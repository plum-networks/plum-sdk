//! [`PlumClient`]: a box, its tokens, and keeping them fresh (the TS SDK's
//! `client.ts`).

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use reqwest::header::{CONTENT_TYPE, HeaderName};
use reqwest::{Method, StatusCode};

use crate::drive::Drive;
use crate::env::{Environment, is_foreign_url};
use crate::error::error_from_response;
use crate::http::{RequestBody, default_http_client, now_ms};
use crate::oauth::{OAuthTokens, is_plum_issuer, redacted, refresh_tokens};
use crate::{Error, Result};

/// Refresh this long before the access token runs out.
const REFRESH_MARGIN_MS: i64 = 60_000;

/// Receives every rotated token set (the TS `onTokens`).
///
/// [`PlumClient`] calls it after every refresh, before the request that
/// needed the refresh is sent again — and before any other request uses the
/// new access token. PERSIST THE SET HERE: the refresh token you stored
/// before no longer works (after a 60-second grace, using it ends the whole
/// connection). Keep it quick and do not call back into the client from it
/// (requests wait for it to return).
///
/// Any `Fn(&OAuthTokens) + Send + Sync + 'static` closure is one.
pub trait TokenSink: Send + Sync + 'static {
    /// Called with the new set after a refresh.
    fn tokens_rotated(&self, tokens: &OAuthTokens);
}

impl<F> TokenSink for F
where
    F: Fn(&OAuthTokens) + Send + Sync + 'static,
{
    fn tokens_rotated(&self, tokens: &OAuthTokens) {
        self(tokens)
    }
}

type AuthErrorFn = Arc<dyn Fn(&Error) + Send + Sync>;

/// Builds a [`PlumClient`]; start with [`PlumClient::builder`].
#[must_use]
pub struct PlumClientBuilder {
    base_url: String,
    tokens: Option<OAuthTokens>,
    client_id: Option<String>,
    iss: Option<String>,
    environment: Environment,
    portal_origin: Option<String>,
    http: Option<reqwest::Client>,
    token_sink: Option<Arc<dyn TokenSink>>,
    on_auth_error: Option<AuthErrorFn>,
}

impl PlumClientBuilder {
    /// The whole token set from [`exchange_code`](crate::exchange_code) (or
    /// the one you stored). With a `refresh_token` the client keeps the
    /// access token fresh by itself: it refreshes shortly before
    /// `expires_at`, and once when a request comes back 401 (then sends that
    /// request again). That needs [`client_id`](Self::client_id) and the
    /// box's verified `iss`. A set with a refresh token and an empty access
    /// token refreshes before the first request.
    pub fn tokens(mut self, tokens: OAuthTokens) -> Self {
        self.tokens = Some(tokens);
        self
    }

    /// A bare access token (`plum_pat_…`, e.g. a personal access token):
    /// sent as it is, never refreshed. Same as
    /// `.tokens(OAuthTokens::bearer(token))`.
    pub fn token(self, access_token: impl Into<String>) -> Self {
        self.tokens(OAuthTokens::bearer(access_token))
    }

    /// The client id the tokens were issued to. Required with a refresh token.
    pub fn client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    /// The `iss` the sign-in was checked against — the box's canonical
    /// address (`https://pb-….plumbox.me`). Default: the base URL. Refreshes
    /// go to `<iss>/api/oauth/token` and nowhere else, so with a refresh token
    /// this must pass [`is_plum_issuer`] (set it explicitly when the base URL
    /// is a LAN address).
    pub fn iss(mut self, iss: impl Into<String>) -> Self {
        self.iss = Some(iss.into());
        self
    }

    /// The Plum environment (default production). A base URL of another
    /// environment's box is refused; a LAN address or localhost belongs to no
    /// environment and is accepted.
    pub fn environment(mut self, environment: Environment) -> Self {
        self.environment = environment;
        self
    }

