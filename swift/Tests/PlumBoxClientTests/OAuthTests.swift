import CryptoKit
import XCTest
@testable import PlumBoxClient

// The vectors of packages/client/test/oauth.test.ts (v3 contract 10.1 and
// Appendix C): the only iss a client accepts is a Plum box's canonical origin.
let longest = "pb-" + String(repeating: "a", count: 59) // 62-character DNS label
let goodIss = [
    "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me", // what relay names a box
    "https://pb-x.plumbox.me",
    "https://pb-a1.plumbox.me",
    "https://pb-old-style-name.plumbox.me", // not narrowed to hex: older names exist
    "https://pb-xlan.plumbox.me", // ends in "lan", but not the -lan alias
    "https://\(longest).plumbox.me",
]
let badIss: [(String, String?)] = [
    ("LAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-lan.plumbox.me"),
    ("WAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-wan.plumbox.me"),
    ("short LAN alias", "https://pb-x-lan.plumbox.me"),
    ("short WAN alias", "https://pb-x-wan.plumbox.me"),
    ("other domain", "https://pb-x.evil.example"),
    ("lookalike suffix", "https://pb-x.plumbox.me.evil.example"),
    ("other domain ending like ours", "https://pb-x.notplumbox.me"),
    ("the portal", "https://plumbox.me"),
    ("the relay", "https://relay.plumbox.me"),
    ("not a box name", "https://www.plumbox.me"),
    ("http", "http://pb-x.plumbox.me"),
    ("port", "https://pb-x.plumbox.me:443"),
    ("other port", "https://pb-x.plumbox.me:8443"),
    ("empty", ""),
    ("missing", nil),
    ("trailing slash", "https://pb-x.plumbox.me/"),
    ("path", "https://pb-x.plumbox.me/api"),
    ("query", "https://pb-x.plumbox.me?x=1"),
    ("fragment", "https://pb-x.plumbox.me#x"),
    ("user info", "https://user@pb-x.plumbox.me"),
    ("upper case", "https://PB-X.plumbox.me"),
    ("upper-case name", "https://pb-X.plumbox.me"),
    ("upper-case scheme", "HTTPS://pb-x.plumbox.me"),
    ("empty name", "https://pb-.plumbox.me"),
    ("name starts with a hyphen", "https://pb--x.plumbox.me"),
    ("name ends with a hyphen", "https://pb-x-.plumbox.me"),
    ("subdomain of a box", "https://a.pb-x.plumbox.me"),
    ("dot in the name", "https://pb-x.y.plumbox.me"),
    ("too long", "https://\(longest)a.plumbox.me"),
    ("leading space", " https://pb-x.plumbox.me"),
    ("trailing newline", "https://pb-x.plumbox.me\n"),
    ("trailing dot", "https://pb-x.plumbox.me."),
]

/// A box that records everything; the stop cases must leave it empty.
func spyBox(_ reply: Reply) -> FakeBox {
    let box = FakeBox(name: "x")
    box.route = { _ in reply }
    return box
}

