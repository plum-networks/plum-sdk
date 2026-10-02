// A fake box token endpoint behind an HttpAdapter. C1 mode applies the order
// of checks of oauth-issuer.v3.md §6.3 (stateless proof checks before the code
// lookup; the code is burned once looked up); C0 mode is today's endpoint,
// which ignores any DPoP header.
import { webcrypto } from "node:crypto";
import type { HttpAdapter, HttpRequest, HttpResponse } from "../../src/http.js";
import { b64url } from "../../src/internal/crypto.js";
import { checkBound, IATError, verifyStateless, type Proof } from "./dpop-verifier.js";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers, body: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

/** What a sign-in's entry URL committed the box to. */
export interface Authorized {
  issuer: string;
  code: string;
  jkt: string;
  challenge: string;
  clientId: string;
  redirectUri: string;
}

export interface FakeBoxOptions extends Authorized {
  /** Box clock, seconds. Default: Date.now(). */
  nowSec?: () => number;
  /** Behave like a shipped core: no DPoP checks, no binding. */
  c0?: boolean;
  /** Replace the 200 body. */
  tokenBody?: unknown;
}

export function header(req: HttpRequest, name: string): string | undefined {
  for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function fakeBox(o: FakeBoxOptions): { adapter: HttpAdapter; requests: HttpRequest[]; codeAlive: () => boolean } {
  const requests: HttpRequest[] = [];
  let alive = true;
  const now = o.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const adapter: HttpAdapter = {
    async request(req) {
      requests.push(req);
      if (req.method !== "POST" || req.url !== o.issuer + "/api/oauth/token") {
        return jsonResponse(404, { error: "not_found" });
      }
      const body = JSON.parse(String(req.body)) as Record<string, string>;
      if (body.grant_type !== "authorization_code") return jsonResponse(400, { error: "unsupported_grant_type" });
      let proof: Proof | null = null;
      const dpop = header(req, "dpop");
      if (!o.c0 && dpop !== undefined) {
        try {
          proof = await verifyStateless([dpop], now());
        } catch (e) {
          if (e instanceof IATError) {
            return jsonResponse(400, {
              error: "invalid_dpop_proof",
              error_description: "proof iat is outside the accepted window",
              plum_retry: "iat",
              plum_server_time: e.serverTime,
            });
          }
          return jsonResponse(400, { error: "invalid_dpop_proof", error_description: "bad proof" });
        }
      }
      // Step 4: look the code up and delete it before any further check.
      if (!alive || body.code !== o.code) return jsonResponse(400, { error: "invalid_grant", error_description: "code" });
      alive = false;
      if (
        body.client_id !== o.clientId ||
        body.redirect_uri !== o.redirectUri ||
        (await s256(body.code_verifier ?? "")) !== o.challenge
      ) {
        return jsonResponse(400, { error: "invalid_grant", error_description: "pkce/client" });
      }
      if (!o.c0) {
        const verdict = checkBound(proof, o.jkt, o.issuer);
        if (verdict !== "accept") return jsonResponse(400, { error: verdict, error_description: verdict });
      }
      return jsonResponse(200, o.tokenBody ?? { access_token: "plum_pat_test", token_type: "bearer", scope: "files:read" });
    },
  };
  return { adapter, requests, codeAlive: () => alive };
}

/** The bits of a PendingAuthorization's URL a box would bind. */
export function fromEntryURL(url: string): { jkt: string; challenge: string; state: string; clientId: string; redirectUri: string } {
  const u = new URL(url);
  const g = (k: string): string => u.searchParams.get(k) ?? "";
  return {
    jkt: g("dpop_jkt"),
    challenge: g("code_challenge"),
    state: g("state"),
    clientId: g("client_id"),
    redirectUri: g("redirect_uri"),
  };
}
