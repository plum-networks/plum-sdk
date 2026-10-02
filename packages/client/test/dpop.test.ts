import { webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDPoPProof, generateDPoPKey, jwkThumbprint, publicJwk, thumbprintInput } from "../src/dpop.js";
import { b64url, b64urlDecode } from "../src/internal/crypto.js";
import { checkBound, judge, verifyStateless } from "./support/dpop-verifier.js";
import { vectors } from "./support/vectors.js";

const NOW = vectors.now_unix;
const ISSUER = "https://pb-1234.plumbox.me";
const HTU = ISSUER + "/api/oauth/token";

const hexToBytes = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const decodeJSON = (s: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as Record<string, unknown>;

/** The vector key as a WebCrypto key pair (d = SHA-256("plum-dpop-test-vector-v1") mod n). */
async function vectorKey(): Promise<CryptoKeyPair> {
  const { x, y } = vectors.key.jwk;
  const d = b64url(hexToBytes(vectors.key.d_hex));
  const alg = { name: "ECDSA", namedCurve: "P-256" };
  return {
    privateKey: await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d }, alg, false, ["sign"]),
    publicKey: await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, alg, true, ["verify"]),
  };
}

describe("thumbprint (RFC 7638)", () => {
  it("matches the vector key and its canonical input", async () => {
    expect(thumbprintInput(vectors.key.jwk)).toBe(vectors.key.thumbprint_input);
    expect(await jwkThumbprint(vectors.key.jwk)).toBe(vectors.key.jkt);
    expect(await jwkThumbprint(vectors.other_key.jwk)).toBe(vectors.other_key.jkt);
  });

  it("left-pads a short coordinate to 32 bytes, refuses a long one", async () => {
    const x = b64urlDecode(vectors.key.jwk.x);
    expect(x[0]).not.toBe(0);
    const short = { x: b64url(new Uint8Array([0, ...x.subarray(1)]).subarray(1)), y: vectors.key.jwk.y };
    const padded = { x: b64url(new Uint8Array([0, ...x.subarray(1)])), y: vectors.key.jwk.y };
    expect(await jwkThumbprint(short)).toBe(await jwkThumbprint(padded));
    await expect(jwkThumbprint({ x: b64url(new Uint8Array(33)), y: vectors.key.jwk.y })).rejects.toThrow();
  });
});

describe("proof vectors (box side, judged by the test port of dpop.go)", () => {
  it("has the 34 cases of v3", () => {
    expect(vectors.version).toBe(3);
    expect(vectors.cases).toHaveLength(34);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(await judge([c.proof], c.bound_jkt, c.bound_issuer, NOW)).toEqual(c.expect);
  });

  it("two DPoP headers are refused before the code lookup", async () => {
    const p = vectors.cases[0]!.proof;
    expect(await judge([p, p], vectors.key.jkt, ISSUER, NOW)).toEqual({
      result: "invalid_dpop_proof",
      code_consumed: false,
    });
  });

  it("bound code without a proof, unbound code without a proof, box without an issuer", async () => {
    expect(checkBound(null, vectors.key.jkt, ISSUER)).toBe("invalid_dpop_proof");
    expect(checkBound(null, "", ISSUER)).toBe("accept");
    const p = await verifyStateless([vectors.cases[0]!.proof], NOW);
    expect(checkBound(p, vectors.key.jkt, "")).toBe("invalid_dpop_proof");
  });

  it("every proof that passes the stateless checks verifies under subtle.verify", async () => {
    const mustVerify = vectors.cases.filter((c) => c.expect.code_consumed || c.expect.plum_retry === "iat");
    expect(mustVerify.length).toBeGreaterThan(10);
    for (const c of mustVerify) {
      const [h, p, s] = c.proof.split(".") as [string, string, string];
      const jwk = decodeJSON(h).jwk as { x: string; y: string };
      const key = await webcrypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const ok = await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        b64urlDecode(s),
        new TextEncoder().encode(h + "." + p),
      );
      expect(ok, c.name).toBe(true);
    }
  });
});

describe("proofs the SDK makes", () => {
  it("are accepted by the box rules at the vector time, for the vector key", async () => {
    const proof = await createDPoPProof(await vectorKey(), HTU, NOW);
    const p = await verifyStateless([proof], NOW);
    expect(p).toEqual({ jkt: vectors.key.jkt, htu: HTU });
    expect(checkBound(p, vectors.key.jkt, ISSUER)).toBe("accept");
    expect(checkBound(p, vectors.other_key.jkt, ISSUER)).toBe("invalid_grant");
    expect(checkBound(p, vectors.key.jkt, "https://pb-evil.plumbox.me")).toBe("invalid_dpop_proof");
  });

  it("have exactly the header and claims of §5.6, a fresh jti and a raw 64-byte signature", async () => {
    const key = await generateDPoPKey(false);
    const jwk = await publicJwk(key);
    const a = await createDPoPProof(key, HTU, NOW);
    const b = await createDPoPProof(key, HTU, NOW);
    const [h, p, s] = a.split(".") as [string, string, string];
    expect(decodeJSON(h)).toEqual({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } });
    const claims = decodeJSON(p);
    expect(Object.keys(claims).sort()).toEqual(["htm", "htu", "iat", "jti"]);
    expect(claims).toMatchObject({ htm: "POST", htu: HTU, iat: NOW });
    expect(b64urlDecode(claims.jti as string)).toHaveLength(16);
    expect(decodeJSON(b.split(".")[1]!).jti).not.toBe(claims.jti);
    expect(b64urlDecode(s)).toHaveLength(64);
    const verified = await verifyStateless([a], NOW);
    expect(verified.jkt).toBe(await jwkThumbprint(jwk));
    expect(verified.htu).toBe(HTU);
  });

  it("refuse a fractional or unsafe iat", async () => {
    const key = await generateDPoPKey(false);
    await expect(createDPoPProof(key, HTU, 1.5)).rejects.toThrow(TypeError);
    await expect(createDPoPProof(key, HTU, Number.NaN)).rejects.toThrow(TypeError);
  });

  it("keep the private key non-extractable unless the transaction is persistable", async () => {
    expect((await generateDPoPKey(false)).privateKey.extractable).toBe(false);
    expect((await generateDPoPKey(true)).privateKey.extractable).toBe(true);
  });

  // §11.2: core's dpop_crosscheck_test.go verifies one proof from every SDK.
  // PLUM_DPOP_CROSSCHECK_DIR=test/.out/dpop-crosscheck writes it beside the
  // tests; any other directory collects the three SDKs' files in one place.
  it.runIf(!!process.env.PLUM_DPOP_CROSSCHECK_DIR)("writes the cross-implementation proof (ts.txt)", async () => {
    const key = await generateDPoPKey(false);
    const jkt = await jwkThumbprint(await publicJwk(key));
    const proof = await createDPoPProof(key, HTU, 1790000000);
    expect(checkBound(await verifyStateless([proof], 1790000000), jkt, ISSUER)).toBe("accept");
    const dir = resolve(process.env.PLUM_DPOP_CROSSCHECK_DIR!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ts.txt"), `${jkt}\n${proof}`);
  });
});
