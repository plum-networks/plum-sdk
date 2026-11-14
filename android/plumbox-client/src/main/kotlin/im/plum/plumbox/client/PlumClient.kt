package im.plum.plumbox.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The user's box, through a token from the delegated sign-in — the Kotlin
 * twin of `PlumClient` in `client.ts`.
 *
 * Given the whole token set plus [clientId], the client keeps the hourly
 * access token fresh by itself: it refreshes when less than a minute is left,
 * and when a request comes back 401 it refreshes once and sends that request
 * again. Concurrent requests share one refresh (one in flight at a time).
 * Every refresh ROTATES the refresh token: `onTokens` (and the [TokenStore])
 * receive the new set before the request that needed it is retried —
 * persist it.
 *
 * Errors: [PlumAuthError] (401, or `invalid_grant` when the connection is
 * gone → `onAuthError`, once), [PlumForbiddenError] (403: the token may not
 * do this — no `onAuthError`), [PlumApiError] for the rest. All calls are
 * `suspend` and main-safe.
 *
 * @param baseUrl `https://pb-<sub>.plumbox.me` (production) — the `iss` of the OAuth callback.
 * @param token the access token (`plum_pat_…`): [OAuthTokens.accessToken], or a PAT.
 * @param refreshToken [OAuthTokens.refreshToken]. With it the client refreshes by
 *   itself; needs [clientId] and the box's verified [iss].
 * @param expiresAt [OAuthTokens.expiresAt] (ms since the epoch) — when [token] expires.
 * @param appFolder [OAuthTokens.appFolder], when `files:app` was granted.
 * @param clientId the client id the tokens were issued to. Required with a refresh token.
 * @param iss the `iss` the sign-in was checked against — the box's canonical
 *   address. Default: [baseUrl]. Refreshes go to `<iss>/api/oauth/token` and
 *   nowhere else, so with a refresh token this must pass [isPlumIssuer]
 *   (pass it explicitly when [baseUrl] is a LAN address).
 * @param onTokens called with the new token set after every refresh, before
 *   the request that needed it is sent again. PERSIST IT: the refresh token
 *   you stored before no longer works (after a 60-second grace, using it ends
 *   the whole connection). A throw from here is ignored — the client already
 *   uses the new tokens. Runs on a background thread.
 * @param onAuthError the credential is no good and the user has to connect
 *   again: a 401 the client could not cure by refreshing, or a refresh the box
 *   refused ([PlumAuthError] code `invalid_grant`). Fires once per credential,
 *   however many requests were in flight. A 403 does NOT fire it. Runs on a
 *   background thread; a throw from it is ignored.
 * @param http transport. Default: [OkHttpAdapter].
 * @param tokenStore where the connection is kept ([KeystoreTokenStore] on Android).
 * @param boxDomain the environment: `plumbox.me` (default) or `staging.plumbox.me`.
 *   A [baseUrl] of another environment's box is refused; a LAN address or
 *   localhost belongs to no environment and is accepted.
 * @param portalOrigin the environment's portal (default: its own).
 * @throws IllegalArgumentException for a [baseUrl] of another environment, or
 *   a refresh token without [clientId] or without a verified [iss].
 */
