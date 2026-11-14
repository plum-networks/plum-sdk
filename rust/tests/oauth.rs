//! The sign-in: PKCE, the `iss` and `state` checks, the code exchange (a
//! current box and an older one) and refreshing by hand. Mirrors
//! `packages/client/test/oauth.test.ts` and `env.test.ts`.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use plumbox_client::testing::{FakeBox, FakeBoxConfig};
use plumbox_client::{
    Callback, Environment, Error, ExchangeCode, OAuthErrorCode, PlumClient, begin_authorization,
    callback_from_params, code_challenge, exchange_code, http_client_builder, is_plum_issuer,
    parse_callback, refresh_tokens, scope,
};
use sha2::{Digest, Sha256};

const CLIENT_ID: &str = "com.example.notes:test";
const REDIRECT: &str = "examplenotes://oauth/callback";

fn query(url: &str) -> Vec<(String, String)> {
    let q = url.split_once('?').unwrap().1;
    url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect()
}

fn get(q: &[(String, String)], k: &str) -> Option<String> {
    q.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone())
}

#[test]
fn begin_authorization_builds_a_portal_url_with_a_valid_s256_challenge() {
    let req = begin_authorization(
        CLIENT_ID,
        REDIRECT,
        &[
            scope::FILES_READ,
            scope::USER_PROFILE,
            &scope::service_call("com.example.notes"),
        ],
        &Environment::Production,
    )
    .unwrap();
    assert!(
        req.url.starts_with("https://plumbox.me/authorize?"),
        "{}",
        req.url
    );
    let q = query(&req.url);
    let keys: Vec<&str> = q.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "code_challenge",
            "code_challenge_method",
            "state"
        ]
    );
    assert_eq!(get(&q, "response_type").unwrap(), "code");
    assert_eq!(get(&q, "client_id").unwrap(), CLIENT_ID);
    assert_eq!(get(&q, "redirect_uri").unwrap(), REDIRECT);
    assert_eq!(
        get(&q, "scope").unwrap(),
        "files:read user:profile service:call:com.example.notes"
    );
    assert_eq!(get(&q, "code_challenge_method").unwrap(), "S256");
    assert_eq!(get(&q, "state").unwrap(), req.state);

    // The challenge must equal base64url(SHA-256(verifier)) — the exact
    // check the box performs — computed here independently.
    let digest = Sha256::digest(req.code_verifier.as_bytes());
    let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    assert_eq!(get(&q, "code_challenge").unwrap(), expected);
    assert_eq!(code_challenge(&req.code_verifier), expected);

    // RFC 7636: 43–128 characters from the unreserved set.
    let unreserved = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    assert_eq!(req.code_verifier.len(), 43);
    assert!(unreserved(&req.code_verifier));
    assert_eq!(req.state.len(), 22);
    assert!(unreserved(&req.state));
    assert!(!req.url.contains("client_name"));
}

#[test]
fn begin_authorization_is_fresh_each_time_and_survives_serialization() {
    let a = begin_authorization(
        CLIENT_ID,
        REDIRECT,
        &["files:app"],
        &Environment::Production,
    )
    .unwrap();
    let b = begin_authorization(
        CLIENT_ID,
        REDIRECT,
        &["files:app"],
        &Environment::Production,
    )
    .unwrap();
    assert_ne!(a.code_verifier, b.code_verifier);
    assert_ne!(a.state, b.state);
    let kept: plumbox_client::AuthorizationRequest =
        serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    assert_eq!(kept, a);
    assert!(!format!("{a:?}").contains(&a.code_verifier));
}

#[test]
fn begin_authorization_needs_a_client_id_and_a_scope_and_starts_at_the_environment_portal() {
    let e =
        begin_authorization(" ", REDIRECT, &["files:read"], &Environment::Production).unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(m) if m.contains("client_id is required")),
        "{e}"
    );
    let none: [&str; 0] = [];
    let e = begin_authorization(CLIENT_ID, REDIRECT, &none, &Environment::Production).unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(m) if m.contains("scope")),
        "{e}"
    );
    let s =
        begin_authorization(CLIENT_ID, REDIRECT, &["files:read"], &Environment::Staging).unwrap();
    assert!(
        s.url.starts_with("https://staging.plumbox.me/authorize?"),
        "{}",
        s.url
    );
}

