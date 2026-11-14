package im.plum.plumbox.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

const val BOX = "https://pb-x.plumbox.me"
const val CLIENT_ID = "im.plum.obsidian-sync:obsidian"
const val APP_FOLDER = "/Apps/Obsidian Sync"

/** One request as the SDK sent it: the URL before the test rerouted it to MockWebServer. */
class Seen(val url: String, val method: String, val headers: Map<String, String>, val body: ByteArray) {
    val path: String get() = url.toHttpUrl().encodedPath
    fun header(name: String): String? = headers[name.lowercase()]
    fun json(): JSONObject = JSONObject(String(body, Charsets.UTF_8))
    fun param(name: String): String? = url.toHttpUrl().queryParameter(name)
    override fun toString(): String = "$method $url"
}

/**
 * An OkHttp-backed [HttpAdapter] whose every request — whatever host the SDK
 * addressed (`https://pb-x.plumbox.me`, a LAN IP) — lands on [server]. The
 * address the SDK used travels in a header so the fake box can record it.
 */
fun reroutingAdapter(server: MockWebServer): HttpAdapter {
    val reroute = Interceptor { chain ->
        val original = chain.request()
        val target = original.url.newBuilder().scheme("http").host(server.hostName).port(server.port).build()
        chain.proceed(original.newBuilder().url(target).header(ORIGINAL_URL, original.url.toString()).build())
    }
    val client = OkHttpClient.Builder()
        .addInterceptor(reroute)
        .followRedirects(false)
        // Count exactly what the SDK sends: no silent transport-level retries.
        .retryOnConnectionFailure(false)
        .dispatcher(okhttp3.Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 64 })
        .build()
    return OkHttpAdapter(client)
}

private const val ORIGINAL_URL = "x-test-original-url"

/** Every request the server got, as the SDK sent it. */
fun RecordedRequest.toSeen(): Seen {
    val headers = this.headers.names().associate { it.lowercase() to this.headers[it]!! }
    return Seen(
        url = headers[ORIGINAL_URL] ?: requestUrl.toString(),
        method = method ?: "",
        headers = headers - ORIGINAL_URL,
        body = body.readByteArray(),
    )
}

fun json(status: Int, body: String, vararg headers: Pair<String, String>): MockResponse =
    MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body).apply {
        for ((k, v) in headers) setHeader(k, v)
    }

/**
 * A box that follows the contract (the Kotlin twin of `fakeBox` in
 * refresh.test.ts): one live access token and one live refresh token at a
 * time; a refresh rotates both. A `files:app` token for [APP_FOLDER].
 */
class FakeBox(private val withAppFolder: Boolean = true) : AutoCloseable {
    val server = MockWebServer()

    @Volatile var access = "plum_pat_1"
    @Volatile var refresh = "plum_rt_1"
    private var n = 1

    /** Token-endpoint calls. */
    val refreshes = AtomicInteger()

    /** The next refreshes answer with this instead (null: rotate as normal). */
    @Volatile var failRefresh: MockResponse? = null

    /** Holds token-endpoint answers until counted down (to line up concurrent requests). */
    @Volatile var gate: CountDownLatch? = null

    /** Runs first for every request; a non-null answer replaces the box's own. */
    @Volatile var before: ((Seen) -> MockResponse?)? = null

    /** Runs after a successful refresh rotated the tokens. */
    @Volatile var afterRefresh: (() -> Unit)? = null

    /** Every request in the order the box answered them. */
    val seen = CopyOnWriteArrayList<Seen>()

    /** A shared timeline tests can append to (the box writes "box: <path> <bearer>"). */
    val events = CopyOnWriteArrayList<String>()

    /** Files in the box, for download. */
    val files = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()

    /** Chunked uploads: id → bytes received so far. */
    private val uploads = java.util.concurrent.ConcurrentHashMap<String, java.io.ByteArrayOutputStream>()
    private val uploadMeta = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()

