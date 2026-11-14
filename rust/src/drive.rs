//! The box's Drive (the TS SDK's `drive.ts`), plus file-to-file transfers
//! that resume.

use std::fmt;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::Method;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::client::{Call, PlumClient};
use crate::http::{RequestBody, build_multipart, form_encode, rfc3339_now};
use crate::{Error, Result};

/// Files above this size go through the resumable chunked-upload protocol.
pub const CHUNKED_THRESHOLD: u64 = 8 * 1024 * 1024;
/// The chunk size when the box does not name one.
const DEFAULT_CHUNK_SIZE: u64 = 4 * 1024 * 1024;
/// The largest chunk the SDK holds in memory, whatever the box offers.
const MAX_CHUNK_SIZE: u64 = 32 * 1024 * 1024;
/// The server's `maxListLimit`.
const PAGE_SIZE: u64 = 1000;

/// One entry from [`Drive::list`] / [`Drive::list_all`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveEntry {
    /// The file or folder name.
    pub name: String,
    /// Its absolute drive path.
    pub path: String,
    /// Whether it is a folder.
    #[serde(default)]
    pub is_dir: bool,
    /// Size in bytes (0 for folders).
    #[serde(default)]
    pub size: u64,
    /// RFC 3339 timestamp as reported by the box.
    #[serde(default)]
    pub mod_time: String,
    /// SHA-256 of the content, hex — present only when asked for with
    /// [`ListOptions::hash`] AND the box has indexed the file (files
    /// uploaded before hash indexing omit it; fall back to size + mod_time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// One page of [`Drive::list`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListPage {
    /// The entries on this page.
    #[serde(default)]
    pub items: Vec<DriveEntry>,
    /// Entries in all pages.
    #[serde(default)]
    pub total: u64,
    /// The page size asked for.
    #[serde(default)]
    pub limit: u64,
    /// Where this page starts.
    #[serde(default)]
    pub offset: u64,
}

/// What [`ListOptions::sort`] sorts by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    /// `name`
    Name,
    /// `size`
    Size,
    /// `modified`
    Modified,
    /// `type`
    Type,
    /// `path`
    Path,
}

impl SortKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::Name => "name",
            Self::Size => "size",
            Self::Modified => "modified",
            Self::Type => "type",
            Self::Path => "path",
        }
    }
}

/// [`ListOptions::order`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortOrder {
    /// `asc`
    Asc,
    /// `desc`
    Desc,
}

/// Options for [`Drive::list`] (the TS `ListOptions`).
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    /// Include every descendant (flat), not just direct children.
    pub recursive: bool,
    /// Include indexed SHA-256 content hashes.
    pub hash: bool,
    /// Server-side filename/path search.
    pub q: Option<String>,
    /// Page size (default and maximum 1000). [`Drive::list_all`] ignores it.
    pub limit: Option<u64>,
    /// Where the page starts (default 0). [`Drive::list_all`] ignores it.
    pub offset: Option<u64>,
    /// Sort key.
    pub sort: Option<SortKey>,
    /// Sort order.
    pub order: Option<SortOrder>,
}

/// Progress: `(bytes done, bytes in all)`. For a download whose size the box
/// did not say, the second number is 0.
pub type ProgressFn = Arc<dyn Fn(u64, u64) + Send + Sync>;

/// Options for uploads (the TS `UploadOptions`).
#[derive(Clone, Default)]
pub struct UploadOptions {
    /// Replace the file at the exact name (the box keeps the previous
    /// content as a version). Without it, a name collision creates
    /// `name (2).ext` — NOT what a sync client wants.
    pub overwrite: bool,
    /// The content type (default `application/octet-stream`).
    pub content_type: Option<String>,
    /// Called after each chunk (once, for a small file).
    pub on_progress: Option<ProgressFn>,
}

impl fmt::Debug for UploadOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UploadOptions")
            .field("overwrite", &self.overwrite)
            .field("content_type", &self.content_type)
            .field("on_progress", &self.on_progress.as_ref().map(|_| "Fn"))
            .finish()
    }
}

/// Options for [`Drive::download_to_file`].
#[derive(Clone, Default)]
pub struct DownloadOptions {
    /// Called as bytes arrive (counting what an earlier attempt left).
    pub on_progress: Option<ProgressFn>,
}