final class BeginAuthorizationTests: XCTestCase {
    func testRequiresClientIdAndScope() {
        XCTAssertThrowsError(try beginAuthorization(clientId: " ", redirectUri: "x://cb", scopes: [.filesRead])) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("clientId is required") == true)
        }
        XCTAssertThrowsError(try beginAuthorization(clientId: "com.example.notes:ios", redirectUri: "x://cb", scopes: [])) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("scope") == true)
        }
    }

    func testBuildsPortalURLWithValidS256Challenge() throws {
        let req = try beginAuthorization(
            clientId: "obsidian-plum-sync",
            redirectUri: "obsidian://plum-sync/callback",
            scopes: [.read, .write]
        )
        let c = URLComponents(url: req.url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual("\(c.scheme!)://\(c.host!)\(c.path)", "https://plumbox.me/authorize")
        let q = query(req.url)
        XCTAssertEqual(q["response_type"], "code")
        XCTAssertEqual(q["code_challenge_method"], "S256")
        XCTAssertEqual(q["client_id"], "obsidian-plum-sync")
        XCTAssertEqual(q["redirect_uri"], "obsidian://plum-sync/callback")
        XCTAssertEqual(q["scope"], "read write")
        XCTAssertEqual(q["state"], req.state)
        XCTAssertNil(q["client_name"])

        // The challenge must equal base64url(SHA-256(verifier)) — the exact
        // check the box performs. Computed here independently of the SDK.
        let digest = Data(SHA256.hash(data: Data(req.codeVerifier.utf8)))
        let expected = digest.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(q["code_challenge"], expected)

        // RFC 7636: 43–128 unreserved characters; state 16 random bytes.
        XCTAssertTrue(req.codeVerifier.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil, req.codeVerifier)
        XCTAssertTrue(req.state.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil, req.state)
    }

    func testRFC7636AppendixBVector() {
        // The challenge function itself against the RFC's published example.
        XCTAssertEqual(
            pkceChallenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }

    func testSendsScopeVocabularyFormEncoded() throws {
        let req = try beginAuthorization(
            clientId: "com.example.notes:ios",
            redirectUri: "examplenotes://oauth/callback",
            scopes: [.filesRead, .userProfile, .serviceCall("com.example.notes")]
        )
        XCTAssertEqual(query(req.url)["scope"], "files:read user:profile service:call:com.example.notes")
        // URLSearchParams spelling on the wire: ':' and '/' escaped, space as '+'.
        XCTAssertTrue(req.url.absoluteString.contains("scope=files%3Aread+user%3Aprofile+service%3Acall%3Acom.example.notes"))
        XCTAssertTrue(req.url.absoluteString.contains("redirect_uri=examplenotes%3A%2F%2Foauth%2Fcallback"))
    }

    func testFreshVerifierAndStateEachCall() throws {
        let a = try beginAuthorization(clientId: "x", redirectUri: "obsidian://x/cb", scopes: ["read"])
        let b = try beginAuthorization(clientId: "x", redirectUri: "obsidian://x/cb", scopes: ["read"])
        XCTAssertNotEqual(a.codeVerifier, b.codeVerifier)
        XCTAssertNotEqual(a.state, b.state)
    }

    func testPortalPerEnvironmentAndOverride() throws {
        let staging = try beginAuthorization(clientId: "x", redirectUri: "x://cb", scopes: [.filesApp], environment: .staging)
        XCTAssertTrue(staging.url.absoluteString.hasPrefix("https://staging.plumbox.me/authorize?"))
        let custom = try beginAuthorization(clientId: "x", redirectUri: "x://cb", scopes: [.filesApp], portalUrl: "https://portal.example//")
        XCTAssertTrue(custom.url.absoluteString.hasPrefix("https://portal.example/authorize?"))
    }

    func testAuthorizationSessionReadsTheRedirectScheme() throws {
        #if canImport(AuthenticationServices) && (os(iOS) || os(macOS))
        let req = try beginAuthorization(clientId: "x", redirectUri: "MyApp://plum/callback", scopes: [.filesApp])
        XCTAssertEqual(PlumAuthorizationSession.redirectScheme(of: req.url), "myapp")
        #endif
    }

    private func query(_ url: URL) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in formDecodeQuery(URLComponents(url: url, resolvingAgainstBaseURL: false)!.percentEncodedQuery!) { out[k] = v }
        return out
    }
}

final class IssuerTests: XCTestCase {
    func testAcceptsCanonicalBoxOrigins() {
        for iss in goodIss { XCTAssertTrue(isPlumIssuer(iss), iss) }
    }

    func testRefusesEverythingElse() {
        for (name, iss) in badIss { XCTAssertFalse(isPlumIssuer(iss), name) }
    }
}

final class ParseCallbackTests: XCTestCase {
    private func cb(_ params: [(String, String)]) -> URL {
        URL(string: "myapp://plum/callback?" + params.map { "\($0.0)=\(encodeURIComponent($0.1))" }.joined(separator: "&"))!
    }

