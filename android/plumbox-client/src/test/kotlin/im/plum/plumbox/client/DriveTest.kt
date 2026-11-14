package im.plum.plumbox.client

import kotlinx.coroutines.flow.toList
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

// drive.ts on Android: same endpoints, same parameters, against the fake box.
class DriveTest {
    private val box = FakeBox()

    @After fun tearDown() = box.close()

    private fun client() = PlumClient(
        baseUrl = BOX,
        token = "plum_pat_1",
        refreshToken = "plum_rt_1",
        expiresAt = System.currentTimeMillis() + 3_600_000,
        appFolder = APP_FOLDER,
        clientId = CLIENT_ID,
        http = box.http,
    )

    @Test
    fun `ensureDir with a files_app token passes over the parents it may not touch`() = boxTest {
        client().drive.ensureDir("$APP_FOLDER/MyVault/notes")
        val made = box.seen.filter { it.path == "/api/drive/mkdir" }.map { it.json() }
        assertEquals(
            listOf("/|Apps", "/Apps|Obsidian Sync", "/Apps/Obsidian Sync|MyVault", "/Apps/Obsidian Sync/MyVault|notes"),
            made.map { "${it.getString("path")}|${it.getString("name")}" },
        )
        assertTrue(box.seen.filter { it.path == "/api/drive/mkdir" }.all { it.method == "POST" && it.header("content-type") == "application/json" })
    }

    @Test
    fun `ensureDir still fails when the folder itself is out of bounds`() = boxTest {
        val err = assertThrowsSuspend<PlumForbiddenError> { client().drive.ensureDir("/Photos/2026") }
        assertEquals(403, err.status)
    }

    @Test
    fun `a chunked upload is init, then PATCHes of 4 MiB in order, then the placed entry`() = boxTest {
        val size = 10 * 1024 * 1024 + 123 // over the 8 MiB threshold
        val data = ByteArray(size) { (it * 31 + 7).toByte() }
        val progress = CopyOnWriteArrayList<Pair<Long, Long>>()
        val entry = client().drive.upload("$APP_FOLDER/video.mp4", data, contentType = "video/mp4") { sent, total -> progress += sent to total }

        val calls = box.seen.filter { it.path.startsWith("/api/uploads/") || it.path.startsWith("/api/drive/upload") }
        assertEquals(listOf("POST /api/uploads/init", "PATCH /api/uploads/up0", "PATCH /api/uploads/up0", "PATCH /api/uploads/up0"), calls.map { "${it.method} ${it.path}" })

        val init = calls[0].json()
        assertEquals("application/json", calls[0].header("content-type"))
        assertEquals("drive", init.getString("target"))
        assertEquals(APP_FOLDER, init.getString("path"))
        assertEquals("video.mp4", init.getString("filename"))
        assertEquals(size.toLong(), init.getLong("size"))
        assertEquals("video/mp4", init.getString("contentType"))

        val mib4 = 4 * 1024 * 1024
        assertEquals(
            listOf("bytes 0-${mib4 - 1}/$size", "bytes $mib4-${2 * mib4 - 1}/$size", "bytes ${2 * mib4}-${size - 1}/$size"),
            calls.drop(1).map { it.header("content-range") },
        )
        assertTrue(calls.drop(1).all { it.header("content-type") == "application/octet-stream" && it.header("authorization") == "Bearer plum_pat_1" })
        assertArrayEquals(data, box.files["$APP_FOLDER/video.mp4"])
        assertEquals(listOf(mib4.toLong() to size.toLong(), 2L * mib4 to size.toLong(), size.toLong() to size.toLong()), progress.toList())
        assertEquals(DriveEntry("video.mp4", "$APP_FOLDER/video.mp4", false, size.toLong(), entry.modTime), entry)
    }

    @Test
    fun `a chunked upload survives a refresh in the middle`() = boxTest {
        val data = ByteArray(9 * 1024 * 1024) { it.toByte() }
        // The access token is rotated away after the first chunk landed.
        box.before = { req ->
            if (req.method == "PATCH" && req.header("content-range")!!.startsWith("bytes 4194304-") && box.access == "plum_pat_1") {
                box.access = "plum_pat_rotated_away"
            }
            null
        }
        client().drive.upload("$APP_FOLDER/big.bin", data)
        assertEquals(1, box.refreshes.get())
        assertArrayEquals(data, box.files["$APP_FOLDER/big.bin"])
    }

    @Test
    fun `small files and overwrites go as one multipart POST`() = boxTest {
        val entry = client().drive.upload("$APP_FOLDER/a.md", "# hello", overwrite = true, contentType = "text/markdown")
        val up = box.seen.single { it.path == "/api/drive/upload" }
        assertEquals("POST", up.method)
        val type = up.header("content-type")!!
        assertTrue(type, type.startsWith("multipart/form-data; boundary=----plumbox"))
        val boundary = type.substringAfter("boundary=")
        val body = String(up.body, Charsets.UTF_8)
        assertEquals(
            "--$boundary\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n$APP_FOLDER\r\n" +
                "--$boundary\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n1\r\n" +
                "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.md\"\r\n" +
                "Content-Type: text/markdown\r\n\r\n# hello\r\n--$boundary--\r\n",
            body,
        )
        assertEquals("a.md", entry.name)
        assertEquals("$APP_FOLDER/a.md", entry.path)
        assertEquals(7L, entry.size)
        assertTrue(box.seen.none { it.path.startsWith("/api/uploads/") })
        // Above the chunk threshold an overwrite goes chunked and says so at init.
        client().drive.upload("$APP_FOLDER/big.md", ByteArray(9 * 1024 * 1024), overwrite = true)
        val init = box.seen.single { it.path == "/api/uploads/init" }.json()
        assertEquals(true, init.getBoolean("overwrite"))
        assertTrue(box.seen.count { it.method == "PATCH" && it.path.startsWith("/api/uploads/") } == 3)
    }

