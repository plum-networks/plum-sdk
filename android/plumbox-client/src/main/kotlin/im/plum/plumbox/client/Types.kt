package im.plum.plumbox.client

/**
 * What the box's token endpoint hands back, from [exchangeCode] or
 * [refreshTokens] (and to [PlumClient]'s `onTokens`). Persist all of it.
 *
 * A box from before access tokens expired answers with [accessToken] +
 * [scope] only: such a token never expires and has no refresh token — keep
 * using it as it is.
 *
 * [toString] leaves the two secrets out, so a stray log line does not leak them.
 */
public data class OAuthTokens(
    /** The bearer token (`plum_pat_…`). */
    val accessToken: String,
    /** Always `"bearer"`. */
    val tokenType: String = "bearer",
    /** The scopes granted, space-separated (may be fewer than requested). */
    val scope: String = "",
    /**
     * Trade it for a new token set with [refreshTokens] ([PlumClient] does it
     * for you). It ROTATES: every refresh returns a new one and the old one
     * stops working, so always store the newest. It lapses after 90 days
     * unused. `null` from older boxes: the access token then never expires.
     */
    val refreshToken: String? = null,
    /**
     * When the access token expires, in ms since the epoch on THIS device's
     * clock (computed from the box's `expires_in` on receipt). `null`: no
     * known expiry.
     */
    val expiresAt: Long? = null,
    /**
     * Present when `files:app` was granted: the absolute drive path the token
     * may read and write under (e.g. `/Apps/Obsidian Sync`). The box creates
     * the folder before it issues the token. Paths you send stay absolute
     * drive paths inside it (`/Apps/Obsidian Sync/MyVault/note.md`).
     */
    val appFolder: String? = null,
) {
    override fun toString(): String =
        "OAuthTokens(accessToken=${redact(accessToken)}, tokenType=$tokenType, scope=$scope, " +
            "refreshToken=${refreshToken?.let(::redact)}, expiresAt=$expiresAt, appFolder=$appFolder)"
}

/** `plum_pat_…` — the prefix says what it is, the secret stays out of logs. */
internal fun redact(secret: String): String = (TOKEN_PREFIX.find(secret)?.value ?: "") + "…"

private val TOKEN_PREFIX = Regex("^[a-z]{1,8}_[a-z]{1,8}_")

/**
 * Scopes a registered companion app may ask the box owner for. One vocabulary
 * on every surface — the developer console's client registration, the box's
 * consent screen and the token it mints:
 *
 * - [FILES_APP]    read and write ONE folder the box makes for the app
 *                  ([OAuthTokens.appFolder], e.g. `/Apps/Obsidian Sync`) and
 *                  nothing else — not the rest of the drive, not the trash.
 *                  The least a sync app needs.
 * - [FILES_READ]   read the user's files
 * - [FILES_WRITE]  change files (implies files:read)
 * - [USER_PROFILE] read the signed-in user's profile only
 * - [serviceCall]  `service:call:<app_id>`: call that app's box-side service
 *
 * [READ] / [WRITE] are the older spellings and still work (`write` =
 * files:read + files:write). `admin` is never delegated to an app.
 */
public object OAuthScope {
    public const val FILES_APP: String = "files:app"
    public const val FILES_READ: String = "files:read"
    public const val FILES_WRITE: String = "files:write"
    public const val USER_PROFILE: String = "user:profile"

    /** Older spelling of [FILES_READ]. */
    public const val READ: String = "read"

    /** Older spelling of [FILES_READ] + [FILES_WRITE]. */
    public const val WRITE: String = "write"

    /** `service:call:<appId>` — call that app's box-side service. */
    @JvmStatic
    public fun serviceCall(appId: String): String = "service:call:$appId"
}

/** One entry from `drive.list` / `drive.listAll`. */
public data class DriveEntry(
    val name: String,
    val path: String,
    val isDir: Boolean,
    val size: Long,
    /** RFC 3339 timestamp as reported by the box. */
    val modTime: String,
    /**
     * SHA-256 of the file content — present only when requested with
     * `hash = true` AND the box has indexed the file (files uploaded before
     * hash indexing omit it; fall back to size + modTime).
     */
    val hash: String? = null,
)

/** One page of `drive.list`. */
public data class ListPage(
    val items: List<DriveEntry>,
    val total: Int,
    val limit: Int,
    val offset: Int,
)

/** Sort key for `drive.list` (`sort=`). */
public enum class ListSort(internal val wire: String) {
    NAME("name"),
    SIZE("size"),
    MODIFIED("modified"),
    TYPE("type"),
    PATH("path"),
}

/** Sort direction for `drive.list` (`order=`). */
public enum class ListOrder(internal val wire: String) {
    ASC("asc"),
    DESC("desc"),
}

/** The signed-in user, from `auth.me()` (needs `user:profile`, or a read scope). */
public data class PlumUser(
    val id: String,
    val username: String? = null,
    val email: String? = null,
    val displayName: String? = null,
)
