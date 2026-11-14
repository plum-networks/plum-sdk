@file:JvmName("PlumOAuth")

package im.plum.plumbox.client

import okio.ByteString.Companion.toByteString
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.contracts.ExperimentalContracts
import kotlin.contracts.contract

/*
 * Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for
 * third-party apps — the Kotlin twin of `oauth.ts`. The user finds their box
 * on plumbox.me (their email and a code Plum mails them) and types the
 * password only on that box's own page — NEVER inside your app. Your app
 * receives a scoped, revocable token, never the password.
 *
 * Two halves:
 *   1. beginAuthorization() builds the authorization URL + a PKCE verifier.
 *      Open the URL in the system browser (PlumAuthorization.launch: Custom
 *      Tabs); the user picks their box, signs in there and approves; the box
 *      redirects back to your redirectUri with ?code=…&state=…&iss=….
 *   2. parseCallback() reads that redirect and checks iss; exchangeCode()
 *      swaps the code (+ the verifier) for the tokens at that box — and only
 *      at that box.
 *
 * The access token expires after an hour; the refresh token that comes with
 * it gets a new one (refreshTokens, which PlumClient calls by itself when
 * given refreshToken + clientId). Older boxes issue a token that never
 * expires and no refresh token.
 */

/** The production portal, where the authorization starts. */
public const val DEFAULT_PORTAL_URL: String = "https://plumbox.me"

/** `iss` for a box of the environment whose box domain is [boxDomain]. */
private fun issuerPattern(boxDomain: String): Regex =
    Regex("^https://pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\\." + Regex.escape(boxDomain) + "$")

/**
 * The shape of every Plum box's own address, as `iss` (v3 contract 10.1). A
 * box answers an authorization with its canonical origin. Its LAN and WAN
 * aliases (`pb-…-lan`, `pb-…-wan`) are refused on top of this pattern by
 * [isPlumIssuer]. The name is not narrowed to hex: older box names exist.
 * Match it against the whole string ([Regex.matches]).
 */
public val PLUM_ISSUER_PATTERN: Regex = issuerPattern(PlumEnvironment.PRODUCTION.boxDomain)

/**
 * Whether [iss] is a Plum box's canonical origin: `https://pb-<name>.plumbox.me`
 * exactly — https, no port, no path, no trailing slash, lower case, and not
 * the box's `-lan`/`-wan` alias. [boxDomain] picks the environment (default
 * production, `plumbox.me`; `staging.plumbox.me` for Plum's staging): a box
 * of another environment is not one.
 *
 * Limit: this says "a Plum box", not "the box the user picked". Swapping in a
 * different Plum box is stopped elsewhere (the signed directory list and the
 * portal sending the user only to the box they chose).
 */
@OptIn(ExperimentalContracts::class)
public fun isPlumIssuer(iss: String?, boxDomain: String? = null): Boolean {
    contract { returns(true) implies (iss != null) }
    val domain = plumEnvironment(boxDomain).boxDomain
    val pattern = if (domain == PlumEnvironment.PRODUCTION.boxDomain) PLUM_ISSUER_PATTERN else issuerPattern(domain)
    return iss != null &&
        pattern.matches(iss) &&
        !iss.endsWith("-lan.$domain") &&
        !iss.endsWith("-wan.$domain")
}

/** What [beginAuthorization] returns. Keep [codeVerifier] and [state] until the redirect returns. */
public data class AuthorizationRequest(
    /** Open this in the system browser (`PlumAuthorization.launch`). */
    val url: String,
    /** Keep until the redirect returns; needed to exchange the code. */
    val codeVerifier: String,
    /** Keep until the redirect returns; pass it to [exchangeCode] as `expectedState`. */
    val state: String,
) {
    override fun toString(): String = "AuthorizationRequest(url=$url, codeVerifier=…, state=$state)"
}

/** What [parseCallback] read from the redirect. */
public data class CallbackResult(
    /** Present only when the callback also carried a valid [iss]. */
    val code: String? = null,
    val state: String? = null,
    /**
     * The box that issued the code, already checked with [isPlumIssuer] —
     * pass it to [exchangeCode] as `baseUrl` and keep it as the box's
     * address. `null` when the callback carried none (an error callback from
     * an older box) or one that failed the check.
     */
    val iss: String? = null,
    /**
     * Set when there is nothing to exchange: the box's own error (e.g.
     * `"access_denied"`), `"invalid_iss"` when the callback's `iss` is missing
     * or not a Plum box (the code is then dropped), or `"invalid_request"`
     * when the callback carried neither a code nor an error.
     */
    val error: String? = null,
)

