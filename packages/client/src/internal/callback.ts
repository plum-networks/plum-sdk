// The transaction and callback validation of oauth-issuer.v3.md §5.2-§5.4: a
// line-by-line port of the reference callback.go. plumconnect (Kotlin) and
// PlumConnect (Swift) port the same function and all three run the shared
// callback_cases, so keep this in step with the reference, not with taste.
//
// Nothing here is exported from the package. The channel a callback arrived
// on is decided by the entry points in authorize.ts, never by the caller.

import { boxLabel, validDevIssuer, wellFormedBoxIssuer } from "../issuer.js";
import { isLoopbackHostname } from "./ip.js";

/**
 * How the callback reaches the app. Only the first three are isolated from
 * other apps (RFC 8252 §8.1); this SDK itself only ever records `loopback`
 * (an http listener the app owns on this machine) or `external` (an OS deep
 * link any app can register for). The other three are the Android and iOS
 * SDKs' channels and appear here so the shared vectors run unchanged.
 */
export type Channel = "auth_tab" | "as_web_auth" | "loopback" | "custom_tab" | "external";

export const isVerified = (c: Channel): boolean => c === "auth_tab" || c === "as_web_auth" || c === "loopback";

export type ExpectMode = "discover" | "known" | "dev";

/** Discover: first connect. Known: the box the app holds a session for. Dev: an explicit developer box. */
export interface Expectation {
  mode: ExpectMode;
  /** Known: the stored issuer. Dev: the dev issuer. Discover: "". */
  issuer: string;
}

export interface Policy {
  boxDomain: string;
  /** Default true: Discover is accepted only on a verified channel. */
  requireVerifiedChannel: boolean;
}

/** The fields of a transaction (PendingAuthorization) that validation reads. */
export interface Txn {
  state: string;
  expectation: Expectation;
  /** Decided by the SDK before launch; a delivery on any other channel is refused. */
  channel: Channel;
  redirectUri: string;
  /** Fixed at start, so a callback cannot be validated under another policy. */
  policy: Policy;
  createdAtMs: number;
  consumed: boolean;
}

export type Match = "exact" | "discovered" | "dev" | "confirmed";

export type Result =
  | { outcome: "authorized"; code: string; issuer: string; match: Match }
  | { outcome: "issuer_changed"; code: string; issuer: string; expected: string }
  | { outcome: "denied"; error: string; description?: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "ignored"; reason: string };

/** A transaction lives 30 minutes (portal time; the code itself lives 5). */
export const TX_TTL_MS = 30 * 60 * 1000;

/**
 * The refusals every SDK's start() makes before anything is launched (the
 * reference Start). Returns the error code, or null. Gating Dev to debug use
 * (`allowDev` here) is the caller's job and comes first.
 */
export function startError(e: Expectation, ch: Channel, p: Policy): string | null {
  switch (e.mode) {
    case "dev":
      return validDevIssuer(e.issuer) ? null : "invalid_dev_issuer";
    case "known":
      return wellFormedBoxIssuer(e.issuer, p.boxDomain) ? null : "invalid_known_issuer";
    case "discover":
      // Refuse before launch, so nobody types a password into a flow that
      // will be refused at the callback.
      return !isVerified(ch) && p.requireVerifiedChannel ? "verified_channel_unavailable" : null;
  }
}

/**
 * The URL to open. Discover and Known start at the portal; Known adds the
 * `#box=<label>` hint (never sent to a server: fragments stay in the
 * browser). Dev starts at the dev box itself.
 */
export function entryURL(e: Expectation, portal: string, query: string): string {
  switch (e.mode) {
    case "dev":
      return e.issuer + "/authorize?" + query;
    case "known":
      return portal + "/authorize?" + query + "#box=" + boxLabel(e.issuer);
    case "discover":
      return portal + "/authorize?" + query;
  }
}

function parseURL(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Same scheme, host, port and path as the transaction's redirect URI (query
 * and fragment ignored). Anything else is another delivery, not ours.
 */
export function redirectMatches(redirectUri: string, raw: string): boolean {
  if (typeof raw !== "string") return false;
  const want = parseURL(redirectUri);
  const got = parseURL(raw);
  if (!want || !got) return false;
  return (
    want.protocol.toLowerCase() === got.protocol.toLowerCase() &&
    want.hostname.toLowerCase() === got.hostname.toLowerCase() &&
    want.port === got.port &&
    want.pathname === got.pathname
  );
}

/** An http URL on this machine: `localhost`, `127.x.x.x` or `[::1]`. */
function isLoopbackHTTP(u: URL | null): boolean {
  return !!u && u.protocol === "http:" && isLoopbackHostname(u.hostname);
}

/**
 * The JS start-time channel: an http loopback redirect is `loopback` (the
 * app's own listener receives it), anything else `external`.
 */
