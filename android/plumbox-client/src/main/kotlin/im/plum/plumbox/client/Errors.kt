package im.plum.plumbox.client

/**
 * Thrown for any non-2xx answer from the box (mirrors `PlumApiError` in
 * `errors.ts`).
 *
 * [status] is the HTTP status. It is `0` when no HTTP answer came back at all
 * (the box or the relay could not be reached); [code] is then
 * `"network_error"` and [cause] holds the transport's exception.
 *
 * Named `…Error` like the TypeScript SDK so the same names work on every
 * platform; it is an [Exception], not a [java.lang.Error].
 */
public open class PlumApiError(
    public val status: Int,
    message: String,
    /** Machine-readable code when the box provided one (e.g. `"invalid_grant"`). */
    public val code: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    override fun toString(): String =
        "${this::class.java.simpleName}(status=$status, code=$code, message=$message)"
}

/**
 * The credential itself is no good: a 401 (missing, expired or revoked
 * token), or a refresh the box refused with `invalid_grant` (status 400,
 * [code] `"invalid_grant"`: the connection is gone and the user has to
 * connect again). Triggers `onAuthError`.
 *
 * A 403 is NOT one of these — see [PlumForbiddenError].
 */
public class PlumAuthError(status: Int, message: String, code: String? = null) :
    PlumApiError(status, message, code)

/**
 * 403: the credential is fine, but it may not do this — a scope it was not
 * granted, or (a `files:app` token) a path outside its app folder. Signing in
 * again would not change the answer, so it does NOT trigger `onAuthError`.
 */
public class PlumForbiddenError(status: Int, message: String, code: String? = null) :
    PlumApiError(status, message, code)

/**
 * A sign-in the SDK stopped on its own, before anything was sent: the
 * redirect back from the box did not hold up. [code] says why:
 *
 * - [INVALID_ISS]: the callback named no box, or something that is not a Plum
 *   box's own address (`https://pb-….plumbox.me`). The authorization code is
 *   never sent anywhere.
 * - [INVALID_STATE]: the callback's `state` is not the one this sign-in began
 *   with (a forged or stale redirect).
 * - [INVALID_REQUEST]: no code and no error, or a required value is missing.
 */
public class PlumOAuthError(public val code: String, message: String) : Exception(message) {
    public companion object {
        public const val INVALID_ISS: String = "invalid_iss"
        public const val INVALID_STATE: String = "invalid_state"
        public const val INVALID_REQUEST: String = "invalid_request"
    }

    override fun toString(): String = "PlumOAuthError(code=$code, message=$message)"
}

/** Parse the box's error body (`{"error","message"}` JSON or plain text). */
internal fun errorFromResponse(status: Int, bodyText: String): PlumApiError {
    var message = bodyText.trim()
    var code: String? = null
    val parsed = Json.parseObjectOrNull(bodyText)
    if (parsed != null) {
        val m = parsed.string("message")
        val e = parsed.string("error")
        if (!m.isNullOrEmpty() || !e.isNullOrEmpty()) {
            message = m ?: e ?: message
            code = e
        }
    }
    if (message.length > 500) message = message.substring(0, 500)
    return when (status) {
        401 -> PlumAuthError(status, message, code)
        403 -> PlumForbiddenError(status, message, code)
        else -> PlumApiError(status, message, code)
    }
}
