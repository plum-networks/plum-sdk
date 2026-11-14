package im.plum.plumbox.client

import kotlinx.coroutines.flow.toList
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.net.URLEncoder

// The README quickstart, end to end against the fake box: authorize, read the
// redirect, exchange the code (the box checks PKCE), store, rebuild, use.
class ReadmeFlowTest {
    private val box = FakeBox()

    @After fun tearDown() = box.close()

    private val redirectUri = "com.example.notes://plum/callback"

    @Test
    fun `the quickstart works from the first click to the first upload`() = boxTest {
        // (1) Start authorization.
        val req = beginAuthorization(clientId = CLIENT_ID, redirectUri = redirectUri, scopes = listOf(OAuthScope.FILES_APP))
        val authorize = req.url.toHttpUrl()

        // The user signs in on their box and approves; the box redirects back.
        val code = box.approve(authorize.queryParameter("code_challenge")!!, authorize.queryParameter("redirect_uri")!!)
        val e = { s: String -> URLEncoder.encode(s, "UTF-8") }
        val incoming = "$redirectUri?code=${e(code)}&state=${e(authorize.queryParameter("state")!!)}&iss=${e(BOX)}"

        // (2) The redirect handler.
        val cb = parseCallback(incoming)
        val cbCode = cb.code
        val iss = cb.iss
        assertEquals(null, cb.error)
        assertNotNull(cbCode)
        assertNotNull(iss)
        val tokens = exchangeCode(
            baseUrl = iss!!,
            code = cbCode!!,
            state = cb.state,
            expectedState = req.state,
            codeVerifier = req.codeVerifier,
            clientId = CLIENT_ID,
            redirectUri = redirectUri,
            http = box.http,
        )
        assertEquals(APP_FOLDER, tokens.appFolder)
        val store = InMemoryTokenStore()
        store.save(PlumConnection(iss = iss, clientId = CLIENT_ID, tokens = tokens))

        // Later (after a restart): rebuild the client and use the box.
        val client = PlumClient.fromStore(store, http = box.http)!!
        val root = client.appFolder!!
        client.drive.ensureDir("$root/vault")
        client.drive.upload("$root/vault/note.md", "# hello", overwrite = true)
        assertEquals(emptyList<DriveEntry>(), client.drive.listAll(root, recursive = true, hash = true).toList())

        // A code works once.
        val again = runCatching {
            exchangeCode(iss, cbCode, cb.state, req.state, req.codeVerifier, CLIENT_ID, redirectUri, http = box.http)
        }.exceptionOrNull()
        assertEquals("invalid_grant", (again as PlumApiError).code)
    }

    @Test
    fun `a verifier that is not the one the challenge was made from is refused by the box`() = boxTest {
        val req = beginAuthorization(clientId = CLIENT_ID, redirectUri = redirectUri, scopes = listOf(OAuthScope.FILES_APP))
        val code = box.approve(req.url.toHttpUrl().queryParameter("code_challenge")!!, redirectUri)
        val other = beginAuthorization(clientId = CLIENT_ID, redirectUri = redirectUri, scopes = listOf(OAuthScope.FILES_APP))
        val err = runCatching {
            exchangeCode(BOX, code, req.state, req.state, other.codeVerifier, CLIENT_ID, redirectUri, http = box.http)
        }.exceptionOrNull()
        assertEquals("invalid_grant", (err as PlumApiError).code)
    }
}
