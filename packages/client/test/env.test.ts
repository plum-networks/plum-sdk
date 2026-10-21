// Plum's environments (S4): production is the default and does not move;
// each environment accepts only its own boxes, portal and relay.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  beginAuthorization,
  callbackFromParams,
  DEFAULT_PORTAL_URL,
  DEFAULT_RELAY_URL,
  discover,
  exchangeCode,
  isForeignUrl,
  isPlumIssuer,
  parseCallback,
  PlumClient,
  PlumOAuthError,
  plumEnvironment,
  PLUM_ISSUER_PATTERN,
  PRODUCTION,
  refreshTokens,
  STAGING,
} from "../src/index.js";
import type { HttpAdapter, HttpRequest } from "../src/http.js";

if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

const PROD_BOX = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me";
const STAG_BOX = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me";

function recorder(body: string): { http: HttpAdapter; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    http: {
      async request(req) {
        seen.push(req);
        return { status: 200, headers: {}, body: new TextEncoder().encode(body).buffer as ArrayBuffer };
      },
    },
  };
}

describe("production values", () => {
  it("are what the SDK always used", () => {
    expect({ ...PRODUCTION }).toEqual({
      name: "production",
      boxDomain: "plumbox.me",
      portalOrigin: "https://plumbox.me",
      relayUrl: "https://relay.plumbox.me",
    });
    expect(DEFAULT_PORTAL_URL).toBe("https://plumbox.me");
    expect(DEFAULT_RELAY_URL).toBe("https://relay.plumbox.me");
    expect(PLUM_ISSUER_PATTERN.source).toBe("^https:\\/\\/pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\\.plumbox\\.me$");
    expect(PLUM_ISSUER_PATTERN.flags).toBe("");
    expect(Object.isFrozen(PRODUCTION) && Object.isFrozen(STAGING)).toBe(true);
  });

  it("staging has its own", () => {
    expect({ ...STAGING }).toEqual({
      name: "staging",
      boxDomain: "staging.plumbox.me",
      portalOrigin: "https://staging.plumbox.me",
      relayUrl: "https://relay.staging.plumbox.me",
    });
  });

  it("no box domain is production; only two environments exist", () => {
    expect(plumEnvironment()).toBe(PRODUCTION);
    expect(plumEnvironment("")).toBe(PRODUCTION);
    expect(plumEnvironment("plumbox.me")).toBe(PRODUCTION);
    expect(plumEnvironment("STAGING.plumbox.me")).toBe(STAGING);
    for (const bad of ["dev.plumbox.me", ".plumbox.me", "plumbox.me.", "example.com", "staging"]) {
      expect(() => plumEnvironment(bad), bad).toThrow(/unknown Plum box domain/);
    }
  });
});

