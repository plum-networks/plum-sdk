// Delegated authorization with an authenticated issuer (oauth-issuer.v3.md).
//
// The legacy flow (oauth.ts) trusts the callback's `iss` to say which box to
// send the code to. Nothing vouches for that value: an app that registers
// the same redirect scheme can rewrite it, and the app then hands its code
// and PKCE verifier to the attacker's server. This flow closes that:
//
// 1. One transaction record (`PendingAuthorization`) holds state, the
//    expected issuer, the callback channel, the policy and a DPoP key, and
//    accepts exactly one callback (AppAuth-style request/response matching).
// 2. The callback's `iss` is checked (RFC 9207) against what the app expects:
//    the box it already has a session with (Known), or, on first connect
//    (Discover), any well-formed box issuer, but only when the callback
//    arrived on a channel no other app can read (RFC 8252 §8.1). In JS that
//    channel is a loopback redirect, and the SDK alone decides it: from the
//    redirect URI at start, confirmed against the callback URL.
// 3. The code is bound to the app's key and to the issuer that minted it
//    (RFC 9449 §10): a stolen code + verifier is useless without the key, and
//    a proof made for another box is useless at the real one.
//
// The normative algorithm lives in internal/callback.ts (a port of the
// reference callback.go, shared with the Android and iOS SDKs).

import { fetchAdapter } from "./adapters/fetch.js";
import { createDPoPProof, generateDPoPKey, jwkThumbprint, publicJwk } from "./dpop.js";
import { errorFromResponse, PlumOAuthError } from "./errors.js";
import type { HttpAdapter, HttpResponse } from "./http.js";
import { responseText } from "./http.js";
import {
  channelForCallbackURL,
  channelForRedirect,
  entryURL,
  isVerified,
  rawQueryOf,
  redirectMatches,
  startError,
  validate,
  type Expectation,
  type Policy,
  type Result,
  type Txn,
} from "./internal/callback.js";
import { b64url, secureRandom, sha256, subtle } from "./internal/crypto.js";
import { DEFAULT_BOX_DOMAIN, validDevIssuer, wellFormedBoxIssuer } from "./issuer.js";
import { DEFAULT_PORTAL_URL } from "./oauth.js";
import type { OAuthScope } from "./types.js";

/**
 * Which box the sign-in must end at.
 *
 * - `discover`: first connect; the portal picks the user's box. Accepted only
 *   when the callback is isolated (a loopback redirect), unless the policy
 *   opts out.
 * - `known`: reconnect to the box you hold a session for; pass the stored
 *   `Grant.issuer`. Another box answering is `issuer_changed` on a loopback
 *   redirect (ask the user) and `rejected` (`issuer_mismatch`) otherwise.
 * - `dev`: a developer box (emulator, LAN), exact match, http allowed. Only
 *   with `policy.allowDev: true`; never ship that in a release build.
 */
export type IssuerExpectation =
  | { mode: "discover" }
  | { mode: "known"; issuer: string }
  | { mode: "dev"; issuer: string };

export interface IssuerPolicy {
  /** The domain box issuers live under. Default `plumbox.me`. */
  boxDomain?: string;
  /**
   * Default `true`: Discover is accepted only on a verified (loopback)
   * callback, and `startAuthorization` refuses Discover on any other redirect
   * with `verified_channel_unavailable` before anything is opened.
   *
   * Setting `false` is an explicit opt-out with known consequences: on boxes
   * that do not bind codes yet, another app that registers your redirect
   * scheme can still steal the token; on boxes that do, it can still connect
   * your app to ITS box, so a sync app would upload the user's data there.
   * Prefer a Known reconnect, or a first connect over loopback on desktop.
   */
  requireVerifiedChannel?: boolean;
  /**
   * Must be exactly `true` for a Dev expectation. Gate it on your own debug
   * build flag; a release build must never set it.
   */
  allowDev?: boolean;
}

