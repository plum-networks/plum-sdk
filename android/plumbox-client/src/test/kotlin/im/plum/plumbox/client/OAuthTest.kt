package im.plum.plumbox.client

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit

// The Kotlin twin of oauth.test.ts.

private val LONGEST = "pb-" + "a".repeat(59) // 62-character DNS label

/** v3 contract 10.1 / Appendix C: the iss vectors every SDK shares. */
private val GOOD_ISS = listOf(
    "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me", // what relay names a box
    "https://pb-x.plumbox.me",
    "https://pb-a1.plumbox.me",
    "https://pb-old-style-name.plumbox.me", // not narrowed to hex: older names exist
    "https://pb-xlan.plumbox.me", // ends in "lan", but not the -lan alias
    "https://$LONGEST.plumbox.me",
)

private val BAD_ISS: List<Pair<String, String?>> = listOf(
    "LAN alias" to "https://pb-0123456789abcdef0123456789ab7f3a-lan.plumbox.me",
    "WAN alias" to "https://pb-0123456789abcdef0123456789ab7f3a-wan.plumbox.me",
    "short LAN alias" to "https://pb-x-lan.plumbox.me",
    "short WAN alias" to "https://pb-x-wan.plumbox.me",
    "other domain" to "https://pb-x.evil.example",
    "lookalike suffix" to "https://pb-x.plumbox.me.evil.example",
    "other domain ending like ours" to "https://pb-x.notplumbox.me",
    "the portal" to "https://plumbox.me",
    "the relay" to "https://relay.plumbox.me",
    "not a box name" to "https://www.plumbox.me",
    "http" to "http://pb-x.plumbox.me",
    "port" to "https://pb-x.plumbox.me:443",
    "other port" to "https://pb-x.plumbox.me:8443",
    "empty" to "",
    "missing" to null,
    "trailing slash" to "https://pb-x.plumbox.me/",
    "path" to "https://pb-x.plumbox.me/api",
    "query" to "https://pb-x.plumbox.me?x=1",
    "fragment" to "https://pb-x.plumbox.me#x",
    "user info" to "https://user@pb-x.plumbox.me",
    "upper case" to "https://PB-X.plumbox.me",
    "upper-case name" to "https://pb-X.plumbox.me",
    "upper-case scheme" to "HTTPS://pb-x.plumbox.me",
    "empty name" to "https://pb-.plumbox.me",
    "name starts with a hyphen" to "https://pb--x.plumbox.me",
    "name ends with a hyphen" to "https://pb-x-.plumbox.me",
    "subdomain of a box" to "https://a.pb-x.plumbox.me",
    "dot in the name" to "https://pb-x.y.plumbox.me",
    "too long" to "https://${LONGEST}a.plumbox.me",
    "leading space" to " https://pb-x.plumbox.me",
    "trailing newline" to "https://pb-x.plumbox.me\n",
    "trailing dot" to "https://pb-x.plumbox.me.",
)

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

private fun cbUrl(q: String) = "myapp://plum/callback?$q"

class BeginAuthorizationTest {
    @Test
    fun `requires a registered clientId and at least one scope`() {
        val noId = runCatching { beginAuthorization(" ", "x://cb", listOf(OAuthScope.FILES_READ)) }.exceptionOrNull()
        assertTrue(noId is IllegalArgumentException && noId.message!!.contains("clientId is required"))
        val noScope = runCatching { beginAuthorization("com.example.notes:android", "x://cb", emptyList()) }.exceptionOrNull()
        assertTrue(noScope is IllegalArgumentException && noScope.message!!.contains("scope"))
    }

    @Test
    fun `sends the scope vocabulary and no client_name`() {
        val req = beginAuthorization(
            clientId = "com.example.notes:android",
            redirectUri = "examplenotes://oauth/callback",
            scopes = listOf(OAuthScope.FILES_READ, OAuthScope.USER_PROFILE, OAuthScope.serviceCall("com.example.notes")),
        )
        val url = req.url.toHttpUrl()
        assertEquals("files:read user:profile service:call:com.example.notes", url.queryParameter("scope"))
        assertNull(url.queryParameter("client_name"))
    }

