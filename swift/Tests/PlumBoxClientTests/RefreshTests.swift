import XCTest
@testable import PlumBoxClient

// PlumClient keeping an OAuth connection alive: hourly access tokens, rotating
// refresh tokens, one refresh for many requests, and telling "signed out"
// (401 / invalid_grant) from "not allowed" (403). The Swift twin of
// packages/client/test/refresh.test.ts.

func makeClient(
    _ box: FakeBox,
    baseUrl: String? = nil,
    token: String? = "plum_pat_1",
    refreshToken: String? = "plum_rt_1",
    expiresIn: TimeInterval = 3600,
    appFolder: String? = nil,
    iss: String? = nil,
    tokenStore: (any TokenStore)? = nil,
    onTokens: (@Sendable (OAuthTokens) async throws -> Void)? = nil,
    onAuthError: (@Sendable (PlumAuthError) -> Void)? = nil
) throws -> PlumClient {
    try PlumClient(
        baseUrl: baseUrl ?? box.iss,
        token: token,
        refreshToken: refreshToken,
        expiresAt: Date().addingTimeInterval(expiresIn),
        appFolder: appFolder,
        clientId: FakeBox.clientId,
        iss: iss,
        tokenStore: tokenStore,
        urlSession: box.session,
        onTokens: onTokens,
        onAuthError: onAuthError
    )
}

final class RefreshTests: XCTestCase {
    func testRefreshesOnA401RetriesAndHandsTheRotatedSetToOnTokens() async throws {
        let box = FakeBox()
        box.with { $0.access = "plum_pat_expired_elsewhere" } // the box no longer takes plum_pat_1
        let onTokens = Recorder<OAuthTokens>()
        let onAuthError = Recorder<PlumAuthError>()
        let c = try makeClient(box, onTokens: { onTokens.append($0) }, onAuthError: { onAuthError.append($0) })
        _ = try await c.drive.list("/Apps/Obsidian Sync")

        XCTAssertEqual(box.with { $0.refreshes }, 1)
        XCTAssertEqual(onAuthError.count, 0)
        let tokens = try XCTUnwrap(onTokens.items.first)
        XCTAssertEqual(tokens.accessToken, "plum_pat_2")
        XCTAssertEqual(tokens.refreshToken, "plum_rt_2")
        XCTAssertEqual(tokens.scope, "files:app")
        XCTAssertEqual(tokens.appFolder, "/Apps/Obsidian Sync")
        XCTAssertEqual(tokens.tokenType, "bearer")
        XCTAssertGreaterThan(try XCTUnwrap(tokens.expiresAt), Date().addingTimeInterval(3500))
        let lists = box.requests("/api/drive/list")
        XCTAssertEqual(lists.map { $0.header("authorization") }, ["Bearer plum_pat_1", "Bearer plum_pat_2"])
        XCTAssertEqual(box.tokenCalls.first?.url.absoluteString, "\(box.iss)/api/oauth/token")
    }

    func testOnTokensRunsBeforeTheRetriedRequest() async throws {
        let box = FakeBox()
        box.with { $0.access = "plum_pat_rotated_away" }
        let store = MemoryTokenStore()
        let c = try makeClient(box, tokenStore: store, onTokens: { tokens in
            // Persisting takes a while; the retry must wait for it.
            try await Task.sleep(nanoseconds: 30_000_000)
            box.log("onTokens \(tokens.refreshToken ?? "-")")
        })
        _ = try await c.drive.list("/Apps/Obsidian Sync")
        XCTAssertEqual(box.with { $0.events }, [
            "GET /api/drive/list",
            "token",
            "onTokens plum_rt_2",
            "GET /api/drive/list",
        ])
        // The store already had the rotated set by then, too.
        let saved = try await store.load()
        XCTAssertEqual(saved?.tokens.refreshToken, "plum_rt_2")
        XCTAssertEqual(saved?.iss, box.iss)
        XCTAssertEqual(saved?.clientId, FakeBox.clientId)
    }