export function channelForRedirect(redirectUri: string): "loopback" | "external" {
  return isLoopbackHTTP(parseURL(redirectUri)) ? "loopback" : "external";
}

/**
 * The JS delivery channel: `loopback` only for a loopback transaction whose
 * own redirect target received the URL; everything else is `external`.
 */
export function channelForCallbackURL(t: Txn, callbackUrl: string): Channel {
  if (t.channel !== "loopback" || !redirectMatches(t.redirectUri, callbackUrl)) return "external";
  return isLoopbackHTTP(parseURL(callbackUrl)) ? "loopback" : "external";
}

/** The raw query of a URL string: after the first `?`, before any `#`. */
export function rawQueryOf(raw: string): string {
  const hash = raw.indexOf("#");
  if (hash >= 0) raw = raw.slice(0, hash);
  const q = raw.indexOf("?");
  return q >= 0 ? raw.slice(q + 1) : "";
}

const HEX = /^[0-9a-fA-F]{2}$/;

/** Go's url.QueryUnescape; "" for a malformed escape, as the reference treats it. */
function queryUnescape(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "%") {
      const h = s.slice(i + 1, i + 3);
      if (!HEX.test(h)) return "";
      bytes.push(parseInt(h, 16));
      i += 2;
    } else if (c === "+") {
      bytes.push(0x20);
    } else {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const SECURITY_KEYS = new Set(["code", "state", "iss", "error"]);

/** The first value of each key, and whether a security-relevant key appeared twice. */
export function parseCallbackQuery(raw: string): { q: Map<string, string>; dup: boolean } {
  const q = new Map<string, string>();
  let dup = false;
  for (const kv of raw.split("&")) {
    if (kv === "") continue;
    const eq = kv.indexOf("=");
    const k = queryUnescape(eq < 0 ? kv : kv.slice(0, eq));
    const v = queryUnescape(eq < 0 ? "" : kv.slice(eq + 1));
    if (q.has(k)) {
      if (SECURITY_KEYS.has(k)) dup = true;
      continue;
    }
    q.set(k, v);
  }
  return { q, dup };
}

/**
 * The normative algorithm (§5.4). `delivered` comes from the entry point,
 * never from the integrator. Mutates `t.consumed`.
 */
export function validate(t: Txn, rawQuery: string, delivered: Channel, nowMs: number): Result {
  const { q, dup } = parseCallbackQuery(rawQuery);
  const st = q.get("state");
  if (st === undefined || st === "" || t.consumed || st !== t.state) {
    return { outcome: "ignored", reason: "state_mismatch" }; // pending untouched: a stray callback cannot cancel sign-in
  }
  t.consumed = true; // one-time from here on, whatever the result
  if (dup) return { outcome: "rejected", reason: "duplicate_param" };
  if (nowMs - t.createdAtMs > TX_TTL_MS) return { outcome: "rejected", reason: "expired" };
  if (delivered !== t.channel) return { outcome: "rejected", reason: "channel_mismatch" };
  const e = q.get("error") ?? "";
  if (e !== "") {
    const description = q.get("error_description") ?? "";
    // iss is optional here: a C0 box omits it on errors.
    return description ? { outcome: "denied", error: e, description } : { outcome: "denied", error: e };
  }
  const code = q.get("code") ?? "";
  if (code === "") return { outcome: "rejected", reason: "missing_code" };
  const iss = q.get("iss") ?? "";
  if (iss === "") return { outcome: "rejected", reason: "missing_iss" }; // every OAuth core sends it on success
  switch (t.expectation.mode) {
    case "dev":
      if (iss !== t.expectation.issuer) return { outcome: "rejected", reason: "issuer_mismatch" };
      return { outcome: "authorized", code, issuer: iss, match: "dev" };
    case "known":
      if (iss === t.expectation.issuer) return { outcome: "authorized", code, issuer: iss, match: "exact" };
      if (!wellFormedBoxIssuer(iss, t.policy.boxDomain)) return { outcome: "rejected", reason: "invalid_iss" };
      // On a verified channel iss is authentic: "you signed in to box X; use
      // it?" is a question for the user. Never auto-accepted.
      if (isVerified(delivered)) return { outcome: "issuer_changed", code, issuer: iss, expected: t.expectation.issuer };
      return { outcome: "rejected", reason: "issuer_mismatch" };
    case "discover":
      if (!wellFormedBoxIssuer(iss, t.policy.boxDomain)) return { outcome: "rejected", reason: "invalid_iss" };
      if (!isVerified(delivered) && t.policy.requireVerifiedChannel) {
        return { outcome: "rejected", reason: "unverified_channel" };
      }
      return { outcome: "authorized", code, issuer: iss, match: "discovered" };
  }
}