export interface StartAuthorizationOptions {
  /** As registered (developer console or manifest `clients[]`). */
  clientId: string;
  /**
   * One of the client's registered redirect URIs. An http loopback URI
   * (`127.0.0.1`, `[::1]`, `localhost`; any port) makes this a verified
   * transaction; anything else (a custom scheme) is `external`.
   */
  redirectUri: string;
  scopes: OAuthScope[];
  /** Default `{ mode: "discover" }`. */
  expectation?: IssuerExpectation;
  policy?: IssuerPolicy;
  /** Portal hosting `/authorize`. Default `https://plumbox.me`. */
  portalUrl?: string;
  /**
   * Default `false`: the DPoP private key cannot be exported, so the
   * transaction lives only in this process. Set `true` only when the callback
   * arrives in a later process (an Obsidian deep link); then
   * `serializePendingAuthorization` writes the key down, and the stored
   * string must be protected like a credential for its 30 minutes.
   */
  persistable?: boolean;
}

/**
 * One sign-in attempt. Open `url` in the system browser, keep this object
 * (or its serialization) until the callback arrives, and pass it to
 * `validateCallback` / `validateCallbackParams`. It accepts one callback and
 * expires after 30 minutes.
 */
export interface PendingAuthorization {
  /** Open this in the system browser (never an embedded web view). */
  readonly url: string;
  /** The OAuth `state` this transaction expects back. */
  readonly state: string;
  /** Decided by the SDK from the redirect URI; `loopback` is the verified one. */
  readonly channel: "loopback" | "external";
}

/**
 * What a callback meant.
 *
 * - `authorized`: pass it to `completeAuthorization`. `issuer` is the box.
 *   `match` says how it was accepted: `exact` (Known), `discovered`
 *   (Discover), `dev`, or `confirmed` (the user accepted an issuer change).
 * - `issuer_changed`: Known, loopback only. A different box of yours
 *   answered (e.g. another RAID member). Ask the user "connect to <issuer>?"
 *   and call `acceptIssuerChange` only on a yes; never accept automatically.
 * - `denied`: the user cancelled, or the box refused (`error`).
 * - `rejected`: refused for safety (`reason`); the transaction is over.
 * - `ignored`: not this transaction's callback (`state_mismatch`,
 *   `not_our_redirect`); keep waiting, the real one may still come.
 */
export type AuthorizationOutcome =
  | { readonly kind: "authorized"; readonly issuer: string; readonly match: "exact" | "discovered" | "dev" | "confirmed" }
  | { readonly kind: "issuer_changed"; readonly issuer: string; readonly expected: string }
  | { readonly kind: "denied"; readonly error: string; readonly description?: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "ignored"; readonly reason: string };

/** The token for the box. Store `issuer` as the box origin; reconnect with `{ mode: "known", issuer }`. */
export interface Grant {
  /** Send as `Authorization: Bearer <accessToken>` (e.g. `new PlumClient({ baseUrl: issuer, token })`). */
  accessToken: string;
  /** Always `bearer`. */
  tokenType: string;
  scope: string;
  /** The validated issuer the code was exchanged at. */
  issuer: string;
}

// ---- module-private state ----

interface Transaction extends Txn {
  url: string;
  codeVerifier: string;
  clientId: string;
  scopes: string[];
  allowDev: boolean;
  dpopJkt: string;
  persistable: boolean;
  /** null once exchanged, discarded, rejected, denied or expired. */
  key: CryptoKeyPair | null;
}

/** The record behind each PendingAuthorization the SDK handed out. */
const transactions = new WeakMap<object, Transaction>();

/**
 * The brand: outcomes this module created, with what they carry that the
 * caller must not see or choose (the code, the transaction, the validated
 * issuer). A hand-made `{ kind: "authorized", … }` is not in here, so
 * `completeAuthorization` refuses it.
 */
const outcomes = new WeakMap<object, { kind: AuthorizationOutcome["kind"]; txn: Transaction; code: string; issuer: string }>();

function register(txn: Transaction): PendingAuthorization {
  const channel = txn.channel === "loopback" ? "loopback" : "external";
  const p: PendingAuthorization = Object.freeze({ url: txn.url, state: txn.state, channel });
  transactions.set(p, txn);
  return p;
}

function txnOf(p: PendingAuthorization, fn: string): Transaction {
  const t = typeof p === "object" && p !== null ? transactions.get(p) : undefined;
  if (!t) {
    throw new PlumOAuthError(
      "invalid_pending",
      `${fn}: pass the PendingAuthorization returned by startAuthorization or deserializePendingAuthorization`,
    );
  }
  return t;
}

