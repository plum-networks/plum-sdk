import Foundation

/// What the box's token endpoint hands back, from ``exchangeCode(baseUrl:code:state:expectedState:codeVerifier:clientId:redirectUri:environment:urlSession:)``
/// or ``refreshTokens(iss:clientId:refreshToken:environment:urlSession:)``
/// (and to `PlumClient`'s `onTokens`). Persist all of it.
///
/// A box from before access tokens expired answers with `accessToken` +
/// `scope` only: such a token never expires and has no refresh token — keep
/// using it as it is.
public struct OAuthTokens: Codable, Sendable, Equatable {
    /// The bearer token (`plum_pat_…`).
    public var accessToken: String
    /// Always `"bearer"`.
    public var tokenType: String
    /// The scopes granted, space-separated (may be fewer than requested).
    public var scope: String
    /// Trade it for a new token set with `refreshTokens` (`PlumClient` does it
    /// for you). It ROTATES: every refresh returns a new one and the old one
    /// stops working, so always store the newest. It lapses after 90 days
    /// unused. Absent from older boxes: the access token then never expires.
    public var refreshToken: String?
    /// When the access token expires, on THIS device's clock (computed from
    /// the box's `expires_in` on receipt). nil: no known expiry.
    public var expiresAt: Date?
    /// Present when `files:app` was granted: the absolute drive path the token
    /// may read and write under (e.g. `/Apps/Obsidian Sync`). The box creates
    /// the folder before it issues the token. Paths you send stay absolute
    /// drive paths inside it (`/Apps/Obsidian Sync/MyVault/note.md`).
    public var appFolder: String?

    public init(
        accessToken: String,
        tokenType: String = "bearer",
        scope: String = "",
        refreshToken: String? = nil,
        expiresAt: Date? = nil,
        appFolder: String? = nil
    ) {
        self.accessToken = accessToken
        self.tokenType = tokenType
        self.scope = scope
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.appFolder = appFolder
    }
}

/// A scope a registered companion app may ask the box owner for (OAuth). One
/// vocabulary on every surface — the developer console's client registration,
/// the box's consent screen and the token it mints:
///
/// - ``filesApp`` (`files:app`): read and write ONE folder the box makes for
///   the app (`appFolder`, e.g. `/Apps/Obsidian Sync`) and nothing else — not
///   the rest of the drive, not the trash. The least a sync app needs.
/// - ``filesRead`` (`files:read`): read the user's files
/// - ``filesWrite`` (`files:write`): change files (implies files:read)
/// - ``userProfile`` (`user:profile`): read the signed-in user's profile only
/// - ``serviceCall(_:)`` (`service:call:<app_id>`): call that app's box-side service
///
/// ``read`` / ``write`` are the older spellings and still work (`write` =
/// files:read + files:write). `admin` is never delegated to an app.
///
/// A string literal works too: `["files:app"]`.
public struct OAuthScope: RawRepresentable, Hashable, Sendable, Codable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public static let filesApp: OAuthScope = "files:app"
    public static let filesRead: OAuthScope = "files:read"
    public static let filesWrite: OAuthScope = "files:write"
    public static let userProfile: OAuthScope = "user:profile"
    public static func serviceCall(_ appId: String) -> OAuthScope { OAuthScope(rawValue: "service:call:\(appId)") }
    /// Older spelling of ``filesRead``.
    public static let read: OAuthScope = "read"
    /// Older spelling of ``filesRead`` + ``filesWrite``.
    public static let write: OAuthScope = "write"

    public var description: String { rawValue }
}

/// One entry from `drive.list` / `drive.listAll`.
public struct DriveEntry: Codable, Sendable, Equatable, Hashable {
    public var name: String
    public var path: String
    public var isDir: Bool
    public var size: Int64
    /// RFC 3339 timestamp as reported by the box.
    public var modTime: String
    /// SHA-256 of file content — present only when requested with
    /// `hash: true` AND the file has been indexed by the box (files uploaded
    /// before hash indexing simply omit it; fall back to size + modTime).
    public var hash: String?

    public init(name: String, path: String, isDir: Bool, size: Int64, modTime: String, hash: String? = nil) {
        self.name = name
        self.path = path
        self.isDir = isDir
        self.size = size
        self.modTime = modTime
        self.hash = hash
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        path = try c.decode(String.self, forKey: .path)
        isDir = try c.decodeIfPresent(Bool.self, forKey: .isDir) ?? false
        size = try c.decodeIfPresent(Int64.self, forKey: .size) ?? 0
        modTime = try c.decodeIfPresent(String.self, forKey: .modTime) ?? ""
        let h = try c.decodeIfPresent(String.self, forKey: .hash)
        hash = (h?.isEmpty ?? true) ? nil : h
    }
}

/// One page of `drive.list`.
public struct ListPage: Decodable, Sendable, Equatable {
    public var items: [DriveEntry]
    public var total: Int
    public var limit: Int
    public var offset: Int

    public init(items: [DriveEntry], total: Int, limit: Int, offset: Int) {
        self.items = items
        self.total = total
        self.limit = limit
        self.offset = offset
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Go encodes an empty slice it never allocated as null.
        items = try c.decodeIfPresent([DriveEntry].self, forKey: .items) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? items.count
        limit = try c.decodeIfPresent(Int.self, forKey: .limit) ?? 0
        offset = try c.decodeIfPresent(Int.self, forKey: .offset) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case items, total, limit, offset }
}

/// Options for `drive.list` (and `drive.listAll`, which ignores `limit` and
/// `offset`: it walks every page itself).
public struct ListOptions: Sendable, Equatable {
    public enum Sort: String, Sendable { case name, size, modified, type, path }
    public enum Order: String, Sendable { case asc, desc }

    /// Include every descendant (flat), not just direct children.
    public var recursive: Bool
    /// Include indexed SHA-256 content hashes.
    public var hash: Bool
    /// Server-side filename/path search.
    public var q: String?
    public var limit: Int?
    public var offset: Int?
    public var sort: Sort?
    public var order: Order?

    public init(
        recursive: Bool = false,
        hash: Bool = false,
        q: String? = nil,
        limit: Int? = nil,
        offset: Int? = nil,
        sort: Sort? = nil,
        order: Order? = nil
    ) {
        self.recursive = recursive
        self.hash = hash
        self.q = q
        self.limit = limit
        self.offset = offset
        self.sort = sort
        self.order = order
    }
}

/// Options for `drive.upload`.
public struct UploadOptions: Sendable {
    /// Replace the file at the exact name (previous content is kept as a
    /// version snapshot on the box). Without it, a name collision creates
    /// "name (2).ext" — NOT what a sync client wants.
    public var overwrite: Bool
    public var contentType: String?
    /// Called with (sentBytes, totalBytes) after the upload or each chunk.
    public var onProgress: (@Sendable (_ sentBytes: Int64, _ totalBytes: Int64) -> Void)?

    public init(
        overwrite: Bool = false,
        contentType: String? = nil,
        onProgress: (@Sendable (_ sentBytes: Int64, _ totalBytes: Int64) -> Void)? = nil
    ) {
        self.overwrite = overwrite
        self.contentType = contentType
        self.onProgress = onProgress
    }
}

/// A raw answer from the box, from `PlumClient.request`.
public struct PlumResponse: Sendable {
    public let status: Int
    /// Lower-cased header names.
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    /// The body as UTF-8 text.
    public var text: String { String(decoding: body, as: UTF8.self) }

    /// The body decoded as JSON.
    public func json<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: body)
    }
}
