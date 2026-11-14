package im.plum.plumbox.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import java.util.Locale

/**
 * The Android half of the sign-in: open the authorization URL in the system
 * browser, and read the redirect that comes back to your app.
 *
 * The URL opens in a **Custom Tab** — the user's own browser, with its
 * address bar, its saved passwords and none of your app's code in the page
 * — never in a WebView. An embedded WebView would let your app read what the
 * user types, which defeats the point of the delegated flow (RFC 8252 §8.12).
 * Without a Custom Tabs browser the URL opens in the default browser.
 *
 * Receiving the redirect is your app's: register an Activity with an
 * intent-filter for your redirect URI (see the README) and hand its intent
 * to [parseCallback].
 */
public object PlumAuthorization {

    /**
     * Open [request]'s URL in a Custom Tab. Keep [AuthorizationRequest.state]
     * and [AuthorizationRequest.codeVerifier] somewhere that survives your
     * process being killed while the browser is open.
     *
     * @param context an Activity (the tab opens in its task); any other
     *   context starts a new task.
     * @param toolbarColor the tab's toolbar colour (ARGB), or `null` for the browser's own.
     * @throws IllegalArgumentException when the URL is not https.
     * @throws android.content.ActivityNotFoundException when the device has no browser at all.
     */
    @JvmStatic
    @JvmOverloads
    public fun launch(context: Context, request: AuthorizationRequest, toolbarColor: Int? = null) {
        val uri = Uri.parse(request.url)
        require(uri.scheme.equals("https", ignoreCase = true)) {
            "PlumAuthorization.launch: the authorization URL must be https (got ${uri.scheme})"
        }
        val builder = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(false)
        if (toolbarColor != null) {
            builder.setDefaultColorSchemeParams(
                CustomTabColorSchemeParams.Builder().setToolbarColor(toolbarColor).build(),
            )
        }
        val tab = builder.build()
        if (context !is Activity) tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        tab.launchUrl(context, uri)
    }

    /**
     * Read the redirect in [intent] (the one your redirect Activity was
     * started or resumed with) and check its `iss`, exactly as the top-level
     * [im.plum.plumbox.client.parseCallback] does.
     *
     * Returns `null` when the intent is not a redirect to [redirectUri] (no
     * data, or another scheme, host or path), so an Activity that also takes
     * other deep links can tell them apart.
     */
    @JvmStatic
    @JvmOverloads
    public fun parseCallback(intent: Intent?, redirectUri: String, boxDomain: String? = null): CallbackResult? {
        val data = intent?.data ?: return null
        return parseCallback(data, redirectUri, boxDomain)
    }

    /** [parseCallback] for a [Uri] you already took out of the intent. */
    @JvmStatic
    @JvmOverloads
    public fun parseCallback(uri: Uri, redirectUri: String, boxDomain: String? = null): CallbackResult? {
        val want = Uri.parse(redirectUri)
        if (!sameTarget(uri, want)) return null
        return im.plum.plumbox.client.parseCallback(uri.toString(), boxDomain)
    }

    private fun sameTarget(a: Uri, b: Uri): Boolean =
        a.scheme?.lowercase(Locale.ROOT) == b.scheme?.lowercase(Locale.ROOT) &&
            a.encodedAuthority?.lowercase(Locale.ROOT) == b.encodedAuthority?.lowercase(Locale.ROOT) &&
            (a.encodedPath ?: "").trimEnd('/') == (b.encodedPath ?: "").trimEnd('/')
}
