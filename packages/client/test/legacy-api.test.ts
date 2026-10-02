// The 0.2.0 surface is on npm, and two shipped apps (obsidian-plum-sync,
// desktop-plum-sync) import beginAuthorization / parseCallback / exchangeCode
// and the CallbackResult type. Their redirects keep working against every core
// until the legacy cutoff, so 0.3.0 must not change any of it: not a name, not
// a parameter, not a line of behaviour. Only JSDoc (@deprecated) may move.
//
// The snapshot in fixtures/legacy-0.2.0.json was generated from git 2a0ee84
// (the 0.2.0 source) and is compared against the current tree here.
import { webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as entry from "../src/index.js";
import {
  beginAuthorization,
  exchangeCode,
  parseCallback,
  type AuthorizationRequest,
  type BeginAuthorizationOptions,
  type CallbackResult,
  type ExchangeCodeOptions,
} from "../src/index.js";
import type { HttpAdapter } from "../src/http.js";
import type { OAuthScope } from "../src/types.js";
import { exportClauses, printDeclarations } from "./support/declarations.js";

// Node 18 has no global crypto; the legacy PKCE helper reads it from there.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

interface LegacySnapshot {
  base: string;
  valueExports: Record<string, string>;
  typeExports: string[];
  oauthDeclarations: Record<string, string>;
  oauthHelpers: Record<string, string>;
  indexOauthLines: string;
}

const SRC = join(__dirname, "..", "src");
const legacy = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "legacy-0.2.0.json"), "utf8"),
) as LegacySnapshot;
const read = (p: string): string => readFileSync(join(SRC, p), "utf8");
const indexTs = read("index.ts");

describe("0.2.0 public surface (snapshot from git " + legacy.base + ")", () => {
  it("still exports every 0.2.0 value, as the same kind of value", () => {
    const now = entry as Record<string, unknown>;
    const got: Record<string, string> = {};
    for (const name of Object.keys(legacy.valueExports)) got[name] = typeof now[name];
    expect(got).toEqual(legacy.valueExports);
    expect(entry.DEFAULT_PORTAL_URL).toBe("https://plumbox.me");
  });

  it("still exports every 0.2.0 type from a type-only clause", () => {
    const typeNames = new Set(exportClauses(indexTs).filter((c) => c.typeOnly).flatMap((c) => c.names));
    expect(legacy.typeExports.filter((n) => !typeNames.has(n))).toEqual([]);
  });

  it("keeps the 0.2.0 OAuth export lines of index.ts verbatim", () => {
    expect(indexTs).toContain(legacy.indexOauthLines);
  });

  it("keeps every 0.2.0 OAuth declaration byte for byte (comments aside)", () => {
    const names = Object.keys(legacy.oauthDeclarations);
    expect(printDeclarations(read("oauth.ts"), names)).toEqual(legacy.oauthDeclarations);
  });

  it("keeps the PKCE helpers the legacy functions call byte for byte, wherever they live", () => {
    const names = Object.keys(legacy.oauthHelpers);
    const found: Record<string, string> = {};
    for (const file of ["oauth.ts", "internal/crypto.ts"]) {
      if (!existsSync(join(SRC, file))) continue;
      for (const [k, v] of Object.entries(printDeclarations(read(file), names))) if (v) found[k] = v;
    }
    expect(found).toEqual(legacy.oauthHelpers);
  });

  it("keeps the 0.2.0 types assignable both ways (checked by `npm run typecheck`)", () => {
    // Exact structural copies of the 0.2.0 declarations. toEqualTypeOf fails
    // the type check if a member is added, removed, renamed or retyped.
    expectTypeOf<CallbackResult>().toEqualTypeOf<{
      code?: string;
      state?: string;
      iss?: string;
      error?: string;
    }>();
    expectTypeOf<AuthorizationRequest>().toEqualTypeOf<{ url: string; codeVerifier: string; state: string }>();
    expectTypeOf<BeginAuthorizationOptions>().toEqualTypeOf<{
      clientId: string;
      clientName?: string;
      redirectUri: string;
      scopes: OAuthScope[];
      portalUrl?: string;
    }>();
    expectTypeOf<ExchangeCodeOptions>().toEqualTypeOf<{
      baseUrl: string;
      code: string;
      codeVerifier: string;
      clientId: string;
      redirectUri: string;
      http?: HttpAdapter;
    }>();
    expectTypeOf(parseCallback).toEqualTypeOf<(callbackUrl: string) => CallbackResult>();
    expectTypeOf(beginAuthorization).toEqualTypeOf<
      (opts: BeginAuthorizationOptions) => Promise<AuthorizationRequest>
    >();
    expectTypeOf(exchangeCode).toEqualTypeOf<
      (opts: ExchangeCodeOptions) => Promise<{ accessToken: string; scope: string }>
    >();
  });

  it("beginAuthorization still sends no dpop_jkt (the legacy flow stays unbound)", async () => {
    const req = await beginAuthorization({
      clientId: "obsidian-plum-sync",
      redirectUri: "obsidian://plum-sync",
      scopes: ["read", "write"],
    });
    const url = new URL(req.url);
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"],
    );
    expect(url.hash).toBe("");
  });
});
