import Foundation

/// Files above this size go through the resumable chunked-upload protocol.
let chunkedThreshold = 8 * 1024 * 1024
let chunkSize = 4 * 1024 * 1024
/// The box's maxListLimit.
let pageSize = 1000

func dirname(_ path: String) -> String {
    var p = Substring(path)
    while p.hasPrefix("/") { p = p.dropFirst() }
    while p.hasSuffix("/") { p = p.dropLast() }
    let norm = "/" + p
    guard let idx = norm.lastIndex(of: "/"), idx > norm.startIndex else { return "/" }
    return String(norm[..<idx])
}

func basename(_ path: String) -> String {
    var p = Substring(path)
    while p.hasSuffix("/") { p = p.dropLast() }
    guard let idx = p.lastIndex(of: "/") else { return String(p) }
    return String(p[p.index(after: idx)...])
}

/// The box's Drive (`@plumbox/client`: `client.drive`). Paths are absolute
/// drive paths (`/Apps/My App/vault/note.md`); a `files:app` token reaches only
/// its ``PlumClient/appFolder`` and gets ``PlumForbiddenError`` elsewhere.
public struct DriveApi: Sendable {
    let client: PlumClient

    /// List one page. Pass `limit`/`offset` for pagination; see ``listAll(_:options:)``
    /// for iteration.
    public func list(_ path: String, options: ListOptions = ListOptions()) async throws -> ListPage {
        var params: [(String, String)] = [("path", path.isEmpty ? "/" : path)]
        if options.recursive { params.append(("recursive", "1")) }
        if options.hash { params.append(("hash", "1")) }
        if let q = options.q, !q.isEmpty { params.append(("q", q)) }
        if let sort = options.sort { params.append(("sort", sort.rawValue)) }
        if let order = options.order { params.append(("order", order.rawValue)) }
        // Always paginate so the response shape is stable ({items,total,...}).
        params.append(("limit", String(options.limit ?? pageSize)))
        params.append(("offset", String(options.offset ?? 0)))
        let res = try await client.request("/api/drive/list?\(formQuery(params))")
        return try res.json(ListPage.self)
    }

    /// Every entry under `path`, walking the pages as you iterate:
    ///
    /// ```swift
    /// for try await f in box.drive.listAll(root, options: ListOptions(recursive: true, hash: true)) { … }
    /// ```
    ///
    /// `limit` and `offset` in `options` are ignored.
    public func listAll(_ path: String, options: ListOptions = ListOptions()) -> DriveListing {
        DriveListing(drive: self, path: path, options: options)
    }

    /// The file's bytes.
    public func download(_ path: String) async throws -> Data {
        let res = try await client.request("/api/drive/download?\(formQuery([("path", path)]))")
        return res.body
    }

    /// Upload `data` as the file at `path` (full drive path including the
    /// file name). Small files go as one multipart POST; larger ones (over
    /// 8 MiB) use the resumable chunked protocol automatically. With
    /// `overwrite: true` the file is replaced in place (previous content
    /// becomes a version snapshot) — without it a name collision creates
    /// "name (2).ext".
    @discardableResult
    public func upload(_ path: String, data: Data, options: UploadOptions = UploadOptions()) async throws -> DriveEntry {
        let dir = dirname(path)
        let name = basename(path)
        if name.isEmpty { throw PlumUsageError("upload path must include a filename") }

        // Large files go chunked, overwrite or not: the chunked protocol has
        // carried `overwrite` since box core 1.7.7, and one multi-hundred-MB
        // POST is what a flaky phone connection loses.
        if data.count > chunkedThreshold {
            return try await uploadChunked(dir: dir, name: name, data: data, options: options)
        }
        var fields: [(String, String)] = [("path", dir)]
        if options.overwrite { fields.append(("overwrite", "1")) }
        let (body, contentType) = buildMultipart(
            fields: fields, fileField: "file", fileName: name, data: data, contentType: options.contentType
        )
        let res = try await client.request(
            "/api/drive/upload", method: "POST", body: body, headers: ["Content-Type": contentType]
        )
        options.onProgress?(Int64(data.count), Int64(data.count))
        struct Placed: Decodable { let path: String; let name: String }
        let out = try res.json(Placed.self)
        return DriveEntry(name: out.name, path: out.path, isDir: false, size: Int64(data.count), modTime: isoNow())
    }

    /// ``upload(_:data:options:)`` with UTF-8 text.
    @discardableResult
    public func upload(_ path: String, text: String, options: UploadOptions = UploadOptions()) async throws -> DriveEntry {
        try await upload(path, data: Data(text.utf8), options: options)
    }

    /// ``upload(_:data:options:)`` with a local file. The file is memory-mapped,
    /// not read into memory up front; a big one goes up chunk by chunk.
    @discardableResult
    public func upload(_ path: String, fileURL: URL, options: UploadOptions = UploadOptions()) async throws -> DriveEntry {
        let data = try Data(contentsOf: fileURL, options: .alwaysMapped)
        return try await upload(path, data: data, options: options)
    }