    /// The environment's portal (default: its own, `https://plumbox.me` in
    /// production). Another environment's portal is refused.
    pub fn portal_origin(mut self, portal_origin: impl Into<String>) -> Self {
        self.portal_origin = Some(portal_origin.into());
        self
    }

    /// The HTTP client to use (default: [`default_http_client`]). Bring your
    /// own to choose TLS roots, timeouts or a proxy; the
    /// `http_client_builder` (feature `webpki-roots`) is a good start.
    pub fn http_client(mut self, http: reqwest::Client) -> Self {
        self.http = Some(http);
        self
    }

    /// Where every rotated token set goes (the TS `onTokens`); see [`TokenSink`].
    pub fn on_tokens(mut self, sink: impl TokenSink) -> Self {
        self.token_sink = Some(Arc::new(sink));
        self
    }

    /// The credential is no good and the user has to connect again: a 401
    /// the client could not cure by refreshing, or a refresh the box refused
    /// (`invalid_grant`). Hook your reconnect UI here. Fires once per
    /// credential, however many requests were in flight. A 403
    /// ([`Error::Forbidden`]: not allowed, credential fine) does NOT fire it.
    pub fn on_auth_error(mut self, callback: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.on_auth_error = Some(Arc::new(callback));
        self
    }

    /// Check the settings and make the client. [`Error::InvalidInput`] when
    /// the base URL or portal belongs to another environment, or when a
    /// refresh token comes without a `client_id` or without a verified `iss`.
    pub fn build(self) -> Result<PlumClient> {
        let env = self.environment;
        let base_url = self.base_url.trim_end_matches('/').to_owned();
        if is_foreign_url(&base_url, &env) {
            return Err(Error::InvalidInput(format!(
                "PlumClient: {base_url} is not a box of {}",
                env.box_domain()
            )));
        }
        let portal_origin = self
            .portal_origin
            .as_deref()
            .unwrap_or(env.portal_origin())
            .trim_end_matches('/')
            .to_owned();
        if is_foreign_url(&portal_origin, &env) {
            return Err(Error::InvalidInput(format!(
                "PlumClient: {portal_origin} is not the portal of {}",
                env.box_domain()
            )));
        }
        let http = match self.http {
            Some(h) => h,
            None => default_http_client()?,
        };
        let client = PlumClient {
            inner: Arc::new(Inner {
                http,
                iss: self.iss.unwrap_or_else(|| base_url.clone()),
                base_url,
                client_id: self
                    .client_id
                    .map(|c| c.trim().to_owned())
                    .filter(|c| !c.is_empty()),
                environment: env,
                portal_origin,
                state: Mutex::new(TokenState::default()),
                refresh_lock: tokio::sync::Mutex::new(()),
                token_sink: self.token_sink,
                on_auth_error: self.on_auth_error,
            }),
        };
        if let Some(tokens) = self.tokens {
            client.adopt(tokens)?;
        }
        Ok(client)
    }
}

/// A connection to one box: its address, the app's tokens, and the
/// [`Drive`]. Cheap to clone (all clones share the tokens and the one
/// refresh in flight); `Send + Sync`.
///
/// ```no_run
/// # async fn f(iss: String, tokens: plumbox_client::OAuthTokens) -> plumbox_client::Result<()> {
/// use plumbox_client::PlumClient;
/// let client = PlumClient::builder(&iss)
///     .client_id("com.example.app:ios")
///     .tokens(tokens)
///     .on_tokens(|next: &plumbox_client::OAuthTokens| { /* persist `next` */ })
///     .on_auth_error(|_err| { /* show "connect again" */ })
///     .build()?;
/// let folder = client.app_folder().unwrap_or_default();
/// for entry in client.drive().list_all(&folder, &Default::default()).await? {
///     println!("{} {}", entry.path, entry.size);
/// }
/// # Ok(()) }
/// ```
#[derive(Clone)]
pub struct PlumClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    base_url: String,
    iss: String,
    client_id: Option<String>,
    environment: Environment,
    portal_origin: String,
    state: Mutex<TokenState>,
    /// Held for the whole of a refresh: one refresh in flight at a time.
    refresh_lock: tokio::sync::Mutex<()>,
    token_sink: Option<Arc<dyn TokenSink>>,
    on_auth_error: Option<AuthErrorFn>,
}

