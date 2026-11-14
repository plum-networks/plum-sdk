package im.plum.plumbox.client

import org.json.JSONObject

/**
 * One connection to one box — what an app needs to rebuild its [PlumClient]
 * after a restart: the box, the client id the tokens were issued to, and the
 * whole token set.
 */
public data class PlumConnection(
    /** The box's verified address (the callback's `iss`). Use it as `baseUrl`. */
    val iss: String,
    /** The client id the tokens were issued to; `null` for a bare personal access token. */
    val clientId: String?,
    val tokens: OAuthTokens,
)

/**
 * Where [PlumClient] keeps the connection. [PlumClient.setToken] saves it,
 * every refresh saves the rotated set (before `onTokens` runs and before the
 * request that needed it is retried), and [PlumClient.clearToken] clears it.
 *
 * On Android use [KeystoreTokenStore]; replace it with your own (a database
 * row, your app's encrypted settings) by implementing these three calls.
 * Keep it on ONE device: the refresh token rotates on every use, so a store
 * that syncs or backs up to another device makes the two knock each other
 * out.
 *
 * The TypeScript SDK's `tokenStorage` is a key/value store holding the token
 * JSON; this one is typed and also keeps `iss` and `clientId`, which an
 * Android app needs to rebuild the client after its process was killed.
 */
public interface TokenStore {
    /** The saved connection, or `null` when there is none (or it cannot be read). */
    public suspend fun load(): PlumConnection?

    /** Replace the saved connection. Write it durably before returning. */
    public suspend fun save(connection: PlumConnection)

    /** Forget the saved connection. */
    public suspend fun clear()
}

/** A [TokenStore] in memory: for tests, and for an app that persists in `onTokens` itself. */
public class InMemoryTokenStore(initial: PlumConnection? = null) : TokenStore {
    @Volatile
    private var connection: PlumConnection? = initial

    override suspend fun load(): PlumConnection? = connection

    override suspend fun save(connection: PlumConnection) {
        this.connection = connection
    }

    override suspend fun clear() {
        connection = null
    }
}

/**
 * The stored form of a [PlumConnection]: JSON with the token set under the
 * same field names `@plumbox/client` stores (`accessToken`, `refreshToken`,
 * `expiresAt`, `appFolder`, …) plus `iss` and `clientId`.
 */
internal object ConnectionCodec {
    private const val VERSION = 1

    fun encode(c: PlumConnection): String {
        val o = JSONObject()
            .put("v", VERSION)
            .put("iss", c.iss)
            .put("accessToken", c.tokens.accessToken)
            .put("tokenType", c.tokens.tokenType)
            .put("scope", c.tokens.scope)
        c.clientId?.let { o.put("clientId", it) }
        c.tokens.refreshToken?.let { o.put("refreshToken", it) }
        c.tokens.expiresAt?.let { o.put("expiresAt", it) }
        c.tokens.appFolder?.let { o.put("appFolder", it) }
        return o.toString()
    }

    /** `null` for anything that is not a connection this codec wrote. */
    fun decode(text: String): PlumConnection? {
        val o = Json.parseObjectOrNull(text) ?: return null
        if (o.number("v")?.toInt() != VERSION) return null
        val iss = o.string("iss")?.takeIf { it.isNotEmpty() } ?: return null
        val access = o.string("accessToken") ?: return null
        val refresh = o.string("refreshToken")?.takeIf { it.isNotEmpty() }
        if (access.isEmpty() && refresh == null) return null
        return PlumConnection(
            iss = iss,
            clientId = o.string("clientId")?.takeIf { it.isNotEmpty() },
            tokens = OAuthTokens(
                accessToken = access,
                tokenType = o.string("tokenType")?.takeIf { it.isNotEmpty() } ?: "bearer",
                scope = o.string("scope") ?: "",
                refreshToken = refresh,
                expiresAt = o.number("expiresAt")?.toLong(),
                appFolder = o.string("appFolder")?.takeIf { it.isNotEmpty() },
            ),
        )
    }
}