    func testCases() {
        let box = goodIss[0]
        let cases: [(String, [(String, String)], CallbackResult)] = [
            ("a code from a box", [("code", "C1"), ("state", "S"), ("iss", box)], CallbackResult(code: "C1", state: "S", iss: box)),
            ("a code with no iss", [("code", "C1"), ("state", "S")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code with an empty iss", [("code", "C1"), ("state", "S"), ("iss", "")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code from the LAN alias", [("code", "C1"), ("state", "S"), ("iss", "https://pb-x-lan.plumbox.me")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code from the WAN alias", [("code", "C1"), ("state", "S"), ("iss", "https://pb-x-wan.plumbox.me")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code from another domain", [("code", "C1"), ("state", "S"), ("iss", "https://pb-x.evil.example")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code over http", [("code", "C1"), ("state", "S"), ("iss", "http://pb-x.plumbox.me")], CallbackResult(state: "S", error: "invalid_iss")),
            ("a code with a port", [("code", "C1"), ("state", "S"), ("iss", "https://pb-x.plumbox.me:8443")], CallbackResult(state: "S", error: "invalid_iss")),
            ("an error from an older box (no iss)", [("error", "access_denied"), ("state", "S")], CallbackResult(state: "S", error: "access_denied")),
            ("an error with the box's iss", [("error", "access_denied"), ("state", "S"), ("iss", "https://pb-x.plumbox.me")], CallbackResult(state: "S", iss: "https://pb-x.plumbox.me", error: "access_denied")),
            ("an error with a bad iss", [("error", "access_denied"), ("state", "S"), ("iss", "https://pb-x-lan.plumbox.me")], CallbackResult(state: "S", error: "invalid_iss")),
            ("an error and a code", [("error", "access_denied"), ("code", "C1"), ("state", "S"), ("iss", "https://pb-x.plumbox.me")], CallbackResult(state: "S", iss: "https://pb-x.plumbox.me", error: "access_denied")),
            ("neither code nor error", [("state", "S"), ("iss", "https://pb-x.plumbox.me")], CallbackResult(state: "S", error: "invalid_request")),
        ]
        for (name, params, want) in cases {
            XCTAssertEqual(parseCallback(cb(params)), want, name)
            XCTAssertEqual(try parseCallback(cb(params).absoluteString), want, name)
        }
    }

    func testNeverHandsBackACodeWithoutACheckedIss() {
        for (name, iss) in badIss {
            var params = [("code", "C1"), ("state", "S")]
            if let iss { params.append(("iss", iss)) }
            let r = parseCallback(cb(params))
            XCTAssertNil(r.code, name)
            XCTAssertNil(r.iss, name)
            XCTAssertEqual(r.error, "invalid_iss", name)
        }
    }

    func testRefusesAnIssGivenTwice() {
        let good = encodeURIComponent("https://pb-x.plumbox.me")
        let evil = encodeURIComponent("https://evil.example")
        XCTAssertEqual(parseCallback(URL(string: "myapp://cb?code=C1&state=S&iss=\(good)&iss=\(evil)")!), CallbackResult(state: "S", error: "invalid_iss"))
        XCTAssertEqual(parseCallback(URL(string: "myapp://cb?code=C1&state=S&iss=\(evil)&iss=\(good)")!), CallbackResult(state: "S", error: "invalid_iss"))
        XCTAssertEqual(parseCallback(URL(string: "myapp://cb?code=C1&state=S&iss=\(good)&iss=\(good)")!), CallbackResult(state: "S", error: "invalid_iss"))
    }

    func testRefusesACodeGivenTwice() {
        let good = encodeURIComponent("https://pb-x.plumbox.me")
        XCTAssertEqual(
            parseCallback(URL(string: "myapp://cb?code=A&code=B&state=S&iss=\(good)")!),
            CallbackResult(state: "S", iss: "https://pb-x.plumbox.me", error: "invalid_request")
        )
    }

    func testReadsPlusAsSpaceLikeURLSearchParams() {
        let r = parseCallback(URL(string: "myapp://cb?error=access+denied&state=S")!)
        XCTAssertEqual(r.error, "access denied")
    }

    func testThrowsOnAMalformedURL() {
        XCTAssertThrowsError(try parseCallback("not a url"))
    }
}

final class ExchangeCodeTests: XCTestCase {
    static let tokenJSON = #"{"access_token":"plum_pat_abc","token_type":"bearer","expires_in":3600,"refresh_token":"plum_rt_1","scope":"files:app user:profile","app_folder":"/Apps/Obsidian Sync"}"#

    private func exchange(
        _ box: FakeBox,
        baseUrl: String? = "https://pb-x.plumbox.me",
        code: String = "CODE1",
        state: String? = "ST",
        expectedState: String = "ST",
        codeVerifier: String = "VERIFIER1"
    ) async throws -> OAuthTokens {
        try await exchangeCode(
            baseUrl: baseUrl ?? "",
            code: code,
            state: state,
            expectedState: expectedState,
            codeVerifier: codeVerifier,
            clientId: "im.plum.obsidian-sync:obsidian",
            redirectUri: "obsidian://plum-sync",
            urlSession: box.session
        )
    }

    func testPostsTheAuthorizationCodeGrantToTheIss() async throws {
        let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
        let before = Date()
        let out = try await exchange(box)
        XCTAssertEqual(out.accessToken, "plum_pat_abc")
        XCTAssertEqual(out.tokenType, "bearer")
        XCTAssertEqual(out.scope, "files:app user:profile")
        XCTAssertEqual(out.refreshToken, "plum_rt_1")
        XCTAssertEqual(out.appFolder, "/Apps/Obsidian Sync")
        let exp = try XCTUnwrap(out.expiresAt)
        XCTAssertGreaterThanOrEqual(exp, before.addingTimeInterval(3600))
        XCTAssertLessThanOrEqual(exp, Date().addingTimeInterval(3600))

        XCTAssertEqual(box.seen.count, 1)
        XCTAssertEqual(box.seen[0].url.absoluteString, "https://pb-x.plumbox.me/api/oauth/token")
        XCTAssertEqual(box.seen[0].method, "POST")
        XCTAssertEqual(box.seen[0].header("content-type"), "application/json")
        XCTAssertEqual(box.seen[0].json as NSDictionary, [
            "grant_type": "authorization_code",
            "code": "CODE1",
            "code_verifier": "VERIFIER1",
            "client_id": "im.plum.obsidian-sync:obsidian",
            "redirect_uri": "obsidian://plum-sync",
        ] as NSDictionary)
    }

    func testSendsNothingToANonBox() async {
        for (name, iss) in badIss {
            let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
            let err = await expectThrows { try await self.exchange(box, baseUrl: iss) }
            XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidIss, name)
            XCTAssertEqual(box.seen.count, 0, name)
        }
    }

    func testSendsNothingForAStateMismatch() async {
        let cases: [(String, String?, String)] = [
            ("a different state", "OTHER", "ST"),
            ("no state on the callback", nil, "ST"),
            ("an empty expected state", "", ""),
        ]
        for (name, state, expected) in cases {
            let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
            let err = await expectThrows { try await self.exchange(box, state: state, expectedState: expected) }
            XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidState, name)
            XCTAssertEqual(err.map { ($0 as? PlumOAuthError)?.code.rawValue }, "invalid_state", name)
            XCTAssertEqual(box.seen.count, 0, name)
        }
    }

    func testChecksIssBeforeState() async {
        let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
        let err = await expectThrows { try await self.exchange(box, baseUrl: "https://evil.example", state: "OTHER") }
        XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidIss)
    }

