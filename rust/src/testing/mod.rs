//! An in-process fake Plum Box for tests (feature `testing`). Never enable
//! the feature in a product build.
//!
//! [`FakeBox`] serves the parts of a box an app's OAuth client and Drive
//! code talk to, over real HTTP on `127.0.0.1`:
//!
//! - sign-in: [`FakeBox::approve`] stands in for the portal and the consent
//!   screen (it returns the callback URL the browser would open), and
//!   `POST /api/oauth/token` exchanges the code (PKCE S256 checked) — as a
//!   current box (hourly access token, rotating refresh token, `app_folder`
//!   for `files:app`) or, with [`FakeBoxConfig::old_box`], as an older one
//!   (an access token that never expires, nothing to refresh);
//! - refresh with rotation, a grace period for the refresh token just
//!   replaced (60 s by default), and reuse after it revoking the
//!   connection; injected expiry ([`FakeBox::expire_access_tokens`]),
//!   revocation and refresh failures; holding refreshes to line up
//!   concurrent requests ([`FakeBox::hold_refreshes`]);
//! - the Drive: list (paged), download (with `Range`), upload (multipart and
//!   the chunked `/api/uploads/*` protocol, with injected chunk failures),
//!   mkdir, rename, move, delete (to a trash) — and the `files:app` rule: a
//!   token that has only `files:app` gets 403 for any path outside its
//!   folder, as a box answers;
//! - a log of every request ([`FakeBox::requests`]).
//!
//! ```no_run
//! # async fn t() -> plumbox_client::Result<()> {
//! use plumbox_client::{testing::FakeBox, PlumClient, scope};
//! let fake = FakeBox::start().await;
//! let tokens = fake.issue_tokens("com.example.app:test", &[scope::FILES_APP]);
//! let client = PlumClient::builder(fake.url())
//!     .environment(fake.environment())
//!     .client_id("com.example.app:test")
//!     .tokens(tokens)
//!     .build()?;
//! client.drive().upload(&format!("{}/a.txt", fake.app_folder()), b"hi", &Default::default()).await?;
//! assert_eq!(fake.file(&format!("{}/a.txt", fake.app_folder())).unwrap(), b"hi");
//! # Ok(()) }
//! ```

// The handlers return the response to send as their `Err`: a test server,
// where the size of that value does not matter.
#![allow(clippy::result_large_err)]

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::env::Environment;
use crate::http::rfc3339_now;
use crate::oauth::{OAuthTokens, code_challenge};

mod multipart;

/// How a [`FakeBox`] behaves.
#[derive(Debug, Clone)]
pub struct FakeBoxConfig {
    /// Answer like a box from before access tokens expired: the code
    /// exchange returns `access_token`, `token_type` and `scope` only, the
    /// token never expires, and there is nothing to refresh.
    pub old_box: bool,
    /// `expires_in` of the access tokens it issues, in seconds (3600).
    pub expires_in: u64,
    /// How long the refresh token a refresh replaced still works (60 s).
    /// Presenting it later revokes the connection.
    pub refresh_grace: Duration,
    /// The chunk size `/api/uploads/init` names (4 MiB).
    pub chunk_size: u64,
    /// The app's display name: a `files:app` grant's folder is
    /// `/Apps/<app_name>` ("Test App").
    pub app_name: String,
}

impl Default for FakeBoxConfig {
    fn default() -> Self {
        Self {
            old_box: false,
            expires_in: 3600,
            refresh_grace: Duration::from_secs(60),
            chunk_size: 4 * 1024 * 1024,
            app_name: "Test App".into(),
        }
    }
}

/// One request the fake box received.
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    /// `GET`, `POST`, …
    pub method: String,
    /// The path, e.g. `/api/drive/list`.
    pub path: String,
    /// The raw query string ("" when none).
    pub query: String,
    /// The `Host` header (`127.0.0.1:<port>`).
    pub host: Option<String>,
    /// The `Authorization` header.
    pub authorization: Option<String>,
    /// The `Range` header.
    pub range: Option<String>,
    /// The `Content-Range` header.
    pub content_range: Option<String>,
    /// The `Content-Type` header.
    pub content_type: Option<String>,
    /// The body.
    pub body: Vec<u8>,
}

impl RecordedRequest {
    /// A query parameter, decoded.
    pub fn param(&self, key: &str) -> Option<String> {
        url::form_urlencoded::parse(self.query.as_bytes())
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    }

    /// The bearer token sent, if any.
    pub fn bearer(&self) -> Option<&str> {
        self.authorization.as_deref()?.strip_prefix("Bearer ")
    }

    /// A field of a form-encoded or JSON body.
    pub fn body_field(&self, key: &str) -> Option<String> {
        token_fields(self.content_type.as_deref(), &self.body).remove(key)
    }
}

