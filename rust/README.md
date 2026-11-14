# plumbox-client (Rust)

> **Not yet released.** This crate is not on crates.io yet. Depend on it from
> git (below); the API may still change before 0.1.0 is published.

The Rust SDK for **third-party apps that connect to a user's Plum Box**. It is
the counterpart of the web/Node SDK [`@plumbox/client`](../packages/client)
0.4.0 — the same concepts, the same names (in snake_case), the same behaviour
— for apps whose shared core is Rust, with native shells (SwiftUI, Compose)
on top.

- **Delegated OAuth (Authorization Code + PKCE).** The user finds their box on
  plumbox.me and types the password only on that box's own page, in the system
  browser. Your app gets a scoped, revocable token — never the password.
- **Tokens that keep themselves fresh.** `PlumClient` refreshes the hourly
  access token, shares one refresh among all requests, and hands every rotated
  set to you to persist.
- **The box's Drive**, including big files: chunked uploads and ranged
  downloads that resume.
- Async (tokio), `reqwest` with rustls — no OpenSSL. No UI.
- MIT.

## Add it to `Cargo.toml`

```toml
[dependencies]
plumbox-client = { git = "https://github.com/plum-networks/plum-sdk", rev = "<commit>" }
```

The crate lives in the `rust/` folder of the `plum-sdk` repository, next to the
TypeScript packages. A git dependency has no `path` key (Cargo does not combine
`git` with `path`): Cargo clones the repository and finds the package named
`plumbox-client` wherever its `Cargo.toml` is in the tree, so the line above is
all it takes. Pin a `rev` (or a `tag` once there are releases) so a push to
`main` never changes your build. To work against a local checkout instead:

```toml
plumbox-client = { path = "../plum-sdk/rust" }
```

Once it is on crates.io this becomes `plumbox-client = "0.1"`.

### Features and TLS

