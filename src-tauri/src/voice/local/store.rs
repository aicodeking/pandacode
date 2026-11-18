//! Speech model files: `<app data>/speech/models/<filename>` (0600), fetched only when the
//! user asks, from `https://huggingface.co/{id}/resolve/{revision}/{filename}` with a pinned
//! size and SHA-256. Partial data lives in `<filename>.part` and resumes with `Range`; a
//! verified file gets `<filename>.verified` (`sha:size:mtime:inode`) so it is hashed once.
use super::catalog;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub const BASE: &str = "https://huggingface.co";
const ATTEMPTS: usize = 3;
const MAX_REDIRECTS: usize = 5;
const CANCEL_POLL: Duration = Duration::from_millis(100);
const SPACE_MARGIN: u64 = 64 * 1024 * 1024;
const BUSY: &str = "Another speech model is downloading. Wait for it or cancel it first.";

/// One downloadable file (a model or the VAD).
#[derive(Clone, Debug)]
pub struct Item {
    pub id: String,
    pub revision: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
}

impl From<&catalog::Model> for Item {
    fn from(m: &catalog::Model) -> Self {
        Self { id: m.id.clone(), revision: m.revision.clone(), filename: m.filename.clone(), size: m.size, sha256: m.sha256.clone() }
    }
}
impl From<&catalog::Vad> for Item {
    fn from(v: &catalog::Vad) -> Self {
        Self { id: v.id.clone(), revision: v.revision.clone(), filename: v.filename.clone(), size: v.size, sha256: v.sha256.clone() }
    }
}

/// The download in progress (at most one).
#[derive(Clone)]
pub struct Active {
    /// The file this slot downloads now (a model id, or the VAD's slot id).
    pub model_id: String,
    /// The model the user asked for; a VAD that follows it keeps this, so cancelling the model
    /// also cancels its silence filter.
    pub owner: String,
    pub cancel: Arc<AtomicBool>,
    pub downloaded: Arc<AtomicU64>,
    pub verifying: Arc<AtomicBool>,
}

type SpaceFn = dyn Fn(&Path) -> std::io::Result<u64> + Send + Sync;

pub struct Store {
    dir: PathBuf,
    base: String,
    /// Tests only: a plain-HTTP loopback host that counts as Hugging Face.
    test_host: Option<String>,
    space: Box<SpaceFn>,
    active: Mutex<Option<Active>>,
}

/// Releases the single download slot.
pub struct Slot<'a> {
    store: &'a Store,
    pub active: Active,
}
impl Slot<'_> {
    /// Hands the slot to another file (the VAD after a model) without releasing it, so the
    /// first file's state no longer follows this slot's progress. The owner and the cancel flag
    /// carry over: a cancel for the model, even one that lands mid-switch, stops the next file.
    pub fn switch(&mut self, id: &str) -> Active {
        self.active = Active { cancel: self.active.cancel.clone(), ..Active::new(id, &self.active.owner) };
        if let Ok(mut active) = self.store.active.lock() {
            *active = Some(self.active.clone());
        }
        self.active.clone()
    }
}
impl Active {
    fn new(id: &str, owner: &str) -> Self {
        Self {
            model_id: id.to_owned(),
            owner: owner.to_owned(),
            cancel: Arc::new(AtomicBool::new(false)),
            downloaded: Arc::new(AtomicU64::new(0)),
            verifying: Arc::new(AtomicBool::new(false)),
        }
    }
}
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.store.active.lock() {
            *active = None;
        }
    }
}

fn host_allowed(host: &str) -> bool {
    host == "huggingface.co" || host.ends_with(".huggingface.co") || host.ends_with(".hf.co")
}

