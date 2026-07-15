import { errorFromResponse } from "./errors.js";
import type { HttpAdapter } from "./http.js";
import { responseJSON, responseText } from "./http.js";
import { fetchAdapter } from "./adapters/fetch.js";

export const DEFAULT_RELAY_URL = "https://relay.plumbox.me";

export interface DiscoverResult {
  /** e.g. "pb-0123abcd…" */
  subdomain: string;
  /** Ready-to-use base URL: `https://<subdomain>.plumbox.me` */
  baseUrl: string;
}

/**
 * Resolve the Plum Box belonging to an account email.
 *
 * CACHE THE RESULT (e.g. in your app's settings): the endpoint is rate-limited
 * to ~10 requests/minute per source IP, and a box's subdomain is stable for
 * its lifetime. Re-discover only when a stored subdomain stops resolving.
 */
export async function discover(
  email: string,
  opts?: { relayUrl?: string; http?: HttpAdapter },
): Promise<DiscoverResult> {
  const relay = (opts?.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  const http = opts?.http ?? fetchAdapter;
  const res = await http.request({
    url: `${relay}/api/lookup`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (res.status !== 200) {
    throw errorFromResponse(res.status, responseText(res));
  }
  const { subdomain } = responseJSON<{ subdomain: string }>(res);
  if (!subdomain) {
    throw errorFromResponse(502, "relay lookup returned no subdomain");
  }
  return { subdomain, baseUrl: `https://${subdomain}.plumbox.me` };
}
