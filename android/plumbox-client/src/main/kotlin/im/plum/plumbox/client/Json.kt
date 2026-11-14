package im.plum.plumbox.client

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The little JSON the SDK reads and writes, through the platform's org.json
 * (no serialization framework, nothing for an app's R8 to keep). Reading is
 * typed by hand the way the TypeScript SDK checks `typeof` — a field of the
 * wrong type counts as absent.
 */
internal object Json {
    /** The body as a JSON object, or null when it is not one. */
    fun parseObjectOrNull(text: String): JSONObject? =
        try {
            JSONTokener(text).nextValue() as? JSONObject
        } catch (_: JSONException) {
            null
        }

    /** A JSON object body from [fields]; `null` values are left out. */
    fun encode(vararg fields: Pair<String, Any?>): ByteArray {
        val o = JSONObject()
        for ((k, v) in fields) if (v != null) o.put(k, v)
        return o.toString().toByteArray(Charsets.UTF_8)
    }
}

internal fun JSONObject.string(key: String): String? = opt(key) as? String

internal fun JSONObject.number(key: String): Number? = opt(key) as? Number

internal fun JSONObject.bool(key: String): Boolean? = opt(key) as? Boolean

internal fun JSONObject.obj(key: String): JSONObject? = opt(key) as? JSONObject

internal fun JSONObject.array(key: String): JSONArray? = opt(key) as? JSONArray

/** The body of [res] as a JSON object; anything else is the box answering out of contract. */
internal fun responseObject(res: HttpResponse): JSONObject =
    Json.parseObjectOrNull(res.text())
        ?: throw PlumApiError(res.status, "the box's answer was not a JSON object", "invalid_response")
