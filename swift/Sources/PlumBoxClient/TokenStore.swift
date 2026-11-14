import Foundation

/// Everything an app keeps about its connection to one box, saved as ONE item:
/// the box (`iss`), the client the tokens were issued to, and the whole token
/// set. Rebuild a client from it with ``PlumClient/init(connection:tokenStore:urlSession:environment:onTokens:onAuthError:)``.
public struct PlumConnection: Codable, Sendable, Equatable {
    /// The box's canonical address — the callback's checked `iss`.
    public var iss: String
    /// The client id the tokens were issued to.
    public var clientId: String
    public var tokens: OAuthTokens

    public init(iss: String, clientId: String, tokens: OAuthTokens) {
        self.iss = iss
        self.clientId = clientId
        self.tokens = tokens
    }

    /// The JSON the stores in this package write: `expiresAt` in milliseconds
    /// since the epoch, the same number `@plumbox/client` stores.
    public func encoded() throws -> Data {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .millisecondsSince1970
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    /// Read what ``encoded()`` wrote.
    public static func decoded(from data: Data) throws -> PlumConnection {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .millisecondsSince1970
        return try dec.decode(PlumConnection.self, from: data)
    }
}

/// Where a ``PlumClient`` keeps its connection (`@plumbox/client`:
/// `tokenStorage`). The client saves the whole set on `setToken` and after
/// every refresh — before `onTokens` and before the request that needed the
/// refresh is sent again — and deletes it on `clearToken`.
///
/// ``KeychainTokenStore`` is the one to use on Apple platforms. Plug your own
/// (an app-group container, your sync engine's database…) by conforming to
/// this protocol. Keep it on one device: the refresh token rotates on every
/// use, so a copy restored or synced to a second device knocks the first one
/// out.
public protocol TokenStore: Sendable {
    /// The saved connection, or nil when there is none.
    func load() async throws -> PlumConnection?
    /// Replace the saved connection.
    func save(_ connection: PlumConnection) async throws
    /// Forget the saved connection. Not an error when there is none.
    func delete() async throws
}

/// A ``TokenStore`` that keeps the connection in memory only — for tests,
/// previews, and apps that persist through `onTokens` themselves.
public actor MemoryTokenStore: TokenStore {
    public private(set) var connection: PlumConnection?

    public init(_ connection: PlumConnection? = nil) {
        self.connection = connection
    }

    public func load() async throws -> PlumConnection? { connection }
    public func save(_ connection: PlumConnection) async throws { self.connection = connection }
    public func delete() async throws { connection = nil }
}