#[derive(Default)]
struct TokenState {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
    scope: String,
    app_folder: Option<String>,
    /// Bumped whenever the tokens are replaced from outside, so a late
    /// refresh result is dropped.
    generation: u64,
    /// Counts finished refreshes. A caller notes it before waiting for the
    /// refresh lock; if it moved meanwhile, a refresh ran while it waited
    /// and it takes that one's outcome instead of starting another.
    refresh_epoch: u64,
    /// The outcome of the last finished refresh.
    last_refresh: Option<Result<()>>,
    /// A refresh is running: new requests wait for it.
    refreshing: bool,
    /// The access token `on_auth_error` last fired for (once per credential).
    auth_error_fired_for: Option<String>,
}

impl TokenState {
    fn refresh_due(&self, now: i64) -> bool {
        self.refresh_token.is_some()
            && self
                .expires_at
                .is_some_and(|t| now >= t - REFRESH_MARGIN_MS)
    }

    fn current(&self) -> Option<OAuthTokens> {
        if self.access_token.is_none() && self.refresh_token.is_none() {
            return None;
        }
        Some(OAuthTokens {
            access_token: self.access_token.clone().unwrap_or_default(),
            token_type: "bearer".into(),
            scope: self.scope.clone(),
            refresh_token: self.refresh_token.clone(),
            expires_at: self.expires_at,
            app_folder: self.app_folder.clone(),
        })
    }
}

/// One request as the client sends it (again, after a refresh).
pub(crate) struct Call {
    pub method: Method,
    /// Path and query, starting with `/`.
    pub path: String,
    pub headers: Vec<(HeaderName, String)>,
    pub body: Option<RequestBody>,
    /// The statuses that count as success; empty: any 2xx.
    pub allow: &'static [u16],
}

impl Call {
    pub fn new(method: Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            headers: Vec::new(),
            body: None,
            allow: &[],
        }
    }

    pub fn body(mut self, body: RequestBody) -> Self {
        self.body = Some(body);
        self
    }

    pub fn header(mut self, name: HeaderName, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    pub fn allow(mut self, statuses: &'static [u16]) -> Self {
        self.allow = statuses;
        self
    }
}

/// Resets `refreshing` if a refresh is dropped half-way (its caller was
/// cancelled), so later requests do not wait for a refresh that is gone.
struct RefreshingFlag<'a>(&'a PlumClient);

impl Drop for RefreshingFlag<'_> {
    fn drop(&mut self) {
        self.0.state().refreshing = false;
    }
}

impl PlumClient {
    /// Start building a client for the box at `base_url`: the callback's
    /// `iss` (`https://pb-….plumbox.me`), or the box's address you stored.
    pub fn builder(base_url: impl Into<String>) -> PlumClientBuilder {
        PlumClientBuilder {
            base_url: base_url.into(),
            tokens: None,
            client_id: None,
            iss: None,
            environment: Environment::Production,
            portal_origin: None,
            http: None,
            token_sink: None,
            on_auth_error: None,
        }
    }

    /// The box's address, without a trailing slash.
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// The `iss` refreshes go to.
    pub fn iss(&self) -> &str {
        &self.inner.iss
    }

    /// The client id the tokens were issued to, if set.
    pub fn client_id(&self) -> Option<&str> {
        self.inner.client_id.as_deref()
    }

    /// The environment.
    pub fn environment(&self) -> &Environment {
        &self.inner.environment
    }