    /** How many entries `/Apps/Obsidian Sync/big` lists (for paging). */
    @Volatile var bigListing = 2500

    val http: HttpAdapter

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = answer(request.toSeen())
        }
        server.start()
        http = reroutingAdapter(server)
    }

    fun tokenCalls(): List<Seen> = seen.filter { it.path == "/api/oauth/token" }

    private fun answer(req: Seen): MockResponse {
        seen += req
        before?.invoke(req)?.let { return it }
        if (req.path == "/api/oauth/token") return token(req)
        events += "box: ${req.path} ${req.header("authorization")}"
        if (req.header("authorization") != "Bearer $access") {
            return json(401, """{"error":"invalid_token"}""", "www-authenticate" to """Bearer error="invalid_token"""")
        }
        return when (req.path) {
            "/api/drive/list" -> list(req)
            "/api/drive/upload" -> json(200, """{"status":"ok","path":"$APP_FOLDER/a.md","name":"a.md"}""")
            "/api/drive/mkdir" -> {
                val b = req.json()
                val parent = b.getString("path")
                val full = (if (parent == "/") "" else parent) + "/" + b.getString("name")
                when {
                    !full.startsWith(APP_FOLDER) -> json(403, """{"error":"forbidden"}""")
                    full == APP_FOLDER -> json(409, """{"error":"exists"}""")
                    else -> json(200, """{"status":"ok"}""")
                }
            }
            "/api/drive/download" -> {
                val bytes = files[req.param("path")] ?: return json(404, """{"error":"not_found"}""")
                MockResponse().setResponseCode(200).setBody(okio.Buffer().write(bytes))
            }
            "/api/uploads/init" -> {
                val b = req.json()
                val id = "up" + uploads.size
                uploads[id] = java.io.ByteArrayOutputStream()
                uploadMeta[id] = b
                json(200, """{"uploadId":"$id","chunkSize":4194304,"receivedBytes":0,"totalBytes":${b.getLong("size")}}""")
            }
            "/api/drive/move", "/api/drive/rename", "/api/drive/delete" -> json(200, """{"status":"ok"}""")
            else -> if (req.path.startsWith("/api/uploads/")) patch(req) else json(200, """{"user":{"id":"u1"}}""")
        }
    }

    /** Authorization codes the box issued: code → (PKCE challenge, redirect URI). */
    private val codes = java.util.concurrent.ConcurrentHashMap<String, Pair<String, String>>()

    /** What the box does when the user approves: remember the challenge, hand out a one-time code. */
    fun approve(codeChallenge: String, redirectUri: String): String {
        val code = "code-" + codes.size
        codes[code] = codeChallenge to redirectUri
        return code
    }

    private fun exchange(body: JSONObject): MockResponse {
        val (challenge, redirectUri) = codes.remove(body.optString("code"))
            ?: return json(400, """{"error":"invalid_grant","error_description":"code used or unknown"}""")
        val verifier = body.optString("code_verifier")
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        val expected = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        if (expected != challenge || body.optString("redirect_uri") != redirectUri || body.optString("client_id") != CLIENT_ID) {
            return json(400, """{"error":"invalid_grant","error_description":"PKCE mismatch"}""")
        }
        return json(
            200,
            JSONObject().put("access_token", access).put("token_type", "bearer").put("expires_in", 3600)
                .put("refresh_token", refresh).put("scope", "files:app").put("app_folder", APP_FOLDER).toString(),
        )
    }

    private fun token(req: Seen): MockResponse {
        if (req.json().optString("grant_type") == "authorization_code") return exchange(req.json())
        refreshes.incrementAndGet()
        gate?.await(10, TimeUnit.SECONDS)
        failRefresh?.let { return it }
        val body = req.json()
        if (body.optString("grant_type") != "refresh_token" ||
            body.optString("client_id") != CLIENT_ID ||
            body.optString("refresh_token") != refresh
        ) {
            return json(400, """{"error":"invalid_grant","error_description":"connect the app again"}""")
        }
        val out: String
        synchronized(this) {
            n++
            access = "plum_pat_$n"
            refresh = "plum_rt_$n"
            out = JSONObject()
                .put("access_token", access)
                .put("token_type", "bearer")
                .put("expires_in", 3600)
                .put("refresh_token", refresh)
                .put("scope", "files:app")
                .apply { if (withAppFolder) put("app_folder", APP_FOLDER) }
                .toString()
        }
        events += "box: rotated to $access"
        afterRefresh?.invoke()
        return json(200, out)
    }

    private fun list(req: Seen): MockResponse {
        val path = req.param("path") ?: "/"
        if (!path.startsWith(APP_FOLDER)) return json(403, """{"error":"forbidden"}""")
        val limit = req.param("limit")!!.toInt()
        val offset = req.param("offset")!!.toInt()
        if (path != "$APP_FOLDER/big") return json(200, """{"items":[],"total":0,"limit":$limit,"offset":$offset}""")
        val items = org.json.JSONArray()
        for (i in offset until minOf(offset + limit, bigListing)) {
            items.put(
                JSONObject().put("name", "f$i.md").put("path", "$path/f$i.md").put("isDir", false)
                    .put("size", i).put("modTime", "2026-11-13T00:00:00Z")
                    .apply { if (req.param("hash") == "1") put("hash", "h$i") },
            )
        }
        return json(200, JSONObject().put("items", items).put("total", bigListing).put("limit", limit).put("offset", offset).toString())
    }

    private fun patch(req: Seen): MockResponse {
        val id = req.path.removePrefix("/api/uploads/")
        val buf = uploads[id] ?: return json(404, """{"error":"no_session"}""")
        val m = Regex("""bytes (\d+)-(\d+)/(\d+)""").matchEntire(req.header("content-range") ?: "")
            ?: return json(400, """{"error":"invalid_content_range"}""")
        val (start, end, total) = m.destructured
        if (start.toInt() != buf.size()) {
            return json(409, """{"error":"offset_mismatch","receivedBytes":${buf.size()}}""")
        }
        if (end.toInt() - start.toInt() + 1 != req.body.size) return json(400, """{"error":"size_mismatch"}""")
        buf.write(req.body)
        if (buf.size() < total.toInt()) {
            return json(200, """{"status":"active","receivedBytes":${buf.size()},"totalBytes":$total}""")
        }
        val meta = uploadMeta.getValue(id)
        val placed = (if (meta.getString("path") == "/") "" else meta.getString("path")) + "/" + meta.getString("filename")
        files[placed] = buf.toByteArray()
        return json(200, JSONObject().put("status", "finalized").put("path", placed).put("name", meta.getString("filename")).toString())
    }

    override fun close() {
        gate?.let { while (it.count > 0) it.countDown() }
        server.shutdown()
    }
}

/** A real-time test with a deadline, so a refresh that never comes fails instead of hanging. */
fun boxTest(block: suspend CoroutineScope.() -> Unit): Unit = runBlocking { withTimeout(30_000) { block() } }

/** Wait (really) until [cond] holds. */
suspend fun waitUntil(timeoutMs: Long = 10_000, cond: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!cond()) {
        check(System.currentTimeMillis() < deadline) { "condition not met in ${timeoutMs}ms" }
        delay(5)
    }
}

/** Run [block] and return what it threw (fails the test when it throws nothing). */
suspend inline fun <reified T : Throwable> assertThrowsSuspend(crossinline block: suspend () -> Unit): T {
    try {
        block()
    } catch (e: Throwable) {
        if (e is T) return e
        throw AssertionError("expected ${T::class.java.simpleName}, got $e", e)
    }
    throw AssertionError("expected ${T::class.java.simpleName}, nothing was thrown")
}
