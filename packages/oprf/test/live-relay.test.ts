import { describe, expect, it } from "vitest";
import { getSodium, lookupId, deriveSeed, oprfBlind, oprfFinalize } from "../src/crypto.js";
import { resolveBoxes } from "../src/resolve.js";

// Opt-in live check against the deployed relay (relay.plumbox.me). Proves the
// wire contract end to end against the REAL OPRF key:
//   PLUM_LIVE_RELAY=1 npx vitest run test/live-relay.test.ts
const enabled = process.env.PLUM_LIVE_RELAY === "1";
const relayUrl = process.env.PLUM_RELAY_URL ?? "https://relay.plumbox.me";

describe.runIf(enabled)("live relay OPRF", () => {
  it("evaluates a blind and yields a well-formed 32-byte token", async () => {
    const lookup = await lookupId(await deriveSeed("nobody@example.com", "pw"));
    const { r, blindedHex } = await oprfBlind(lookup);
    const res = await fetch(`${relayUrl}/api/oprf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blinded: blindedHex }),
    });
    expect(res.status).toBe(200);
    const { evaluated } = (await res.json()) as { evaluated: string };
    expect(evaluated).toMatch(/^[0-9a-f]{64}$/);
    const token = await oprfFinalize(lookup, r, evaluated);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("determinism: same credential → same evaluated element (unblinded)", async () => {
    const sodium = await getSodium();
    const lookup = await lookupId(await deriveSeed("determinism@example.com", "pw"));
    const evalOnce = async () => {
      const { r, blindedHex } = await oprfBlind(lookup);
      const res = await fetch(`${relayUrl}/api/oprf`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blinded: blindedHex }),
      });
      const { evaluated } = (await res.json()) as { evaluated: string };
      // Unblind to k*H2C(lookup), which is blind-independent.
      const E = sodium.from_hex(evaluated);
      const rInv = sodium.crypto_core_ristretto255_scalar_invert(r);
      return sodium.to_hex(sodium.crypto_scalarmult_ristretto255(rInv, E));
    };
    expect(await evalOnce()).toBe(await evalOnce());
  });

  it("resolveBoxes returns [] for an unknown credential (uniform 404, no oracle)", async () => {
    const boxes = await resolveBoxes("no-such-user@example.com", "whatever", { relayUrl });
    expect(boxes).toEqual([]);
  });
});

describe.runIf(!enabled)("live relay (skipped)", () => {
  it("set PLUM_LIVE_RELAY=1 to run against relay.plumbox.me", () => {
    expect(true).toBe(true);
  });
});
