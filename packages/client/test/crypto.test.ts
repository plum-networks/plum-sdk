import { describe, expect, it } from "vitest";
import { b64url, b64urlDecode, secureRandom, subtle } from "../src/internal/crypto.js";

describe("internal crypto helpers", () => {
  it("base64url round-trips every length", async () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = await secureRandom(n);
      expect(b64urlDecode(b64url(bytes))).toEqual(bytes);
    }
  });

  it("decodes strictly, as the box does (Go RawURLEncoding.Strict)", () => {
    expect(b64urlDecode("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => b64urlDecode("AQI=")).toThrow(); // padding
    expect(() => b64urlDecode("AQ+D")).toThrow(); // standard alphabet
    expect(() => b64urlDecode("AQ/D")).toThrow();
    expect(() => b64urlDecode("AQIDB")).toThrow(); // 5 chars cannot be whole bytes
    expect(() => b64urlDecode("AR")).toThrow(); // trailing bits set ("AQ" is canonical)
    expect(b64urlDecode("AQ")).toEqual(new Uint8Array([1]));
  });

  it("reaches WebCrypto", async () => {
    const s = await subtle();
    const d = new Uint8Array(await s.digest("SHA-256", new TextEncoder().encode("abc")));
    expect(b64url(d)).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect((await secureRandom(16)).length).toBe(16);
  });
});