private val secureRandom = SecureRandom()

private fun randomBytes(n: Int): ByteArray = ByteArray(n).also { secureRandom.nextBytes(it) }

// okio (shipped with OkHttp) rather than java.util.Base64, which needs API 26.
internal fun base64Url(bytes: ByteArray): String = bytes.toByteString().base64Url().trimEnd('=')

/** The PKCE S256 challenge for [codeVerifier]: base64url(SHA-256(verifier)), unpadded. */
internal fun pkceChallenge(codeVerifier: String): String =
    base64Url(MessageDigest.getInstance("SHA-256").digest(codeVerifier.toByteArray(Charsets.US_ASCII)))

/**
 * Build the authorization URL and the PKCE material. The verifier and
 * `state` must survive until the redirect comes back — the process may die
 * while the browser is open, so keep them somewhere that outlives it.
 *
 * @param clientId the client id you registered for this app in the Plum
 *   developer console (`<app_id>:<label>`, e.g. `com.example.notes:android`),
 *   or declared in your app's manifest `clients[]`. The box refuses an
 *   unregistered client_id with `unauthorized_client` before showing any
 *   consent screen.
 * @param redirectUri must equal one of the redirect URIs registered for the client.
 * @param scopes must be a subset of the scopes the client was registered with ([OAuthScope]).
 * @param portalUrl portal that hosts the /authorize entry (where the user
 *   finds their box). Default: the environment's portal.
 * @param boxDomain the environment, by box domain: `plumbox.me` (default) or `staging.plumbox.me`.
 * @throws IllegalArgumentException without a client id or a scope, or for an unknown [boxDomain].
 */
public fun beginAuthorization(
    clientId: String,
    redirectUri: String,
    scopes: List<String>,
    portalUrl: String? = null,
    boxDomain: String? = null,
): AuthorizationRequest {
    val id = clientId.trim()
    require(id.isNotEmpty()) {
        "beginAuthorization: clientId is required (register one in the Plum developer console)"
    }
    require(scopes.isNotEmpty()) { "beginAuthorization: at least one scope is required" }
    val portal = (portalUrl ?: plumEnvironment(boxDomain).portalOrigin).trimEnd('/')
    // PKCE verifier: 43–128 chars from the unreserved set. 32 random bytes
    // base64url-encoded → 43 chars.
    val codeVerifier = base64Url(randomBytes(32))
    val codeChallenge = pkceChallenge(codeVerifier)
    val state = base64Url(randomBytes(16))
    val query = formEncode(
        listOf(
            "response_type" to "code",
            "client_id" to id,
            "redirect_uri" to redirectUri,
            "scope" to scopes.joinToString(" "),
            "code_challenge" to codeChallenge,
            "code_challenge_method" to "S256",
            "state" to state,
        ),
    )
    return AuthorizationRequest("$portal/authorize?$query", codeVerifier, state)
}

/**
 * Read the redirect the box sent back to your `redirect_uri`
 * (e.g. `myapp://plum/callback?code=…&state=…&iss=…`) and check its `iss`
 * (v3 contract 10.1):
 *
 * - A code with no `iss`, or with one that is not a Plum box's own address,
 *   comes back as `error = "invalid_iss"` and WITHOUT the code — there is
 *   nothing left to send anywhere.
 * - An error callback is accepted without `iss` (older boxes send none); if
 *   it carries one, the same check applies.
 * - A parameter given twice is not one this flow produced: `iss` twice is
 *   `invalid_iss`, `code` twice is `invalid_request`.
 *
 * `state` is checked by [exchangeCode] (pass the one [beginAuthorization]
 * returned as `expectedState`).
 *
 * @throws IllegalArgumentException on a malformed or relative URL.
 */
public fun parseCallback(callbackUrl: String, boxDomain: String? = null): CallbackResult {
    plumEnvironment(boxDomain) // an unknown environment throws before anything is read
    val uri = try {
        URI(callbackUrl)
    } catch (e: URISyntaxException) {
        throw IllegalArgumentException("parseCallback: not a URL", e)
    }
    require(uri.isAbsolute) { "parseCallback: not a URL" }
    val all = parseQueryAll(uri.rawQuery)
    return checkCallback({ all[it] ?: emptyList() }, boxDomain)
}

