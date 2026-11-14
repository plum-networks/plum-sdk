//! The Drive against the fake box: paged listing, ranged and resumed
//! downloads, uploads (single-shot, chunked, resumed), folders, and the
//! `files:app` boundary. Mirrors the drive parts of `refresh.test.ts` and
//! `unit.test.ts`, plus the file transfers the TS SDK has no counterpart for.

use std::sync::{Arc, Mutex};

use plumbox_client::testing::{FakeBox, FakeBoxConfig};
use plumbox_client::{
    DownloadOptions, Error, ListOptions, PlumClient, ProgressFn, SortKey, SortOrder, UploadOptions,
};

const CLIENT_ID: &str = "com.example.backup:test";
const FOLDER: &str = "/Apps/Test App";

async fn setup_with(config: FakeBoxConfig, scopes: &[&str]) -> (FakeBox, PlumClient) {
    let fake = FakeBox::start_with(config).await;
    let tokens = fake.issue_tokens(CLIENT_ID, scopes);
    let client = PlumClient::builder(fake.url())
        .environment(fake.environment())
        .client_id(CLIENT_ID)
        .tokens(tokens)
        .build()
        .unwrap();
    (fake, client)
}

async fn setup() -> (FakeBox, PlumClient) {
    setup_with(FakeBoxConfig::default(), &["files:app"]).await
}

/// Bytes that are not all the same, so a misplaced chunk shows.
fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 31 % 251) as u8).collect()
}

type ProgressLog = Arc<Mutex<Vec<(u64, u64)>>>;

fn progress_log() -> (ProgressFn, ProgressLog) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    (
        Arc::new(move |done, total| l.lock().unwrap().push((done, total))),
        log,
    )
}

#[tokio::test]
async fn app_folder_comes_with_the_tokens() {
    let (_fake, client) = setup().await;
    assert_eq!(client.app_folder().as_deref(), Some(FOLDER));
}