struct PendingCode {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    scopes: Vec<String>,
}

struct Grant {
    client_id: String,
    scopes: Vec<String>,
    app_folder: Option<String>,
    access: String,
    /// `None`: never expires (an older box's token).
    access_expires: Option<Instant>,
    refresh: Option<String>,
    prev_refresh: Option<String>,
    rotated_at: Option<Instant>,
    revoked: bool,
}

enum Node {
    Dir { mod_time: String },
    File { data: Vec<u8>, mod_time: String },
}

struct UploadSess {
    dir: String,
    name: String,
    size: u64,
    data: Vec<u8>,
    overwrite: bool,
    status: &'static str,
}

#[derive(Default)]
struct BoxState {
    next_id: u64,
    codes: HashMap<String, PendingCode>,
    grants: Vec<Grant>,
    files: BTreeMap<String, Node>,
    trash: Vec<String>,
    uploads: HashMap<String, UploadSess>,
    log: Vec<RecordedRequest>,
    refreshes: usize,
    fail_refresh: VecDeque<(u16, String)>,
    /// `Some(n)`: n more chunks are taken, then one fails.
    fail_chunk_after: Option<usize>,
    ignore_range: bool,
}

impl BoxState {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn mkdir_all(&mut self, path: &str) {
        let mut cur = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            cur.push('/');
            cur.push_str(seg);
            self.files.entry(cur.clone()).or_insert(Node::Dir {
                mod_time: rfc3339_now(),
            });
        }
    }

    fn is_dir(&self, path: &str) -> bool {
        path == "/" || matches!(self.files.get(path), Some(Node::Dir { .. }))
    }

    /// Put a file at `dir/name` the way a box does: replace with
    /// `overwrite`, else `name (2).ext` on a collision. Returns the path.
    fn place(
        &mut self,
        dir: &str,
        name: &str,
        data: Vec<u8>,
        overwrite: bool,
    ) -> Result<String, Response> {
        self.mkdir_all(dir);
        let mut path = join(dir, name);
        match self.files.get(&path) {
            Some(Node::Dir { .. }) => {
                return Err(text(StatusCode::CONFLICT, "A folder with that name exists"));
            }
            Some(Node::File { .. }) if !overwrite => {
                let (stem, ext) = match name.rfind('.') {
                    Some(i) if i > 0 => (&name[..i], &name[i..]),
                    _ => (name, ""),
                };
                let mut n = 2;
                while self.files.contains_key(&path) {
                    path = join(dir, &format!("{stem} ({n}){ext}"));
                    n += 1;
                }
            }
            _ => {}
        }
        self.files.insert(
            path.clone(),
            Node::File {
                data,
                mod_time: rfc3339_now(),
            },
        );
        Ok(path)
    }

    /// Move `from` (and everything under it) to `to`.
    fn relocate(&mut self, from: &str, to: &str) {
        let keys: Vec<String> = self
            .files
            .keys()
            .filter(|k| *k == from || k.starts_with(&format!("{from}/")))
            .cloned()
            .collect();
        for k in keys {
            if let Some(node) = self.files.remove(&k) {
                self.files.insert(format!("{to}{}", &k[from.len()..]), node);
            }
        }
    }

    fn grant_for(&self, authorization: Option<&str>) -> Option<usize> {
        let token = authorization?.strip_prefix("Bearer ")?;
        let now = Instant::now();
        self.grants.iter().position(|g| {
            g.access == token && !g.revoked && g.access_expires.is_none_or(|t| now < t)
        })
    }
}

