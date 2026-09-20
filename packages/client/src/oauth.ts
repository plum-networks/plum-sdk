import { errorFromResponse } from "./errors.js";
import type { HttpAdapter } from "./http.js";
import { responseJSON, responseText } from "./http.js";
import { fetchAdapter } from "./adapters/fetch.js";
import type { OAuthScope } from "./types.js";

/**
 * Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for third-party
 * apps. The user authenticates on the Plum portal — NEVER inside your app — and
 * your app receives only a scoped, revocable token, never the password.
 *
 * Two halves:
 *   1. `beginAuthorization()` builds the portal URL + a PKCE verifier. Open the
 *      URL in the system browser; the user logs in and approves; the portal
 *      redirects back to your `redirectUri` with `?code=…&state=…`.
 *   2. `exchangeCode()` swaps that code (+ the verifier) for the access token at
 *      the box's token endpoint.
 *
 * Obsidian: register `obsidian://<your-id>/callback` via
 * `registerObsidianProtocolHandler`, pass it as `redirectUri`, and pass
 * `injectedAdapter(requestUrl)` as `http`.
 */

export const DEFAULT_PORTAL_URL = "https://plumbox.me";

export interface BeginAuthorizationOptions {
  /**
   * The client id you registered for this app in the Plum developer console
   * (`<app_id>:<label>`, e.g. `com.example.notes:ios`), or declared in your
   * app's manifest `clients[]`. The box refuses an unregistered client_id
   * with `unauthorized_client` before showing any consent screen.
   */
  clientId: string;
  /**
   * @deprecated The consent screen shows the display name from the client
   * registration; this value is ignored by boxes that know the registry. Kept
   * for older boxes, still sent when provided.
   */
  clientName?: string;
  /** Must equal one of the redirect URIs registered for the client (loopback http: any port). */
  redirectUri: string;
  /** Must be a subset of the scopes the client was registered with. */
  scopes: OAuthScope[];
  /** Portal that hosts the /authorize consent page. */
  portalUrl?: string;
}

export interface AuthorizationRequest {
  /** Open this in the system browser. */
  url: string;
  /** Keep until the redirect returns; needed to exchange the code. */
  codeVerifier: string;
  /** Opaque value echoed back in the redirect — verify it to prevent CSRF. */
  state: string;
}

export interface ExchangeCodeOptions {
  /**
   * The box base URL to exchange the code against, e.g.
   * https://pb-<sub>.plumbox.me. Read it from the callback's `iss` param
   * (see `parseCallback`) — your app never learned the box address by itself,
   * which is the whole point of routing auth through the portal.
   */
  baseUrl: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  http?: HttpAdapter;
}

export interface CallbackResult {
  code?: string;
  state?: string;
  /** The box origin that issued the code — pass as `baseUrl` to exchangeCode. */
  iss?: string;
  /** Present when the user denied or the box refused (e.g. "access_denied"). */
  error?: string;
}

/**
 * Parse the redirect the box sent back to your `redirect_uri`
 * (e.g. obsidian://plum-sync/callback?code=…&state=…&iss=…). Verify
 * `state === <the state from beginAuthorization>` yourself before exchanging —
 * a mismatch means a forged callback. Throws on a malformed URL.
 */
export function parseCallback(callbackUrl: string): CallbackResult {
  const u = new URL(callbackUrl);
  const g = (k: string): string | undefined => u.searchParams.get(k) ?? undefined;
  return { code: g("code"), state: g("state"), iss: g("iss"), error: g("error") };
}

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaShim(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function btoaShim(s: string): string {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.btoa === "function") return g.btoa(s);
  if (g.Buffer) return g.Buffer.from(s, "binary").toString("base64");
  throw new Error("no base64 encoder available");
}

function randomBytes(n: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const out = new Uint8Array(n);
  if (g.crypto?.getRandomValues) return g.crypto.getRandomValues(out);
  throw new Error("no secure RNG available");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const g = globalThis as { crypto?: Crypto };
  let subtle = g.crypto?.subtle;
  if (!subtle) {
    const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto?: Crypto };
    subtle = nodeCrypto.webcrypto?.subtle;
  }
  if (!subtle) throw new Error("no SubtleCrypto for PKCE");
  return new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

/**
 * Build the portal authorization URL and the PKCE material. The verifier and
 * `state` must survive until the redirect comes back.
 */
export async function beginAuthorization(
  opts: BeginAuthorizationOptions,
): Promise<AuthorizationRequest> {
  const clientId = (opts.clientId ?? "").trim();
  if (!clientId) {
    throw new Error("beginAuthorization: clientId is required (register one in the Plum developer console)");
  }
  if (!opts.scopes || opts.scopes.length === 0) {
    throw new Error("beginAuthorization: at least one scope is required");
  }
  const portal = (opts.portalUrl ?? DEFAULT_PORTAL_URL).replace(/\/+$/, "");
  // PKCE verifier: 43–128 chars from the unreserved set. 32 random bytes
  // base64url-encoded → 43 chars.
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(await sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64url(randomBytes(16));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  if (opts.clientName) params.set("client_name", opts.clientName);
  return { url: `${portal}/authorize?${params}`, codeVerifier, state };
}

/**
 * Exchange the authorization code for a scoped access token (PAT). Verify the
 * returned `state` matches what `beginAuthorization` produced BEFORE calling
 * this. Returns the token to store — the password was never seen by your app.
 *
 * Errors carry the box's OAuth code in `PlumApiError.code`:
 * `invalid_grant` (code used, expired or PKCE mismatch), `unauthorized_client`
 * (client_id not registered), `invalid_scope`, `invalid_redirect_uri`.
 */
export async function exchangeCode(
  opts: ExchangeCodeOptions,
): Promise<{ accessToken: string; scope: string }> {
  const http = opts.http ?? fetchAdapter;
  const res = await http.request({
    url: opts.baseUrl.replace(/\/+$/, "") + "/api/oauth/token",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (res.status !== 200) {
    throw errorFromResponse(res.status, responseText(res));
  }
  const body = responseJSON<{ access_token: string; scope: string }>(res);
  return { accessToken: body.access_token, scope: body.scope };
}
