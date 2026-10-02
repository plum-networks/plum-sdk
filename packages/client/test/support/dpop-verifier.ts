// TEST-ONLY port of the box-side verifier (oauth-issuer-v3-proto dpop.go,
// core internal/oauth/dpop.go): VerifyStateless (§6.3 steps 2-3) and
// CheckBound (steps 5-7). The SDK never verifies proofs; this exists so the
// shared proof vectors run here too, and so every proof the SDK makes is
// judged by the same rules a C1 box applies (fake box in complete.test.ts).
import { webcrypto } from "node:crypto";
import { b64url, b64urlDecode } from "../../src/internal/crypto.js";
import { jwkThumbprint } from "../../src/dpop.js";

export const MAX_PROOF_BYTES = 2048;
export const IAT_WINDOW_S = 600;

export type BoxVerdict = "accept" | "invalid_dpop_proof" | "invalid_grant";

/** A stateless failure; the code was not looked up. */
export class ProofError extends Error {
  constructor() {
    super("invalid_dpop_proof");
  }
}

/** The one stateless failure a client can fix: re-sign with iat = serverTime. */
export class IATError extends ProofError {
  constructor(readonly serverTime: number) {
    super();
  }
}

export interface Proof {
  jkt: string;
  htu: string;
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function decode(s: string): Uint8Array {
  try {
    return b64urlDecode(s);
  } catch {
    throw new ProofError();
  }
}

/** VerifyStateless: every check that does not need the code. */
export async function verifyStateless(headers: string[], nowSec: number): Promise<Proof> {
  if (headers.length !== 1 || headers[0]!.length === 0 || utf8Len(headers[0]!) > MAX_PROOF_BYTES) throw new ProofError();
  const parts = headers[0]!.split(".");
  if (parts.length !== 3) throw new ProofError();
  const hb = decode(parts[0]!);
  const pb = decode(parts[1]!);
  const sig = decode(parts[2]!);
  if (sig.length !== 64) throw new ProofError();

  let hdr: unknown;
  try {
    hdr = JSON.parse(new TextDecoder().decode(hb));
  } catch {
    throw new ProofError();
  }
  if (!isObject(hdr)) throw new ProofError();
  const { typ, alg, jwk } = hdr;
  if (typeof typ !== "string" || typeof alg !== "string" || !(jwk === null || isObject(jwk))) throw new ProofError();
  if (typ.toLowerCase() !== "dpop+jwt" || alg !== "ES256") throw new ProofError(); // typ: RFC 7515 §4.1.9
  if ("crit" in hdr) throw new ProofError();
  if (jwk === null || "d" in jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") throw new ProofError();
  const xb = decode(typeof jwk.x === "string" ? jwk.x : "");
  const yb = decode(typeof jwk.y === "string" ? jwk.y : "");
  if (xb.length !== 32 || yb.length !== 32) throw new ProofError();

  let pub: CryptoKey;
  try {
    // importKey refuses a point that is not on the curve.
    pub = await webcrypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64url(xb), y: b64url(yb) },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new ProofError();
  }
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pub,
    sig,
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) throw new ProofError();

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(pb));
  } catch {
    throw new ProofError();
  }
  if (claims !== null && !isObject(claims)) throw new ProofError();
  const c = claims ?? {};
  for (const k of ["htm", "htu", "jti"] as const) {
    if (k in c && c[k] !== null && typeof c[k] !== "string") throw new ProofError();
  }
  const htm = (c.htm as string | undefined) ?? "";
  const jti = (c.jti as string | undefined) ?? "";
  const iat = c.iat;
  if (htm !== "POST" || utf8Len(jti) < 1 || utf8Len(jti) > 128 || iat === undefined || iat === null) {
    throw new ProofError();
  }
  if (typeof iat !== "number" || !Number.isFinite(iat)) throw new ProofError();
  const iatSec = Math.trunc(iat);
  const htu = normaliseHTU((c.htu as string | undefined) ?? "");
  if (htu === null) throw new ProofError();
  const d = nowSec - iatSec;
  if (d > IAT_WINDOW_S || d < -IAT_WINDOW_S) throw new IATError(nowSec);
  return { jkt: await jwkThumbprint({ x: b64url(xb), y: b64url(yb) }), htu };
}

/**
 * normaliseHTU: absolute http(s) URL, no userinfo/query/fragment, path
 * exactly /api/oauth/token (no escapes); scheme+host lower-cased, default
 * port dropped. Null when it is not such a URL.
 */
export function normaliseHTU(raw: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m || m[4] !== undefined || m[5] !== undefined) return null;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if ((scheme !== "https" && scheme !== "http") || m[3] !== "/api/oauth/token" || authority.includes("@")) return null;
  let host: string;
  let port: string;
  const v6 = /^\[([0-9A-Fa-f:.]+)\](?::(\d*))?$/.exec(authority);
  if (v6) {
    host = v6[1]!.toLowerCase();
    port = v6[2] ?? "";
  } else {
    const hp = /^([A-Za-z0-9._~-]*)(?::(\d*))?$/.exec(authority);
    if (!hp) return null;
    host = hp[1]!.toLowerCase();
    port = hp[2] ?? "";
  }
  if (host === "") return null;
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  const h = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${h}${port ? ":" + port : ""}/api/oauth/token`;
}

/** CheckBound: after the code was looked up and deleted. */
export function checkBound(p: Proof | null, boundJKT: string, boundIssuer: string): BoxVerdict {
  if (p === null) return boundJKT !== "" ? "invalid_dpop_proof" : "accept";
  if (boundJKT !== "" && p.jkt !== boundJKT) return "invalid_grant";
  if (boundIssuer === "" || p.htu !== boundIssuer + "/api/oauth/token") return "invalid_dpop_proof";
  return "accept";
}

/** The whole token-endpoint judgement, shaped like a vector's `expect`. */
export async function judge(
  headers: string[],
  boundJKT: string,
  boundIssuer: string,
  nowSec: number,
): Promise<{ result: BoxVerdict; code_consumed: boolean; plum_retry?: "iat"; plum_server_time?: number }> {
  let p: Proof | null = null;
  if (headers.length > 0) {
    try {
      p = await verifyStateless(headers, nowSec);
    } catch (e) {
      if (e instanceof IATError) {
        return { result: "invalid_dpop_proof", code_consumed: false, plum_retry: "iat", plum_server_time: e.serverTime };
      }
      return { result: "invalid_dpop_proof", code_consumed: false };
    }
  }
  return { result: checkBound(p, boundJKT, boundIssuer), code_consumed: true };
}
