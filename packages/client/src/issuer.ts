// Issuer syntax for the bound OAuth flow (oauth-issuer.v3.md §5.1, §5.4). A
// port of the reference issuer.go; the shared vectors' issuer_syntax and
// dev_expectation lists are the contract with core, plumconnect and
// PlumConnect Swift. Internal: not exported from the package.

import { isLoopbackIP, isPrivateIP, parseIP } from "./internal/ip.js";

/** The box domain every box issuer lives under unless a policy says otherwise. */
export const DEFAULT_BOX_DOMAIN = "plumbox.me";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Plum infrastructure names under the box domain. Never a box. Narrow box
 * issuers to the `pb-` prefix once the relay confirms no legacy label remains.
 */
const INFRA_LABELS = new Set([
  "relay", "relay-us", "relay-eu", "signal", "turn", "turn-us", "turn-eu", "wildcard",
  "www", "api", "ssh", "portal", "store", "developer", "pbsu", "testbox", "mail",
]);

/**
 * `https://<one label>.<boxDomain>` and nothing else: all lower-case; no port,
 * path, query, fragment or userinfo; not a `-lan` / `-wan` alias; not an
 * infrastructure name. This is the only shape a box's canonical issuer has,
 * so it is what Discover accepts and what Known must be.
 */
export function wellFormedBoxIssuer(iss: string, boxDomain: string = DEFAULT_BOX_DOMAIN): boolean {
  if (typeof iss !== "string" || typeof boxDomain !== "string" || !DOMAIN.test(boxDomain)) return false;
  const prefix = "https://";
  const suffix = "." + boxDomain;
  if (!iss.startsWith(prefix) || !iss.endsWith(suffix) || iss.length <= prefix.length + suffix.length) return false;
  // The label regex admits only [a-z0-9-], so the whole string is exactly
  // "https://" + label + "." + boxDomain: lower-case, one label, no port or path.
  const label = iss.slice(prefix.length, iss.length - suffix.length);
  if (!LABEL.test(label) || INFRA_LABELS.has(label)) return false;
  return !label.endsWith("-lan") && !label.endsWith("-wan");
}

/** The first DNS label of a well-formed box issuer (`pb-1234` for https://pb-1234.plumbox.me). */
export function boxLabel(iss: string): string {
  return iss.slice("https://".length).split(".")[0]!;
}

const HOSTNAME = /^[a-z0-9._~-]+$/;
const EMULATOR_ALIASES = new Set(["localhost", "10.0.2.2", "10.0.3.2"]);

/**
 * What a Dev expectation accepts: `https://<host>[:port]`, or
 * `http://<host>[:port]` where host is `localhost`, an Android emulator alias
 * (`10.0.2.2`, `10.0.3.2`), or a loopback or RFC 1918 / RFC 4193 IP literal.
 * Lower-case; no path, query, fragment or userinfo. A Dev issuer is never
 * discoverable: it is reached only by an explicit Dev expectation, which the
 * SDK further gates behind `policy.allowDev === true`.
 */
export function validDevIssuer(iss: string): boolean {
  if (typeof iss !== "string" || iss !== iss.toLowerCase()) return false;
  const m = /^(https?):\/\/(.*)$/.exec(iss);
  if (!m) return false;
  const scheme = m[1]!;
  const authority = m[2]!;
  if (/[/?#@\\\s]/.test(authority)) return false; // path, query, fragment, userinfo
  let host: string;
  let ip: Uint8Array | null;
  let rest: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return false;
    host = authority.slice(1, close);
    rest = authority.slice(close + 1);
    ip = host.includes(":") ? parseIP(host) : null;
    if (!ip) return false;
  } else {
    const colon = authority.indexOf(":");
    host = colon < 0 ? authority : authority.slice(0, colon);
    rest = colon < 0 ? "" : authority.slice(colon);
    if (!HOSTNAME.test(host)) return false;
    ip = parseIP(host);
  }
  if (rest !== "" && !/^:\d*$/.test(rest)) return false; // optional numeric port
  if (scheme === "https") return host !== "";
  if (EMULATOR_ALIASES.has(host)) return true;
  return ip !== null && (isLoopbackIP(ip) || isPrivateIP(ip));
}
