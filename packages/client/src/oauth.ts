import { errorFromResponse, PlumOAuthError } from "./errors.js";
import type { HttpAdapter } from "./http.js";
import { responseJSON, responseText } from "./http.js";
import { fetchAdapter } from "./adapters/fetch.js";
import type { OAuthScope } from "./types.js";
import { plumEnvironment, PRODUCTION } from "./env.js";

/**
 * Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for third-party
 * apps. The user finds their box on plumbox.me (their email and a code Plum
 * mails them) and types the password only on that box's own page — NEVER
 * inside your app. Your app receives a scoped, revocable token, never the
 * password.
 *
 * Two halves:
 *   1. `beginAuthorization()` builds the authorization URL + a PKCE verifier.
 *      Open the URL in the system browser; the user picks their box, signs in
 *      there and approves; the box redirects back to your `redirectUri` with
 *      `?code=…&state=…&iss=…`.
 *   2. `parseCallback()` reads that redirect and checks `iss`;
 *      `exchangeCode()` swaps the code (+ the verifier) for the access token at
 *      that box — and only at that box.
 *
 * Obsidian: register a protocol handler via `registerObsidianProtocolHandler`,
 * pass its URL as `redirectUri`, read the params with `callbackFromParams`, and
 * pass `injectedAdapter(requestUrl)` as `http`.
 */

export const DEFAULT_PORTAL_URL = PRODUCTION.portalOrigin;

/** `iss` for a box of the environment whose box domain is `boxDomain`. */
function issuerPattern(boxDomain: string): RegExp {
  const domain = boxDomain.replace(/\./g, "\\.");
  return new RegExp(`^https:\\/\\/pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\\.${domain}$`);
}

/**
 * The shape of every Plum box's own address, as `iss` (v3 contract 10.1). A
 * box answers an authorization with its canonical origin. Its LAN and WAN
 * aliases (`pb-…-lan`, `pb-…-wan`) are refused on top of this pattern by
 * {@link isPlumIssuer}. The name is not narrowed to hex: older box names exist.
 */
export const PLUM_ISSUER_PATTERN = issuerPattern(PRODUCTION.boxDomain);

/**
 * Whether `iss` is a Plum box's canonical origin: `https://pb-<name>.plumbox.me`
 * exactly — https, no port, no path, no trailing slash, lower case, and not the
 * box's `-lan`/`-wan` alias. `boxDomain` picks the environment (default
 * production, `plumbox.me`; `staging.plumbox.me` for Plum's staging): a box of
 * another environment is not one.
 *
 * Limit: this says "a Plum box", not "the box the user picked". Swapping in a
 * different Plum box is stopped elsewhere (the signed directory list and the
 * portal sending the user only to the box they chose).
 */
export function isPlumIssuer(iss: unknown, boxDomain?: string): iss is string {
  const domain = plumEnvironment(boxDomain).boxDomain;
  return (
    typeof iss === "string" &&
    (domain === PRODUCTION.boxDomain ? PLUM_ISSUER_PATTERN : issuerPattern(domain)).test(iss) &&
    !iss.endsWith(`-lan.${domain}`) &&
    !iss.endsWith(`-wan.${domain}`)
  );
}

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
  /** Portal that hosts the /authorize entry (where the user finds their box). Default: the environment's portal. */
  portalUrl?: string;
  /** The environment, by box domain: `plumbox.me` (default) or `staging.plumbox.me`. */
  boxDomain?: string;
}

export interface AuthorizationRequest {
  /** Open this in the system browser. */
  url: string;
  /** Keep until the redirect returns; needed to exchange the code. */
  codeVerifier: string;
  /** Keep until the redirect returns; pass it to `exchangeCode` as `expectedState`. */
  state: string;
}

export interface ExchangeCodeOptions {
  /**
   * The box to exchange the code at: the callback's `iss` (from
   * `parseCallback`/`callbackFromParams`). It must be a Plum box's canonical
   * origin ({@link isPlumIssuer}); anything else stops with
   * `PlumOAuthError("invalid_iss")` before the code or the verifier is sent
   * anywhere. The code goes to `<iss>/api/oauth/token` and nowhere else.
   */
  baseUrl: string;
  code: string;
  /** The callback's `state`. */
  state?: string;
  /**
   * The `state` that `beginAuthorization` returned for this sign-in. A callback
   * whose `state` is different (or missing) stops with
   * `PlumOAuthError("invalid_state")` before anything is sent.
   */
  expectedState: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  http?: HttpAdapter;
  /** The environment, by box domain: `plumbox.me` (default) or `staging.plumbox.me`. */
  boxDomain?: string;
}

/** Which environment a callback is checked against. */
export interface CallbackOptions {
  /** By box domain: `plumbox.me` (default) or `staging.plumbox.me`. */
  boxDomain?: string;
}

export interface CallbackResult {
  /** Present only when the callback also carried a valid `iss`. */
  code?: string;
  state?: string;
  /**
   * The box that issued the code, already checked with {@link isPlumIssuer} —
   * pass it to `exchangeCode` as `baseUrl` and keep it as the box's address.
   * Absent when the callback carried none (an error callback from an older
   * box) or one that failed the check.
   */
  iss?: string;
  /**
   * Set when there is nothing to exchange: the box's own error (e.g.
   * "access_denied"), "invalid_iss" when the callback's `iss` is missing or
   * not a Plum box (the code is then dropped), or "invalid_request" when the
   * callback carried neither a code nor an error.
   */
  error?: string;
}