/** `a=1&a=2&b=x+y` → every value of each key, decoded like `URLSearchParams`. */
private fun parseQueryAll(rawQuery: String?): Map<String, List<String>> {
    if (rawQuery.isNullOrEmpty()) return emptyMap()
    return try {
        rawQuery.split('&').filter { it.isNotEmpty() }.map { kv ->
            val i = kv.indexOf('=')
            val k = if (i < 0) kv else kv.substring(0, i)
            val v = if (i < 0) "" else kv.substring(i + 1)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }.groupBy({ it.first }, { it.second })
    } catch (e: IllegalArgumentException) {
        throw IllegalArgumentException("parseCallback: malformed query", e)
    }
}

private fun checkCallback(all: (String) -> List<String>, boxDomain: String?): CallbackResult {
    // A parameter that appears twice is not one this flow produced; refusing
    // it keeps "which iss did we check" and "which iss do we use" the same.
    fun twice(k: String): Boolean = all(k).size > 1
    fun one(k: String): String? = all(k).singleOrNull()?.takeIf { it.isNotEmpty() }

    val code = one("code")
    val state = one("state")
    val iss = one("iss")
    val error = one("error")

    if (twice("iss") || (iss != null && !isPlumIssuer(iss, boxDomain))) {
        return CallbackResult(state = state, error = PlumOAuthError.INVALID_ISS)
    }
    if (error != null || twice("error") || twice("code")) {
        // The box's own refusal (access_denied, …). No code goes with it,
        // even if one were present.
        return CallbackResult(state = state, iss = iss, error = error ?: PlumOAuthError.INVALID_REQUEST)
    }
    if (code == null) return CallbackResult(state = state, error = PlumOAuthError.INVALID_REQUEST)
    // A code and no box to name it: stop here (contract 10.1).
    if (iss == null) return CallbackResult(state = state, error = PlumOAuthError.INVALID_ISS)
    return CallbackResult(code = code, state = state, iss = iss)
}

/**
 * Exchange the authorization code for a scoped access token at the box that
 * issued it. Before anything is sent, [baseUrl] must be a Plum box's own
 * address ([PlumOAuthError] `invalid_iss` otherwise) and the callback's
 * [state] must equal [expectedState] (`invalid_state` otherwise). The code
 * goes to `<iss>/api/oauth/token` and nowhere else. Returns the tokens to
 * store; the password was never seen by your app.
 *
 * A current box returns an access token that expires in an hour plus a
 * refresh token (and `appFolder` when `files:app` was granted); hand all of
 * them to [PlumClient] and it keeps the access token fresh. An older box
 * returns `accessToken` + `scope` only — a token that never expires.
 *
 * Errors from the box carry its OAuth code in [PlumApiError.code]:
 * `invalid_grant` (code used, expired or PKCE mismatch), `unauthorized_client`
 * (client_id not registered), `invalid_scope`, `invalid_redirect_uri`.
 *
 * @param baseUrl the box to exchange the code at: the callback's `iss` (from [parseCallback]).
 * @param state the callback's `state`.
 * @param expectedState the `state` that [beginAuthorization] returned for this sign-in.
 */
public suspend fun exchangeCode(
    baseUrl: String,
    code: String,
    state: String?,
    expectedState: String,
    codeVerifier: String,
    clientId: String,
    redirectUri: String,
    http: HttpAdapter? = null,
    boxDomain: String? = null,
): OAuthTokens {
    val iss = baseUrl
    val domain = plumEnvironment(boxDomain).boxDomain
    if (!isPlumIssuer(iss, domain)) {
        throw PlumOAuthError(
            PlumOAuthError.INVALID_ISS,
            "exchangeCode: the callback's iss is not a Plum box (https://pb-….$domain); nothing was sent",
        )
    }
    if (expectedState.isEmpty() || state != expectedState) {
        throw PlumOAuthError(
            PlumOAuthError.INVALID_STATE,
            "exchangeCode: the callback's state is not the one this sign-in began with; nothing was sent",
        )
    }
    if (code.isEmpty() || codeVerifier.isEmpty()) {
        throw PlumOAuthError(PlumOAuthError.INVALID_REQUEST, "exchangeCode: code and codeVerifier are required")
    }
    val res = (http ?: OkHttpAdapter.default).request(
        HttpRequest(
            url = "$iss/api/oauth/token",
            method = "POST",
            headers = mapOf("content-type" to "application/json"),
            body = Json.encode(
                "grant_type" to "authorization_code",
                "code" to code,
                "code_verifier" to codeVerifier,
                "client_id" to clientId,
                "redirect_uri" to redirectUri,
            ),
        ),
    )
    if (res.status != 200) throw errorFromResponse(res.status, res.text())
    return tokensFromResponse(res, System.currentTimeMillis())
}

