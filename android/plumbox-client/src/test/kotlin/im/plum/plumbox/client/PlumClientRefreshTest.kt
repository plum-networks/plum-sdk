package im.plum.plumbox.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The Kotlin twin of refresh.test.ts: hourly access tokens, rotating refresh
// tokens, one refresh for many requests, and telling "signed out"
// (401 / invalid_grant) from "not allowed" (403).
class PlumClientRefreshTest {
    private val box = FakeBox()

    @After fun tearDown() = box.close()

    private val authErrors = CopyOnWriteArrayList<PlumAuthError>()
    private val rotated = CopyOnWriteArrayList<OAuthTokens>()

    private fun client(
        baseUrl: String = BOX,
        iss: String? = null,
        expiresAt: Long? = System.currentTimeMillis() + 3_600_000,
        appFolder: String? = null,
        tokenStore: TokenStore? = null,
        onTokens: (suspend (OAuthTokens) -> Unit)? = { rotated += it },
    ) = PlumClient(
        baseUrl = baseUrl,
        token = "plum_pat_1",
        refreshToken = "plum_rt_1",
        expiresAt = expiresAt,
        appFolder = appFolder,
        clientId = CLIENT_ID,
        iss = iss,
        onTokens = onTokens,
        onAuthError = { authErrors += it },
        http = box.http,
        tokenStore = tokenStore,
    )

    private fun bearers(pathPart: String) = box.seen.filter { it.url.contains(pathPart) && it.path != "/api/oauth/token" }.map { it.header("authorization") }

    @Test
    fun `refreshes on a 401, sends the request again, and hands the rotated set to onTokens`() = boxTest {
        box.access = "plum_pat_expired_elsewhere" // the box no longer takes plum_pat_1
        val c = client()
        c.drive.list(APP_FOLDER)
        assertEquals(1, box.refreshes.get())
        assertTrue(authErrors.isEmpty())
        val tokens = rotated.single()
        assertEquals("plum_pat_2", tokens.accessToken)
        assertEquals("plum_rt_2", tokens.refreshToken)
        assertEquals("files:app", tokens.scope)
        assertEquals(APP_FOLDER, tokens.appFolder)
        assertEquals("bearer", tokens.tokenType)
        assertTrue(tokens.expiresAt!! > System.currentTimeMillis() + 3_500_000)
        assertEquals(listOf("Bearer plum_pat_1", "Bearer plum_pat_2"), bearers("/api/drive/list"))
        assertEquals("$BOX/api/oauth/token", box.tokenCalls().single().url)
        assertEquals(tokens, c.tokens)
    }

