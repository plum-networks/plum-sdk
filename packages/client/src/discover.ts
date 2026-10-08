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
 * @deprecated Connect with delegated OAuth instead (`beginAuthorization` →
 * `parseCallback` → `exchangeCode`): the callback's `iss` names the user's
 * box, so an app never has to look one up. This function goes away in a later
 * minor version, when the relay switches `/api/lookup` off.
 *
 * This resolves a box from an email alone via the relay's LEGACY `/api/lookup`.
 * That endpoint is an existence oracle — anyone who guesses an email learns
 * whether that person owns a box and its address — and Plum Box v3 retires it:
 * people now find their boxes on plumbox.me with a code mailed to them. The
 * other old route, `resolveBoxes` from `@plumbox/oprf`, is deprecated for the
 * same reason.
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