function expectationOf(e: IssuerExpectation | undefined): Expectation {
  const x = (e ?? { mode: "discover" }) as { mode?: unknown; issuer?: unknown };
  if (x.mode === "discover") return { mode: "discover", issuer: "" };
  if ((x.mode === "known" || x.mode === "dev") && typeof x.issuer === "string") return { mode: x.mode, issuer: x.issuer };
  throw new PlumOAuthError("invalid_request", "startAuthorization: expectation must be discover, known(issuer) or dev(issuer)");
}

// ---- public API ----

/**
 * Start a bound sign-in. Opens nothing: open the returned `url` in the system
 * browser. Throws `PlumOAuthError` before anything is launched when the
 * attempt could only be refused later (see its `code` list), so the user never
 * types a password into a doomed flow.
 *
 * The entry URL carries `dpop_jkt` (the code will be bound to this attempt's
 * key) and, for Known, a `#box=<label>` hint that never reaches a server.
 */
export async function startAuthorization(opts: StartAuthorizationOptions): Promise<PendingAuthorization> {
  const clientId = (opts?.clientId ?? "").trim();
  if (!clientId) {
    throw new PlumOAuthError(
      "invalid_request",
      "startAuthorization: clientId is required (register one in the Plum developer console)",
    );
  }
  if (!Array.isArray(opts.scopes) || opts.scopes.length === 0) {
    throw new PlumOAuthError("invalid_request", "startAuthorization: at least one scope is required");
  }
  if (typeof opts.redirectUri !== "string" || opts.redirectUri === "") {
    throw new PlumOAuthError("invalid_request", "startAuthorization: redirectUri is required");
  }
  const expectation = expectationOf(opts.expectation);
  // Fail closed: only an explicit `false` opts out, only an explicit `true` allows Dev.
  const policy: Policy = {
    boxDomain: opts.policy?.boxDomain ?? DEFAULT_BOX_DOMAIN,
    requireVerifiedChannel: opts.policy?.requireVerifiedChannel !== false,
  };
  const allowDev = opts.policy?.allowDev === true;
  const channel = channelForRedirect(opts.redirectUri);

  if (expectation.mode === "dev" && !allowDev) {
    throw new PlumOAuthError("dev_not_allowed", "startAuthorization: a Dev expectation needs policy.allowDev === true (debug builds only)");
  }
  const refused = startError(expectation, channel, policy);
  if (refused) throw new PlumOAuthError(refused, startErrorMessage(refused));

  const persistable = opts.persistable === true;
  const key = await generateDPoPKey(persistable);
  const dpopJkt = await jwkThumbprint(await publicJwk(key));
  const codeVerifier = b64url(await secureRandom(32)); // 43 chars, RFC 7636
  const codeChallenge = b64url(await sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64url(await secureRandom(16));
  const scopes = [...opts.scopes];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    dpop_jkt: dpopJkt,
  });
  const portal = (opts.portalUrl ?? DEFAULT_PORTAL_URL).replace(/\/+$/, "");
  return register({
    url: entryURL(expectation, portal, params.toString()),
    state,
    codeVerifier,
    clientId,
    redirectUri: opts.redirectUri,
    scopes,
    expectation,
    channel,
    policy,
    allowDev,
    dpopJkt,
    persistable,
    createdAtMs: Date.now(),
    consumed: false,
    key,
  });
}

function startErrorMessage(code: string): string {
  switch (code) {
    case "verified_channel_unavailable":
      return "startAuthorization: a first connect (Discover) needs a loopback redirect; reconnect with a Known issuer, or connect from a desktop first";
    case "invalid_known_issuer":
      return "startAuthorization: the Known issuer is not a box issuer (https://<label>.plumbox.me); use Discover";
    case "invalid_dev_issuer":
      return "startAuthorization: a Dev issuer must be https, or http to localhost / an emulator alias / a private IP, with no path";
    default:
      return "startAuthorization: " + code;
  }
}

function toOutcome(txn: Transaction, r: Result): AuthorizationOutcome {
  switch (r.outcome) {
    case "authorized": {
      const o = Object.freeze({ kind: "authorized" as const, issuer: r.issuer, match: r.match });
      outcomes.set(o, { kind: o.kind, txn, code: r.code, issuer: r.issuer });
      return o;
    }
    case "issuer_changed": {
      const o = Object.freeze({ kind: "issuer_changed" as const, issuer: r.issuer, expected: r.expected });
      outcomes.set(o, { kind: o.kind, txn, code: r.code, issuer: r.issuer });
      return o;
    }
    case "denied":
      txn.key = null;
      return Object.freeze(
        r.description === undefined
          ? { kind: "denied" as const, error: r.error }
          : { kind: "denied" as const, error: r.error, description: r.description },
      );
    case "rejected":
      txn.key = null;
      return Object.freeze({ kind: "rejected" as const, reason: r.reason });
    case "ignored":
      return Object.freeze({ kind: "ignored" as const, reason: r.reason });
  }
}

