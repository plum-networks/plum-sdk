# PlumBox client for Swift (`PlumBoxClient`)

> **Not yet released.** The package builds and its tests pass, but no version is tagged yet, so
> there is nothing to pin to. Versioning and tagging are decided later; until then, depend on a
> branch or a commit.

Client SDK for **Plum Box** on Apple platforms: connect a third-party iOS or macOS app to the
user's box. It is the Swift counterpart of [`@plumbox/client`](../packages/client) 0.4.0, with
the same concepts, the same names (Swift-cased) and the same behaviour, so moving between the
two is not confusing.

- iOS 15+ / macOS 12+, Swift 6 (Xcode 16 or newer), no third-party dependencies: Foundation
  (`URLSession`), CryptoKit, Security, AuthenticationServices
- `PlumClient` is an `actor`: one instance can be shared safely across your app
- **Third-party apps authenticate with delegated OAuth (PKCE): the user finds their box on
  plumbox.me and types the password only on that box's own page. Your app only ever receives a
  scoped, revocable token, never the password.**

## ⚠️ Read this first: never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do **not** collect the
user's Plum email and password in your app. Use the delegated flow below. It is the same model
as "Sign in with Google":

- In the **system browser** (`ASWebAuthenticationSession`, which `PlumAuthorizationSession` runs
  for you), the user enters their email on `https://plumbox.me` and the code Plum mails them,
  picks their box, and types the password **only** on that box's own page
  (`https://pb-….plumbox.me`). plumbox.me itself never asks for the password.
- Your app gets back a scoped token it can store and revoke. It never gets the password, and it
  never gets account control (`admin` is refused). With `files:app` it reaches only a folder the
  box makes for your app.

This package has no password `login`. That route is deprecated in `@plumbox/client` and was
never brought to Swift.

## Install

Swift Package Manager. In Xcode: *File → Add Package Dependencies…* →
`https://github.com/plum-networks/plum-sdk`, product **PlumBoxClient**. Or in `Package.swift`:

```swift
dependencies: [
    // Not tagged yet: pin a branch or a revision for now.
    .package(url: "https://github.com/plum-networks/plum-sdk", branch: "main"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "PlumBoxClient", package: "plum-sdk"),
    ]),
]
```

## Quickstart (third-party app, delegated OAuth)

Two steps: (1) send the user to Plum to authorize; (2) trade the returned code for a token.

```swift
import PlumBoxClient

let clientId = "com.example.myapp:ios"     // registered in the Plum developer console (or your manifest's clients[])
let redirectUri = "myapp://plum/callback"  // must be one of the client's registered redirect URIs

// (1) Start authorization. Keep verifier + state until the redirect comes back.
let req = try beginAuthorization(
    clientId: clientId,
    redirectUri: redirectUri,
    scopes: [.filesApp]                    // subset of the client's registered scopes; "admin" is never granted
)

// Open it in the SYSTEM BROWSER, not a WKWebView (see the security notes below).
// The user finds their box on plumbox.me, signs in on it and approves.
let callbackURL = try await PlumAuthorizationSession().start(req)

// (2) The box redirected to myapp://plum/callback?code=…&iss=…&state=…
let cb = parseCallback(callbackURL)        // checks iss: a code from anything but a Plum box is dropped
guard cb.error == nil, let code = cb.code, let iss = cb.iss else {
    throw MyError.signInFailed(cb.error ?? "no code")
}

let tokens = try await exchangeCode(
    baseUrl: iss,                          // which box issued the code (the app never knew the address)
    code: code,
    state: cb.state,
    expectedState: req.state,              // the SDK refuses a callback this sign-in did not start
    codeVerifier: req.codeVerifier,        // PKCE: proves this is the same app that started the flow
    clientId: clientId,
    redirectUri: redirectUri
)
// Store ALL of `tokens` (accessToken, refreshToken, expiresAt, appFolder, scope) plus iss,
// as one Keychain item. The password never touched your app.
let store = KeychainTokenStore(service: "com.example.myapp.plum")
try await store.save(PlumConnection(iss: iss, clientId: clientId, tokens: tokens))
```

Then use the box with the stored tokens. The client refreshes the hourly access token by itself.
Every new set is saved to `tokenStore` and handed to `onTokens` before the request that needed it
goes out again:

```swift
guard let saved = try await store.load() else { return /* not connected yet */ }
let box = try PlumClient(
    connection: saved,                     // baseUrl = iss, clientId, and the whole token set
    tokenStore: store,                     // the old refresh token stops working, so each new set is saved here
    onTokens: { next in /* optional: also told about every new set */ },
    onAuthError: { _ in                    // the connection is gone (revoked, or 90 days unused)
        Task { @MainActor in model.showReconnect() }
    }
)
let root = saved.tokens.appFolder!         // e.g. "/Apps/My App": a files:app token reaches nothing else
for try await f in box.drive.listAll(root, options: ListOptions(recursive: true, hash: true)) {
    print(f.path, f.hash ?? "(size=\(f.size))")
}
try await box.drive.upload("\(root)/note.md", text: "# hello", options: UploadOptions(overwrite: true))
```

The same client can also be built from separate values, as in TypeScript:

```swift
let box = try PlumClient(
    baseUrl: iss,                          // = cb.iss
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,     // absent from older boxes: the token then never expires
    expiresAt: tokens.expiresAt,
    appFolder: tokens.appFolder,
    clientId: clientId,                    // needed to refresh
    onTokens: { next in try await save(next) },
    onAuthError: { _ in showReconnect() }
)
```

`PlumAuthorizationSession` watches for your redirect URI's custom scheme. You do not need to
list that scheme in `CFBundleURLTypes` for this. Pass `presentationAnchor:` when your app has
more than one window. If the user closes the browser sheet, `start` throws `CancellationError`.

### 🔒 Security requirements (do not skip)

These make the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded web view.** An embedded
   `WKWebView` lets *your own app* read what the user types, which defeats the entire point. The
   user must see the real `plumbox.me`, and then their own box's `pb-….plumbox.me`, in a browser
   they trust (RFC 8252 §8.12). `PlumAuthorizationSession` uses `ASWebAuthenticationSession`. It
   shares the browser's cookies (`prefersEphemeralWebBrowserSession` is false), so the user stays
   signed in to plumbox.me.
2. **Exchange the code only with the box that issued it.** The callback's `iss` is that box's
   address. `parseCallback` and `exchangeCode` accept only a Plum box's canonical origin:
   `https://pb-….plumbox.me`, https, no port, no path, and not the box's `-lan`/`-wan` alias.
   Anything else stops with `invalid_iss` before the code or the verifier is sent anywhere. Never
   pass some other `baseUrl` to `exchangeCode`. (`isPlumIssuer` exposes the same check.)
3. **Check `state`.** Pass the `state` `beginAuthorization` gave you as `expectedState`.
   `exchangeCode` stops with `invalid_state` when the callback's differs, because a mismatch means
   a forged or stale callback.
4. **Request the least scope you need** (`.filesRead` alone if you never write). Never request
   `admin`; the box refuses it anyway.
5. **Store the tokens, not the password** (you never had the password). Treat them like a
   credential, and let the user revoke them in box settings. Keep the refresh token **on one
   device**: it rotates on every use, so two devices sharing it (a synced file, a backup restored
   elsewhere) knock each other out. After a 60-second grace, a reused refresh token ends the
   connection. `KeychainTokenStore` writes its item as
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and not synchronizable, so neither backups
   nor iCloud Keychain carry it to another device.
