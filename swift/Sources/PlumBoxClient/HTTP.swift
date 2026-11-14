import Foundation

// The transport is Foundation's URLSession: every call that talks to a box
// takes a `urlSession` (default `.shared`), the Swift counterpart of
// `@plumbox/client`'s `http` adapter option. Tests pass a session whose
// configuration registers a URLProtocol.

/// Send one request and read the whole answer. Transport failures (no network,
/// TLS, timeouts) come through as URLSession's own `URLError`.
func perform(
    _ urlSession: URLSession,
    url: URL,
    method: String,
    headers: [String: String],
    body: Data?
) async throws -> PlumResponse {
    var req = URLRequest(url: url)
    req.httpMethod = method
    // Answers from a box are the user's live data and credentials: never
    // from (or into) a cache, and no cookies — the token is the credential.
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.httpShouldHandleCookies = false
    for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
    req.httpBody = body
    let (data, response) = try await urlSession.data(for: req)
    guard let http = response as? HTTPURLResponse else {
        throw URLError(.badServerResponse)
    }
    var lower: [String: String] = [:]
    for (k, v) in http.allHeaderFields {
        if let k = k as? String, let v = v as? String { lower[k.lowercased()] = v }
    }
    return PlumResponse(status: http.statusCode, headers: lower, body: data)
}

/// `base` without trailing slashes, then `path` with exactly one leading slash.
func joinURL(_ base: String, _ path: String) -> String {
    trimTrailingSlashes(base) + (path.hasPrefix("/") ? path : "/" + path)
}

func trimTrailingSlashes(_ s: String) -> String {
    var s = Substring(s)
    while s.hasSuffix("/") { s = s.dropLast() }
    return String(s)
}

func makeURL(_ string: String) throws -> URL {
    guard let url = URL(string: string) else {
        throw PlumUsageError("not a URL: \(string)")
    }
    return url
}

/// `application/x-www-form-urlencoded`, byte for byte what the WHATWG
/// `URLSearchParams` serializer writes (`@plumbox/client` builds every query
/// with it): ASCII letters, digits and `*-._` stay, a space becomes `+`,
/// everything else is percent-encoded UTF-8. (`URLComponents.queryItems`
/// would leave `+` and `/` alone, and the box reads a bare `+` as a space.)
func formEncode(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.utf8.count)
    for b in s.utf8 {
        switch b {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "*"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"):
            out.unicodeScalars.append(Unicode.Scalar(b))
        case UInt8(ascii: " "):
            out.append("+")
        default:
            out.append(String(format: "%%%02X", b))
        }
    }
    return out
}

/// An ordered query string, as `new URLSearchParams([...]).toString()`.
func formQuery(_ pairs: [(String, String)]) -> String {
    pairs.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
}

/// JavaScript's `encodeURIComponent`: keeps `A–Z a–z 0–9 - _ . ! ~ * ' ( )`.
func encodeURIComponent(_ s: String) -> String {
    var out = ""
    for b in s.utf8 {
        switch b {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "!"),
             UInt8(ascii: "~"), UInt8(ascii: "*"), UInt8(ascii: "'"), UInt8(ascii: "("), UInt8(ascii: ")"):
            out.unicodeScalars.append(Unicode.Scalar(b))
        default:
            out.append(String(format: "%%%02X", b))
        }
    }
    return out
}

/// Read an `application/x-www-form-urlencoded` query the way `URLSearchParams`
/// does: split on `&`, then on the first `=`, `+` is a space, then
/// percent-decoding. Order and repeats are kept.
func formDecodeQuery(_ query: String) -> [(String, String)] {
    var out: [(String, String)] = []
    for part in query.split(separator: "&", omittingEmptySubsequences: true) {
        let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let key = formDecode(String(kv[0]))
        let value = kv.count > 1 ? formDecode(String(kv[1])) : ""
        out.append((key, value))
    }
    return out
}

private func formDecode(_ s: String) -> String {
    let spaced = s.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
}

/// JSON the way `JSON.stringify` would write these bodies: no `\/` escapes.
func jsonBody<T: Encodable>(_ value: T) throws -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try enc.encode(value)
}

/// Build a multipart/form-data body by hand (as `@plumbox/client`'s
/// `buildMultipart`). Returns the raw body plus the boundary-bearing content
/// type.
func buildMultipart(
    fields: [(String, String)],
    fileField: String,
    fileName: String,
    data: Data,
    contentType: String?
) -> (body: Data, contentType: String) {
    let boundary = "----plumbox" + randomBoundaryToken()
    var body = Data()
    for (k, v) in fields {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8))
    }
    // RFC 2388 filename: keep it UTF-8; the Go server reads it verbatim.
    let escapedName = fileName.replacingOccurrences(of: "\"", with: "%22")
    body.append(Data(
        ("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(escapedName)\"\r\n" +
            "Content-Type: \(contentType ?? "application/octet-stream")\r\n\r\n").utf8
    ))
    body.append(data)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return (body, "multipart/form-data; boundary=\(boundary)")
}

private func randomBoundaryToken() -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    return String((0..<24).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
}

/// `new Date().toISOString()`.
func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
}