impl Store {
    pub fn new(app_data: &Path) -> Self {
        Self {
            dir: app_data.join("speech").join("models"),
            base: BASE.into(),
            test_host: None,
            space: Box::new(|p| fs4::available_space(p)),
            active: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub fn for_test(dir: &Path, base: String, space: Box<SpaceFn>) -> Self {
        let host = reqwest::Url::parse(&base).ok().and_then(|u| u.host_str().map(str::to_owned));
        Self { dir: dir.to_path_buf(), base, test_host: host, space, active: Mutex::new(None) }
    }

    pub fn path(&self, filename: &str) -> PathBuf {
        self.dir.join(filename)
    }
    fn part(&self, filename: &str) -> PathBuf {
        self.dir.join(format!("{filename}.part"))
    }
    /// Writes `body` as `item` and marks it verified, as a finished download would.
    #[cfg(test)]
    pub fn install_for_test(&self, item: &Item, body: &[u8]) {
        let path = self.path(&item.filename);
        std::fs::write(&path, body).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        std::fs::write(self.marker(&item.filename), marker(item, &meta)).unwrap();
    }

    fn marker(&self, filename: &str) -> PathBuf {
        self.dir.join(format!("{filename}.verified"))
    }

    pub fn active(&self) -> Option<Active> {
        self.active.lock().ok().and_then(|a| a.clone())
    }

    pub fn begin(&self, model_id: &str) -> Result<Slot<'_>, String> {
        let mut slot = self.active.lock().map_err(|_| BUSY.to_owned())?;
        if slot.is_some() {
            return Err(BUSY.into());
        }
        let active = Active::new(model_id, model_id);
        *slot = Some(active.clone());
        Ok(Slot { store: self, active })
    }

    /// Bytes of a resumable partial download, for the catalog.
    pub fn partial(&self, item: &Item) -> u64 {
        std::fs::metadata(self.part(&item.filename)).map(|m| m.len().min(item.size)).unwrap_or(0)
    }

    /// Installed = right size and a marker matching this exact file.
    pub fn installed(&self, item: &Item) -> bool {
        let path = self.path(&item.filename);
        let Ok(meta) = std::fs::metadata(&path) else { return false };
        meta.len() == item.size
            && std::fs::read_to_string(self.marker(&item.filename)).is_ok_and(|m| m == marker(item, &meta))
    }

    pub fn delete(&self, item: &Item) -> Result<(), String> {
        for path in [self.path(&item.filename), self.marker(&item.filename), self.part(&item.filename)] {
            match std::fs::remove_file(&path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("Could not delete the speech model file.".into()),
            }
        }
        Ok(())
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let test_host = self.test_host.clone();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            let url = attempt.url();
            let host = url.host_str().unwrap_or_default();
            let ok = (url.scheme() == "https" && host_allowed(host))
                || (url.scheme() == "http" && test_host.as_deref() == Some(host));
            if attempt.previous().len() >= MAX_REDIRECTS || !ok {
                attempt.error("redirect refused")
            } else {
                attempt.follow()
            }
        });
        reqwest::Client::builder()
            .redirect(policy)
            .retry(reqwest::retry::never())
            .https_only(self.test_host.is_none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .no_proxy()
            .build()
            .map_err(|_| "Could not prepare the model download.".to_owned())
    }

    fn url(&self, item: &Item) -> String {
        format!("{}/{}/resolve/{}/{}", self.base, item.id, item.revision, item.filename)
    }

    /// Downloads, verifies and installs `item`; returns its path. Cancel keeps the `.part`.
    pub async fn fetch(&self, item: &Item, active: &Active) -> Result<PathBuf, String> {
        if !catalog::valid_filename(&item.filename) {
            return Err("Invalid speech model file name.".into());
        }
        let path = self.path(&item.filename);
        if self.installed(item) {
            return Ok(path);
        }
        create_private_dir(&self.dir)?;
        let part = self.part(&item.filename);
        // A complete file without a marker (crash after rename) only needs hashing.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() == item.size) {
            let _ = std::fs::rename(&path, &part);
        } else {
            let _ = std::fs::remove_file(&path);
        }
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let need = item.size.saturating_sub(have.min(item.size)) + SPACE_MARGIN;
        let free = (self.space)(&self.dir).map_err(|_| "Could not check free disk space.".to_owned())?;
        if free < need {
            return Err(format!(
                "Not enough free disk space: this model needs {} MB more.",
                (need - free).div_ceil(1024 * 1024)
            ));
        }
        let client = self.client()?;
        let mut last = String::from("The model download failed.");
        for _ in 0..ATTEMPTS {
            if active.cancel.load(Ordering::Acquire) {
                return Err(super::super::CANCELLED.into());
            }
            match self.attempt(&client, item, &part, active).await {
                Ok(()) => break,
                Err(Attempt::Fatal(e)) => return Err(e),
                Err(Attempt::Retry(e)) => last = e,
            }
        }
        if std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) != item.size {
            return Err(last);
        }
        active.verifying.store(true, Ordering::Release);
        let (check, sha) = (part.clone(), item.sha256.clone());
        let cancel = active.cancel.clone();
        let matches = tokio::task::spawn_blocking(move || sha256_file(&check, &cancel).map(|h| h == sha))
            .await
            .map_err(|_| "Could not verify the model download.".to_owned())??;
        active.verifying.store(false, Ordering::Release);
        if !matches {
            let _ = std::fs::remove_file(&part);
            return Err("The downloaded model failed its checksum and was removed. Try again.".into());
        }
        set_private(&part)?;
        std::fs::rename(&part, &path).map_err(|_| "Could not install the speech model.".to_owned())?;
        let meta = std::fs::metadata(&path).map_err(|_| "Could not install the speech model.".to_owned())?;
        write_private(&self.marker(&item.filename), marker(item, &meta).as_bytes())?;
        Ok(path)
    }

    async fn attempt(&self, client: &reqwest::Client, item: &Item, part: &Path, active: &Active) -> Result<(), Attempt> {
        let have = resumable(part, item);
        active.downloaded.store(have, Ordering::Release);
        if have == item.size {
            return Ok(());
        }
        let response = self.request(client, item, have, active).await?;
        let start = start_offset(&response, item, part, have)?;
        let file = open_part(part, start).map_err(Attempt::Fatal)?;
        active.downloaded.store(start, Ordering::Release);
        let written = stream(response, file, start, item, part, active).await?;
        if written == item.size {
            Ok(())
        } else {
            Err(Attempt::Retry("The model download ended early.".into()))
        }
    }

    /// Sends the (range) request and refuses a response from a host outside the allowlist.
    /// Cancel is polled while waiting for the response, so it frees the slot at once.
    async fn request(&self, client: &reqwest::Client, item: &Item, have: u64, active: &Active) -> Result<reqwest::Response, Attempt> {
        let mut request = client.get(self.url(item));
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let sent = request.send();
        tokio::pin!(sent);
        let mut cancel_poll = tokio::time::interval(CANCEL_POLL);
        let sent = loop {
            tokio::select! {
                sent = &mut sent => break sent,
                _ = cancel_poll.tick() => {
                    if active.cancel.load(Ordering::Acquire) {
                        return Err(Attempt::Fatal(super::super::CANCELLED.into()));
                    }
                }
            }
        };
        let response = sent.map_err(|e| {
            Attempt::Retry(if e.is_redirect() {
                "The model download was redirected to an unexpected site.".into()
            } else {
                "Could not reach Hugging Face. Check your connection and try again.".into()
            })
        })?;
        if response.url().host_str().is_some_and(|h| !host_allowed(h) && self.test_host.as_deref() != Some(h)) {
            return Err(Attempt::Fatal("The model download was redirected to an unexpected site.".into()));
        }
        Ok(response)
    }
}

