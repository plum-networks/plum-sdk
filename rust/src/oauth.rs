//! Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for
//! third-party apps (the TS SDK's `oauth.ts`).
//!
//! The user finds their box on plumbox.me (their email and a code Plum mails
//! them) and types the password only on that box's own page — never inside
//! your app. Your app receives a scoped, revocable token, never the password.
//!
//! 1. [`begin_authorization`] builds the authorization URL and a PKCE
//!    verifier. Open the URL in the system browser; the user picks their box,
//!    signs in there and approves; the box redirects back to your
//!    `redirect_uri` with `?code=…&state=…&iss=…`.
//! 2. [`parse_callback`] reads that redirect and checks `iss`;
//!    [`exchange_code`] swaps the code (and the verifier) for the tokens at
//!    that box — and only at that box.
//!
//! The access token expires after an hour; the refresh token that comes with
//! it gets a new one ([`refresh_tokens`], which [`PlumClient`](crate::PlumClient)
//! calls by itself). Older boxes issue a token that never expires and no
//! refresh token.

use std::fmt;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::env::Environment;
use crate::error::{OAuthErrorCode, error_from_response};
use crate::http::{client_or_default, form_encode, now_ms, random_b64url};
use crate::{Error, Result};

/// The scopes a registered app may ask the box owner for. One vocabulary on
/// every surface: the developer console's client registration, the box's
/// consent screen and the token it mints.
///
/// Ask for the least you need. `admin` is never delegated to an app.
pub mod scope {
    /// Read and write ONE folder the box makes for the app
    /// ([`OAuthTokens::app_folder`](crate::OAuthTokens::app_folder), e.g.
    /// `/Apps/My App`) and nothing else —
    /// not the rest of the drive, not the trash. The least a sync or backup
    /// app needs.
    pub const FILES_APP: &str = "files:app";
    /// Read the user's files (the whole Drive).
    pub const FILES_READ: &str = "files:read";
    /// Change the user's files (implies `files:read`).
    pub const FILES_WRITE: &str = "files:write";
    /// Read the signed-in user's profile only.
    pub const USER_PROFILE: &str = "user:profile";
    /// The older spelling of `files:read`; still works.
    pub const READ: &str = "read";
    /// The older spelling of `files:read files:write`; still works.
    pub const WRITE: &str = "write";

    /// `service:call:<app_id>`: call that app's box-side service
    /// (`/apps/<app_id>/svc/*`). May only name your own app.
    pub fn service_call(app_id: &str) -> String {
        format!("service:call:{app_id}")
    }
}

/// What the box's token endpoint hands back, from [`exchange_code`] or
/// [`refresh_tokens`] (and to [`TokenSink`](crate::TokenSink)). Persist all of
/// it, and the box's address (`iss`) with it.
///
/// A box from before access tokens expired answers with `access_token` and
/// `scope` only: such a token never expires and has no refresh token — keep
/// using it as it is.
///
/// Serializes with snake_case field names; deserializing also accepts the TS
/// SDK's camelCase names, so a set stored by `@plumbox/client` loads. `Debug`
/// does not print the two secrets.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthTokens {
    /// The bearer token (`plum_pat_…`).
    #[serde(alias = "accessToken")]
    pub access_token: String,
    /// Always `"bearer"`.
    #[serde(default = "bearer", alias = "tokenType")]
    pub token_type: String,
    /// The scopes granted, space-separated (may be fewer than requested).
    #[serde(default)]
    pub scope: String,
    /// Trade it for a new token set (the client does it for you). It
    /// ROTATES: every refresh returns a new one and the old one stops
    /// working, so always store the newest. It lapses after 90 days unused.
    /// Absent from older boxes: the access token then never expires.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "refreshToken"
    )]
    pub refresh_token: Option<String>,
    /// When the access token expires, in milliseconds since the Unix epoch on
    /// THIS device's clock (computed from the box's `expires_in` on receipt).
    /// Absent: no known expiry.
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "expiresAt")]
    pub expires_at: Option<i64>,
    /// Present when `files:app` was granted: the absolute drive path the
    /// token may read and write under (e.g. `/Apps/My App`). The box creates
    /// the folder before it issues the token. Paths you send stay absolute
    /// drive paths inside it (`/Apps/My App/backups/1.bin`).
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "appFolder")]
    pub app_folder: Option<String>,
}

