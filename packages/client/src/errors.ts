/** Error thrown for any non-2xx API response. */
export class PlumApiError extends Error {
  readonly status: number;
  /** Machine-readable code when the server provided one (e.g. "version_mismatch"). */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "PlumApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The credential itself is no good: a 401 (missing, expired or revoked token),
 * or a refresh the box refused with `invalid_grant` (status 400, `code`
 * `"invalid_grant"`: the connection is gone and the user has to connect
 * again). Triggers `onAuthError`.
 *
 * Since 0.4.0 a 403 is NOT one of these — see {@link PlumForbiddenError}.
 */
export class PlumAuthError extends PlumApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = "PlumAuthError";
  }
}

/**
 * 403: the credential is fine, but it may not do this — a scope it was not
 * granted, or (a `files:app` token) a path outside its app folder. Signing in
 * again would not change the answer, so it does NOT trigger `onAuthError`.
 *
 * Before 0.4.0 a 403 came as `PlumAuthError`; it is a `PlumApiError` now.
 */
export class PlumForbiddenError extends PlumApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = "PlumForbiddenError";
  }
}

/**
 * A sign-in the SDK stopped on its own, before anything was sent: the
 * redirect back from the box did not hold up. `code` says why:
 *
 * - `invalid_iss`: the callback named no box, or something that is not a Plum
 *   box's own address (`https://pb-….plumbox.me`). The authorization code is
 *   never sent anywhere.
 * - `invalid_state`: the callback's `state` is not the one this sign-in began
 *   with (a forged or stale redirect).
 * - `invalid_request`: no code and no error, or a required value is missing.
 */
export class PlumOAuthError extends Error {
  readonly code: "invalid_iss" | "invalid_state" | "invalid_request";

  constructor(code: PlumOAuthError["code"], message: string) {
    super(message);
    this.name = "PlumOAuthError";
    this.code = code;
  }
}

/** Parse the box's error body ({"error","message"} JSON or plain text). */
export function errorFromResponse(status: number, bodyText: string): PlumApiError {
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
  if (status === 401) return new PlumAuthError(status, message, code);
  if (status === 403) return new PlumForbiddenError(status, message, code);
  return new PlumApiError(status, message, code);
}
