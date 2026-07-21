/**
 * Zero-knowledge routing crypto for Plum box discovery.
 *
 * This reproduces the FROZEN cross-repo contract byte-for-byte:
 *   - box (Go):      plum-box-core/internal/routing/{derive,oprf}.go
 *   - browser:       plum-portal/static/js/plum-crypto.js
 *   - Android/iOS:   RoutingKey.kt / swift-sodium
 *
 * Any deviation makes a client's lookup silently miss the relay row. The unit
 * tests pin the same golden vectors the Go tests assert; do not "fix" a
 * constant here — bump the "-v2" label across all repos and migrate.
 *
 * Derivation (v1):
 *   emailNorm = lower(trim(email))                 // secret is NOT normalized
 *   salt      = SHA-256(emailNorm)[:16]
 *   seed      = Argon2id(emailNorm||secret, salt, t=3, m=64MiB, p=1, 32B)
 *   K(label)  = HKDF-SHA256(seed, info=label, salt=32 zero bytes)   // enc/commit/lookup
 *   H2C(x)    = ristretto255_from_hash(SHA-512("plum-oprf-h2c-v1" || x))
 *   token     = SHA-256("plum-oprf-out-v1" || lookup || encode(k*H2C(lookup)))
 *   blob      = nonce(24) || commit(32) || XChaCha20Poly1305(encKey, nonce, pt, ad=commit)
 */
import _sodium from "libsodium-wrappers-sumo";

const H2C_LABEL = "plum-oprf-h2c-v1";
const OUT_LABEL = "plum-oprf-out-v1";
const AEAD_LABEL = "plum-routing-aead-v1";
const COMMIT_LABEL = "plum-routing-commit-v1";
const LOOKUP_LABEL = "plum-routing-lookup-v1";

export type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;

/** Resolve and initialize libsodium once (idempotent). */
export async function getSodium(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = _sodium.ready.then(() => _sodium);
  }
  return readyPromise;
}

const te = new TextEncoder();
function enc(s: string): Uint8Array {
  return te.encode(s);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** WebCrypto SubtleCrypto, resolved for Node 18+, browsers, and Electron. */
async function getSubtle(): Promise<SubtleCrypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto.subtle;
  // Node 18 without the global: reach for node:crypto's webcrypto.
  const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto?: Crypto };
  if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
  throw new Error("@plumbox/oprf: no WebCrypto SubtleCrypto available in this runtime");
}

// TS 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, which lib.dom's
// BufferSource (ArrayBuffer-backed) rejects. Our arrays are always plain
// ArrayBuffer-backed at runtime, so this cast is sound.
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = await getSubtle();
  return new Uint8Array(await subtle.digest("SHA-256", bs(bytes)));
}

/** HKDF-SHA256(seed, info=label) → 32 bytes, salt = 32 zero bytes (Go hkdf nil salt). */
async function hkdf32(seed: Uint8Array, label: string): Promise<Uint8Array> {
  const subtle = await getSubtle();
  const key = await subtle.importKey("raw", bs(seed), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bs(new Uint8Array(32)), info: bs(enc(label)) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function normEmail(email: string): string {
  return String(email).trim().toLowerCase();
}

/** Argon2id KDF root seed. `secret` = password / invite code / recovery code. */
export async function deriveSeed(email: string, secret: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const ne = normEmail(email);
  const salt = (await sha256(enc(ne))).slice(0, 16);
  const pwd = cat(enc(ne), enc(secret));
  return sodium.crypto_pwhash(
    32,
    pwd,
    salt,
    3,
    64 * 1024 * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** 32-byte relay directory key. Never transmit raw — OPRF-blind it. */
export async function lookupId(seed: Uint8Array): Promise<Uint8Array> {
  return hkdf32(seed, LOOKUP_LABEL);
}

async function hashToGroup(lookup: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  const h = sodium.crypto_hash(cat(enc(H2C_LABEL), lookup)); // crypto_hash = SHA-512
  return sodium.crypto_core_ristretto255_from_hash(h);
}

export interface Blind {
  /** Keep secret; needed to unblind the relay's response. */
  r: Uint8Array;
  /** POST this to /api/oprf as {blinded}. */
  blindedHex: string;
}

/** OPRF blind: pick a random scalar r and return B = r*H2C(lookup). */
export async function oprfBlind(lookup: Uint8Array): Promise<Blind> {
  const sodium = await getSodium();
  const r = sodium.crypto_core_ristretto255_scalar_random();
  const B = sodium.crypto_scalarmult_ristretto255(r, await hashToGroup(lookup));
  return { r, blindedHex: sodium.to_hex(B) };
}

/** OPRF finalize: unblind the relay's evaluated element → 64-char token hex. */
export async function oprfFinalize(
  lookup: Uint8Array,
  r: Uint8Array,
  evaluatedHex: string,
): Promise<string> {
  const sodium = await getSodium();
  const E = sodium.from_hex(evaluatedHex);
  const rInv = sodium.crypto_core_ristretto255_scalar_invert(r);
  const final = sodium.crypto_scalarmult_ristretto255(rInv, E);
  const token = await sha256(cat(enc(OUT_LABEL), lookup, final));
  return sodium.to_hex(token);
}

/** The decrypted routing locator: how a client reaches the box. */
export interface Locator {
  /** e.g. "pb-0123abcd…" */
  sub: string;
  /** Human-friendly box name (multi-box picker). */
  label?: string;
}

/**
 * Open a sealed locator blob. Committing: the commitment is constant-time
 * checked before AEAD-open, so a blob sealed for a different account fails
 * closed (throws) instead of decrypting to garbage — callers iterating a
 * multi-box list skip on throw.
 */
export async function openLocator(seed: Uint8Array, blob: Uint8Array): Promise<Locator> {
  const sodium = await getSodium();
  if (blob.length < 24 + 32) throw new Error("locator blob too short");
  const nonce = blob.slice(0, 24);
  const blobCommit = blob.slice(24, 56);
  const ct = blob.slice(56);
  const commit = await hkdf32(seed, COMMIT_LABEL);
  if (!sodium.memcmp(blobCommit, commit)) throw new Error("wrong key");
  const encKey = await hkdf32(seed, AEAD_LABEL);
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    commit,
    nonce,
    encKey,
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Locator;
}

/** Portable standard-base64 → bytes (Node Buffer or browser atob). */
export function base64ToBytes(b64: string): Uint8Array {
  const g = globalThis as { atob?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.atob === "function") {
    const bin = g.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, "base64"));
  throw new Error("@plumbox/oprf: no base64 decoder available");
}
