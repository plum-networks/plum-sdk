package im.plum.plumbox.client

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The user's Drive on the box (`client.drive`) — the Kotlin twin of
 * `drive.ts`, same endpoints, same parameters. Paths are absolute drive paths
 * (`/Apps/My App/vault/note.md`); a `files:app` token reaches only its
 * [PlumClient.appFolder] and gets [PlumForbiddenError] anywhere else.
 */
public class DriveApi internal constructor(private val client: PlumClient) {

    /** List one page. Pass [limit]/[offset] for pagination; see [listAll] for iteration. */
    public suspend fun list(
        path: String,
        /** Include every descendant (flat), not just direct children. */
        recursive: Boolean = false,
        /** Include indexed SHA-256 content hashes. */
        hash: Boolean = false,
        /** Server-side filename/path search. */
        q: String? = null,
        sort: ListSort? = null,
        order: ListOrder? = null,
        limit: Int? = null,
        offset: Int? = null,
    ): ListPage {
        val params = mutableListOf("path" to path.ifEmpty { "/" })
        if (recursive) params += "recursive" to "1"
        if (hash) params += "hash" to "1"
        if (!q.isNullOrEmpty()) params += "q" to q
        if (sort != null) params += "sort" to sort.wire
        if (order != null) params += "order" to order.wire
        // Always paginate so the response shape is stable ({items,total,...}).
        params += "limit" to (limit ?: PAGE_SIZE).toString()
        params += "offset" to (offset ?: 0).toString()
        val body = responseObject(client.request("/api/drive/list?" + formEncode(params)))
        val items = body.array("items")
        val entries = ArrayList<DriveEntry>(items?.length() ?: 0)
        if (items != null) {
            for (i in 0 until items.length()) {
                val o = items.opt(i) as? JSONObject ?: continue
                entries += DriveEntry(
                    name = o.string("name") ?: "",
                    path = o.string("path") ?: "",
                    isDir = o.bool("isDir") ?: false,
                    size = o.number("size")?.toLong() ?: 0L,
                    modTime = o.string("modTime") ?: "",
                    hash = o.string("hash")?.takeIf { it.isNotEmpty() },
                )
            }
        }
        return ListPage(
            items = entries,
            total = body.number("total")?.toInt() ?: entries.size,
            limit = body.number("limit")?.toInt() ?: (limit ?: PAGE_SIZE),
            offset = body.number("offset")?.toInt() ?: (offset ?: 0),
        )
    }

    /** Every entry under [path], walking the pages as the flow is collected. */
    public fun listAll(
        path: String,
        recursive: Boolean = false,
        hash: Boolean = false,
        q: String? = null,
        sort: ListSort? = null,
        order: ListOrder? = null,
    ): Flow<DriveEntry> = flow {
        var offset = 0
        while (true) {
            val page = list(path, recursive, hash, q, sort, order, limit = PAGE_SIZE, offset = offset)
            for (item in page.items) emit(item)
            offset += page.items.size
            if (page.items.isEmpty() || offset >= page.total) return@flow
        }
    }

    /** The file's bytes. */
    public suspend fun download(path: String): ByteArray =
        client.request("/api/drive/download?" + formEncode(listOf("path" to path))).body

    /**
     * Upload [data] as the file at [path] (full drive path including the file
     * name). Small files go as one multipart POST; larger ones (over 8 MiB)
     * use the resumable chunked protocol (`/api/uploads/…`, 4 MiB chunks)
     * automatically.
     *
     * @param overwrite replace the file at the exact name (the previous
     *   content is kept as a version on the box). Without it a name collision
     *   creates "name (2).ext" — NOT what a sync client wants. A large
     *   overwrite goes chunked like any large upload (`overwrite` at init).
     * @param onProgress `(sentBytes, totalBytes)` after each part.
     */
    public suspend fun upload(
        path: String,
        data: ByteArray,
        overwrite: Boolean = false,
        contentType: String? = null,
        onProgress: ((sentBytes: Long, totalBytes: Long) -> Unit)? = null,
    ): DriveEntry {
        val dir = dirname(path)
        val name = basename(path)
        require(name.isNotEmpty()) { "upload path must include a filename" }

        // Large files go chunked, overwrite or not: the chunked protocol has
        // carried `overwrite` since box core 1.7.7, and one multi-hundred-MB
        // POST is what a flaky phone connection loses.
        if (data.size > CHUNKED_THRESHOLD) {
            return uploadChunked(dir, name, data, overwrite, contentType, onProgress)
        }
        val fields = mutableListOf("path" to dir)
        if (overwrite) fields += "overwrite" to "1"
        val (body, multipartType) = buildMultipart(fields, "file", name, data, contentType)
        val res = client.request(
            "/api/drive/upload",
            method = "POST",
            body = body,
            headers = mapOf("content-type" to multipartType),
        )
        onProgress?.invoke(data.size.toLong(), data.size.toLong())
        val out = responseObject(res)
        return DriveEntry(
            name = out.string("name") ?: name,
            path = out.string("path") ?: joinDrivePath(dir, name),
            isDir = false,
            size = data.size.toLong(),
            modTime = nowRfc3339(),
        )
    }