describe("each environment takes only its own addresses", () => {
  it("isForeignUrl", () => {
    expect(isForeignUrl(STAG_BOX, PRODUCTION)).toBe(true);
    expect(isForeignUrl("https://relay.staging.plumbox.me", PRODUCTION)).toBe(true);
    expect(isForeignUrl(PROD_BOX, PRODUCTION)).toBe(false);
    expect(isForeignUrl(PROD_BOX, STAGING)).toBe(true);
    expect(isForeignUrl("https://plumbox.me", STAGING)).toBe(true);
    expect(isForeignUrl(STAG_BOX, STAGING)).toBe(false);
    for (const env of [PRODUCTION, STAGING]) {
      expect(isForeignUrl("http://192.168.0.10:8443", env)).toBe(false);
      expect(isForeignUrl("http://127.0.0.1:8080", env)).toBe(false);
      expect(isForeignUrl("https://evilplumbox.me", env)).toBe(false);
      expect(isForeignUrl("not a url", env)).toBe(false);
    }
  });

  it("isPlumIssuer", () => {
    expect(isPlumIssuer(PROD_BOX)).toBe(true);
    expect(isPlumIssuer(STAG_BOX)).toBe(false);
    expect(isPlumIssuer(STAG_BOX, "staging.plumbox.me")).toBe(true);
    expect(isPlumIssuer(PROD_BOX, "staging.plumbox.me")).toBe(false);
    expect(isPlumIssuer("https://pb-x-lan.staging.plumbox.me", "staging.plumbox.me")).toBe(false);
    expect(isPlumIssuer("https://pb-x-wan.staging.plumbox.me", "staging.plumbox.me")).toBe(false);
    expect(isPlumIssuer("https://pb-xlan.staging.plumbox.me", "staging.plumbox.me")).toBe(true);
    expect(isPlumIssuer("https://pb-xXstagingYplumboxZme.staging.plumbox.me", "staging.plumbox.me")).toBe(false);
    expect(isPlumIssuer("https://pb-x.stagingXplumbox.me", "staging.plumbox.me")).toBe(false);
    expect(isPlumIssuer("https://pb-x.staging.plumboxXme", "staging.plumbox.me")).toBe(false);
    expect(() => isPlumIssuer(PROD_BOX, "example.com")).toThrow(/unknown/);
  });

  it("the callback", () => {
    expect(parseCallback(`app://cb?code=C&state=S&iss=${encodeURIComponent(STAG_BOX)}`)).toEqual({ error: "invalid_iss", state: "S" });
    expect(parseCallback(`app://cb?code=C&state=S&iss=${encodeURIComponent(STAG_BOX)}`, { boxDomain: "staging.plumbox.me" })).toEqual({
      code: "C",
      state: "S",
      iss: STAG_BOX,
    });
    expect(callbackFromParams({ code: "C", state: "S", iss: PROD_BOX }, { boxDomain: "staging.plumbox.me" })).toEqual({
      error: "invalid_iss",
      state: "S",
    });
    expect(callbackFromParams({ code: "C", state: "S", iss: PROD_BOX })).toEqual({ code: "C", state: "S", iss: PROD_BOX });
    expect(() => parseCallback("app://cb?code=C", { boxDomain: "dev.plumbox.me" })).toThrow(/unknown/);
  });

  it("the code exchange sends nothing to another environment's box", async () => {
    const base = { code: "C", state: "S", expectedState: "S", codeVerifier: "V", clientId: "a:b", redirectUri: "app://cb" };
    for (const [baseUrl, boxDomain] of [
      [STAG_BOX, undefined],
      [PROD_BOX, "staging.plumbox.me"],
    ] as const) {
      const { http, seen } = recorder("{}");
      await expect(exchangeCode({ ...base, baseUrl, boxDomain, http })).rejects.toBeInstanceOf(PlumOAuthError);
      expect(seen).toEqual([]);
    }
    const { http, seen } = recorder('{"access_token":"plum_pat_x","scope":"files:read"}');
    await expect(exchangeCode({ ...base, baseUrl: STAG_BOX, boxDomain: "staging.plumbox.me", http })).resolves.toEqual({
      accessToken: "plum_pat_x",
      tokenType: "bearer",
      scope: "files:read",
    });
    expect(seen.map((r) => r.url)).toEqual([STAG_BOX + "/api/oauth/token"]);
    await expect(exchangeCode({ ...base, baseUrl: PROD_BOX, boxDomain: "staging.plumbox.me", http })).rejects.toThrow(
      "(https://pb-….staging.plumbox.me)",
    );
    await expect(exchangeCode({ ...base, baseUrl: STAG_BOX, http })).rejects.toThrow("(https://pb-….plumbox.me)");
  });

  it("a refresh sends nothing to another environment's box", async () => {
    const base = { clientId: "a:b", refreshToken: "plum_rt_1" };
    for (const [iss, boxDomain] of [
      [STAG_BOX, undefined],
      [PROD_BOX, "staging.plumbox.me"],
    ] as const) {
      const { http, seen } = recorder("{}");
      await expect(refreshTokens({ ...base, iss, boxDomain, http })).rejects.toBeInstanceOf(PlumOAuthError);
      expect(seen).toEqual([]);
    }
    const { http, seen } = recorder('{"access_token":"plum_pat_y","refresh_token":"plum_rt_2","expires_in":3600}');
    await expect(refreshTokens({ ...base, iss: STAG_BOX, boxDomain: "staging.plumbox.me", http })).resolves.toMatchObject({
      accessToken: "plum_pat_y",
      refreshToken: "plum_rt_2",
    });
    expect(seen.map((r) => r.url)).toEqual([STAG_BOX + "/api/oauth/token"]);
  });

  it("a PlumClient refreshes only at its own environment's box", () => {
    const tok = { token: "plum_pat_x", refreshToken: "plum_rt_1", clientId: "a:b" };
    expect(() => new PlumClient({ baseUrl: STAG_BOX, boxDomain: "staging.plumbox.me", ...tok })).not.toThrow();
    expect(() => new PlumClient({ baseUrl: "http://192.168.0.10:8443", iss: STAG_BOX, ...tok })).toThrow(/verified iss/);
    expect(
      () => new PlumClient({ baseUrl: "http://192.168.0.10:8443", iss: STAG_BOX, boxDomain: "staging.plumbox.me", ...tok }),
    ).not.toThrow();
  });

  it("the authorization starts at the environment's portal", async () => {
    const opts = { clientId: "a:b", redirectUri: "app://cb", scopes: ["files:read" as const] };
    expect((await beginAuthorization(opts)).url).toMatch(/^https:\/\/plumbox\.me\/authorize\?/);
    expect((await beginAuthorization({ ...opts, boxDomain: "staging.plumbox.me" })).url).toMatch(
      /^https:\/\/staging\.plumbox\.me\/authorize\?/,
    );
  });

  it("the deprecated discover uses the environment's relay and box domain", async () => {
    const { http, seen } = recorder('{"subdomain":"pb-abc"}');
    expect(await discover("a@example.com", { http })).toEqual({ subdomain: "pb-abc", baseUrl: "https://pb-abc.plumbox.me" });
    expect(await discover("a@example.com", { http, boxDomain: "staging.plumbox.me" })).toEqual({
      subdomain: "pb-abc",
      baseUrl: "https://pb-abc.staging.plumbox.me",
    });
    expect(seen.map((r) => r.url)).toEqual([
      "https://relay.plumbox.me/api/lookup",
      "https://relay.staging.plumbox.me/api/lookup",
    ]);
  });

  it("PlumClient", () => {
    const prod = new PlumClient({ baseUrl: PROD_BOX + "/" });
    expect([prod.baseUrl, prod.boxDomain, prod.portalOrigin]).toEqual([PROD_BOX, "plumbox.me", "https://plumbox.me"]);
    const stag = new PlumClient({ baseUrl: STAG_BOX, boxDomain: "staging.plumbox.me" });
    expect([stag.boxDomain, stag.portalOrigin]).toEqual(["staging.plumbox.me", "https://staging.plumbox.me"]);
    expect(() => new PlumClient({ baseUrl: STAG_BOX })).toThrow(/not a box of plumbox\.me/);
    expect(() => new PlumClient({ baseUrl: PROD_BOX, boxDomain: "staging.plumbox.me" })).toThrow(/not a box of staging/);
    expect(() => new PlumClient({ baseUrl: STAG_BOX, boxDomain: "staging.plumbox.me", portalOrigin: "https://plumbox.me" })).toThrow(
      /not the portal/,
    );
    expect(() => new PlumClient({ baseUrl: PROD_BOX, portalOrigin: "https://staging.plumbox.me" })).toThrow(/not the portal/);
    expect(() => new PlumClient({ baseUrl: PROD_BOX, boxDomain: "dev.plumbox.me" })).toThrow(/unknown/);
    for (const boxDomain of [undefined, "staging.plumbox.me"]) {
      expect(new PlumClient({ baseUrl: "http://192.168.0.10:8443", boxDomain }).baseUrl).toBe("http://192.168.0.10:8443");
    }
  });
});
