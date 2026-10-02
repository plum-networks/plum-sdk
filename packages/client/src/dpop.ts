// DPoP for the bound OAuth flow (RFC 9449; oauth-issuer.v3.md §5.6). One
// ES256 key per authorization attempt; its RFC 7638 thumbprint goes into the
// authorization request as dpop_jkt, and the token request carries a proof
// signed by it. A C1 box binds the code to that key and to the issuer that
// minted it, so a stolen code + verifier is useless without the key, and a
// proof made for another box is useless at this one. Internal: the package
// exports the flow (authorize.ts), not these primitives.

import { b64url, b64urlDecode, b64urlText, secureRandom, sha256, subtle } from "./internal/crypto.js";

/** The public half of a DPoP key, as it appears in the proof header. */
export interface DPoPPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

const KEY_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * A fresh P-256 key pair. Non-extractable unless `persistable`: only a
 * transaction that must survive a restart (an Obsidian deep link arrives in a
 * new plugin instance) needs to write its private key down.
 */
export async function generateDPoPKey(persistable: boolean): Promise<CryptoKeyPair> {
  const s = await subtle();
  return (await s.generateKey(KEY_ALG, persistable, ["sign", "verify"])) as CryptoKeyPair;
}

/** A 32-byte P-256 coordinate from its base64url form, left-padded if short. */
function coordinate(s: string): Uint8Array {
  const raw = b64urlDecode(s);
  if (raw.length > 32) throw new Error("dpop: P-256 coordinate longer than 32 bytes");
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

/**
 * The RFC 7638 thumbprint input: required members in lexicographic order, no
 * whitespace, coordinates re-encoded from their 32 decoded bytes (the box
 * computes it the same way, never from the strings it received).
 */
export function thumbprintInput(jwk: { x: string; y: string }): string {
  return `{"crv":"P-256","kty":"EC","x":"${b64url(coordinate(jwk.x))}","y":"${b64url(coordinate(jwk.y))}"}`;
}

/** RFC 7638 JWK SHA-256 thumbprint, base64url: the `dpop_jkt` the code is bound to. */
export async function jwkThumbprint(jwk: { x: string; y: string }): Promise<string> {
  return b64url(await sha256(new TextEncoder().encode(thumbprintInput(jwk))));
}

/** The public JWK of a key, with exactly the members a proof header carries. */
export async function publicJwk(key: CryptoKeyPair): Promise<DPoPPublicJwk> {
  const jwk = (await (await subtle()).exportKey("jwk", key.publicKey)) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("dpop: not a P-256 key");
  return { kty: "EC", crv: "P-256", x: b64url(coordinate(jwk.x)), y: b64url(coordinate(jwk.y)) };
}

/**
 * A DPoP proof for `POST htu` at `iat` (whole seconds):
 * header `{"typ":"dpop+jwt","alg":"ES256","jwk":{kty,crv,x,y}}`,
 * payload `{"jti":<16 random bytes>,"htm":"POST","htu":…,"iat":…}`, and the
 * raw 64-byte r‖s signature WebCrypto produces (not DER).
 */
export async function createDPoPProof(key: CryptoKeyPair, htu: string, iat: number): Promise<string> {
  if (!Number.isSafeInteger(iat)) throw new TypeError("dpop: iat must be whole seconds");
  const jwk = await publicJwk(key);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk };
  const payload = { jti: b64url(await secureRandom(16)), htm: "POST", htu, iat };
  const input = b64urlText(JSON.stringify(header)) + "." + b64urlText(JSON.stringify(payload));
  const sig = new Uint8Array(
    await (await subtle()).sign(SIGN_ALG, key.privateKey, new TextEncoder().encode(input) as unknown as BufferSource),
  );
  if (sig.length !== 64) throw new Error("dpop: ES256 signature is not raw r||s");
  return input + "." + b64url(sig);
}