/**
 * Trade a refresh token for a new token set at `<iss>/api/oauth/token`
 * (`grant_type=refresh_token`). [PlumClient] calls this for you when it holds
 * a refresh token; call it yourself only if you manage tokens by hand.
 *
 * Refresh tokens ROTATE: the result carries a new `refreshToken` and the one
 * you sent stops working (the box forgives a repeat within 60 s, for a reply
 * that got lost). Store the new one before anything else; reusing an old one
 * after that ends the whole connection. A box that answers without a new
 * refresh token leaves the one you sent valid, and the result carries it.
 *
 * Throws [PlumAuthError] with status 400 and code `"invalid_grant"` when the
 * box refuses the refresh token (rotated away, revoked, 90 days unused, or
 * the user disconnected the app): the connection is gone and the user has to
 * connect again. Any other failure (network, 5xx) is a plain [PlumApiError] —
 * the refresh token is still good; try again later.
 *
 * @param iss the box the tokens came from: the `iss` the sign-in was checked
 *   against (the `baseUrl` given to [exchangeCode]). The same check applies:
 *   [PlumOAuthError] `invalid_iss` before the refresh token is sent anywhere.
 * @param clientId the client id the tokens were issued to.
 * @param refreshToken the newest refresh token you hold.
 */
public suspend fun refreshTokens(
    iss: String,
    clientId: String,
    refreshToken: String,
    http: HttpAdapter? = null,
    boxDomain: String? = null,
): OAuthTokens {
    val domain = plumEnvironment(boxDomain).boxDomain
    if (!isPlumIssuer(iss, domain)) {
        throw PlumOAuthError(
            PlumOAuthError.INVALID_ISS,
            "refreshTokens: iss is not a Plum box (https://pb-….$domain); nothing was sent",
        )
    }
    if (refreshToken.isEmpty() || clientId.isEmpty()) {
        throw PlumOAuthError(PlumOAuthError.INVALID_REQUEST, "refreshTokens: refreshToken and clientId are required")
    }
    // JSON, like @plumbox/client. (The box also takes the form-encoded body
    // RFC 6749 §3.2 describes, but only boxes new enough to refresh do.)
    val res = (http ?: OkHttpAdapter.default).request(
        HttpRequest(
            url = "$iss/api/oauth/token",
            method = "POST",
            headers = mapOf("content-type" to "application/json"),
            body = Json.encode(
                "grant_type" to "refresh_token",
                "refresh_token" to refreshToken,
                "client_id" to clientId,
            ),
        ),
    )
    if (res.status != 200) {
        val err = errorFromResponse(res.status, res.text())
        if (err.code == "invalid_grant") throw PlumAuthError(err.status, err.message ?: "invalid_grant", "invalid_grant")
        throw err
    }
    val tokens = tokensFromResponse(res, System.currentTimeMillis())
    return if (tokens.refreshToken == null) tokens.copy(refreshToken = refreshToken) else tokens
}

/** Read a 200 from the token endpoint (RFC 6749 5.1, plus Plum's `app_folder`). */
internal fun tokensFromResponse(res: HttpResponse, now: Long): OAuthTokens {
    val body = Json.parseObjectOrNull(res.text())
    val accessToken = body?.string("access_token")
    if (body == null || accessToken.isNullOrEmpty()) {
        throw PlumApiError(res.status, "the token response carried no access_token", "invalid_token_response")
    }
    val expiresIn = body.number("expires_in")?.toDouble()
    return OAuthTokens(
        accessToken = accessToken,
        tokenType = body.string("token_type")?.takeIf { it.isNotEmpty() } ?: "bearer",
        scope = body.string("scope") ?: "",
        refreshToken = body.string("refresh_token")?.takeIf { it.isNotEmpty() },
        expiresAt = if (expiresIn != null && expiresIn.isFinite() && expiresIn > 0) now + (expiresIn * 1000).toLong() else null,
        appFolder = body.string("app_folder")?.takeIf { it.startsWith("/") },
    )
}
