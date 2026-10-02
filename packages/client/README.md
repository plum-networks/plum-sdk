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

Three calls: **start** a sign-in, **validate** the callback, **complete** it.

```ts
import { startAuthorization, validateCallback, acceptIssuerChange, completeAuthorization, PlumClient } from "@plumbox/client";

// (1) Start. Open pending.url in the SYSTEM BROWSER (never an in-app web view).
const pending = await startAuthorization({
  clientId: "com.example.myapp:desktop",   // registered in the Plum developer console (or your manifest's clients[])
  redirectUri,                             // e.g. http://127.0.0.1:<port>/callback, see below
  scopes: ["files:read", "files:write"],   // subset of the client's registered scopes; "admin" is never granted
  // First connect: { mode: "discover" } (the default) — the portal finds the user's box.
  // Reconnect:     { mode: "known", issuer: saved.issuer } — must come back from that box.
});
openInSystemBrowser(pending.url);

// (2) Your redirect target receives the callback URL. Validate it against the pending sign-in.
const outcome = validateCallback(pending, callbackUrl);
if (outcome.kind === "ignored") return;              // not this sign-in's callback: keep waiting
if (outcome.kind !== "authorized") throw new Error(outcome.kind); // see "Outcomes" below

// (3) Exchange. Goes only to the validated box, with a proof of this sign-in's key.
const grant = await completeAuthorization(outcome);
save({ issuer: grant.issuer, token: grant.accessToken }); // reconnect later with { mode: "known", issuer }

const box = new PlumClient({ baseUrl: grant.issuer, token: grant.accessToken });
```

### Why there is a "verified channel"

The callback says which box issued the code (`iss`), and the app sends the code
there. On a custom-scheme redirect (`myapp://…`, `obsidian://…`) any other app on
the device can register the same scheme, read the callback and rewrite `iss` — so
the SDK only trusts a **first connect** (Discover) when the callback arrived on a
channel no other app can read. In this SDK that is a **loopback redirect**: an http
listener your app owns on `127.0.0.1`, `[::1]` or `localhost` (RFC 8252 §7.3).

- The SDK decides the channel itself: from `redirectUri` at start, confirmed
  against the URL handed to `validateCallback`. You cannot pass it in.
- **Discover on a custom scheme is refused at start** with
  `PlumOAuthError` code `verified_channel_unavailable`, before the user types a
  password. Connect from a desktop (loopback) first; afterwards the app can
  **reconnect with `{ mode: "known", issuer }`** over any redirect, because then
  any other box answering is refused.
- The code is also bound to a key that never leaves your app (DPoP, RFC 9449): a
  code copied out of a hijacked callback cannot be redeemed without it.

### Desktop / Node: loopback redirect

Register `http://127.0.0.1/callback` for your client (loopback entries match any port).

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

const pending = await startAuthorization({ clientId, redirectUri, scopes: ["files:read", "files:write"] });
openInSystemBrowser(pending.url);