    func testRefreshesAheadOfTimeWithLessThanAMinuteLeft() async throws {
        let box = FakeBox()
        let onTokens = Recorder<OAuthTokens>()
        let c = try makeClient(box, expiresIn: 30, onTokens: { onTokens.append($0) })
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        XCTAssertEqual(box.with { $0.seen.map(\.path) }, ["/api/oauth/token", "/api/auth/me"])
        XCTAssertEqual(box.with { $0.seen[1].header("authorization") }, "Bearer plum_pat_2")
        XCTAssertEqual(onTokens.count, 1)
        // ...and not again while the new token is fresh.
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.refreshes }, 1)
    }

    func testFourRequestsThatAllHit401ShareOneRefresh() async throws {
        let box = FakeBox()
        let gate = Gate()
        box.with {
            $0.access = "plum_pat_rotated_away"
            $0.tokenGate = gate
        }
        let c = try makeClient(box)
        async let all: [ListPage] = withThrowingTaskGroup(of: ListPage.self) { group in
            for i in 0..<4 { group.addTask { try await c.drive.list("/Apps/Obsidian Sync/\(i)") } }
            var out: [ListPage] = []
            for try await p in group { out.append(p) }
            return out
        }
        try await waitFor { box.with { $0.refreshes } == 1 && box.requests("/api/drive/list").count == 4 }
        try await Task.sleep(nanoseconds: 50_000_000) // every request has had its 401 by now
        gate.release()
        let pages = try await all
        XCTAssertEqual(pages.count, 4)
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        // A second refresh would have sent the rotated-away plum_rt_1 again —
        // on a real box, after the grace period, that ends the connection.
        XCTAssertEqual(box.tokenCalls.count, 1)
        let retried = box.requests("/api/drive/list").filter { $0.header("authorization") == "Bearer plum_pat_2" }
        XCTAssertEqual(retried.count, 4)
    }

    func testA401ThatLandsAfterAnotherRequestRefreshedJustRetries() async throws {
        let box = FakeBox()
        box.with { $0.access = "plum_pat_rotated_away" }
        // Hold B's first answer until A has had its 401, refreshed and retried.
        let bGate = Gate()
        box.hold = { req in
            if req.url.absoluteString.contains("B"), req.header("authorization") == "Bearer plum_pat_1" { await bGate.wait() }
        }
        let c = try makeClient(box)
        async let b = c.drive.list("/Apps/Obsidian Sync/B") // goes out with plum_pat_1
        try await waitFor { box.requests("/api/drive/list").count == 1 }
        _ = try await c.drive.list("/Apps/Obsidian Sync/A") // 401 → refresh → plum_pat_2
        bGate.release() // B's 401 (for plum_pat_1) arrives only now
        _ = try await b
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        let bs = box.requests("/api/drive/list").filter { $0.url.absoluteString.contains("B") }
        XCTAssertEqual(bs.map { $0.header("authorization") }, ["Bearer plum_pat_1", "Bearer plum_pat_2"])
    }

    func testInvalidGrantEndsTheConnectionOnAuthErrorOnce() async throws {
        let box = FakeBox()
        box.with {
            $0.access = "plum_pat_rotated_away"
            $0.failRefresh = .json(400, ["error": "invalid_grant"])
        }
        let onAuthError = Recorder<PlumAuthError>()
        let onTokens = Recorder<OAuthTokens>()
        let c = try makeClient(box, onTokens: { onTokens.append($0) }, onAuthError: { onAuthError.append($0) })
        let results = await withTaskGroup(of: Error?.self) { group -> [Error?] in
            for i in 0..<4 {
                group.addTask { await expectThrows { try await c.drive.list("/Apps/Obsidian Sync/\(i)") } }
            }
            var out: [Error?] = []
            for await r in group { out.append(r) }
            return out
        }
        for err in results {
            let auth = try XCTUnwrap(err as? PlumAuthError, "\(String(describing: err))")
            XCTAssertTrue(auth.code == "invalid_grant" || auth.status == 401)
        }
        XCTAssertEqual(onAuthError.count, 1)
        XCTAssertEqual(onAuthError.items.first?.code, "invalid_grant")
        XCTAssertEqual(onTokens.count, 0)
        XCTAssertEqual(box.with { $0.refreshes }, 1)

        let again = await expectThrows { try await c.drive.list("/Apps/Obsidian Sync") }
        XCTAssertTrue(again is PlumAuthError)
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        XCTAssertEqual(onAuthError.count, 1)
    }

    func testARefreshThatCouldNotReachTheBoxIsNotASignOut() async throws {
        let box = FakeBox()
        box.with {
            $0.access = "plum_pat_rotated_away"
            $0.failRefresh = .json(503, ["error": "unavailable"])
        }
        let onAuthError = Recorder<PlumAuthError>()
        let c = try makeClient(box, onAuthError: { onAuthError.append($0) })
        let err = await expectThrows { try await c.drive.list("/Apps/Obsidian Sync") }
        XCTAssertTrue(err is PlumApiError)
        XCTAssertFalse(err is PlumAuthError)
        XCTAssertEqual((err as? PlumApiError)?.status, 503)
        XCTAssertEqual(onAuthError.count, 0)
        box.with { $0.failRefresh = nil }
        _ = try await c.drive.list("/Apps/Obsidian Sync")
        XCTAssertEqual(box.with { $0.refreshes }, 2)
        XCTAssertEqual(onAuthError.count, 0)
    }

    func testGoesAheadWithATokenThatHasAFewSecondsLeftWhenAnEarlyRefreshFails() async throws {
        let box = FakeBox()
        box.with { $0.failRefresh = .json(503, ["error": "unavailable"]) }
        let c = try makeClient(box, expiresIn: 20)
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.map(\.path) }, ["/api/oauth/token", "/api/auth/me"])
    }

    func testRefreshesOnlyOncePerRequest() async throws {
        let box = FakeBox()
        let onAuthError = Recorder<PlumAuthError>()
        // The box accepts neither the old token nor the refreshed one.
        box.with { $0.access = "plum_pat_nothing_works" }
        box.afterToken = { b in b.with { $0.access = "plum_pat_nothing_works" } }
        let c = try makeClient(box, onAuthError: { onAuthError.append($0) })
        let err = await expectThrows { try await c.drive.list("/Apps/Obsidian Sync") }
        XCTAssertTrue(err is PlumAuthError)
        XCTAssertEqual((err as? PlumAuthError)?.status, 401)
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        XCTAssertEqual(onAuthError.count, 1)
    }

    func testSendsAnUploadBodyAgainByteForByteAfterTheRefresh() async throws {
        let box = FakeBox()
        box.with { $0.access = "plum_pat_rotated_away" }
        let c = try makeClient(box)
        try await c.drive.upload("/Apps/Obsidian Sync/a.md", text: "hello", options: UploadOptions(overwrite: true))
        let uploads = box.requests("/api/drive/upload")
        XCTAssertEqual(uploads.count, 2)
        XCTAssertEqual(uploads[1].body, uploads[0].body)
        XCTAssertEqual(uploads[1].header("content-type"), uploads[0].header("content-type"))
        XCTAssertEqual(uploads.map { $0.header("authorization") }, ["Bearer plum_pat_1", "Bearer plum_pat_2"])
    }

    func testA403IsNotAReasonToRefreshOrToSignOut() async throws {
        let box = FakeBox()
        let onAuthError = Recorder<PlumAuthError>()
        let c = try makeClient(box, onAuthError: { onAuthError.append($0) })
        let err = await expectThrows { try await c.drive.list("/Photos") }
        XCTAssertTrue(err is PlumForbiddenError)
        XCTAssertTrue(err is PlumApiError)
        XCTAssertFalse(err is PlumAuthError)
        XCTAssertEqual((err as? PlumApiError)?.status, 403)
        XCTAssertEqual(box.with { $0.refreshes }, 0)
        XCTAssertEqual(onAuthError.count, 0)
    }

    func testKeepsTheAppFolderWhenARefreshDoesNotRepeatIt() async throws {
        let box = FakeBox()
        box.with {
            $0.appFolder = false
            $0.access = "plum_pat_rotated_away"
        }
        let onTokens = Recorder<OAuthTokens>()
        let c = try makeClient(box, appFolder: "/Apps/Obsidian Sync", onTokens: { onTokens.append($0) })
        let before = await c.appFolder
        XCTAssertEqual(before, "/Apps/Obsidian Sync")
        _ = try await c.drive.list("/Apps/Obsidian Sync")
        XCTAssertEqual(onTokens.items.first?.appFolder, "/Apps/Obsidian Sync")
        let after = await c.drive.appFolder
        XCTAssertEqual(after, "/Apps/Obsidian Sync")
    }

    func testARefreshTokenAloneRefreshesBeforeTheFirstRequest() async throws {
        let box = FakeBox()
        let c = try PlumClient(baseUrl: box.iss, refreshToken: "plum_rt_1", clientId: FakeBox.clientId, urlSession: box.session)
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.map(\.path) }, ["/api/oauth/token", "/api/auth/me"])
    }

    func testRefreshRefreshesNowAndSharesARefreshInFlight() async throws {
        let box = FakeBox()
        let c = try makeClient(box)
        async let a: Void = c.refresh()
        async let b: Void = c.refresh()
        _ = try await (a, b)
        XCTAssertEqual(box.with { $0.refreshes }, 1)
        let plain = try PlumClient(baseUrl: box.iss, token: "plum_pat_x", urlSession: box.session)
        let err = await expectThrows { try await plain.refresh() }
        XCTAssertTrue((err as? PlumUsageError)?.message.contains("no refresh token") == true)
    }

    func testDropsARefreshResultWhenTheTokensWereReplacedMeanwhile() async throws {
        let box = FakeBox()
        let gate = Gate()
        box.with { $0.tokenGate = gate }
        let onTokens = Recorder<OAuthTokens>()
        let c = try makeClient(box, onTokens: { onTokens.append($0) })
        async let p: Void = c.refresh()
        try await waitFor { box.with { $0.refreshes } == 1 }
        try await c.setToken(OAuthTokens(accessToken: "plum_pat_new_signin", scope: "files:app"))
        gate.release()
        try await p
        XCTAssertEqual(onTokens.count, 0)
        box.with { $0.access = "plum_pat_new_signin" }
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.last?.header("authorization") }, "Bearer plum_pat_new_signin")
    }

    func testAdoptsTheResultWhenStorageHandsBackTheVerySetTheRefreshRotatedAway() async throws {
        let box = FakeBox()
        let gate = Gate()
        box.with { $0.tokenGate = gate }
        let onTokens = Recorder<OAuthTokens>()
        let c = try makeClient(box, onTokens: { onTokens.append($0) })
        async let p: Void = c.refresh()
        try await waitFor { box.with { $0.refreshes } == 1 }
        try await c.setToken(OAuthTokens(accessToken: "plum_pat_1", scope: "files:app", refreshToken: "plum_rt_1"))
        gate.release()
        try await p
        XCTAssertEqual(onTokens.count, 1)
        _ = try await c.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.last?.header("authorization") }, "Bearer plum_pat_2")
    }

    func testARequestThatStartsWhileARefreshIsUnderWayWaitsForIt() async throws {
        let box = FakeBox()
        let gate = Gate()
        box.with {
            $0.access = "plum_pat_rotated_away"
            $0.tokenGate = gate
        }
        let c = try makeClient(box)
        async let first = c.drive.list("/Apps/Obsidian Sync/1")
        try await waitFor { box.with { $0.refreshes } == 1 }
        async let second = c.drive.list("/Apps/Obsidian Sync/2")
        try await Task.sleep(nanoseconds: 50_000_000) // second is waiting on the refresh by now
        gate.release()
        _ = try await (first, second)
        let seconds = box.requests("/api/drive/list").filter { $0.url.absoluteString.contains("%2F2") }
        XCTAssertEqual(seconds.map { $0.header("authorization") }, ["Bearer plum_pat_2"])
    }

    func testAnOldNeverExpiringTokenIsNeverRefreshed() async throws {
        let box = FakeBox()
        box.with { $0.access = "plum_pat_revoked" }
        let onAuthError = Recorder<PlumAuthError>()
        let c = try PlumClient(baseUrl: box.iss, token: "plum_pat_legacy", urlSession: box.session, onAuthError: { onAuthError.append($0) })
        let err = await expectThrows { try await c.request("/api/auth/me") }
        XCTAssertTrue(err is PlumAuthError)
        XCTAssertEqual(box.with { $0.refreshes }, 0)
        XCTAssertEqual(onAuthError.count, 1)
    }

    func testRefusesARefreshTokenItCouldNotUseSafely() throws {
        let box = "https://pb-x.plumbox.me"
        XCTAssertThrowsError(try PlumClient(baseUrl: box, token: "plum_pat_1", refreshToken: "plum_rt_1")) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("clientId") == true)
        }
        XCTAssertThrowsError(try PlumClient(baseUrl: "http://192.168.0.10:8443", token: "plum_pat_1", refreshToken: "plum_rt_1", clientId: FakeBox.clientId)) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("verified iss") == true)
        }
        XCTAssertNoThrow(try PlumClient(baseUrl: box + "/", token: "plum_pat_1", refreshToken: "plum_rt_1", clientId: FakeBox.clientId))
        XCTAssertThrowsError(try PlumClient(baseUrl: box, token: "plum_pat_1", refreshToken: "plum_rt_1", clientId: FakeBox.clientId, iss: "https://pb-x-lan.plumbox.me")) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("verified iss") == true)
        }
        XCTAssertThrowsError(try PlumClient(baseUrl: box, token: "plum_pat_1", tokenStore: MemoryTokenStore())) {
            XCTAssertTrue(($0 as? PlumUsageError)?.message.contains("clientId") == true)
        }
    }

    func testRefreshesAtTheIssNotAtALanBaseUrl() async throws {
        let box = FakeBox()
        box.alias("192.168.0.10")
        box.with { $0.access = "plum_pat_rotated_away" }
        let c = try makeClient(box, baseUrl: "http://192.168.0.10:8443", iss: box.iss)
        _ = try await c.drive.list("/Apps/Obsidian Sync")
        XCTAssertEqual(box.tokenCalls.map(\.url.absoluteString), ["\(box.iss)/api/oauth/token"])
        XCTAssertTrue(box.with { $0.seen.last!.url.absoluteString.hasPrefix("http://192.168.0.10:8443/api/drive/list") })
    }

    func testEnvironmentsTakeOnlyTheirOwnBoxes() {
        XCTAssertThrowsError(try PlumClient(baseUrl: "https://pb-x.staging.plumbox.me", token: "t"))
        XCTAssertThrowsError(try PlumClient(baseUrl: "https://pb-x.plumbox.me", token: "t", environment: .staging))
        XCTAssertNoThrow(try PlumClient(baseUrl: "https://pb-x.staging.plumbox.me", token: "t", environment: .staging))
        XCTAssertNoThrow(try PlumClient(baseUrl: "http://192.168.0.10:8443", token: "t", environment: .staging))
        XCTAssertThrowsError(try PlumClient(baseUrl: "https://pb-x.plumbox.me", token: "t", portalOrigin: "https://staging.plumbox.me"))
    }
}

