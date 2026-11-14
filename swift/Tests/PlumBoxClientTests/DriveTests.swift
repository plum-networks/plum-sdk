import XCTest
@testable import PlumBoxClient

final class DriveTests: XCTestCase {
    // MARK: ensureDir with a files:app token

    func testEnsureDirPassesOverTheParentsItMayNotTouch() async throws {
        let box = FakeBox()
        let c = try makeClient(box)
        try await c.drive.ensureDir("/Apps/Obsidian Sync/MyVault/notes")
        let made = box.requests("/api/drive/mkdir").map { "\($0.json["path"] as! String)|\($0.json["name"] as! String)" }
        XCTAssertEqual(made, [
            "/|Apps", // 403: passed over
            "/Apps|Obsidian Sync", // 409: exists
            "/Apps/Obsidian Sync|MyVault",
            "/Apps/Obsidian Sync/MyVault|notes",
        ])
    }

    func testEnsureDirStillFailsWhenTheFolderItselfIsOutOfBounds() async throws {
        let box = FakeBox()
        let c = try makeClient(box)
        let err = await expectThrows { try await c.drive.ensureDir("/Photos/2026") }
        XCTAssertTrue(err is PlumForbiddenError)
    }

    // MARK: list / listAll

    func testListSendsTheParamsInTheTypeScriptOrder() async throws {
        let box = FakeBox()
        box.route = { _ in .json(200, ["items": NSNull(), "total": 0, "limit": 50, "offset": 10] as [String: Any]) }
        let c = try makeClient(box)
        let page = try await c.drive.list(
            "/Apps/My App/a b+c",
            options: ListOptions(recursive: true, hash: true, q: "note", limit: 50, offset: 10, sort: .modified, order: .desc)
        )
        XCTAssertEqual(page.items, []) // a Go nil slice
        XCTAssertEqual(
            box.with { $0.seen[0].pathAndQuery },
            "/api/drive/list?path=%2FApps%2FMy+App%2Fa+b%2Bc&recursive=1&hash=1&q=note&sort=modified&order=desc&limit=50&offset=10"
        )
        XCTAssertEqual(box.with { $0.seen[0].query["path"] }, "/Apps/My App/a b+c")
    }

    func testListAllWalksThePages() async throws {
        let box = FakeBox()
        let all = (0..<2500).map { i in ["name": "f\(i)", "path": "/Apps/X/f\(i)", "isDir": false, "size": i, "modTime": "2026-11-13T00:00:00Z", "hash": "h\(i)"] as [String: Any] }
        box.route = { req in
            let offset = Int(req.query["offset"] ?? "0")!
            let limit = Int(req.query["limit"] ?? "0")!
            let items = Array(all[min(offset, all.count)..<min(offset + limit, all.count)])
            return .json(200, ["items": items, "total": all.count, "limit": limit, "offset": offset] as [String: Any])
        }
        let c = try makeClient(box)
        var seen: [DriveEntry] = []
        for try await entry in c.drive.listAll("/Apps/X", options: ListOptions(recursive: true, hash: true)) {
            seen.append(entry)
        }
        XCTAssertEqual(seen.count, 2500)
        XCTAssertEqual(seen.last?.name, "f2499")
        XCTAssertEqual(seen[3].hash, "h3")
        XCTAssertEqual(seen[3].size, 3)
        XCTAssertEqual(box.with { $0.seen.map { $0.query["offset"]! } }, ["0", "1000", "2000"])
        XCTAssertTrue(box.with { $0.seen.allSatisfy { $0.query["limit"] == "1000" && $0.query["recursive"] == "1" && $0.query["hash"] == "1" } })
    }

    func testListAllStopsLazily() async throws {
        let box = FakeBox()
        box.route = { req in
            let offset = Int(req.query["offset"] ?? "0")!
            let items = (0..<1000).map { ["name": "f\(offset + $0)", "path": "/x", "isDir": false, "size": 0, "modTime": ""] as [String: Any] }
            return .json(200, ["items": items, "total": 5000, "limit": 1000, "offset": offset] as [String: Any])
        }
        let c = try makeClient(box)
        var n = 0
        for try await _ in c.drive.listAll("/Apps/X") {
            n += 1
            if n == 1500 { break }
        }
        XCTAssertEqual(box.with { $0.seen.count }, 2) // pages are fetched as you iterate
    }

    // MARK: download / move / rename / remove