fn bearer() -> String {
    "bearer".into()
}

impl OAuthTokens {
    /// A bare access token (a personal access token, or one stored without
    /// the rest): never refreshed, no known expiry.
    pub fn bearer(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            token_type: bearer(),
            scope: String::new(),
            refresh_token: None,
            expires_at: None,
            app_folder: None,
        }
    }
}

impl fmt::Debug for OAuthTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthTokens")
            .field("access_token", &redacted(&self.access_token))
            .field("token_type", &self.token_type)
            .field("scope", &self.scope)
            .field(
                "refresh_token",
                &self.refresh_token.as_deref().map(redacted),
            )
            .field("expires_at", &self.expires_at)
            .field("app_folder", &self.app_folder)
            .finish()
    }
}

/// `plum_pat_…` → `plum_pat_[redacted]`: the kind of secret, not the secret.
pub(crate) fn redacted(secret: &str) -> String {
    let kind = ["plum_pat_", "plum_rt_"]
        .into_iter()
        .find(|p| secret.starts_with(p))
        .unwrap_or("");
    if secret.is_empty() {
        String::new()
    } else {
        format!("{kind}[redacted]")
    }
}

/// A sign-in under way: what [`begin_authorization`] returns. Keep `state`
/// and `code_verifier` until the redirect comes back (serialize it if the
/// app may be killed while the user is in the browser); never send them
/// anywhere yourself.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequest {
    /// Open this in the system browser (not an embedded web view).
    pub url: String,
    /// Pass it to [`exchange_code`] as `expected_state`.
    pub state: String,
    /// The PKCE verifier: pass it to [`exchange_code`] as `code_verifier`.
    pub code_verifier: String,
}

impl fmt::Debug for AuthorizationRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthorizationRequest")
            .field("url", &self.url)
            .field("state", &self.state)
            .field("code_verifier", &"[redacted]")
            .finish()
    }
}

/// `base64url(SHA-256(verifier))`: the S256 PKCE challenge (RFC 7636 §4.2),
/// the exact check the box performs.
pub fn code_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_slice())
}

/// Build the authorization URL and the PKCE material (the TS
/// `beginAuthorization`).
///
/// - `client_id`: the id you registered for this app in the Plum developer
///   console (`<app_id>:<label>`, e.g. `com.example.notes:ios`), or declared in
///   your app's manifest `clients[]`. The box refuses an unregistered one
///   with `unauthorized_client` before showing any consent screen.
/// - `redirect_uri`: one of the redirect URIs registered for the client (a
///   custom scheme, or http loopback on any port; https is refused).
/// - `scopes`: a subset of the client's registered scopes (see [`scope`]).
/// - `environment`: whose portal the sign-in starts at.
///
/// The verifier is 32 random bytes base64url-encoded (43 characters), the
/// `state` 16 random bytes (22 characters). Both must survive until the
/// redirect comes back.
pub fn begin_authorization<S: AsRef<str>>(
    client_id: &str,
    redirect_uri: &str,
    scopes: &[S],
    environment: &Environment,
) -> Result<AuthorizationRequest> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err(Error::InvalidInput(
            "begin_authorization: client_id is required (register one in the Plum developer console)"
                .into(),
        ));
    }
    if scopes.is_empty() {
        return Err(Error::InvalidInput(
            "begin_authorization: at least one scope is required".into(),
        ));
    }
    let portal = environment.portal_origin().trim_end_matches('/');
    let code_verifier = random_b64url(32)?;
    let challenge = code_challenge(&code_verifier);
    let state = random_b64url(16)?;
    let scope = scopes
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(" ");
    let query = form_encode([
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("scope", scope.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
    ]);
    Ok(AuthorizationRequest {
        url: format!("{portal}/authorize?{query}"),
        state,
        code_verifier,
    })
}

