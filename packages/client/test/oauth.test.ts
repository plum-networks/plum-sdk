import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginAuthorization, exchangeCode, parseCallback } from "../src/oauth.js";
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

describe("exchangeCode", () => {
  it("POSTs the authorization_code grant and returns the token", async () => {
    let seen: unknown;
    const http: HttpAdapter = {
      async request(req) {
        seen = JSON.parse(req.body as string);
        expect(req.url).toBe("https://pb-x.plumbox.me/api/oauth/token");
        return textResponse(200, `{"access_token":"plum_pat_abc","token_type":"bearer","scope":"read write"}`);
      },
    };
    const out = await exchangeCode({
      baseUrl: "https://pb-x.plumbox.me",
      code: "CODE1",
      codeVerifier: "VERIFIER1",
      clientId: "obsidian-plum-sync",
      redirectUri: "obsidian://plum-sync/callback",
      http,
    });
    expect(out.accessToken).toBe("plum_pat_abc");
    expect(out.scope).toBe("read write");
    expect(seen).toEqual({
      grant_type: "authorization_code",
      code: "CODE1",
      code_verifier: "VERIFIER1",
      client_id: "obsidian-plum-sync",
      redirect_uri: "obsidian://plum-sync/callback",
    });
  });

  it("parseCallback extracts code, state, iss and error", () => {
    const ok = parseCallback("obsidian://plum-sync/callback?code=CODE1&state=ST&iss=https%3A%2F%2Fpb-x.plumbox.me");
    expect(ok.code).toBe("CODE1");
    expect(ok.state).toBe("ST");
    expect(ok.iss).toBe("https://pb-x.plumbox.me");
    expect(ok.error).toBeUndefined();

    const denied = parseCallback("obsidian://plum-sync/callback?error=access_denied&state=ST");
    expect(denied.error).toBe("access_denied");
    expect(denied.code).toBeUndefined();
  });

  it("throws on a non-200 token response", async () => {
    const http: HttpAdapter = {
      async request() {
        return textResponse(400, `{"error":"invalid_grant","error_description":"bad code"}`);
      },
    };
    await expect(
      exchangeCode({
        baseUrl: "https://pb-x.plumbox.me",
        code: "bad",
        codeVerifier: "v",
        clientId: "x",
        redirectUri: "obsidian://x/cb",
        http,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
