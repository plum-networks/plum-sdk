# PlumBox client for Android — `im.plum:plumbox-client`

> **Not yet released.** Version `0.1.0` is prepared in this repository but is not published to any Maven repository yet. Until it is, build the AAR from source (`./gradlew :plumbox-client:assembleRelease` in `android/`) or include the `plumbox-client` module in your build.

Client SDK for **Plum Box** on Android: connect a third-party app to the user's box. Works like a cloud SDK, but the storage is the user's own box. It is the Kotlin twin of [`@plumbox/client`](../packages/client/README.md) 0.4.0 — same concepts, same names, same behaviour — so moving between platforms is not confusing.

- Kotlin, coroutines (`suspend` everywhere, `Flow` for listings), minSdk 24
- Small, mainstream dependencies: OkHttp, kotlinx-coroutines, AndroidX Browser (Custom Tabs). JSON is read with the platform's `org.json`; nothing for R8 to keep
- **Third-party apps authenticate with delegated OAuth (PKCE): the user finds their box on plumbox.me and types the password only on that box's own page. Your app only ever receives a scoped, revocable token — never the password.**

## ⚠️ Read this first — never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do **not** collect the user's Plum email + password in your app. Use the delegated flow below. It is the same model as "Sign in with Google":

- In the **system browser** (a Custom Tab), the user enters their email on `https://plumbox.me` and the code Plum mails them, picks their box, and types the password **only** on that box's own page (`https://pb-….plumbox.me`). plumbox.me itself never asks for the password.
- Your app gets back a scoped token it can store and revoke — never the password, never account control (`admin` is refused). With `files:app` it reaches only a folder the box makes for your app.