    func testSendsNothingWithoutCodeOrVerifier() async {
        for (code, verifier) in [("", "VERIFIER1"), ("CODE1", "")] {
            let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
            let err = await expectThrows { try await self.exchange(box, code: code, codeVerifier: verifier) }
            XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidRequest)
            XCTAssertEqual(box.seen.count, 0)
        }
    }

    func testExchangesExactlyWhatAGoodCallbackCarried() async throws {
        let cb = parseCallback(URL(string: "myapp://plum/callback?code=CODE1&state=ST&iss=\(encodeURIComponent("https://pb-x.plumbox.me"))")!)
        let box = spyBox(Reply(status: 200, body: Data(Self.tokenJSON.utf8)))
        _ = try await exchange(box, baseUrl: cb.iss, code: cb.code!, state: cb.state)
        XCTAssertEqual(box.seen.map(\.url.absoluteString), ["https://pb-x.plumbox.me/api/oauth/token"])
    }

    func testTakesAnOlderBoxsAnswer() async throws {
        let box = spyBox(.text(200, #"{"access_token":"plum_pat_old","token_type":"bearer","scope":"files:read files:write"}"#))
        let out = try await exchange(box)
        XCTAssertEqual(out, OAuthTokens(accessToken: "plum_pat_old", tokenType: "bearer", scope: "files:read files:write"))
        XCTAssertNil(out.refreshToken)
        XCTAssertNil(out.expiresAt)
        XCTAssertNil(out.appFolder)
    }

    func testRefusesA200WithoutAccessToken() async {
        let box = spyBox(.text(200, #"{"token_type":"bearer"}"#))
        let err = await expectThrows { try await self.exchange(box) }
        XCTAssertEqual((err as? PlumApiError)?.code, "invalid_token_response")
    }

    func testThrowsTheBoxsOAuthError() async {
        let box = spyBox(.text(400, #"{"error":"invalid_grant","error_description":"bad code"}"#))
        let err = await expectThrows { try await self.exchange(box, code: "bad") }
        let api = err as? PlumApiError
        XCTAssertEqual(api?.status, 400)
        XCTAssertEqual(api?.code, "invalid_grant")
    }
}

final class RefreshTokensTests: XCTestCase {
    static let rotated = #"{"access_token":"plum_pat_2","token_type":"bearer","expires_in":3600,"refresh_token":"plum_rt_2","scope":"files:app","app_folder":"/Apps/Obsidian Sync"}"#

    private func refresh(_ box: FakeBox, iss: String? = "https://pb-x.plumbox.me", clientId: String = "im.plum.obsidian-sync:obsidian", refreshToken: String = "plum_rt_1") async throws -> OAuthTokens {
        try await refreshTokens(iss: iss ?? "", clientId: clientId, refreshToken: refreshToken, urlSession: box.session)
    }

    func testPostsTheRefreshGrantToTheIss() async throws {
        let box = spyBox(.text(200, Self.rotated))
        let out = try await refresh(box)
        XCTAssertEqual(out.accessToken, "plum_pat_2")
        XCTAssertEqual(out.refreshToken, "plum_rt_2")
        XCTAssertEqual(out.scope, "files:app")
        XCTAssertEqual(out.appFolder, "/Apps/Obsidian Sync")
        XCTAssertGreaterThan(try XCTUnwrap(out.expiresAt), Date().addingTimeInterval(3500))
        XCTAssertEqual(box.seen.count, 1)
        XCTAssertEqual(box.seen[0].url.absoluteString, "https://pb-x.plumbox.me/api/oauth/token")
        // As @plumbox/client sends it (the box also takes form encoding).
        XCTAssertEqual(box.seen[0].header("content-type"), "application/json")
        XCTAssertEqual(box.seen[0].json as NSDictionary, [
            "grant_type": "refresh_token",
            "refresh_token": "plum_rt_1",
            "client_id": "im.plum.obsidian-sync:obsidian",
        ] as NSDictionary)
    }

    func testSendsNothingToANonBox() async {
        for (name, iss) in badIss {
            let box = spyBox(.text(200, Self.rotated))
            let err = await expectThrows { try await self.refresh(box, iss: iss) }
            XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidIss, name)
            XCTAssertEqual(box.seen.count, 0, name)
        }
    }

    func testSendsNothingWithoutRefreshTokenOrClientId() async {
        for (cid, rt) in [("im.plum.obsidian-sync:obsidian", ""), ("", "plum_rt_1")] {
            let box = spyBox(.text(200, Self.rotated))
            let err = await expectThrows { try await self.refresh(box, clientId: cid, refreshToken: rt) }
            XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidRequest)
            XCTAssertEqual(box.seen.count, 0)
        }
    }

    func testInvalidGrantIsAnAuthError() async {
        let box = spyBox(.text(400, #"{"error":"invalid_grant"}"#))
        let err = await expectThrows { try await self.refresh(box) }
        XCTAssertTrue(err is PlumAuthError)
        XCTAssertEqual((err as? PlumAuthError)?.status, 400)
        XCTAssertEqual((err as? PlumAuthError)?.code, "invalid_grant")
    }

    func testAnyOtherFailureIsNot() async {
        for (status, body) in [(500, "boom"), (400, #"{"error":"invalid_request"}"#), (503, #"{"error":"unavailable"}"#)] {
            let box = spyBox(.text(status, body))
            let err = await expectThrows { try await self.refresh(box) }
            XCTAssertTrue(err is PlumApiError, "\(status)")
            XCTAssertFalse(err is PlumAuthError, "\(status)")
        }
    }

    func testKeepsTheRefreshTokenItSentWhenTheBoxReturnsNone() async throws {
        let box = spyBox(.text(200, #"{"access_token":"plum_pat_2","token_type":"bearer","expires_in":3600,"scope":"files:app"}"#))
        let out = try await refresh(box)
        XCTAssertEqual(out.refreshToken, "plum_rt_1")
    }
}