impl fmt::Debug for DownloadOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DownloadOptions")
            .field("on_progress", &self.on_progress.as_ref().map(|_| "Fn"))
            .finish()
    }
}

/// A chunked upload the box has opened ([`Drive::begin_upload`]). Keep it
/// (it serializes) to go on after a failure or a restart with
/// [`Drive::resume_upload`]; the box keeps what it received until the
/// session expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadSession {
    /// The box's id for the upload.
    pub upload_id: String,
    /// The folder the file goes into.
    pub dir: String,
    /// The file name.
    pub name: String,
    /// The file's size in bytes.
    pub size: u64,
    /// The chunk size the box asked for.
    pub chunk_size: u64,
}

impl UploadSession {
    fn path(&self) -> String {
        join(&self.dir, &self.name)
    }
}

fn dirname(path: &str) -> String {
    let norm = format!("/{}", path.trim_start_matches('/').trim_end_matches('/'));
    match norm.rfind('/') {
        Some(i) if i > 0 => norm[..i].to_owned(),
        _ => "/".to_owned(),
    }
}

fn basename(path: &str) -> &str {
    let norm = path.trim_end_matches('/');
    &norm[norm.rfind('/').map_or(0, |i| i + 1)..]
}

fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// A path segment for a URL (the TS `encodeURIComponent`).
fn segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

async fn read_json<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status().as_u16();
    let bytes = res.bytes().await?;
    serde_json::from_slice(&bytes).map_err(|e| Error::Api {
        status,
        code: Some("invalid_response".into()),
        message: format!("the box's answer could not be read: {e}"),
    })
}

/// What the box answers when a file lands (`{status, path, name}`).
#[derive(Deserialize, Default)]
struct Placed {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkAnswer {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    received_bytes: Option<u64>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Where chunked-upload bytes come from.
enum Source<'a> {
    Memory(&'a [u8]),
    File(tokio::fs::File),
}

impl Source<'_> {
    async fn read(&mut self, start: u64, end: u64) -> Result<Vec<u8>> {
        match self {
            Self::Memory(data) => Ok(data[start as usize..end as usize].to_vec()),
            Self::File(f) => {
                let mut buf = vec![0u8; (end - start) as usize];
                f.seek(SeekFrom::Start(start)).await?;
                f.read_exact(&mut buf).await?;
                Ok(buf)
            }
        }
    }
}

/// The box's Drive: [`PlumClient::drive`]. Paths are absolute drive paths
/// (`/Apps/My App/notes/a.md`); a `files:app` token reaches only paths
/// inside [`PlumClient::app_folder`] and gets [`Error::Forbidden`] anywhere
/// else.
#[derive(Clone, Debug)]
pub struct Drive {
    client: PlumClient,
}

impl Drive {
    pub(crate) fn new(client: PlumClient) -> Self {
        Self { client }
    }

    /// The client this drive belongs to.
    pub fn client(&self) -> &PlumClient {
        &self.client
    }

    /// List one page of `path` (`GET /api/drive/list`). See
    /// [`list_all`](Self::list_all) for every page.
    pub async fn list(&self, path: &str, opts: &ListOptions) -> Result<ListPage> {
        let path = if path.is_empty() { "/" } else { path };
        let limit = opts.limit.unwrap_or(PAGE_SIZE).to_string();
        let offset = opts.offset.unwrap_or(0).to_string();
        let mut params = vec![("path", path)];
        if opts.recursive {
            params.push(("recursive", "1"));
        }
        if opts.hash {
            params.push(("hash", "1"));
        }
        if let Some(q) = &opts.q {
            params.push(("q", q));
        }
        if let Some(s) = opts.sort {
            params.push(("sort", s.as_str()));
        }
        if let Some(o) = opts.order {
            params.push((
                "order",
                match o {
                    SortOrder::Asc => "asc",
                    SortOrder::Desc => "desc",
                },
            ));
        }
        // Always paginate so the answer's shape is stable ({items,total,…}).
        params.push(("limit", &limit));
        params.push(("offset", &offset));
        let call = Call::new(
            Method::GET,
            format!("/api/drive/list?{}", form_encode(params)),
        );
        read_json(self.client.execute(&call).await?).await
    }

