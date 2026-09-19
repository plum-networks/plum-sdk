# @plumbox/client

Client SDK for **Plum Box**: connect a third-party app to the user's box through **Plum Relay** — no IP addresses, ports, or tunneling. Works like a cloud SDK, but the storage is the user's own box.

- Zero runtime dependencies, ESM + CJS, TypeScript types included
- Pluggable HTTP transport: global `fetch` (Node 18+/desktop) or Obsidian's `requestUrl` (desktop **and** mobile — no `isDesktopOnly`)
- **Third-party apps authenticate with delegated OAuth (PKCE): the user logs in on Plum's own page, and your app only ever receives a scoped, revocable token — never the password.**

## ⚠️ Read this first — never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do **not** collect the user's Plum email + password in your app. Use the delegated flow below. It is the same model as "Sign in with Google":

- The user types their password **only** on `https://plumbox.me` (Plum's own surface), opened in the **system browser**.
- Your app gets back a scoped **read/write** token it can store and revoke — never the password, never account control (`admin` is refused).

The `client.login({ login, password })` method further down exists **only for Plum's own first-party apps**. Using it in a third-party app means you are asking the user to trust you with their password — exactly what this SDK is designed to avoid.

## Quickstart (third-party app — delegated OAuth)

Two steps: (1) send the user to Plum to authorize; (2) trade the returned code for a token.

```ts
import { beginAuthorization, exchangeCode, parseCallback, PlumClient } from "@plumbox/client";

// (1) Start authorization. Open the URL in the SYSTEM BROWSER — not an
//     in-app webview (see the security note below). Keep verifier + state.
const req = await beginAuthorization({
  clientId: "com.example.myapp:ios",          // registered in the Plum developer console (or your manifest's clients[])
  redirectUri: "myapp://plum/callback",        // must be one of the client's registered redirect URIs
  scopes: ["files:read", "files:write"],       // subset of the client's registered scopes; "admin" is never granted
});
saveForLater(req.codeVerifier, req.state);
openInSystemBrowser(req.url);                   // user logs in on plumbox.me & approves

// (2) Your redirect handler is called with myapp://plum/callback?code=…&iss=…&state=…
const cb = parseCallback(incomingUrl);
if (cb.state !== savedState) throw new Error("state mismatch — reject");
if (cb.error || !cb.code || !cb.iss) throw new Error(cb.error ?? "no code");

const { accessToken, scope } = await exchangeCode({
  baseUrl: cb.iss,                              // which box issued the code (app never knew the address)
  code: cb.code,
  codeVerifier: savedVerifier,                  // PKCE: proves this is the same app that started the flow
  clientId: "com.example.myapp:ios",
  redirectUri: "myapp://plum/callback",
});
// Store accessToken + cb.iss (as baseUrl). The password never touched your app.
```

Then use the box with the stored token:

```ts
const box = new PlumClient({ baseUrl /* = cb.iss */, token: accessToken });
for await (const f of box.drive.listAll("/", { recursive: true, hash: true })) {
  console.log(f.path, f.hash ?? `(size=${f.size})`);
}
await box.drive.upload("/MyApp/note.md", "# hello", { overwrite: true });
```

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded webview.** An embedded webview lets *your own app* read what the user types, which defeats the entire point — the user must see the real `plumbox.me` in a browser address bar they trust. (This is RFC 8252 §8.12.) In Obsidian use `window.open(url)`; on desktop/Electron use `shell.openExternal(url)`; on mobile use the OS "open in browser" API.
2. **Always verify `state`** from the callback equals the value `beginAuthorization` gave you, before exchanging. A mismatch means a forged callback.
3. **Request the least scope you need** (`files:read` alone if you never write). Never request `admin` — the box refuses it anyway.
5. **Register your client first.** The box consents only to a `client_id` it knows: one you registered in the [developer console](https://developer.plum.im) (Clients page of your app) or declared in your app's `manifest.json` `clients[]`. The consent screen shows the *registered* display name, and the `redirect_uri` and `scope` must match that registration — an unknown client gets `unauthorized_client` before any screen renders.

### Scopes

| scope | grants |
|---|---|
| `files:read` | read the user's files |
| `files:write` | change files (implies `files:read`) |
| `user:profile` | the signed-in user's profile only |
| `service:call:<app_id>` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` are the older spellings and still work (`write` = `files:read` + `files:write`).

## Companion apps: the box-side service and paid features

A companion app usually pairs with a service (.plu) running on the box. After connecting:

```ts
const box = new PlumClient({ baseUrl, token });
const svc = await box.apps.ensureServiceInstalled("com.example.myapp");
if (!svc.installed) {
  // Send the user to install it: the Plum app (deep link) or the box web UI.
  openUrl(svc.installUrl /* plum://store/com.example.myapp */ ?? svc.webUrl);
}
const ent = await box.apps.entitlement("com.example.myapp");
const pro = ent.skus.some((s) => s.sku === "pro" && s.active);   // what "pro" unlocks is up to you
```

Your box-side service sees the same information on every proxied request as `X-Plum-Entitlements: pro,plus` (and `X-Plum-Entitlements-Stale: 1` when the box could not refresh receipts for two days), and through the control socket `GET /entitlement`.
4. **Store the token, not the password** (you never had the password). Treat the token like a credential; let the user revoke it in box settings.

## Obsidian plugin (delegated OAuth)

```ts
import { requestUrl, Notice } from "obsidian";
import { beginAuthorization, exchangeCode, injectedAdapter, PlumClient } from "@plumbox/client";

// In onload(): register the deep-link handler once.
this.registerObsidianProtocolHandler("plum", async (params) => {
  if (params.state !== this.pending?.state) return new Notice("Sign-in state mismatch.");
  if (params.error || !params.code || !params.iss) return new Notice("Sign-in was cancelled.");
  const { accessToken } = await exchangeCode({
    baseUrl: params.iss,
    code: params.code,
    codeVerifier: this.pending.verifier,
    clientId: "obsidian-plum-sync",
    redirectUri: "obsidian://plum/callback",
    http: injectedAdapter(requestUrl),          // bypasses CORS on desktop AND mobile
  });
  await this.saveData({ baseUrl: params.iss, token: accessToken });
  new Notice("Connected to your Plum Box.");
});

// When the user clicks "Connect":
const req = await beginAuthorization({
  clientId: "im.plum.obsidian-sync:obsidian",  // as registered in the developer console
  redirectUri: "obsidian://plum/callback",
  scopes: ["files:read", "files:write"],
});
this.pending = { verifier: req.codeVerifier, state: req.state };
window.open(req.url);                            // system browser — the user logs in on plumbox.me
```

`requestUrl` bypasses CORS on desktop and mobile, so the same code runs everywhere. Note the token is stored in the plugin's `data.json` (plaintext at rest, like most sync plugins) — it is scoped read/write and the user can revoke it, but never store `admin`.

## First-party login (Plum apps only)

For Plum's own apps, where showing the password form is legitimate, discover the box and mint a token directly:

```ts
import { resolveBoxes } from "@plumbox/oprf";   // zero-knowledge discovery
import { PlumClient } from "@plumbox/client";

const [box] = await resolveBoxes("user@example.com", password); // relay learns nothing
const client = new PlumClient({ baseUrl: box.baseUrl });
const r = await client.login({ login: "user@example.com", password });
if (!r.ok && r.requireTotp) await r.verifyTotp("123456");
const { token } = await client.auth.createToken({ name: "Plum app", scopes: ["read", "write"] });
await client.auth.logout();                      // keep only the PAT
```

Do not use this path in a third-party app — see the warning at the top.

## API surface

| Area | Methods |
|---|---|
| **Delegated auth (third-party)** | **`beginAuthorization`**, **`exchangeCode`**, **`parseCallback`** — the password-free OAuth+PKCE flow |
| Discovery | `resolveBoxes(email, password)` from `@plumbox/oprf` (zero-knowledge; first-party). `discover(email)` here is the deprecated legacy lookup. |
| First-party auth | `login`, `verifyTotp`, `auth.createToken/listTokens/revokeToken/me/logout`, `setToken/loadToken/clearToken` |
| Drive | `list`, `listAll` (auto-pagination), `download`, `upload` (auto-chunked >8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash), `trash.list/restore/empty`, `versions.list/restore` |
| Apps (companion) | `apps.status`, `apps.ensureServiceInstalled` (→ `plum://store/<id>` / web install link), `apps.entitlement`, `apps.refreshEntitlements` |
| Errors | `PlumApiError` (status/code), `PlumAuthError` (401/403 → `onAuthError` hook) |

## Sync-client notes

- `list(..., { hash: true })` returns the box-indexed SHA-256 per file; files uploaded before hash indexing omit it — fall back to `size` + `modTime`.
- `upload(..., { overwrite: true })` replaces in place and the box snapshots the previous content as a version. Without it, name collisions create `name (2).ext`.
- `remove` moves to the box trash (user-recoverable), not a hard delete.
- Browser pages can NOT talk to a box cross-origin (the box API sends no CORS headers); use Node/desktop runtimes or Obsidian `requestUrl`.

## Integration tests

```bash
PLUM_INTEGRATION=1 \
PLUM_TEST_BASE_URL=https://pb-<sub>.plumbox.me \
PLUM_TEST_PAT=plum_pat_... \
npm run test:integration --workspace @plumbox/client
```
