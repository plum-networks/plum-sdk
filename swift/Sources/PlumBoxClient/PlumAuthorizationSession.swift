#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
import AuthenticationServices
import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#endif

/// Opens the authorization URL in the SYSTEM browser —
/// `ASWebAuthenticationSession`, never a `WKWebView` — and hands back the
/// redirect the box sent to your app.
///
/// An embedded web view would let your own app read what the user types,
/// which defeats the point: the user must see the real `plumbox.me`, and then
/// their own box's `pb-….plumbox.me`, in a browser they trust (RFC 8252
/// §8.12). The session shares cookies with the browser
/// (`prefersEphemeralWebBrowserSession` is false), so a user already signed in
/// to plumbox.me is not asked again.
///
/// ```swift
/// let req = try beginAuthorization(clientId: clientId, redirectUri: "myapp://plum/callback", scopes: [.filesApp])
/// let callbackURL = try await PlumAuthorizationSession().start(req)
/// let cb = parseCallback(callbackURL)
/// ```
///
/// The redirect URI must use a custom scheme registered for your client
/// (`myapp://…`); the session watches for that scheme.
@MainActor
public final class PlumAuthorizationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor?
    private var session: ASWebAuthenticationSession?

    /// - Parameter presentationAnchor: The window the browser sheet belongs
    ///   to. nil: the app's key window.
    public init(presentationAnchor: ASPresentationAnchor? = nil) {
        self.anchor = presentationAnchor
        super.init()
    }

    /// Run the sign-in and return the URL the box redirected to; pass it to
    /// ``parseCallback(_:environment:)-(URL,_)``.
    ///
    /// - Parameters:
    ///   - request: From `beginAuthorization`.
    ///   - callbackURLScheme: The scheme of your redirect URI. nil: read from
    ///     the request's `redirect_uri`.
    /// - Throws: `CancellationError` when the user closed the browser sheet
    ///   (or the calling task was cancelled); ``PlumUsageError`` when the
    ///   redirect URI has no custom scheme; `ASWebAuthenticationSessionError`
    ///   when the session could not start.
    public func start(_ request: AuthorizationRequest, callbackURLScheme: String? = nil) async throws -> URL {
        guard let scheme = callbackURLScheme ?? PlumAuthorizationSession.redirectScheme(of: request.url) else {
            throw PlumUsageError("PlumAuthorizationSession: the redirect URI has no scheme to watch for")
        }
        if scheme == "http" || scheme == "https" {
            throw PlumUsageError(
                "PlumAuthorizationSession: use a custom-scheme redirect URI (myapp://…); an http loopback redirect needs your own listener"
            )
        }
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                // A session that fails to start may also call its handler:
                // whichever comes first answers.
                let once = ResumeOnce(continuation)
                let session = ASWebAuthenticationSession(url: request.url, callbackURLScheme: scheme) { url, error in
                    if let url {
                        once.resume(.success(url))
                    } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        once.resume(.failure(CancellationError()))
                    } else {
                        once.resume(.failure(error ?? CancellationError()))
                    }
                }
                // Share the browser's cookies: the user stays signed in to plumbox.me.
                session.prefersEphemeralWebBrowserSession = false
                session.presentationContextProvider = self
                self.session = session
                if !session.start() {
                    self.session = nil
                    once.resume(.failure(ASWebAuthenticationSessionError(.presentationContextInvalid)))
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    /// Close the browser sheet; a pending ``start(_:callbackURLScheme:)`` throws `CancellationError`.
    public func cancel() {
        session?.cancel()
        session = nil
    }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            if let anchor { return anchor }
            return PlumAuthorizationSession.keyWindow()
        }
    }

    nonisolated static func redirectScheme(of authorizationURL: URL) -> String? {
        guard let query = URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false)?.percentEncodedQuery,
              let redirect = formDecodeQuery(query).first(where: { $0.0 == "redirect_uri" })?.1,
              let scheme = URL(string: redirect)?.scheme, !scheme.isEmpty
        else { return nil }
        return scheme.lowercased()
    }

    private static func keyWindow() -> ASPresentationAnchor {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        #elseif canImport(AppKit)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #endif
    }
}

/// Resumes a continuation at most once, from any thread.
private final class ResumeOnce: @unchecked Sendable {
    // @unchecked: `continuation` is read and cleared only under `lock`.
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL, Error>?

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<URL, Error>) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(with: result)
    }
}
#endif