    func testTheOtherRoutes() async throws {
        let box = FakeBox()
        box.route = { req in
            req.path == "/api/drive/download" ? Reply(status: 200, headers: [:], body: Data([1, 2, 3])) : .json(200, ["status": "ok"])
        }
        let c = try makeClient(box)
        let bytes = try await c.drive.download("/Apps/X/a&b.bin")
        XCTAssertEqual(bytes, Data([1, 2, 3]))
        try await c.drive.move("/Apps/X/a.md", newPath: "/Apps/X/sub/a.md")
        try await c.drive.rename("/Apps/X/sub/a.md", newName: "b.md")
        try await c.drive.remove("/Apps/X/sub/b.md")
        let seen = box.with { $0.seen }
        XCTAssertEqual(seen.map { "\($0.method) \($0.pathAndQuery)" }, [
            "GET /api/drive/download?path=%2FApps%2FX%2Fa%26b.bin",
            "POST /api/drive/move",
            "POST /api/drive/rename",
            "DELETE /api/drive/delete?path=%2FApps%2FX%2Fsub%2Fb.md",
        ])
        XCTAssertEqual(seen[1].json as NSDictionary, ["path": "/Apps/X/a.md", "newPath": "/Apps/X/sub/a.md"] as NSDictionary)
        XCTAssertEqual(seen[2].json as NSDictionary, ["path": "/Apps/X/sub/a.md", "name": "b.md"] as NSDictionary)
        XCTAssertEqual(seen[1].header("content-type"), "application/json")
        // No `\/` escapes: the bytes are what JSON.stringify writes.
        XCTAssertFalse(String(decoding: seen[1].body, as: UTF8.self).contains("\\/"))
    }

    // MARK: upload

    func testSmallUploadIsOneMultipartPost() async throws {
        let box = FakeBox()
        box.route = { req in
            req.path == "/api/drive/upload" ? .json(200, ["status": "ok", "path": "/Apps/X/note \"1\".md", "name": "note \"1\".md"]) : nil
        }
        let progress = Recorder<[Int64]>()
        let c = try makeClient(box)
        let entry = try await c.drive.upload(
            "/Apps/X/note \"1\".md",
            text: "# hello",
            options: UploadOptions(overwrite: true, contentType: "text/markdown", onProgress: { progress.append([$0, $1]) })
        )
        XCTAssertEqual(entry.name, "note \"1\".md")
        XCTAssertEqual(entry.path, "/Apps/X/note \"1\".md")
        XCTAssertEqual(entry.size, 7)
        XCTAssertFalse(entry.isDir)
        XCTAssertEqual(progress.items, [[7, 7]])

        let req = try XCTUnwrap(box.requests("/api/drive/upload").first)
        XCTAssertEqual(req.method, "POST")
        let ct = try XCTUnwrap(req.header("content-type"))
        XCTAssertTrue(ct.hasPrefix("multipart/form-data; boundary=----plumbox"))
        let boundary = String(ct.dropFirst("multipart/form-data; boundary=".count))
        let body = String(decoding: req.body, as: UTF8.self)
        XCTAssertEqual(body, [
            "--\(boundary)\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n/Apps/X\r\n",
            "--\(boundary)\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n1\r\n",
            "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"note %221%22.md\"\r\nContent-Type: text/markdown\r\n\r\n",
            "# hello",
            "\r\n--\(boundary)--\r\n",
        ].joined())
    }

    func testBigUploadGoesThroughTheChunkedProtocol() async throws {
        let box = FakeBox()
        let total = 8 * 1024 * 1024 + 1 // just over the threshold: 4 MiB + 4 MiB + 1 byte
        var data = Data(count: total)
        data.withUnsafeMutableBytes { buf in for i in 0..<total { buf[i] = UInt8(truncatingIfNeeded: i &* 31) } }
        let received = Recorder<Data>()
        box.route = { req in
            switch req.path {
            case "/api/uploads/init":
                return .json(200, ["uploadId": "up/1 x", "chunkSize": 4_194_304, "expiresAt": "x", "receivedBytes": 0] as [String: Any])
            case "/api/uploads/up/1 x":
                received.append(req.body)
                let got = received.items.reduce(0) { $0 + $1.count }
                if got < total { return .json(200, ["status": "active", "receivedBytes": got, "totalBytes": total] as [String: Any]) }
                return .json(200, ["status": "ok", "path": "/Apps/X/big (2).bin", "name": "big (2).bin"])
            default:
                return nil
            }
        }
        let progress = Recorder<Int64>()
        let c = try makeClient(box)
        let entry = try await c.drive.upload("/Apps/X/big.bin", data: data, options: UploadOptions(onProgress: { sent, all in
            XCTAssertEqual(all, Int64(total))
            progress.append(sent)
        }))
        XCTAssertEqual(entry.path, "/Apps/X/big (2).bin")
        XCTAssertEqual(entry.name, "big (2).bin")
        XCTAssertEqual(entry.size, Int64(total))

        let seen = box.with { $0.seen }
        XCTAssertEqual(seen.map { "\($0.method) \($0.url.path)" }, [
            "POST /api/uploads/init",
            "PATCH /api/uploads/up/1 x",
            "PATCH /api/uploads/up/1 x",
            "PATCH /api/uploads/up/1 x",
        ])
        // encodeURIComponent on the upload id.
        XCTAssertTrue(seen[1].url.absoluteString.hasSuffix("/api/uploads/up%2F1%20x"))
        XCTAssertEqual(seen[0].json as NSDictionary, [
            "target": "drive",
            "path": "/Apps/X",
            "filename": "big.bin",
            "size": total,
            "contentType": "application/octet-stream",
        ] as NSDictionary)
        XCTAssertEqual(seen[1...].map { $0.header("content-range") }, [
            "bytes 0-4194303/\(total)",
            "bytes 4194304-8388607/\(total)",
            "bytes 8388608-8388608/\(total)",
        ])
        XCTAssertTrue(seen[1...].allSatisfy { $0.header("content-type") == "application/octet-stream" })
        XCTAssertEqual(received.items.map(\.count), [4_194_304, 4_194_304, 1])
        XCTAssertEqual(received.items.reduce(Data(), +), data)
        XCTAssertEqual(progress.items, [4_194_304, 8_388_608, Int64(total)])
    }