struct Shared {
    origin: String,
    config: FakeBoxConfig,
    state: Mutex<BoxState>,
    /// `true` while refreshes are held.
    hold: tokio::sync::watch::Sender<bool>,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, BoxState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A fake Plum Box on `http://127.0.0.1:<port>`, running on the current
/// tokio runtime until it is dropped. See the [module docs](self).
pub struct FakeBox {
    shared: Arc<Shared>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for FakeBox {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Holds every refresh at the token endpoint (counted, then waiting) until
/// released or dropped: [`FakeBox::hold_refreshes`].
pub struct RefreshHold {
    shared: Arc<Shared>,
}

impl RefreshHold {
    /// Let the held refreshes go on.
    pub fn release(self) {}
}

impl Drop for RefreshHold {
    fn drop(&mut self) {
        self.shared.hold.send_replace(false);
    }
}

impl FakeBox {
    /// Start a fake current box.
    pub async fn start() -> Self {
        Self::start_with(FakeBoxConfig::default()).await
    }

    /// Start a fake box that behaves as `config` says.
    pub async fn start_with(config: FakeBoxConfig) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1");
        let origin = format!("http://{}", listener.local_addr().expect("local addr"));
        let shared = Arc::new(Shared {
            origin,
            config,
            state: Mutex::new(BoxState::default()),
            hold: tokio::sync::watch::channel(false).0,
        });
        let app = axum::Router::new()
            .fallback(handle)
            .with_state(shared.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { shared, server }
    }

    /// The box's origin, `http://127.0.0.1:<port>`: its address and its `iss`.
    pub fn url(&self) -> &str {
        &self.shared.origin
    }

    /// The environment that accepts this box as an issuer (and is its portal).
    pub fn environment(&self) -> Environment {
        Environment::Local {
            origin: self.shared.origin.clone(),
        }
    }

    /// The folder a `files:app` grant gets: `/Apps/<app_name>`.
    pub fn app_folder(&self) -> String {
        format!("/Apps/{}", self.shared.config.app_name)
    }

    /// The user approves the sign-in that `authorization_url` (from
    /// [`begin_authorization`](crate::begin_authorization)) started: returns
    /// the callback URL the browser would open, `<redirect_uri>?code=…&state=…&iss=…`.
    /// Panics on a URL that is not an S256 authorization request.
    pub fn approve(&self, authorization_url: &str) -> String {
        let q = query_of(authorization_url);
        let get = |k: &str| q.get(k).cloned().unwrap_or_default();
        assert_eq!(get("response_type"), "code", "response_type");
        assert_eq!(
            get("code_challenge_method"),
            "S256",
            "code_challenge_method"
        );
        assert!(!get("code_challenge").is_empty(), "code_challenge");
        let mut st = self.shared.state();
        let code = format!("code_{}", st.id());
        st.codes.insert(
            code.clone(),
            PendingCode {
                client_id: get("client_id"),
                redirect_uri: get("redirect_uri"),
                challenge: get("code_challenge"),
                scopes: get("scope")
                    .split(' ')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
            },
        );
        callback_url(
            &get("redirect_uri"),
            &[
                ("code", &code),
                ("state", &get("state")),
                ("iss", &self.shared.origin),
            ],
        )
    }

    /// The user turns the sign-in down: the callback URL with
    /// `error=access_denied`.
    pub fn deny(&self, authorization_url: &str) -> String {
        let q = query_of(authorization_url);
        let get = |k: &str| q.get(k).cloned().unwrap_or_default();
        callback_url(
            &get("redirect_uri"),
            &[
                ("error", "access_denied"),
                ("state", &get("state")),
                ("iss", &self.shared.origin),
            ],
        )
    }

    /// Make a connection without the browser part, as if a sign-in with
    /// these scopes had just finished: the tokens the code exchange would
    /// return.
    pub fn issue_tokens(&self, client_id: &str, scopes: &[&str]) -> OAuthTokens {
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        let mut st = self.shared.state();
        let v = new_grant(&self.shared.config, &mut st, client_id, scopes);
        tokens_of(&v)
    }

    /// Every access token issued so far stops working (as an hour passing
    /// would): requests with them get 401 until the app refreshes.
    pub fn expire_access_tokens(&self) {
        let now = Instant::now();
        for g in &mut self.shared.state().grants {
            g.access_expires = Some(now);
        }
    }

    /// The user disconnects the app: every connection ends, every refresh is
    /// `invalid_grant`.
    pub fn revoke_all(&self) {
        for g in &mut self.shared.state().grants {
            g.revoked = true;
        }
    }

    /// The next refresh is answered with this status and body (queued: call
    /// it again for the one after).
    pub fn fail_next_refresh(&self, status: u16, body: &str) {
        self.shared
            .state()
            .fail_refresh
            .push_back((status, body.to_owned()));
    }

    /// Hold refreshes: each is counted ([`refresh_count`](Self::refresh_count))
    /// and then waits until the returned guard is released or dropped.
    pub fn hold_refreshes(&self) -> RefreshHold {
        self.shared.hold.send_replace(true);
        RefreshHold {
            shared: self.shared.clone(),
        }
    }

    /// How many refreshes reached the token endpoint.
    pub fn refresh_count(&self) -> usize {
        self.shared.state().refreshes
    }

    /// Every request so far, in order.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.shared.state().log.clone()
    }

    /// The requests to `path` (e.g. `/api/drive/list`).
    pub fn requests_to(&self, path: &str) -> Vec<RecordedRequest> {
        self.shared
            .state()
            .log
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }

    /// Put a file in the Drive (parents made as needed).
    pub fn put_file(&self, path: &str, data: impl Into<Vec<u8>>) {
        let path = normalize(path);
        let mut st = self.shared.state();
        st.mkdir_all(&split(&path).0);
        st.files.insert(
            path,
            Node::File {
                data: data.into(),
                mod_time: rfc3339_now(),
            },
        );
    }

    /// The content of the file at `path`.
    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        match self.shared.state().files.get(path) {
            Some(Node::File { data, .. }) => Some(data.clone()),
            _ => None,
        }
    }