This SDK has no password login at all (the TypeScript SDK's `login()` is deprecated).

## Install

```kotlin
// build.gradle.kts of your app
dependencies {
    implementation("im.plum:plumbox-client:0.1.0")
}
```

Requirements for your app: `minSdk` 24, `compileSdk` 34 or newer (the AAR's `minCompileSdk`, set by AndroidX Browser 1.8), and Kotlin 2.0 or newer (the library is compiled to Kotlin 2.1 metadata against kotlin-stdlib 2.1.0 — the same floor kotlinx-coroutines 1.10 sets). The AAR declares no minimum Android Gradle Plugin; any AGP that supports `compileSdk` 34 works (8.1.1+ officially). The library adds the `INTERNET` permission.

## Set up the redirect

1. **Register the client** in the [developer console](https://developer.plum.im) (Clients page of your app) — e.g. client id `com.example.notes:android` — with a **custom-scheme** redirect URI such as `com.example.notes://plum/callback`. Boxes refuse `https` redirect URIs, so Android App Links cannot be used; pick a scheme only your app would use (your package name is a good one).

2. **Receive the redirect** in an Activity of yours:

```xml
<!-- AndroidManifest.xml -->
<activity
    android:name=".PlumCallbackActivity"
    android:exported="true"
    android:launchMode="singleTask">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="com.example.notes"
            android:host="plum"
            android:path="/callback" />
    </intent-filter>
</activity>
```

`singleTask` brings the Activity to the front and closes the Custom Tab above it. Handle the intent in both `onCreate` and `onNewIntent` (the Activity may already be running). It can be your main Activity or a small one of its own.

3. **Keep the tokens off backups.** `KeystoreTokenStore` writes `shared_prefs/im.plum.plumbox.client.<name>.xml`. A copy restored on another device cannot be decrypted there (the Keystore key does not travel), but exclude it anyway:

```xml
<!-- res/xml/data_extraction_rules.xml (Android 12+), referenced by android:dataExtractionRules -->
<data-extraction-rules>
    <cloud-backup><exclude domain="sharedpref" path="im.plum.plumbox.client.default.xml" /></cloud-backup>
    <device-transfer><exclude domain="sharedpref" path="im.plum.plumbox.client.default.xml" /></device-transfer>
</data-extraction-rules>
<!-- res/xml/backup_rules.xml (Android 11 and older), referenced by android:fullBackupContent -->
<full-backup-content>
    <exclude domain="sharedpref" path="im.plum.plumbox.client.default.xml" />
</full-backup-content>
```

## Quickstart (third-party app — delegated OAuth)

Two steps, as in `@plumbox/client`: (1) send the user to Plum to authorize; (2) trade the returned code for a token.

```kotlin
import im.plum.plumbox.client.*

const val CLIENT_ID = "com.example.notes:android"            // registered in the Plum developer console
const val REDIRECT_URI = "com.example.notes://plum/callback" // one of the client's registered redirect URIs

// (1) Start authorization. It opens in the SYSTEM BROWSER (a Custom Tab) —
//     never a WebView (see the security note below). Keep verifier + state:
//     your process may be killed while the browser is open.
val req = beginAuthorization(
    clientId = CLIENT_ID,
    redirectUri = REDIRECT_URI,
    scopes = listOf(OAuthScope.FILES_APP),                   // subset of the client's registered scopes; "admin" is never granted
)
getSharedPreferences("plum-signin", MODE_PRIVATE).edit()
    .putString("verifier", req.codeVerifier)
    .putString("state", req.state)
    .commit()
PlumAuthorization.launch(activity, req)                      // user finds their box on plumbox.me, signs in on it & approves
```

```kotlin
// (2) The redirect: com.example.notes://plum/callback?code=…&iss=…&state=…
class PlumCallbackActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        // null: not our redirect. The iss check runs here: a code from anything but a Plum box is dropped.
        val cb = PlumAuthorization.parseCallback(intent, REDIRECT_URI) ?: return
        val code = cb.code
        val iss = cb.iss
        if (cb.error != null || code == null || iss == null) return showError(cb.error ?: "no code")

        val pending = getSharedPreferences("plum-signin", MODE_PRIVATE)
        lifecycleScope.launch {
            val tokens = exchangeCode(
                baseUrl = iss,                                // which box issued the code (the app never knew the address)
                code = code,
                state = cb.state,
                expectedState = pending.getString("state", null).orEmpty(), // the SDK refuses a callback this sign-in did not start
                codeVerifier = pending.getString("verifier", null).orEmpty(), // PKCE: proves this is the same app that started the flow
                clientId = CLIENT_ID,
                redirectUri = REDIRECT_URI,
            )
            pending.edit().clear().commit()
            // Store ALL of `tokens` (accessToken, refreshToken, expiresAt, appFolder, scope)
            // + iss (as baseUrl). The password never touched your app.
            KeystoreTokenStore(applicationContext).save(PlumConnection(iss = iss, clientId = CLIENT_ID, tokens = tokens))
        }
    }
}
```

Then use the box with the stored tokens. The client refreshes the hourly access token by itself and saves every new set in the store:

```kotlin
val box = PlumClient.fromStore(
    KeystoreTokenStore(applicationContext),
    onAuthError = { showReconnect() },                       // the connection is gone (revoked, or 90 days unused)
) ?: return showConnectButton()                              // nothing saved yet

val root = box.appFolder!!                                   // e.g. "/Apps/My App" — a files:app token reaches nothing else
box.drive.listAll(root, recursive = true, hash = true).collect { f ->
    Log.d("plum", "${f.path} ${f.hash ?: "(size=${f.size})"}")
}
box.drive.upload("$root/note.md", "# hello", overwrite = true)
```

`PlumClient.fromStore` is shorthand for the constructor `@plumbox/client` users know, which works the same way:

```kotlin
val box = PlumClient(
    baseUrl = iss,                                           // = cb.iss
    clientId = CLIENT_ID,                                    // needed to refresh
    token = tokens.accessToken,
    refreshToken = tokens.refreshToken,                      // null from older boxes: the token then never expires
    expiresAt = tokens.expiresAt,
    appFolder = tokens.appFolder,
    onTokens = { next -> save(next) },                       // the old refresh token stops working — store the new one
    onAuthError = { showReconnect() },
)
```

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded WebView.** An embedded WebView lets *your own app* read what the user types, which defeats the entire point — the user must see the real `plumbox.me`, and then their own box's `pb-….plumbox.me`, in a browser address bar they trust. (This is RFC 8252 §8.12.) `PlumAuthorization.launch` opens a Custom Tab (the user's own browser); do not load the URL in a `WebView` or intercept it.
2. **Exchange the code only with the box that issued it.** The callback's `iss` is that box's address. `parseCallback` and `exchangeCode` accept only a Plum box's canonical origin — `https://pb-….plumbox.me`, https, no port, no path, not the box's `-lan`/`-wan` alias — and stop with `invalid_iss` otherwise, before the code or the verifier is sent anywhere. Never pass some other `baseUrl` to `exchangeCode`. (`isPlumIssuer` exposes the same check.)
3. **Check `state`.** Pass the `state` `beginAuthorization` gave you as `expectedState`; `exchangeCode` stops with `invalid_state` when the callback's differs. A mismatch means a forged or stale callback.
4. **Request the least scope you need** (`files:read` alone if you never write). Never request `admin` — the box refuses it anyway.
5. **Store the tokens, not the password** (you never had the password). Treat them like a credential (`KeystoreTokenStore` encrypts them with a key in the Android Keystore); let the user revoke them in box settings. Keep the refresh token **on one device**: it rotates on every use, so two devices sharing it (a synced settings file, a backup restored elsewhere) knock each other out — after a 60-second grace, a reused refresh token ends the connection. Exclude the store from backups (above).
6. **Register your client first.** The box consents only to a `client_id` it knows: one you registered in the [developer console](https://developer.plum.im) (Clients page of your app) or declared in your app's `manifest.json` `clients[]`. The consent screen shows the *registered* display name, and the `redirect_uri` and `scope` must match that registration — an unknown client gets `unauthorized_client` before any screen renders.

`parseCallback` accepts an error callback (`?error=access_denied&state=…`) without `iss`, since older boxes send none; when one is present it gets the same check. The `iss` check says "a Plum box", not "the box the user picked" — swapping in another Plum box is stopped by the signed box list on plumbox.me, which sends the user only to the box they chose. Another app could register the same custom scheme as yours; PKCE and `state` make a code it intercepts useless, but choose a scheme only you would use.

`exchangeCode` stops with a `PlumOAuthError` (`code`: `invalid_iss`, `invalid_state`, `invalid_request`) before any request; errors from the box itself come as `PlumApiError`.

### Scopes

| scope | constant | grants |
|---|---|---|
| `files:app` | `OAuthScope.FILES_APP` | read and write **one folder the box makes for your app** (`appFolder`, e.g. `/Apps/My App`) — nothing else of the drive, not the trash |
| `files:read` | `OAuthScope.FILES_READ` | read the user's files |
| `files:write` | `OAuthScope.FILES_WRITE` | change files (implies `files:read`) |
| `user:profile` | `OAuthScope.USER_PROFILE` | the signed-in user's profile only (`auth.me()`) |
| `service:call:<app_id>` | `OAuthScope.serviceCall(appId)` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` (`OAuthScope.READ` / `OAuthScope.WRITE`) are the older spellings and still work (`write` = `files:read` + `files:write`).

**`files:app`** is the least a sync or backup app needs, and what the user is most willing to approve. The token response's `appFolder` is the folder (an absolute drive path; the box creates it before it issues the token). Paths stay absolute drive paths inside it — `/Apps/My App/vault/note.md`. The token may list, download, upload (also chunked), mkdir, rename, move, delete and use versions there; anything else, or any path outside the folder, is `403` (`PlumForbiddenError`). `drive.ensureDir` passes over the parents it may not touch (`/Apps`), so `ensureDir(appFolder + "/vault")` works.

### Token lifetime and refresh

A box issues an **access token that expires after an hour** and a **refresh token** with it (`exchangeCode` → `OAuthTokens`):

- Give `PlumClient` the whole set plus `clientId` and it keeps the access token fresh: it refreshes when less than a minute is left, and when a request comes back `401` it refreshes once and sends that request again. Concurrent requests share one refresh (one in flight at a time, behind a `Mutex`). Request bodies in this SDK are `ByteArray`s, so the retry sends the same bytes; a `401` is answered before the box reads the body, so it is not a duplicate write.
- Every refresh **rotates** the refresh token. The `TokenStore` saves the new set, then `onTokens(tokens)` receives it — both before the request is retried. A refresh is never abandoned halfway: if the coroutine that triggered it is cancelled, the refresh still finishes and the new set is still saved.
- A refresh token lapses after **90 days** unused. When the box refuses one (`invalid_grant`: revoked, lapsed, reused) the connection is gone: requests fail with `PlumAuthError` code `invalid_grant` and `onAuthError` fires — once, however many requests were in flight. A refresh that merely failed to reach the box is a plain `PlumApiError` (status `0`, code `network_error`, or the box's 5xx); the refresh token is still good.
- Refreshes go only to `<iss>/api/oauth/token`, the box the sign-in was checked against: `iss` defaults to `baseUrl`, and must pass `isPlumIssuer` (pass `iss` explicitly if you talk to the box at a LAN address).
- `refreshTokens(iss, clientId, refreshToken)` does one refresh by hand; `client.refresh()` forces one.
- **Older boxes** answer the code exchange with an access token only, which never expires: no `refreshToken`, no `expiresAt`. Use it as before — the client never tries to refresh it.
- `onTokens` and `onAuthError` run on a background thread; switch to the main thread yourself before touching UI.

**401 vs 403.** `401` (`PlumAuthError`) means the credential is no good — after the client could not cure it with a refresh, sign the user in again. `403` (`PlumForbiddenError`) means the credential is fine but may not do *this* (a scope it lacks, a path outside its app folder): it does not fire `onAuthError`, and reconnecting would not help.

## Storing the connection

`TokenStore` is where `PlumClient` keeps the connection: `PlumConnection(iss, clientId, tokens)`. `setToken(tokens)` saves it, every refresh saves the rotated set, `clearToken()` clears it, `loadToken()` reads it back (only for the same box and client id), and `PlumClient.fromStore(store)` rebuilds a client after a restart.

- **`KeystoreTokenStore(context, name = "default")`** — AES-256-GCM with a key in the Android Keystore; ciphertext in private SharedPreferences, written synchronously. Anything it cannot decrypt reads as "no connection". (It does not use `androidx.security:security-crypto`, which is deprecated.)
- **`InMemoryTokenStore`** — for tests, or when you persist in `onTokens` yourself.
- **Your own** — implement `load()`, `save()`, `clear()` (a database row, your app's encrypted settings). Write durably before `save` returns, and keep it on one device.

## Environments

Production (`plumbox.me`) is the default and needs no argument. Plum's own staging environment is chosen with `boxDomain = "staging.plumbox.me"` — on `PlumClient`, `beginAuthorization`, `parseCallback` and `exchangeCode`. Each environment takes only its own boxes: a production client refuses a `*.staging.plumbox.me` box and a staging client refuses a production one (LAN addresses and localhost belong to neither and are accepted). `PlumEnvironment.PRODUCTION`, `PlumEnvironment.STAGING` and `plumEnvironment()` hold the addresses.

## API surface

| Area | Kotlin |
|---|---|
| **Delegated auth** | `beginAuthorization(clientId, redirectUri, scopes, portalUrl?, boxDomain?)` → `AuthorizationRequest(url, codeVerifier, state)`; `parseCallback(url, boxDomain?)` → `CallbackResult(code, state, iss, error)`; `suspend exchangeCode(baseUrl, code, state, expectedState, codeVerifier, clientId, redirectUri, http?, boxDomain?)` → `OAuthTokens`; `isPlumIssuer(iss, boxDomain?)`, `PLUM_ISSUER_PATTERN`, `DEFAULT_PORTAL_URL` |
| **Android** | `PlumAuthorization.launch(context, request, toolbarColor?)` (Custom Tabs); `PlumAuthorization.parseCallback(intent, redirectUri, boxDomain?)`; `KeystoreTokenStore` |
| Tokens | `OAuthTokens(accessToken, tokenType, scope, refreshToken?, expiresAt?, appFolder?)`; `suspend refreshTokens(iss, clientId, refreshToken, http?, boxDomain?)`; `client.refresh()`, `setToken`, `loadToken`, `clearToken`, `tokens`, `hasToken`, `appFolder`; `TokenStore`, `PlumConnection`, `InMemoryTokenStore`, `PlumClient.fromStore` |
| Client | `PlumClient(baseUrl, token?, refreshToken?, expiresAt?, appFolder?, clientId?, iss?, onTokens?, onAuthError?, http?, tokenStore?, boxDomain?, portalOrigin?)`; `client.request(path, method, body, headers, allowStatus)` for endpoints the SDK does not wrap; `auth.me()` |
| Drive | `list` → `ListPage`, `listAll` → `Flow<DriveEntry>` (auto-pagination), `download` → `ByteArray`, `upload` (auto-chunked > 8 MiB through `/api/uploads/*`, `overwrite` option, `onProgress`), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash) |
| Errors | `PlumApiError` (status/code), `PlumAuthError` (401, or a refused refresh `invalid_grant` → `onAuthError`), `PlumForbiddenError` (403: not allowed — no hook), `PlumOAuthError` (a callback the SDK refused before sending anything) |
| Transport | `HttpAdapter` (`suspend fun request(HttpRequest): HttpResponse`), `OkHttpAdapter(client)` — pass your own `OkHttpClient` (pinning, proxy); keep `followRedirects(false)` |

### Where the Kotlin API differs from `@plumbox/client`

- **Named arguments instead of option objects**, `suspend` instead of `Promise`. `beginAuthorization` is a plain function: the JVM's PKCE crypto is synchronous.
- **`listAll` is a `Flow<DriveEntry>`** (an async generator in TypeScript). Listing options are arguments (`recursive = true`), with `ListSort` / `ListOrder` enums for `sort` / `order`.
- **`tokenStore: TokenStore`** replaces the key/value `tokenStorage`: it is typed and also keeps `iss` and `clientId`, which an Android app needs to rebuild the client after its process was killed. The stored token fields keep the TypeScript names.
- **Errors are `Exception`s** with the same names. A request that got no HTTP answer at all is a `PlumApiError` with status `0` and code `network_error` (TypeScript lets the transport's own error through). `PlumOAuthError.code` is a `String` with constants (`PlumOAuthError.INVALID_ISS`, …).
- **`PlumEnvironment` is an enum** (`PlumEnvironment.PRODUCTION.boxDomain`); `isForeignUrl` and `plumEnvironment()` are the same.
- **Request bodies are always `ByteArray`**, so the TypeScript `token_refreshed` case (a body that cannot be sent twice) cannot happen.
- **The default transport does not follow redirects**, so a code or a refresh token cannot be carried anywhere but `<iss>/api/oauth/token`.
- **Not in this SDK:** the deprecated password login (`login`, `verifyTotp`), `discover`, `auth.createToken/listTokens/revokeToken/logout`, `apps.*`, `drive.trash` / `drive.versions`, `callbackFromParams` (Obsidian-specific) and the deprecated `clientName`. `client.request()` reaches any box endpoint.

## Sync-client notes

- `list(…, hash = true)` returns the box-indexed SHA-256 per file; files uploaded before hash indexing omit it — fall back to `size` + `modTime`.
- `upload(…, overwrite = true)` replaces in place and the box snapshots the previous content as a version. Without it, name collisions create `name (2).ext`. A large overwrite goes chunked like any large upload.
- `upload` and `download` hold the whole file in memory, as in `@plumbox/client`; chunked uploads send it in 4 MiB pieces.
- `remove` moves to the box trash (user-recoverable), not a hard delete.

## Building and testing

```bash
cd android
./gradlew :plumbox-client:testDebugUnitTest   # JVM unit tests against a fake box (OkHttp MockWebServer)
./gradlew :plumbox-client:assembleRelease     # build/outputs/aar/plumbox-client-release.aar
```

Everything but `PlumAuthorization` and `KeystoreTokenStore` is plain JVM Kotlin, so the tests need no device or emulator. Android Studio needs `android/local.properties` with `sdk.dir` (not checked in).