server.on("request", async (req, res) => {
  const outcome = validateCallback(pending, new URL(req.url ?? "/", redirectUri).href);
  if (outcome.kind === "ignored") return void res.writeHead(404).end(); // a stray request: keep listening
  res.end("You can close this window and return to the app.");
  server.close();
  if (outcome.kind === "issuer_changed") {
    // Reconnect only: a different box of the user's answered (e.g. another RAID member).
    if (!(await askUser(`Connect to ${new URL(outcome.issuer).host} instead?`))) return;
    return finish(await completeAuthorization(acceptIssuerChange(outcome)));
  }
  if (outcome.kind !== "authorized") return showError(outcome);
  finish(await completeAuthorization(outcome));
});
```

### Outcomes

| `outcome.kind` | Meaning | What to do |
|---|---|---|
| `authorized` | `issuer` is the box; `match` is `exact`, `discovered`, `dev` or `confirmed` | `completeAuthorization(outcome)` |
| `issuer_changed` | Known reconnect on loopback, and another box of the user answered (`issuer` vs `expected`) | Ask the user. Yes → `acceptIssuerChange(outcome)` → complete. No → `discardPendingAuthorization(pending)`. Never accept automatically. |
| `denied` | The user cancelled, or the box refused (`error`, `description`) | Show it; start again on request |
| `rejected` | Refused for safety (`reason`: `issuer_mismatch`, `unverified_channel`, `channel_mismatch`, `invalid_iss`, `expired`, …). The sign-in is over. | Offer "try again" |
| `ignored` | Not this sign-in's callback (`state_mismatch`, `not_our_redirect`) | Keep waiting; the real callback may still come |

A sign-in accepts one callback, expires after 30 minutes, and exchanges once.
`completeAuthorization` only accepts outcomes the SDK produced; a hand-built
`{ kind: "authorized", … }` is refused.

### Errors

Problems found on the device throw `PlumOAuthError` with a `code`:
`verified_channel_unavailable`, `invalid_known_issuer` (the stored issuer is not
a box address: start with Discover), `dev_not_allowed`, `invalid_dev_issuer`,
`invalid_request`, `invalid_pending`, `not_persistable`, `invalid_outcome`,
`key_lost` (the sign-in already ended), `bad_response`. Refusals by the box are
`PlumApiError`s with the box's OAuth code (`invalid_grant`, `invalid_dpop_proof`,
`unauthorized_client`, …). If the box says the proof's clock is off
(`plum_retry: "iat"`), `completeAuthorization` re-signs once on the box's clock by
itself — a phone or box clock that is hours off still signs in.

### Opting out of the verified channel (read before you do)

`policy: { requireVerifiedChannel: false }` lets Discover run on a custom-scheme
redirect. The cost is yours and your users': on boxes that do not bind codes yet,
an app that registers your scheme can still **steal the token**; on boxes that
do, it can still **connect your app to its own box** — for a sync app, the user's
data then goes there. Prefer a desktop first connect plus Known reconnects.

### Developer box (emulator)

```ts
const pending = await startAuthorization({
  clientId, redirectUri, scopes: ["files:read"],
  expectation: { mode: "dev", issuer: "http://10.0.2.2:8080" },   // or http://127.0.0.1:8080, a LAN IP, https://…
  policy: { allowDev: isDebugBuild },                              // must be exactly true; never in a release build
});
```

Dev starts at the dev box itself and accepts exactly that issuer. Sign in to the
dev box's web UI first: its consent page sends a browser without a session to the
real portal.

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded webview.** An embedded webview lets *your own app* read what the user types, which defeats the entire point — the user must see the real `plumbox.me` in a browser address bar they trust. (This is RFC 8252 §8.12.) In Obsidian use `window.open(url)`; on desktop/Electron use `shell.openExternal(url)`; on mobile use the OS "open in browser" API.
2. **Use a loopback redirect for first connects**, and reconnect with `{ mode: "known", issuer }`. Do not opt out of the verified channel without reading the section above.
3. **Request the least scope you need** (`files:read` alone if you never write). Never request `admin` — the box refuses it anyway.
4. **Store the token, not the password** (you never had the password). Treat the token like a credential; let the user revoke it in box settings.
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

## Obsidian plugin (delegated OAuth)

The deep link (`obsidian://…`) arrives in a fresh plugin call, so the sign-in must
be **persisted** (`persistable: true` + `serializePendingAuthorization`), and the
protocol handler hands over parsed params, so validate with
**`validateCallbackParams`**. A deep link is not a verified channel: connect for
the first time from **desktop** over a loopback redirect (Node's `http`, as above);
on mobile, reconnect with **Known**.

```ts
import { requestUrl, Notice, Platform } from "obsidian";
import {
  startAuthorization, serializePendingAuthorization, deserializePendingAuthorization,
  validateCallbackParams, completeAuthorization, injectedAdapter, PlumOAuthError,
} from "@plumbox/client";

// "Connect":
try {
  const pending = await startAuthorization({
    clientId: "obsidian-plum-sync",
    redirectUri: "obsidian://plum-sync",          // desktop: a loopback redirect instead (verified, so Discover works)
    scopes: ["files:read", "files:write"],
    expectation: this.settings.baseUrl ? { mode: "known", issuer: this.settings.baseUrl } : { mode: "discover" },
    persistable: true,
  });
  this.settings.pending = await serializePendingAuthorization(pending); // a credential for 30 min
  await this.saveSettings();
  window.open(pending.url);                       // system browser
} catch (e) {
  if (e instanceof PlumOAuthError && e.code === "verified_channel_unavailable") {
    new Notice("Connect from Obsidian on your computer first; this device then reconnects to the same box.");
  } else throw e;
}

// In onload():
this.registerObsidianProtocolHandler("plum-sync", async (params) => {
  let pending;
  try {
    pending = await deserializePendingAuthorization(this.settings.pending ?? "");
  } catch {
    return; // no sign-in in progress (an old {verifier, state} record reads the same)
  }
  const outcome = validateCallbackParams(pending, params);
  if (outcome.kind === "ignored") return;         // a stray link: keep waiting
  this.settings.pending = null;
  await this.saveSettings();
  if (outcome.kind !== "authorized") return new Notice(`Plum: sign-in ${outcome.kind}.`);
  const grant = await completeAuthorization(outcome, { http: injectedAdapter(requestUrl) });
  this.settings.baseUrl = grant.issuer;
  this.settings.token = grant.accessToken;
  await this.saveSettings();
});
```

`requestUrl` bypasses CORS on desktop and mobile, so the same code runs everywhere. `validateCallbackParams` cannot detect repeated parameters (Obsidian already collapsed them); prefer `validateCallback` wherever you have the raw URL. Note the token is stored in the plugin's `data.json` (plaintext at rest, like most sync plugins) — it is scoped read/write and the user can revoke it, but never store `admin`.

### Legacy API (deprecated)

`beginAuthorization`, `parseCallback`, `exchangeCode` and the `CallbackResult`
type are unchanged from 0.2.0 and still work, but they check nothing about `iss`
and do not bind the code. Boxes will refuse their unbound requests on
custom-scheme redirects from a published cutoff date (loopback redirects are
never cut off). Migrate: `beginAuthorization` → `startAuthorization`,
`parseCallback` + your own state check → `validateCallback` /
`validateCallbackParams`, `exchangeCode({ baseUrl: cb.iss, … })` →
`completeAuthorization(outcome)`; store `grant.issuer` and reconnect with
`{ mode: "known", issuer }`.

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
| **Delegated auth (third-party)** | **`startAuthorization`**, **`validateCallback`** / **`validateCallbackParams`**, **`acceptIssuerChange`**, **`completeAuthorization`**, `serializePendingAuthorization` / `deserializePendingAuthorization`, `discardPendingAuthorization` — the password-free OAuth+PKCE flow with an authenticated issuer and a DPoP-bound code. Deprecated, unchanged: `beginAuthorization`, `exchangeCode`, `parseCallback`. |
| Discovery | `resolveBoxes(email, password)` from `@plumbox/oprf` (zero-knowledge; first-party). `discover(email)` here is the deprecated legacy lookup. |
| First-party auth | `login`, `verifyTotp`, `auth.createToken/listTokens/revokeToken/me/logout`, `setToken/loadToken/clearToken` |
| Drive | `list`, `listAll` (auto-pagination), `download`, `upload` (auto-chunked >8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash), `trash.list/restore/empty`, `versions.list/restore` |
| Apps (companion) | `apps.status`, `apps.ensureServiceInstalled` (→ `plum://store/<id>` / web install link), `apps.entitlement`, `apps.refreshEntitlements` |
| Errors | `PlumApiError` (status/code/`retryAfterMs`), `PlumAuthError` (401/403 → `onAuthError` hook), `ListingIncompleteError` (503 `listing_incomplete`, see below), `PlumOAuthError` (sign-in stopped on the device; `code`) |

## Sync-client notes

- **A listing you could not get is not an empty listing.** When the box cannot
  read every folder of a recursive listing it answers `503 {"error":"listing_incomplete"}`
  instead of a shorter list, and `list` / `listAll` throw `ListingIncompleteError`
  (a `PlumApiError`, so existing `instanceof PlumApiError` checks still catch it).
  Abort that sync pass: do not diff against what you have, and do not delete
  anything. If `listAll` throws partway, the entries it already yielded are not
  the folder's contents either. List again later — not before `err.retryAfterMs`
  when the box sent `Retry-After`. The SDK never retries on its own. (Boxes
  older than this change answered a silently partial `200`; there is nothing a
  client can do about those but update the box.)
  ```ts
  try {
    for await (const f of box.drive.listAll("/", { recursive: true, hash: true })) onBox.set(f.path, f);
  } catch (e) {
    if (e instanceof ListingIncompleteError) return scheduleRetry(e.retryAfterMs ?? 60_000); // no diff, no deletes
    throw e;
  }
  ```
- Entries whose bytes live on another box of the owner's RAID set carry
  `remote: true`. Treat them like any other entry when you diff (current
  boxes include them in recursive listings and searches), and `download`
  streams them from that box — expect it to be slower, and to fail while that
  box is offline.
- `list(..., { hash: true })` returns the box-indexed SHA-256 per file; files uploaded before hash indexing omit it — fall back to `size` + `modTime`.
- `upload(..., { overwrite: true })` replaces in place and the box snapshots the previous content as a version. Without it, name collisions create `name (2).ext`.
- `remove` moves to the box trash (user-recoverable), not a hard delete.
- Browser pages can NOT talk to a box cross-origin (the box API sends no CORS headers); use Node/desktop runtimes or Obsidian `requestUrl`.

## Changes in 0.3.0

- New sign-in API: `startAuthorization`, `validateCallback`, `validateCallbackParams`, `acceptIssuerChange`, `completeAuthorization`, `serializePendingAuthorization`, `deserializePendingAuthorization`, `discardPendingAuthorization`; types `StartAuthorizationOptions`, `IssuerExpectation`, `IssuerPolicy`, `PendingAuthorization`, `AuthorizationOutcome`, `Grant`; error class `PlumOAuthError`.
- `beginAuthorization`, `parseCallback`, `exchangeCode` and `CallbackResult` are deprecated and otherwise unchanged.

## Integration tests

```bash
PLUM_INTEGRATION=1 \
PLUM_TEST_BASE_URL=https://pb-<sub>.plumbox.me \
PLUM_TEST_PAT=plum_pat_... \
npm run test:integration --workspace @plumbox/client
```

The sign-in end to end, against a local emulator running a core with issuer binding (setup in the header of `test/oauth.e2e.test.ts`):

```bash
PLUM_OAUTH_E2E=1 npm run test:e2e --workspace @plumbox/client
```