    /// Make a folder (and its parents).
    pub fn mkdir_all(&self, path: &str) {
        self.shared.state().mkdir_all(path);
    }

    /// Whether `path` is a folder.
    pub fn is_dir(&self, path: &str) -> bool {
        self.shared.state().is_dir(path)
    }

    /// What was deleted, in order (the paths as they were).
    pub fn trash(&self) -> Vec<String> {
        self.shared.state().trash.clone()
    }

    /// Take `n` more upload chunks, then answer the next one with a 500
    /// (once), as a box that lost the connection mid-upload would.
    pub fn fail_upload_chunk_after(&self, n: usize) {
        self.shared.state().fail_chunk_after = Some(n);
    }

    /// Ignore `Range` and always send the whole file (an old server would).
    pub fn ignore_range(&self, ignore: bool) {
        self.shared.state().ignore_range = ignore;
    }
}

fn new_grant(
    config: &FakeBoxConfig,
    st: &mut BoxState,
    client_id: &str,
    scopes: Vec<String>,
) -> Value {
    let n = st.id();
    let app_folder = (!config.old_box && scopes.iter().any(|s| s == "files:app"))
        .then(|| format!("/Apps/{}", config.app_name));
    if let Some(f) = &app_folder {
        st.mkdir_all(f);
    }
    let grant = Grant {
        client_id: client_id.to_owned(),
        scopes: scopes.clone(),
        app_folder: app_folder.clone(),
        access: format!("plum_pat_fake{n}"),
        access_expires: (!config.old_box)
            .then(|| Instant::now() + Duration::from_secs(config.expires_in)),
        refresh: (!config.old_box).then(|| format!("plum_rt_fake{n}")),
        prev_refresh: None,
        rotated_at: None,
        revoked: false,
    };
    let v = token_json(config, &grant);
    st.grants.push(grant);
    v
}

fn token_json(config: &FakeBoxConfig, g: &Grant) -> Value {
    if config.old_box {
        return json!({ "access_token": g.access, "token_type": "bearer", "scope": g.scopes.join(" ") });
    }
    let mut v = json!({
        "access_token": g.access,
        "token_type": "bearer",
        "expires_in": config.expires_in,
        "refresh_token": g.refresh,
        "scope": g.scopes.join(" "),
    });
    if let Some(f) = &g.app_folder {
        v["app_folder"] = json!(f);
    }
    v
}

/// The tokens an app would hold after this answer (read as the SDK reads it).
fn tokens_of(v: &Value) -> OAuthTokens {
    crate::oauth::tokens_from_response(200, &v.to_string(), crate::http::now_ms())
        .expect("the fake box answers with an access token")
}

fn query_of(url: &str) -> HashMap<String, String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let q = q.split('#').next().unwrap_or(q);
    url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect()
}

fn callback_url(redirect_uri: &str, params: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in params {
        s.append_pair(k, v);
    }
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    format!("{redirect_uri}{sep}{}", s.finish())
}

fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn split(path: &str) -> (String, String) {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) => ("/".into(), p[1..].to_owned()),
        Some(i) => (p[..i].to_owned(), p[i + 1..].to_owned()),
        None => ("/".into(), p.to_owned()),
    }
}

fn normalize(path: &str) -> String {
    let p = format!("/{}", path.trim_matches('/'));
    if p.len() > 1 { p } else { "/".into() }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn token_fields(content_type: Option<&str>, body: &[u8]) -> HashMap<String, String> {
    if content_type.is_some_and(|c| c.starts_with("application/x-www-form-urlencoded")) {
        return url::form_urlencoded::parse(body).into_owned().collect();
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => m
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned())))
            .collect(),
        _ => HashMap::new(),
    }
}

fn respond(status: StatusCode, content_type: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body.into())
        .expect("a response")
}

fn json_response(status: StatusCode, v: Value) -> Response {
    respond(status, "application/json", v.to_string())
}

fn text(status: StatusCode, msg: &str) -> Response {
    // As Go's http.Error writes it.
    respond(status, "text/plain; charset=utf-8", format!("{msg}\n"))
}

fn oauth_err(status: StatusCode, code: &str, desc: &str) -> Response {
    json_response(status, json!({ "error": code, "error_description": desc }))
}