/// Bytes of `part` worth resuming; an oversized leftover is removed and counts as zero.
fn resumable(part: &Path, item: &Item) -> u64 {
    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if have > item.size {
        let _ = std::fs::remove_file(part);
        return 0;
    }
    have
}

/// Where the response body starts in the file: `have` for an exact resume, 0 for a full body.
fn start_offset(response: &reqwest::Response, item: &Item, part: &Path, have: u64) -> Result<u64, Attempt> {
    let status = response.status().as_u16();
    let expected_range = format!("bytes {have}-{}/{}", item.size - 1, item.size);
    let start = match status {
        206 if have > 0 => {
            let range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok());
            if range != Some(expected_range.as_str()) {
                // The server resumed somewhere else: start over cleanly.
                let _ = std::fs::remove_file(part);
                return Err(Attempt::Retry("The download server resumed at the wrong position.".into()));
            }
            have
        }
        200 => 0,
        _ if response.status().is_redirection() => {
            return Err(Attempt::Fatal("The model download was redirected to an unexpected site.".into()))
        }
        404 | 401 | 403 => return Err(Attempt::Fatal("This model is no longer available for download.".into())),
        _ => return Err(Attempt::Retry(format!("The model download failed (HTTP {status})."))),
    };
    if start == 0 && response.content_length().is_some_and(|len| len != item.size) {
        return Err(Attempt::Retry("The download server sent an unexpected file size.".into()));
    }
    Ok(start)
}

/// Appends the body to `file` from `written`, polling for cancel; returns the bytes on disk.
async fn stream(
    mut response: reqwest::Response,
    mut file: std::fs::File,
    mut written: u64,
    item: &Item,
    part: &Path,
    active: &Active,
) -> Result<u64, Attempt> {
    let mut cancel_poll = tokio::time::interval(CANCEL_POLL);
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk,
            _ = cancel_poll.tick() => {
                if active.cancel.load(Ordering::Acquire) {
                    let _ = file.flush();
                    return Err(Attempt::Fatal(super::super::CANCELLED.into()));
                }
                continue;
            }
        };
        let chunk = chunk.map_err(|_| Attempt::Retry("The model download was interrupted.".into()))?;
        let Some(chunk) = chunk else { break };
        if written + chunk.len() as u64 > item.size {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Err(Attempt::Retry("The download server sent more data than expected.".into()));
        }
        file.write_all(&chunk).map_err(|_| Attempt::Fatal("Could not write the model file. Check free disk space.".into()))?;
        written += chunk.len() as u64;
        active.downloaded.store(written, Ordering::Release);
    }
    file.flush().map_err(|_| Attempt::Fatal("Could not write the model file.".into()))?;
    Ok(written)
}

enum Attempt {
    Retry(String),
    Fatal(String),
}

fn marker(item: &Item, meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(meta);
    #[cfg(not(unix))]
    let inode = 0u64;
    format!("{}:{}:{mtime}:{inode}", item.sha256, item.size)
}

fn sha256_file(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|_| "Could not verify the model download.".to_owned())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(super::super::CANCELLED.into());
        }
        let n = file.read(&mut buf).map_err(|_| "Could not verify the model download.".to_owned())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|_| "Could not create the speech model folder.".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn set_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not protect the speech model file.".to_owned())?;
    }
    let _ = path;
    Ok(())
}

fn open_part(part: &Path, start: u64) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if start == 0 {
        options.truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(part).map_err(|_| "Could not write the model file.".to_owned())?;
    if start > 0 && file.metadata().map(|m| m.len()).unwrap_or(0) != start {
        return Err("The partial model file changed; try again.".into());
    }
    Ok(file)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(path)
        .and_then(|mut f| f.write_all(bytes))
        .map_err(|_| "Could not record the verified model.".to_owned())
}
