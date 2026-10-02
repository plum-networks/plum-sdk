/** Error thrown for any non-2xx API response. */
export class PlumApiError extends Error {
  readonly status: number;
  /** Machine-readable code when the server provided one (e.g. "version_mismatch"). */
  readonly code?: string;
  /**
   * How long the server asked the caller to wait before trying again, in
   * milliseconds, from a `Retry-After` header (delta-seconds or HTTP-date).
   * Undefined when the response carried none. The SDK never retries on its
   * own; when you do, wait at least this long.
   */
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = "PlumApiError";
    this.status = status;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** 401/403: missing, expired, or revoked credential. Triggers `onAuthError`. */
export class PlumAuthError extends PlumApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = "PlumAuthError";
  }
}

/**
 * 503 `listing_incomplete`: the box could not read every folder under the path
 * of a recursive listing, so it refused to answer rather than return a list
 * with holes in it. It is NOT an empty folder and NOT a partial result to work
 * with: a sync client that diffed against it would read every missing path as
 * deleted. Abort the pass and list again later — no sooner than
 * `retryAfterMs` when the box said so. With `drive.listAll`, entries already
 * yielded before this was thrown are not a complete listing either.
 */
export class ListingIncompleteError extends PlumApiError {
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(status, message, "listing_incomplete", retryAfterMs);
    this.name = "ListingIncompleteError";
  }
}

/**
 * Parse a `Retry-After` value (RFC 9110 §10.2.3: delta-seconds or an
 * HTTP-date) into milliseconds from `now`. Undefined when absent or
 * unparseable; a date in the past is 0.
 */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/[a-z]/i.test(v)) return undefined; // not a date either ("-1", "1.5")
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Parse the box's error body ({"error","message"} JSON or plain text) and,
 * when given, the response headers (lower-cased names, as adapters return
 * them) for `Retry-After`.
 */
export function errorFromResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): PlumApiError {
  let message = bodyText.trim();
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
    if (parsed && (parsed.message || parsed.error)) {
      message = parsed.message ?? parsed.error ?? message;
      code = parsed.error;
    }
  } catch {
    // plain-text error body
  }
  if (message.length > 500) message = message.slice(0, 500);
  const retryAfterMs = parseRetryAfter(headers["retry-after"]);
  if (status === 401 || status === 403) return new PlumAuthError(status, message, code);
  if (code === "listing_incomplete") return new ListingIncompleteError(status, message, retryAfterMs);
  return new PlumApiError(status, message, code, retryAfterMs);
}