fn unauthorized() -> Response {
    let mut r = json_response(
        StatusCode::UNAUTHORIZED,
        json!({ "error": "invalid_token", "message": "the access token is not valid" }),
    );
    r.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        header::HeaderValue::from_static("Bearer error=\"invalid_token\""),
    );
    r
}

fn forbidden() -> Response {
    text(StatusCode::FORBIDDEN, "path not allowed")
}

/// How a path must relate to a `files:app` folder for an operation, as the
/// box's `CheckAppFolder`: rename, move and delete only strictly inside it;
/// everything else inside or the folder itself.
#[derive(Clone, Copy)]
enum Reach {
    Within,
    Strict,
}

/// What a grant may do with `path`. `Err` is the response to send.
fn check_path(g: &Grant, path: &str, write: bool, reach: Reach) -> Result<(), Response> {
    let has = |s: &str| g.scopes.iter().any(|x| x == s);
    let folder_only = has("files:app")
        && !["files:read", "files:write", "read", "write"]
            .iter()
            .any(|s| has(s));
    if folder_only {
        let root = g.app_folder.as_deref().unwrap_or("/");
        let path = normalize(path);
        let inside = path.starts_with(&format!("{root}/"));
        let ok = match reach {
            Reach::Within => inside || path == root,
            Reach::Strict => inside,
        };
        return if root != "/" && ok {
            Ok(())
        } else {
            Err(forbidden())
        };
    }
    let may = if write {
        has("files:write") || has("write")
    } else {
        has("files:read") || has("files:write") || has("read") || has("write")
    };
    if may {
        Ok(())
    } else {
        Err(text(StatusCode::FORBIDDEN, "insufficient scope"))
    }
}

async fn handle(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default()
        .to_vec();
    let hdr = |h: &HeaderMap, n: header::HeaderName| {
        h.get(n).and_then(|v| v.to_str().ok()).map(str::to_owned)
    };
    let rec = RecordedRequest {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        query: parts.uri.query().unwrap_or("").to_owned(),
        host: hdr(&parts.headers, header::HOST),
        authorization: hdr(&parts.headers, header::AUTHORIZATION),
        range: hdr(&parts.headers, header::RANGE),
        content_range: hdr(&parts.headers, header::CONTENT_RANGE),
        content_type: hdr(&parts.headers, header::CONTENT_TYPE),
        body,
    };
    shared.state().log.push(rec.clone());

    if rec.path == "/api/oauth/token" && parts.method == Method::POST {
        return token_endpoint(&shared, &rec).await;
    }

    let mut st = shared.state();
    let Some(gi) = st.grant_for(rec.authorization.as_deref()) else {
        return unauthorized();
    };
    let r = route(&shared, &mut st, gi, &parts.method, &rec);
    r.unwrap_or_else(|e| e)
}

async fn token_endpoint(shared: &Shared, rec: &RecordedRequest) -> Response {
    let f = token_fields(rec.content_type.as_deref(), &rec.body);
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    match get("grant_type").as_str() {
        "authorization_code" => {
            let mut st = shared.state();
            let Some(pending) = st.codes.remove(&get("code")) else {
                return oauth_err(
                    StatusCode::BAD_REQUEST,
                    "invalid_grant",
                    "unknown or used code",
                );
            };
            if pending.client_id != get("client_id")
                || pending.redirect_uri != get("redirect_uri")
                || code_challenge(&get("code_verifier")) != pending.challenge
            {
                return oauth_err(
                    StatusCode::BAD_REQUEST,
                    "invalid_grant",
                    "code, client or verifier mismatch",
                );
            }
            let v = new_grant(&shared.config, &mut st, &pending.client_id, pending.scopes);
            json_response(StatusCode::OK, v)
        }
        "refresh_token" => {
            let mut held = {
                let mut st = shared.state();
                st.refreshes += 1;
                shared.hold.subscribe()
            };
            let _ = held.wait_for(|h| !*h).await;
            let mut st = shared.state();
            if let Some((status, body)) = st.fail_refresh.pop_front() {
                return respond(
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    "application/json",
                    body,
                );
            }
            refresh(shared, &mut st, &get("client_id"), &get("refresh_token"))
        }
        _ => oauth_err(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "grant_type must be authorization_code or refresh_token",
        ),
    }
}

