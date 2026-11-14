package im.plum.plumbox.client

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers.Companion.toHeaders
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Transport abstraction, as in `http.ts`: the SDK never talks to the network
 * directly — it builds [HttpRequest]s and hands them to an [HttpAdapter].
 * [OkHttpAdapter] is the default; pass your own to share an app-wide
 * [OkHttpClient] (certificate pinning, interceptors, a proxy) or to fake the
 * box in tests.
 */
public class HttpRequest(
    public val url: String,
    public val method: String,
    /** Header names as given; the SDK uses lower case. */
    public val headers: Map<String, String> = emptyMap(),
    /**
     * Always an in-memory buffer, so a request can be sent a second time
     * unchanged (the retry after a refresh).
     */
    public val body: ByteArray? = null,
) {
    override fun toString(): String = "HttpRequest($method $url)"
}

public class HttpResponse(
    public val status: Int,
    /** Lower-cased header names; repeated headers are joined with ", ". */
    public val headers: Map<String, String>,
    public val body: ByteArray,
) {
    /** The body as UTF-8 text. */
    public fun text(): String = String(body, Charsets.UTF_8)

    override fun toString(): String = "HttpResponse($status, ${body.size} bytes)"
}

/** Sends one request and returns the box's answer, whatever its status. */
public fun interface HttpAdapter {
    /**
     * Return the response for any HTTP status (the SDK maps statuses to
     * errors itself). Throw only when there is no answer at all; the default
     * adapter throws [PlumApiError] with status 0 and code `"network_error"`.
     */
    public suspend fun request(req: HttpRequest): HttpResponse
}

/**
 * The default transport, on [OkHttp](https://square.github.io/okhttp/).
 *
 * The default client does not follow redirects: the token endpoint must be
 * `<iss>/api/oauth/token` and nowhere else, and a box API call never
 * redirects. A 3xx comes back as a [PlumApiError]. If you pass your own
 * [client], keep it that way (`followRedirects(false)`).
 */
public class OkHttpAdapter(private val client: OkHttpClient = defaultClient) : HttpAdapter {

    override suspend fun request(req: HttpRequest): HttpResponse {
        val method = req.method.uppercase(Locale.ROOT)
        // A null media type: the content-type header goes out exactly as given.
        val body = when {
            req.body != null -> req.body.toRequestBody(null)
            method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val request = try {
            Request.Builder()
                .url(req.url)
                .headers(req.headers.toHeaders())
                .method(method, body)
                .build()
        } catch (e: IllegalArgumentException) {
            throw PlumApiError(0, "not a request the SDK can send: ${e.message}", "invalid_request", e)
        }
        val call = client.newCall(request)
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    cont.resumeWithException(
                        PlumApiError(0, "could not reach ${request.url.host}: ${e.message ?: e.javaClass.simpleName}", "network_error", e),
                    )
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use {
                            val headers = it.headers.names().associate { name ->
                                name.lowercase(Locale.ROOT) to it.headers.values(name).joinToString(", ")
                            }
                            HttpResponse(it.code, headers, it.body?.bytes() ?: ByteArray(0))
                        }
                    } catch (e: IOException) {
                        cont.resumeWithException(
                            PlumApiError(0, "the answer from ${request.url.host} broke off: ${e.message}", "network_error", e),
                        )
                        return
                    }
                    cont.resume(result)
                }
            })
        }
    }

    public companion object {
        /**
         * The client [OkHttpAdapter] uses by default: no redirects, and
         * timeouts that leave room for a box finishing a large upload.
         */
        public val defaultClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .build()
        }

        internal val default: OkHttpAdapter by lazy { OkHttpAdapter() }
    }
}

internal fun joinUrl(base: String, path: String): String =
    base.trimEnd('/') + if (path.startsWith("/")) path else "/$path"

/**
 * `application/x-www-form-urlencoded`, the same bytes as JavaScript's
 * `URLSearchParams` (space as `+`, `*-._` and alphanumerics left as they are).
 */
internal fun formEncode(params: List<Pair<String, String>>): String =
    params.joinToString("&") { (k, v) -> URLEncoder.encode(k, "UTF-8") + "=" + URLEncoder.encode(v, "UTF-8") }

/** JavaScript's `encodeURIComponent`, for one path segment. */
internal fun encodeUriComponent(s: String): String =
    URLEncoder.encode(s, "UTF-8")
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%7E", "~")

private val boundaryRandom = SecureRandom()

/**
 * A multipart/form-data body built by hand, as `buildMultipart` in `http.ts`:
 * the fields, then one file part. Returns the body and its content type.
 */
internal fun buildMultipart(
    fields: List<Pair<String, String>>,
    fileField: String,
    fileName: String,
    data: ByteArray,
    contentType: String?,
): Pair<ByteArray, String> {
    val boundary = "----plumbox" + java.lang.Long.toString(boundaryRandom.nextLong() and Long.MAX_VALUE, 36) +
        java.lang.Long.toString(System.currentTimeMillis(), 36)
    val out = java.io.ByteArrayOutputStream(data.size + 512)
    fun write(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
    for ((k, v) in fields) {
        write("--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n$v\r\n")
    }
    // RFC 2388 filename: kept UTF-8; the Go server reads it verbatim.
    val escapedName = fileName.replace("\"", "%22")
    write(
        "--$boundary\r\nContent-Disposition: form-data; name=\"$fileField\"; filename=\"$escapedName\"\r\n" +
            "Content-Type: ${contentType ?: "application/octet-stream"}\r\n\r\n",
    )
    out.write(data)
    write("\r\n--$boundary--\r\n")
    return out.toByteArray() to "multipart/form-data; boundary=$boundary"
}
