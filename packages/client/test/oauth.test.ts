import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAuthorization,
  callbackFromParams,
  exchangeCode,
  isPlumIssuer,
  parseCallback,
  type CallbackResult,
} from "../src/oauth.js";
import { PlumOAuthError } from "../src/errors.js";
import type { HttpAdapter } from "../src/http.js";

// Node 18 has no global crypto; provide it for the PKCE helper under test.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

function textResponse(status: number, body: string) {
  return { status, headers: {}, body: new TextEncoder().encode(body).buffer as ArrayBuffer };
}

describe("beginAuthorization", () => {
  it("requires a registered clientId and at least one scope", async () => {
    await expect(
      beginAuthorization({ clientId: " ", redirectUri: "x://cb", scopes: ["files:read"] }),
    ).rejects.toThrow(/clientId is required/);
    await expect(
      beginAuthorization({ clientId: "com.example.notes:ios", redirectUri: "x://cb", scopes: [] }),
    ).rejects.toThrow(/scope/);
  });

  it("sends the scope vocabulary and omits client_name unless given", async () => {
    const req = await beginAuthorization({
      clientId: "com.example.notes:ios",
      redirectUri: "examplenotes://oauth/callback",
      scopes: ["files:read", "user:profile", "service:call:com.example.notes"],
    });
    const url = new URL(req.url);
    expect(url.searchParams.get("scope")).toBe("files:read user:profile service:call:com.example.notes");
    expect(url.searchParams.has("client_name")).toBe(false);
  });

  it("builds a portal URL with a valid S256 PKCE challenge", async () => {
    const req = await beginAuthorization({
      clientId: "obsidian-plum-sync",
      clientName: "Obsidian Sync",
      redirectUri: "obsidian://plum-sync/callback",
      scopes: ["read", "write"],
    });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://plumbox.me/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("obsidian-plum-sync");
    expect(url.searchParams.get("redirect_uri")).toBe("obsidian://plum-sync/callback");
    expect(url.searchParams.get("scope")).toBe("read write");

    // The challenge must equal base64url(SHA-256(verifier)) — the exact check
    // the box performs.
    const digest = new Uint8Array(
      await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(req.codeVerifier)),
    );
    const expected = Buffer.from(digest)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(expected);

    // Verifier length within RFC 7636 bounds; state present.
    expect(req.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(req.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(req.state.length).toBeGreaterThan(0);
  });

  describe("with no global crypto (Node 18 ES modules)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Node 18 gives a script or an ES module no global `crypto`; the polyfill
    // at the top of this file hid that. The verifier and state must fall back
    // to node:crypto just as the challenge does.
    it("still builds the request from node:crypto", async () => {
      vi.stubGlobal("crypto", undefined);
      expect((globalThis as { crypto?: unknown }).crypto).toBeUndefined();

      const a = await beginAuthorization({
        clientId: "com.example.notes:ios", redirectUri: "x://cb", scopes: ["files:read"],
      });
      const b = await beginAuthorization({
        clientId: "com.example.notes:ios", redirectUri: "x://cb", scopes: ["files:read"],
      });
      expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.state).not.toBe(b.state);

      const digest = new Uint8Array(
        await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(a.codeVerifier)),
      );
      const expected = Buffer.from(digest).toString("base64url");
      expect(new URL(a.url).searchParams.get("code_challenge")).toBe(expected);
    });
  });

  it("produces a fresh verifier and state each call", async () => {
    const a = await beginAuthorization({
      clientId: "x", clientName: "X", redirectUri: "obsidian://x/cb", scopes: ["read"],
    });
    const b = await beginAuthorization({
      clientId: "x", clientName: "X", redirectUri: "obsidian://x/cb", scopes: ["read"],
    });
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
  });
});