    /// Every entry under `path`, walking the pages (the TS `listAll`).
    /// `opts.limit` and `opts.offset` are ignored.
    pub async fn list_all(&self, path: &str, opts: &ListOptions) -> Result<Vec<DriveEntry>> {
        let mut out = Vec::new();
        let mut offset = 0;
        loop {
            let page_opts = ListOptions {
                limit: Some(PAGE_SIZE),
                offset: Some(offset),
                ..opts.clone()
            };
            let page = self.list(path, &page_opts).await?;
            let n = page.items.len() as u64;
            out.extend(page.items);
            offset += n;
            if n == 0 || offset >= page.total {
                return Ok(out);
            }
        }
    }

    /// The whole file at `path`, in memory (`GET /api/drive/download`). For
    /// big files use [`download_to_file`](Self::download_to_file).
    pub async fn download(&self, path: &str) -> Result<Vec<u8>> {
        let call = Call::new(
            Method::GET,
            format!("/api/drive/download?{}", form_encode([("path", path)])),
        );
        let res = self.client.execute(&call).await?;
        Ok(res.bytes().await?.to_vec())
    }

    /// Download the file at `path` into `dest`, resuming where an earlier
    /// attempt stopped.
    ///
    /// Bytes go to `dest` + `.part` first; a `.part` already there is
    /// continued with an HTTP `Range` request (`bytes=<have>-`). A box that
    /// answers the whole file instead (200) starts the `.part` over; a `206`
    /// that does not start where asked, or a `416`, does too. When every byte
    /// is there the `.part` is renamed to `dest`. Returns the file's size.
    ///
    /// If the file on the box may have changed since the `.part` was
    /// started, delete the `.part` first: the range request cannot tell.
    pub async fn download_to_file(
        &self,
        path: &str,
        dest: &Path,
        opts: &DownloadOptions,
    ) -> Result<u64> {
        let part = part_path(dest);
        // Two passes at most: the second starts from nothing.
        for _ in 0..2 {
            let have = tokio::fs::metadata(&part)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            let mut call = Call::new(
                Method::GET,
                format!("/api/drive/download?{}", form_encode([("path", path)])),
            );
            if have > 0 {
                call = call
                    .header(RANGE, format!("bytes={have}-"))
                    .allow(&[200, 206, 416]);
            }
            let mut res = self.client.execute(&call).await?;
            let range = res
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .map(parse_content_range);
            let (append, total) = match res.status().as_u16() {
                416 => {
                    // Nothing past `have`: the .part may already be whole.
                    if let Some(Some((None, size))) = range
                        && size == Some(have)
                    {
                        tokio::fs::rename(&part, dest).await?;
                        return Ok(have);
                    }
                    remove_if_there(&part).await?;
                    continue;
                }
                206 => match range {
                    Some(Some((Some(start), size))) if start == have => (true, size.unwrap_or(0)),
                    _ => {
                        remove_if_there(&part).await?;
                        continue;
                    }
                },
                _ => (
                    false,
                    res.headers()
                        .get(CONTENT_LENGTH)
                        .and_then(|v| v.to_str().ok()?.parse().ok())
                        .unwrap_or(0),
                ),
            };
            let mut out = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&part)
                .await?;
            let mut done = if append { have } else { 0 };
            while let Some(chunk) = res.chunk().await? {
                out.write_all(&chunk).await?;
                done += chunk.len() as u64;
                if let Some(p) = &opts.on_progress {
                    p(done, total);
                }
            }
            out.flush().await?;
            out.sync_all().await?;
            drop(out);
            tokio::fs::rename(&part, dest).await?;
            return Ok(done);
        }
        Err(Error::Api {
            status: 416,
            code: Some("range_not_satisfiable".into()),
            message: "the box would not serve the file from the start".into(),
        })
    }

