#if canImport(Security)
import Foundation
import Security

/// A ``TokenStore`` in the Keychain: the whole connection — token set, `iss`
/// and `clientId` — as ONE generic-password item (JSON), so the parts can
/// never get out of step.
///
/// The item is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable
/// for a background refresh once the device was unlocked after boot, and
/// never carried to another device by a backup or iCloud Keychain — a
/// refresh token belongs on one device (it rotates on every use, and two
/// devices sharing it knock each other out).
///
/// ```swift
/// let store = KeychainTokenStore(service: "com.example.notes.plum")
/// try await store.save(PlumConnection(iss: iss, clientId: clientId, tokens: tokens))
/// if let saved = try await store.load() {
///     let box = try PlumClient(connection: saved, tokenStore: store)
/// }
/// ```
public struct KeychainTokenStore: TokenStore {
    /// `kSecAttrService`: your app's own name for the item (e.g. its bundle id + ".plum").
    public let service: String
    /// `kSecAttrAccount`: one item per account value — one per box, if your
    /// app connects to more than one.
    public let account: String
    /// `kSecAttrAccessGroup`, to share the item with your app extensions.
    /// nil: the app's default group.
    public let accessGroup: String?

    public init(service: String, account: String = "plumbox.connection", accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    public func load() async throws -> PlumConnection? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status, operation: "read") }
        guard let data = out as? Data else { return nil }
        return try PlumConnection.decoded(from: data)
    }

    public func save(_ connection: PlumConnection) async throws {
        let data = try connection.encoded()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status, operation: "update") }
        var add = baseQuery()
        for (k, v) in attributes { add[k] = v }
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added, operation: "add") }
    }

    public func delete() async throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status, operation: "delete")
        }
    }

    private func baseQuery() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }
}

/// A Keychain call failed (`OSStatus`).
public struct KeychainError: Error, LocalizedError, Equatable, Sendable {
    public let status: OSStatus
    public let operation: String

    public var errorDescription: String? {
        let text = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Keychain \(operation) failed: \(text)"
    }
}
#endif
