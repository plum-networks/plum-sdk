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

/** 401/403: missing, expired, or revoked credential. Triggers `onAuthError`. */
export class PlumAuthError extends PlumApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, code);
    this.name = "PlumAuthError";
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
  if (status === 401 || status === 403) return new PlumAuthError(status, message, code);
  return new PlumApiError(status, message, code);
}