/**
 * Validate the URL your redirect target received, e.g. what a loopback
 * listener saw (`new URL(req.url, redirectUri).href`) or a deep link. A URL
 * whose scheme, host, port or path differ from the transaction's redirect URI
 * is `ignored` (`not_our_redirect`). The channel is `loopback` only when this
 * is a loopback transaction and the URL is its own loopback target.
 */
export function validateCallback(pending: PendingAuthorization, callbackUrl: string): AuthorizationOutcome {
  const txn = txnOf(pending, "validateCallback");
  if (!redirectMatches(txn.redirectUri, callbackUrl)) {
    return Object.freeze({ kind: "ignored" as const, reason: "not_our_redirect" });
  }
  return toOutcome(txn, validate(txn, rawQueryOf(callbackUrl), channelForCallbackURL(txn, callbackUrl), Date.now()));
}

/**
 * Validate a callback a host already parsed into a record (Obsidian's
 * `registerObsidianProtocolHandler` params). Always the `external` channel,
 * so a loopback transaction fed here is `rejected` (`channel_mismatch`).
 * Duplicate parameters cannot be detected: the host collapsed them before
 * the SDK saw them. Prefer `validateCallback` when you have the URL.
 */
export function validateCallbackParams(
  pending: PendingAuthorization,
  params: Record<string, string>,
): AuthorizationOutcome {
  const txn = txnOf(pending, "validateCallbackParams");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v !== "string") continue;
    try {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    } catch {
      // A lone surrogate cannot be a real parameter; drop it.
    }
  }
  return toOutcome(txn, validate(txn, parts.join("&"), "external", Date.now()));
}

/**
 * The user agreed to connect to the box named in an `issuer_changed`
 * outcome. Returns an `authorized` outcome (`match: "confirmed"`) for
 * `completeAuthorization`; anything else gives `rejected`
 * (`not_an_issuer_change`). If the user declines, call
 * `discardPendingAuthorization`.
 */
export function acceptIssuerChange(outcome: AuthorizationOutcome): AuthorizationOutcome {
  const b = typeof outcome === "object" && outcome !== null ? outcomes.get(outcome) : undefined;
  if (!b || b.kind !== "issuer_changed") {
    return Object.freeze({ kind: "rejected" as const, reason: "not_an_issuer_change" });
  }
  const o = Object.freeze({ kind: "authorized" as const, issuer: b.issuer, match: "confirmed" as const });
  outcomes.set(o, { kind: "authorized", txn: b.txn, code: b.code, issuer: b.issuer });
  return o;
}

/** `plum_server_time` from a box's `iat` refusal, or null when the refusal is anything else. */
function iatRetryTime(res: HttpResponse): number | null {
  if (res.status !== 400) return null;
  try {
    const b = JSON.parse(responseText(res)) as { error?: unknown; plum_retry?: unknown; plum_server_time?: unknown };
    if (b.error !== "invalid_dpop_proof" || b.plum_retry !== "iat") return null;
    const t = b.plum_server_time;
    return typeof t === "number" && Number.isFinite(t) && Number.isSafeInteger(Math.trunc(t)) ? Math.trunc(t) : null;
  } catch {
    return null;
  }
}

function grantFrom(res: HttpResponse, issuer: string): Grant {
  let b: { access_token?: unknown; token_type?: unknown; scope?: unknown };
  try {
    b = JSON.parse(responseText(res)) as typeof b;
  } catch {
    throw new PlumOAuthError("bad_response", "completeAuthorization: the token response is not JSON");
  }
  if (typeof b !== "object" || b === null || typeof b.access_token !== "string" || b.access_token === "") {
    throw new PlumOAuthError("bad_response", "completeAuthorization: the token response has no access_token");
  }
  const tokenType = typeof b.token_type === "string" ? b.token_type.toLowerCase() : "bearer";
  if (tokenType !== "bearer") {
    throw new PlumOAuthError("bad_response", `completeAuthorization: unsupported token_type ${String(b.token_type)}`);
  }
  return { accessToken: b.access_token, tokenType, scope: typeof b.scope === "string" ? b.scope : "", issuer };
}