// v3 contract 10.1 and Appendix C: the only iss a client accepts is a Plum
// box's canonical origin. Same vectors as oauth.test.ts.
fn longest() -> String {
    format!("pb-{}", "a".repeat(59))
}

fn good_iss() -> Vec<String> {
    vec![
        "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me".into(),
        "https://pb-x.plumbox.me".into(),
        "https://pb-a1.plumbox.me".into(),
        "https://pb-old-style-name.plumbox.me".into(),
        "https://pb-xlan.plumbox.me".into(),
        format!("https://{}.plumbox.me", longest()),
    ]
}

fn bad_iss() -> Vec<(&'static str, String)> {
    vec![
        (
            "LAN alias",
            "https://pb-0123456789abcdef0123456789ab7f3a-lan.plumbox.me".into(),
        ),
        (
            "WAN alias",
            "https://pb-0123456789abcdef0123456789ab7f3a-wan.plumbox.me".into(),
        ),
        ("short LAN alias", "https://pb-x-lan.plumbox.me".into()),
        ("short WAN alias", "https://pb-x-wan.plumbox.me".into()),
        ("other domain", "https://pb-x.evil.example".into()),
        (
            "lookalike suffix",
            "https://pb-x.plumbox.me.evil.example".into(),
        ),
        (
            "other domain ending like ours",
            "https://pb-x.notplumbox.me".into(),
        ),
        ("the portal", "https://plumbox.me".into()),
        ("the relay", "https://relay.plumbox.me".into()),
        ("not a box name", "https://www.plumbox.me".into()),
        ("http", "http://pb-x.plumbox.me".into()),
        ("port", "https://pb-x.plumbox.me:443".into()),
        ("other port", "https://pb-x.plumbox.me:8443".into()),
        ("empty", "".into()),
        ("trailing slash", "https://pb-x.plumbox.me/".into()),
        ("path", "https://pb-x.plumbox.me/api".into()),
        ("query", "https://pb-x.plumbox.me?x=1".into()),
        ("fragment", "https://pb-x.plumbox.me#x".into()),
        ("user info", "https://user@pb-x.plumbox.me".into()),
        ("upper case", "https://PB-X.plumbox.me".into()),
        ("upper-case name", "https://pb-X.plumbox.me".into()),
        ("upper-case scheme", "HTTPS://pb-x.plumbox.me".into()),
        ("empty name", "https://pb-.plumbox.me".into()),
        (
            "name starts with a hyphen",
            "https://pb--x.plumbox.me".into(),
        ),
        ("name ends with a hyphen", "https://pb-x-.plumbox.me".into()),
        ("subdomain of a box", "https://a.pb-x.plumbox.me".into()),
        ("dot in the name", "https://pb-x.y.plumbox.me".into()),
        ("too long", format!("https://{}a.plumbox.me", longest())),
        ("leading space", " https://pb-x.plumbox.me".into()),
        ("trailing newline", "https://pb-x.plumbox.me\n".into()),
        ("trailing dot", "https://pb-x.plumbox.me.".into()),
        ("loopback", "http://127.0.0.1:8080".into()),
    ]
}

#[test]
fn is_plum_issuer_takes_only_a_box_canonical_origin() {
    for iss in good_iss() {
        assert!(
            is_plum_issuer(&iss, &Environment::Production),
            "accepts {iss}"
        );
    }
    for (name, iss) in bad_iss() {
        assert!(
            !is_plum_issuer(&iss, &Environment::Production),
            "refuses {name}: {iss:?}"
        );
    }
}

#[test]
fn is_plum_issuer_per_environment() {
    let prod = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me";
    let stag = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me";
    let (p, s) = (Environment::Production, Environment::Staging);
    assert!(is_plum_issuer(prod, &p));
    assert!(!is_plum_issuer(stag, &p));
    assert!(is_plum_issuer(stag, &s));
    assert!(!is_plum_issuer(prod, &s));
    assert!(!is_plum_issuer("https://pb-x-lan.staging.plumbox.me", &s));
    assert!(!is_plum_issuer("https://pb-x-wan.staging.plumbox.me", &s));
    assert!(is_plum_issuer("https://pb-xlan.staging.plumbox.me", &s));
    assert!(!is_plum_issuer(
        "https://pb-xXstagingYplumboxZme.staging.plumbox.me",
        &s
    ));
    assert!(!is_plum_issuer("https://pb-x.stagingXplumbox.me", &s));
    assert!(!is_plum_issuer("https://pb-x.staging.plumboxXme", &s));
}