    @Test
    fun `builds a portal URL with a valid S256 PKCE challenge`() {
        val req = beginAuthorization(
            clientId = "obsidian-plum-sync",
            redirectUri = "obsidian://plum-sync/callback",
            scopes = listOf(OAuthScope.READ, OAuthScope.WRITE),
        )
        val url = req.url.toHttpUrl()
        assertEquals("https://plumbox.me/authorize", url.newBuilder().query(null).build().toString())
        assertEquals("code", url.queryParameter("response_type"))
        assertEquals("S256", url.queryParameter("code_challenge_method"))
        assertEquals("obsidian-plum-sync", url.queryParameter("client_id"))
        assertEquals("obsidian://plum-sync/callback", url.queryParameter("redirect_uri"))
        assertEquals("read write", url.queryParameter("scope"))
        assertEquals(req.state, url.queryParameter("state"))

        // The challenge must equal base64url(SHA-256(verifier)) — the exact
        // check the box performs — computed here independently of the SDK.
        val digest = MessageDigest.getInstance("SHA-256").digest(req.codeVerifier.toByteArray(Charsets.US_ASCII))
        val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        assertEquals(expected, url.queryParameter("code_challenge"))

        // RFC 7636: 43–128 characters from the unreserved set. 32 random bytes → 43.
        assertTrue(req.codeVerifier.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        assertTrue(req.state.matches(Regex("^[A-Za-z0-9_-]{22}$")))
        // The verifier never leaves in the URL.
        assertFalse(req.url.contains(req.codeVerifier))
    }

    @Test
    fun `the challenge matches RFC 7636 appendix B`() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
    }

    @Test
    fun `produces a fresh verifier and state each call`() {
        val a = beginAuthorization("x", "obsidian://x/cb", listOf(OAuthScope.READ))
        val b = beginAuthorization("x", "obsidian://x/cb", listOf(OAuthScope.READ))
        assertNotEquals(a.codeVerifier, b.codeVerifier)
        assertNotEquals(a.state, b.state)
    }