#[tokio::test]
async fn list_sends_the_ts_parameters_and_reads_a_page() {
    let (fake, client) = setup().await;
    fake.put_file(&format!("{FOLDER}/b.txt"), "bb");
    fake.put_file(&format!("{FOLDER}/sub/a.txt"), "a");
    let page = client
        .drive()
        .list(
            FOLDER,
            &ListOptions {
                hash: true,
                sort: Some(SortKey::Name),
                order: Some(SortOrder::Desc),
                q: Some("a b".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let r = &fake.requests_to("/api/drive/list")[0];
    assert_eq!(
        r.query,
        "path=%2FApps%2FTest+App&hash=1&q=a+b&sort=name&order=desc&limit=1000&offset=0"
    );
    assert_eq!(page.total, 2);
    let names: Vec<(&str, bool, u64)> = page
        .items
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir, e.size))
        .collect();
    assert_eq!(names, [("b.txt", false, 2), ("sub", true, 0)]);
    let b = &page.items[0];
    assert_eq!(b.path, format!("{FOLDER}/b.txt"));
    // sha256("bb")
    assert_eq!(
        b.hash.as_deref(),
        Some("3b64db95cb55c763391c707108489ae18b4112d783300de38e033b4c98c3deaf")
    );
    let all = client
        .drive()
        .list_all(
            FOLDER,
            &ListOptions {
                recursive: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
}

#[tokio::test]
async fn list_all_walks_every_page() {
    let (fake, client) = setup().await;
    for i in 0..2345 {
        fake.put_file(&format!("{FOLDER}/f{i:05}"), vec![1u8]);
    }
    let all = client
        .drive()
        .list_all(FOLDER, &Default::default())
        .await
        .unwrap();
    assert_eq!(all.len(), 2345);
    assert_eq!(all[0].name, "f00000");
    assert_eq!(all[2344].name, "f02344");
    let offsets: Vec<String> = fake
        .requests_to("/api/drive/list")
        .iter()
        .map(|r| r.param("offset").unwrap())
        .collect();
    assert_eq!(offsets, ["0", "1000", "2000"]);
}

#[tokio::test]
async fn paths_outside_the_app_folder_are_forbidden() {
    let (fake, client) = setup().await;
    fake.put_file("/Photos/x.jpg", "x");
    let d = client.drive();
    assert!(
        d.list("/Photos", &Default::default())
            .await
            .unwrap_err()
            .is_forbidden()
    );
    assert!(
        d.download("/Photos/x.jpg")
            .await
            .unwrap_err()
            .is_forbidden()
    );
    assert!(
        d.upload("/Photos/y.jpg", b"y", &Default::default())
            .await
            .unwrap_err()
            .is_forbidden()
    );
    assert!(
        d.begin_upload("/Photos/y.jpg", 1, &Default::default())
            .await
            .unwrap_err()
            .is_forbidden()
    );
    assert!(d.remove("/Photos/x.jpg").await.unwrap_err().is_forbidden());
    // The folder itself may be listed, not deleted or renamed.
    d.list(FOLDER, &Default::default()).await.unwrap();
    assert!(d.remove(FOLDER).await.unwrap_err().is_forbidden());
    assert!(d.rename(FOLDER, "Other").await.unwrap_err().is_forbidden());
    assert_eq!(fake.file("/Photos/x.jpg").unwrap(), b"x");
    assert_eq!(fake.refresh_count(), 0);
}

#[tokio::test]
async fn ensure_dir_passes_over_the_parents_a_files_app_token_may_not_touch() {
    let (fake, client) = setup().await;
    client
        .drive()
        .ensure_dir(&format!("{FOLDER}/MyVault/notes"))
        .await
        .unwrap();
    let made: Vec<String> = fake
        .requests_to("/api/drive/mkdir")
        .iter()
        .map(|r| {
            let b: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
            format!(
                "{}|{}",
                b["path"].as_str().unwrap(),
                b["name"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        made,
        [
            "/|Apps",
            "/Apps|Test App",
            "/Apps/Test App|MyVault",
            "/Apps/Test App/MyVault|notes"
        ]
    );
    assert!(fake.is_dir(&format!("{FOLDER}/MyVault/notes")));
    // Twice is fine: the folders are there.
    client
        .drive()
        .ensure_dir(&format!("{FOLDER}/MyVault/notes"))
        .await
        .unwrap();
}

#[tokio::test]
async fn ensure_dir_still_fails_when_the_folder_itself_is_out_of_bounds() {
    let (fake, client) = setup().await;
    let e = client.drive().ensure_dir("/Photos/2026").await.unwrap_err();
    assert!(matches!(e, Error::Forbidden { .. }), "{e}");
    assert!(!fake.is_dir("/Photos/2026"));
}

#[tokio::test]
async fn rename_move_and_remove() {
    let (fake, client) = setup().await;
    let d = client.drive();
    fake.put_file(&format!("{FOLDER}/a.txt"), "A");
    d.mkdir(&format!("{FOLDER}/archive")).await.unwrap();
    d.rename(&format!("{FOLDER}/a.txt"), "b.txt").await.unwrap();
    assert_eq!(fake.file(&format!("{FOLDER}/b.txt")).unwrap(), b"A");
    d.move_to(
        &format!("{FOLDER}/b.txt"),
        &format!("{FOLDER}/archive/b.txt"),
    )
    .await
    .unwrap();
    let moved = &fake.requests_to("/api/drive/move")[0];
    let body: serde_json::Value = serde_json::from_slice(&moved.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "path": format!("{FOLDER}/b.txt"), "newPath": format!("{FOLDER}/archive/b.txt") })
    );
    assert_eq!(fake.file(&format!("{FOLDER}/archive/b.txt")).unwrap(), b"A");
    d.remove(&format!("{FOLDER}/archive/b.txt")).await.unwrap();
    assert_eq!(fake.file(&format!("{FOLDER}/archive/b.txt")), None);
    assert_eq!(fake.trash(), [format!("{FOLDER}/archive/b.txt")]);
    let e = d
        .remove(&format!("{FOLDER}/archive/b.txt"))
        .await
        .unwrap_err();
    assert!(e.is_not_found(), "{e}");
    let del = fake.requests_to("/api/drive/delete");
    assert_eq!(del[0].method, "DELETE");
    assert_eq!(
        del[0].param("path").unwrap(),
        format!("{FOLDER}/archive/b.txt")
    );
}

#[tokio::test]
async fn a_small_upload_is_one_multipart_post_and_overwrite_replaces() {
    let (fake, client) = setup().await;
    let d = client.drive();
    let (progress, log) = progress_log();
    let path = format!("{FOLDER}/notes/a.md");
    let e = d
        .upload(
            &path,
            b"# one",
            &UploadOptions {
                on_progress: Some(progress.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (e.path.as_str(), e.name.as_str(), e.size, e.is_dir),
        (path.as_str(), "a.md", 5, false)
    );
    assert_eq!(fake.file(&path).unwrap(), b"# one");
    assert_eq!(*log.lock().unwrap(), [(5, 5)]);
    let up = &fake.requests_to("/api/drive/upload")[0];
    assert!(
        up.content_type
            .as_deref()
            .unwrap()
            .starts_with("multipart/form-data; boundary=")
    );
    assert!(fake.requests_to("/api/uploads/init").is_empty());

    // Without overwrite a name collision makes "a (2).md"…
    let second = d
        .upload(&path, b"# two", &Default::default())
        .await
        .unwrap();
    assert_eq!(second.path, format!("{FOLDER}/notes/a (2).md"));
    assert_eq!(fake.file(&path).unwrap(), b"# one");
    // …with it, the file is replaced in place.
    let third = d
        .upload(
            &path,
            b"# three",
            &UploadOptions {
                overwrite: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(third.path, path);
    assert_eq!(fake.file(&path).unwrap(), b"# three");

    let e = d.upload("/", b"x", &Default::default()).await.unwrap_err();
    assert!(matches!(e, Error::InvalidInput(_)), "{e}");
}

#[tokio::test]
async fn after_a_refresh_an_upload_body_goes_out_byte_for_byte_again() {
    let (fake, client) = setup().await;
    fake.expire_access_tokens();
    client
        .drive()
        .upload(
            &format!("{FOLDER}/a.md"),
            b"hello",
            &UploadOptions {
                overwrite: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let ups = fake.requests_to("/api/drive/upload");
    assert_eq!(ups.len(), 2);
    assert_eq!(ups[0].body, ups[1].body);
    assert_eq!(ups[0].content_type, ups[1].content_type);
    assert_ne!(ups[0].authorization, ups[1].authorization);
    assert_eq!(fake.refresh_count(), 1);
}

#[tokio::test]
async fn a_big_file_goes_through_the_chunked_protocol() {
    let (fake, client) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("big.bin");
    let data = pattern(9 * 1024 * 1024 + 123);
    std::fs::write(&local, &data).unwrap();
    fake.put_file(&format!("{FOLDER}/big.bin"), "old");
    let (progress, log) = progress_log();
    let entry = client
        .drive()
        .upload_file(
            &format!("{FOLDER}/big.bin"),
            &local,
            &UploadOptions {
                overwrite: true,
                on_progress: Some(progress),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(entry.path, format!("{FOLDER}/big.bin"));
    assert_eq!(entry.size, data.len() as u64);
    assert_eq!(fake.file(&format!("{FOLDER}/big.bin")).unwrap(), data);
    assert!(fake.requests_to("/api/drive/upload").is_empty());

    let init = &fake.requests_to("/api/uploads/init")[0];
    let body: serde_json::Value = serde_json::from_slice(&init.body).unwrap();
    assert_eq!(body["target"], "drive");
    assert_eq!(body["path"], FOLDER);
    assert_eq!(body["filename"], "big.bin");
    assert_eq!(body["size"], data.len() as u64);
    assert_eq!(body["overwrite"], true);
    // 4 MiB chunks, as the box named.
    let total = data.len() as u64;
    let ranges: Vec<String> = fake
        .requests()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(|r| r.content_range.clone().unwrap())
        .collect();
    let mib4 = 4 * 1024 * 1024u64;
    assert_eq!(
        ranges,
        [
            format!("bytes 0-{}/{total}", mib4 - 1),
            format!("bytes {mib4}-{}/{total}", 2 * mib4 - 1),
            format!("bytes {}-{}/{total}", 2 * mib4, total - 1),
        ]
    );
    assert_eq!(
        *log.lock().unwrap(),
        [(mib4, total), (2 * mib4, total), (total, total)]
    );

    // The same from memory, without overwrite: a new name.
    let again = client
        .drive()
        .upload(&format!("{FOLDER}/big.bin"), &data, &Default::default())
        .await
        .unwrap();
    assert_eq!(again.path, format!("{FOLDER}/big (2).bin"));
    assert_eq!(fake.file(&again.path).unwrap(), data);
}

#[tokio::test]
async fn a_chunked_upload_resumes_from_the_box_count_after_a_failure() {
    let (fake, client) = setup_with(
        FakeBoxConfig {
            chunk_size: 1000,
            ..Default::default()
        },
        &["files:app"],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("history.sealed");
    let data = pattern(4500);
    std::fs::write(&local, &data).unwrap();
    let d = client.drive();
    let path = format!("{FOLDER}/backups/history.sealed");

    let session = d
        .begin_upload(&path, data.len() as u64, &Default::default())
        .await
        .unwrap();
    assert_eq!(session.chunk_size, 1000);
    // The app keeps the session across a restart.
    let session: plumbox_client::UploadSession =
        serde_json::from_str(&serde_json::to_string(&session).unwrap()).unwrap();

    fake.fail_upload_chunk_after(2);
    let e = d
        .resume_upload(&session, &local, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Api { status: 500, .. }), "{e}");
    assert_eq!(fake.file(&path), None);

    let entry = d
        .resume_upload(&session, &local, &Default::default())
        .await
        .unwrap();
    assert_eq!(entry.path, path);
    assert_eq!(fake.file(&path).unwrap(), data);
    let starts: Vec<String> = fake
        .requests()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(|r| r.content_range.clone().unwrap())
        .collect();
    assert_eq!(
        starts,
        [
            "bytes 0-999/4500",
            "bytes 1000-1999/4500",
            "bytes 2000-2999/4500", // refused: the connection broke
            "bytes 2000-2999/4500", // the second call asks the box, goes on from 2000
            "bytes 3000-3999/4500",
            "bytes 4000-4499/4500",
        ]
    );
    let status_checks = fake
        .requests()
        .iter()
        .filter(|r| r.method == "GET" && r.path.starts_with("/api/uploads/"))
        .count();
    assert_eq!(status_checks, 2);

    // Finished: resuming again just says so.
    let done = d
        .resume_upload(&session, &local, &Default::default())
        .await
        .unwrap();
    assert_eq!(done.path, path);
    assert_eq!(
        fake.requests()
            .iter()
            .filter(|r| r.method == "PATCH")
            .count(),
        6
    );
}

#[tokio::test]
async fn a_cancelled_upload_cannot_be_resumed() {
    let (fake, client) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("x.bin");
    std::fs::write(&local, b"xyz").unwrap();
    let d = client.drive();
    let s = d
        .begin_upload(&format!("{FOLDER}/x.bin"), 3, &Default::default())
        .await
        .unwrap();
    d.cancel_upload(&s).await.unwrap();
    let e = d
        .resume_upload(&s, &local, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Api { status: 410, .. }), "{e}");
    assert_eq!(e.code(), Some("session_aborted"));
    // A local file of another size than the session's is refused before sending.
    let s = d
        .begin_upload(&format!("{FOLDER}/x.bin"), 4, &Default::default())
        .await
        .unwrap();
    let e = d
        .resume_upload(&s, &local, &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::InvalidInput(_)), "{e}");
    assert_eq!(fake.file(&format!("{FOLDER}/x.bin")), None);
}

#[tokio::test]
async fn download_into_memory_and_to_a_file() {
    let (fake, client) = setup().await;
    let data = pattern(100_000);
    let path = format!("{FOLDER}/a b+c.bin");
    fake.put_file(&path, data.clone());
    assert_eq!(client.drive().download(&path).await.unwrap(), data);
    assert_eq!(
        fake.requests_to("/api/drive/download")[0]
            .param("path")
            .unwrap(),
        path
    );

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.bin");
    let (progress, log) = progress_log();
    let n = client
        .drive()
        .download_to_file(
            &path,
            &dest,
            &DownloadOptions {
                on_progress: Some(progress),
            },
        )
        .await
        .unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert!(!dir.path().join("a.bin.part").exists());
    assert_eq!(
        log.lock().unwrap().last().copied(),
        Some((100_000, 100_000))
    );
    assert_eq!(fake.requests_to("/api/drive/download")[1].range, None);
}

#[tokio::test]
async fn a_download_resumes_with_a_range_request() {
    let (fake, client) = setup().await;
    let data = pattern(50_000);
    let path = format!("{FOLDER}/history.sealed");
    fake.put_file(&path, data.clone());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("history.sealed");
    // An earlier attempt got 20 000 bytes.
    std::fs::write(dir.path().join("history.sealed.part"), &data[..20_000]).unwrap();
    let (progress, log) = progress_log();
    let n = client
        .drive()
        .download_to_file(
            &path,
            &dest,
            &DownloadOptions {
                on_progress: Some(progress),
            },
        )
        .await
        .unwrap();
    assert_eq!(n, 50_000);
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    let reqs = fake.requests_to("/api/drive/download");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].range.as_deref(), Some("bytes=20000-"));
    assert_eq!(log.lock().unwrap().last().copied(), Some((50_000, 50_000)));
}

#[tokio::test]
async fn a_box_that_ignores_range_sends_the_whole_file_and_the_part_starts_over() {
    let (fake, client) = setup().await;
    fake.ignore_range(true);
    let data = pattern(30_000);
    let path = format!("{FOLDER}/f.bin");
    fake.put_file(&path, data.clone());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.bin");
    std::fs::write(dir.path().join("f.bin.part"), &data[..10_000]).unwrap();
    assert_eq!(
        client
            .drive()
            .download_to_file(&path, &dest, &Default::default())
            .await
            .unwrap(),
        30_000
    );
    assert_eq!(std::fs::read(&dest).unwrap(), data);
}

#[tokio::test]
async fn a_part_past_the_end_starts_over_and_a_whole_part_is_just_kept() {
    let (fake, client) = setup().await;
    let data = pattern(5_000);
    let path = format!("{FOLDER}/f.bin");
    fake.put_file(&path, data.clone());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.bin");
    let part = dir.path().join("f.bin.part");

    // Longer than the file (it changed on the box): 416, then from 0.
    std::fs::write(&part, pattern(9_000)).unwrap();
    assert_eq!(
        client
            .drive()
            .download_to_file(&path, &dest, &Default::default())
            .await
            .unwrap(),
        5_000
    );
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    let ranges: Vec<Option<String>> = fake
        .requests_to("/api/drive/download")
        .iter()
        .map(|r| r.range.clone())
        .collect();
    assert_eq!(ranges, [Some("bytes=9000-".to_owned()), None]);

    // Every byte already there (stopped before the rename): kept as it is.
    std::fs::remove_file(&dest).unwrap();
    std::fs::write(&part, &data).unwrap();
    assert_eq!(
        client
            .drive()
            .download_to_file(&path, &dest, &Default::default())
            .await
            .unwrap(),
        5_000
    );
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert_eq!(fake.requests_to("/api/drive/download").len(), 3);
}

#[tokio::test]
async fn a_missing_file_is_not_found() {
    let (_fake, client) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let e = client
        .drive()
        .download_to_file(
            &format!("{FOLDER}/nope"),
            &dir.path().join("x"),
            &Default::default(),
        )
        .await
        .unwrap_err();
    assert!(e.is_not_found(), "{e}");
    let e = client
        .drive()
        .list(&format!("{FOLDER}/nope"), &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_not_found(), "{e}");
}

#[tokio::test]
async fn a_whole_drive_token_reaches_everywhere_it_may() {
    let (fake, client) = setup_with(FakeBoxConfig::default(), &["files:read"]).await;
    assert_eq!(client.app_folder(), None);
    fake.put_file("/Photos/x.jpg", "x");
    assert_eq!(
        client.drive().download("/Photos/x.jpg").await.unwrap(),
        b"x"
    );
    // files:read cannot write.
    let e = client
        .drive()
        .upload("/Photos/y.jpg", b"y", &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_forbidden(), "{e}");
}
