package im.plum.plumbox.client

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator

// The TokenStore seam (tokenStorage in client.ts) and the pieces of
// KeystoreTokenStore that do not need a device: the stored form and the
// AES-GCM envelope.
class TokenStoreTest {
    private val box = FakeBox()

    @After fun tearDown() = box.close()

    private val full = OAuthTokens(
        accessToken = "plum_pat_1",
        scope = "files:app",
        refreshToken = "plum_rt_1",
        expiresAt = System.currentTimeMillis() + 3_600_000,
        appFolder = APP_FOLDER,
    )

    @Test
    fun `stores the whole set with iss and clientId and keeps it current across refreshes`() = boxTest {
        val store = InMemoryTokenStore()
        val c = PlumClient(baseUrl = BOX, clientId = CLIENT_ID, http = box.http, tokenStore = store)
        c.setToken(full)
        assertEquals(PlumConnection(BOX, CLIENT_ID, full), store.load())

        box.access = "plum_pat_rotated_away"
        c.drive.list(APP_FOLDER)
        val saved = store.load()!!
        assertEquals("plum_pat_2", saved.tokens.accessToken)
        assertEquals("plum_rt_2", saved.tokens.refreshToken)
        assertEquals(APP_FOLDER, saved.tokens.appFolder)
        assertEquals("files:app", saved.tokens.scope)

        // After a restart: the saved connection is enough to rebuild the client.
        val again = PlumClient.fromStore(store, http = box.http)!!
        assertEquals(BOX, again.baseUrl)
        assertEquals(CLIENT_ID, again.clientId)
        assertEquals(APP_FOLDER, again.appFolder)
        again.auth.me()
        assertEquals("Bearer plum_pat_2", box.seen.last().header("authorization"))
    }

    @Test
    fun `loadToken adopts a saved connection for this box and client only`() = boxTest {
        val store = InMemoryTokenStore(PlumConnection(BOX, CLIENT_ID, full))
        val c = PlumClient(baseUrl = BOX, clientId = CLIENT_ID, http = box.http, tokenStore = store)
        assertTrue(c.loadToken())
        assertTrue(c.hasToken)
        assertEquals(full, c.tokens)

        val otherBox = PlumClient(baseUrl = "https://pb-y.plumbox.me", clientId = CLIENT_ID, http = box.http, tokenStore = store)
        assertFalse(otherBox.loadToken())
        assertFalse(otherBox.hasToken)
        val otherClient = PlumClient(baseUrl = BOX, clientId = "com.other:android", http = box.http, tokenStore = store)
        assertFalse(otherClient.loadToken())
        assertFalse(PlumClient(baseUrl = BOX, clientId = CLIENT_ID, http = box.http).loadToken())
    }

    @Test
    fun `a PAT is stored as a set with no refresh token, and clearToken forgets it`() = boxTest {
        val store = InMemoryTokenStore()
        val c = PlumClient(baseUrl = BOX, tokenStore = store)
        c.setToken("plum_pat_x")
        assertEquals(PlumConnection(BOX, null, OAuthTokens("plum_pat_x")), store.load())
        c.clearToken()
        assertNull(store.load())
        assertFalse(c.hasToken)
        assertNull(c.tokens)
        assertNull(PlumClient.fromStore(store))
    }

    @Test
    fun `a failing store does not fail the request that refreshed`() = boxTest {
        box.access = "plum_pat_rotated_away"
        val broken = object : TokenStore {
            override suspend fun load(): PlumConnection? = null
            override suspend fun save(connection: PlumConnection) = throw IllegalStateException("disk full")
            override suspend fun clear() = Unit
        }
        val rotated = mutableListOf<OAuthTokens>()
        val c = PlumClient(
            baseUrl = BOX, token = "plum_pat_1", refreshToken = "plum_rt_1", expiresAt = full.expiresAt,
            clientId = CLIENT_ID, http = box.http, tokenStore = broken, onTokens = { rotated += it },
        )
        c.drive.list(APP_FOLDER)
        assertEquals("plum_rt_2", rotated.single().refreshToken)
    }

    @Test
    fun `the stored form round-trips and refuses what it did not write`() {
        val conn = PlumConnection(BOX, CLIENT_ID, full)
        assertEquals(conn, ConnectionCodec.decode(ConnectionCodec.encode(conn)))
        val old = PlumConnection(BOX, null, OAuthTokens("plum_pat_old", scope = "files:read"))
        assertEquals(old, ConnectionCodec.decode(ConnectionCodec.encode(old)))
        // The token fields carry @plumbox/client's names.
        val json = org.json.JSONObject(ConnectionCodec.encode(conn))
        assertEquals("plum_rt_1", json.getString("refreshToken"))
        assertEquals(APP_FOLDER, json.getString("appFolder"))
        for (bad in listOf("", "plum_pat_bare", "{}", """{"v":2,"iss":"x","accessToken":"a"}""", """{"v":1,"accessToken":"a"}""")) {
            assertNull(bad, ConnectionCodec.decode(bad))
        }
    }

    @Test
    fun `the AES-GCM envelope opens only with its key and its store name`() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val aad = "plumbox-client:default".toByteArray()
        val plain = ConnectionCodec.encode(PlumConnection(BOX, CLIENT_ID, full))

        val a = SealedBox.seal(key, plain, aad)
        val b = SealedBox.seal(key, plain, aad)
        assertNotEquals("a fresh IV every time", a, b)
        assertFalse(a.contains("plum_rt_1"))
        assertEquals(plain, SealedBox.open(key, a, aad))

        fun refused(block: () -> Unit) = assertTrue(runCatching(block).exceptionOrNull() is GeneralSecurityException)
        refused { SealedBox.open(other, a, aad) }
        refused { SealedBox.open(key, a, "plumbox-client:work".toByteArray()) }
        val tampered = a.toCharArray().also { it[it.size - 6] = if (it[it.size - 6] == 'A') 'B' else 'A' }.concatToString()
        refused { SealedBox.open(key, tampered, aad) }
        refused { SealedBox.open(key, "not base64!", aad) }
        refused { SealedBox.open(key, "AQw=", aad) }
    }
}
