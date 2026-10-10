/**
 * The one place in `@plumbox/client` that knows Plum's environments and their
 * addresses: the box domain (a box is `https://pb-<name>.<boxDomain>`), the
 * portal where people find their box, and the relay.
 *
 * Production is the default everywhere and its values are what the SDK always
 * used. Staging (`staging.plumbox.me`) is for Plum's own test environment; an
 * app chooses it with the `boxDomain` option. Each environment accepts only
 * its own addresses: a production client never takes a staging box, and a
 * staging client never takes a production one.
 */
export interface PlumEnvironment {
  readonly name: "production" | "staging";
  /** A box is `https://pb-<name>.<boxDomain>`. */
  readonly boxDomain: string;
  /** Where people find their box and the authorization starts. */
  readonly portalOrigin: string;
  /** The relay. */
  readonly relayUrl: string;
}

export const PRODUCTION: PlumEnvironment = Object.freeze({
  name: "production",
  boxDomain: "plumbox.me",
  portalOrigin: "https://plumbox.me",
  relayUrl: "https://relay.plumbox.me",
});

export const STAGING: PlumEnvironment = Object.freeze({
  name: "staging",
  boxDomain: "staging.plumbox.me",
  portalOrigin: "https://staging.plumbox.me",
  relayUrl: "https://relay.staging.plumbox.me",
});

const ENVIRONMENTS: readonly PlumEnvironment[] = [PRODUCTION, STAGING];

/**
 * The environment whose box domain is `boxDomain` (case-insensitive). No
 * value is production. Anything else throws: there is no third environment,
 * and a typo must not quietly become one.
 */
export function plumEnvironment(boxDomain?: string): PlumEnvironment {
  if (boxDomain === undefined || boxDomain === "") return PRODUCTION;
  const want = boxDomain.toLowerCase();
  const found = ENVIRONMENTS.find((e) => e.boxDomain === want);
  if (!found) throw new Error(`unknown Plum box domain "${boxDomain}" (only plumbox.me and staging.plumbox.me exist)`);
  return found;
}

/** The environment whose box domain `host` lies in — the most specific one. */
function environmentOfHost(host: string): PlumEnvironment | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  let best: PlumEnvironment | undefined;
  for (const e of ENVIRONMENTS) {
    if ((h === e.boxDomain || h.endsWith("." + e.boxDomain)) && (!best || e.boxDomain.length > best.boxDomain.length)) {
      best = e;
    }
  }
  return best;
}

/**
 * Whether `url` is an address of another environment than `env`: its host
 * lies in another environment's box domain. An address of no environment (a
 * LAN IP, localhost, a test server) is not foreign; neither is one that
 * cannot be read.
 */
export function isForeignUrl(url: string, env: PlumEnvironment): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const owner = environmentOfHost(host);
  return owner !== undefined && owner.name !== env.name;
}
