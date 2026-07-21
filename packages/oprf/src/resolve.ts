import {
  base64ToBytes,
  deriveSeed,
  lookupId,
  oprfBlind,
  oprfFinalize,
  openLocator,
  type Locator,
} from "./crypto.js";

export const DEFAULT_RELAY_URL = "https://relay.plumbox.me";

/**
 * Minimal HTTP transport — structurally identical to `@plumbox/client`'s
 * `HttpAdapter`, so the same fetch/`requestUrl` adapter can be passed here.
 */
export interface HttpAdapter {
  request(req: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | Uint8Array;
  }): Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }>;
}

const globalFetchAdapter: HttpAdapter = {
  async request(req) {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | undefined,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.arrayBuffer() };
  },
};

function decodeJSON<T>(body: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

/** A box discovered zero-knowledge from (email, secret). */
export interface DiscoveredBox extends Locator {
  /** Ready-to-use base URL: `https://<sub>.plumbox.me`. */
  baseUrl: string;
}

export interface ResolveOptions {
  relayUrl?: string;
  http?: HttpAdapter;
  /** Base domain for the box host (default "plumbox.me"). */
  hostSuffix?: string;
}

/**
 * Find every Plum Box reachable with these credentials, WITHOUT the relay
 * learning the email, the password, or which box — the whole point of the
 * zero-knowledge directory. `secret` is normally the account password (or an
 * invite/recovery code for those flows).
 *
 * Returns an empty array when no box matches (wrong credentials, or none
 * registered) — the relay answers a uniform 404 for both, so there is no way
 * to distinguish them, by design (no existence oracle).
 */
export async function resolveBoxes(
  email: string,
  secret: string,
  opts: ResolveOptions = {},
): Promise<DiscoveredBox[]> {
  const relay = (opts.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  const http = opts.http ?? globalFetchAdapter;
  const hostSuffix = opts.hostSuffix ?? "plumbox.me";

  const seed = await deriveSeed(email, secret);
  const lookup = await lookupId(seed);

  const { r, blindedHex } = await oprfBlind(lookup);
  const oprfRes = await http.request({
    url: `${relay}/api/oprf`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blinded: blindedHex }),
  });
  if (oprfRes.status !== 200) {
    throw new Error(`relay OPRF eval failed (HTTP ${oprfRes.status})`);
  }
  const { evaluated } = decodeJSON<{ evaluated: string }>(oprfRes.body);
  const token = await oprfFinalize(lookup, r, evaluated);

  const resolveRes = await http.request({
    url: `${relay}/api/resolve`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (resolveRes.status === 404) return []; // uniform "no box" — not an error
  if (resolveRes.status !== 200) {
    throw new Error(`relay resolve failed (HTTP ${resolveRes.status})`);
  }

  const { locators } = decodeJSON<{ locators: string[] }>(resolveRes.body);
  const out: DiscoveredBox[] = [];
  for (const b64 of locators) {
    try {
      const loc = await openLocator(seed, base64ToBytes(b64));
      out.push({ ...loc, baseUrl: `https://${loc.sub}.${hostSuffix}` });
    } catch {
      // Blob sealed for a different account (committing check) — skip.
    }
  }
  return out;
}
