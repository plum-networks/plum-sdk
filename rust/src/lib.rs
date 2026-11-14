//! # plumbox-client
//!
//! The Rust SDK for apps that connect to a user's **Plum Box**: the
//! counterpart of the web/Node SDK `@plumbox/client` 0.4.0, with the same
//! concepts, names (in snake_case) and behaviour.
//!
//! Third-party apps sign in with **delegated OAuth (Authorization Code +
//! PKCE)**: the user finds their box on plumbox.me and types the password
//! only on that box's own page, in the system browser. Your app receives a
//! scoped, revocable token — never the password.
//!
//! 1. [`begin_authorization`] → open [`AuthorizationRequest::url`] in the
//!    system browser; keep `state` and `code_verifier`.
//! 2. Your redirect URI receives `…?code=…&state=…&iss=…`:
//!    [`parse_callback`] checks `iss`, [`exchange_code`] checks `state` and
//!    trades the code for [`OAuthTokens`] at that box.
//! 3. [`PlumClient`] holds the tokens, refreshes the hourly access token by
//!    itself (handing every rotated set to your [`TokenSink`]) and gives you
//!    the box's [`Drive`].
//!
//! ```no_run
//! use plumbox_client::{begin_authorization, exchange_code, parse_callback, scope,
//!                      Environment, ExchangeCode, OAuthTokens, PlumClient};
//!
//! # async fn run(open_in_browser: impl Fn(&str), wait_for_redirect: impl AsyncFn() -> String)
//! # -> plumbox_client::Result<()> {
//! const CLIENT_ID: &str = "com.example.app:ios";
//! const REDIRECT_URI: &str = "exampleapp://plum/callback";
//! let env = Environment::Production;
//!
//! let req = begin_authorization(CLIENT_ID, REDIRECT_URI, &[scope::FILES_APP], &env)?;
//! open_in_browser(&req.url);
//!
//! let cb = parse_callback(&wait_for_redirect().await, &env)?;
//! let (Some(code), Some(iss)) = (cb.code.as_deref(), cb.iss.as_deref()) else {
//!     panic!("not connected: {:?}", cb.error);
//! };
//! let tokens = exchange_code(ExchangeCode {
//!     iss,
//!     code,
//!     state: cb.state.as_deref(),
//!     expected_state: &req.state,
//!     code_verifier: &req.code_verifier,
//!     client_id: CLIENT_ID,
//!     redirect_uri: REDIRECT_URI,
//!     ..Default::default()
//! })
//! .await?;
//!
//! let client = PlumClient::builder(iss)
//!     .client_id(CLIENT_ID)
//!     .tokens(tokens)
//!     .on_tokens(|next: &OAuthTokens| { /* persist `next` */ })
//!     .build()?;
//! let folder = client.app_folder().unwrap_or_default();
//! client.drive().upload(&format!("{folder}/hello.txt"), b"hello", &Default::default()).await?;
//! # Ok(()) }
//! ```
//!
//! ## Features
//!
//! - `webpki-roots` (default): the HTTP client the SDK builds when you pass
//!   none uses rustls with `ring` and Mozilla's roots
//!   (`http_client_builder`). Without it, pass your own `reqwest::Client`.
//! - `testing`: `testing::FakeBox`, an in-process fake box for your tests,
//!   and `Environment::Local` to sign in to it. Never in a product build:
//!   `Environment::Local` accepts a loopback `http://` box as an issuer, so
//!   it exists only when this feature is compiled in.

#![warn(missing_docs)]

mod client;
mod drive;
mod env;
mod error;
mod http;
mod oauth;

#[cfg(feature = "testing")]
pub mod testing;

pub use client::{PlumClient, PlumClientBuilder, TokenSink};
pub use drive::{
    CHUNKED_THRESHOLD, DownloadOptions, Drive, DriveEntry, ListOptions, ListPage, ProgressFn,
    SortKey, SortOrder, UploadOptions, UploadSession,
};
pub use env::{Environment, is_foreign_url};
pub use error::{Error, OAuthErrorCode, Result};
#[cfg(feature = "webpki-roots")]
pub use http::http_client_builder;
pub use http::{RequestBody, default_http_client};
pub use oauth::{
    AuthorizationRequest, Callback, ExchangeCode, OAuthTokens, begin_authorization,
    callback_from_params, code_challenge, exchange_code, is_plum_issuer, parse_callback,
    refresh_tokens, scope,
};

/// `reqwest`, re-exported so you can build a client (or name its types)
/// at the version this crate uses.
pub use reqwest;
