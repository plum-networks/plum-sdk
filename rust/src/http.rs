//! The HTTP client and small wire helpers.

use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;

use crate::{Error, Result};

/// A [`reqwest::ClientBuilder`] with the TLS the SDK uses by default: rustls
/// with the `ring` provider and Mozilla's root certificates
/// ([webpki-roots](https://docs.rs/webpki-roots)), so it needs no
/// process-wide crypto provider and no platform verifier. Add your own
/// timeouts or proxy and pass the built client to
/// [`PlumClientBuilder::http_client`](crate::PlumClientBuilder::http_client).
///
/// Only with the `webpki-roots` feature (on by default).
#[cfg(feature = "webpki-roots")]
pub fn http_client_builder() -> Result<reqwest::ClientBuilder> {
    use std::sync::Arc;
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| Error::InvalidInput(format!("TLS setup: {e}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(std::time::Duration::from_secs(20)))
}

/// The client every call uses when the app passes none. Built once.
///
/// With the `webpki-roots` feature: `http_client_builder()`. Without it:
/// `reqwest::Client::builder()` as it is, which (with rustls and no provider
/// chosen) needs the app to have installed a process-wide rustls
/// `CryptoProvider` — or, better, pass your own client everywhere.
pub fn default_http_client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    #[cfg(feature = "webpki-roots")]
    let built = http_client_builder()?.build()?;
    #[cfg(not(feature = "webpki-roots"))]
    let built = reqwest::Client::builder().build()?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// `http` if given, else [`default_http_client`].
pub(crate) fn client_or_default(http: Option<&reqwest::Client>) -> Result<reqwest::Client> {
    match http {
        Some(c) => Ok(c.clone()),
        None => default_http_client(),
    }
}

/// A request body for [`PlumClient::request`](crate::PlumClient::request).
/// Held in memory, so a request the client has to send again after
/// refreshing the access token goes out byte for byte the same.
#[derive(Debug, Clone)]
pub struct RequestBody {
    /// The `Content-Type` header.
    pub content_type: String,
    /// The bytes.
    pub data: Bytes,
}

impl RequestBody {
    /// A JSON body (`application/json`).
    pub fn json<T: serde::Serialize + ?Sized>(value: &T) -> Result<Self> {
        let data = serde_json::to_vec(value)
            .map_err(|e| Error::InvalidInput(format!("request body: {e}")))?;
        Ok(Self {
            content_type: "application/json".into(),
            data: data.into(),
        })
    }

    /// Raw bytes with their content type.
    pub fn bytes(content_type: impl Into<String>, data: impl Into<Bytes>) -> Self {
        Self {
            content_type: content_type.into(),
            data: data.into(),
        }
    }
}

/// `k=v&…` as `application/x-www-form-urlencoded` (what the TS SDK's
/// `URLSearchParams` produces).
pub(crate) fn form_encode<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// Milliseconds since the Unix epoch on this device's clock.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `n` random bytes from the OS, base64url without padding.
pub(crate) fn random_b64url(n: usize) -> Result<String> {
    use base64::Engine;
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b)
        .map_err(|e| Error::InvalidInput(format!("no secure random numbers: {e}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b))
}

/// A `multipart/form-data` body built in memory (so it can be sent twice),
/// like the TS SDK's `buildMultipart`. Returns the body and its content type.
pub(crate) fn build_multipart(
    fields: &[(&str, &str)],
    file_field: &str,
    file_name: &str,
    file_content_type: &str,
    data: &[u8],
) -> Result<(Bytes, String)> {
    let boundary = format!("----plumbox{}", random_b64url(18)?.replace(['-', '_'], "x"));
    let mut body = Vec::with_capacity(data.len() + 512);
    for (k, v) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    // RFC 2388 filename: UTF-8 as it is; the box reads it verbatim.
    let escaped = file_name.replace('"', "%22").replace(['\r', '\n'], "");
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{escaped}\"\r\nContent-Type: {file_content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((
        body.into(),
        format!("multipart/form-data; boundary={boundary}"),
    ))
}

/// The current time as RFC 3339 UTC with milliseconds (`new Date().toISOString()`).
pub(crate) fn rfc3339_now() -> String {
    let ms = now_ms().max(0);
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encoding_matches_url_search_params() {
        assert_eq!(
            form_encode([("path", "/Apps/My App/a+b.md"), ("q", "é")]),
            "path=%2FApps%2FMy+App%2Fa%2Bb.md&q=%C3%A9"
        );
    }

    #[test]
    fn rfc3339_now_has_the_shape() {
        let s = rfc3339_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T', "{s}");
        assert!(s.starts_with("20"), "{s}");
    }

    #[test]
    fn multipart_carries_fields_and_file() {
        let (body, ct) =
            build_multipart(&[("path", "/a")], "file", "n\"x.md", "text/plain", b"hi").unwrap();
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.starts_with(&format!("--{boundary}\r\n")));
        assert!(text.contains("name=\"path\"\r\n\r\n/a\r\n"));
        assert!(text.contains("filename=\"n%22x.md\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }
}