    private func uploadChunked(dir: String, name: String, data: Data, options: UploadOptions) async throws -> DriveEntry {
        struct Init: Encodable, Sendable {
            let target = "drive"
            let path: String
            let filename: String
            let size: Int
            let contentType: String
            let overwrite: Bool?
        }
        let initRes = try await client.request(
            "/api/uploads/init",
            method: "POST",
            json: Init(
                path: dir, filename: name, size: data.count,
                contentType: options.contentType ?? "application/octet-stream",
                overwrite: options.overwrite ? true : nil
            )
        )
        struct Started: Decodable { let uploadId: String }
        let uploadId = try initRes.json(Started.self).uploadId

        let total = data.count
        var sent = 0
        var finalBody: Data?
        while sent < total {
            let end = min(sent + chunkSize, total)
            let chunk = data.subdata(in: (data.startIndex + sent)..<(data.startIndex + end))
            let res = try await client.request(
                "/api/uploads/\(encodeURIComponent(uploadId))",
                method: "PATCH",
                body: chunk,
                headers: [
                    "Content-Type": "application/octet-stream",
                    "Content-Range": "bytes \(sent)-\(end - 1)/\(total)",
                ]
            )
            sent = end
            options.onProgress?(Int64(sent), Int64(total))
            if sent >= total { finalBody = res.body }
        }
        struct Placed: Decodable { let path: String?; let name: String? }
        let placed = finalBody.flatMap { try? JSONDecoder().decode(Placed.self, from: $0) }
        return DriveEntry(
            name: placed?.name ?? name,
            path: placed?.path ?? "\(dir == "/" ? "" : dir)/\(name)",
            isDir: false,
            size: Int64(total),
            modTime: isoNow()
        )
    }

    /// Create one directory. The parent must exist — see ``ensureDir(_:)`` for mkdir -p.
    public func mkdir(_ path: String) async throws {
        struct Body: Encodable, Sendable { let path: String; let name: String }
        _ = try await client.request("/api/drive/mkdir", method: "POST", json: Body(path: dirname(path), name: basename(path)))
    }

    /// mkdir -p: create every missing segment of `path`.
    ///
    /// A parent the token may not touch is passed over: a `files:app` token
    /// gets 403 on `/Apps` itself, yet may create folders inside its app folder
    /// (which the box made when it issued the token). A 403 on the last
    /// segment, or on a parent that really is missing, still surfaces.
    public func ensureDir(_ path: String) async throws {
        let segments = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        var current = ""
        for (i, segment) in segments.enumerated() {
            current += "/" + segment
            do {
                try await mkdir(current)
            } catch let err as PlumApiError {
                // Already-exists is fine; surface anything else.
                if err.status == 409 || err.status == 500 { continue }
                if err.status == 403, i < segments.count - 1 { continue }
                throw err
            }
        }
    }

    /// Rename within the same directory. For cross-directory moves use ``move(_:newPath:)``.
    public func rename(_ path: String, newName: String) async throws {
        struct Body: Encodable, Sendable { let path: String; let name: String }
        _ = try await client.request("/api/drive/rename", method: "POST", json: Body(path: path, name: newName))
    }

    /// Move a file or directory to an arbitrary path (the destination parent must exist).
    public func move(_ path: String, newPath: String) async throws {
        struct Body: Encodable, Sendable { let path: String; let newPath: String }
        _ = try await client.request("/api/drive/move", method: "POST", json: Body(path: path, newPath: newPath))
    }

    /// Delete — moves to the box trash (recoverable from the Drive UI), not a
    /// hard delete.
    public func remove(_ path: String) async throws {
        _ = try await client.request("/api/drive/delete?\(formQuery([("path", path)]))", method: "DELETE")
    }

    /// The folder a `files:app` token may use, when known (``PlumClient/appFolder``).
    public var appFolder: String? {
        get async { await client.appFolder }
    }
}

/// The pages of `drive.listAll`, fetched as you iterate (`@plumbox/client`:
/// the `listAll` async generator).
public struct DriveListing: AsyncSequence, Sendable {
    public typealias Element = DriveEntry

    let drive: DriveApi
    let path: String
    let options: ListOptions

    public func makeAsyncIterator() -> Iterator {
        Iterator(drive: drive, path: path, options: options)
    }

    public struct Iterator: AsyncIteratorProtocol {
        let drive: DriveApi
        let path: String
        let options: ListOptions
        var buffer: [DriveEntry] = []
        var index = 0
        var offset = 0
        var done = false

        public mutating func next() async throws -> DriveEntry? {
            while index >= buffer.count {
                if done { return nil }
                var opts = options
                opts.limit = pageSize
                opts.offset = offset
                let page = try await drive.list(path, options: opts)
                buffer = page.items
                index = 0
                offset += page.items.count
                if page.items.isEmpty || offset >= page.total { done = true }
            }
            defer { index += 1 }
            return buffer[index]
        }
    }

    /// Every entry, collected into an array.
    public func collect() async throws -> [DriveEntry] {
        var out: [DriveEntry] = []
        for try await e in self { out.append(e) }
        return out
    }
}
