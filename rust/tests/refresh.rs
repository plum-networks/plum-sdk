//! PlumClient keeping an OAuth connection alive: hourly access tokens,
//! rotating refresh tokens, one refresh for many requests, and telling
//! "signed out" (401 / invalid_grant) from "not allowed" (403). Mirrors
//! `packages/client/test/refresh.test.ts`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use plumbox_client::testing::{FakeBox, FakeBoxConfig};
use plumbox_client::{Error, OAuthTokens, PlumClient, PlumClientBuilder};

const CLIENT_ID: &str = "com.example.sync:test";

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// What the callbacks saw.
#[derive(Default)]
struct Seen {
    rotated: Mutex<Vec<OAuthTokens>>,
    auth_errors: Mutex<Vec<Error>>,
}

impl Seen {
    fn rotated(&self) -> Vec<OAuthTokens> {
        self.rotated.lock().unwrap().clone()
    }
    fn auth_errors(&self) -> Vec<Error> {
        self.auth_errors.lock().unwrap().clone()
    }
}

fn builder(fake: &FakeBox, tokens: OAuthTokens, seen: &Arc<Seen>) -> PlumClientBuilder {
    let (a, b) = (seen.clone(), seen.clone());
    PlumClient::builder(fake.url())
        .environment(fake.environment())
        .client_id(CLIENT_ID)
        .tokens(tokens)
        .on_tokens(move |t: &OAuthTokens| a.rotated.lock().unwrap().push(t.clone()))
        .on_auth_error(move |e| b.auth_errors.lock().unwrap().push(e.clone()))
}

/// A fake box, a files:app connection to it, and a client holding it.
async fn setup() -> (FakeBox, PlumClient, Arc<Seen>, OAuthTokens) {
    let fake = FakeBox::start().await;
    let tokens = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens.clone(), &seen).build().unwrap();
    (fake, client, seen, tokens)
}