// v3 contract 10.1 and Appendix C ("SDK: iss 정규식 벡터"): the only iss a
// client accepts is a Plum box's canonical origin.
const LONGEST = "pb-" + "a".repeat(59); // 62-character DNS label
const GOOD_ISS = [
  "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me", // what relay names a box
  "https://pb-x.plumbox.me",
  "https://pb-a1.plumbox.me",
  "https://pb-old-style-name.plumbox.me", // not narrowed to hex: older names exist
  "https://pb-xlan.plumbox.me", // ends in "lan", but not the -lan alias
  `https://${LONGEST}.plumbox.me`,
];
const BAD_ISS: [string, unknown][] = [
  ["LAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-lan.plumbox.me"],
  ["WAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-wan.plumbox.me"],
  ["short LAN alias", "https://pb-x-lan.plumbox.me"],
  ["short WAN alias", "https://pb-x-wan.plumbox.me"],
  ["other domain", "https://pb-x.evil.example"],
  ["lookalike suffix", "https://pb-x.plumbox.me.evil.example"],
  ["other domain ending like ours", "https://pb-x.notplumbox.me"],
  ["the portal", "https://plumbox.me"],
  ["the relay", "https://relay.plumbox.me"],
  ["not a box name", "https://www.plumbox.me"],
  ["http", "http://pb-x.plumbox.me"],
  ["port", "https://pb-x.plumbox.me:443"],
  ["other port", "https://pb-x.plumbox.me:8443"],
  ["empty", ""],
  ["missing", undefined],
  ["null", null],
  ["not a string", 42],
  ["trailing slash", "https://pb-x.plumbox.me/"],
  ["path", "https://pb-x.plumbox.me/api"],
  ["query", "https://pb-x.plumbox.me?x=1"],
  ["fragment", "https://pb-x.plumbox.me#x"],
  ["user info", "https://user@pb-x.plumbox.me"],
  ["upper case", "https://PB-X.plumbox.me"],
  ["upper-case name", "https://pb-X.plumbox.me"],
  ["upper-case scheme", "HTTPS://pb-x.plumbox.me"],
  ["empty name", "https://pb-.plumbox.me"],
  ["name starts with a hyphen", "https://pb--x.plumbox.me"],
  ["name ends with a hyphen", "https://pb-x-.plumbox.me"],
  ["subdomain of a box", "https://a.pb-x.plumbox.me"],
  ["dot in the name", "https://pb-x.y.plumbox.me"],
  ["too long", `https://${LONGEST}a.plumbox.me`],
  ["leading space", " https://pb-x.plumbox.me"],
  ["trailing newline", "https://pb-x.plumbox.me\n"],
  ["trailing dot", "https://pb-x.plumbox.me."],
];

describe("isPlumIssuer", () => {
  it.each(GOOD_ISS)("accepts %s", (iss) => {
    expect(isPlumIssuer(iss)).toBe(true);
  });
  it.each(BAD_ISS)("refuses %s", (_name, iss) => {
    expect(isPlumIssuer(iss)).toBe(false);
  });
});

const cbURL = (q: string) => "myapp://plum/callback?" + q;
const enc = encodeURIComponent;

describe("parseCallback / callbackFromParams", () => {
  // Every case runs through both readers: the URL form and Obsidian's
  // params-object form must agree.
  const cases: [string, Record<string, string>, CallbackResult][] = [
    ["a code from a box", { code: "C1", state: "S", iss: GOOD_ISS[0]! }, { code: "C1", state: "S", iss: GOOD_ISS[0]! }],
    ["a code with no iss", { code: "C1", state: "S" }, { error: "invalid_iss", state: "S" }],
    ["a code with an empty iss", { code: "C1", state: "S", iss: "" }, { error: "invalid_iss", state: "S" }],
    ["a code from the LAN alias", { code: "C1", state: "S", iss: "https://pb-x-lan.plumbox.me" }, { error: "invalid_iss", state: "S" }],
    ["a code from the WAN alias", { code: "C1", state: "S", iss: "https://pb-x-wan.plumbox.me" }, { error: "invalid_iss", state: "S" }],
    ["a code from another domain", { code: "C1", state: "S", iss: "https://pb-x.evil.example" }, { error: "invalid_iss", state: "S" }],
    ["a code over http", { code: "C1", state: "S", iss: "http://pb-x.plumbox.me" }, { error: "invalid_iss", state: "S" }],
    ["a code with a port", { code: "C1", state: "S", iss: "https://pb-x.plumbox.me:8443" }, { error: "invalid_iss", state: "S" }],
    ["an error from an older box (no iss)", { error: "access_denied", state: "S" }, { error: "access_denied", state: "S" }],
    ["an error with the box's iss", { error: "access_denied", state: "S", iss: "https://pb-x.plumbox.me" }, { error: "access_denied", state: "S", iss: "https://pb-x.plumbox.me" }],
    ["an error with a bad iss", { error: "access_denied", state: "S", iss: "https://pb-x-lan.plumbox.me" }, { error: "invalid_iss", state: "S" }],
    ["an error and a code", { error: "access_denied", code: "C1", state: "S", iss: "https://pb-x.plumbox.me" }, { error: "access_denied", state: "S", iss: "https://pb-x.plumbox.me" }],
    ["neither code nor error", { state: "S", iss: "https://pb-x.plumbox.me" }, { error: "invalid_request", state: "S" }],
  ];
  it.each(cases)("%s", (_name, params, want) => {
    const q = Object.entries(params).map(([k, v]) => `${k}=${enc(v)}`).join("&");
    expect(parseCallback(cbURL(q))).toEqual(want);
    expect(callbackFromParams({ action: "plum-sync", ...params })).toEqual(want);
  });

  it("never hands back a code without a checked iss", () => {
    for (const [, iss] of BAD_ISS) {
      const params: Record<string, unknown> = { code: "C1", state: "S" };
      if (iss !== undefined) params.iss = iss;
      const fromParams = callbackFromParams(params);
      expect(fromParams.code).toBeUndefined();
      expect(fromParams.iss).toBeUndefined();
      expect(fromParams.error).toBe("invalid_iss");
      if (typeof iss === "string") {
        const fromURL = parseCallback(cbURL(`code=C1&state=S&iss=${enc(iss)}`));
        expect(fromURL.code).toBeUndefined();
        expect(fromURL.error).toBe("invalid_iss");
      }
    }
  });

  it("refuses an iss given twice, even when one of them is good", () => {
    const twice = parseCallback(cbURL(`code=C1&state=S&iss=${enc("https://pb-x.plumbox.me")}&iss=${enc("https://evil.example")}`));
    expect(twice).toEqual({ error: "invalid_iss", state: "S" });
    const reversed = parseCallback(cbURL(`code=C1&state=S&iss=${enc("https://evil.example")}&iss=${enc("https://pb-x.plumbox.me")}`));
    expect(reversed).toEqual({ error: "invalid_iss", state: "S" });
    expect(callbackFromParams({ code: "C1", state: "S", iss: ["https://pb-x.plumbox.me", "https://pb-x.plumbox.me"] })).toEqual({
      error: "invalid_iss",
      state: "S",
    });
  });

  it("refuses a code given twice", () => {
    expect(parseCallback(cbURL(`code=A&code=B&state=S&iss=${enc("https://pb-x.plumbox.me")}`))).toEqual({
      error: "invalid_request",
      state: "S",
      iss: "https://pb-x.plumbox.me",
    });
  });

  it("throws on a malformed URL", () => {
    expect(() => parseCallback("not a url")).toThrow();
  });
});