/// Whether `iss` is a Plum box's canonical origin in `environment`:
/// `https://pb-<name>.plumbox.me` exactly — https, no port, no path, no
/// trailing slash, lower case, and not the box's `-lan`/`-wan` alias. A box
/// of another environment is not one.
///
/// Limit: this says "a Plum box", not "the box the user picked". Swapping in
/// a different Plum box is stopped elsewhere (the signed directory list and
/// the portal sending the user only to the box they chose).
pub fn is_plum_issuer(iss: &str, environment: &Environment) -> bool {
    #[cfg(feature = "testing")]
    if let Environment::Local { origin } = environment {
        return !origin.is_empty() && iss == origin;
    }
    let Some(host) = iss.strip_prefix("https://") else {
        return false;
    };
    let Some(label) = host
        .strip_suffix(environment.box_domain())
        .and_then(|h| h.strip_suffix('.'))
    else {
        return false;
    };
    let Some(name) = label.strip_prefix("pb-") else {
        return false;
    };
    // pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])? — one DNS label of at most 62.
    let b = name.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (1..=59).contains(&b.len())
        && alnum(&b[0])
        && alnum(&b[b.len() - 1])
        && b.iter().all(|c| alnum(c) || *c == b'-')
        && !name.ends_with("-lan")
        && !name.ends_with("-wan")
}

/// What came back to your redirect URI, checked ([`parse_callback`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Callback {
    /// Present only when the callback also carried a valid `iss`.
    pub code: Option<String>,
    /// The callback's `state`: pass it to [`exchange_code`] as `state`.
    pub state: Option<String>,
    /// The box that issued the code, already checked with
    /// [`is_plum_issuer`]: pass it to [`exchange_code`] and keep it as the
    /// box's address. Absent when the callback carried none (an error
    /// callback from an older box) or one that failed the check.
    pub iss: Option<String>,
    /// Set when there is nothing to exchange: the box's own error (e.g.
    /// `"access_denied"`), `"invalid_iss"` when the callback's `iss` is
    /// missing or not a Plum box (the code is then dropped), or
    /// `"invalid_request"` when the callback carried neither a code nor an
    /// error.
    pub error: Option<String>,
}

/// Read the redirect the box sent back to your `redirect_uri`
/// (`myapp://plum/callback?code=…&state=…&iss=…`) and check its `iss`:
///
/// - A code with no `iss`, or with one that is not a Plum box's own address,
///   comes back as `error: "invalid_iss"` and WITHOUT the code — there is
///   nothing left to send anywhere.
/// - An error callback is accepted without `iss` (older boxes send none); if
///   it carries one, the same check applies.
/// - A parameter given twice is refused (`iss` → `invalid_iss`, `code` →
///   `invalid_request`).
///
/// `state` is checked by [`exchange_code`]. A URL that cannot be parsed is
/// [`Error::InvalidInput`].
pub fn parse_callback(callback_url: &str, environment: &Environment) -> Result<Callback> {
    let url = url::Url::parse(callback_url)
        .map_err(|e| Error::InvalidInput(format!("parse_callback: not a URL: {e}")))?;
    Ok(callback_from_params(url.query_pairs(), environment))
}

/// [`parse_callback`] for a callback that arrives as parameters rather than
/// a URL (a deep-link handler that hands over its query items). Same checks,
/// same result. A key may appear more than once.
pub fn callback_from_params<I, K, V>(params: I, environment: &Environment) -> Callback
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let pairs: Vec<(String, String)> = params
        .into_iter()
        .map(|(k, v)| (k.as_ref().to_owned(), v.as_ref().to_owned()))
        .collect();
    // One value: Ok(Some(non-empty)) / Ok(None) for absent or empty;
    // Err(()) when the key appears twice — not a callback this flow produced.
    let one = |key: &str| -> std::result::Result<Option<String>, ()> {
        let mut values = pairs.iter().filter(|(k, _)| k == key).map(|(_, v)| v);
        match (values.next(), values.next()) {
            (Some(_), Some(_)) => Err(()),
            (Some(v), None) if !v.is_empty() => Ok(Some(v.clone())),
            _ => Ok(None),
        }
    };
    let code = one("code");
    let state = one("state");
    let iss = one("iss");
    let error = one("error");

    let mut out = Callback {
        state: state.ok().flatten(),
        ..Callback::default()
    };
    let iss = match iss {
        Err(()) => {
            out.error = Some("invalid_iss".into());
            return out;
        }
        Ok(Some(i)) if !is_plum_issuer(&i, environment) => {
            out.error = Some("invalid_iss".into());
            return out;
        }
        Ok(i) => i,
    };
    match (error, code) {
        // The box's own refusal (access_denied, …). No code goes with it,
        // even if one were present.
        (Ok(Some(e)), _) => {
            out.error = Some(e);
            out.iss = iss;
        }
        (Err(()), _) | (Ok(None), Err(())) => {
            out.error = Some("invalid_request".into());
            out.iss = iss;
        }
        (Ok(None), Ok(None)) => out.error = Some("invalid_request".into()),
        (Ok(None), Ok(Some(c))) => match iss {
            // A code and no box to name it: stop here.
            None => out.error = Some("invalid_iss".into()),
            Some(i) => {
                out.code = Some(c);
                out.iss = Some(i);
            }
        },
    }
    out
}