fn refresh(shared: &Shared, st: &mut BoxState, client_id: &str, presented: &str) -> Response {
    let invalid = || {
        oauth_err(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "connect the app again",
        )
    };
    let now = Instant::now();
    let config = &shared.config;
    let Some(gi) = st.grants.iter().position(|g| {
        !presented.is_empty()
            && (g.refresh.as_deref() == Some(presented)
                || g.prev_refresh.as_deref() == Some(presented))
    }) else {
        return invalid();
    };
    let n = st.id();
    let g = &mut st.grants[gi];
    if g.revoked || g.client_id != client_id {
        return invalid();
    }
    if g.refresh.as_deref() == Some(presented) {
        // The current one: it becomes the previous one, for the grace.
        g.prev_refresh = g.refresh.take();
        g.rotated_at = Some(now);
    } else if g
        .rotated_at
        .is_none_or(|t| now.duration_since(t) > config.refresh_grace)
    {
        // An old one after the grace: two parties hold the connection. End it.
        g.revoked = true;
        return invalid();
    }
    // (Inside the grace, the grace keeps counting from the first rotation.)
    g.refresh = Some(format!("plum_rt_fake{n}"));
    g.access = format!("plum_pat_fake{n}");
    g.access_expires = Some(now + Duration::from_secs(config.expires_in));
    json_response(StatusCode::OK, token_json(config, g))
}

