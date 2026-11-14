import Foundation

/// Thrown for any non-2xx API response (`@plumbox/client`: `PlumApiError`).
///
/// A class so the hierarchy reads as in TypeScript: ``PlumAuthError`` and
/// ``PlumForbiddenError`` ARE `PlumApiError`s, so `catch let e as PlumApiError`
/// sees them too, and `catch let e as PlumAuthError` sees only the 401s and
/// refused refreshes.
public class PlumApiError: Error, LocalizedError, CustomStringConvertible, @unchecked Sendable {
    // @unchecked: every stored property is an immutable `let` of a Sendable
    // type; the class is not open, so no subclass outside this module adds state.

    /// The HTTP status.
    public let status: Int
    /// Machine-readable code when the box provided one (e.g. "invalid_grant",
    /// "version_mismatch").
    public let code: String?
    public let message: String

    public init(status: Int, message: String, code: String? = nil) {
        self.status = status
        self.message = message
        self.code = code
    }

    /// The class name as `@plumbox/client` reports it in `err.name`.
    public var name: String { "PlumApiError" }

    public var errorDescription: String? { message }

    public var description: String {
        "\(name)(status: \(status)\(code.map { ", code: \($0)" } ?? ""), message: \(message))"
    }
}

/// The credential itself is no good: a 401 (missing, expired or revoked
/// token), or a refresh the box refused with `invalid_grant` (status 400,
/// `code` `"invalid_grant"`: the connection is gone and the user has to connect
/// again). Triggers `onAuthError`.
///
/// A 403 is NOT one of these — see ``PlumForbiddenError``.
public final class PlumAuthError: PlumApiError, @unchecked Sendable {
    public override var name: String { "PlumAuthError" }
}

/// 403: the credential is fine, but it may not do this — a scope it was not
/// granted, or (a `files:app` token) a path outside its app folder. Signing in
/// again would not change the answer, so it does NOT trigger `onAuthError`.
public final class PlumForbiddenError: PlumApiError, @unchecked Sendable {
    public override var name: String { "PlumForbiddenError" }
}

/// A sign-in the SDK stopped on its own, before anything was sent: the
/// redirect back from the box did not hold up. ``code`` says why:
///
/// - `invalid_iss`: the callback named no box, or something that is not a Plum
///   box's own address (`https://pb-….plumbox.me`). The authorization code is
///   never sent anywhere.
/// - `invalid_state`: the callback's `state` is not the one this sign-in began
///   with (a forged or stale redirect).
/// - `invalid_request`: no code and no error, or a required value is missing.
public struct PlumOAuthError: Error, LocalizedError, Equatable, Sendable, CustomStringConvertible {
    public enum Code: String, Sendable, Hashable {
        case invalidIss = "invalid_iss"
        case invalidState = "invalid_state"
        case invalidRequest = "invalid_request"
    }

    public let code: Code
    public let message: String

    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
    public var description: String { "PlumOAuthError(\(code.rawValue)): \(message)" }
}

/// A call the SDK cannot make as asked: a required option is missing or the
/// options contradict each other (no `clientId` with a refresh token, an
/// unknown box domain, a `baseUrl` of another environment…). A programming
/// error, not something the box said. (`@plumbox/client` throws a plain
/// `Error` in these places.)
public struct PlumUsageError: Error, LocalizedError, Equatable, Sendable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
    public var description: String { "PlumUsageError: \(message)" }
}

/// Parse the box's error body (`{"error","message"}` JSON or plain text).
func errorFromResponse(status: Int, body: Data) -> PlumApiError {
    let text = String(decoding: body, as: UTF8.self)
    var message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    var code: String?
    if let obj = (try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])) as? [String: Any] {
        let msg = obj["message"] as? String
        let err = obj["error"] as? String
        if (msg?.isEmpty == false) || (err?.isEmpty == false) {
            message = msg ?? err ?? message
            code = err
        }
    }
    if message.count > 500 { message = String(message.prefix(500)) }
    switch status {
    case 401: return PlumAuthError(status: status, message: message, code: code)
    case 403: return PlumForbiddenError(status: status, message: message, code: code)
    default: return PlumApiError(status: status, message: message, code: code)
    }
}