    func testBigOverwriteUploadGoesChunkedWithOverwriteAtInit() async throws {
        let box = FakeBox()
        let total = 8 * 1024 * 1024 + 1
        let received = Recorder<Data>()
        box.route = { req in
            switch req.path {
            case "/api/uploads/init":
                return .json(200, ["uploadId": "u1", "chunkSize": 4_194_304] as [String: Any])
            case "/api/uploads/u1":
                received.append(req.body)
                let got = received.items.reduce(0) { $0 + $1.count }
                if got < total { return .json(200, ["status": "active", "receivedBytes": got, "totalBytes": total] as [String: Any]) }
                return .json(200, ["status": "ok", "path": "/Apps/X/big.bin", "name": "big.bin"])
            default:
                return nil
            }
        }
        let c = try makeClient(box)
        let entry = try await c.drive.upload("/Apps/X/big.bin", data: Data(count: total), options: UploadOptions(overwrite: true))
        XCTAssertEqual(entry.path, "/Apps/X/big.bin")
        let seen = box.with { $0.seen }
        XCTAssertEqual(seen.map(\.path), ["/api/uploads/init", "/api/uploads/u1", "/api/uploads/u1", "/api/uploads/u1"])
        XCTAssertEqual(seen[0].json["overwrite"] as? Bool, true)
    }