    /// Upload `data` as the file at `path` (full drive path including the
    /// file name). Up to 8 MiB it goes as one multipart POST
    /// (`/api/drive/upload`); above, through the resumable chunked protocol
    /// (`/api/uploads/*`). With `overwrite` the file is replaced in place
    /// (the previous content becomes a version) — without it a name
    /// collision creates `name (2).ext`. Returns where the file landed.
    pub async fn upload(
        &self,
        path: &str,
        data: &[u8],
        opts: &UploadOptions,
    ) -> Result<DriveEntry> {
        let (dir, name) = split_upload_path(path)?;
        if data.len() as u64 > CHUNKED_THRESHOLD {
            let session = self.begin(&dir, &name, data.len() as u64, opts).await?;
            return self
                .send_chunks(&session, Source::Memory(data), 0, opts)
                .await;
        }
        let mut fields = vec![("path", dir.as_str())];
        if opts.overwrite {
            fields.push(("overwrite", "1"));
        }
        let content_type = opts
            .content_type
            .as_deref()
            .unwrap_or("application/octet-stream");
        let (body, ct) = build_multipart(&fields, "file", &name, content_type, data)?;
        let call = Call::new(Method::POST, "/api/drive/upload").body(RequestBody::bytes(ct, body));
        let res = self.client.execute(&call).await?;
        let size = data.len() as u64;
        if let Some(p) = &opts.on_progress {
            p(size, size);
        }
        let placed: Placed = read_json(res).await.unwrap_or_default();
        Ok(DriveEntry {
            path: placed.path.unwrap_or_else(|| join(&dir, &name)),
            name: placed.name.unwrap_or(name),
            is_dir: false,
            size,
            mod_time: rfc3339_now(),
            hash: None,
        })
    }

    /// Upload the local file `local` as the file at `path`. Up to 8 MiB it is
    /// read into memory and sent as [`upload`](Self::upload) sends it;
    /// above, it streams through the chunked protocol a chunk at a time,
    /// going on from where the box says it got to if the two disagree. To be
    /// able to resume after a failure or a restart, use
    /// [`begin_upload`](Self::begin_upload) and
    /// [`resume_upload`](Self::resume_upload) instead.
    pub async fn upload_file(
        &self,
        path: &str,
        local: &Path,
        opts: &UploadOptions,
    ) -> Result<DriveEntry> {
        let size = tokio::fs::metadata(local).await?.len();
        if size <= CHUNKED_THRESHOLD {
            let data = tokio::fs::read(local).await?;
            return self.upload(path, &data, opts).await;
        }
        let session = self.begin_upload(path, size, opts).await?;
        let file = tokio::fs::File::open(local).await?;
        self.send_chunks(&session, Source::File(file), 0, opts)
            .await
    }

    /// Open a chunked upload of `size` bytes to `path` (`POST
    /// /api/uploads/init`) and return the session; send the bytes with
    /// [`resume_upload`](Self::resume_upload). Works for any size, also
    /// below the 8 MiB the other uploads switch at. `opts.overwrite` and
    /// `opts.content_type` go to the box here.
    pub async fn begin_upload(
        &self,
        path: &str,
        size: u64,
        opts: &UploadOptions,
    ) -> Result<UploadSession> {
        let (dir, name) = split_upload_path(path)?;
        self.begin(&dir, &name, size, opts).await
    }