fn cb(q: &str) -> String {
    format!("myapp://plum/callback?{q}")
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn want(
    code: Option<&str>,
    state: Option<&str>,
    iss: Option<&str>,
    error: Option<&str>,
) -> Callback {
    Callback {
        code: code.map(Into::into),
        state: state.map(Into::into),
        iss: iss.map(Into::into),
        error: error.map(Into::into),
    }
}

#[test]
fn parse_callback_checks_iss_like_the_ts_sdk() {
    let box_iss = "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me";
    let x = "https://pb-x.plumbox.me";
    type Case<'a> = (&'a str, Vec<(&'a str, &'a str)>, Callback);
    let cases: Vec<Case> = vec![
        (
            "a code from a box",
            vec![("code", "C1"), ("state", "S"), ("iss", box_iss)],
            want(Some("C1"), Some("S"), Some(box_iss), None),
        ),
        (
            "a code with no iss",
            vec![("code", "C1"), ("state", "S")],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code with an empty iss",
            vec![("code", "C1"), ("state", "S"), ("iss", "")],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code from the LAN alias",
            vec![
                ("code", "C1"),
                ("state", "S"),
                ("iss", "https://pb-x-lan.plumbox.me"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code from the WAN alias",
            vec![
                ("code", "C1"),
                ("state", "S"),
                ("iss", "https://pb-x-wan.plumbox.me"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code from another domain",
            vec![
                ("code", "C1"),
                ("state", "S"),
                ("iss", "https://pb-x.evil.example"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code over http",
            vec![
                ("code", "C1"),
                ("state", "S"),
                ("iss", "http://pb-x.plumbox.me"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "a code with a port",
            vec![
                ("code", "C1"),
                ("state", "S"),
                ("iss", "https://pb-x.plumbox.me:8443"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "an error from an older box (no iss)",
            vec![("error", "access_denied"), ("state", "S")],
            want(None, Some("S"), None, Some("access_denied")),
        ),
        (
            "an error with the box's iss",
            vec![("error", "access_denied"), ("state", "S"), ("iss", x)],
            want(None, Some("S"), Some(x), Some("access_denied")),
        ),
        (
            "an error with a bad iss",
            vec![
                ("error", "access_denied"),
                ("state", "S"),
                ("iss", "https://pb-x-lan.plumbox.me"),
            ],
            want(None, Some("S"), None, Some("invalid_iss")),
        ),
        (
            "an error and a code",
            vec![
                ("error", "access_denied"),
                ("code", "C1"),
                ("state", "S"),
                ("iss", x),
            ],
            want(None, Some("S"), Some(x), Some("access_denied")),
        ),
        (
            "neither code nor error",
            vec![("state", "S"), ("iss", x)],
            want(None, Some("S"), None, Some("invalid_request")),
        ),
    ];
    for (name, params, expected) in cases {
        let q = params
            .iter()
            .map(|(k, v)| format!("{k}={}", enc(v)))
            .collect::<Vec<_>>()
            .join("&");
        assert_eq!(
            parse_callback(&cb(&q), &Environment::Production).unwrap(),
            expected,
            "{name} (URL)"
        );
        let mut with_action = vec![("action", "plum-sync")];
        with_action.extend(params.iter().copied());
        assert_eq!(
            callback_from_params(with_action, &Environment::Production),
            expected,
            "{name} (params)"
        );
    }
}

#[test]
fn parse_callback_never_hands_back_a_code_without_a_checked_iss() {
    for (name, iss) in bad_iss() {
        let got = parse_callback(
            &cb(&format!("code=C1&state=S&iss={}", enc(&iss))),
            &Environment::Production,
        )
        .unwrap();
        assert_eq!(
            (got.code, got.iss, got.error.as_deref()),
            (None, None, Some("invalid_iss")),
            "{name}"
        );
    }
}

#[test]
fn parse_callback_refuses_parameters_given_twice() {
    let x = enc("https://pb-x.plumbox.me");
    let evil = enc("https://evil.example");
    let p = Environment::Production;
    assert_eq!(
        parse_callback(&cb(&format!("code=C1&state=S&iss={x}&iss={evil}")), &p).unwrap(),
        want(None, Some("S"), None, Some("invalid_iss"))
    );
    assert_eq!(
        parse_callback(&cb(&format!("code=C1&state=S&iss={evil}&iss={x}")), &p).unwrap(),
        want(None, Some("S"), None, Some("invalid_iss"))
    );
    assert_eq!(
        callback_from_params(
            [
                ("code", "C1"),
                ("state", "S"),
                ("iss", "https://pb-x.plumbox.me"),
                ("iss", "https://pb-x.plumbox.me")
            ],
            &p
        ),
        want(None, Some("S"), None, Some("invalid_iss"))
    );
    assert_eq!(
        parse_callback(&cb(&format!("code=A&code=B&state=S&iss={x}")), &p).unwrap(),
        want(
            None,
            Some("S"),
            Some("https://pb-x.plumbox.me"),
            Some("invalid_request")
        )
    );
}

#[test]
fn parse_callback_per_environment_and_on_a_malformed_url() {
    let stag = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me";
    let prod = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me";
    let url = format!("app://cb?code=C&state=S&iss={}", enc(stag));
    assert_eq!(
        parse_callback(&url, &Environment::Production).unwrap(),
        want(None, Some("S"), None, Some("invalid_iss"))
    );
    assert_eq!(
        parse_callback(&url, &Environment::Staging).unwrap(),
        want(Some("C"), Some("S"), Some(stag), None)
    );
    assert_eq!(
        callback_from_params(
            [("code", "C"), ("state", "S"), ("iss", prod)],
            &Environment::Staging
        ),
        want(None, Some("S"), None, Some("invalid_iss"))
    );
    assert!(matches!(
        parse_callback("not a url", &Environment::Production),
        Err(Error::InvalidInput(_))
    ));
}

/// A client that sends everything through the fake box as a proxy, so the
/// fake box sees any request at all — to any host, even an https one (as a
/// CONNECT). "Nothing was sent" is then "the fake box's log is empty".
fn recording_http(fake: &FakeBox) -> reqwest::Client {
    http_client_builder()
        .unwrap()
        .proxy(reqwest::Proxy::all(fake.url()).unwrap())
        .build()
        .unwrap()
}

fn exchange<'a>(iss: &'a str, http: &'a reqwest::Client) -> ExchangeCode<'a> {
    ExchangeCode {
        iss,
        code: "CODE1",
        state: Some("ST"),
        expected_state: "ST",
        code_verifier: "VERIFIER1",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        environment: Environment::Production,
        http: Some(http),
    }
}

fn oauth_code(e: &Error) -> Option<OAuthErrorCode> {
    match e {
        Error::OAuth { code, .. } => Some(*code),
        _ => None,
    }
}

#[tokio::test]
async fn exchange_code_sends_nothing_to_anything_but_a_plum_box() {
    let fake = FakeBox::start().await;
    let http = recording_http(&fake);
    for (name, iss) in bad_iss() {
        let e = exchange_code(exchange(&iss, &http)).await.unwrap_err();
        assert_eq!(
            oauth_code(&e),
            Some(OAuthErrorCode::InvalidIss),
            "{name}: {e}"
        );
    }
    // Another environment's box is not one either.
    let stag = "https://pb-x.staging.plumbox.me";
    let e = exchange_code(exchange(stag, &http)).await.unwrap_err();
    assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidIss));
    assert!(e.to_string().contains("(https://pb-….plumbox.me)"), "{e}");
    let e = exchange_code(ExchangeCode {
        environment: Environment::Staging,
        ..exchange("https://pb-x.plumbox.me", &http)
    })
    .await
    .unwrap_err();
    assert!(
        e.to_string().contains("(https://pb-….staging.plumbox.me)"),
        "{e}"
    );
    assert!(fake.requests().is_empty(), "sent: {:?}", fake.requests());
}

#[tokio::test]
async fn exchange_code_sends_nothing_when_state_or_inputs_do_not_hold_up() {
    let fake = FakeBox::start().await;
    let http = recording_http(&fake);
    let iss = "https://pb-x.plumbox.me";
    let state_cases: Vec<(&str, ExchangeCode)> = vec![
        (
            "a different state",
            ExchangeCode {
                state: Some("OTHER"),
                ..exchange(iss, &http)
            },
        ),
        (
            "no state on the callback",
            ExchangeCode {
                state: None,
                ..exchange(iss, &http)
            },
        ),
        (
            "no expected state",
            ExchangeCode {
                expected_state: "",
                ..exchange(iss, &http)
            },
        ),
        (
            "an empty expected state",
            ExchangeCode {
                state: Some(""),
                expected_state: "",
                ..exchange(iss, &http)
            },
        ),
    ];
    for (name, params) in state_cases {
        let e = exchange_code(params).await.unwrap_err();
        assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidState), "{name}");
        assert_eq!(e.code(), Some("invalid_state"));
    }
    for params in [
        ExchangeCode {
            code: "",
            ..exchange(iss, &http)
        },
        ExchangeCode {
            code_verifier: "",
            ..exchange(iss, &http)
        },
    ] {
        let e = exchange_code(params).await.unwrap_err();
        assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidRequest));
    }
    // The iss is checked first: a bad iss with a bad state is invalid_iss.
    let e = exchange_code(ExchangeCode {
        state: Some("OTHER"),
        ..exchange("https://evil.example", &http)
    })
    .await
    .unwrap_err();
    assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidIss));
    assert!(fake.requests().is_empty(), "sent: {:?}", fake.requests());
}

#[tokio::test]
async fn the_recording_client_would_have_seen_a_request() {
    // The control for the two tests above: a request that does go out
    // through the proxy shows up in the fake box's log.
    let fake = FakeBox::start().await;
    let http = recording_http(&fake);
    let _ = http
        .get("http://pb-x.plumbox.me/api/oauth/token")
        .send()
        .await;
    assert_eq!(fake.requests().len(), 1);
}

#[tokio::test]
async fn a_current_box_exchanges_the_code_end_to_end() {
    let fake = FakeBox::start().await;
    let env = fake.environment();
    let req = begin_authorization(
        CLIENT_ID,
        REDIRECT,
        &[scope::FILES_APP, scope::USER_PROFILE],
        &env,
    )
    .unwrap();
    assert!(req.url.starts_with(&format!("{}/authorize?", fake.url())));
    let callback = fake.approve(&req.url);
    assert!(
        callback.starts_with(&format!("{REDIRECT}?code=")),
        "{callback}"
    );

    let cb = parse_callback(&callback, &env).unwrap();
    assert_eq!(cb.iss.as_deref(), Some(fake.url()));
    assert_eq!(cb.state.as_deref(), Some(req.state.as_str()));
    let before = plumbox_now();
    let tokens = exchange_code(ExchangeCode {
        iss: cb.iss.as_deref().unwrap(),
        code: cb.code.as_deref().unwrap(),
        state: cb.state.as_deref(),
        expected_state: &req.state,
        code_verifier: &req.code_verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        environment: env.clone(),
        http: None,
    })
    .await
    .unwrap();
    assert!(tokens.access_token.starts_with("plum_pat_"));
    assert!(
        tokens
            .refresh_token
            .as_deref()
            .unwrap()
            .starts_with("plum_rt_")
    );
    assert_eq!(tokens.token_type, "bearer");
    assert_eq!(tokens.scope, "files:app user:profile");
    assert_eq!(tokens.app_folder.as_deref(), Some("/Apps/Test App"));
    let exp = tokens.expires_at.unwrap();
    assert!(
        exp >= before + 3_600_000 && exp <= plumbox_now() + 3_600_000,
        "{exp}"
    );

    let sent = fake.requests_to("/api/oauth/token");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].content_type.as_deref(), Some("application/json"));
    let body: serde_json::Value = serde_json::from_slice(&sent[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "grant_type": "authorization_code",
            "code": cb.code.as_deref().unwrap(),
            "code_verifier": req.code_verifier,
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT,
        })
    );

    // A code works once.
    let again = exchange_code(ExchangeCode {
        iss: fake.url(),
        code: cb.code.as_deref().unwrap(),
        state: cb.state.as_deref(),
        expected_state: &req.state,
        code_verifier: &req.code_verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        environment: env.clone(),
        http: None,
    })
    .await
    .unwrap_err();
    assert!(matches!(&again, Error::Api { status: 400, .. }), "{again}");
    assert_eq!(again.code(), Some("invalid_grant"));
    assert!(!again.is_auth(), "a refused code is not a refused refresh");
}