    @Test
    fun `list sends the parameters drive ts sends`() = boxTest {
        val c = client()
        c.drive.list(APP_FOLDER)
        c.drive.list("$APP_FOLDER/big", recursive = true, hash = true, q = "note s", sort = ListSort.MODIFIED, order = ListOrder.DESC, limit = 50, offset = 100)
        val lists = box.seen.filter { it.path == "/api/drive/list" }
        assertEquals("$BOX/api/drive/list?path=%2FApps%2FObsidian+Sync&limit=1000&offset=0", lists[0].url)
        assertEquals(
            "$BOX/api/drive/list?path=%2FApps%2FObsidian+Sync%2Fbig&recursive=1&hash=1&q=note+s&sort=modified&order=desc&limit=50&offset=100",
            lists[1].url,
        )
    }

    @Test
    fun `list reads a page and listAll walks every page as a Flow`() = boxTest {
        val c = client()
        val page = c.drive.list("$APP_FOLDER/big", hash = true, limit = 2, offset = 10)
        assertEquals(ListPage(listOf(entry(10, hash = true), entry(11, hash = true)), 2500, 2, 10), page)

        val all = c.drive.listAll("$APP_FOLDER/big").toList()
        assertEquals(2500, all.size)
        assertEquals(entry(0), all.first())
        assertEquals(entry(2499), all.last())
        assertNull(all[5].hash)
        val offsets = box.seen.filter { it.path == "/api/drive/list" }.drop(1).map { it.param("offset") to it.param("limit") }
        assertEquals(listOf("0" to "1000", "1000" to "1000", "2000" to "1000"), offsets)

        // An empty folder is one request and nothing emitted.
        assertEquals(0, c.drive.listAll(APP_FOLDER).toList().size)
    }

    private fun entry(i: Int, hash: Boolean = false) =
        DriveEntry("f$i.md", "$APP_FOLDER/big/f$i.md", false, i.toLong(), "2026-11-13T00:00:00Z", if (hash) "h$i" else null)

    @Test
    fun `download returns the file's bytes`() = boxTest {
        val bytes = ByteArray(70_000) { (it % 251).toByte() }
        box.files["$APP_FOLDER/photo.jpg"] = bytes
        assertArrayEquals(bytes, client().drive.download("$APP_FOLDER/photo.jpg"))
        assertEquals("$BOX/api/drive/download?path=%2FApps%2FObsidian+Sync%2Fphoto.jpg", box.seen.last().url)
        assertEquals(404, assertThrowsSuspend<PlumApiError> { client().drive.download("$APP_FOLDER/missing") }.status)
    }

    @Test
    fun `mkdir, move, rename and remove hit the drive ts endpoints`() = boxTest {
        val d = client().drive
        d.mkdir("$APP_FOLDER/new")
        d.move("$APP_FOLDER/a.md", "$APP_FOLDER/new/a.md")
        d.rename("$APP_FOLDER/new/a.md", "b.md")
        d.remove("$APP_FOLDER/new/b.md")
        val calls = box.seen.toList()
        assertEquals(
            listOf("POST /api/drive/mkdir", "POST /api/drive/move", "POST /api/drive/rename", "DELETE /api/drive/delete"),
            calls.map { "${it.method} ${it.path}" },
        )
        assertEquals("$APP_FOLDER|new", calls[0].json().let { "${it.getString("path")}|${it.getString("name")}" })
        assertEquals("$APP_FOLDER/a.md|$APP_FOLDER/new/a.md", calls[1].json().let { "${it.getString("path")}|${it.getString("newPath")}" })
        assertEquals("$APP_FOLDER/new/a.md|b.md", calls[2].json().let { "${it.getString("path")}|${it.getString("name")}" })
        assertEquals("$BOX/api/drive/delete?path=%2FApps%2FObsidian+Sync%2Fnew%2Fb.md", calls[3].url)
    }

    @Test
    fun `auth me reads the wrapped profile`() = boxTest {
        assertEquals(PlumUser(id = "u1"), client().auth.me())
    }

    @Test
    fun `path helpers match drive ts`() {
        assertEquals("/", DriveApi.dirname("a.md"))
        assertEquals("/", DriveApi.dirname("/a.md"))
        assertEquals("/Apps/X", DriveApi.dirname("/Apps/X/a.md"))
        assertEquals("/Apps/X", DriveApi.dirname("Apps/X/a.md/"))
        assertEquals("a.md", DriveApi.basename("/Apps/X/a.md"))
        assertEquals("X", DriveApi.basename("/Apps/X/"))
        val err = runCatching { kotlinx.coroutines.runBlocking { client().drive.upload("/", "x") } }.exceptionOrNull()
        assertTrue("$err", err is IllegalArgumentException)
    }
}