fn bearers(fake: &FakeBox, path: &str) -> Vec<String> {
    fake.requests_to(path)
        .iter()
        .map(|r| r.bearer().unwrap_or_default().to_owned())
        .collect()
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..500 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

const FOLDER: &str = "/Apps/Test App";

#[tokio::test]
async fn a_401_refreshes_hands_the_rotated_set_to_the_sink_first_then_retries() {
    let fake = Arc::new(FakeBox::start().await);
    let first = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    // The sink runs before the request that needed the refresh is sent
    // again: at that moment the box has seen exactly one list request.
    let lists_when_rotated = Arc::new(Mutex::new(Vec::new()));
    let (probe, log) = (fake.clone(), lists_when_rotated.clone());
    let seen = Arc::new(Seen::default());
    let errors = seen.clone();
    let client = PlumClient::builder(fake.url())
        .environment(fake.environment())
        .client_id(CLIENT_ID)
        .tokens(first.clone())
        .on_tokens(move |t: &OAuthTokens| {
            log.lock()
                .unwrap()
                .push((probe.requests_to("/api/drive/list").len(), t.clone()));
        })
        .on_auth_error(move |e| errors.auth_errors.lock().unwrap().push(e.clone()))
        .build()
        .unwrap();
    fake.expire_access_tokens();
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();

    assert_eq!(fake.refresh_count(), 1);
    let log = lists_when_rotated.lock().unwrap().clone();
    assert_eq!(log.len(), 1);
    let (lists_before, rotated) = &log[0];
    assert_eq!(*lists_before, 1, "the sink ran before the retry went out");
    assert_ne!(rotated.access_token, first.access_token);
    assert_ne!(rotated.refresh_token, first.refresh_token);
    assert_eq!(rotated.scope, "files:app");
    assert_eq!(rotated.app_folder.as_deref(), Some(FOLDER));
    assert_eq!(rotated.token_type, "bearer");
    assert!(rotated.expires_at.unwrap() > now() + 3_500_000);
    assert_eq!(
        bearers(&fake, "/api/drive/list"),
        vec![first.access_token.clone(), rotated.access_token.clone()]
    );
    assert_eq!(
        client.tokens().unwrap(),
        *rotated,
        "the client holds what the sink got"
    );
    let token_calls = fake.requests_to("/api/oauth/token");
    assert_eq!(token_calls.len(), 1);
    assert_eq!(
        token_calls[0].body_field("refresh_token"),
        first.refresh_token
    );
    assert!(seen.auth_errors().is_empty());
}

#[tokio::test]
async fn refreshes_ahead_of_time_when_less_than_a_minute_is_left() {
    let fake = FakeBox::start().await;
    let tokens = OAuthTokens {
        expires_at: Some(now() + 30_000),
        ..fake.issue_tokens(CLIENT_ID, &["files:app"])
    };
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens.clone(), &seen).build().unwrap();
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    let paths: Vec<String> = fake.requests().iter().map(|r| r.path.clone()).collect();
    assert_eq!(paths, ["/api/oauth/token", "/api/drive/list"]);
    assert_ne!(bearers(&fake, "/api/drive/list")[0], tokens.access_token);
    assert_eq!(seen.rotated().len(), 1);
    // …and not again while the new token is fresh.
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    assert_eq!(fake.refresh_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_requests_that_all_hit_401_share_one_refresh() {
    let (fake, client, seen, first) = setup().await;
    fake.expire_access_tokens();
    let hold = fake.hold_refreshes();
    let tasks: Vec<_> = (0..4)
        .map(|i| {
            let c = client.clone();
            tokio::spawn(async move {
                c.drive()
                    .list(&format!("{FOLDER}/{i}"), &Default::default())
                    .await
            })
        })
        .collect();
    fake.mkdir_all(&format!("{FOLDER}/0"));
    fake.mkdir_all(&format!("{FOLDER}/1"));
    fake.mkdir_all(&format!("{FOLDER}/2"));
    fake.mkdir_all(&format!("{FOLDER}/3"));
    // All four got their 401 and wait on the one refresh the box holds.
    wait_until("four 401s and a refresh", || {
        fake.requests_to("/api/drive/list").len() == 4 && fake.refresh_count() == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    hold.release();
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    // A second refresh would have sent the rotated-away token again — on a
    // real box, after the grace period, that ends the connection.
    assert_eq!(fake.refresh_count(), 1);
    assert_eq!(seen.rotated().len(), 1);
    let new = client.tokens().unwrap().access_token;
    let b = bearers(&fake, "/api/drive/list");
    assert_eq!(b.len(), 8);
    assert_eq!(b.iter().filter(|t| **t == first.access_token).count(), 4);
    assert_eq!(b.iter().filter(|t| **t == new).count(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_that_starts_while_a_refresh_is_under_way_waits_for_it() {
    let (fake, client, _seen, first) = setup().await;
    fake.mkdir_all(&format!("{FOLDER}/one"));
    fake.mkdir_all(&format!("{FOLDER}/two"));
    fake.expire_access_tokens();
    let hold = fake.hold_refreshes();
    let c1 = client.clone();
    let one = tokio::spawn(async move {
        c1.drive()
            .list(&format!("{FOLDER}/one"), &Default::default())
            .await
    });
    wait_until("the refresh", || fake.refresh_count() == 1).await;
    let c2 = client.clone();
    let two = tokio::spawn(async move {
        c2.drive()
            .list(&format!("{FOLDER}/two"), &Default::default())
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    hold.release();
    one.await.unwrap().unwrap();
    two.await.unwrap().unwrap();
    let seconds: Vec<String> = fake
        .requests_to("/api/drive/list")
        .iter()
        .filter(|r| r.param("path").unwrap().ends_with("/two"))
        .map(|r| r.bearer().unwrap().to_owned())
        .collect();
    assert_eq!(seconds.len(), 1, "it never went out with the old token");
    assert_ne!(seconds[0], first.access_token);
    assert_eq!(fake.refresh_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_grant_ends_the_connection_callback_once_every_request_fails_no_more_refreshes() {
    let (fake, client, seen, _) = setup().await;
    fake.expire_access_tokens();
    fake.revoke_all();
    let tasks: Vec<_> = (0..4)
        .map(|i| {
            let c = client.clone();
            tokio::spawn(async move {
                c.drive()
                    .list(&format!("{FOLDER}/{i}"), &Default::default())
                    .await
            })
        })
        .collect();
    for t in tasks {
        let e = t.await.unwrap().unwrap_err();
        assert!(e.is_auth(), "{e}");
        assert!(e.is_invalid_grant() || e.status() == Some(401), "{e}");
    }
    let errors = seen.auth_errors();
    assert_eq!(
        errors.len(),
        1,
        "once, however many requests were in flight"
    );
    assert!(errors[0].is_invalid_grant());
    assert_eq!(errors[0].status(), Some(400));
    assert!(seen.rotated().is_empty());
    assert_eq!(fake.refresh_count(), 1);
    assert_eq!(
        client.tokens().unwrap().refresh_token,
        None,
        "it stops sending a refused refresh token"
    );

    let e = client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_auth());
    assert_eq!(fake.refresh_count(), 1);
    assert_eq!(seen.auth_errors().len(), 1);
}

#[tokio::test]
async fn a_refresh_the_box_could_not_serve_is_not_a_sign_out() {
    let (fake, client, seen, first) = setup().await;
    fake.expire_access_tokens();
    fake.fail_next_refresh(503, r#"{"error":"temporarily_unavailable"}"#);
    let e = client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Api { status: 503, .. }), "{e}");
    assert!(!e.is_auth());
    assert!(seen.auth_errors().is_empty());
    assert_eq!(
        client.tokens().unwrap().refresh_token,
        first.refresh_token,
        "the refresh token is still good"
    );
    // The next request tries again, and gets through.
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    assert_eq!(fake.refresh_count(), 2);
    assert!(seen.auth_errors().is_empty());
}

#[tokio::test]
async fn a_box_that_cannot_be_reached_is_not_a_sign_out() {
    let fake = FakeBox::start().await;
    let tokens = OAuthTokens {
        expires_at: Some(now() + 30_000),
        ..fake.issue_tokens(CLIENT_ID, &["files:app"])
    };
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens.clone(), &seen).build().unwrap();
    drop(fake);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let e = client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Network(_)), "{e}");
    assert!(seen.auth_errors().is_empty());
    assert_eq!(client.tokens().unwrap(), tokens, "nothing was given up");
}

#[tokio::test]
async fn goes_ahead_with_a_token_that_has_a_few_seconds_left_when_an_early_refresh_fails() {
    let fake = FakeBox::start().await;
    let tokens = OAuthTokens {
        expires_at: Some(now() + 20_000),
        ..fake.issue_tokens(CLIENT_ID, &["files:app"])
    };
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens.clone(), &seen).build().unwrap();
    fake.fail_next_refresh(503, r#"{"error":"temporarily_unavailable"}"#);
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    let paths: Vec<String> = fake.requests().iter().map(|r| r.path.clone()).collect();
    assert_eq!(paths, ["/api/oauth/token", "/api/drive/list"]);
    assert_eq!(bearers(&fake, "/api/drive/list"), vec![tokens.access_token]);
}

#[tokio::test]
async fn refreshes_only_once_per_request_a_401_after_a_good_refresh_is_the_end() {
    // Every token this box issues is dead on arrival.
    let fake = FakeBox::start_with(FakeBoxConfig {
        expires_in: 0,
        ..Default::default()
    })
    .await;
    let tokens = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    assert_eq!(tokens.expires_at, None, "expires_in 0 is no known expiry");
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens, &seen).build().unwrap();
    let e = client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Auth { status: 401, .. }), "{e}");
    assert_eq!(fake.refresh_count(), 1);
    assert_eq!(fake.requests_to("/api/drive/list").len(), 2);
    assert_eq!(seen.auth_errors().len(), 1);
}

#[tokio::test]
async fn a_403_is_not_a_reason_to_refresh_or_to_sign_out() {
    let (fake, client, seen, _) = setup().await;
    fake.mkdir_all("/Photos");
    let e = client
        .drive()
        .list("/Photos", &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Forbidden { status: 403, .. }), "{e}");
    assert!(e.is_forbidden() && !e.is_auth());
    assert_eq!(fake.refresh_count(), 0);
    assert!(seen.auth_errors().is_empty());
}

#[tokio::test]
async fn keeps_the_app_folder_when_a_refresh_does_not_repeat_it() {
    let fake = FakeBox::start().await;
    // A connection whose refresh answers carry no app_folder.
    let tokens = OAuthTokens {
        app_folder: Some(FOLDER.into()),
        ..fake.issue_tokens(CLIENT_ID, &["files:read"])
    };
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, tokens, &seen).build().unwrap();
    assert_eq!(client.app_folder().as_deref(), Some(FOLDER));
    fake.mkdir_all(FOLDER);
    fake.expire_access_tokens();
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    assert_eq!(seen.rotated()[0].app_folder.as_deref(), Some(FOLDER));
    assert_eq!(seen.rotated()[0].scope, "files:read");
    assert_eq!(client.app_folder().as_deref(), Some(FOLDER));
}

#[tokio::test]
async fn a_refresh_token_alone_refreshes_before_the_first_request() {
    let fake = FakeBox::start().await;
    let t = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let only_refresh = OAuthTokens {
        refresh_token: t.refresh_token,
        ..OAuthTokens::bearer("")
    };
    let client = builder(&fake, only_refresh, &Arc::new(Seen::default()))
        .build()
        .unwrap();
    let res = client
        .request(reqwest::Method::GET, "/api/auth/me", None)
        .await
        .unwrap();
    let me: serde_json::Value = serde_json::from_slice(&res.bytes().await.unwrap()).unwrap();
    assert_eq!(me["user"]["id"], "u1");
    let paths: Vec<String> = fake.requests().iter().map(|r| r.path.clone()).collect();
    assert_eq!(paths, ["/api/oauth/token", "/api/auth/me"]);
}

#[tokio::test]
async fn refresh_refreshes_now_and_shares_a_refresh_in_flight() {
    let (fake, client, seen, first) = setup().await;
    let (a, b) = tokio::join!(client.refresh(), client.refresh());
    a.unwrap();
    b.unwrap();
    assert_eq!(fake.refresh_count(), 1);
    assert_eq!(seen.rotated().len(), 1);
    assert_ne!(client.tokens().unwrap().refresh_token, first.refresh_token);
    // One after the other: two refreshes, each with the newest token.
    client.refresh().await.unwrap();
    assert_eq!(fake.refresh_count(), 2);
    let sent: Vec<Option<String>> = fake
        .requests_to("/api/oauth/token")
        .iter()
        .map(|r| r.body_field("refresh_token"))
        .collect();
    assert_eq!(sent[0], first.refresh_token);
    assert_eq!(sent[1], seen.rotated()[0].refresh_token);

    let pat_only = PlumClient::builder(fake.url())
        .environment(fake.environment())
        .token("plum_pat_x")
        .build()
        .unwrap();
    let e = pat_only.refresh().await.unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(m) if m.contains("no refresh token")),
        "{e}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drops_a_refresh_result_when_the_tokens_were_replaced_meanwhile() {
    let (fake, client, seen, _) = setup().await;
    let other = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let replacement = OAuthTokens::bearer(other.access_token.clone());
    let hold = fake.hold_refreshes();
    let c = client.clone();
    let refreshing = tokio::spawn(async move { c.refresh().await });
    wait_until("the refresh", || fake.refresh_count() == 1).await;
    client.set_tokens(replacement.clone()).unwrap();
    hold.release();
    refreshing.await.unwrap().unwrap();
    assert!(seen.rotated().is_empty());
    assert_eq!(client.tokens().unwrap().access_token, other.access_token);
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    assert_eq!(bearers(&fake, "/api/drive/list"), vec![other.access_token]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adopts_the_result_when_storage_hands_back_the_very_set_the_refresh_rotated_away() {
    let (fake, client, seen, first) = setup().await;
    let hold = fake.hold_refreshes();
    let c = client.clone();
    let refreshing = tokio::spawn(async move { c.refresh().await });
    wait_until("the refresh", || fake.refresh_count() == 1).await;
    client.set_tokens(first.clone()).unwrap();
    hold.release();
    refreshing.await.unwrap().unwrap();
    assert_eq!(seen.rotated().len(), 1);
    assert_ne!(client.tokens().unwrap().access_token, first.access_token);
}

#[tokio::test]
async fn refreshes_at_the_iss_not_at_a_lan_base_url() {
    let fake = FakeBox::start().await;
    let tokens = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    // The same box under another name, standing in for its LAN address.
    let port = fake.url().rsplit(':').next().unwrap().to_owned();
    let lan = format!("http://localhost:{port}");
    let client = PlumClient::builder(&lan)
        .iss(fake.url())
        .environment(fake.environment())
        .client_id(CLIENT_ID)
        .tokens(tokens)
        .build()
        .unwrap();
    fake.expire_access_tokens();
    client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap();
    let hosts = |path: &str| -> Vec<String> {
        fake.requests_to(path)
            .iter()
            .map(|r| r.host.clone().unwrap())
            .collect()
    };
    assert_eq!(hosts("/api/oauth/token"), vec![format!("127.0.0.1:{port}")]);
    assert_eq!(
        hosts("/api/drive/list"),
        vec![format!("localhost:{port}"); 2]
    );
    // Without a verified iss, a refresh token is refused up front.
    let e = PlumClient::builder(&lan)
        .environment(fake.environment())
        .client_id(CLIENT_ID)
        .tokens(fake.issue_tokens(CLIENT_ID, &["files:app"]))
        .build()
        .unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(m) if m.contains("verified iss")),
        "{e}"
    );
}

#[tokio::test]
async fn a_bare_token_is_never_refreshed() {
    let fake = FakeBox::start().await;
    let t = fake.issue_tokens(CLIENT_ID, &["files:app"]);
    let seen = Arc::new(Seen::default());
    let client = builder(&fake, OAuthTokens::bearer(t.access_token), &seen)
        .build()
        .unwrap();
    fake.expire_access_tokens();
    let e = client
        .drive()
        .list(FOLDER, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Auth { status: 401, .. }), "{e}");
    assert_eq!(e.code(), Some("invalid_token"));
    assert_eq!(fake.refresh_count(), 0);
    assert_eq!(seen.auth_errors().len(), 1);
}