    /// The environment's box domain (`plumbox.me` in production).
    pub fn box_domain(&self) -> &str {
        self.inner.environment.box_domain()
    }

    /// The environment's portal.
    pub fn portal_origin(&self) -> &str {
        &self.inner.portal_origin
    }

    /// The box's Drive.
    pub fn drive(&self) -> Drive {
        Drive::new(self.clone())
    }

    /// The folder a `files:app` token may use ([`OAuthTokens::app_folder`]),
    /// when known.
    pub fn app_folder(&self) -> Option<String> {
        self.state().app_folder.clone()
    }

    /// Whether the client holds an access token.
    pub fn has_token(&self) -> bool {
        self.state().access_token.is_some()
    }

    /// The token set the client holds now (with the newest refresh token),
    /// or `None` when it holds none.
    pub fn tokens(&self) -> Option<OAuthTokens> {
        self.state().current()
    }

    /// Adopt a token set for every request from now on (a new sign-in, or a
    /// set loaded from storage). Pass the whole set so the client can
    /// refresh it. A refresh already under way for the previous set is
    /// dropped when it finishes (unless this is the very set it rotated
    /// away). Same checks as [`PlumClientBuilder::build`].
    pub fn set_tokens(&self, tokens: OAuthTokens) -> Result<()> {
        self.adopt(tokens)
    }

    /// Forget the tokens (the app disconnected).
    pub fn clear_tokens(&self) {
        let mut st = self.state();
        st.generation += 1;
        st.access_token = None;
        st.refresh_token = None;
        st.expires_at = None;
        st.app_folder = None;
        st.scope.clear();
    }

    /// Refresh the access token now. Concurrent callers (and requests that
    /// hit a 401 meanwhile) share one refresh. [`Error::Auth`] with code
    /// `invalid_grant` when the connection is gone (and `on_auth_error`
    /// fires); [`Error::Network`] or [`Error::Api`] when the box could not
    /// be reached (the refresh token is still good);
    /// [`Error::InvalidInput`] when the client holds no refresh token.
    pub async fn refresh(&self) -> Result<()> {
        let ticket = {
            let st = self.state();
            if st.refresh_token.is_none() {
                return Err(Error::InvalidInput(
                    "PlumClient::refresh: this client holds no refresh token".into(),
                ));
            }
            st.refresh_epoch
        };
        self.refresh_shared(ticket).await
    }

