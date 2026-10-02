// completeAuthorization against a fake box token endpoint (test/support/
// fake-box.ts), which judges every DPoP proof by the box rules of
// oauth-issuer.v3.md §6.3: only the validated issuer is called, with a proof
// the box accepts; one iat retry on the box's clock; C0 boxes still work.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptIssuerChange,
  completeAuthorization,
  startAuthorization,
  validateCallback,
  type AuthorizationOutcome,
  type IssuerExpectation,
  type PendingAuthorization,
} from "../src/authorize.js";
import { PlumApiError, PlumAuthError, PlumOAuthError } from "../src/errors.js";
import type { HttpAdapter, HttpRequest } from "../src/http.js";
import { b64urlDecode } from "../src/internal/crypto.js";
import { judge } from "./support/dpop-verifier.js";
import { fakeBox, fromEntryURL, header, jsonResponse } from "./support/fake-box.js";

const LOOPBACK = "http://127.0.0.1:53682/callback";
const BOX = "https://pb-1234.plumbox.me";
const OTHER = "https://pb-5678.plumbox.me";
const CLIENT = "dev.plum.bridgecheck:test";

afterEach(() => {
  vi.useRealTimers();
});

async function authorized(
  iss = BOX,
  expectation: IssuerExpectation = { mode: "discover" },
): Promise<{ pending: PendingAuthorization; outcome: AuthorizationOutcome; bound: ReturnType<typeof fromEntryURL> }> {
  const pending = await startAuthorization({ clientId: CLIENT, redirectUri: LOOPBACK, scopes: ["files:read"], expectation });
  const outcome = validateCallback(pending, `${LOOPBACK}?code=CODE1&iss=${encodeURIComponent(iss)}&state=${pending.state}`);
  return { pending, outcome, bound: fromEntryURL(pending.url) };
}

const claimsOf = (proof: string): { iat: number; htu: string; htm: string; jti: string } =>
  JSON.parse(new TextDecoder().decode(b64urlDecode(proof.split(".")[1]!))) as { iat: number; htu: string; htm: string; jti: string };