/**
 * Exchange an `authorized` outcome for the box's token. Only outcomes this
 * SDK produced are accepted; the request goes only to the validated issuer
 * (`<issuer>/api/oauth/token`), with the code, verifier, client id and
 * redirect URI of the transaction and a DPoP proof. If the box says the
 * proof's time is off (`plum_retry: "iat"`), it re-signs once with the box's
 * own clock (`plum_server_time`). One exchange per transaction: the key is
 * destroyed whatever the result.
 *
 * Throws `PlumOAuthError` (`invalid_outcome`, `key_lost`, `bad_response`) or,
 * for a box refusal, `PlumApiError` with the box's code.
 */
export async function completeAuthorization(
  outcome: AuthorizationOutcome,
  opts: { http?: HttpAdapter } = {},
): Promise<Grant> {
  const b = typeof outcome === "object" && outcome !== null ? outcomes.get(outcome) : undefined;
  if (!b || b.kind !== "authorized") {
    throw new PlumOAuthError(
      "invalid_outcome",
      "completeAuthorization: pass an authorized outcome from validateCallback, validateCallbackParams or acceptIssuerChange",
    );
  }
  const key = b.txn.key;
  if (!key) throw new PlumOAuthError("key_lost", "completeAuthorization: this sign-in already ended; start again");
  b.txn.key = null;

  const http = opts.http ?? fetchAdapter;
  const htu = b.issuer + "/api/oauth/token"; // built only from the validated issuer
  const body = JSON.stringify({
    grant_type: "authorization_code",
    code: b.code,
    code_verifier: b.txn.codeVerifier,
    client_id: b.txn.clientId,
    redirect_uri: b.txn.redirectUri,
  });
  let iat = Math.floor(Date.now() / 1000);
  for (let attempt = 0; ; attempt++) {
    const res = await http.request({
      url: htu,
      method: "POST",
      headers: { "content-type": "application/json", DPoP: await createDPoPProof(key, htu, iat) },
      body,
    });
    if (res.status === 200) return grantFrom(res, b.issuer);
    // The box refused the proof's iat BEFORE looking the code up, so the code
    // is still good: re-sign once on the box's clock. No HTTP-date parsing.
    const serverTime = attempt === 0 ? iatRetryTime(res) : null;
    if (serverTime === null) throw errorFromResponse(res.status, responseText(res), res.headers);
    iat = serverTime;
  }
}

interface SerializedV1 {
  v: 1;
  url: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  expectation: { mode: "discover" } | { mode: "known" | "dev"; issuer: string };
  channel: "loopback" | "external";
  policy: { boxDomain: string; requireVerifiedChannel: boolean; allowDev: boolean };
  dpopJkt: string;
  createdAtMs: number;
  key: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
}

/**
 * The transaction as a string, private key included, for a callback that
 * arrives in a later process. Only for `persistable: true` transactions.
 * Store it sealed (it is a credential for 30 minutes) and delete it once the
 * callback was handled.
 */
export async function serializePendingAuthorization(pending: PendingAuthorization): Promise<string> {
  const t = txnOf(pending, "serializePendingAuthorization");
  if (!t.persistable) {
    throw new PlumOAuthError("not_persistable", "serializePendingAuthorization: start with persistable: true to serialize");
  }
  if (!t.key) throw new PlumOAuthError("key_lost", "serializePendingAuthorization: this sign-in already ended");
  const jwk = (await (await subtle()).exportKey("jwk", t.key.privateKey)) as JsonWebKey;
  if (!jwk.x || !jwk.y || !jwk.d) throw new PlumOAuthError("invalid_pending", "serializePendingAuthorization: key not exportable");
  const out: SerializedV1 = {
    v: 1,
    url: t.url,
    state: t.state,
    codeVerifier: t.codeVerifier,
    clientId: t.clientId,
    redirectUri: t.redirectUri,
    scopes: t.scopes,
    expectation: t.expectation.mode === "discover" ? { mode: "discover" } : { mode: t.expectation.mode, issuer: t.expectation.issuer },
    channel: t.channel === "loopback" ? "loopback" : "external",
    policy: { boxDomain: t.policy.boxDomain, requireVerifiedChannel: t.policy.requireVerifiedChannel, allowDev: t.allowDev },
    dpopJkt: t.dpopJkt,
    createdAtMs: t.createdAtMs,
    key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
  };
  return JSON.stringify(out);
}