    /// Send a request to the box with the client's token, its refresh and
    /// its error mapping — for routes the SDK has no method for (a box-side
    /// service at `/apps/<app_id>/svc/…`, `/api/auth/me`, …). `path` starts
    /// with `/` and carries its query string. A non-2xx answer is an
    /// [`Error`]; a 2xx is returned for you to read.
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<RequestBody>,
    ) -> Result<reqwest::Response> {
        let mut call = Call::new(method, path);
        call.body = body;
        self.execute(&call).await
    }

    fn state(&self) -> MutexGuard<'_, TokenState> {
        // The state holds plain values; a panic elsewhere cannot leave it
        // half-written, so a poisoned lock is still good to read.
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn adopt(&self, t: OAuthTokens) -> Result<()> {
        let refresh = t.refresh_token.filter(|r| !r.is_empty());
        if refresh.is_some() {
            if self.inner.client_id.is_none() {
                return Err(Error::InvalidInput(
                    "PlumClient: a refresh token needs client_id (the client id the tokens were issued to)"
                        .into(),
                ));
            }
            if !is_plum_issuer(&self.inner.iss, &self.inner.environment) {
                return Err(Error::InvalidInput(format!(
                    "PlumClient: refreshing needs the box's verified iss (https://pb-….{}); pass it with .iss()",
                    self.inner.environment.box_domain()
                )));
            }
        }
        let mut st = self.state();
        st.generation += 1;
        let has_access = !t.access_token.is_empty();
        st.expires_at = match (has_access, &refresh) {
            (true, _) => t.expires_at,
            // A refresh token without an access token: refresh before the first request.
            (false, Some(_)) => Some(0),
            (false, None) => None,
        };
        st.access_token = has_access.then_some(t.access_token);
        st.refresh_token = refresh;
        st.scope = t.scope;
        st.app_folder = t.app_folder.filter(|f| !f.is_empty());
        Ok(())
    }

    /// Run the one refresh in flight, or wait for it and take its outcome.
    /// `ticket` is the `refresh_epoch` the caller saw when it decided a
    /// refresh was needed.
    async fn refresh_shared(&self, ticket: u64) -> Result<()> {
        let _one_at_a_time = self.inner.refresh_lock.lock().await;
        {
            let mut st = self.state();
            if st.refresh_epoch != ticket {
                return st.last_refresh.clone().unwrap_or(Ok(()));
            }
            st.refreshing = true;
        }
        let flag = RefreshingFlag(self);
        let result = self.do_refresh().await;
        {
            let mut st = self.state();
            st.refresh_epoch += 1;
            st.last_refresh = Some(result.clone());
        }
        drop(flag);
        result
    }

    async fn do_refresh(&self) -> Result<()> {
        let (sent, generation) = {
            let st = self.state();
            (st.refresh_token.clone(), st.generation)
        };
        let (Some(sent), Some(client_id)) = (sent, self.inner.client_id.as_deref()) else {
            return Err(Error::InvalidInput("PlumClient: no refresh token".into()));
        };
        let next = match refresh_tokens(
            &self.inner.iss,
            client_id,
            &sent,
            &self.inner.environment,
            Some(&self.inner.http),
        )
        .await
        {
            Ok(next) => next,
            Err(err) => {
                if err.is_invalid_grant() {
                    // The connection is gone: stop sending a refresh token the box refuses.
                    let fire_for = {
                        let mut st = self.state();
                        (st.generation == generation).then(|| {
                            st.refresh_token = None;
                            st.access_token.clone()
                        })
                    };
                    if let Some(token) = fire_for {
                        self.fire_auth_error(&err, token);
                    }
                }
                return Err(err);
            }
        };
        // The tokens were replaced (set_tokens/clear_tokens) while this was in
        // flight: keep those — unless they are the very set this refresh
        // rotated away (re-loaded from storage), which no longer works.
        let replaced = |st: &TokenState| {
            st.generation != generation && st.refresh_token.as_deref() != Some(sent.as_str())
        };
        let merged = {
            let st = self.state();
            if replaced(&st) {
                return Ok(());
            }
            OAuthTokens {
                scope: if next.scope.is_empty() {
                    st.scope.clone()
                } else {
                    next.scope.clone()
                },
                app_folder: next.app_folder.clone().or_else(|| st.app_folder.clone()),
                ..next
            }
        };
        // Persist first: no request goes out with the new access token
        // before the app has the new refresh token (requests that need the
        // new token are waiting for this refresh to finish).
        if let Some(sink) = &self.inner.token_sink {
            sink.tokens_rotated(&merged);
        }
        let mut st = self.state();
        if replaced(&st) {
            return Ok(());
        }
        st.access_token = Some(merged.access_token);
        st.refresh_token = merged.refresh_token;
        st.expires_at = merged.expires_at;
        st.scope = merged.scope;
        st.app_folder = merged.app_folder;
        Ok(())
    }

    fn fire_auth_error(&self, err: &Error, sent_with: Option<String>) {
        {
            let mut st = self.state();
            if sent_with.is_some() && st.auth_error_fired_for == sent_with {
                return;
            }
            st.auth_error_fired_for = sent_with;
        }
        if let Some(cb) = &self.inner.on_auth_error {
            cb(err);
        }
    }

    /// Perform an API request with auth, refresh and error mapping.
    ///
    /// With a refresh token, an access token about to expire is refreshed
    /// first, and a 401 is answered by one refresh (shared with every request
    /// waiting on it) and one more try of the same request. A 401 is the box
    /// refusing the credential before it reads the request, so the second try
    /// is not a duplicate write; every body is in memory and goes out again
    /// byte for byte.
    pub(crate) async fn execute(&self, call: &Call) -> Result<reqwest::Response> {
        // Due, or already under way (another request's 401): wait for the new token.
        let (due, ticket) = {
            let st = self.state();
            (st.refreshing || st.refresh_due(now_ms()), st.refresh_epoch)
        };
        if due && let Err(err) = self.refresh_shared(ticket).await {
            // Gone for good, or no longer usable at all: stop. A token that
            // is still valid for a few seconds is worth one try.
            let expires_at = self.state().expires_at;
            if err.is_auth() || expires_at.is_none_or(|t| now_ms() >= t) {
                return Err(err);
            }
        }
        let mut sent_with = self.state().access_token.clone();
        let mut res = self.send(call, sent_with.as_deref()).await?;
        if res.status() == StatusCode::UNAUTHORIZED
            && sent_with.is_some()
            && !call.allow.contains(&401)
        {
            let (has_refresh, same, ticket) = {
                let st = self.state();
                (
                    st.refresh_token.is_some(),
                    st.access_token == sent_with,
                    st.refresh_epoch,
                )
            };
            if has_refresh {
                // Another request may have refreshed already while this one was out.
                if same {
                    self.refresh_shared(ticket).await?;
                }
                sent_with = self.state().access_token.clone();
                res = self.send(call, sent_with.as_deref()).await?;
            }
        }
        let status = res.status().as_u16();
        let ok = if call.allow.is_empty() {
            res.status().is_success()
        } else {
            call.allow.contains(&status)
        };
        if !ok {
            let text = res.text().await.unwrap_or_default();
            let err = error_from_response(status, &text);
            if err.is_auth() {
                self.fire_auth_error(&err, sent_with);
            }
            return Err(err);
        }
        Ok(res)
    }

    async fn send(&self, call: &Call, token: Option<&str>) -> Result<reqwest::Response> {
        let path = if call.path.starts_with('/') {
            call.path.clone()
        } else {
            format!("/{}", call.path)
        };
        let mut req = self.inner.http.request(
            call.method.clone(),
            format!("{}{path}", self.inner.base_url),
        );
        for (name, value) in &call.headers {
            req = req.header(name, value);
        }
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(body) = &call.body {
            req = req
                .header(CONTENT_TYPE, &body.content_type)
                .body(body.data.clone());
        }
        Ok(req.send().await?)
    }
}