final class TokenStoreTests: XCTestCase {
    func testStoresTheWholeSetAndKeepsItCurrentAcrossRefreshes() async throws {
        let box = FakeBox()
        let store = MemoryTokenStore()
        let c = try PlumClient(baseUrl: box.iss, clientId: FakeBox.clientId, tokenStore: store, urlSession: box.session)
        try await c.setToken(OAuthTokens(
            accessToken: "plum_pat_1",
            scope: "files:app",
            refreshToken: "plum_rt_1",
            expiresAt: Date().addingTimeInterval(3600),
            appFolder: "/Apps/Obsidian Sync"
        ))
        var saved = try await store.load()
        XCTAssertEqual(saved?.tokens.accessToken, "plum_pat_1")
        XCTAssertEqual(saved?.tokens.refreshToken, "plum_rt_1")

        box.with { $0.access = "plum_pat_rotated_away" }
        _ = try await c.drive.list("/Apps/Obsidian Sync")
        saved = try await store.load()
        XCTAssertEqual(saved?.tokens.accessToken, "plum_pat_2")
        XCTAssertEqual(saved?.tokens.refreshToken, "plum_rt_2")
        XCTAssertEqual(saved?.tokens.appFolder, "/Apps/Obsidian Sync")
        XCTAssertEqual(saved?.tokens.scope, "files:app")

        let again = try PlumClient(baseUrl: box.iss, clientId: FakeBox.clientId, tokenStore: store, urlSession: box.session)
        let loaded = try await again.loadToken()
        XCTAssertTrue(loaded)
        let folder = await again.appFolder
        XCTAssertEqual(folder, "/Apps/Obsidian Sync")
        _ = try await again.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.last?.header("authorization") }, "Bearer plum_pat_2")

        // Or straight from the saved connection.
        let fromSaved = try PlumClient(connection: try XCTUnwrap(saved), tokenStore: store, urlSession: box.session)
        _ = try await fromSaved.request("/api/auth/me")
        XCTAssertEqual(box.with { $0.seen.last?.header("authorization") }, "Bearer plum_pat_2")
    }

    func testDoesNotLoadAConnectionOfAnotherBoxOrClient() async throws {
        let tokens = OAuthTokens(accessToken: "plum_pat_1", scope: "files:app")
        let store = MemoryTokenStore(PlumConnection(iss: "https://pb-other.plumbox.me", clientId: FakeBox.clientId, tokens: tokens))
        let c = try PlumClient(baseUrl: "https://pb-x.plumbox.me", clientId: FakeBox.clientId, tokenStore: store)
        let loaded = try await c.loadToken()
        XCTAssertFalse(loaded)
        let has = await c.hasToken
        XCTAssertFalse(has)

        let other = MemoryTokenStore(PlumConnection(iss: "https://pb-x.plumbox.me", clientId: "com.other:ios", tokens: tokens))
        let c2 = try PlumClient(baseUrl: "https://pb-x.plumbox.me", clientId: FakeBox.clientId, tokenStore: other)
        let loaded2 = try await c2.loadToken()
        XCTAssertFalse(loaded2)
    }

    func testClearTokenForgetsAndDeletes() async throws {
        let store = MemoryTokenStore()
        let c = try PlumClient(baseUrl: "https://pb-x.plumbox.me", clientId: FakeBox.clientId, tokenStore: store)
        try await c.setToken(OAuthTokens(accessToken: "plum_pat_x"))
        var has = await c.hasToken
        XCTAssertTrue(has)
        try await c.clearToken()
        has = await c.hasToken
        XCTAssertFalse(has)
        let saved = try await store.load()
        XCTAssertNil(saved)
    }

    func testConnectionJSONMatchesTheTypeScriptShape() throws {
        let conn = PlumConnection(
            iss: "https://pb-x.plumbox.me",
            clientId: "com.example:ios",
            tokens: OAuthTokens(
                accessToken: "plum_pat_1", scope: "files:app", refreshToken: "plum_rt_1",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000.5), appFolder: "/Apps/X"
            )
        )
        let data = try conn.encoded()
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let tokens = try XCTUnwrap(obj["tokens"] as? [String: Any])
        XCTAssertEqual((tokens["expiresAt"] as? NSNumber)?.doubleValue, 1_800_000_000_500) // ms since the epoch
        XCTAssertEqual(tokens["appFolder"] as? String, "/Apps/X")
        XCTAssertEqual(try PlumConnection.decoded(from: data), conn)
    }

    #if canImport(Security)
    func testKeychainRoundTrip() async throws {
        let store = KeychainTokenStore(service: "im.plum.sdk.tests.\(UUID().uuidString)")
        let conn = PlumConnection(
            iss: "https://pb-x.plumbox.me",
            clientId: "com.example:ios",
            tokens: OAuthTokens(accessToken: "plum_pat_1", scope: "files:app", refreshToken: "plum_rt_1", expiresAt: Date(timeIntervalSince1970: 1_800_000_000))
        )
        do {
            try await store.save(conn)
        } catch let err as KeychainError {
            throw XCTSkip("no usable keychain in this test environment: \(err.localizedDescription)")
        }
        defer { Task { try? await store.delete() } }
        let loaded = try await store.load()
        XCTAssertEqual(loaded, conn)
        var rotated = conn
        rotated.tokens.refreshToken = "plum_rt_2"
        try await store.save(rotated) // update in place, one item
        let loadedAgain = try await store.load()
        XCTAssertEqual(loadedAgain?.tokens.refreshToken, "plum_rt_2")
        try await store.delete()
        let gone = try await store.load()
        XCTAssertNil(gone)
        try await store.delete() // deleting nothing is fine
    }
    #endif
}
