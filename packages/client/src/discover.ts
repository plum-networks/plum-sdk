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
 * @deprecated Use `resolveBoxes(email, password)` from `@plumbox/oprf` instead.
 *
 * This resolves a box from an email alone via the relay's LEGACY `/api/lookup`.
 * That endpoint is an existence oracle — anyone who guesses an email learns
 * whether that person owns a box and its address — and it is being retired. The
 * zero-knowledge path (`@plumbox/oprf`) requires the password too, so the relay
 * never learns the email, the password, or which box. Prefer it for anything
 * new; this remains only for boxes/relays that predate the routing directory.
 *
 * CACHE THE RESULT: the endpoint is rate-limited to ~10 requests/minute per
 * source IP, and a box's subdomain is stable for its lifetime.
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
