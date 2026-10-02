// Crypto helpers shared by the legacy OAuth calls (oauth.ts) and the bound
// flow (authorize.ts, dpop.ts). Not exported from the package.
//
// b64url, btoaShim, randomBytes and sha256 moved here from oauth.ts verbatim:
// the 0.2.0 calls use them and must behave exactly as they did
// (test/legacy-api.test.ts compares them with the 0.2.0 source).

export const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaShim(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function btoaShim(s: string): string {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.btoa === "function") return g.btoa(s);
  if (g.Buffer) return g.Buffer.from(s, "binary").toString("base64");
  throw new Error("no base64 encoder available");
}

export function randomBytes(n: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const out = new Uint8Array(n);
  if (g.crypto?.getRandomValues) return g.crypto.getRandomValues(out);
  throw new Error("no secure RNG available");
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as { crypto?: Crypto };
  let subtle = g.crypto?.subtle;
  if (!subtle) {
    const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto?: Crypto };
    subtle = nodeCrypto.webcrypto?.subtle;
  }
  if (!subtle) throw new Error("no SubtleCrypto for PKCE");
  return new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

// ---- used only by the bound flow ----

/**
 * The runtime's WebCrypto: the global one (browsers, Electron, Node 19+), else
 * `node:crypto`'s `webcrypto` (Node 18, which has no global `crypto`). Same
 * fallback as `sha256`, which stays as it shipped.
 */
async function webcrypto(): Promise<Crypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle && typeof g.crypto.getRandomValues === "function") return g.crypto;
  const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto?: Crypto };
  if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto;
  throw new Error("no WebCrypto available (needs crypto.subtle)");
}

/** WebCrypto's SubtleCrypto, with the `node:crypto` fallback. */
export async function subtle(): Promise<SubtleCrypto> {
  return (await webcrypto()).subtle;
}

/** `n` bytes from the platform CSPRNG, with the `node:crypto` fallback. */
export async function secureRandom(n: number): Promise<Uint8Array> {
  const c = await webcrypto();
  return c.getRandomValues(new Uint8Array(n));
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Strict base64url decoding (RFC 4648 §5, no padding): any other character, a
 * length that cannot come from whole bytes, or non-zero trailing bits throw.
 * Strict on purpose: the box decodes proofs with Go's RawURLEncoding.Strict().
 */
export function b64urlDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("base64url: impossible length");
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64URL.indexOf(s[i]!);
    if (v < 0) throw new Error("base64url: invalid character");
    acc = ((acc << 6) | v) & 0xffff; // at most 13 pending bits are ever needed
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("base64url: non-canonical trailing bits");
  return out;
}

/** UTF-8 → base64url. */
export function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
