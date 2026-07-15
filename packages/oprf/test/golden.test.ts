import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import _sodium from "libsodium-wrappers-sumo";
import {
  deriveSeed,
  getSodium,
  lookupId,
  oprfBlind,
  oprfFinalize,
} from "../src/crypto.js";

// The SAME golden vectors the box's Go tests pin
// (plum-box-core/internal/routing/{derive,oprf}_test.go). If these pass, the
// JS derivation is byte-identical to the box, the portal, and the apps.
const EMAIL = "alice@example.com";
const SECRET = "correct horse battery staple";
const WANT_SEED = "034f97dcfb20b419771cc223165618864311d07b2a4c501bc153ccc71b4a1f99";
const WANT_LOOKUP = "48a1ffa677e0ef8200304be5ae1bc1ff0e04c2e8cd9b7eb1aea4bef08cca61ec";
// OPRF key k = scalar_reduce(bytes 0x01..0x40); token for the vector above.
const WANT_TOKEN = "549ec88460d1a08b16cc2d26daf401369cc2e6e8595e7861014fb08bc93274bd";

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

describe("frozen crypto contract (golden vectors)", () => {
  it("deriveSeed + lookupId match the Go golden vectors", async () => {
    const seed = await deriveSeed(EMAIL, SECRET);
    expect(hex(seed)).toBe(WANT_SEED);
    const lookup = await lookupId(seed);
    expect(hex(lookup)).toBe(WANT_LOOKUP);
  });

  it("email is normalized (case/space), secret is not", async () => {
    const a = hex(await deriveSeed("  Alice@Example.COM ", "pw"));
    expect(a).toBe(hex(await deriveSeed("alice@example.com", "pw")));
    expect(a).not.toBe(hex(await deriveSeed("alice@example.com", "PW")));
    expect(a).not.toBe(hex(await deriveSeed("alice@example.com", " pw")));
  });

  it("full OPRF round-trip reproduces the token against a local k = 0x01..0x40", async () => {
    // Reproduce the relay's k*B step in-process with the fixed test key, so we
    // verify blind → eval → unblind → finalize end to end without the network.
    const sodium = await getSodium();
    const k = sodium.crypto_core_ristretto255_scalar_reduce(
      Uint8Array.from({ length: 64 }, (_, i) => i + 1),
    );
    const lookup = await lookupId(await deriveSeed(EMAIL, SECRET));
    const { r, blindedHex } = await oprfBlind(lookup);
    const B = sodium.from_hex(blindedHex);
    const evaluated = sodium.to_hex(sodium.crypto_scalarmult_ristretto255(k, B));
    const token = await oprfFinalize(lookup, r, evaluated);
    expect(token).toBe(WANT_TOKEN);
  });
});

describe("seal/open interop (round-trip through libsodium)", () => {
  it("openLocator opens a blob sealed the same way the box seals it", async () => {
    // Seal a locator EXACTLY like plum-box-core/internal/routing.SealLocator
    // (nonce||commit||XChaCha20Poly1305(encKey, nonce, pt, ad=commit)), then
    // confirm our openLocator recovers it and rejects a wrong-key blob.
    await _sodium.ready;
    const s = _sodium;
    const { openLocator } = await import("../src/crypto.js");

    // Derive enc/commit exactly as the contract (HKDF-SHA256, 32 zero salt).
    const subtle = webcrypto.subtle;
    const seed = await deriveSeed("bob@example.com", "hunter2");
    const hkdf = async (label: string) => {
      const key = await subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
      return new Uint8Array(
        await subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(label) },
          key,
          256,
        ),
      );
    };
    const encKey = await hkdf("plum-routing-aead-v1");
    const commit = await hkdf("plum-routing-commit-v1");
    const pt = new TextEncoder().encode(JSON.stringify({ sub: "pb-deadbeef", label: "Bob's Box" }));
    const nonce = s.randombytes_buf(24);
    const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, commit, null, nonce, encKey);
    const blob = new Uint8Array(24 + 32 + ct.length);
    blob.set(nonce, 0);
    blob.set(commit, 24);
    blob.set(ct, 56);

    const loc = await openLocator(seed, blob);
    expect(loc.sub).toBe("pb-deadbeef");
    expect(loc.label).toBe("Bob's Box");

    const wrongSeed = await deriveSeed("bob@example.com", "wrong");
    await expect(openLocator(wrongSeed, blob)).rejects.toThrow(/wrong key/);
  });
});
