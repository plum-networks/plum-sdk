import Foundation
@testable import PlumBoxClient

/// One request as the fake box saw it.
struct Seen {
    let url: URL
    let method: String
    let headers: [String: String] // lower-cased names
    let body: Data

    var path: String { url.path }
    var pathAndQuery: String { url.absoluteString.replacingOccurrences(of: "\(url.scheme!)://\(url.host!)", with: "") }
    func header(_ name: String) -> String? { headers[name.lowercased()] }
    var query: [String: String] {
        var out: [String: String] = [:]
        for (k, v) in formDecodeQuery(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? "") {
            out[k] = v
        }
        return out
    }
    var json: [String: Any] { ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any]) ?? [:] }
}

struct Reply {
    var status: Int
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body: Data

    static func json(_ status: Int, _ object: Any, headers: [String: String] = [:]) -> Reply {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        var h = ["Content-Type": "application/json"]
        for (k, v) in headers { h[k] = v }
        return Reply(status: status, headers: h, body: data)
    }

    static func text(_ status: Int, _ text: String) -> Reply {
        Reply(status: status, headers: ["Content-Type": "text/plain"], body: Data(text.utf8))
    }
}

/// Holds replies until opened — to line up concurrent requests.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if open {
                lock.unlock()
                c.resume()
            } else {
                waiters.append(c)
                lock.unlock()
            }
        }
    }

    func release() {
        lock.lock()
        open = true
        let w = waiters
        waiters = []
        lock.unlock()
        for c in w { c.resume() }
    }
}

/// A box that follows the contract (the Swift twin of refresh.test.ts's
/// `fakeBox`): one live access token and one live refresh token at a time; a
/// refresh rotates both. Registered under its own host so tests never see one
/// another's traffic.
final class FakeBox: @unchecked Sendable {
    static let clientId = "im.plum.obsidian-sync:obsidian"

    let host: String
    var iss: String { "https://\(host)" }
    private let lock = NSLock()

    // Box state, guarded by `lock` (use `with`).
    var access: String
    var refresh: String
    var n = 1
    var refreshes = 0
    var failRefresh: Reply?
    var tokenGate: Gate?
    var appFolder = true
    var seen: [Seen] = []
    /// Ordered log of what happened: "token", "GET /api/drive/list", "onTokens", ...
    var events: [String] = []
    /// Runs before the box answers (may wait on a gate).
    var hold: (@Sendable (Seen) async -> Void)?
    /// Answers instead of the box when it returns non-nil.
    var route: (@Sendable (Seen) -> Reply?)?
    /// Called after the box answered a token request (to change state behind the client's back).
    var afterToken: (@Sendable (FakeBox) -> Void)?

    /// Extra hosts (a LAN address) that reach this box.
    private var aliases: [String] = []

    init(access: String = "plum_pat_1", refresh: String = "plum_rt_1", name: String? = nil) {
        self.access = access
        self.refresh = refresh
        self.host = "pb-\(name ?? FakeBox.uniqueName()).plumbox.me"
        FakeBox.register(self, host: host)
    }

    deinit {
        FakeBox.unregister(host: host)
        for a in aliases { FakeBox.unregister(host: a) }
    }

    /// Let `host` (e.g. "192.168.0.10") reach this box too.
    func alias(_ host: String) {
        aliases.append(host)
        FakeBox.register(self, host: host)
    }

    func with<T>(_ body: (FakeBox) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(self)
    }

    func log(_ event: String) { with { $0.events.append(event) } }