    @Test
    fun `starts at the environment's portal`() {
        val staging = beginAuthorization("x", "x://cb", listOf(OAuthScope.FILES_APP), boxDomain = "staging.plumbox.me")
        assertTrue(staging.url.startsWith("https://staging.plumbox.me/authorize?"))
        val custom = beginAuthorization("x", "x://cb", listOf(OAuthScope.FILES_APP), portalUrl = "https://plumbox.me///")
        assertTrue(custom.url.startsWith("https://plumbox.me/authorize?"))
        assertTrue(runCatching { beginAuthorization("x", "x://cb", listOf("read"), boxDomain = "plumbox.dev") }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `keeps the verifier out of toString`() {
        val req = beginAuthorization("x", "x://cb", listOf(OAuthScope.FILES_APP))
        assertFalse(req.toString().contains(req.codeVerifier))
    }
}

class IsPlumIssuerTest {
    @Test
    fun `accepts every canonical box origin`() {
        for (iss in GOOD_ISS) assertTrue(iss, isPlumIssuer(iss))
    }

    @Test
    fun `refuses everything else`() {
        for ((name, iss) in BAD_ISS) assertFalse(name, isPlumIssuer(iss))
    }

    @Test
    fun `each environment takes only its own boxes`() {
        assertTrue(isPlumIssuer("https://pb-x.staging.plumbox.me", "staging.plumbox.me"))
        assertTrue(isPlumIssuer("https://pb-x.staging.plumbox.me", "STAGING.plumbox.me"))
        assertFalse(isPlumIssuer("https://pb-x.staging.plumbox.me"))
        assertFalse(isPlumIssuer("https://pb-x.plumbox.me", "staging.plumbox.me"))
        assertFalse(isPlumIssuer("https://pb-x-lan.staging.plumbox.me", "staging.plumbox.me"))
        assertTrue(runCatching { isPlumIssuer(BOX, "plumbox.dev") }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `the exported pattern is the production shape`() {
        assertTrue(PLUM_ISSUER_PATTERN.matches("https://pb-x.plumbox.me"))
        assertFalse(PLUM_ISSUER_PATTERN.matches("https://pb-x.plumbox.me\n"))
    }
}

class ParseCallbackTest {
    private val cases: List<Triple<String, List<Pair<String, String>>, CallbackResult>> = listOf(
        Triple("a code from a box", listOf("code" to "C1", "state" to "S", "iss" to GOOD_ISS[0]), CallbackResult(code = "C1", state = "S", iss = GOOD_ISS[0])),
        Triple("a code with no iss", listOf("code" to "C1", "state" to "S"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code with an empty iss", listOf("code" to "C1", "state" to "S", "iss" to ""), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code from the LAN alias", listOf("code" to "C1", "state" to "S", "iss" to "https://pb-x-lan.plumbox.me"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code from the WAN alias", listOf("code" to "C1", "state" to "S", "iss" to "https://pb-x-wan.plumbox.me"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code from another domain", listOf("code" to "C1", "state" to "S", "iss" to "https://pb-x.evil.example"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code over http", listOf("code" to "C1", "state" to "S", "iss" to "http://pb-x.plumbox.me"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("a code with a port", listOf("code" to "C1", "state" to "S", "iss" to "https://pb-x.plumbox.me:8443"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("an error from an older box (no iss)", listOf("error" to "access_denied", "state" to "S"), CallbackResult(state = "S", error = "access_denied")),
        Triple("an error with the box's iss", listOf("error" to "access_denied", "state" to "S", "iss" to BOX), CallbackResult(state = "S", iss = BOX, error = "access_denied")),
        Triple("an error with a bad iss", listOf("error" to "access_denied", "state" to "S", "iss" to "https://pb-x-lan.plumbox.me"), CallbackResult(state = "S", error = "invalid_iss")),
        Triple("an error and a code", listOf("error" to "access_denied", "code" to "C1", "state" to "S", "iss" to BOX), CallbackResult(state = "S", iss = BOX, error = "access_denied")),
        Triple("neither code nor error", listOf("state" to "S", "iss" to BOX), CallbackResult(state = "S", error = "invalid_request")),
    )

    @Test
    fun `reads and checks every kind of callback`() {
        for ((name, params, want) in cases) {
            val q = params.joinToString("&") { (k, v) -> "$k=${enc(v)}" }
            assertEquals(name, want, parseCallback(cbUrl(q)))
        }
    }

    @Test
    fun `never hands back a code without a checked iss`() {
        for ((name, iss) in BAD_ISS) {
            val q = "code=C1&state=S" + (iss?.let { "&iss=${enc(it)}" } ?: "")
            val cb = parseCallback(cbUrl(q))
            assertNull(name, cb.code)
            assertNull(name, cb.iss)
            assertEquals(name, "invalid_iss", cb.error)
        }
    }

    @Test
    fun `refuses an iss given twice, even when one of them is good`() {
        assertEquals(
            CallbackResult(state = "S", error = "invalid_iss"),
            parseCallback(cbUrl("code=C1&state=S&iss=${enc(BOX)}&iss=${enc("https://evil.example")}")),
        )
        assertEquals(
            CallbackResult(state = "S", error = "invalid_iss"),
            parseCallback(cbUrl("code=C1&state=S&iss=${enc("https://evil.example")}&iss=${enc(BOX)}")),
        )
        assertEquals(CallbackResult(state = "S", error = "invalid_iss"), parseCallback(cbUrl("code=C1&state=S&iss=${enc(BOX)}&iss=${enc(BOX)}")))
    }

    @Test
    fun `refuses a code given twice`() {
        assertEquals(
            CallbackResult(state = "S", iss = BOX, error = "invalid_request"),
            parseCallback(cbUrl("code=A&code=B&state=S&iss=${enc(BOX)}")),
        )
    }

    @Test
    fun `a state given twice is no state, so the exchange refuses it`() = boxTest {
        val cb = parseCallback(cbUrl("code=C1&state=S&state=T&iss=${enc(BOX)}"))
        assertNull(cb.state)
        val err = assertThrowsSuspend<PlumOAuthError> {
            exchangeCode(cb.iss!!, cb.code!!, cb.state, "S", "V", CLIENT_ID, "myapp://plum/callback", http = { fail("sent"); throw AssertionError() })
        }
        assertEquals("invalid_state", err.code)
    }

    @Test
    fun `checks against the chosen environment`() {
        val staging = "https://pb-x.staging.plumbox.me"
        assertEquals(CallbackResult(code = "C1", state = "S", iss = staging), parseCallback(cbUrl("code=C1&state=S&iss=${enc(staging)}"), "staging.plumbox.me"))
        assertEquals("invalid_iss", parseCallback(cbUrl("code=C1&state=S&iss=${enc(staging)}")).error)
        assertEquals("invalid_iss", parseCallback(cbUrl("code=C1&state=S&iss=${enc(BOX)}"), "staging.plumbox.me").error)
    }

    @Test
    fun `throws on a malformed URL`() {
        for (bad in listOf("not a url", "relative/path?code=C1", "myapp://plum/callback?code=%zz")) {
            assertTrue(bad, runCatching { parseCallback(bad) }.exceptionOrNull() is IllegalArgumentException)
        }
    }
}

/** A token endpoint on MockWebServer; requests reach it whatever host the SDK addressed. */
private class TokenEndpoint : AutoCloseable {
    val server = MockWebServer().apply { start() }
    val http = reroutingAdapter(server)

    fun answer(status: Int, body: String) = server.enqueue(json(status, body))

    fun taken(): Seen = server.takeRequest(5, TimeUnit.SECONDS)!!.toSeen()

    override fun close() = server.shutdown()
}

class ExchangeCodeTest {
    private val box = TokenEndpoint()

    @After fun tearDown() = box.close()

    private suspend fun exchange(
        baseUrl: String = BOX,
        code: String = "CODE1",
        state: String? = "ST",
        expectedState: String = "ST",
        codeVerifier: String = "VERIFIER1",
        boxDomain: String? = null,
    ) = exchangeCode(
        baseUrl = baseUrl,
        code = code,
        state = state,
        expectedState = expectedState,
        codeVerifier = codeVerifier,
        clientId = CLIENT_ID,
        redirectUri = "obsidian://plum-sync",
        http = box.http,
        boxDomain = boxDomain,
    )

    @Test
    fun `POSTs the authorization_code grant to the iss and returns the tokens (current box)`() = boxTest {
        box.answer(
            200,
            """{"access_token":"plum_pat_abc","token_type":"bearer","expires_in":3600,"refresh_token":"plum_rt_1","scope":"files:app user:profile","app_folder":"/Apps/Obsidian Sync"}""",
        )
        val before = System.currentTimeMillis()
        val out = exchange()
        assertEquals("plum_pat_abc", out.accessToken)
        assertEquals("bearer", out.tokenType)
        assertEquals("files:app user:profile", out.scope)
        assertEquals("plum_rt_1", out.refreshToken)
        assertEquals("/Apps/Obsidian Sync", out.appFolder)
        assertTrue(out.expiresAt!! >= before + 3_600_000 && out.expiresAt!! <= System.currentTimeMillis() + 3_600_000)

        val sent = box.taken()
        assertEquals(1, box.server.requestCount)
        assertEquals("POST", sent.method)
        assertEquals("$BOX/api/oauth/token", sent.url)
        assertEquals("application/json", sent.header("content-type"))
        val body = sent.json()
        assertEquals(setOf("grant_type", "code", "code_verifier", "client_id", "redirect_uri"), body.keys().asSequence().toSet())
        assertEquals("authorization_code", body.getString("grant_type"))
        assertEquals("CODE1", body.getString("code"))
        assertEquals("VERIFIER1", body.getString("code_verifier"))
        assertEquals(CLIENT_ID, body.getString("client_id"))
        assertEquals("obsidian://plum-sync", body.getString("redirect_uri"))
    }

    @Test
    fun `takes an older box's answer - a token that never expires, no refresh token`() = boxTest {
        box.answer(200, """{"access_token":"plum_pat_old","token_type":"bearer","scope":"files:read files:write"}""")
        assertEquals(OAuthTokens(accessToken = "plum_pat_old", tokenType = "bearer", scope = "files:read files:write"), exchange())
    }

    @Test
    fun `sends nothing to an iss that is not a Plum box (invalid_iss)`() = boxTest {
        for ((name, iss) in BAD_ISS) {
            val err = assertThrowsSuspend<PlumOAuthError> { exchange(baseUrl = iss ?: "") }
            assertEquals(name, "invalid_iss", err.code)
        }
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `sends nothing for a state that does not match (invalid_state)`() = boxTest {
        val cases = listOf<Pair<String?, String>>("OTHER" to "ST", null to "ST", "ST" to "", "" to "")
        for ((state, expected) in cases) {
            val err = assertThrowsSuspend<PlumOAuthError> { exchange(state = state, expectedState = expected) }
            assertEquals("$state/$expected", "invalid_state", err.code)
        }
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `checks iss before state`() = boxTest {
        val err = assertThrowsSuspend<PlumOAuthError> { exchange(baseUrl = "https://evil.example", state = "OTHER") }
        assertEquals("invalid_iss", err.code)
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `sends nothing without a code or a verifier (invalid_request)`() = boxTest {
        assertEquals("invalid_request", assertThrowsSuspend<PlumOAuthError> { exchange(code = "") }.code)
        assertEquals("invalid_request", assertThrowsSuspend<PlumOAuthError> { exchange(codeVerifier = "") }.code)
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `exchanges exactly what a good callback carried, end to end`() = boxTest {
        box.answer(200, """{"access_token":"plum_pat_abc","token_type":"bearer","scope":"files:app"}""")
        val cb = parseCallback(cbUrl("code=CODE1&state=ST&iss=${enc(BOX)}"))
        exchange(baseUrl = cb.iss!!, code = cb.code!!, state = cb.state)
        assertEquals("$BOX/api/oauth/token", box.taken().url)
    }

    @Test
    fun `works in the staging environment and refuses production there`() = boxTest {
        box.answer(200, """{"access_token":"plum_pat_s","scope":"files:app"}""")
        exchange(baseUrl = "https://pb-x.staging.plumbox.me", boxDomain = "staging.plumbox.me")
        assertEquals("https://pb-x.staging.plumbox.me/api/oauth/token", box.taken().url)
        assertEquals("invalid_iss", assertThrowsSuspend<PlumOAuthError> { exchange(boxDomain = "staging.plumbox.me") }.code)
    }

    @Test
    fun `refuses a 200 that carries no access token`() = boxTest {
        box.answer(200, """{"token_type":"bearer"}""")
        assertEquals("invalid_token_response", assertThrowsSuspend<PlumApiError> { exchange() }.code)
    }

    @Test
    fun `a refusal from the box is a PlumApiError with its OAuth code`() = boxTest {
        box.answer(400, """{"error":"invalid_grant","error_description":"bad code"}""")
        val err = assertThrowsSuspend<PlumApiError> { exchange(code = "bad") }
        assertEquals(400, err.status)
        assertEquals("invalid_grant", err.code)
        assertFalse(err is PlumAuthError)
    }
}

class RefreshTokensTest {
    private val box = TokenEndpoint()

    @After fun tearDown() = box.close()

    private val rotated =
        """{"access_token":"plum_pat_2","token_type":"bearer","expires_in":3600,"refresh_token":"plum_rt_2","scope":"files:app","app_folder":"/Apps/Obsidian Sync"}"""

    private suspend fun refresh(iss: String = BOX, clientId: String = CLIENT_ID, refreshToken: String = "plum_rt_1") =
        refreshTokens(iss = iss, clientId = clientId, refreshToken = refreshToken, http = box.http)

    @Test
    fun `POSTs the refresh_token grant to iss and returns the rotated set`() = boxTest {
        box.answer(200, rotated)
        val out = refresh()
        assertEquals(OAuthTokens("plum_pat_2", "bearer", "files:app", "plum_rt_2", out.expiresAt, "/Apps/Obsidian Sync"), out)
        assertTrue(out.expiresAt!! > System.currentTimeMillis() + 3_500_000)
        val sent = box.taken()
        assertEquals("$BOX/api/oauth/token", sent.url)
        assertEquals("POST", sent.method)
        // JSON, exactly as @plumbox/client sends it.
        assertEquals("application/json", sent.header("content-type"))
        val body = sent.json()
        assertEquals(setOf("grant_type", "refresh_token", "client_id"), body.keys().asSequence().toSet())
        assertEquals("refresh_token", body.getString("grant_type"))
        assertEquals("plum_rt_1", body.getString("refresh_token"))
        assertEquals(CLIENT_ID, body.getString("client_id"))
    }

    @Test
    fun `sends nothing to an iss that is not a Plum box (invalid_iss)`() = boxTest {
        for ((name, iss) in BAD_ISS) {
            assertEquals(name, "invalid_iss", assertThrowsSuspend<PlumOAuthError> { refresh(iss = iss ?: "") }.code)
        }
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `sends nothing without a refresh token or a client id`() = boxTest {
        assertEquals("invalid_request", assertThrowsSuspend<PlumOAuthError> { refresh(refreshToken = "") }.code)
        assertEquals("invalid_request", assertThrowsSuspend<PlumOAuthError> { refresh(clientId = "") }.code)
        assertEquals(0, box.server.requestCount)
    }

    @Test
    fun `invalid_grant is a PlumAuthError - the connection is gone`() = boxTest {
        box.answer(400, """{"error":"invalid_grant","error_description":"connect the app again"}""")
        val err = assertThrowsSuspend<PlumAuthError> { refresh() }
        assertEquals(400, err.status)
        assertEquals("invalid_grant", err.code)
    }

    @Test
    fun `any other failure is not - the refresh token is still good`() = boxTest {
        for ((status, body) in listOf(500 to "boom", 400 to """{"error":"invalid_request"}""", 503 to """{"error":"unavailable"}""")) {
            box.answer(status, body)
            val err = assertThrowsSuspend<PlumApiError> { refresh() }
            assertFalse("$status", err is PlumAuthError)
            assertEquals(status, err.status)
        }
    }

    @Test
    fun `a box that cannot be reached is a plain PlumApiError`() = boxTest {
        box.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        val err = assertThrowsSuspend<PlumApiError> { refresh() }
        assertFalse(err is PlumAuthError)
        assertEquals(0, err.status)
        assertEquals("network_error", err.code)
    }

    @Test
    fun `keeps the refresh token it sent when the box returns none`() = boxTest {
        box.answer(200, """{"access_token":"plum_pat_2","token_type":"bearer","expires_in":3600,"scope":"files:app"}""")
        assertEquals("plum_rt_1", refresh().refreshToken)
    }
}

class ErrorMappingTest {
    @Test
    fun `maps statuses and bodies like errors ts`() {
        val unauthorized = errorFromResponse(401, """{"error":"invalid_token"}""")
        assertTrue(unauthorized is PlumAuthError)
        assertEquals("invalid_token", unauthorized.code)
        assertEquals("invalid_token", unauthorized.message)

        val forbidden = errorFromResponse(403, """{"error":"forbidden","message":"outside the app folder"}""")
        assertTrue(forbidden is PlumForbiddenError)
        assertEquals("forbidden", forbidden.code)
        assertEquals("outside the app folder", forbidden.message)

        val plain = errorFromResponse(500, "  boom \n")
        assertEquals(PlumApiError::class.java, plain.javaClass)
        assertNull(plain.code)
        assertEquals("boom", plain.message)

        assertEquals(500, errorFromResponse(502, "x".repeat(800)).message!!.length)
    }

    @Test
    fun `token sets keep their secrets out of toString`() {
        val t = OAuthTokens("plum_pat_SECRETVALUE", refreshToken = "plum_rt_OTHERSECRET", scope = "files:app")
        assertFalse(t.toString().contains("SECRETVALUE"))
        assertFalse(t.toString().contains("OTHERSECRET"))
        assertTrue(t.toString().contains("plum_pat_…"))
    }
}
