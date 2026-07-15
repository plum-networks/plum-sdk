# @plumbox/client

Client SDK for **Plum Box**: log in once, auto-connect to the user's box through **Plum Relay**, and use the Drive API — no IP addresses, ports, or tunneling. Works like a cloud SDK, but the storage is the user's own box.

- Zero runtime dependencies, ESM + CJS, TypeScript types included
- Pluggable HTTP transport: global `fetch` (Node 18+/desktop) or Obsidian's `requestUrl` (desktop **and** mobile — no `isDesktopOnly`)
- Auth designed for third-party apps: password login (+ TOTP) once → mint a scoped **Personal Access Token** → store only the PAT

## Quickstart

```ts
import { discover, PlumClient } from "@plumbox/client";

// 1) Find the user's box from their account email (cache the result!)
const { baseUrl } = await discover("user@example.com");

// 2) Log in once and mint a PAT
const client = new PlumClient({ baseUrl });
const r = await client.login({ login: "user@example.com", password });
if (!r.ok && r.requireTotp) await r.verifyTotp("123456");
const { token } = await client.auth.createToken({
  name: "MyApp - MacBook",
  scopes: ["read", "write"], // never request "admin" from an app
});
await client.auth.logout(); // drop the session; keep only the PAT

// 3) Every later run: connect straight away with the stored PAT
const box = new PlumClient({ baseUrl, token });
for await (const f of box.drive.listAll("/", { recursive: true, hash: true })) {
  console.log(f.path, f.hash ?? `(size=${f.size})`);
}
await box.drive.upload("/Obsidian/vault/note.md", "# hello", { overwrite: true });
```

## Obsidian plugins

```ts
import { requestUrl } from "obsidian";
import { injectedAdapter, PlumClient } from "@plumbox/client";

const client = new PlumClient({ baseUrl, token, http: injectedAdapter(requestUrl) });
```

`requestUrl` bypasses CORS on desktop and mobile, so the same code runs everywhere.

## API surface

| Area | Methods |
|---|---|
| Discovery | `discover(email)` → `{ subdomain, baseUrl }` (rate-limited — cache it) |
| Auth | `login`, `verifyTotp`, `auth.createToken/listTokens/revokeToken/me/logout`, `setToken/loadToken/clearToken` |
| Drive | `list`, `listAll` (auto-pagination), `download`, `upload` (auto-chunked >8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash), `trash.list/restore/empty`, `versions.list/restore` |
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