fn route(
    shared: &Shared,
    st: &mut BoxState,
    gi: usize,
    method: &Method,
    rec: &RecordedRequest,
) -> Result<Response, Response> {
    let body_json = || serde_json::from_slice::<Value>(&rec.body).unwrap_or(Value::Null);
    let field = |v: &Value, k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let param = |k: &str| rec.param(k).unwrap_or_default();
    let path = rec.path.as_str();
    match (method.clone(), path) {
        (Method::GET, "/api/auth/me") => Ok(json_response(
            StatusCode::OK,
            json!({ "user": { "id": "u1", "username": "tester" } }),
        )),
        (Method::GET, "/api/drive/list") => {
            let dir = normalize(&rec.param("path").unwrap_or_else(|| "/".into()));
            check_path(&st.grants[gi], &dir, false, Reach::Within)?;
            if !st.is_dir(&dir) {
                return Err(text(StatusCode::NOT_FOUND, "not found"));
            }
            let recursive = param("recursive") == "1";
            let with_hash = param("hash") == "1";
            let prefix = if dir == "/" {
                "/".to_owned()
            } else {
                format!("{dir}/")
            };
            let all: Vec<Value> = st
                .files
                .iter()
                .filter(|(k, _)| k.starts_with(&prefix) && (recursive || !k[prefix.len()..].contains('/')))
                .map(|(k, node)| {
                    let name = k.rsplit('/').next().unwrap_or_default();
                    match node {
                        Node::Dir { mod_time } => {
                            json!({ "name": name, "path": k, "isDir": true, "size": 0, "modTime": mod_time })
                        }
                        Node::File { data, mod_time } => {
                            let mut v = json!({ "name": name, "path": k, "isDir": false, "size": data.len(), "modTime": mod_time });
                            if with_hash {
                                v["hash"] = json!(hex(&Sha256::digest(data)));
                            }
                            v
                        }
                    }
                })
                .collect();
            let limit: usize = param("limit").parse().unwrap_or(1000).clamp(1, 1000);
            let offset: usize = param("offset").parse().unwrap_or(0);
            let total = all.len();
            let items: Vec<Value> = all.into_iter().skip(offset).take(limit).collect();
            Ok(json_response(
                StatusCode::OK,
                json!({ "items": items, "total": total, "limit": limit, "offset": offset }),
            ))
        }
        (Method::GET, "/api/drive/download") => {
            let p = normalize(&param("path"));
            check_path(&st.grants[gi], &p, false, Reach::Within)?;
            let Some(Node::File { data, .. }) = st.files.get(&p) else {
                return Err(text(StatusCode::NOT_FOUND, "not found"));
            };
            let len = data.len() as u64;
            let range = rec
                .range
                .as_deref()
                .filter(|_| !st.ignore_range)
                .and_then(|r| r.strip_prefix("bytes="))
                .and_then(|r| r.split_once('-'))
                .and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok())));
            match range {
                Some((start, _)) if start >= len => {
                    let mut r = text(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable");
                    r.headers_mut().insert(
                        header::CONTENT_RANGE,
                        format!("bytes */{len}").parse().expect("header"),
                    );
                    Ok(r)
                }
                Some((start, end)) => {
                    let end = end.unwrap_or(len - 1).min(len - 1);
                    let mut r = respond(
                        StatusCode::PARTIAL_CONTENT,
                        "application/octet-stream",
                        data[start as usize..=end as usize].to_vec(),
                    );
                    r.headers_mut().insert(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{len}")
                            .parse()
                            .expect("header"),
                    );
                    Ok(r)
                }
                None => Ok(respond(
                    StatusCode::OK,
                    "application/octet-stream",
                    data.clone(),
                )),
            }
        }
        (Method::POST, "/api/drive/upload") => {
            let parts = multipart::parse(rec.content_type.as_deref().unwrap_or(""), &rec.body)
                .ok_or_else(|| text(StatusCode::BAD_REQUEST, "Failed to get file"))?;
            let dir = normalize(&parts.field("path").unwrap_or_else(|| "/".into()));
            let overwrite = matches!(parts.field("overwrite").as_deref(), Some("1" | "true"));
            let (name, data) = parts
                .file("file")
                .ok_or_else(|| text(StatusCode::BAD_REQUEST, "Failed to get file"))?;
            check_path(&st.grants[gi], &dir, true, Reach::Within)?;
            if name.is_empty() || name.contains('/') {
                return Err(text(StatusCode::BAD_REQUEST, "Invalid filename"));
            }
            let placed = st.place(&dir, &name, data, overwrite)?;
            let placed_name = placed.rsplit('/').next().unwrap_or_default().to_owned();
            Ok(json_response(
                StatusCode::OK,
                json!({ "status": "ok", "path": placed, "name": placed_name }),
            ))
        }
        (Method::POST, "/api/drive/mkdir") => {
            let b = body_json();
            let parent = normalize(&field(&b, "path"));
            let name = field(&b, "name");
            // As the box: the folder it is made in must be inside the app folder.
            check_path(&st.grants[gi], &parent, true, Reach::Within)?;
            if name.is_empty() || name.contains('/') {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "invalid_name", "message": "Invalid name" }),
                ));
            }
            let full = join(&parent, &name);
            if matches!(st.files.get(&full), Some(Node::File { .. })) {
                return Err(text(StatusCode::CONFLICT, "a file with that name exists"));
            }
            st.mkdir_all(&full);
            Ok(json_response(
                StatusCode::OK,
                json!({ "status": "ok", "path": full }),
            ))
        }
        (Method::POST, "/api/drive/rename") => {
            let b = body_json();
            let from = normalize(&field(&b, "path"));
            let name = field(&b, "name");
            check_path(&st.grants[gi], &from, true, Reach::Strict)?;
            if !st.files.contains_key(&from) {
                return Err(text(StatusCode::NOT_FOUND, "not found"));
            }
            if name.is_empty() || name.contains('/') {
                return Err(text(StatusCode::BAD_REQUEST, "Invalid name"));
            }
            let to = join(&split(&from).0, &name);
            if st.files.contains_key(&to) {
                return Err(text(StatusCode::CONFLICT, "exists"));
            }
            st.relocate(&from, &to);
            Ok(json_response(StatusCode::OK, json!({ "status": "ok" })))
        }
        (Method::POST, "/api/drive/move") => {
            let b = body_json();
            let from = normalize(&field(&b, "path"));
            let to = normalize(&field(&b, "newPath"));
            check_path(&st.grants[gi], &from, true, Reach::Strict)?;
            check_path(&st.grants[gi], &to, true, Reach::Strict)?;
            if !st.files.contains_key(&from) {
                return Err(text(StatusCode::NOT_FOUND, "not found"));
            }
            if !st.is_dir(&split(&to).0) {
                return Err(text(StatusCode::NOT_FOUND, "destination folder not found"));
            }
            if st.files.contains_key(&to) {
                return Err(text(StatusCode::CONFLICT, "exists"));
            }
            st.relocate(&from, &to);
            Ok(json_response(StatusCode::OK, json!({ "status": "ok" })))
        }
        (Method::DELETE, "/api/drive/delete") => {
            let p = normalize(&param("path"));
            check_path(&st.grants[gi], &p, true, Reach::Strict)?;
            if !st.files.contains_key(&p) {
                return Err(text(StatusCode::NOT_FOUND, "not found"));
            }
            st.files
                .retain(|k, _| !(k == &p || k.starts_with(&format!("{p}/"))));
            st.trash.push(p);
            Ok(json_response(StatusCode::OK, json!({ "status": "ok" })))
        }
        (Method::POST, "/api/uploads/init") => {
            let b = body_json();
            if field(&b, "target") != "drive" {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "invalid_target" }),
                ));
            }
            let dir = normalize(&field(&b, "path"));
            let name = field(&b, "filename");
            let size = b.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
            check_path(&st.grants[gi], &dir, true, Reach::Within)?;
            if name.is_empty() || name.contains('/') {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "invalid_filename" }),
                ));
            }
            let id = format!("up{}", st.id());
            st.uploads.insert(
                id.clone(),
                UploadSess {
                    dir,
                    name,
                    size,
                    data: Vec::new(),
                    overwrite: b
                        .get("overwrite")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false),
                    status: "active",
                },
            );
            Ok(json_response(
                StatusCode::OK,
                json!({
                    "uploadId": id,
                    "chunkSize": shared.config.chunk_size,
                    "expiresAt": "2099-01-01T00:00:00Z",
                    "receivedBytes": 0,
                    "totalBytes": size,
                    "parallelChunks": false,
                }),
            ))
        }
        (m, p) if p.starts_with("/api/uploads/") => {
            let rest = &p["/api/uploads/".len()..];
            let (id, tail) = rest.split_once('/').unwrap_or((rest, ""));
            upload_session(st, m, id, tail, rec)
        }
        _ => Err(text(StatusCode::NOT_FOUND, "404 page not found")),
    }
}

