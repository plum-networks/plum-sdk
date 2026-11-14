import CryptoKit
import Foundation
import Security

// Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for
// third-party apps. The user finds their box on plumbox.me (their email and a
// code Plum mails them) and types the password only on that box's own page —
// NEVER inside your app. Your app receives a scoped, revocable token, never
// the password.
//
// Two halves:
//   1. `beginAuthorization()` builds the authorization URL + a PKCE verifier.
//      Open the URL in the system browser (`PlumAuthorizationSession`); the
//      user picks their box, signs in there and approves; the box redirects
//      back to your `redirectUri` with `?code=…&state=…&iss=…`.
//   2. `parseCallback()` reads that redirect and checks `iss`;
//      `exchangeCode()` swaps the code (+ the verifier) for the tokens at
//      that box — and only at that box.
//
// The access token expires after an hour; the refresh token that comes with
// it gets a new one (`refreshTokens`, which `PlumClient` calls by itself when
// given `refreshToken` + `clientId`). Older boxes issue a token that never
// expires and no refresh token.

/// The production portal, `https://plumbox.me`.
public let defaultPortalUrl = PlumEnvironment.production.portalOrigin

// MARK: - iss

/// Whether `iss` is a Plum box's canonical origin: `https://pb-<name>.plumbox.me`
/// exactly — https, no port, no path, no trailing slash, lower case, and not
/// the box's `-lan`/`-wan` alias. `environment` picks the environment (default
/// production, `plumbox.me`; `.staging` for `staging.plumbox.me`): a box of
/// another environment is not one.
///
/// The name is `[a-z0-9]`, optionally `[a-z0-9-]{0,57}[a-z0-9]` after it (one
/// DNS label with the `pb-` prefix), not narrowed to hex: older box names exist.
///
/// Limit: this says "a Plum box", not "the box the user picked". Swapping in
/// a different Plum box is stopped elsewhere (the signed directory list and
/// the portal sending the user only to the box they chose).
public func isPlumIssuer(_ iss: String?, environment: PlumEnvironment = .production) -> Bool {
    guard let iss else { return false }
    let domain = environment.boxDomain
    let bytes = Array(iss.utf8)
    let prefix = Array("https://pb-".utf8)
    let suffix = Array(("." + domain).utf8)
    guard bytes.count > prefix.count + suffix.count,
          bytes.starts(with: prefix),
          Array(bytes.suffix(suffix.count)) == suffix
    else { return false }
    let name = bytes[prefix.count..<(bytes.count - suffix.count)]
    // ^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$
    guard (1...59).contains(name.count) else { return false }
    func alnum(_ b: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b)
    }
    guard alnum(name.first!), alnum(name.last!) else { return false }
    guard name.allSatisfy({ alnum($0) || $0 == UInt8(ascii: "-") }) else { return false }
    return !iss.hasSuffix("-lan.\(domain)") && !iss.hasSuffix("-wan.\(domain)")
}

// MARK: - beginAuthorization

/// The authorization URL and the PKCE material from ``beginAuthorization(clientId:redirectUri:scopes:portalUrl:environment:)``.
/// The verifier and `state` must survive until the redirect comes back (it is
/// `Codable` so you can park it if your app may be suspended meanwhile).
public struct AuthorizationRequest: Codable, Sendable, Equatable {
    /// Open this in the system browser (``PlumAuthorizationSession``).
    public let url: URL
    /// Keep until the redirect returns; needed to exchange the code.
    public let codeVerifier: String
    /// Keep until the redirect returns; pass it to `exchangeCode` as `expectedState`.
    public let state: String

    public init(url: URL, codeVerifier: String, state: String) {
        self.url = url
        self.codeVerifier = codeVerifier
        self.state = state
    }
}

