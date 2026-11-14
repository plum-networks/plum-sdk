import Foundation

/// Refresh this long before the access token runs out.
let refreshMargin: TimeInterval = 60

/// A connection to one Plum Box (`@plumbox/client`: `PlumClient`).
///
/// An actor: share one instance across your app. With a refresh token it
/// keeps the hourly access token fresh by itself — it refreshes when less than
/// a minute is left, and once when a request comes back 401 (then sends that
/// request again). Concurrent requests share ONE refresh; every refresh
/// rotates the refresh token, so persist the new set (`tokenStore` and/or
/// `onTokens`).
///
/// ```swift
/// let box = try PlumClient(
///     baseUrl: iss,                       // = callback.iss
///     tokens: tokens,                     // from exchangeCode
///     clientId: "com.example.myapp:ios",  // needed to refresh
///     tokenStore: KeychainTokenStore(service: "com.example.myapp.plum"),
///     onAuthError: { _ in Task { @MainActor in model.showReconnect() } }
/// )
/// ```
public actor PlumClient {
    /// The box's address requests go to (trailing slashes removed).
    public nonisolated let baseUrl: String
    /// The environment (`.production` unless you chose `.staging`).
    public nonisolated let environment: PlumEnvironment
    /// The environment's box domain (`plumbox.me` in production).
    public nonisolated var boxDomain: String { environment.boxDomain }
    /// The environment's portal — pass it to `beginAuthorization` as `portalUrl`.
    public nonisolated let portalOrigin: String
    /// The client id the tokens were issued to.
    public nonisolated let clientId: String?
    /// The box's verified `iss`: refreshes go to `<iss>/api/oauth/token` and
    /// nowhere else. Defaults to `baseUrl`.
    public nonisolated let iss: String

    /// The Drive API of this box.
    public nonisolated var drive: DriveApi { DriveApi(client: self) }

    private let urlSession: URLSession
    private let tokenStore: (any TokenStore)?
    private let onTokens: (@Sendable (OAuthTokens) async throws -> Void)?
    private let onAuthError: (@Sendable (PlumAuthError) -> Void)?

    private var token: String?
    private var refreshToken: String?
    private var expiresAt: Date?
    private var scope = ""
    private var folder: String?
    /// The refresh every waiting request shares (single flight).
    private var refreshing: Task<Void, Error>?
    /// Bumped whenever the tokens are replaced from outside, so a late refresh result is dropped.
    private var generation = 0
    /// The access token `onAuthError` last fired for (it fires once per credential).
    private var authErrorToken: String?

    // MARK: init

    /// A client from the separate token values, as `@plumbox/client`'s
    /// `new PlumClient({ baseUrl, token, refreshToken, expiresAt, appFolder, clientId, iss, onTokens, onAuthError })`.
    ///
    /// - Parameters:
    ///   - baseUrl: `https://pb-<sub>.plumbox.me` — the `iss` of the OAuth
    ///     callback, or stored settings. A box of another environment is refused;
    ///     a LAN address or localhost is no environment's and is accepted.
    ///   - token: The access token (`plum_pat_…`): `OAuthTokens.accessToken`,
    ///     or a personal access token. Every request uses Bearer auth with it.
    ///   - refreshToken: `OAuthTokens.refreshToken`. With it the client keeps
    ///     the access token fresh by itself. Needs `clientId` and the box's
    ///     verified `iss`. Alone (no `token`), the client refreshes before the
    ///     first request.
    ///   - expiresAt: `OAuthTokens.expiresAt` — when `token` expires.
    ///   - appFolder: `OAuthTokens.appFolder`, when `files:app` was granted.
    ///   - clientId: The client id the tokens were issued to. Required with a
    ///     refresh token and with a `tokenStore`.
    ///   - iss: The `iss` the sign-in was checked against — the box's canonical
    ///     address. Default: `baseUrl`. With a refresh token it must pass
    ///     ``isPlumIssuer(_:environment:)`` (pass it explicitly when `baseUrl`
    ///     is a LAN address).
    ///   - environment: `.production` (default) or `.staging`.
    ///   - portalOrigin: The environment's portal (default: its own).
    ///   - tokenStore: Where to keep the connection; saved on `setToken` and
    ///     after every refresh (before `onTokens`), read by `loadToken`.
    ///   - urlSession: The transport. Default `URLSession.shared`.
    ///   - onTokens: Called with the new token set after every refresh, before
    ///     the request that needed it is sent again. PERSIST IT: the refresh
    ///     token you stored before no longer works (after a 60-second grace,
    ///     using it ends the whole connection). A throw from here is ignored —
    ///     the client already uses the new tokens.
    ///   - onAuthError: The credential is no good and the user has to connect
    ///     again: a 401 the client could not cure by refreshing, or a refresh
    ///     the box refused (``PlumAuthError`` code `invalid_grant`). Fires once
    ///     per credential, however many requests were in flight. A 403
    ///     (``PlumForbiddenError``: not allowed, credential fine) does NOT fire it.
    /// - Throws: ``PlumUsageError`` for a combination it cannot use safely.
    public init(
        baseUrl: String,
        token: String? = nil,
        refreshToken: String? = nil,
        expiresAt: Date? = nil,
        appFolder: String? = nil,
        clientId: String? = nil,
        iss: String? = nil,
        environment: PlumEnvironment = .production,
        portalOrigin: String? = nil,
        tokenStore: (any TokenStore)? = nil,
        urlSession: URLSession = .shared,
        onTokens: (@Sendable (OAuthTokens) async throws -> Void)? = nil,
        onAuthError: (@Sendable (PlumAuthError) -> Void)? = nil
    ) throws {
        let token = token.flatMap { $0.isEmpty ? nil : $0 }
        let refreshToken = refreshToken.flatMap { $0.isEmpty ? nil : $0 }
        var initial: OAuthTokens?
        if token != nil || refreshToken != nil {
            initial = OAuthTokens(
                accessToken: token ?? "",
                scope: "",
                refreshToken: refreshToken,
                // A refresh token without an access token: refresh before the first request.
                expiresAt: token != nil ? expiresAt : Date(timeIntervalSince1970: 0),
                appFolder: appFolder
            )
        }
        try self.init(
            core: baseUrl, initial: initial, clientId: clientId, iss: iss, environment: environment,
            portalOrigin: portalOrigin, tokenStore: tokenStore, urlSession: urlSession,
            onTokens: onTokens, onAuthError: onAuthError
        )
    }

    /// A client from the whole token set `exchangeCode` returned (keeps its
    /// `scope` too). Same options as ``init(baseUrl:token:refreshToken:expiresAt:appFolder:clientId:iss:environment:portalOrigin:tokenStore:urlSession:onTokens:onAuthError:)``.
    public init(
        baseUrl: String,
        tokens: OAuthTokens,
        clientId: String? = nil,
        iss: String? = nil,
        environment: PlumEnvironment = .production,
        portalOrigin: String? = nil,
        tokenStore: (any TokenStore)? = nil,
        urlSession: URLSession = .shared,
        onTokens: (@Sendable (OAuthTokens) async throws -> Void)? = nil,
        onAuthError: (@Sendable (PlumAuthError) -> Void)? = nil
    ) throws {
        var initial = tokens
        if initial.accessToken.isEmpty, initial.refreshToken?.isEmpty == false {
            initial.expiresAt = Date(timeIntervalSince1970: 0)
        }
        try self.init(
            core: baseUrl, initial: initial, clientId: clientId, iss: iss, environment: environment,
            portalOrigin: portalOrigin, tokenStore: tokenStore, urlSession: urlSession,
            onTokens: onTokens, onAuthError: onAuthError
        )
    }

    /// A client from a saved ``PlumConnection`` (e.g. `KeychainTokenStore().load()`):
    /// `iss` and `clientId` come from it. `baseUrl` defaults to its `iss`.
    public init(
        connection: PlumConnection,
        baseUrl: String? = nil,
        tokenStore: (any TokenStore)? = nil,
        urlSession: URLSession = .shared,
        environment: PlumEnvironment = .production,
        onTokens: (@Sendable (OAuthTokens) async throws -> Void)? = nil,
        onAuthError: (@Sendable (PlumAuthError) -> Void)? = nil
    ) throws {
        try self.init(
            baseUrl: baseUrl ?? connection.iss, tokens: connection.tokens, clientId: connection.clientId,
            iss: connection.iss, environment: environment, tokenStore: tokenStore, urlSession: urlSession,
            onTokens: onTokens, onAuthError: onAuthError
        )
    }

    private init(
        core baseUrl: String,
        initial: OAuthTokens?,
        clientId: String?,
        iss: String?,
        environment: PlumEnvironment,
        portalOrigin: String?,
        tokenStore: (any TokenStore)?,
        urlSession: URLSession,
        onTokens: (@Sendable (OAuthTokens) async throws -> Void)?,
        onAuthError: (@Sendable (PlumAuthError) -> Void)?
    ) throws {
        let base = trimTrailingSlashes(baseUrl)
        if isForeignUrl(base, environment) {
            throw PlumUsageError("PlumClient: \(base) is not a box of \(environment.boxDomain)")
        }
        let portal = trimTrailingSlashes(portalOrigin ?? environment.portalOrigin)
        if isForeignUrl(portal, environment) {
            throw PlumUsageError("PlumClient: \(portal) is not the portal of \(environment.boxDomain)")
        }
        let cid = clientId.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        let issuer = iss ?? base
        if tokenStore != nil, cid == nil {
            throw PlumUsageError("PlumClient: a tokenStore needs the clientId option (it is saved with the tokens)")
        }
        if let initial, initial.refreshToken?.isEmpty == false {
            try PlumClient.checkRefreshable(clientId: cid, iss: issuer, environment: environment)
        }
        self.baseUrl = base
        self.environment = environment
        self.portalOrigin = portal
        self.clientId = cid
        self.iss = issuer
        self.tokenStore = tokenStore
        self.urlSession = urlSession
        self.onTokens = onTokens
        self.onAuthError = onAuthError
        if let initial {
            token = initial.accessToken.isEmpty ? nil : initial.accessToken
            refreshToken = initial.refreshToken.flatMap { $0.isEmpty ? nil : $0 }
            expiresAt = initial.expiresAt
            scope = initial.scope
            folder = initial.appFolder.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    private static func checkRefreshable(clientId: String?, iss: String, environment: PlumEnvironment) throws {
        if clientId == nil {
            throw PlumUsageError(
                "PlumClient: a refresh token needs the clientId option (the client id the tokens were issued to)"
            )
        }
        if !isPlumIssuer(iss, environment: environment) {
            throw PlumUsageError(
                "PlumClient: refreshing needs the box's verified iss (https://pb-….\(environment.boxDomain)); pass it as the iss option"
            )
        }
    }

    // MARK: tokens

    /// Whether the client holds an access token.
    public var hasToken: Bool { token != nil }

    /// The folder a `files:app` token may use (`OAuthTokens.appFolder`), when known.
    public var appFolder: String? { folder }

    /// Adopt a token set for all subsequent requests (and save it to the
    /// `tokenStore`, when there is one) — the whole `OAuthTokens` from
    /// `exchangeCode`, so the client can refresh it.
    public func setToken(_ tokens: OAuthTokens) async throws {
        try adopt(tokens)
        try await saveToStore(currentTokens())
    }

    /// Load the connection saved in `tokenStore`. Returns true when one was
    /// found for this box (`iss`) and this `clientId`; a connection saved for
    /// another box or client is left alone and gives false.
    @discardableResult
    public func loadToken() async throws -> Bool {
        guard let tokenStore, let saved = try await tokenStore.load() else { return false }
        guard saved.iss == iss, saved.clientId == clientId else { return false }
        try adopt(saved.tokens)
        return true
    }

    /// Forget the tokens (and delete the saved connection).
    public func clearToken() async throws {
        generation += 1
        token = nil
        refreshToken = nil
        expiresAt = nil
        folder = nil
        scope = ""
        try await tokenStore?.delete()
    }

    /// Refresh the access token now. Concurrent callers (and requests that hit
    /// a 401 meanwhile) share one refresh. Throws ``PlumAuthError`` code
    /// `invalid_grant` when the connection is gone (and fires `onAuthError`),
    /// or a `URLError`/``PlumApiError`` when the box could not be reached (the
    /// refresh token is still good).
    public func refresh() async throws {
        guard refreshToken != nil else {
            throw PlumUsageError("PlumClient.refresh: this client holds no refresh token")
        }
        try await refreshShared()
    }

    private func adopt(_ t: OAuthTokens) throws {
        if t.refreshToken?.isEmpty == false {
            try PlumClient.checkRefreshable(clientId: clientId, iss: iss, environment: environment)
        }
        generation += 1
        token = t.accessToken.isEmpty ? nil : t.accessToken
        refreshToken = t.refreshToken.flatMap { $0.isEmpty ? nil : $0 }
        expiresAt = t.expiresAt
        scope = t.scope
        folder = t.appFolder.flatMap { $0.isEmpty ? nil : $0 }
    }

    private func currentTokens() -> OAuthTokens {
        OAuthTokens(
            accessToken: token ?? "",
            tokenType: "bearer",
            scope: scope,
            refreshToken: refreshToken,
            expiresAt: expiresAt,
            appFolder: folder
        )
    }

    private func saveToStore(_ tokens: OAuthTokens) async throws {
        guard let tokenStore, let clientId else { return }
        try await tokenStore.save(PlumConnection(iss: iss, clientId: clientId, tokens: tokens))
    }

    private func refreshShared() async throws {
        if let running = refreshing {
            return try await running.value
        }
        let task = Task { try await self.runRefresh() }
        refreshing = task
        try await task.value
    }

    private func runRefresh() async throws {
        // Cleared before anyone waiting on the task resumes, so a request that
        // starts after this refresh ended starts a new one rather than reading
        // this one's outcome.
        defer { refreshing = nil }
        try await doRefresh()
    }

    private func doRefresh() async throws {
        guard let sent = refreshToken, let clientId else {
            throw PlumUsageError("PlumClient: no refresh token")
        }
        let generation = self.generation
        let next: OAuthTokens
        do {
            next = try await refreshTokens(
                iss: iss, clientId: clientId, refreshToken: sent, environment: environment, urlSession: urlSession
            )
        } catch let err as PlumAuthError where err.code == "invalid_grant" {
            if generation == self.generation {
                // The connection is gone: stop sending a refresh token the box refuses.
                refreshToken = nil
                fireAuthError(err, sentWith: token)
            }
            throw err
        }
        // The tokens were replaced (setToken/clearToken) while this was in
        // flight: keep those — unless they are the very set this refresh
        // rotated away (re-loaded from storage), which no longer works.
        if generation != self.generation, refreshToken != sent { return }
        token = next.accessToken
        refreshToken = next.refreshToken
        expiresAt = next.expiresAt
        if !next.scope.isEmpty { scope = next.scope }
        if let f = next.appFolder { folder = f }
        let tokens = currentTokens()
        // The new tokens are in use; a storage failure must not fail the request.
        try? await saveToStore(tokens)
        // Same: documented as ignored.
        try? await onTokens?(tokens)
    }

    private func refreshDue() -> Bool {
        guard refreshToken != nil, let expiresAt else { return false }
        return Date() >= expiresAt.addingTimeInterval(-refreshMargin)
    }

    private func fireAuthError(_ err: PlumAuthError, sentWith: String?) {
        if let sentWith, sentWith == authErrorToken { return }
        authErrorToken = sentWith
        onAuthError?(err)
    }

    // MARK: requests

    /// Perform an API request with auth and error mapping — for the routes the
    /// SDK has no method for (e.g. your service at `/apps/<app_id>/svc/…`).
    ///
    /// With a refresh token, an access token about to expire is refreshed
    /// first, and a 401 is answered by one refresh (shared with every request
    /// waiting on it) and one more try of the same request. A 401 is the box
    /// refusing the credential before it reads the request, so the second try
    /// is not a duplicate write; the body is sent again byte for byte.
    ///
    /// - Parameters:
    ///   - path: Absolute path on the box, query included (`/api/auth/me`).
    ///   - allowStatus: The statuses that count as success (default: 2xx).
    /// - Throws: ``PlumAuthError`` (401, or `invalid_grant`),
    ///   ``PlumForbiddenError`` (403), ``PlumApiError`` (anything else), or
    ///   URLSession's `URLError`.
    public func request(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        headers: [String: String] = [:],
        allowStatus: Set<Int>? = nil
    ) async throws -> PlumResponse {
        // Due, or already under way (another request's 401): wait for the new token.
        if refreshDue() || refreshing != nil {
            do {
                try await refreshShared()
            } catch {
                // Gone for good, or no longer usable at all: stop. A token
                // that is still valid for a few seconds is worth one try.
                if error is PlumAuthError { throw error }
                guard let expiresAt, Date() < expiresAt else { throw error }
            }
        }
        var sentWith = token
        var res = try await send(path, method: method, body: body, headers: headers)
        if res.status == 401, sentWith != nil, refreshToken != nil, !(allowStatus?.contains(401) ?? false) {
            // Another request may have refreshed already while this one was out.
            if token == sentWith { try await refreshShared() }
            sentWith = token
            res = try await send(path, method: method, body: body, headers: headers)
        }
        let ok = allowStatus.map { $0.contains(res.status) } ?? (200..<300).contains(res.status)
        if !ok {
            let err = errorFromResponse(status: res.status, body: res.body)
            if let auth = err as? PlumAuthError { fireAuthError(auth, sentWith: sentWith) }
            throw err
        }
        return res
    }

    /// ``request(_:method:body:headers:allowStatus:)`` with a JSON body
    /// (`Content-Type: application/json`).
    public func request<Body: Encodable & Sendable>(
        _ path: String,
        method: String,
        json: Body,
        headers: [String: String] = [:],
        allowStatus: Set<Int>? = nil
    ) async throws -> PlumResponse {
        var h = headers.filter { $0.key.lowercased() != "content-type" }
        h["Content-Type"] = "application/json"
        return try await request(path, method: method, body: try jsonBody(json), headers: h, allowStatus: allowStatus)
    }

    private func send(_ path: String, method: String, body: Data?, headers: [String: String]) async throws -> PlumResponse {
        var h = headers
        if let token {
            h = h.filter { $0.key.lowercased() != "authorization" }
            h["Authorization"] = "Bearer \(token)"
        }
        return try await perform(
            urlSession, url: try makeURL(joinURL(baseUrl, path)), method: method, headers: h, body: body
        )
    }
}
