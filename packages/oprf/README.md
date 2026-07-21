# @plumbox/oprf

Zero-knowledge **box discovery** for Plum. Find the box belonging to a user from
their `(email, password)` — while the relay learns **nothing**: not the email,
not the password, not which box, not even whether a box exists.

## Why

The legacy way to find a box was `POST /api/lookup {email} → {subdomain}`: an
**existence oracle**. Anyone who guessed an email learned whether that person
owns a Plum Box and its public address. For a self-hosted, privacy-first product
that's a leak. This package replaces it with the routing directory:

- The client derives a lookup key from `(email, password)` and **OPRF-blinds**
  it. The relay evaluates it with a secret key it never exposes and never sees
  the unblinded value — so it can't recompute tokens offline or link requests.
- The box's address is stored **encrypted** under a key derived from the same
  credential. The relay holds only ciphertext.
- A wrong credential and "no box" are **indistinguishable** (uniform 404).

## Usage

```ts
import { resolveBoxes } from "@plumbox/oprf";

const boxes = await resolveBoxes("user@example.com", password);
// [{ sub: "pb-…", label: "My Box", baseUrl: "https://pb-….plumbox.me" }, …]
for (const box of boxes) {
  console.log(box.label, box.baseUrl);
}
```

Pair it with `@plumbox/client`:

```ts
import { resolveBoxes } from "@plumbox/oprf";
import { PlumClient } from "@plumbox/client";

const [box] = await resolveBoxes(email, password);
const client = new PlumClient({ baseUrl: box.baseUrl });
await client.login({ login: email, password });
// … mint a PAT, then use client.drive.*
```

In Obsidian, pass the same `injectedAdapter(requestUrl)` you use for the client:

```ts
import { injectedAdapter } from "@plumbox/client";
const boxes = await resolveBoxes(email, password, { http: injectedAdapter(requestUrl) });
```

## Crypto contract

Byte-for-byte identical to the box (`plum-box-core/internal/routing`), the portal
(`plum-crypto.js`), and the mobile apps. Verified in `test/golden.test.ts`
against the same golden vectors the Go tests pin:

- `salt = SHA-256(lower(trim(email)))[:16]`
- `seed = Argon2id(emailNorm‖secret, salt, t=3, m=64 MiB, p=1, 32 B)`
- `enc/commit/lookup = HKDF-SHA256(seed, info=label, salt=32×0)`
- OPRF over ristretto255: `token = SHA-256("plum-oprf-out-v1" ‖ lookup ‖ k·H2C(lookup))`
- locator = `nonce(24) ‖ commit(32) ‖ XChaCha20-Poly1305(encKey, nonce, plaintext, ad=commit)` (committing)

Never edit a constant here — bump the `-v2` label across all repos and migrate.

Uses `libsodium-wrappers-sumo` (bundled) for Argon2id / ristretto255 /
XChaCha20-Poly1305 / SHA-512, and WebCrypto Subtle for SHA-256 / HKDF. Runs in
Node 18+, browsers, Electron, and mobile webviews.

## Live check

```bash
PLUM_LIVE_RELAY=1 npx vitest run test/live-relay.test.ts
```