/**
 * Restore a `serializePendingAuthorization` string. Throws
 * `PlumOAuthError("invalid_pending")` for anything else, including the
 * `{verifier, state}` records apps kept for the legacy flow: treat that as
 * "no sign-in in progress".
 */
export async function deserializePendingAuthorization(serialized: string): Promise<PendingAuthorization> {
  const bad = (why: string): PlumOAuthError =>
    new PlumOAuthError("invalid_pending", `deserializePendingAuthorization: ${why}`);
  let j: Partial<SerializedV1> & Record<string, unknown>;
  try {
    j = JSON.parse(serialized) as typeof j;
  } catch {
    throw bad("not JSON");
  }
  if (typeof j !== "object" || j === null || j.v !== 1) throw bad("not a v1 transaction");
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (![j.url, j.state, j.codeVerifier, j.clientId, j.redirectUri, j.dpopJkt].every(str)) throw bad("missing field");
  if (!Array.isArray(j.scopes) || j.scopes.length === 0 || !j.scopes.every(str)) throw bad("scopes");
  if (typeof j.createdAtMs !== "number" || !Number.isFinite(j.createdAtMs)) throw bad("createdAtMs");
  const pol = j.policy as SerializedV1["policy"] | undefined;
  if (
    !pol ||
    typeof pol.boxDomain !== "string" ||
    typeof pol.requireVerifiedChannel !== "boolean" ||
    typeof pol.allowDev !== "boolean"
  ) {
    throw bad("policy");
  }
  const policy: Policy = { boxDomain: pol.boxDomain, requireVerifiedChannel: pol.requireVerifiedChannel };
  // The channel is a function of the redirect URI; a record that disagrees was edited.
  const channel = channelForRedirect(j.redirectUri!);
  if (j.channel !== channel) throw bad("channel does not match the redirect URI");
  const e = j.expectation as { mode?: unknown; issuer?: unknown } | undefined;
  let expectation: Expectation;
  if (e?.mode === "discover") {
    expectation = { mode: "discover", issuer: "" };
    if (!isVerified(channel) && policy.requireVerifiedChannel) throw bad("discover on an unverified channel");
  } else if (e?.mode === "known" && typeof e.issuer === "string" && wellFormedBoxIssuer(e.issuer, policy.boxDomain)) {
    expectation = { mode: "known", issuer: e.issuer };
  } else if (e?.mode === "dev" && typeof e.issuer === "string" && pol.allowDev && validDevIssuer(e.issuer)) {
    expectation = { mode: "dev", issuer: e.issuer };
  } else {
    throw bad("expectation");
  }
  const k = j.key as SerializedV1["key"] | undefined;
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || ![k.x, k.y, k.d].every(str)) throw bad("key");
  let key: CryptoKeyPair;
  try {
    const s = await subtle();
    const alg = { name: "ECDSA", namedCurve: "P-256" };
    key = {
      privateKey: await s.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, d: k.d }, alg, true, ["sign"]),
      publicKey: await s.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y }, alg, true, ["verify"]),
    };
  } catch {
    throw bad("key");
  }
  if ((await jwkThumbprint(k)) !== j.dpopJkt) throw bad("key does not match dpopJkt");
  return register({
    url: j.url!,
    state: j.state!,
    codeVerifier: j.codeVerifier!,
    clientId: j.clientId!,
    redirectUri: j.redirectUri!,
    scopes: [...j.scopes],
    expectation,
    channel,
    policy,
    allowDev: pol.allowDev,
    dpopJkt: j.dpopJkt!,
    persistable: true,
    createdAtMs: j.createdAtMs,
    consumed: false,
    key,
  });
}

/** End a transaction without exchanging (the user cancelled or declined a box change). Destroys its key. */
export function discardPendingAuthorization(pending: PendingAuthorization): void {
  const t = typeof pending === "object" && pending !== null ? transactions.get(pending) : undefined;
  if (!t) return;
  t.key = null;
  t.consumed = true;
}
