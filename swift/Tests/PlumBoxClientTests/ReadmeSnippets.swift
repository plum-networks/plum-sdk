import Foundation
import PlumBoxClient

// The code of swift/README.md, kept here so a change to the API that breaks
// the README breaks the build. Compiled, never run (it would open a browser).

private enum MyError: Error { case signInFailed(String) }

@MainActor private final class Model {
    func showReconnect() {}
}

private func save(_ tokens: OAuthTokens) async throws {}
private func showReconnect() {}

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS))
@MainActor
private func readmeQuickstart(model: Model) async throws {
    let clientId = "com.example.myapp:ios"
    let redirectUri = "myapp://plum/callback"

    let req = try beginAuthorization(
        clientId: clientId,
        redirectUri: redirectUri,
        scopes: [.filesApp]
    )

    let callbackURL = try await PlumAuthorizationSession().start(req)

    let cb = parseCallback(callbackURL)
    guard cb.error == nil, let code = cb.code, let iss = cb.iss else {
        throw MyError.signInFailed(cb.error ?? "no code")
    }

    let tokens = try await exchangeCode(
        baseUrl: iss,
        code: code,
        state: cb.state,
        expectedState: req.state,
        codeVerifier: req.codeVerifier,
        clientId: clientId,
        redirectUri: redirectUri
    )
    let store = KeychainTokenStore(service: "com.example.myapp.plum")
    try await store.save(PlumConnection(iss: iss, clientId: clientId, tokens: tokens))

    guard let saved = try await store.load() else { return }
    let box = try PlumClient(
        connection: saved,
        tokenStore: store,
        onTokens: { _ in },
        onAuthError: { _ in
            Task { @MainActor in model.showReconnect() }
        }
    )
    let root = saved.tokens.appFolder!
    for try await f in box.drive.listAll(root, options: ListOptions(recursive: true, hash: true)) {
        print(f.path, f.hash ?? "(size=\(f.size))")
    }
    try await box.drive.upload("\(root)/note.md", text: "# hello", options: UploadOptions(overwrite: true))

    let box2 = try PlumClient(
        baseUrl: iss,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        appFolder: tokens.appFolder,
        clientId: clientId,
        onTokens: { next in try await save(next) },
        onAuthError: { _ in showReconnect() }
    )
    _ = box2

    let path = "\(root)/a.bin"
    let data = Data()
    do {
        try await box.drive.upload(path, data: data)
    } catch let e as PlumAuthError {
        _ = e
    } catch let e as PlumForbiddenError {
        _ = e
    } catch let e as PlumApiError {
        _ = (e.status, e.code)
    } catch {}

    _ = refreshTokens
    try await box.refresh()
    _ = try plumEnvironment("staging.plumbox.me")
    _ = isPlumIssuer(iss, environment: .staging)
}
#endif