/**
 * Read the redirect the box sent back to your `redirect_uri`
 * (e.g. myapp://plum/callback?code=…&state=…&iss=…) and check its `iss`
 * (v3 contract 10.1):
 *
 * - A code with no `iss`, or with one that is not a Plum box's own address,
 *   comes back as `{ error: "invalid_iss" }` and WITHOUT the code — there is
 *   nothing left to send anywhere.
 * - An error callback is accepted without `iss` (older boxes send none); if it
 *   carries one, the same check applies.
 *
 * `state` is checked by `exchangeCode` (pass the one `beginAuthorization`
 * returned as `expectedState`). Throws on a malformed URL.
 */
export function parseCallback(callbackUrl: string, opts?: CallbackOptions): CallbackResult {
  const u = new URL(callbackUrl);
  return checkCallback((k) => u.searchParams.getAll(k), opts?.boxDomain);
}

/**
 * {@link parseCallback} for callbacks that arrive as a parameter object
 * rather than a URL — Obsidian's `registerObsidianProtocolHandler` hands the
 * handler `{ action, code, state, iss, … }`. Same checks, same result.
 */
export function callbackFromParams(params: Record<string, unknown>, opts?: CallbackOptions): CallbackResult {
  return checkCallback((k) => {
    const v = params[k];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  }, opts?.boxDomain);
}

function checkCallback(all: (key: string) => string[], boxDomain: string | undefined): CallbackResult {
  plumEnvironment(boxDomain); // an unknown environment throws before anything is read
  // A parameter that appears twice is not one this flow produced; refusing
  // it keeps "which iss did we check" and "which iss do we use" the same.
  const one = (k: string): string | undefined | null => {
    const v = all(k);
    if (v.length > 1) return null;
    return v.length === 1 && v[0] !== "" ? v[0] : undefined;
  };
  const code = one("code");
  const state = one("state");
  const iss = one("iss");
  const error = one("error");
  const out: CallbackResult = {};
  if (typeof state === "string") out.state = state;

  if (iss === null || (iss !== undefined && !isPlumIssuer(iss, boxDomain))) {
    out.error = "invalid_iss";
    return out;
  }
  if (error !== undefined || code === null) {
    // The box's own refusal (access_denied, …). No code goes with it, even
    // if one were present.
    out.error = typeof error === "string" ? error : "invalid_request";
    if (iss) out.iss = iss;
    return out;
  }
  if (code === undefined) {
    out.error = "invalid_request";
    return out;
  }
  if (!iss) {
    // A code and no box to name it: stop here (contract 10.1).
    out.error = "invalid_iss";
    return out;
  }
  out.code = code;
  out.iss = iss;
  return out;
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

/**
 * `node:crypto`'s Web Crypto, for runtimes with no global `crypto`: Node 18
 * gives scripts and ES modules none (it arrived unflagged in Node 19).
 * Undefined where there is no `node:crypto` (a browser without Web Crypto).
 * The random bytes and the hash both come through here, so the verifier and
 * `state` work wherever the challenge does.
 */
async function nodeWebCrypto(): Promise<Crypto | undefined> {
  try {
    const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto?: Crypto };
    return nodeCrypto.webcrypto;
  } catch {
    return undefined;
  }
}

async function randomBytes(n: number): Promise<Uint8Array> {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  const c = g?.getRandomValues ? g : await nodeWebCrypto();
  if (!c?.getRandomValues) throw new Error("no secure RNG available");
  return c.getRandomValues(new Uint8Array(n));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  const subtle = g?.subtle ?? (await nodeWebCrypto())?.subtle;
  if (!subtle) throw new Error("no SubtleCrypto for PKCE");
  return new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

/**
 * Build the authorization URL and the PKCE material. The verifier and
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
  const portal = (opts.portalUrl ?? plumEnvironment(opts.boxDomain).portalOrigin).replace(/\/+$/, "");
  // PKCE verifier: 43–128 chars from the unreserved set. 32 random bytes
  // base64url-encoded → 43 chars.
  const codeVerifier = b64url(await randomBytes(32));
  const codeChallenge = b64url(await sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64url(await randomBytes(16));

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
 * Exchange the authorization code for a scoped access token (PAT) at the box
 * that issued it. Before anything is sent, `baseUrl` must be a Plum box's own
 * address (`invalid_iss` otherwise) and the callback's `state` must equal
 * `expectedState` (`invalid_state` otherwise) — both as `PlumOAuthError`.
 * Returns the token to store; the password was never seen by your app.
 *
 * Errors from the box carry its OAuth code in `PlumApiError.code`:
 * `invalid_grant` (code used, expired or PKCE mismatch), `unauthorized_client`
 * (client_id not registered), `invalid_scope`, `invalid_redirect_uri`.
 */
export async function exchangeCode(
  opts: ExchangeCodeOptions,
): Promise<{ accessToken: string; scope: string }> {
  const iss = opts.baseUrl;
  const domain = plumEnvironment(opts.boxDomain).boxDomain;
  if (!isPlumIssuer(iss, domain)) {
    throw new PlumOAuthError(
      "invalid_iss",
      `exchangeCode: the callback's iss is not a Plum box (https://pb-….${domain}); nothing was sent`,
    );
  }
  if (typeof opts.expectedState !== "string" || opts.expectedState === "" || opts.state !== opts.expectedState) {
    throw new PlumOAuthError(
      "invalid_state",
      "exchangeCode: the callback's state is not the one this sign-in began with; nothing was sent",
    );
  }
  if (!opts.code || !opts.codeVerifier) {
    throw new PlumOAuthError("invalid_request", "exchangeCode: code and codeVerifier are required");
  }
  const http = opts.http ?? fetchAdapter;
  const res = await http.request({
    url: iss + "/api/oauth/token",
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