/// Build the authorization URL and the PKCE material. The verifier and
/// `state` must survive until the redirect comes back.
///
/// - Parameters:
///   - clientId: The client id you registered for this app in the Plum
///     developer console (`<app_id>:<label>`, e.g. `com.example.notes:ios`),
///     or declared in your app's manifest `clients[]`. The box refuses an
///     unregistered client id with `unauthorized_client` before showing any
///     consent screen.
///   - redirectUri: Must equal one of the redirect URIs registered for the
///     client (a custom scheme such as `notes://auth/callback`; http loopback
///     any port).
///   - scopes: Must be a subset of the scopes the client was registered with.
///   - portalUrl: Portal that hosts the /authorize entry (where the user finds
///     their box). Default: the environment's portal.
///   - environment: Default production (`plumbox.me`).
/// - Throws: ``PlumUsageError`` without a client id or a scope.
public func beginAuthorization(
    clientId: String,
    redirectUri: String,
    scopes: [OAuthScope],
    portalUrl: String? = nil,
    environment: PlumEnvironment = .production
) throws -> AuthorizationRequest {
    let clientId = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
    if clientId.isEmpty {
        throw PlumUsageError("beginAuthorization: clientId is required (register one in the Plum developer console)")
    }
    if scopes.isEmpty {
        throw PlumUsageError("beginAuthorization: at least one scope is required")
    }
    let portal = trimTrailingSlashes(portalUrl ?? environment.portalOrigin)
    // PKCE verifier: 43–128 chars from the unreserved set. 32 random bytes
    // base64url-encoded → 43 chars.
    let codeVerifier = base64url(try randomBytes(32))
    let codeChallenge = pkceChallenge(for: codeVerifier)
    let state = base64url(try randomBytes(16))

    let query = formQuery([
        ("response_type", "code"),
        ("client_id", clientId),
        ("redirect_uri", redirectUri),
        ("scope", scopes.map(\.rawValue).joined(separator: " ")),
        ("code_challenge", codeChallenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ])
    let url = try makeURL("\(portal)/authorize?\(query)")
    return AuthorizationRequest(url: url, codeVerifier: codeVerifier, state: state)
}

/// `base64url(SHA-256(verifier))` without padding — the S256 challenge the box
/// checks the verifier against.
func pkceChallenge(for codeVerifier: String) -> String {
    base64url(Data(SHA256.hash(data: Data(codeVerifier.utf8))))
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func randomBytes(_ n: Int) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: n)
    let status = SecRandomCopyBytes(kSecRandomDefault, n, &bytes)
    guard status == errSecSuccess else {
        throw PlumUsageError("no secure random number generator available (SecRandomCopyBytes: \(status))")
    }
    return Data(bytes)
}

// MARK: - parseCallback

/// What the box's redirect said, after the `iss` check (``parseCallback(_:environment:)-(URL,_)``).
public struct CallbackResult: Sendable, Equatable {
    /// Present only when the callback also carried a valid `iss`.
    public var code: String?
    public var state: String?
    /// The box that issued the code, already checked with ``isPlumIssuer(_:environment:)`` —
    /// pass it to `exchangeCode` as `baseUrl` and keep it as the box's address.
    /// nil when the callback carried none (an error callback from an older
    /// box) or one that failed the check.
    public var iss: String?
    /// Set when there is nothing to exchange: the box's own error (e.g.
    /// "access_denied"), "invalid_iss" when the callback's `iss` is missing or
    /// not a Plum box (the code is then dropped), or "invalid_request" when the
    /// callback carried neither a code nor an error.
    public var error: String?

    public init(code: String? = nil, state: String? = nil, iss: String? = nil, error: String? = nil) {
        self.code = code
        self.state = state
        self.iss = iss
        self.error = error
    }
}