    /// Send the local file `local` for `session`, from wherever the box got
    /// to (`GET /api/uploads/<id>`, then `PATCH` per chunk; `POST …/complete`
    /// when every byte was there already). Call it again after a failure: it
    /// goes on from the box's count, never re-sending what arrived. `local`
    /// must still be `session.size` bytes. A session the box has let go
    /// (expired, aborted) is [`Error::Api`] 410 with code `session_<status>`:
    /// begin a new one.
    pub async fn resume_upload(
        &self,
        session: &UploadSession,
        local: &Path,
        opts: &UploadOptions,
    ) -> Result<DriveEntry> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Status {
            #[serde(default)]
            received_bytes: u64,
            #[serde(default)]
            total_bytes: u64,
            #[serde(default)]
            status: String,
        }
        let call = Call::new(
            Method::GET,
            format!("/api/uploads/{}", segment(&session.upload_id)),
        );
        let st: Status = read_json(self.client.execute(&call).await?).await?;
        match st.status.as_str() {
            "active" => {}
            "finalized" => return Ok(entry_for(session, None)),
            other => {
                return Err(Error::Api {
                    status: 410,
                    code: Some(format!("session_{other}")),
                    message: format!("this upload is {other} on the box; begin a new one"),
                });
            }
        }
        if st.total_bytes != session.size {
            return Err(Error::InvalidInput(format!(
                "resume_upload: the box expects {} bytes, the session says {}",
                st.total_bytes, session.size
            )));
        }
        let file = tokio::fs::File::open(local).await?;
        self.send_chunks(session, Source::File(file), st.received_bytes, opts)
            .await
    }

    /// Give up an upload (`DELETE /api/uploads/<id>`): the box drops what it
    /// received.
    pub async fn cancel_upload(&self, session: &UploadSession) -> Result<()> {
        let call = Call::new(
            Method::DELETE,
            format!("/api/uploads/{}", segment(&session.upload_id)),
        );
        self.client.execute(&call).await?;
        Ok(())
    }

    async fn begin(
        &self,
        dir: &str,
        name: &str,
        size: u64,
        opts: &UploadOptions,
    ) -> Result<UploadSession> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Init {
            upload_id: String,
            #[serde(default)]
            chunk_size: u64,
        }
        let body = RequestBody::json(&serde_json::json!({
            "target": "drive",
            "path": dir,
            "filename": name,
            "size": size,
            "contentType": opts.content_type.as_deref().unwrap_or("application/octet-stream"),
            "overwrite": opts.overwrite,
        }))?;
        let call = Call::new(Method::POST, "/api/uploads/init").body(body);
        let init: Init = read_json(self.client.execute(&call).await?).await?;
        Ok(UploadSession {
            upload_id: init.upload_id,
            dir: dir.to_owned(),
            name: name.to_owned(),
            size,
            chunk_size: init.chunk_size,
        })
    }

    async fn send_chunks(
        &self,
        session: &UploadSession,
        mut source: Source<'_>,
        mut at: u64,
        opts: &UploadOptions,
    ) -> Result<DriveEntry> {
        let size = session.size;
        if let Source::File(f) = &source {
            let len = f.metadata().await?.len();
            if len != size {
                return Err(Error::InvalidInput(format!(
                    "upload: the local file is {len} bytes, the upload began with {size}"
                )));
            }
        }
        let chunk = match session.chunk_size {
            0 => DEFAULT_CHUNK_SIZE,
            n => n.min(MAX_CHUNK_SIZE),
        };
        let id = segment(&session.upload_id);
        loop {
            if at >= size {
                // Every byte is there but the upload is not finished (the
                // last answer was lost, or finishing failed): finish it.
                let call = Call::new(Method::POST, format!("/api/uploads/{id}/complete"));
                let answer: ChunkAnswer = read_json(self.client.execute(&call).await?).await?;
                return Ok(entry_for(session, Some(answer)));
            }
            let end = (at + chunk).min(size);
            let bytes = source.read(at, end).await?;
            let call = Call::new(Method::PATCH, format!("/api/uploads/{id}"))
                .header(CONTENT_RANGE, format!("bytes {at}-{}/{size}", end - 1))
                .body(RequestBody::bytes("application/octet-stream", bytes))
                .allow(&[200, 409]);
            let res = self.client.execute(&call).await?;
            let status = res.status().as_u16();
            let text = res.text().await?;
            let answer: Option<ChunkAnswer> = serde_json::from_str(&text).ok();
            if status == 409 {
                // The box has more (or fewer) bytes than this side thought:
                // go on from its count.
                match answer {
                    Some(ChunkAnswer {
                        error: Some(e),
                        received_bytes: Some(r),
                        ..
                    }) if e == "offset_mismatch" && r != at && r <= size => {
                        at = r;
                        continue;
                    }
                    _ => return Err(crate::error::error_from_response(409, &text)),
                }
            }
            at = end;
            if let Some(p) = &opts.on_progress {
                p(at, size);
            }
            if at >= size {
                return Ok(entry_for(session, answer));
            }
        }
    }

    /// Create one folder (`POST /api/drive/mkdir`). The parent must exist —
    /// see [`ensure_dir`](Self::ensure_dir) for `mkdir -p`.
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        let body = RequestBody::json(&serde_json::json!({
            "path": dirname(path),
            "name": basename(path),
        }))?;
        self.client
            .execute(&Call::new(Method::POST, "/api/drive/mkdir").body(body))
            .await?;
        Ok(())
    }

    /// `mkdir -p`: create every missing segment of `path`.
    ///
    /// A parent the token may not touch is passed over: a `files:app` token
    /// gets 403 on `/Apps` itself, yet may create folders inside its app
    /// folder (which the box made when it issued the token). A 403 on the
    /// last segment, or on a parent that really is missing, still surfaces.
    /// An answer that the folder exists (409, or the 500 older boxes give)
    /// is fine.
    pub async fn ensure_dir(&self, path: &str) -> Result<()> {
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut current = String::new();
        for (i, seg) in segments.iter().enumerate() {
            current.push('/');
            current.push_str(seg);
            match self.mkdir(&current).await {
                Ok(()) => {}
                Err(e) if matches!(e.status(), Some(409 | 500)) => {}
                Err(e) if e.is_forbidden() && i + 1 < segments.len() => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Rename within the same folder (`POST /api/drive/rename`). For a move
    /// to another folder use [`move_to`](Self::move_to).
    pub async fn rename(&self, path: &str, new_name: &str) -> Result<()> {
        let body = RequestBody::json(&serde_json::json!({ "path": path, "name": new_name }))?;
        self.client
            .execute(&Call::new(Method::POST, "/api/drive/rename").body(body))
            .await?;
        Ok(())
    }

    /// Move a file or folder to another path (`POST /api/drive/move`); the
    /// destination's parent must exist. (The TS SDK's `move`; `move` is a
    /// Rust keyword.)
    pub async fn move_to(&self, path: &str, new_path: &str) -> Result<()> {
        let body = RequestBody::json(&serde_json::json!({ "path": path, "newPath": new_path }))?;
        self.client
            .execute(&Call::new(Method::POST, "/api/drive/move").body(body))
            .await?;
        Ok(())
    }

    /// Delete: the file or folder moves to the box's trash, where the user
    /// can restore it (`DELETE /api/drive/delete`).
    pub async fn remove(&self, path: &str) -> Result<()> {
        let call = Call::new(
            Method::DELETE,
            format!("/api/drive/delete?{}", form_encode([("path", path)])),
        );
        self.client.execute(&call).await?;
        Ok(())
    }
}

fn split_upload_path(path: &str) -> Result<(String, String)> {
    let name = basename(path);
    if name.is_empty() {
        return Err(Error::InvalidInput(
            "upload path must include a filename".into(),
        ));
    }
    Ok((dirname(path), name.to_owned()))
}

fn entry_for(session: &UploadSession, answer: Option<ChunkAnswer>) -> DriveEntry {
    let (path, name) = match answer {
        Some(a) => (a.path, a.name),
        None => (None, None),
    };
    DriveEntry {
        path: path.unwrap_or_else(|| session.path()),
        name: name.unwrap_or_else(|| session.name.clone()),
        is_dir: false,
        size: session.size,
        mod_time: rfc3339_now(),
        hash: None,
    }
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

async fn remove_if_there(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// `bytes <start>-<end>/<size>` → `(Some(start), Some(size))`;
/// `bytes */<size>` → `(None, Some(size))`; a `*` size is `None`. Anything
/// else → `None`.
fn parse_content_range(v: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, size) = rest.split_once('/')?;
    let size = if size == "*" {
        None
    } else {
        Some(size.parse().ok()?)
    };
    if range == "*" {
        return Some((None, size));
    }
    let (start, _end) = range.split_once('-')?;
    Some((Some(start.parse().ok()?), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_as_the_ts_sdk_splits_them() {
        assert_eq!(dirname("/Apps/X/a.md"), "/Apps/X");
        assert_eq!(dirname("/a.md"), "/");
        assert_eq!(dirname("a.md"), "/");
        assert_eq!(dirname("/Apps/X/"), "/Apps");
        assert_eq!(basename("/Apps/X/a.md"), "a.md");
        assert_eq!(basename("/Apps/X/"), "X");
        assert_eq!(basename("/"), "");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/x", "a"), "/x/a");
        assert!(split_upload_path("/").is_err());
    }

    #[test]
    fn content_range() {
        assert_eq!(
            parse_content_range("bytes 5-9/10"),
            Some((Some(5), Some(10)))
        );
        assert_eq!(parse_content_range("bytes */10"), Some((None, Some(10))));
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((Some(0), None)));
        assert_eq!(parse_content_range("items 0-9/10"), None);
    }

    #[test]
    fn part_path_appends() {
        assert_eq!(
            part_path(Path::new("/tmp/a.bin")),
            PathBuf::from("/tmp/a.bin.part")
        );
    }
}