    func testUploadFromAFile() async throws {
        let box = FakeBox()
        box.route = { req in req.path == "/api/drive/upload" ? .json(200, ["status": "ok", "path": "/Apps/X/f.txt", "name": "f.txt"]) : nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("plum-\(UUID().uuidString).txt")
        try Data("from disk".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let c = try makeClient(box)
        let entry = try await c.drive.upload("/Apps/X/f.txt", fileURL: url)
        XCTAssertEqual(entry.size, 9)
        XCTAssertTrue(String(decoding: box.requests("/api/drive/upload")[0].body, as: UTF8.self).contains("\r\n\r\nfrom disk\r\n"))
    }

    func testUploadNeedsAFileName() async throws {
        let c = try makeClient(FakeBox())
        let err = await expectThrows { try await c.drive.upload("/", text: "x") }
        XCTAssertTrue(err is PlumUsageError)
    }

    func testPathHelpersMatchTheTypeScriptOnes() {
        XCTAssertEqual(dirname("/Apps/X/a.md"), "/Apps/X")
        XCTAssertEqual(dirname("/a.md"), "/")
        XCTAssertEqual(dirname("a.md"), "/")
        XCTAssertEqual(dirname("//Apps//"), "/")
        XCTAssertEqual(dirname("/Apps/X/"), "/Apps")
        XCTAssertEqual(basename("/Apps/X/a.md"), "a.md")
        XCTAssertEqual(basename("/Apps/X/"), "X")
        XCTAssertEqual(basename("a.md"), "a.md")
        XCTAssertEqual(basename("/"), "")
    }
}

final class ErrorsAndEnvironmentTests: XCTestCase {
    func testErrorFromResponse() {
        let a = errorFromResponse(status: 401, body: Data(#"{"error":"invalid_token"}"#.utf8))
        XCTAssertTrue(a is PlumAuthError)
        XCTAssertEqual(a.code, "invalid_token")
        XCTAssertEqual(a.message, "invalid_token")
        let f = errorFromResponse(status: 403, body: Data(#"{"error":"forbidden","message":"outside the app folder"}"#.utf8))
        XCTAssertTrue(f is PlumForbiddenError)
        XCTAssertFalse(f is PlumAuthError)
        XCTAssertEqual(f.message, "outside the app folder")
        XCTAssertEqual(f.name, "PlumForbiddenError")
        let p = errorFromResponse(status: 500, body: Data("  boom \n".utf8))
        XCTAssertTrue(type(of: p) == PlumApiError.self)
        XCTAssertNil(p.code)
        XCTAssertEqual(p.message, "boom")
        XCTAssertEqual(errorFromResponse(status: 502, body: Data(String(repeating: "x", count: 900).utf8)).message.count, 500)
    }

    func testEnvironmentValues() throws {
        XCTAssertEqual(PlumEnvironment.production.boxDomain, "plumbox.me")
        XCTAssertEqual(PlumEnvironment.production.portalOrigin, "https://plumbox.me")
        XCTAssertEqual(PlumEnvironment.production.relayUrl, "https://relay.plumbox.me")
        XCTAssertEqual(PlumEnvironment.staging.boxDomain, "staging.plumbox.me")
        XCTAssertEqual(PlumEnvironment.staging.portalOrigin, "https://staging.plumbox.me")
        XCTAssertEqual(PlumEnvironment.staging.relayUrl, "https://relay.staging.plumbox.me")
        XCTAssertEqual(defaultPortalUrl, "https://plumbox.me")
        XCTAssertEqual(try plumEnvironment(), .production)
        XCTAssertEqual(try plumEnvironment(""), .production)
        XCTAssertEqual(try plumEnvironment("STAGING.plumbox.me"), .staging)
        for bad in ["dev.plumbox.me", ".plumbox.me", "plumbox.me.", "example.com", "staging"] {
            XCTAssertThrowsError(try plumEnvironment(bad), bad)
        }
    }

    func testIsForeignUrl() {
        let prod = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me"
        let stag = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me"
        XCTAssertTrue(isForeignUrl(stag, .production))
        XCTAssertTrue(isForeignUrl("https://relay.staging.plumbox.me", .production))
        XCTAssertFalse(isForeignUrl(prod, .production))
        XCTAssertTrue(isForeignUrl(prod, .staging))
        XCTAssertTrue(isForeignUrl("https://plumbox.me", .staging))
        XCTAssertFalse(isForeignUrl(stag, .staging))
        for env in [PlumEnvironment.production, .staging] {
            XCTAssertFalse(isForeignUrl("http://192.168.0.10:8443", env))
            XCTAssertFalse(isForeignUrl("http://127.0.0.1:8080", env))
            XCTAssertFalse(isForeignUrl("https://evilplumbox.me", env))
            XCTAssertFalse(isForeignUrl("not a url", env))
        }
    }

    func testIsPlumIssuerPerEnvironment() {
        let prod = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me"
        let stag = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me"
        XCTAssertTrue(isPlumIssuer(prod))
        XCTAssertFalse(isPlumIssuer(stag))
        XCTAssertTrue(isPlumIssuer(stag, environment: .staging))
        XCTAssertFalse(isPlumIssuer(prod, environment: .staging))
        XCTAssertFalse(isPlumIssuer("https://pb-x-lan.staging.plumbox.me", environment: .staging))
        XCTAssertFalse(isPlumIssuer("https://pb-x-wan.staging.plumbox.me", environment: .staging))
        XCTAssertTrue(isPlumIssuer("https://pb-xlan.staging.plumbox.me", environment: .staging))
        XCTAssertFalse(isPlumIssuer("https://pb-xXstagingYplumboxZme.staging.plumbox.me", environment: .staging))
        XCTAssertFalse(isPlumIssuer("https://pb-x.stagingXplumbox.me", environment: .staging))
        XCTAssertFalse(isPlumIssuer("https://pb-x.staging.plumboxXme", environment: .staging))
    }

    func testStagingCallbackAndExchange() async throws {
        let stag = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me"
        let url = URL(string: "app://cb?code=C&state=S&iss=\(encodeURIComponent(stag))")!
        XCTAssertEqual(parseCallback(url), CallbackResult(state: "S", error: "invalid_iss"))
        XCTAssertEqual(parseCallback(url, environment: .staging), CallbackResult(code: "C", state: "S", iss: stag))
        let err = await expectThrows {
            try await exchangeCode(baseUrl: stag, code: "C", state: "S", expectedState: "S", codeVerifier: "V", clientId: "c", redirectUri: "app://cb")
        }
        XCTAssertEqual((err as? PlumOAuthError)?.code, .invalidIss)
    }

    func testFormEncodingMatchesURLSearchParams() {
        XCTAssertEqual(formEncode("a b+c/d:e?f&g=h~i*j-k.l_m"), "a+b%2Bc%2Fd%3Ae%3Ff%26g%3Dh%7Ei*j-k.l_m")
        XCTAssertEqual(formEncode("한"), "%ED%95%9C")
        XCTAssertEqual(encodeURIComponent("a b/~!*'()"), "a%20b%2F~!*'()")
    }
}