public class PlumClient(
    baseUrl: String,
    token: String? = null,
    refreshToken: String? = null,
    expiresAt: Long? = null,
    appFolder: String? = null,
    clientId: String? = null,
    iss: String? = null,
    private val onTokens: (suspend (OAuthTokens) -> Unit)? = null,
    private val onAuthError: ((PlumAuthError) -> Unit)? = null,
    http: HttpAdapter? = null,
    private val tokenStore: TokenStore? = null,
    boxDomain: String? = null,
    portalOrigin: String? = null,
) {
    /** The box's address, without a trailing slash. */
    public val baseUrl: String = baseUrl.trimEnd('/')

    /** The environment's box domain (`plumbox.me` in production). */
    public val boxDomain: String

    /** The environment's portal — pass it to [beginAuthorization] as `portalUrl`. */
    public val portalOrigin: String

    /** The client id the tokens were issued to. */
    public val clientId: String? = clientId?.trim()?.takeIf { it.isNotEmpty() }

    /** Where refreshes go: the box's verified address (default [baseUrl]). */
    public val iss: String = iss ?: this.baseUrl

    public val drive: DriveApi = DriveApi(this)
    public val auth: AuthApi = AuthApi(this)

    internal val http: HttpAdapter = http ?: OkHttpAdapter.default

    /** The tokens in use; replaced as a whole, read without a lock. */
    private data class TokenState(
        val token: String?,
        val refreshToken: String?,
        val expiresAt: Long?,
        val scope: String,
        val folder: String?,
        /** Bumped whenever the tokens are replaced from outside, so a late refresh result is dropped. */
        val generation: Long,
    )

    @Volatile
    private var state = TokenState(null, null, null, "", null, 0)
    private val lock = Any()

    /** Guards [refreshing]: at most one refresh in flight; everyone else joins it. */
    private val refreshMutex = Mutex()

    @Volatile
    private var refreshing: CompletableDeferred<Unit>? = null

    /** The access token `onAuthError` last fired for (it fires once per credential). Guarded by [lock]. */
    private var authErrorToken: String? = null

    /**
     * Runs the refreshes. Not the caller's scope on purpose: a caller that is
     * cancelled mid-refresh must not throw away a rotated refresh token the
     * box has already issued — the refresh finishes and is persisted.
     */
    private val refreshScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        val env = plumEnvironment(boxDomain)
        require(!isForeignUrl(this.baseUrl, env)) { "PlumClient: ${this.baseUrl} is not a box of ${env.boxDomain}" }
        this.portalOrigin = (portalOrigin ?: env.portalOrigin).trimEnd('/')
        require(!isForeignUrl(this.portalOrigin, env)) {
            "PlumClient: ${this.portalOrigin} is not the portal of ${env.boxDomain}"
        }
        this.boxDomain = env.boxDomain
        if (!token.isNullOrEmpty() || !refreshToken.isNullOrEmpty()) {
            adopt(
                OAuthTokens(
                    accessToken = token ?: "",
                    refreshToken = refreshToken,
                    // A refresh token without an access token: refresh before the first request.
                    expiresAt = if (!token.isNullOrEmpty()) expiresAt else 0L,
                    appFolder = appFolder,
                ),
            )
        }
    }

    /** Whether the client holds an access token. */
    public val hasToken: Boolean get() = !state.token.isNullOrEmpty()

    /** The folder a `files:app` token may use ([OAuthTokens.appFolder]), when known. */
    public val appFolder: String? get() = state.folder

    /** The token set in use now (the newest after a refresh), or `null` without one. */
    public val tokens: OAuthTokens? get() = state.takeIf { it.token != null || it.refreshToken != null }?.toTokens()

    /**
     * Load the connection saved in [tokenStore] and use it. Returns `false`
     * when there is no store, nothing saved, or the saved connection is for
     * another box or another client id (its tokens are not sent here).
     */
    public suspend fun loadToken(): Boolean {
        val saved = tokenStore?.load() ?: return false
        if (saved.iss != iss || saved.clientId != clientId) return false
        adopt(saved.tokens)
        return true
    }

    /**
     * Use these tokens for all later requests (and save them in [tokenStore]):
     * the whole [OAuthTokens] from [exchangeCode], so the client can refresh it.
     */
    public suspend fun setToken(tokens: OAuthTokens) {
        adopt(tokens)
        tokenStore?.save(PlumConnection(iss, clientId, state.toTokens()))
    }

    /** Use a personal access token (`plum_pat_…`) that never refreshes. */
    public suspend fun setToken(token: String) {
        setToken(OAuthTokens(accessToken = token))
    }

    /** Forget the tokens (and clear [tokenStore]). The box still knows the connection until the user removes it. */
    public suspend fun clearToken() {
        synchronized(lock) { state = TokenState(null, null, null, "", null, state.generation + 1) }
        tokenStore?.clear()
    }

    /**
     * Refresh the access token now. Concurrent callers (and requests that hit
     * a 401 meanwhile) share one refresh. Throws [PlumAuthError] code
     * `invalid_grant` when the connection is gone (and fires `onAuthError`),
     * or [PlumApiError] when the box could not be reached (the refresh token
     * is still good).
     *
     * @throws IllegalStateException when the client holds no refresh token.
     */
    public suspend fun refresh() {
        check(state.refreshToken != null) { "PlumClient.refresh: this client holds no refresh token" }
        refreshShared { true }
    }

    private fun adopt(t: OAuthTokens) {
        if (!t.refreshToken.isNullOrEmpty()) {
            require(clientId != null) {
                "PlumClient: a refresh token needs the clientId option (the client id the tokens were issued to)"
            }
            require(isPlumIssuer(iss, boxDomain)) {
                "PlumClient: refreshing needs the box's verified iss (https://pb-….$boxDomain); pass it as the iss option"
            }
        }
        synchronized(lock) {
            state = TokenState(
                token = t.accessToken.takeIf { it.isNotEmpty() },
                refreshToken = t.refreshToken?.takeIf { it.isNotEmpty() },
                expiresAt = t.expiresAt,
                scope = t.scope,
                folder = t.appFolder?.takeIf { it.isNotEmpty() },
                generation = state.generation + 1,
            )
        }
    }

    private fun TokenState.toTokens(): OAuthTokens =
        OAuthTokens(
            accessToken = token ?: "",
            tokenType = "bearer",
            scope = scope,
            refreshToken = refreshToken,
            expiresAt = expiresAt,
            appFolder = folder,
        )

    private fun refreshDue(s: TokenState): Boolean =
        s.refreshToken != null && s.expiresAt != null && System.currentTimeMillis() >= s.expiresAt - REFRESH_MARGIN_MS

    /**
     * Join the refresh in flight, or start one when [shouldStart] still holds
     * for the current tokens (checked under the lock, so two callers that both
     * saw the same expired token start one refresh between them).
     */
    private suspend fun refreshShared(shouldStart: (TokenState) -> Boolean) {
        val (deferred, starter) = refreshMutex.withLock {
            val inFlight = refreshing
            if (inFlight != null) {
                inFlight to false
            } else {
                val s = state
                if (s.refreshToken == null || clientId == null || !shouldStart(s)) return
                CompletableDeferred<Unit>().also { refreshing = it } to true
            }
        }
        if (starter) {
            refreshScope.launch {
                val result = runCatching { doRefresh() }
                // Cleared before anyone resumes, so a request after this one starts fresh.
                refreshMutex.withLock { refreshing = null }
                result.fold({ deferred.complete(Unit) }, { deferred.completeExceptionally(it) })
            }
        }
        deferred.await()
    }

    private suspend fun doRefresh() {
        val start = state
        val sent = start.refreshToken ?: throw IllegalStateException("PlumClient: no refresh token")
        val id = clientId ?: throw IllegalStateException("PlumClient: no clientId")
        val next = try {
            refreshTokens(iss = iss, clientId = id, refreshToken = sent, http = http, boxDomain = boxDomain)
        } catch (e: PlumAuthError) {
            if (e.code == "invalid_grant") {
                // The connection is gone: stop sending a refresh token the box refuses.
                val deadToken = synchronized(lock) {
                    if (state.generation != start.generation) return@synchronized null
                    state = state.copy(refreshToken = null)
                    state.token ?: ""
                }
                if (deadToken != null) fireAuthError(e, deadToken.ifEmpty { null })
            }
            throw e
        }
        val tokens = synchronized(lock) {
            val cur = state
            // The tokens were replaced (setToken/clearToken) while this was in
            // flight: keep those — unless they are the very set this refresh
            // rotated away (re-loaded from storage), which no longer works.
            if (cur.generation != start.generation && cur.refreshToken != sent) return
            val updated = cur.copy(
                token = next.accessToken,
                refreshToken = next.refreshToken,
                expiresAt = next.expiresAt,
                scope = next.scope.ifEmpty { cur.scope },
                folder = next.appFolder ?: cur.folder,
            )
            state = updated
            updated.toTokens()
        }
        try {
            tokenStore?.save(PlumConnection(iss, clientId, tokens))
        } catch (_: Exception) {
            // The new tokens are in use; a storage failure must not fail the request.
        }
        try {
            onTokens?.invoke(tokens)
        } catch (_: Exception) {
            // Same: documented as ignored.
        }
    }

    private fun fireAuthError(err: PlumAuthError, sentWith: String?) {
        synchronized(lock) {
            if (sentWith != null && sentWith == authErrorToken) return
            authErrorToken = sentWith
        }
        try {
            onAuthError?.invoke(err)
        } catch (_: Exception) {
            // The hook's own failure must not replace the error the caller gets.
        }
    }

    /**
     * Perform an API request with auth and error mapping — for box endpoints
     * this SDK does not wrap. [path] is relative to [baseUrl] and may carry a
     * query (`/api/x?y=1`).
     *
     * With a refresh token, an access token about to expire is refreshed
     * first, and a 401 is answered by one refresh (shared with every request
     * waiting on it) and one more try of the same request. A 401 is the box
     * refusing the credential before it reads the request, so the second try
     * is not a duplicate write; the body is sent again byte for byte.
     *
     * @param allowStatus the statuses that count as success (default: 2xx).
     * @throws PlumApiError (or a subclass) for any other status.
     */
    public suspend fun request(
        path: String,
        method: String = "GET",
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
        allowStatus: Set<Int>? = null,
    ): HttpResponse {
        // Due, or already under way (another request's 401): wait for the new token.
        if (refreshing != null || refreshDue(state)) {
            try {
                refreshShared { refreshDue(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Gone for good, or no longer usable at all: stop. A token
                // that is still valid for a few seconds is worth one try.
                val exp = state.expiresAt
                if (e is PlumAuthError || exp == null || System.currentTimeMillis() >= exp) throw e
            }
        }
        var sentWith = state.token
        var res = send(path, method, body, headers, sentWith)
        if (res.status == 401 && sentWith != null && state.refreshToken != null && allowStatus?.contains(401) != true) {
            // Another request may have refreshed already while this one was out.
            refreshShared { it.token == sentWith }
            val fresh = state.token
            if (fresh != sentWith) {
                sentWith = fresh
                res = send(path, method, body, headers, sentWith)
            }
        }
        val ok = allowStatus?.contains(res.status) ?: (res.status in 200..299)
        if (!ok) {
            val err = errorFromResponse(res.status, res.text())
            if (err is PlumAuthError) fireAuthError(err, sentWith)
            throw err
        }
        return res
    }

    /** [request] with a JSON body. */
    internal suspend fun requestJson(path: String, method: String, json: ByteArray): HttpResponse =
        request(path, method, json, mapOf("content-type" to "application/json"))

    private suspend fun send(
        path: String,
        method: String,
        body: ByteArray?,
        headers: Map<String, String>,
        token: String?,
    ): HttpResponse {
        val h = LinkedHashMap(headers)
        if (token != null) h["authorization"] = "Bearer $token"
        return http.request(HttpRequest(joinUrl(baseUrl, path), method, h, body))
    }

    public companion object {
        /** Refresh this long before the access token runs out. */
        private const val REFRESH_MARGIN_MS = 60_000L

        /**
         * Rebuild the client from the connection saved in [store] (after an
         * app restart), or `null` when nothing is saved. The saved `iss` is
         * the box's address and where refreshes go; pass [baseUrl] only to
         * talk to the box at another address (a LAN address).
         */
        public suspend fun fromStore(
            store: TokenStore,
            onTokens: (suspend (OAuthTokens) -> Unit)? = null,
            onAuthError: ((PlumAuthError) -> Unit)? = null,
            http: HttpAdapter? = null,
            boxDomain: String? = null,
            baseUrl: String? = null,
        ): PlumClient? {
            val saved = store.load() ?: return null
            val client = PlumClient(
                baseUrl = baseUrl ?: saved.iss,
                clientId = saved.clientId,
                iss = saved.iss,
                onTokens = onTokens,
                onAuthError = onAuthError,
                http = http,
                tokenStore = store,
                boxDomain = boxDomain,
            )
            client.adopt(saved.tokens)
            return client
        }
    }
}

/** Account calls a companion app may make. */
public class AuthApi internal constructor(private val client: PlumClient) {
    /** Who does the credential belong to? Needs `user:profile` (or a read scope). Also a cheap connectivity check. */
    public suspend fun me(): PlumUser {
        val body = responseObject(client.request("/api/auth/me"))
        // The box wraps the profile: {"user": {...}}
        val u = body.obj("user") ?: body
        return PlumUser(
            id = u.string("id") ?: "",
            username = u.string("username"),
            email = u.string("email"),
            displayName = u.string("displayName"),
        )
    }
}