/// What [`exchange_code`] needs (the TS `ExchangeCodeOptions`). Fill it from
/// the [`Callback`] and the stored [`AuthorizationRequest`]:
///
/// ```no_run
/// # async fn f(cb: plumbox_client::Callback, saved: plumbox_client::AuthorizationRequest)
/// # -> plumbox_client::Result<()> {
/// use plumbox_client::{exchange_code, ExchangeCode};
/// let tokens = exchange_code(ExchangeCode {
///     iss: cb.iss.as_deref().unwrap_or_default(),
///     code: cb.code.as_deref().unwrap_or_default(),
///     state: cb.state.as_deref(),
///     expected_state: &saved.state,
///     code_verifier: &saved.code_verifier,
///     client_id: "com.example.app:ios",
///     redirect_uri: "exampleapp://plum/callback",
///     ..Default::default()
/// })
/// .await?;
/// # Ok(()) }
/// ```
#[derive(Debug, Clone, Default)]
pub struct ExchangeCode<'a> {
    /// The box to exchange the code at: the callback's `iss` (the TS
    /// `baseUrl`). It must be a Plum box's canonical origin
    /// ([`is_plum_issuer`]); anything else stops with
    /// [`OAuthErrorCode::InvalidIss`] before the code or the verifier is sent
    /// anywhere. The code goes to `<iss>/api/oauth/token` and nowhere else.
    pub iss: &'a str,
    /// The callback's `code`.
    pub code: &'a str,
    /// The callback's `state`.
    pub state: Option<&'a str>,
    /// The `state` that [`begin_authorization`] returned for this sign-in. A
    /// callback whose `state` is different (or missing) stops with
    /// [`OAuthErrorCode::InvalidState`] before anything is sent.
    pub expected_state: &'a str,
    /// The `code_verifier` that [`begin_authorization`] returned.
    pub code_verifier: &'a str,
    /// The client id the sign-in began with.
    pub client_id: &'a str,
    /// The redirect URI the sign-in began with.
    pub redirect_uri: &'a str,
    /// The environment the callback was checked against (default production).
    pub environment: Environment,
    /// The HTTP client (default: [`default_http_client`](crate::default_http_client)).
    pub http: Option<&'a reqwest::Client>,
}

fn oauth_error(code: OAuthErrorCode, message: impl Into<String>) -> Error {
    Error::OAuth {
        code,
        message: message.into(),
    }
}