fn plumbox_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tokio::test]
async fn the_box_checks_the_pkce_verifier() {
    let fake = FakeBox::start().await;
    let env = fake.environment();
    let req = begin_authorization(CLIENT_ID, REDIRECT, &["files:app"], &env).unwrap();
    let cb = parse_callback(&fake.approve(&req.url), &env).unwrap();
    let e = exchange_code(ExchangeCode {
        iss: fake.url(),
        code: cb.code.as_deref().unwrap(),
        state: cb.state.as_deref(),
        expected_state: &req.state,
        code_verifier: "a-verifier-that-is-not-the-one-the-challenge-was-made-from",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        environment: env,
        http: None,
    })
    .await
    .unwrap_err();
    assert_eq!(e.code(), Some("invalid_grant"));
}

#[tokio::test]
async fn a_denied_sign_in_comes_back_as_an_error() {
    let fake = FakeBox::start().await;
    let env = fake.environment();
    let req = begin_authorization(CLIENT_ID, REDIRECT, &["files:app"], &env).unwrap();
    let cb = parse_callback(&fake.deny(&req.url), &env).unwrap();
    assert_eq!(cb.error.as_deref(), Some("access_denied"));
    assert_eq!(cb.code, None);
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn an_older_box_gives_a_token_that_never_expires_and_is_never_refreshed() {
    let fake = FakeBox::start_with(FakeBoxConfig {
        old_box: true,
        ..Default::default()
    })
    .await;
    let env = fake.environment();
    let req =
        begin_authorization(CLIENT_ID, REDIRECT, &["files:read", "files:write"], &env).unwrap();
    let cb = parse_callback(&fake.approve(&req.url), &env).unwrap();
    let tokens = exchange_code(ExchangeCode {
        iss: cb.iss.as_deref().unwrap(),
        code: cb.code.as_deref().unwrap(),
        state: cb.state.as_deref(),
        expected_state: &req.state,
        code_verifier: &req.code_verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        environment: env.clone(),
        http: None,
    })
    .await
    .unwrap();
    assert_eq!(tokens.refresh_token, None);
    assert_eq!(tokens.expires_at, None);
    assert_eq!(tokens.app_folder, None);
    assert_eq!(tokens.scope, "files:read files:write");

    let auth_errors = Arc::new(AtomicUsize::new(0));
    let rotated = Arc::new(AtomicUsize::new(0));
    let client = PlumClient::builder(fake.url())
        .environment(env)
        .client_id(CLIENT_ID)
        .tokens(tokens)
        .on_auth_error({
            let n = auth_errors.clone();
            move |_| {
                n.fetch_add(1, Ordering::SeqCst);
            }
        })
        .on_tokens({
            let n = rotated.clone();
            move |_: &plumbox_client::OAuthTokens| {
                n.fetch_add(1, Ordering::SeqCst);
            }
        })
        .build()
        .unwrap();
    fake.put_file("/notes/a.md", "hello");
    assert_eq!(
        client.drive().download("/notes/a.md").await.unwrap(),
        b"hello"
    );

    // The user revokes it: a 401 the client cannot cure — no refresh tried.
    fake.revoke_all();
    let e = client
        .drive()
        .list("/notes", &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_auth(), "{e}");
    let e = client
        .drive()
        .list("/notes", &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_auth(), "{e}");
    assert_eq!(fake.refresh_count(), 0);
    assert_eq!(auth_errors.load(Ordering::SeqCst), 1, "once per credential");
    assert_eq!(rotated.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn refresh_tokens_posts_the_json_grant_to_the_iss_and_rotates() {
    let fake = FakeBox::start().await;
    let env = fake.environment();
    let t = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let first = t.refresh_token.clone().unwrap();
    let next = refresh_tokens(fake.url(), CLIENT_ID, &first, &env, None)
        .await
        .unwrap();
    assert_ne!(next.access_token, t.access_token);
    let second = next.refresh_token.clone().unwrap();
    assert_ne!(second, first, "the refresh token rotates");
    assert_eq!(next.app_folder.as_deref(), Some("/Apps/Test App"));
    assert!(next.expires_at.unwrap() > plumbox_now() + 3_500_000);

    let sent = fake.requests_to("/api/oauth/token");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].host.as_deref(),
        Some(fake.url().trim_start_matches("http://"))
    );
    // JSON, exactly as oauth.ts sends it (oauth.test.ts checks the same).
    assert_eq!(sent[0].content_type.as_deref(), Some("application/json"));
    let body: serde_json::Value = serde_json::from_slice(&sent[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": first,
            "client_id": CLIENT_ID,
        })
    );

    // The one just replaced still works for a repeat inside the grace…
    let repeat = refresh_tokens(fake.url(), CLIENT_ID, &first, &env, None)
        .await
        .unwrap();
    assert!(repeat.refresh_token.is_some());
    // …and another client's id never does.
    let e = refresh_tokens(
        fake.url(),
        "com.other:app",
        &repeat.refresh_token.unwrap(),
        &env,
        None,
    )
    .await
    .unwrap_err();
    assert!(e.is_invalid_grant(), "{e}");
}