describe("completeAuthorization", () => {
  it("calls only the validated issuer, with the transaction's body and a proof the box accepts", async () => {
    const { outcome, bound } = await authorized();
    expect(outcome.kind).toBe("authorized");
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound });
    const grant = await completeAuthorization(outcome, { http: box.adapter });
    expect(grant).toEqual({ accessToken: "plum_pat_test", tokenType: "bearer", scope: "files:read", issuer: BOX });

    expect(box.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${BOX}/api/oauth/token`]);
    const req = box.requests[0]!;
    expect(JSON.parse(String(req.body))).toEqual({
      grant_type: "authorization_code",
      code: "CODE1",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_id: CLIENT,
      redirect_uri: LOOPBACK,
    });
    const proof = header(req, "DPoP")!;
    expect(claimsOf(proof)).toMatchObject({ htm: "POST", htu: `${BOX}/api/oauth/token` });
    // The proof's key is the one the entry URL committed to (dpop_jkt).
    const nowSec = Math.floor(Date.now() / 1000);
    expect(await judge([proof], bound.jkt, BOX, nowSec)).toEqual({ result: "accept", code_consumed: true });
    expect(await judge([proof], bound.jkt, "https://pb-evil.plumbox.me", nowSec)).toMatchObject({ result: "invalid_dpop_proof" });
  });

  it("re-signs once with plum_server_time when the phone clock is an hour behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const real = Date.now();
    vi.setSystemTime(real - 3600_000); // the phone
    const { outcome, bound } = await authorized();
    const boxNow = Math.floor(real / 1000);
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound, nowSec: () => boxNow });
    const grant = await completeAuthorization(outcome, { http: box.adapter });
    expect(grant.accessToken).toBe("plum_pat_test");
    expect(box.requests).toHaveLength(2);
    const [first, second] = box.requests.map((r) => claimsOf(header(r, "DPoP")!));
    expect(first!.iat).toBe(boxNow - 3600);
    expect(second!.iat).toBe(boxNow); // = plum_server_time, not the phone's clock
    expect(second!.jti).not.toBe(first!.jti);
    // The same code was redeemed: the first refusal happened before the lookup.
    expect(JSON.parse(String(box.requests[1]!.body)).code).toBe("CODE1");
  });

  it("re-signs once when the box's clock is wrong (box 1 h ahead)", async () => {
    const { outcome, bound } = await authorized();
    const boxNow = Math.floor(Date.now() / 1000) + 3600;
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound, nowSec: () => boxNow });
    await expect(completeAuthorization(outcome, { http: box.adapter })).resolves.toMatchObject({ issuer: BOX });
    expect(box.requests).toHaveLength(2);
  });

  it("retries only once", async () => {
    const { outcome } = await authorized();
    const requests: HttpRequest[] = [];
    const http: HttpAdapter = {
      async request(req) {
        requests.push(req);
        return jsonResponse(400, { error: "invalid_dpop_proof", plum_retry: "iat", plum_server_time: 1790000000 + requests.length });
      },
    };
    await expect(completeAuthorization(outcome, { http })).rejects.toMatchObject({ code: "invalid_dpop_proof", status: 400 });
    expect(requests).toHaveLength(2);
  });

  it("does not retry invalid_dpop_proof without plum_retry, nor a malformed plum_server_time", async () => {
    for (const body of [
      { error: "invalid_dpop_proof", error_description: "bad proof" },
      { error: "invalid_dpop_proof", plum_retry: "iat" },
      { error: "invalid_dpop_proof", plum_retry: "iat", plum_server_time: "1790000000" },
      { error: "invalid_grant", plum_retry: "iat", plum_server_time: 1790000000 },
    ]) {
      const { outcome } = await authorized();
      let n = 0;
      const http: HttpAdapter = { request: async () => (n++, jsonResponse(400, body)) };
      const err = await completeAuthorization(outcome, { http }).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(PlumApiError);
      expect((err as PlumApiError).code).toBe(body.error);
      expect(n, JSON.stringify(body)).toBe(1);
    }
  });

  it("works against a C0 box: no binding, today's 200 body", async () => {
    const { outcome, bound } = await authorized();
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound, c0: true });
    await expect(completeAuthorization(outcome, { http: box.adapter })).resolves.toEqual({
      accessToken: "plum_pat_test",
      tokenType: "bearer",
      scope: "files:read",
      issuer: BOX,
    });
  });

  it("reads token_type case-insensitively and refuses what it cannot use as a bearer token", async () => {
    const cases: [unknown, string | null][] = [
      [{ access_token: "t", token_type: "Bearer", scope: "s" }, "bearer"],
      [{ access_token: "t", scope: "s" }, "bearer"],
      [{ access_token: "t", token_type: "DPoP", scope: "s" }, null],
      [{ token_type: "bearer", scope: "s" }, null],
      ["not json", null],
    ];
    for (const [body, tokenType] of cases) {
      const { outcome } = await authorized();
      const http: HttpAdapter = { request: async () => jsonResponse(200, body as object) };
      const run = completeAuthorization(outcome, { http });
      if (tokenType) await expect(run, JSON.stringify(body)).resolves.toMatchObject({ tokenType });
      else await expect(run, JSON.stringify(body)).rejects.toMatchObject({ code: "bad_response" });
    }
  });

  it("surfaces box refusals as PlumApiError with the box's code", async () => {
    const { outcome, bound } = await authorized();
    const box = fakeBox({ issuer: BOX, code: "OTHER-CODE", ...bound });
    const err = await completeAuthorization(outcome, { http: box.adapter }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumApiError);
    expect(err).not.toBeInstanceOf(PlumAuthError);
    expect(err).toMatchObject({ status: 400, code: "invalid_grant" });
  });

  it("exchanges once per transaction", async () => {
    const { outcome, bound } = await authorized();
    const box = fakeBox({ issuer: BOX, code: "CODE1", ...bound });
    await completeAuthorization(outcome, { http: box.adapter });
    const again = completeAuthorization(outcome, { http: box.adapter });
    await expect(again).rejects.toBeInstanceOf(PlumOAuthError);
    await expect(again).rejects.toMatchObject({ code: "key_lost" });
    expect(box.requests).toHaveLength(1);
  });

  it("refuses outcomes it did not produce, and those that are not authorized", async () => {
    const http: HttpAdapter = { request: async () => { throw new Error("must not be called"); } };
    const { outcome } = await authorized();
    for (const o of [
      { kind: "authorized", issuer: BOX, match: "exact" },
      { ...outcome },
      { kind: "rejected", reason: "x" },
    ] as AuthorizationOutcome[]) {
      await expect(completeAuthorization(o, { http })).rejects.toMatchObject({ code: "invalid_outcome" });
    }
  });

  it("exchanges a confirmed issuer change at the NEW box, never the expected one", async () => {
    const { outcome, bound } = await authorized(OTHER, { mode: "known", issuer: BOX });
    expect(outcome).toEqual({ kind: "issuer_changed", issuer: OTHER, expected: BOX });
    await expect(completeAuthorization(outcome)).rejects.toMatchObject({ code: "invalid_outcome" });
    const box = fakeBox({ issuer: OTHER, code: "CODE1", ...bound });
    const grant = await completeAuthorization(acceptIssuerChange(outcome), { http: box.adapter });
    expect(grant.issuer).toBe(OTHER);
    expect(box.requests.map((r) => r.url)).toEqual([`${OTHER}/api/oauth/token`]);
  });

  it("a Dev box over http gets its proof with the http htu", async () => {
    const dev = "http://10.0.2.2:8080";
    const pending = await startAuthorization({
      clientId: CLIENT,
      redirectUri: LOOPBACK,
      scopes: ["files:read"],
      expectation: { mode: "dev", issuer: dev },
      policy: { allowDev: true },
    });
    expect(pending.url.startsWith(`${dev}/authorize?`)).toBe(true);
    const outcome = validateCallback(pending, `${LOOPBACK}?code=CODE1&iss=${encodeURIComponent(dev)}&state=${pending.state}`);
    expect(outcome).toEqual({ kind: "authorized", issuer: dev, match: "dev" });
    const box = fakeBox({ issuer: dev, code: "CODE1", ...fromEntryURL(pending.url) });
    await expect(completeAuthorization(outcome, { http: box.adapter })).resolves.toMatchObject({ issuer: dev });
    expect(claimsOf(header(box.requests[0]!, "DPoP")!).htu).toBe(`${dev}/api/oauth/token`);
  });
});