/// Exchange the authorization code for a scoped access token at the box
/// that issued it (the TS `exchangeCode`).
///
/// Before anything is sent, `iss` must be a Plum box's own address
/// ([`OAuthErrorCode::InvalidIss`] otherwise) and the callback's `state`
/// must equal `expected_state` ([`OAuthErrorCode::InvalidState`] otherwise),
/// both as [`Error::OAuth`]. Then it POSTs the `authorization_code` grant as
/// JSON to `<iss>/api/oauth/token`.
///
/// A current box returns an access token that expires in an hour plus a
/// refresh token (and `app_folder` when `files:app` was granted); hand all of
/// them to [`PlumClient`](crate::PlumClient) and it keeps the access token
/// fresh. An older box returns `access_token` + `scope` only — a token that
/// never expires.
///
/// Errors from the box are [`Error::Api`] carrying its OAuth code:
/// `invalid_grant` (code used, expired or PKCE mismatch),
/// `unauthorized_client`, `invalid_scope`, `invalid_redirect_uri`.
pub async fn exchange_code(params: ExchangeCode<'_>) -> Result<OAuthTokens> {
    let iss = params.iss;
    if !is_plum_issuer(iss, &params.environment) {
        return Err(oauth_error(
            OAuthErrorCode::InvalidIss,
            format!(
                "exchange_code: the callback's iss is not a Plum box (https://pb-….{}); nothing was sent",
                params.environment.box_domain()
            ),
        ));
    }
    if params.expected_state.is_empty() || params.state != Some(params.expected_state) {
        return Err(oauth_error(
            OAuthErrorCode::InvalidState,
            "exchange_code: the callback's state is not the one this sign-in began with; nothing was sent",
        ));
    }
    if params.code.is_empty() || params.code_verifier.is_empty() {
        return Err(oauth_error(
            OAuthErrorCode::InvalidRequest,
            "exchange_code: code and code_verifier are required",
        ));
    }
    let http = client_or_default(params.http)?;
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "code": params.code,
        "code_verifier": params.code_verifier,
        "client_id": params.client_id,
        "redirect_uri": params.redirect_uri,
    });
    let res = http
        .post(format!("{iss}/api/oauth/token"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = res.status().as_u16();
    let text = res.text().await?;
    if status != 200 {
        return Err(error_from_response(status, &text));
    }
    tokens_from_response(status, &text, now_ms())
}

/// Trade a refresh token for a new token set at `<iss>/api/oauth/token`
/// (`grant_type: "refresh_token"`, as JSON — like the TS SDK; the box also
/// takes the form-encoded body generic OAuth libraries send). [`PlumClient`](crate::PlumClient)
/// calls this for you; call it yourself only if you manage tokens by hand.
///
/// - `iss`: the box the tokens came from (the `iss` the sign-in was checked
///   against). The same check applies — a value that is not a Plum box's
///   canonical origin stops with [`OAuthErrorCode::InvalidIss`] before the
///   refresh token is sent anywhere.
/// - `client_id`: the client id the tokens were issued to.
/// - `refresh_token`: the newest refresh token you hold.
///
/// Refresh tokens ROTATE: the result carries a new `refresh_token` and the
/// one you sent stops working (the box forgives a repeat within 60 s, for a
/// reply that got lost). Store the new one before anything else; reusing an
/// old one after that ends the whole connection. A box that answers without
/// a new refresh token leaves the one you sent valid, and the result carries
/// it.
///
/// [`Error::Auth`] with status 400 and code `"invalid_grant"` when the box
/// refuses the refresh token (rotated away, revoked, 90 days unused, or the
/// user disconnected the app): the connection is gone and the user has to
/// connect again. Any other failure ([`Error::Network`], or [`Error::Api`]
/// for 5xx and the like) leaves the refresh token good; try again later.
pub async fn refresh_tokens(
    iss: &str,
    client_id: &str,
    refresh_token: &str,
    environment: &Environment,
    http: Option<&reqwest::Client>,
) -> Result<OAuthTokens> {
    if !is_plum_issuer(iss, environment) {
        return Err(oauth_error(
            OAuthErrorCode::InvalidIss,
            format!(
                "refresh_tokens: iss is not a Plum box (https://pb-….{}); nothing was sent",
                environment.box_domain()
            ),
        ));
    }
    if refresh_token.is_empty() || client_id.is_empty() {
        return Err(oauth_error(
            OAuthErrorCode::InvalidRequest,
            "refresh_tokens: refresh_token and client_id are required",
        ));
    }
    let http = client_or_default(http)?;
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    });
    let res = http
        .post(format!("{iss}/api/oauth/token"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = res.status().as_u16();
    let text = res.text().await?;
    if status != 200 {
        return Err(match error_from_response(status, &text) {
            Error::Api {
                status,
                code: Some(code),
                message,
            } if code == "invalid_grant" => Error::Auth {
                status,
                code: Some(code),
                message,
            },
            other => other,
        });
    }
    let mut tokens = tokens_from_response(status, &text, now_ms())?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_owned());
    }
    Ok(tokens)
}