    @Test
    fun `persists the rotated set before the retried request is sent`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val store = object : TokenStore {
            var saved: PlumConnection? = null
            override suspend fun load() = saved
            override suspend fun save(connection: PlumConnection) {
                box.events += "store: ${connection.tokens.refreshToken}"
                saved = connection
            }
            override suspend fun clear() { saved = null }
        }
        val c = client(tokenStore = store, onTokens = { box.events += "onTokens: ${it.refreshToken}" })
        c.drive.list(APP_FOLDER)
        assertEquals(
            listOf(
                "box: /api/drive/list Bearer plum_pat_1", // 401
                "box: rotated to plum_pat_2",
                "store: plum_rt_2", // the new refresh token is saved...
                "onTokens: plum_rt_2", // ...and handed over...
                "box: /api/drive/list Bearer plum_pat_2", // ...before the retry goes out
            ),
            box.events.toList(),
        )
        assertEquals(PlumConnection(BOX, CLIENT_ID, c.tokens!!), store.saved)
    }

    @Test
    fun `refreshes ahead of time when the access token has less than a minute left`() = boxTest {
        val c = client(expiresAt = System.currentTimeMillis() + 30_000)
        c.auth.me()
        assertEquals(1, box.refreshes.get())
        assertEquals(listOf("/api/oauth/token", "/api/auth/me"), box.seen.map { it.path })
        assertEquals("Bearer plum_pat_2", box.seen[1].header("authorization"))
        assertEquals(1, rotated.size)
        // ...and not again while the new token is fresh.
        c.auth.me()
        assertEquals(1, box.refreshes.get())
    }

    @Test
    fun `four requests that all hit 401 share ONE refresh`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val gate = CountDownLatch(1)
        box.gate = gate
        val c = client()
        coroutineScope {
            val all = (0..3).map { i -> async(Dispatchers.IO) { c.drive.list("$APP_FOLDER/$i") } }
            waitUntil { box.refreshes.get() == 1 && box.seen.count { it.path == "/api/drive/list" } == 4 }
            gate.countDown()
            all.awaitAll()
        }
        assertEquals(1, box.refreshes.get())
        // A second refresh would have sent the rotated-away plum_rt_1 again —
        // on a real box, after the grace period, that ends the connection.
        assertEquals(1, box.tokenCalls().size)
        assertEquals(1, rotated.size)
        for (i in 0..3) assertEquals(listOf("Bearer plum_pat_1", "Bearer plum_pat_2"), bearers("Sync%2F$i"))
    }

    @Test
    fun `a 401 that lands after another request already refreshed just retries`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val bGate = CountDownLatch(1)
        box.before = { if (it.url.contains("B")) bGate.await(10, TimeUnit.SECONDS); null }
        val c = client()
        coroutineScope {
            val b = async(Dispatchers.IO) { c.drive.list("$APP_FOLDER/B") } // goes out with plum_pat_1
            waitUntil { box.seen.any { it.url.contains("B") } }
            c.drive.list("$APP_FOLDER/A") // 401 → refresh → plum_pat_2
            bGate.countDown() // B's 401 (for plum_pat_1) arrives only now
            b.await()
        }
        assertEquals(1, box.refreshes.get())
        assertEquals(listOf("Bearer plum_pat_1", "Bearer plum_pat_2"), bearers("B"))
    }

    @Test
    fun `a request that starts while a refresh is under way waits for it`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val gate = CountDownLatch(1)
        box.gate = gate
        val c = client()
        coroutineScope {
            val first = async(Dispatchers.IO) { c.drive.list("$APP_FOLDER/1") }
            waitUntil { box.refreshes.get() == 1 }
            val second = async(Dispatchers.IO) { c.drive.list("$APP_FOLDER/2") }
            Thread.sleep(100) // give it every chance to go out early
            gate.countDown()
            awaitAll(first, second)
        }
        assertEquals(listOf("Bearer plum_pat_2"), bearers("Sync%2F2"))
    }

    @Test
    fun `invalid_grant ends the connection - onAuthError once, every request fails, no more refreshes`() = boxTest {
        box.access = "plum_pat_rotated_away"
        box.failRefresh = json(400, """{"error":"invalid_grant"}""")
        val c = client()
        val results = coroutineScope {
            (0..3).map { i -> async(Dispatchers.IO) { runCatching { c.drive.list("$APP_FOLDER/$i") } } }.awaitAll()
        }
        for (r in results) {
            val err = r.exceptionOrNull()
            assertTrue("$err", err is PlumAuthError)
            err as PlumAuthError
            assertTrue(err.code == "invalid_grant" || err.status == 401)
        }
        assertEquals(1, authErrors.size)
        assertEquals("invalid_grant", authErrors.single().code)
        assertEquals(400, authErrors.single().status)
        assertTrue(rotated.isEmpty())
        assertEquals(1, box.refreshes.get())

        assertThrowsSuspend<PlumAuthError> { c.drive.list(APP_FOLDER) }
        assertEquals(1, box.refreshes.get())
        assertEquals(1, authErrors.size)
    }

    @Test
    fun `a refresh that could not reach the box is not a sign-out - the next request tries again`() = boxTest {
        box.access = "plum_pat_rotated_away"
        box.failRefresh = json(503, """{"error":"unavailable"}""")
        val c = client()
        val err = assertThrowsSuspend<PlumApiError> { c.drive.list(APP_FOLDER) }
        assertFalse(err is PlumAuthError)
        assertEquals(503, err.status)
        assertTrue(authErrors.isEmpty())
        box.failRefresh = null
        c.drive.list(APP_FOLDER)
        assertEquals(2, box.refreshes.get())
        assertTrue(authErrors.isEmpty())
        // The second refresh sent the same, still good, refresh token.
        assertEquals(listOf("plum_rt_1", "plum_rt_1"), box.tokenCalls().map { it.json().getString("refresh_token") })
    }

    @Test
    fun `a dropped connection during the refresh is a plain PlumApiError and keeps the refresh token`() = boxTest {
        box.access = "plum_pat_rotated_away"
        box.failRefresh = MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
        val c = client()
        val err = assertThrowsSuspend<PlumApiError> { c.drive.list(APP_FOLDER) }
        assertFalse(err is PlumAuthError)
        assertEquals("network_error", err.code)
        assertTrue(authErrors.isEmpty())
        assertEquals("plum_rt_1", c.tokens!!.refreshToken)
        box.failRefresh = null
        c.drive.list(APP_FOLDER)
        assertEquals("plum_rt_2", c.tokens!!.refreshToken)
    }

    @Test
    fun `goes ahead with a token that has a few seconds left when an early refresh fails`() = boxTest {
        box.failRefresh = json(503, """{"error":"unavailable"}""")
        val c = client(expiresAt = System.currentTimeMillis() + 20_000)
        c.auth.me()
        assertEquals(listOf("/api/oauth/token", "/api/auth/me"), box.seen.map { it.path })
    }

    @Test
    fun `refreshes only once per request - a 401 after a good refresh is the end`() = boxTest {
        box.access = "plum_pat_nothing_works"
        // The box accepts neither the old token nor the refreshed one.
        box.afterRefresh = { box.access = "plum_pat_nothing_works" }
        val c = client()
        val err = assertThrowsSuspend<PlumAuthError> { c.drive.list(APP_FOLDER) }
        assertEquals(401, err.status)
        assertEquals(1, box.refreshes.get())
        assertEquals(1, authErrors.size)
    }

    @Test
    fun `sends an upload body again byte for byte after the refresh`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val c = client()
        c.drive.upload("$APP_FOLDER/a.md", "hello", overwrite = true)
        val uploads = box.seen.filter { it.path == "/api/drive/upload" }
        assertEquals(2, uploads.size)
        assertTrue(uploads[0].body.contentEquals(uploads[1].body))
        assertEquals(uploads[0].header("content-type"), uploads[1].header("content-type"))
        assertEquals(listOf("Bearer plum_pat_1", "Bearer plum_pat_2"), uploads.map { it.header("authorization") })
    }

    @Test
    fun `a 403 is not a reason to refresh or to sign out`() = boxTest {
        val c = client()
        val err = assertThrowsSuspend<PlumForbiddenError> { c.drive.list("/Photos") }
        assertEquals(403, err.status)
        assertEquals(0, box.refreshes.get())
        assertTrue(authErrors.isEmpty())
    }

    @Test
    fun `keeps the app folder when a refresh does not repeat it`() = boxTest {
        FakeBox(withAppFolder = false).use { plain ->
            plain.access = "plum_pat_rotated_away"
            val c = PlumClient(
                baseUrl = BOX, token = "plum_pat_1", refreshToken = "plum_rt_1",
                expiresAt = System.currentTimeMillis() + 3_600_000, appFolder = APP_FOLDER, clientId = CLIENT_ID,
                onTokens = { rotated += it }, http = plain.http,
            )
            assertEquals(APP_FOLDER, c.appFolder)
            c.drive.list(APP_FOLDER)
            assertEquals(APP_FOLDER, rotated.single().appFolder)
            assertEquals(APP_FOLDER, c.appFolder)
        }
    }

    @Test
    fun `a refresh token alone refreshes before the first request`() = boxTest {
        val c = PlumClient(baseUrl = BOX, refreshToken = "plum_rt_1", clientId = CLIENT_ID, http = box.http)
        c.auth.me()
        assertEquals(listOf("/api/oauth/token", "/api/auth/me"), box.seen.map { it.path })
    }

    @Test
    fun `refresh() refreshes now and shares a refresh in flight`() = boxTest {
        val c = client()
        coroutineScope {
            listOf(async(Dispatchers.IO) { c.refresh() }, async(Dispatchers.IO) { c.refresh() }).awaitAll()
        }
        assertEquals(1, box.refreshes.get())
        val noRefresh = PlumClient(baseUrl = BOX, token = "plum_pat_x", http = box.http)
        val err = assertThrowsSuspend<IllegalStateException> { noRefresh.refresh() }
        assertTrue(err.message!!.contains("no refresh token"))
    }

    @Test
    fun `drops a refresh result when the tokens were replaced meanwhile`() = boxTest {
        val gate = CountDownLatch(1)
        box.gate = gate
        val c = client()
        coroutineScope {
            val p = async(Dispatchers.IO) { c.refresh() }
            waitUntil { box.refreshes.get() == 1 }
            c.setToken(OAuthTokens(accessToken = "plum_pat_new_signin", scope = "files:app"))
            gate.countDown()
            p.await()
        }
        assertTrue(rotated.isEmpty())
        box.access = "plum_pat_new_signin"
        c.auth.me()
        assertEquals("Bearer plum_pat_new_signin", box.seen.last().header("authorization"))
    }

    @Test
    fun `adopts the result when storage hands back the very set the refresh rotated away`() = boxTest {
        val gate = CountDownLatch(1)
        box.gate = gate
        val c = client()
        coroutineScope {
            val p = async(Dispatchers.IO) { c.refresh() }
            waitUntil { box.refreshes.get() == 1 }
            c.setToken(OAuthTokens(accessToken = "plum_pat_1", scope = "files:app", refreshToken = "plum_rt_1"))
            gate.countDown()
            p.await()
        }
        assertEquals(1, rotated.size)
        c.auth.me()
        assertEquals("Bearer plum_pat_2", box.seen.last().header("authorization"))
    }

    @Test
    fun `a caller that gives up mid-refresh does not throw the rotated token away`() = boxTest {
        val gate = CountDownLatch(1)
        box.gate = gate
        box.access = "plum_pat_rotated_away"
        val store = InMemoryTokenStore()
        val c = client(tokenStore = store)
        val job = launch(Dispatchers.IO) { c.drive.list(APP_FOLDER) }
        waitUntil { box.refreshes.get() == 1 }
        job.cancelAndJoin() // the caller goes away while the box is still answering the refresh
        gate.countDown()
        waitUntil { rotated.isNotEmpty() }
        assertEquals("plum_rt_2", store.load()!!.tokens.refreshToken)
        assertEquals("plum_rt_2", c.tokens!!.refreshToken)
    }

    @Test
    fun `an old never-expiring token (no refresh token) is never refreshed`() = boxTest {
        box.access = "plum_pat_revoked"
        val c = PlumClient(baseUrl = BOX, token = "plum_pat_legacy", http = box.http, onAuthError = { authErrors += it })
        val err = assertThrowsSuspend<PlumAuthError> { c.auth.me() }
        assertEquals(401, err.status)
        assertEquals(0, box.refreshes.get())
        assertEquals(1, authErrors.size)
        // Once per credential: the same dead token does not fire it again.
        assertThrowsSuspend<PlumAuthError> { c.auth.me() }
        assertEquals(1, authErrors.size)
    }

    @Test
    fun `refuses a refresh token it could not use safely`() {
        fun make(baseUrl: String = BOX, iss: String? = null, clientId: String? = CLIENT_ID) =
            runCatching { PlumClient(baseUrl = baseUrl, iss = iss, clientId = clientId, token = "plum_pat_1", refreshToken = "plum_rt_1") }
                .exceptionOrNull()
        assertTrue(make(clientId = null)!!.message!!.contains("clientId"))
        assertTrue(make(baseUrl = "http://192.168.0.10:8443")!!.message!!.contains("verified iss"))
        assertNull(make(baseUrl = "$BOX/"))
        assertTrue(make(iss = "https://pb-x-lan.plumbox.me")!!.message!!.contains("verified iss"))
        // Another environment's box is refused outright.
        assertTrue(runCatching { PlumClient(baseUrl = "https://pb-x.staging.plumbox.me") }.exceptionOrNull() is IllegalArgumentException)
        assertNull(runCatching { PlumClient(baseUrl = "https://pb-x.staging.plumbox.me", boxDomain = "staging.plumbox.me") }.exceptionOrNull())
    }

    @Test
    fun `refreshes at the iss, not at a LAN baseUrl`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val c = client(baseUrl = "http://192.168.0.10:8443", iss = BOX)
        c.drive.list(APP_FOLDER)
        assertEquals(listOf("$BOX/api/oauth/token"), box.tokenCalls().map { it.url })
        assertTrue(box.seen.last().url.startsWith("http://192.168.0.10:8443/api/drive/list"))
    }
}