#[tokio::test]
async fn a_refresh_token_reused_after_the_grace_ends_the_connection() {
    let fake = FakeBox::start_with(FakeBoxConfig {
        refresh_grace: std::time::Duration::ZERO,
        ..Default::default()
    })
    .await;
    let env = fake.environment();
    let t = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let old = t.refresh_token.unwrap();
    let next = refresh_tokens(fake.url(), CLIENT_ID, &old, &env, None)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let e = refresh_tokens(fake.url(), CLIENT_ID, &old, &env, None)
        .await
        .unwrap_err();
    assert!(e.is_invalid_grant(), "{e}");
    assert!(matches!(&e, Error::Auth { status: 400, .. }));
    // Two parties held it: the whole connection is gone, the newest token too.
    let e = refresh_tokens(
        fake.url(),
        CLIENT_ID,
        &next.refresh_token.unwrap(),
        &env,
        None,
    )
    .await
    .unwrap_err();
    assert!(e.is_invalid_grant(), "{e}");
}

#[tokio::test]
async fn refresh_tokens_errors() {
    let fake = FakeBox::start().await;
    let env = fake.environment();
    let t = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let rt = t.refresh_token.unwrap();

    // Not an issuer, or nothing to send: nothing is sent.
    let http = recording_http(&fake);
    for iss in [
        "https://pb-x-lan.plumbox.me",
        "https://pb-x.staging.plumbox.me",
        "http://127.0.0.1:1",
    ] {
        let e = refresh_tokens(iss, CLIENT_ID, &rt, &Environment::Production, Some(&http))
            .await
            .unwrap_err();
        assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidIss), "{iss}");
    }
    for (client_id, token) in [("", rt.as_str()), (CLIENT_ID, "")] {
        let e = refresh_tokens(
            "https://pb-x.plumbox.me",
            client_id,
            token,
            &Environment::Production,
            Some(&http),
        )
        .await
        .unwrap_err();
        assert_eq!(oauth_code(&e), Some(OAuthErrorCode::InvalidRequest));
    }
    assert!(fake.requests().is_empty());

    // Anything but invalid_grant leaves the refresh token good.
    for (status, body) in [
        (500, "boom"),
        (400, r#"{"error":"invalid_request"}"#),
        (503, r#"{"error":"temporarily_unavailable"}"#),
    ] {
        fake.fail_next_refresh(status, body);
        let e = refresh_tokens(fake.url(), CLIENT_ID, &rt, &env, None)
            .await
            .unwrap_err();
        assert!(matches!(&e, Error::Api { .. }), "{status}: {e}");
        assert!(!e.is_auth());
    }
    // A box that answers without a new refresh token leaves the one sent valid.
    fake.fail_next_refresh(200, r#"{"access_token":"plum_pat_2","token_type":"bearer","expires_in":3600,"scope":"files:app"}"#);
    let kept = refresh_tokens(fake.url(), CLIENT_ID, &rt, &env, None)
        .await
        .unwrap();
    assert_eq!(kept.refresh_token.as_deref(), Some(rt.as_str()));
    // A refused one is the end.
    fake.revoke_all();
    let e = refresh_tokens(fake.url(), CLIENT_ID, &rt, &env, None)
        .await
        .unwrap_err();
    assert!(e.is_invalid_grant() && e.status() == Some(400), "{e}");
}