fn upload_session(
    st: &mut BoxState,
    method: Method,
    id: &str,
    tail: &str,
    rec: &RecordedRequest,
) -> Result<Response, Response> {
    let not_found = || {
        json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "session_not_found" }),
        )
    };
    let finish = |st: &mut BoxState, id: &str| -> Result<Response, Response> {
        let u = st.uploads.get_mut(id).ok_or_else(not_found)?;
        let (dir, name, data, overwrite) = (
            u.dir.clone(),
            u.name.clone(),
            std::mem::take(&mut u.data),
            u.overwrite,
        );
        u.status = "finalized";
        let placed = st.place(&dir, &name, data, overwrite)?;
        let placed_name = placed.rsplit('/').next().unwrap_or_default().to_owned();
        Ok(json_response(
            StatusCode::OK,
            json!({ "status": "ok", "path": placed, "name": placed_name }),
        ))
    };
    match (method, tail) {
        (Method::GET, "") => {
            let u = st.uploads.get(id).ok_or_else(not_found)?;
            Ok(json_response(
                StatusCode::OK,
                json!({
                    "uploadId": id,
                    "filename": u.name,
                    "receivedBytes": u.data.len() as u64,
                    "totalBytes": u.size,
                    "status": u.status,
                }),
            ))
        }
        (Method::DELETE, "") => {
            if let Some(u) = st.uploads.get_mut(id)
                && u.status == "active"
            {
                u.status = "aborted";
                u.data.clear();
            }
            Ok(respond(StatusCode::NO_CONTENT, "text/plain", ""))
        }
        (Method::POST, "complete") => {
            let u = st.uploads.get(id).ok_or_else(not_found)?;
            match u.status {
                "finalized" => Ok(json_response(
                    StatusCode::OK,
                    json!({ "status": "ok", "alreadyFinalized": true }),
                )),
                "active" if u.data.len() as u64 == u.size => finish(st, id),
                "active" => Err(json_response(
                    StatusCode::PRECONDITION_FAILED,
                    json!({ "error": "incomplete", "receivedBytes": u.data.len(), "totalBytes": u.size }),
                )),
                other => Err(json_response(
                    StatusCode::GONE,
                    json!({ "error": format!("session_{other}") }),
                )),
            }
        }
        (Method::PATCH, "") => {
            let fail_now = match st.fail_chunk_after {
                Some(0) => {
                    st.fail_chunk_after = None;
                    true
                }
                Some(n) => {
                    st.fail_chunk_after = Some(n - 1);
                    false
                }
                None => false,
            };
            let u = st.uploads.get_mut(id).ok_or_else(not_found)?;
            if u.status != "active" {
                return Err(json_response(
                    StatusCode::GONE,
                    json!({ "error": format!("session_{}", u.status) }),
                ));
            }
            if fail_now {
                return Err(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "chunk_write_failed", "message": "the connection broke" }),
                ));
            }
            let Some((start, end, total)) =
                rec.content_range.as_deref().and_then(parse_content_range)
            else {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "invalid_content_range" }),
                ));
            };
            if total.is_some_and(|t| t != u.size) {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "size_mismatch" }),
                ));
            }
            let received = u.data.len() as u64;
            if start != received {
                return Err(json_response(
                    StatusCode::CONFLICT,
                    json!({ "error": "offset_mismatch", "receivedBytes": received, "totalBytes": u.size }),
                ));
            }
            if end < start || end >= u.size {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "chunk_exceeds_total" }),
                ));
            }
            if rec.body.len() as u64 != end - start + 1 {
                return Err(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "short_chunk" }),
                ));
            }
            u.data.extend_from_slice(&rec.body);
            if (u.data.len() as u64) < u.size {
                return Ok(json_response(
                    StatusCode::OK,
                    json!({ "status": "active", "receivedBytes": u.data.len(), "totalBytes": u.size }),
                ));
            }
            finish(st, id)
        }
        _ => Err(text(StatusCode::NOT_FOUND, "404 page not found")),
    }
}

fn parse_content_range(v: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = v.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (a, b) = range.split_once('-')?;
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    Some((a.parse().ok()?, b.parse().ok()?, total))
}