impl fmt::Debug for PlumClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.state();
        f.debug_struct("PlumClient")
            .field("base_url", &self.inner.base_url)
            .field("iss", &self.inner.iss)
            .field("client_id", &self.inner.client_id)
            .field("environment", &self.inner.environment)
            .field("access_token", &st.access_token.as_deref().map(redacted))
            .field("refresh_token", &st.refresh_token.as_deref().map(redacted))
            .field("expires_at", &st.expires_at)
            .field("app_folder", &st.app_folder)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = "https://pb-x.plumbox.me";

    fn with_refresh() -> OAuthTokens {
        OAuthTokens {
            refresh_token: Some("plum_rt_1".into()),
            expires_at: Some(now_ms() + 3_600_000),
            ..OAuthTokens::bearer("plum_pat_1")
        }
    }

    #[test]
    fn refuses_a_refresh_token_it_could_not_use_safely() {
        let e = PlumClient::builder(BOX)
            .tokens(with_refresh())
            .build()
            .unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("client_id")),
            "{e}"
        );
        let e = PlumClient::builder("http://192.168.0.10:8443")
            .client_id("a:b")
            .tokens(with_refresh())
            .build()
            .unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("verified iss")),
            "{e}"
        );
        let e = PlumClient::builder(BOX)
            .iss("https://pb-x-lan.plumbox.me")
            .client_id("a:b")
            .tokens(with_refresh())
            .build()
            .unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("verified iss")),
            "{e}"
        );
        let ok = PlumClient::builder(format!("{BOX}/"))
            .client_id("a:b")
            .tokens(with_refresh())
            .build()
            .unwrap();
        assert_eq!(ok.base_url(), BOX);
        let lan = PlumClient::builder("http://192.168.0.10:8443")
            .iss(BOX)
            .client_id("a:b")
            .tokens(with_refresh())
            .build()
            .unwrap();
        assert_eq!(lan.iss(), BOX);
    }

    #[test]
    fn each_environment_takes_only_its_own_boxes() {
        let stag = "https://pb-x.staging.plumbox.me";
        let e = PlumClient::builder(stag).build().unwrap_err();
        assert!(e.to_string().contains("not a box of plumbox.me"), "{e}");
        let c = PlumClient::builder(stag)
            .environment(Environment::Staging)
            .build()
            .unwrap();
        assert_eq!(c.portal_origin(), "https://staging.plumbox.me");
        assert_eq!(c.box_domain(), "staging.plumbox.me");
        let e = PlumClient::builder(BOX)
            .environment(Environment::Staging)
            .build()
            .unwrap_err();
        assert!(e.to_string().contains("not a box of staging"), "{e}");
        let e = PlumClient::builder(BOX)
            .portal_origin("https://staging.plumbox.me")
            .build()
            .unwrap_err();
        assert!(e.to_string().contains("not the portal"), "{e}");
        for env in [Environment::Production, Environment::Staging] {
            let c = PlumClient::builder("http://192.168.0.10:8443")
                .environment(env)
                .build()
                .unwrap();
            assert_eq!(c.base_url(), "http://192.168.0.10:8443");
        }
    }

    #[test]
    fn holds_and_replaces_tokens_and_never_prints_them() {
        let c = PlumClient::builder(BOX)
            .client_id("a:b")
            .tokens(OAuthTokens {
                app_folder: Some("/Apps/X".into()),
                ..with_refresh()
            })
            .build()
            .unwrap();
        assert!(c.has_token());
        assert_eq!(c.app_folder().as_deref(), Some("/Apps/X"));
        assert_eq!(
            c.tokens().unwrap().refresh_token.as_deref(),
            Some("plum_rt_1")
        );
        let dbg = format!("{c:?}");
        assert!(
            !dbg.contains("plum_pat_1") && !dbg.contains("plum_rt_1"),
            "{dbg}"
        );
        c.set_tokens(OAuthTokens::bearer("plum_pat_2")).unwrap();
        assert_eq!(c.tokens().unwrap().refresh_token, None);
        c.clear_tokens();
        assert!(!c.has_token() && c.tokens().is_none());
    }

    #[test]
    fn a_refresh_token_alone_is_due_at_once() {
        let c = PlumClient::builder(BOX)
            .client_id("a:b")
            .tokens(OAuthTokens {
                refresh_token: Some("plum_rt_1".into()),
                ..OAuthTokens::bearer("")
            })
            .build()
            .unwrap();
        assert!(!c.has_token());
        assert!(c.state().refresh_due(now_ms()));
    }

    #[test]
    fn the_client_and_its_futures_are_send_and_sync() {
        fn send_sync<T: Send + Sync>(_: &T) {}
        fn send<T: Send>(_: &T) {}
        let c = PlumClient::builder(BOX).build().unwrap();
        send_sync(&c);
        send(&c.refresh());
        send(&c.request(Method::GET, "/api/auth/me", None));
        let d = c.drive();
        send_sync(&d);
        send(&d.list("/", &Default::default()));
        send(&d.upload_file("/a", std::path::Path::new("a"), &Default::default()));
        send(&d.download_to_file("/a", std::path::Path::new("a"), &Default::default()));
    }
}