/// Read a 200 from the token endpoint (RFC 6749 §5.1, plus Plum's `app_folder`).
pub(crate) fn tokens_from_response(status: u16, body: &str, now: i64) -> Result<OAuthTokens> {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty());
    let Some(access_token) = text("access_token") else {
        return Err(Error::Api {
            status,
            code: Some("invalid_token_response".into()),
            message: "the token response carried no access_token".into(),
        });
    };
    let expires_at = v
        .get("expires_in")
        .and_then(|x| x.as_f64())
        .filter(|s| s.is_finite() && *s > 0.0)
        .map(|s| now + (s * 1000.0) as i64);
    Ok(OAuthTokens {
        access_token: access_token.to_owned(),
        token_type: text("token_type").unwrap_or("bearer").to_owned(),
        scope: v
            .get("scope")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_owned(),
        refresh_token: text("refresh_token").map(str::to_owned),
        expires_at,
        app_folder: text("app_folder")
            .filter(|f| f.starts_with('/'))
            .map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fixed vector computed outside this crate:
    // base64.urlsafe_b64encode(hashlib.sha256(verifier).digest()) in Python.
    #[test]
    fn s256_challenge_matches_an_independent_vector() {
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mJ92K9qkd_WSDOH4DkYOXtM89GzwEo"),
            "UsxSR29VeePtquNsk58xFp2Z0oi3tjGjZ6OieWwl84Y"
        );
    }

    #[test]
    fn tokens_from_a_new_and_an_old_box() {
        let t = tokens_from_response(
            200,
            r#"{"access_token":"plum_pat_a","token_type":"bearer","expires_in":3600,"refresh_token":"plum_rt_1","scope":"files:app","app_folder":"/Apps/X"}"#,
            1_000,
        )
        .unwrap();
        assert_eq!(t.expires_at, Some(1_000 + 3_600_000));
        assert_eq!(t.refresh_token.as_deref(), Some("plum_rt_1"));
        assert_eq!(t.app_folder.as_deref(), Some("/Apps/X"));
        let old = tokens_from_response(
            200,
            r#"{"access_token":"plum_pat_old","scope":"files:read"}"#,
            1,
        )
        .unwrap();
        assert_eq!(
            old,
            OAuthTokens {
                scope: "files:read".into(),
                ..OAuthTokens::bearer("plum_pat_old")
            }
        );
        let e = tokens_from_response(200, r#"{"token_type":"bearer"}"#, 1).unwrap_err();
        assert_eq!(e.code(), Some("invalid_token_response"));
        let odd = tokens_from_response(
            200,
            r#"{"access_token":"x","expires_in":-5,"app_folder":"Apps"}"#,
            1,
        )
        .unwrap();
        assert_eq!((odd.expires_at, odd.app_folder), (None, None));
    }

    #[test]
    fn tokens_serialize_snake_case_and_read_the_ts_shape() {
        let t = OAuthTokens {
            refresh_token: Some("plum_rt_1".into()),
            expires_at: Some(42),
            app_folder: Some("/Apps/X".into()),
            scope: "files:app".into(),
            ..OAuthTokens::bearer("plum_pat_1")
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["access_token"], "plum_pat_1");
        assert_eq!(json["refresh_token"], "plum_rt_1");
        let back: OAuthTokens = serde_json::from_value(json).unwrap();
        assert_eq!(back, t);
        let from_ts: OAuthTokens = serde_json::from_str(
            r#"{"accessToken":"plum_pat_1","tokenType":"bearer","scope":"files:app","refreshToken":"plum_rt_1","expiresAt":42,"appFolder":"/Apps/X"}"#,
        )
        .unwrap();
        assert_eq!(from_ts, t);
        let dbg = format!("{t:?}");
        assert!(
            !dbg.contains("plum_pat_1") && !dbg.contains("plum_rt_1"),
            "{dbg}"
        );
    }

    /// A product build must never take a loopback box as an issuer — not
    /// even behind a switch. `Environment::Local`, the only environment that
    /// does, exists only with the `testing` feature (see Cargo.toml); run
    /// `cargo test` without features too, so this holds for what ships.
    #[test]
    fn no_real_environment_takes_a_loopback_box() {
        for env in [Environment::Production, Environment::Staging] {
            for iss in [
                "http://127.0.0.1:8080",
                "http://localhost:8080",
                "http://[::1]:8080",
                "https://127.0.0.1",
                "https://localhost",
            ] {
                assert!(!is_plum_issuer(iss, &env), "{iss} in {env:?}");
            }
        }
        assert!(Environment::from_box_domain("127.0.0.1").is_err());
        assert!(Environment::from_box_domain("localhost").is_err());
    }

    #[test]
    fn redaction_keeps_the_kind() {
        assert_eq!(redacted("plum_pat_abc"), "plum_pat_[redacted]");
        assert_eq!(redacted("plum_rt_abc"), "plum_rt_[redacted]");
        assert_eq!(redacted("x"), "[redacted]");
        assert_eq!(redacted(""), "");
    }
}