/// Read the redirect the box sent back to your `redirect_uri`
/// (e.g. `myapp://plum/callback?code=…&state=…&iss=…`) and check its `iss`:
///
/// - A code with no `iss`, or with one that is not a Plum box's own address,
///   comes back as `error: "invalid_iss"` and WITHOUT the code — there is
///   nothing left to send anywhere.
/// - An error callback is accepted without `iss` (older boxes send none); if
///   it carries one, the same check applies.
/// - A parameter that appears twice is refused.
///
/// `state` is checked by `exchangeCode` (pass the one `beginAuthorization`
/// returned as `expectedState`).
public func parseCallback(_ callbackUrl: URL, environment: PlumEnvironment = .production) -> CallbackResult {
    let query = URLComponents(url: callbackUrl, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
    let pairs = formDecodeQuery(query)
    return checkCallback({ key in pairs.filter { $0.0 == key }.map(\.1) }, environment: environment)
}

/// ``parseCallback(_:environment:)-(URL,_)`` for a callback held as a string. Throws
/// ``PlumUsageError`` on a malformed URL.
public func parseCallback(_ callbackUrl: String, environment: PlumEnvironment = .production) throws -> CallbackResult {
    guard let url = URL(string: callbackUrl), url.scheme != nil else {
        throw PlumUsageError("parseCallback: not a URL: \(callbackUrl)")
    }
    return parseCallback(url, environment: environment)
}

private enum One {
    case absent
    case repeated
    case value(String)
}

private func checkCallback(_ all: (String) -> [String], environment: PlumEnvironment) -> CallbackResult {
    // A parameter that appears twice is not one this flow produced; refusing
    // it keeps "which iss did we check" and "which iss do we use" the same.
    func one(_ key: String) -> One {
        let v = all(key)
        if v.count > 1 { return .repeated }
        if v.count == 1, !v[0].isEmpty { return .value(v[0]) }
        return .absent
    }
    let code = one("code")
    let state = one("state")
    let iss = one("iss")
    let error = one("error")
    var out = CallbackResult()
    if case let .value(s) = state { out.state = s }

    switch iss {
    case .repeated:
        out.error = "invalid_iss"
        return out
    case let .value(i) where !isPlumIssuer(i, environment: environment):
        out.error = "invalid_iss"
        return out
    default:
        break
    }
    let checkedIss: String? = { if case let .value(i) = iss { return i } else { return nil } }()

    var codeRepeated = false
    if case .repeated = code { codeRepeated = true }
    var errorPresent = false
    if case .absent = error {} else { errorPresent = true }
    if errorPresent || codeRepeated {
        // The box's own refusal (access_denied, …). No code goes with it,
        // even if one were present.
        if case let .value(e) = error { out.error = e } else { out.error = "invalid_request" }
        if let checkedIss { out.iss = checkedIss }
        return out
    }
    guard case let .value(c) = code else {
        out.error = "invalid_request"
        return out
    }
    guard let checkedIss else {
        // A code and no box to name it: stop here (contract 10.1).
        out.error = "invalid_iss"
        return out
    }
    out.code = c
    out.iss = checkedIss
    return out
}

// MARK: - exchangeCode

/// Exchange the authorization code for a scoped access token at the box that
/// issued it. Before anything is sent, `baseUrl` must be a Plum box's own
/// address (`invalid_iss` otherwise) and the callback's `state` must equal
/// `expectedState` (`invalid_state` otherwise) — both as ``PlumOAuthError``.
/// Returns the tokens to store; the password was never seen by your app.
///
/// A current box returns an access token that expires in an hour plus a
/// refresh token (and `appFolder` when `files:app` was granted); hand all of
/// them to `PlumClient` and it keeps the access token fresh. An older box
/// returns `accessToken` + `scope` only — a token that never expires.
///
/// Errors from the box carry its OAuth code in ``PlumApiError/code``:
/// `invalid_grant` (code used, expired or PKCE mismatch), `unauthorized_client`
/// (client id not registered), `invalid_scope`, `invalid_redirect_uri`.
///
/// - Parameters:
///   - baseUrl: The box to exchange the code at: the callback's `iss` (from
///     `parseCallback`). It must be a Plum box's canonical origin
///     (``isPlumIssuer(_:environment:)``); anything else stops with
///     `invalid_iss` before the code or the verifier is sent anywhere. The
///     code goes to `<iss>/api/oauth/token` and nowhere else.
///   - code: The callback's `code`.
///   - state: The callback's `state`.
///   - expectedState: The `state` that `beginAuthorization` returned for this
///     sign-in. A callback whose `state` is different (or missing) stops with
///     `invalid_state` before anything is sent.
///   - codeVerifier: From `beginAuthorization`.
///   - clientId: The client id the sign-in began with.
///   - redirectUri: The redirect URI the sign-in began with.
public func exchangeCode(
    baseUrl: String,
    code: String,
    state: String?,
    expectedState: String,
    codeVerifier: String,
    clientId: String,
    redirectUri: String,
    environment: PlumEnvironment = .production,
    urlSession: URLSession = .shared
) async throws -> OAuthTokens {
    let iss = baseUrl
    guard isPlumIssuer(iss, environment: environment) else {
        throw PlumOAuthError(
            .invalidIss,
            "exchangeCode: the callback's iss is not a Plum box (https://pb-….\(environment.boxDomain)); nothing was sent"
        )
    }
    guard !expectedState.isEmpty, state == expectedState else {
        throw PlumOAuthError(
            .invalidState,
            "exchangeCode: the callback's state is not the one this sign-in began with; nothing was sent"
        )
    }
    guard !code.isEmpty, !codeVerifier.isEmpty else {
        throw PlumOAuthError(.invalidRequest, "exchangeCode: code and codeVerifier are required")
    }
    struct Body: Encodable {
        let grant_type = "authorization_code"
        let code: String
        let code_verifier: String
        let client_id: String
        let redirect_uri: String
    }
    let res = try await perform(
        urlSession,
        url: try makeURL(iss + "/api/oauth/token"),
        method: "POST",
        headers: ["Content-Type": "application/json"],
        body: try jsonBody(Body(code: code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri))
    )
    guard res.status == 200 else {
        throw errorFromResponse(status: res.status, body: res.body)
    }
    return try tokensFromResponse(res, now: Date())
}

// MARK: - refreshTokens

/// Trade a refresh token for a new token set at `<iss>/api/oauth/token`
/// (`grant_type=refresh_token`). `PlumClient` calls this for you when it holds
/// a refresh token; call it yourself only if you manage tokens by hand.
///
/// Refresh tokens ROTATE: the result carries a new `refreshToken` and the one
/// you sent stops working (the box forgives a repeat within 60 s, for a reply
/// that got lost). Store the new one before anything else; reusing an old one
/// after that ends the whole connection. A box that answers without a new
/// refresh token leaves the one you sent valid, and the result carries it.
///
/// Throws ``PlumAuthError`` with status 400 and `code` `"invalid_grant"` when
/// the box refuses the refresh token (rotated away, revoked, 90 days unused,
/// or the user disconnected the app): the connection is gone and the user has
/// to connect again. Any other failure (network, 5xx) is a ``PlumApiError`` or
/// URLSession's own `URLError` — the refresh token is still good; try again
/// later.
///
/// - Parameters:
///   - iss: The box the tokens came from: the `iss` the sign-in was checked
///     against (the `baseUrl` given to `exchangeCode`). The same check applies
///     — a value that is not a Plum box's canonical origin stops with
///     ``PlumOAuthError`` `invalid_iss` before the refresh token is sent anywhere.
///   - clientId: The client id the tokens were issued to.
///   - refreshToken: The newest refresh token you hold.
public func refreshTokens(
    iss: String,
    clientId: String,
    refreshToken: String,
    environment: PlumEnvironment = .production,
    urlSession: URLSession = .shared
) async throws -> OAuthTokens {
    guard isPlumIssuer(iss, environment: environment) else {
        throw PlumOAuthError(
            .invalidIss,
            "refreshTokens: iss is not a Plum box (https://pb-….\(environment.boxDomain)); nothing was sent"
        )
    }
    guard !refreshToken.isEmpty, !clientId.isEmpty else {
        throw PlumOAuthError(.invalidRequest, "refreshTokens: refreshToken and clientId are required")
    }
    struct Body: Encodable {
        let grant_type = "refresh_token"
        let refresh_token: String
        let client_id: String
    }
    let res = try await perform(
        urlSession,
        url: try makeURL(iss + "/api/oauth/token"),
        method: "POST",
        headers: ["Content-Type": "application/json"],
        body: try jsonBody(Body(refresh_token: refreshToken, client_id: clientId))
    )
    guard res.status == 200 else {
        let err = errorFromResponse(status: res.status, body: res.body)
        if err.code == "invalid_grant" {
            throw PlumAuthError(status: err.status, message: err.message, code: "invalid_grant")
        }
        throw err
    }
    var tokens = try tokensFromResponse(res, now: Date())
    if tokens.refreshToken == nil { tokens.refreshToken = refreshToken }
    return tokens
}

/// Read a 200 from the token endpoint (RFC 6749 5.1, plus Plum's `app_folder`).
func tokensFromResponse(_ res: PlumResponse, now: Date) throws -> OAuthTokens {
    let body = ((try? JSONSerialization.jsonObject(with: res.body)) as? [String: Any]) ?? [:]
    guard let access = body["access_token"] as? String, !access.isEmpty else {
        throw PlumApiError(status: res.status, message: "the token response carried no access_token", code: "invalid_token_response")
    }
    var out = OAuthTokens(
        accessToken: access,
        tokenType: (body["token_type"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "bearer",
        scope: body["scope"] as? String ?? ""
    )
    if let r = body["refresh_token"] as? String, !r.isEmpty { out.refreshToken = r }
    if let n = body["expires_in"] as? NSNumber, !isBoolean(n) {
        let seconds = n.doubleValue
        if seconds.isFinite, seconds > 0 { out.expiresAt = now.addingTimeInterval(seconds) }
    }
    if let f = body["app_folder"] as? String, f.hasPrefix("/") { out.appFolder = f }
    return out
}

private func isBoolean(_ n: NSNumber) -> Bool {
    CFGetTypeID(n) == CFBooleanGetTypeID()
}