    var session: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeBoxProtocol.self]
        return URLSession(configuration: config)
    }

    var tokenCalls: [Seen] { with { $0.seen.filter { $0.path == "/api/oauth/token" } } }
    func requests(_ path: String) -> [Seen] { with { $0.seen.filter { $0.path == path } } }

    // MARK: the box

    func handle(_ req: Seen) async -> Reply {
        with {
            $0.seen.append(req)
            $0.events.append(req.path == "/api/oauth/token" ? "token" : "\(req.method) \(req.path)")
        }
        if let hold = with({ $0.hold }) { await hold(req) }
        if let route = with({ $0.route }), let reply = route(req) { return reply }

        if req.path == "/api/oauth/token" {
            let gate = with { b -> Gate? in
                b.refreshes += 1
                return b.tokenGate
            }
            if let gate { await gate.wait() }
            let reply: Reply = with { b in
                if let fail = b.failRefresh { return fail }
                let body = req.json
                guard body["grant_type"] as? String == "refresh_token",
                      body["client_id"] as? String == FakeBox.clientId,
                      body["refresh_token"] as? String == b.refresh
                else { return .json(400, ["error": "invalid_grant"]) }
                b.n += 1
                b.access = "plum_pat_\(b.n)"
                b.refresh = "plum_rt_\(b.n)"
                var out: [String: Any] = [
                    "access_token": b.access,
                    "token_type": "bearer",
                    "expires_in": 3600,
                    "refresh_token": b.refresh,
                    "scope": "files:app",
                ]
                if b.appFolder { out["app_folder"] = "/Apps/Obsidian Sync" }
                return .json(200, out)
            }
            if let after = with({ $0.afterToken }) { after(self) }
            return reply
        }

        let access = with { $0.access }
        guard req.header("authorization") == "Bearer \(access)" else {
            return .json(401, ["error": "invalid_token"], headers: ["WWW-Authenticate": "Bearer error=\"invalid_token\""])
        }
        switch req.path {
        case "/api/drive/list":
            let path = req.query["path"] ?? "/"
            if !path.hasPrefix("/Apps/Obsidian Sync") { return .json(403, ["error": "forbidden"]) }
            return .json(200, ["items": [], "total": 0, "limit": 1000, "offset": 0] as [String: Any])
        case "/api/drive/upload":
            return .json(200, ["status": "ok", "path": "/Apps/Obsidian Sync/a.md", "name": "a.md"])
        case "/api/drive/mkdir":
            let b = req.json
            let parent = b["path"] as? String ?? ""
            let name = b["name"] as? String ?? ""
            let full = "\(parent == "/" ? "" : parent)/\(name)"
            if !full.hasPrefix("/Apps/Obsidian Sync") { return .json(403, ["error": "forbidden"]) }
            if full == "/Apps/Obsidian Sync" { return .json(409, ["error": "exists"]) }
            return .json(200, ["status": "ok"])
        default:
            return .json(200, ["user": ["id": "u1"]])
        }
    }

    // MARK: registry

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var registry: [String: WeakBox] = [:]
    nonisolated(unsafe) private static var counter = 0

    private final class WeakBox { weak var box: FakeBox?; init(_ b: FakeBox) { box = b } }

    static func uniqueName() -> String {
        registryLock.lock()
        defer { registryLock.unlock() }
        counter += 1
        return "t\(counter)x\(UInt32.random(in: 0...UInt32.max))"
    }

    static func register(_ box: FakeBox, host: String) {
        registryLock.lock()
        registry[host] = WeakBox(box)
        registryLock.unlock()
    }

    /// Drop `host` unless another, live box has taken it since.
    static func unregister(host: String) {
        registryLock.lock()
        if registry[host]?.box == nil { registry[host] = nil }
        registryLock.unlock()
    }

    static func lookup(_ host: String) -> FakeBox? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return registry[host]?.box
    }
}

/// Routes every request of a FakeBox session to the box registered for its host.
final class FakeBoxProtocol: URLProtocol, @unchecked Sendable {
    private var work: Task<Void, Never>?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let host = url.host, let box = FakeBox.lookup(host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        var headers: [String: String] = [:]
        for (k, v) in request.allHTTPHeaderFields ?? [:] { headers[k.lowercased()] = v }
        let seen = Seen(url: url, method: request.httpMethod ?? "GET", headers: headers, body: FakeBoxProtocol.body(of: request))
        work = Task { [weak self] in
            let reply = await box.handle(seen)
            guard let self else { return }
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: reply.body)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    /// URLSession hands a URLProtocol the body as a stream, not `httpBody`.
    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: size)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: size)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// Collects callback invocations from any thread.
final class Recorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _items: [T] = []
    var items: [T] { lock.lock(); defer { lock.unlock() }; return _items }
    var count: Int { items.count }
    func append(_ item: T) { lock.lock(); _items.append(item); lock.unlock() }
}

/// Wait (polling) until `condition` holds — vi.waitFor.
func waitFor(_ condition: @escaping () -> Bool, timeout: TimeInterval = 5) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { throw URLError(.timedOut) }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
}

/// Run `body`, expecting it to throw; returns the error.
func expectThrows<T>(_ body: () async throws -> T) async -> Error? {
    do {
        _ = try await body()
        return nil
    } catch {
        return error
    }
}
