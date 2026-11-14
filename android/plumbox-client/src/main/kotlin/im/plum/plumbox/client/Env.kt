@file:JvmName("PlumEnvironments")

package im.plum.plumbox.client

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Locale

/**
 * The one place in the SDK that knows Plum's environments and their
 * addresses: the box domain (a box is `https://pb-<name>.<boxDomain>`), the
 * portal where people find their box, and the relay. Mirrors `env.ts`.
 *
 * Production is the default everywhere. Staging (`staging.plumbox.me`) is for
 * Plum's own test environment; an app chooses it with the `boxDomain`
 * argument. Each environment accepts only its own addresses: a production
 * client never takes a staging box, and a staging client never takes a
 * production one.
 */
public enum class PlumEnvironment(
    /** A box is `https://pb-<name>.<boxDomain>`. */
    public val boxDomain: String,
    /** Where people find their box and the authorization starts. */
    public val portalOrigin: String,
    /** The relay. */
    public val relayUrl: String,
) {
    PRODUCTION("plumbox.me", "https://plumbox.me", "https://relay.plumbox.me"),
    STAGING("staging.plumbox.me", "https://staging.plumbox.me", "https://relay.staging.plumbox.me"),
}

/**
 * The environment whose box domain is [boxDomain] (case-insensitive). `null`
 * or empty is production. Anything else throws [IllegalArgumentException]:
 * there is no third environment, and a typo must not quietly become one.
 */
public fun plumEnvironment(boxDomain: String? = null): PlumEnvironment {
    if (boxDomain.isNullOrEmpty()) return PlumEnvironment.PRODUCTION
    val want = boxDomain.lowercase(Locale.ROOT)
    return PlumEnvironment.entries.firstOrNull { it.boxDomain == want }
        ?: throw IllegalArgumentException(
            "unknown Plum box domain \"$boxDomain\" (only plumbox.me and staging.plumbox.me exist)",
        )
}

/** The environment whose box domain [host] lies in — the most specific one. */
private fun environmentOfHost(host: String): PlumEnvironment? {
    val h = host.lowercase(Locale.ROOT).removeSuffix(".")
    return PlumEnvironment.entries
        .filter { h == it.boxDomain || h.endsWith("." + it.boxDomain) }
        .maxByOrNull { it.boxDomain.length }
}

/**
 * Whether [url] is an address of another environment than [env]: its host
 * lies in another environment's box domain. An address of no environment (a
 * LAN IP, localhost, a test server) is not foreign; neither is one that
 * cannot be read.
 */
public fun isForeignUrl(url: String, env: PlumEnvironment): Boolean {
    val host = url.toHttpUrlOrNull()?.host ?: return false
    val owner = environmentOfHost(host) ?: return false
    return owner != env
}
