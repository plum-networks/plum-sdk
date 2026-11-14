//! Errors (the TS SDK's `errors.ts`).
//!
//! | TS                     | Rust                      |
//! |------------------------|---------------------------|
//! | `PlumOAuthError`       | [`Error::OAuth`]          |
//! | `PlumAuthError`        | [`Error::Auth`]           |
//! | `PlumForbiddenError`   | [`Error::Forbidden`]      |
//! | `PlumApiError`         | [`Error::Api`]            |
//! | the transport's error  | [`Error::Network`]        |
//! | a plain `Error` throw  | [`Error::InvalidInput`]   |
//! | (none: TS has no files)| [`Error::Io`]             |

use std::sync::Arc;

/// `Result` with this crate's [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Why a sign-in stopped before anything was sent ([`Error::OAuth`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OAuthErrorCode {
    /// The callback named no box, or something that is not a Plum box's own
    /// address (`https://pb-….plumbox.me`). The authorization code is never
    /// sent anywhere.
    InvalidIss,
    /// The callback's `state` is not the one this sign-in began with (a
    /// forged or stale redirect).
    InvalidState,
    /// No code and no error, or a required value is missing.
    InvalidRequest,
}

impl OAuthErrorCode {
    /// The wire spelling: `"invalid_iss"`, `"invalid_state"`, `"invalid_request"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidIss => "invalid_iss",
            Self::InvalidState => "invalid_state",
            Self::InvalidRequest => "invalid_request",
        }
    }
}

impl std::fmt::Display for OAuthErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Everything that can go wrong. `Clone`, so one failed refresh can be handed
/// to every request that was waiting on it.
#[derive(Debug, Clone, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// A sign-in the SDK stopped on its own, before anything was sent: the
    /// redirect back from the box did not hold up (`PlumOAuthError`).
    #[error("{message}")]
    OAuth {
        /// Why.
        code: OAuthErrorCode,
        /// What happened, for logs.
        message: String,
    },

    /// The credential itself is no good (`PlumAuthError`): a 401 the client
    /// could not cure by refreshing, or a refresh the box refused with
    /// `invalid_grant` (status 400, `code` `"invalid_grant"`: the connection
    /// is gone and the user has to connect again). Fires the client's
    /// `on_auth_error` callback.
    #[error("not signed in (HTTP {status}): {message}")]
    Auth {
        /// 401, or 400 for a refused refresh.
        status: u16,
        /// The box's error code (`"invalid_grant"`, `"invalid_token"`, …).
        code: Option<String>,
        /// The box's message.
        message: String,
    },

    /// 403: the credential is fine, but it may not do this — a scope it was
    /// not granted, or (a `files:app` token) a path outside its app folder
    /// (`PlumForbiddenError`). Signing in again would not change the
    /// answer, so it does NOT fire `on_auth_error`.
    #[error("not allowed (HTTP {status}): {message}")]
    Forbidden {
        /// 403.
        status: u16,
        /// The box's error code, when it sent one.
        code: Option<String>,
        /// The box's message.
        message: String,
    },

    /// Any other answer the box gave that is not a success (`PlumApiError`):
    /// 404, 409, 5xx, an OAuth error from the token endpoint other than a
    /// refused refresh (`unauthorized_client`, `invalid_scope`, …), or
    /// `invalid_token_response` for a 200 that carried no access token. A
    /// refresh that fails this way leaves the refresh token good.
    #[error("the box answered HTTP {status}: {message}")]
    Api {
        /// The HTTP status.
        status: u16,
        /// The box's error code, when it sent one.
        code: Option<String>,
        /// The box's message.
        message: String,
    },

    /// The box could not be reached, or the connection broke (the
    /// transport's own error in TS). Nothing about the credential is known;
    /// a refresh that fails this way leaves the refresh token good.
    #[error("network: {0}")]
    Network(Arc<reqwest::Error>),

    /// A local file could not be read or written (uploads and downloads).
    #[error("i/o: {0}")]
    Io(Arc<std::io::Error>),

    /// The SDK was called in a way it cannot work with: a missing client id,
    /// an unknown environment, a refresh token without a verified `iss`, a
    /// malformed callback URL, … (a plain `Error` throw in TS).
    #[error("{0}")]
    InvalidInput(String),
}

impl Error {
    /// The HTTP status, for the variants that have one.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Auth { status, .. }
            | Self::Forbidden { status, .. }
            | Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The machine-readable code: the box's `error` for HTTP errors
    /// (`"invalid_grant"`, `"offset_mismatch"`, …), the SDK's own for
    /// [`Error::OAuth`] (`"invalid_iss"`, …).
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::OAuth { code, .. } => Some(code.as_str()),
            Self::Auth { code, .. } | Self::Forbidden { code, .. } | Self::Api { code, .. } => {
                code.as_deref()
            }
            _ => None,
        }
    }

    /// The credential is no good ([`Error::Auth`]): connect the user again.
    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Auth { .. })
    }

    /// The box refused the refresh token: the connection is gone.
    pub fn is_invalid_grant(&self) -> bool {
        self.is_auth() && self.code() == Some("invalid_grant")
    }

    /// 403 ([`Error::Forbidden`]).
    pub fn is_forbidden(&self) -> bool {
        matches!(self, Self::Forbidden { .. })
    }

    /// 404 from the box (a path that is not there).
    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Network(Arc::new(e))
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(Arc::new(e))
    }
}

/// Map a box's non-success answer: `{"error","message"}` JSON (or
/// `error_description`, as the token endpoint sends) or plain text. 401 is
/// [`Error::Auth`], 403 [`Error::Forbidden`], anything else [`Error::Api`].
pub(crate) fn error_from_response(status: u16, body: &str) -> Error {
    let mut message = body.trim().to_owned();
    let mut code = None;
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(body) {
        let text = |k: &str| {
            map.get(k)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        };
        let err = text("error");
        if let Some(m) = text("message")
            .or_else(|| text("error_description"))
            .or(err)
        {
            message = m.to_owned();
            code = err.map(str::to_owned);
        }
    }
    if message.len() > 500 {
        let mut cut = 500;
        while !message.is_char_boundary(cut) {
            cut -= 1;
        }
        message.truncate(cut);
    }
    match status {
        401 => Error::Auth {
            status,
            code,
            message,
        },
        403 => Error::Forbidden {
            status,
            code,
            message,
        },
        _ => Error::Api {
            status,
            code,
            message,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_and_reads_the_body() {
        let e = error_from_response(401, r#"{"error":"invalid_token"}"#);
        assert!(e.is_auth());
        assert_eq!(e.code(), Some("invalid_token"));
        let e = error_from_response(403, "path not allowed\n");
        assert!(e.is_forbidden());
        assert_eq!(e.code(), None);
        assert!(matches!(&e, Error::Forbidden { message, .. } if message == "path not allowed"));
        let e = error_from_response(
            400,
            r#"{"error":"invalid_grant","error_description":"connect the app again"}"#,
        );
        assert!(
            matches!(&e, Error::Api { status: 400, message, .. } if message == "connect the app again")
        );
        assert_eq!(e.code(), Some("invalid_grant"));
        assert!(
            !e.is_invalid_grant(),
            "only a refused refresh is an Auth error"
        );
        let e = error_from_response(500, &"é".repeat(400));
        assert!(matches!(&e, Error::Api { message, .. } if message.len() <= 500));
        assert!(error_from_response(404, "").is_not_found());
    }
}