    /** Upload [text] as UTF-8. Same as the [ByteArray] form. */
    public suspend fun upload(
        path: String,
        text: String,
        overwrite: Boolean = false,
        contentType: String? = null,
        onProgress: ((sentBytes: Long, totalBytes: Long) -> Unit)? = null,
    ): DriveEntry = upload(path, text.toByteArray(Charsets.UTF_8), overwrite, contentType, onProgress)

    private suspend fun uploadChunked(
        dir: String,
        name: String,
        data: ByteArray,
        overwrite: Boolean,
        contentType: String?,
        onProgress: ((Long, Long) -> Unit)?,
    ): DriveEntry {
        val total = data.size
        val init = responseObject(
            client.requestJson(
                "/api/uploads/init",
                "POST",
                Json.encode(
                    "target" to "drive",
                    "path" to dir,
                    "filename" to name,
                    "size" to total.toLong(),
                    "contentType" to (contentType ?: "application/octet-stream"),
                    "overwrite" to (if (overwrite) true else null),
                ),
            ),
        )
        val uploadId = init.string("uploadId")?.takeIf { it.isNotEmpty() }
            ?: throw PlumApiError(200, "the box started no upload (no uploadId)", "invalid_response")

        var sent = 0
        var placed: JSONObject? = null
        while (sent < total) {
            val end = minOf(sent + CHUNK_SIZE, total)
            val res = client.request(
                "/api/uploads/" + encodeUriComponent(uploadId),
                method = "PATCH",
                body = data.copyOfRange(sent, end),
                headers = mapOf(
                    "content-type" to "application/octet-stream",
                    "content-range" to "bytes $sent-${end - 1}/$total",
                ),
            )
            sent = end
            onProgress?.invoke(sent.toLong(), total.toLong())
            if (sent >= total) placed = Json.parseObjectOrNull(res.text())
        }
        return DriveEntry(
            name = placed?.string("name") ?: name,
            path = placed?.string("path") ?: joinDrivePath(dir, name),
            isDir = false,
            size = total.toLong(),
            modTime = nowRfc3339(),
        )
    }

    /** Create one directory. The parent must exist — see [ensureDir] for `mkdir -p`. */
    public suspend fun mkdir(path: String) {
        client.requestJson("/api/drive/mkdir", "POST", Json.encode("path" to dirname(path), "name" to basename(path)))
    }

    /**
     * `mkdir -p`: create every missing segment of [path].
     *
     * A parent the token may not touch is passed over: a `files:app` token
     * gets 403 on `/Apps` itself, yet may create folders inside its app folder
     * (which the box made when it issued the token). A 403 on the last
     * segment, or on a parent that really is missing, still surfaces.
     */
    public suspend fun ensureDir(path: String) {
        val segments = path.split('/').filter { it.isNotEmpty() }
        var current = ""
        for ((i, segment) in segments.withIndex()) {
            current += "/$segment"
            try {
                mkdir(current)
            } catch (e: PlumApiError) {
                // Already-exists is fine; surface anything else.
                if (e.status == 409 || e.status == 500) continue
                if (e.status == 403 && i < segments.size - 1) continue
                throw e
            }
        }
    }

    /** Rename within the same directory. For cross-directory moves use [move]. */
    public suspend fun rename(path: String, newName: String) {
        client.requestJson("/api/drive/rename", "POST", Json.encode("path" to path, "name" to newName))
    }

    /** Move a file or directory to an arbitrary path (the destination parent must exist). */
    public suspend fun move(path: String, newPath: String) {
        client.requestJson("/api/drive/move", "POST", Json.encode("path" to path, "newPath" to newPath))
    }

    /** Delete: moves to the box trash (recoverable from the Drive UI), not a hard delete. */
    public suspend fun remove(path: String) {
        client.request("/api/drive/delete?" + formEncode(listOf("path" to path)), method = "DELETE")
    }

    internal companion object {
        /** Files above this size go through the resumable chunked-upload protocol. */
        const val CHUNKED_THRESHOLD: Int = 8 * 1024 * 1024
        const val CHUNK_SIZE: Int = 4 * 1024 * 1024
        const val PAGE_SIZE: Int = 1000 // the box's maxListLimit

        fun dirname(path: String): String {
            val norm = "/" + path.trimStart('/').trimEnd('/')
            val idx = norm.lastIndexOf('/')
            return if (idx <= 0) "/" else norm.substring(0, idx)
        }

        fun basename(path: String): String {
            val norm = path.trimEnd('/')
            return norm.substring(norm.lastIndexOf('/') + 1)
        }

        fun joinDrivePath(dir: String, name: String): String = (if (dir == "/") "" else dir) + "/" + name

        fun nowRfc3339(): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date())
    }
}