6. **Register your client first.** The box consents only to a `client_id` it knows: one you
   registered in the [developer console](https://developer.plum.im) (Clients page of your app),
   or declared in your app's `manifest.json` `clients[]`. The consent screen shows the
   *registered* display name, and the `redirect_uri` and `scope` must match that registration.
   An unknown client gets `unauthorized_client` before any screen renders. On iOS, register a
   custom-scheme redirect (`myapp://…`); the box refuses `https` redirects.

`parseCallback` accepts an error callback (`?error=access_denied&state=…`) without `iss`, since
older boxes send none. When one is present, it gets the same check. The `iss` check says "a Plum
box", not "the box the user picked". Swapping in another Plum box is stopped by the signed box
list on plumbox.me, which sends the user only to the box they chose.

`exchangeCode` stops with a `PlumOAuthError` (`code`: `.invalidIss`, `.invalidState`,
`.invalidRequest`, whose raw values are `invalid_iss`, `invalid_state` and `invalid_request`)
before any request. Errors from the box itself come as `PlumApiError`.

### Scopes

| scope | Swift | grants |
|---|---|---|
| `files:app` | `.filesApp` | read and write **one folder the box makes for your app** (`appFolder`, e.g. `/Apps/My App`). Nothing else of the drive, and not the trash |
| `files:read` | `.filesRead` | read the user's files |
| `files:write` | `.filesWrite` | change files (implies `files:read`) |
| `user:profile` | `.userProfile` | the signed-in user's profile only (`GET /api/auth/me`) |
| `service:call:<app_id>` | `.serviceCall("<app_id>")` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` (`.read`, `.write`) are the older spellings and still work (`write` =
`files:read` + `files:write`). A string literal works too: `scopes: ["files:app"]`.

**`files:app`** is the least a sync or backup app needs, and the scope users are most willing to
approve. The token response's `appFolder` is the folder: an absolute drive path, which the box
creates before it issues the token. Paths stay absolute drive paths inside it, such as
`/Apps/My App/vault/note.md`. The token may list, download, view, archive, upload (also
chunked), mkdir, rename, move, save, delete and use versions there. Anything else, or any path
outside the folder, is `403` (`PlumForbiddenError`). `drive.ensureDir` passes over the parents it
may not touch (`/Apps`), so `ensureDir(appFolder + "/vault")` works.

### Token lifetime and refresh

A box issues an **access token that expires after an hour** and a **refresh token** with it
(`exchangeCode` → `OAuthTokens`):

- Give `PlumClient` the whole set plus `clientId`, and it keeps the access token fresh. It
  refreshes when less than a minute is left. When a request comes back `401`, it refreshes once
  and sends that request again. Concurrent requests share one refresh. Request bodies are `Data`,
  so the retry sends the same bytes. A `401` is answered before the box reads the body, so the
  retry is not a duplicate write.
- Every refresh **rotates** the refresh token. The new set is saved to `tokenStore` and then
  passed to `onTokens(tokens)`, both before the request is retried. Persist it in one of the two.
  A throw from `onTokens` is ignored, because the client already uses the new tokens.
- A refresh token lapses after **90 days** unused. When the box refuses one (`invalid_grant`:
  revoked, lapsed or reused), the connection is gone. Requests fail with `PlumAuthError` code
  `invalid_grant`, and `onAuthError` fires once, however many requests were in flight. A refresh
  that merely failed to reach the box is a plain `PlumApiError` (or a `URLError`), and the
  refresh token is still good.
- Refreshes go only to `<iss>/api/oauth/token`, the box the sign-in was checked against. `iss`
  defaults to `baseUrl` and must pass `isPlumIssuer`. Pass `iss:` explicitly if you talk to the
  box at a LAN address.
- `refreshTokens(iss:clientId:refreshToken:)` does one refresh by hand. `try await box.refresh()`
  forces one.
- **Older boxes** answer the code exchange with an access token only, which never expires: no
  `refreshToken`, no `expiresAt`. Use it as before; the client never tries to refresh it.

**401 vs 403.** `401` (`PlumAuthError`) means the credential is no good, after the client could
not cure it with a refresh, so sign the user in again. `403` (`PlumForbiddenError`) means the
credential is fine but may not do *this* (a scope it lacks, or a path outside its app folder). It
does not fire `onAuthError`, and reconnecting would not help. Both are subclasses of
`PlumApiError`:

```swift
do {
    try await box.drive.upload(path, data: data)
} catch let e as PlumAuthError {        // 401 or invalid_grant: reconnect
} catch let e as PlumForbiddenError {   // 403: not allowed, credential fine
} catch let e as PlumApiError {         // anything else the box said (e.status, e.code)
} catch {                               // URLError: the box could not be reached
}
```

## Environments

Production (`plumbox.me`) is the default and needs no option. Plum's own staging environment is
chosen with `environment: .staging`, on `PlumClient`, `beginAuthorization`, `parseCallback`,
`exchangeCode`, `refreshTokens` and `isPlumIssuer`. Each environment takes only its own boxes: a
production client refuses a `*.staging.plumbox.me` box, and a staging client refuses a
production one. LAN addresses and localhost belong to neither and are accepted.
`PlumEnvironment.production`, `.staging` and `plumEnvironment("staging.plumbox.me")` hold the
addresses. There is no third environment.

## API surface

| Area | Swift |
|---|---|
| **Delegated auth** | `beginAuthorization(clientId:redirectUri:scopes:portalUrl:environment:)` → `AuthorizationRequest {url, codeVerifier, state}`; `parseCallback(_:environment:)` → `CallbackResult {code, state, iss, error}`; `exchangeCode(baseUrl:code:state:expectedState:codeVerifier:clientId:redirectUri:environment:urlSession:)` → `OAuthTokens`; `isPlumIssuer(_:environment:)` |
| System browser | `PlumAuthorizationSession(presentationAnchor:)`, `.start(_:callbackURLScheme:)` → callback `URL`, `.cancel()` |
| Tokens | `refreshTokens(iss:clientId:refreshToken:environment:urlSession:)`; `PlumClient.refresh()`, `setToken(_:)`, `loadToken()`, `clearToken()`, `hasToken`, `appFolder`; `OAuthTokens {accessToken, tokenType, scope, refreshToken?, expiresAt?, appFolder?}` |
| Storage | `TokenStore` protocol (`load`/`save`/`delete` of a `PlumConnection {iss, clientId, tokens}`); `KeychainTokenStore(service:account:accessGroup:)`; `MemoryTokenStore` |
| Client | `PlumClient(baseUrl:token:refreshToken:expiresAt:appFolder:clientId:iss:environment:portalOrigin:tokenStore:urlSession:onTokens:onAuthError:)`, `PlumClient(baseUrl:tokens:…)`, `PlumClient(connection:…)`; `request(_:method:body:headers:allowStatus:)` and `request(_:method:json:…)` for routes without a method |
| Drive | `drive.list`, `drive.listAll` (an `AsyncSequence` that walks the pages as you iterate), `download`, `upload(_:data:)` / `upload(_:text:)` / `upload(_:fileURL:)` (chunked through `/api/uploads/*` above 8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename(_:newName:)`, `move(_:newPath:)`, `remove` (→ trash), `appFolder` |
| Errors | `PlumApiError` (`status`, `code`, `message`), `PlumAuthError` (401, or a refused refresh `invalid_grant` → `onAuthError`), `PlumForbiddenError` (403: not allowed, no hook), `PlumOAuthError` (a callback the SDK refused before sending anything), `PlumUsageError` (the options cannot work, e.g. a refresh token without `clientId`) |

## Where Swift differs from `@plumbox/client`

Same flow, same checks and the same wire format. Where Swift does things differently:

- **Options are labelled arguments**, not an options object: `exchangeCode(baseUrl:code:…)`,
  `PlumClient(baseUrl:token:…)`.
- **`beginAuthorization` is synchronous** (`try`, no `await`). Apple's random and SHA-256 calls
  are not async.
- **`environment: PlumEnvironment`** takes the place of the `boxDomain` string option, so an
  unknown domain cannot be passed, and `isPlumIssuer` does not throw.
  `PlumEnvironment(boxDomain:)` / `plumEnvironment(_:)` read a string when you have one.
- **`expiresAt` is a `Date`.** It is stored as milliseconds since the epoch, the same number as
  TypeScript.
- **`url` is a `URL`** in `AuthorizationRequest`, and `parseCallback` takes a `URL` (or a string,
  which throws when it is malformed).
- **Token storage holds the whole connection.** `tokenStorage` (a key/value string store) is
  replaced by `TokenStore`, which saves `{iss, clientId, tokens}` as one item. `loadToken()`
  adopts a saved connection only when its `iss` and `clientId` are this client's.
- **The transport is a `URLSession`** (`urlSession:`), in place of the `http` adapter.
- **`listAll` is an `AsyncSequence`** (`for try await`), the Swift form of the async generator.
- **Bodies are always `Data`**, so the `token_refreshed` error for a body that cannot be sent
  twice never arises.
- **Wrong options throw `PlumUsageError`**, where TypeScript throws a plain `Error`.
- **Not ported:** the deprecated `login`/`verifyTotp`, `discover`, `auth.createToken` & co.,
  `apps.*`, `drive.trash` and `drive.versions`, `callbackFromParams` (Obsidian only), and the
  deprecated `clientName`. Use `request(_:…)` for any box route without a method.

## Development

From the repository root (the manifest is `Package.swift` there; the sources are under `swift/`):

```bash
swift test                                                                        # macOS: the fake-box test suite
xcodebuild -scheme plum-sdk -destination 'generic/platform=iOS Simulator' build   # the iOS build, Apple glue included
```

The tests run against a fake box behind a `URLProtocol`. They cover PKCE, the `iss`/`state`
refusals (nothing is sent), the code exchange with new and old boxes, early refresh, 401 →
refresh → retry, concurrent requests sharing one refresh, rotation and the `onTokens` order,
`invalid_grant` and `onAuthError` firing once, 403, `ensureDir` with a `files:app` token, and the
chunked upload. They mirror `packages/client/test/oauth.test.ts` and `refresh.test.ts`.