| feature | default | what it does |
|---|---|---|
| `webpki-roots` | on | When you pass no HTTP client, the SDK builds one with rustls, the `ring` provider and Mozilla's root certificates (`webpki-roots`) — no process-wide crypto provider, no platform verifier, works the same on iOS, Android, desktop. `plumbox_client::http_client_builder()` gives you that builder to add timeouts or a proxy. |
| `testing` | off | `plumbox_client::testing::FakeBox`, an in-process fake box, and `Environment::Local` to sign in to it. **Tests only — never in a product build** (see [Testing your app](#testing-your-app)). |

To choose your own roots or TLS stack, build a `reqwest::Client` yourself and
pass it everywhere: `PlumClient::builder(..).http_client(client)`, and
`http: Some(&client)` on `exchange_code` / `refresh_tokens`. With
`default-features = false` the crate pulls in neither `rustls` directly nor
`webpki-roots`; reqwest is built with `rustls-no-provider`, so a client you
build must be given a TLS config (or the process must install a rustls
`CryptoProvider`).

## ⚠️ Read this first — never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do
**not** collect the user's Plum email and password in your app. Use the
delegated flow below. It is the same model as "Sign in with Google":

- In the **system browser**, the user enters their email on
  `https://plumbox.me` and the code Plum mails them, picks their box, and types
  the password **only** on that box's own page (`https://pb-….plumbox.me`).
- Your app gets back a scoped token it can store and revoke — never the
  password, never account control (`admin` is refused). With `files:app` it
  reaches only a folder the box makes for your app.

This crate has no password login at all.

## Quickstart (delegated OAuth)

Two steps: (1) send the user to Plum to authorize; (2) trade the returned code
for tokens.

```rust
use plumbox_client::{
    begin_authorization, exchange_code, parse_callback, scope, Environment, ExchangeCode,
};

const CLIENT_ID: &str = "com.example.myapp:ios";        // registered in the Plum developer console
const REDIRECT_URI: &str = "myapp://plum/callback";      // one of the client's registered redirect URIs
let env = Environment::Production;

// (1) Start authorization. Open the URL in the SYSTEM BROWSER — not an
//     embedded web view (see the security requirements below).
//     Keep `state` and `code_verifier` (AuthorizationRequest is Serialize:
//     store it if the app may be killed while the user is in the browser).
let req = begin_authorization(CLIENT_ID, REDIRECT_URI, &[scope::FILES_APP], &env)?;
save_for_later(&req);
open_in_system_browser(&req.url); // the user finds their box on plumbox.me, signs in on it and approves

// (2) Your redirect handler receives myapp://plum/callback?code=…&state=…&iss=…
let cb = parse_callback(&incoming_url, &env)?; // checks iss: a code from anything but a Plum box is dropped
let (Some(code), Some(iss)) = (cb.code.as_deref(), cb.iss.as_deref()) else {
    return Err(format!("not connected: {:?}", cb.error).into());
};
let tokens = exchange_code(ExchangeCode {
    iss,                                   // which box issued the code (the app never knew the address)
    code,
    state: cb.state.as_deref(),
    expected_state: &req.state,            // the SDK refuses a callback this sign-in did not start
    code_verifier: &req.code_verifier,     // PKCE: proves this is the same app that started the flow
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    ..Default::default()                   // environment: production; http: the default client
})
.await?;
// Store ALL of `tokens` (access_token, refresh_token, expires_at, app_folder,
// scope — it is Serialize) and `iss` (the box's address), on this device only.
// The password never touched your app.
```

Then use the box with the stored tokens. The client refreshes the hourly
access token by itself; persist every new set it hands you:

```rust
use plumbox_client::{ListOptions, OAuthTokens, PlumClient, UploadOptions};

let client = PlumClient::builder(&iss)                      // = cb.iss
    .client_id(CLIENT_ID)                                    // needed to refresh
    .tokens(tokens)                                          // the whole set (older boxes: no refresh token, never expires)
    .on_tokens(|next: &OAuthTokens| save(next))              // the old refresh token stops working — store the new one
    .on_auth_error(|_err| show_reconnect())                  // the connection is gone (revoked, or 90 days unused)
    .build()?;

let root = client.app_folder().unwrap();                     // e.g. "/Apps/My App" — a files:app token reaches nothing else
for f in client.drive().list_all(&root, &ListOptions { recursive: true, hash: true, ..Default::default() }).await? {
    println!("{} {}", f.path, f.hash.unwrap_or_else(|| format!("(size={})", f.size)));
}
client
    .drive()
    .upload(&format!("{root}/note.md"), b"# hello", &UploadOptions { overwrite: true, ..Default::default() })
    .await?;
```

`PlumClient` is cheap to clone and `Send + Sync`; all clones share the tokens
and the one refresh in flight.

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can
still be phished":

1. **Open the authorization URL in the system browser, never an embedded web
   view.** An embedded web view lets *your own app* read what the user types,
   which defeats the entire point — the user must see the real `plumbox.me`,
   and then their own box's `pb-….plumbox.me`, in a browser address bar they
   trust (RFC 8252 §8.12). On iOS use `ASWebAuthenticationSession`, on Android
   Custom Tabs, on desktop the default browser.
2. **Exchange the code only with the box that issued it.** The callback's
   `iss` is that box's address. `parse_callback` and `exchange_code` accept
   only a Plum box's canonical origin — `https://pb-….plumbox.me`, https, no
   port, no path, not the box's `-lan`/`-wan` alias — and stop with
   `invalid_iss` otherwise, before the code or the verifier is sent anywhere.
   Never pass some other `iss` to `exchange_code`. (`is_plum_issuer` exposes
   the same check.)
3. **Check `state`.** Pass the `state` that `begin_authorization` gave you as
   `expected_state`; `exchange_code` stops with `invalid_state` when the
   callback's differs. A mismatch means a forged or stale callback.
4. **Request the least scope you need** (`files:app` for a backup or sync app;
   `files:read` alone if you never write). Never request `admin` — the box
   refuses it anyway.
5. **Store the tokens, not the password** (you never had the password). Treat
   them like a credential — the platform keystore, not a synced settings file —
   and let the user revoke them in box settings. Keep the refresh token **on one
   device**: it rotates on every use, so two devices sharing it (a synced
   settings file, a backup restored elsewhere) knock each other out — after a
   60-second grace, a reused refresh token ends the connection.
6. **Register your client first.** The box consents only to a `client_id` it
   knows: one you registered in the [developer console](https://developer.plum.im)
   or declared in your app's `manifest.json` `clients[]`. The consent screen
   shows the *registered* display name, and the `redirect_uri` and `scope` must
   match that registration — an unknown client gets `unauthorized_client`
   before any screen renders. Redirect URIs are a custom scheme or http
   loopback (any port); https is refused.

`parse_callback` accepts an error callback (`?error=access_denied&state=…`)
without `iss`, since older boxes send none; when one is present it gets the same
check. The `iss` check says "a Plum box", not "the box the user picked" —
swapping in another Plum box is stopped by the signed box list on plumbox.me,
which sends the user only to the box they chose.

`exchange_code` stops with `Error::OAuth` (`code`: `InvalidIss`,
`InvalidState`, `InvalidRequest`) before any request; errors from the box
itself come as `Error::Api` with the box's OAuth code (`invalid_grant`,
`unauthorized_client`, `invalid_scope`, `invalid_redirect_uri`).

### Scopes

| scope | constant | grants |
|---|---|---|
| `files:app` | `scope::FILES_APP` | read and write **one folder the box makes for your app** (`app_folder`, e.g. `/Apps/My App`) — nothing else of the drive, not the trash |
| `files:read` | `scope::FILES_READ` | read the user's files |
| `files:write` | `scope::FILES_WRITE` | change files (implies `files:read`) |
| `user:profile` | `scope::USER_PROFILE` | the signed-in user's profile only (`/api/auth/me`) |
| `service:call:<app_id>` | `scope::service_call(app_id)` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` are the older spellings and still work (`write` =
`files:read` + `files:write`).

**`files:app`** is the least a sync or backup app needs, and what the user is
most willing to approve. The token response's `app_folder` is the folder (an
absolute drive path; the box creates it before it issues the token). Paths stay
absolute drive paths inside it — `/Apps/My App/vault/note.md`. Anything else,
or any path outside the folder, is `403` (`Error::Forbidden`).
`drive().ensure_dir` passes over the parents it may not touch (`/Apps`), so
`ensure_dir(&format!("{app_folder}/vault"))` works.

### Token lifetime and refresh

A box issues an **access token that expires after an hour** and a **refresh
token** with it (`exchange_code` → `OAuthTokens`):

- Give `PlumClient` the whole set plus `client_id` and it keeps the access
  token fresh: it refreshes when less than a minute is left, and when a request
  comes back `401` it refreshes once and sends that request again. Concurrent
  requests share one refresh (one in flight at a time; a request that starts
  while one runs waits for it). Request bodies are in memory, so the retry
  sends the same bytes; a `401` is answered before the box reads the body, so
  it is not a duplicate write.
- Every refresh **rotates** the refresh token. `on_tokens` receives the new set
  before the request is sent again, and before any request uses the new access
  token — persist it there. (`client.tokens()` also returns the current set.)
- A refresh token lapses after **90 days** unused. When the box refuses one
  (`invalid_grant`: revoked, lapsed, reused) the connection is gone: requests
  fail with `Error::Auth { code: Some("invalid_grant"), .. }` and
  `on_auth_error` fires — once, however many requests were in flight. A refresh
  that merely failed to reach the box is `Error::Network` or `Error::Api`; the
  refresh token is still good.
- Refreshes go only to `<iss>/api/oauth/token`, the box the sign-in was checked
  against: `iss` defaults to the base URL and must pass `is_plum_issuer` (set
  `.iss(..)` explicitly if you talk to the box at a LAN address).
- `refresh_tokens(iss, client_id, refresh_token, &env, http)` does one refresh
  by hand; `client.refresh()` forces one.
- **Older boxes** answer the code exchange with an access token only, which
  never expires: no `refresh_token`, no `expires_at`. Use it as before — the
  client never tries to refresh it.

**401 vs 403.** `401` (`Error::Auth`) means the credential is no good — after
the client could not cure it with a refresh, connect the user again. `403`
(`Error::Forbidden`) means the credential is fine but may not do *this* (a scope
it lacks, a path outside its app folder): it does not fire `on_auth_error`, and
reconnecting would not help.

## The Drive

`client.drive()` — the same paths and parameters as the TS SDK:

| method | box route |
|---|---|
| `list(path, &opts)` / `list_all(path, &opts)` (every page) | `GET /api/drive/list` |
| `download(path)` → bytes | `GET /api/drive/download` |
| `download_to_file(path, dest, &opts)` — resumable | `GET /api/drive/download` with `Range` |
| `upload(path, &data, &opts)` — ≤ 8 MiB one multipart POST, above chunked | `POST /api/drive/upload`, `/api/uploads/*` |
| `upload_file(path, local, &opts)` — streams big files a chunk at a time | same |
| `begin_upload(path, size, &opts)` / `resume_upload(&session, local, &opts)` / `cancel_upload(&session)` | `/api/uploads/*` |
| `mkdir(path)` / `ensure_dir(path)` (mkdir -p) | `POST /api/drive/mkdir` |
| `rename(path, new_name)` | `POST /api/drive/rename` |
| `move_to(path, new_path)` (TS `move`) | `POST /api/drive/move` |
| `remove(path)` → the box's trash | `DELETE /api/drive/delete` |

`client.app_folder()` is the `files:app` folder. For anything else (a box-side
service, `/api/auth/me`), `client.request(method, path, body)` sends with the
client's token, refresh and error mapping.

**Resuming.** `download_to_file` writes to `dest` + `.part` and continues a
`.part` it finds with `Range: bytes=<have>-`; a box that sends the whole file
instead starts it over. For uploads that must survive a failure or a restart,
`begin_upload` returns an `UploadSession` (Serialize): keep it, and call
`resume_upload` again after a failure — it asks the box how far it got and goes
on from there, never re-sending what arrived.

`overwrite: true` replaces a file in place (the box keeps the previous content
as a version); without it a name collision creates `name (2).ext`. `remove`
moves to the box trash (recoverable), not a hard delete.

## Errors

| `Error` | TS | when |
|---|---|---|
| `OAuth { code, .. }` | `PlumOAuthError` | the SDK stopped a sign-in before sending anything (`invalid_iss`, `invalid_state`, `invalid_request`) |
| `Auth { status, code, .. }` | `PlumAuthError` | 401 the client could not cure, or a refused refresh (`invalid_grant`, status 400) — fires `on_auth_error` |
| `Forbidden { .. }` | `PlumForbiddenError` | 403 — not allowed, credential fine |
| `Api { status, code, .. }` | `PlumApiError` | any other non-2xx (404, 409, 5xx, OAuth errors from the code exchange) |
| `Network(_)` | the transport's error | the box could not be reached |
| `Io(_)` | — | a local file could not be read or written |
| `InvalidInput(_)` | a plain `Error` | the SDK was called in a way it cannot work with |

`err.status()`, `err.code()`, `is_auth()`, `is_invalid_grant()`,
`is_forbidden()`, `is_not_found()` help match them. `Error` is `Clone`.

## Environments

Production (`plumbox.me`) is the default. Plum's own staging environment is
`Environment::Staging` (`Environment::from_box_domain("staging.plumbox.me")`),
on `begin_authorization`, `parse_callback`, `exchange_code`, `refresh_tokens`
and `PlumClient::builder(..).environment(..)`. Each environment takes only its
own boxes: a production client refuses a `*.staging.plumbox.me` box and a
staging client a production one (LAN addresses and localhost belong to neither
and are accepted as a base URL, never as an issuer).

## If your app has native shells (UniFFI)

The browser part belongs to the shells; everything else stays in Rust:

1. Rust calls `begin_authorization` and hands `req.url` to the shell (keep
   `req` in Rust, or persist it — it serializes).
2. The shell opens it in the **system browser**: `ASWebAuthenticationSession`
   on iOS/macOS (with your callback scheme), Custom Tabs on Android (with an
   intent filter for the redirect URI).
3. The shell hands the **whole callback URL** it receives back to Rust,
   unchanged. Rust runs `parse_callback` and `exchange_code` — the `iss` and
   `state` checks happen there, never in the shell.
4. `on_tokens` / `on_auth_error` are plain closures: forward them to a UniFFI
   callback interface to store the tokens in the Keychain / Keystore and to
   show "connect again". Implement `TokenSink` on your own type if you prefer.

## Testing your app

With the `testing` feature (as a dev-dependency feature only), `FakeBox`
runs an in-process box on `127.0.0.1` that signs in (current or older box),
refreshes with rotation, a 60-second grace and reuse-revokes, lets you expire
or revoke tokens, refuses paths outside the app folder with 403, and serves
list / upload (chunked) / download (ranges) / delete, with a log of every
request:

```toml
[dev-dependencies]
plumbox-client = { git = "https://github.com/plum-networks/plum-sdk", rev = "<commit>", features = ["testing"] }
```

```rust
use plumbox_client::{testing::FakeBox, begin_authorization, parse_callback, scope};

let fake = FakeBox::start().await;
let env = fake.environment();                        // Environment::Local { origin: "http://127.0.0.1:…" }
let req = begin_authorization(CLIENT_ID, REDIRECT_URI, &[scope::FILES_APP], &env)?;
let callback = fake.approve(&req.url);               // what the browser would hand back
let cb = parse_callback(&callback, &env)?;
// … exchange_code with `environment: env.clone()`, then PlumClient::builder(fake.url()).environment(env) …
fake.expire_access_tokens();                         // the next request gets 401 and refreshes
```

`Environment::Local` accepts a loopback `http://` box as an issuer, which a
shipped app must never do — so it exists only when the `testing` feature is
compiled in, not behind a runtime switch. Never enable `testing` in a product
build.

## Where Rust differs from the TS SDK

- Options objects are builders or structs: `PlumClient::builder(base_url)…build()`,
  `exchange_code(ExchangeCode { .. })`. The TS `baseUrl` of `exchangeCode` is
  `iss` here.
- `boxDomain` is an `Environment` value. The deprecated `clientName` and the
  `portalUrl` override of `beginAuthorization` are not there.
- `drive.move` is `move_to` (`move` is a keyword); `listAll` returns a `Vec`.
- `tokenStorage` is replaced by `on_tokens` (+ `client.tokens()`/`set_tokens()`);
  `onTokens` is a synchronous callback.
- Not in this crate: password login, discovery (`discover`, OPRF), the trash and
  versions APIs, `apps.*`.
- Added: file-to-file transfers that resume (`download_to_file`, `upload_file`,
  `begin_upload`/`resume_upload`), and `Error::Io`.
- `OAuthTokens` serializes snake_case; it also reads the TS camelCase JSON.

## Developing

```bash
cd rust
cargo test --all-features                   # unit + integration tests against the fake box
cargo test                                  # the product feature set (no `testing`)
cargo clippy --all-features --all-targets -- -D warnings
cargo doc --all-features --no-deps
```