describe("exchangeCode", () => {
  const good = {
    baseUrl: "https://pb-x.plumbox.me",
    code: "CODE1",
    state: "ST",
    expectedState: "ST",
    codeVerifier: "VERIFIER1",
    clientId: "im.plum.obsidian-sync:obsidian",
    redirectUri: "obsidian://plum-sync",
  };
  // An adapter that records everything; the stop cases must leave it empty.
  function spy() {
    const sent: { url: string; body?: unknown }[] = [];
    const http: HttpAdapter = {
      async request(req) {
        sent.push({ url: req.url, body: req.body });
        return textResponse(200, `{"access_token":"plum_pat_abc","token_type":"bearer","scope":"files:read files:write"}`);
      },
    };
    return { sent, http };
  }

  it("POSTs the authorization_code grant to the iss and returns the token", async () => {
    const { sent, http } = spy();
    const out = await exchangeCode({ ...good, http });
    expect(out.accessToken).toBe("plum_pat_abc");
    expect(out.scope).toBe("files:read files:write");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://pb-x.plumbox.me/api/oauth/token");
    expect(JSON.parse(sent[0]!.body as string)).toEqual({
      grant_type: "authorization_code",
      code: "CODE1",
      code_verifier: "VERIFIER1",
      client_id: "im.plum.obsidian-sync:obsidian",
      redirect_uri: "obsidian://plum-sync",
    });
  });

  it.each(BAD_ISS)("sends nothing to %s (invalid_iss)", async (_name, iss) => {
    const { sent, http } = spy();
    const err = await exchangeCode({ ...good, baseUrl: iss as string, http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumOAuthError);
    expect((err as PlumOAuthError).code).toBe("invalid_iss");
    expect(sent).toEqual([]);
  });

  it.each([
    ["a different state", { state: "OTHER" }],
    ["no state on the callback", { state: undefined }],
    ["no expected state", { expectedState: undefined as unknown as string }],
    ["an empty expected state", { state: "", expectedState: "" }],
  ])("sends nothing for %s (invalid_state)", async (_name, change) => {
    const { sent, http } = spy();
    const err = await exchangeCode({ ...good, ...change, http }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlumOAuthError);
    expect((err as PlumOAuthError).code).toBe("invalid_state");
    expect(sent).toEqual([]);
  });

  it("sends nothing without a code or a verifier (invalid_request)", async () => {
    for (const change of [{ code: "" }, { codeVerifier: "" }]) {
      const { sent, http } = spy();
      await expect(exchangeCode({ ...good, ...change, http })).rejects.toMatchObject({ code: "invalid_request" });
      expect(sent).toEqual([]);
    }
  });

  it("exchanges exactly what a good callback carried, end to end", async () => {
    const cb = parseCallback(cbURL(`code=CODE1&state=ST&iss=${enc("https://pb-x.plumbox.me")}`));
    const { sent, http } = spy();
    await exchangeCode({ ...good, baseUrl: cb.iss!, code: cb.code!, state: cb.state, http });
    expect(sent.map((s) => s.url)).toEqual(["https://pb-x.plumbox.me/api/oauth/token"]);
  });

  it("throws on a non-200 token response", async () => {
    const http: HttpAdapter = {
      async request() {
        return textResponse(400, `{"error":"invalid_grant","error_description":"bad code"}`);
      },
    };
    await expect(exchangeCode({ ...good, code: "bad", http })).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
