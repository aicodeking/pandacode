//! One-click Lima setup on Linux, with no root: fetch the pinned release for this CPU from
//! GitHub, check its SHA-256 before anything in it runs, and unpack it whole beside
//! PandaCode's Lima home (Lima finds its guest agent and templates next to `bin/`).
//! Lima is Apache-2.0; PandaCode fetches it, never bundles it.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::io::AsyncWriteExt;

use crate::workspace::run_process;

pub const VERSION: &str = "2.2.1";
/// Older releases are not tested with PandaCode's settings, so one on PATH is ignored.
const MINIMUM: [u32; 3] = [2, 2, 1];
const X86_64: &str = "b391ac7fcac2b2a5a1628107756463188ded4d18d3104a40a66a8bb6fec01bcb";
const AARCH64: &str = "fbcf4d127936666aa2cf6013b663c250431f2a59394757b404070f8d6a160e10";
const MAX_BYTES: u64 = 200 << 20;

fn release(arch: &str) -> Option<(String, &'static str)> {
    let sha = match arch { "x86_64" => X86_64, "aarch64" => AARCH64, _ => return None };
    Some((format!("https://github.com/lima-vm/lima/releases/download/v{VERSION}/lima-{VERSION}-Linux-{arch}.tar.gz"), sha))
}

fn folder(data: &Path) -> PathBuf {
    data.join(format!("lima-{VERSION}"))
}
/// Where setup puts `limactl`.
pub fn path() -> Option<PathBuf> {
    super::data_dir().map(|data| folder(&data).join("bin/limactl"))
}

/// `limactl version 2.2.1` as numbers. Anything but a plain release reads as None: a
/// pre-release (`2.3.0-rc.1`) or a development build (`2.2.1-12-gabc`, `-dirty`).
fn parse_version(output: &str) -> Option<[u32; 3]> {
    let version = output.split_whitespace().last()?.trim_start_matches('v');
    // Digits only: `u32::from_str` would take a leading `+`.
    let mut parts = version.split('.').map(|part| part.bytes().all(|b| b.is_ascii_digit()).then_some(part)?.parse::<u32>().ok());
    let version = [parts.next()??, parts.next()??, parts.next()??];
    parts.next().is_none().then_some(version)
}
/// Lima 2 at `MINIMUM` or later: a major release may change the settings PandaCode relies on.
fn acceptable(version: [u32; 3]) -> bool {
    version[0] == MINIMUM[0] && version >= MINIMUM
}
fn version_of(limactl: &Path) -> Option<[u32; 3]> {
    let mut command = Command::new(limactl);
    command.arg("--version");
    let out = run_process(command, "Lima", 4096, Duration::from_secs(10)).ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout.bytes))
}
pub fn recent_enough(limactl: &Path) -> bool {
    version_of(limactl).is_some_and(acceptable)
}

/// Stream `url` to `dest` with redirects (GitHub serves releases from another host), hashing as it goes.
async fn download(url: &str, dest: &Path) -> Result<String, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .https_only(!cfg!(test))
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(20 * 60))
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let fail = |error: String| format!("Downloading Lima failed: {error}");
    let mut response = client.get(url).send().await.map_err(|error| fail(error.to_string()))?;
    if !response.status().is_success() {
        return Err(fail(format!("HTTP {}", response.status().as_u16())));
    }
    let mut out = tokio::fs::File::create(dest).await.map_err(|error| fail(error.to_string()))?;
    let (mut hasher, mut size) = (Sha256::new(), 0u64);
    while let Some(chunk) = response.chunk().await.map_err(|error| fail(error.to_string()))? {
        size += chunk.len() as u64;
        if size > MAX_BYTES {
            return Err(fail("the file is too large".into()));
        }
        hasher.update(&chunk);
        out.write_all(&chunk).await.map_err(|error| fail(error.to_string()))?;
    }
    out.flush().await.map_err(|error| fail(error.to_string()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let mut command = Command::new("tar");
    command.args(["-xzf".as_ref(), archive.as_os_str(), "-C".as_ref(), into.as_os_str(), "--no-same-owner".as_ref()]);
    let out = run_process(command, "tar", 1 << 16, Duration::from_secs(120))?;
    if out.status.success() { Ok(()) } else { Err(format!("Unpacking Lima failed: {}", String::from_utf8_lossy(&out.stderr.bytes).trim())) }
}

/// Earlier releases PandaCode installed, never the `lima` home beside them.
fn remove_old_releases(data: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(data) else { return };
    for path in entries.flatten().map(|entry| entry.path()) {
        let release = path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix("lima-")).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
        if release && path != keep {
            let _ = fs::remove_dir_all(path);
        }
    }
}

async fn install_from(url: &str, sha: &str, data: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(data).map_err(|error| format!("Could not prepare {}: {error}", data.display()))?;
    // Beside the target, so the final rename stays on one filesystem.
    let work = data.join(format!(".lima-setup-{}", uuid::Uuid::new_v4().simple()));
    let unpacked = work.join("lima");
    let result = async {
        fs::create_dir_all(&unpacked).map_err(|error| error.to_string())?;
        let archive = work.join("lima.tar.gz");
        if download(url, &archive).await? != sha {
            return Err("The Lima download does not match its pinned SHA-256 hash. Nothing was installed.".to_string());
        }
        let moved = archive.clone();
        let target = unpacked.clone();
        crate::blocking(move || unpack(&moved, &target)).await?;
        let limactl = unpacked.join("bin/limactl");
        if !limactl.is_file() || !unpacked.join("share/lima").is_dir() {
            return Err("The Lima download is missing its files. Nothing was installed.".to_string());
        }
        let target = folder(data);
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| format!("Could not replace the old Lima: {error}"))?;
        }
        fs::rename(&unpacked, &target).map_err(|error| format!("Could not install Lima: {error}"))?;
        remove_old_releases(data, &target);
        Ok(target.join("bin/limactl"))
    }
    .await;
    let _ = fs::remove_dir_all(&work);
    result
}

/// Install this computer's pinned Lima; returns the path of `limactl`.
pub async fn install() -> Result<PathBuf, String> {
    let (url, sha) = release(std::env::consts::ARCH).ok_or("Local VMs need a Linux computer on x86_64 or arm64.")?;
    let data = super::data_dir().ok_or("Your home folder is unknown.")?;
    install_from(&url, sha, &data).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-lima-setup-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// A one-shot HTTP server for `body`.
    fn serve(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(&body);
        });
        format!("http://{address}/lima.tar.gz")
    }
    /// A release-shaped archive whose `limactl` leaves a mark if it ever runs.
    fn archive(root: &Path, mark: &Path) -> Vec<u8> {
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("share/lima/templates")).unwrap();
        fs::write(root.join("bin/limactl"), format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
        let file = root.with_extension("tgz");
        let status = Command::new("tar").args(["-czf".as_ref(), file.as_os_str(), "-C".as_ref(), root.as_os_str(), "bin".as_ref(), "share".as_ref()]).status().unwrap();
        assert!(status.success());
        fs::read(file).unwrap()
    }

    #[test]
    fn pins_a_release_for_each_cpu() {
        let (url, sha) = release("x86_64").unwrap();
        assert_eq!(url, "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-x86_64.tar.gz");
        assert_eq!(sha, X86_64);
        assert_eq!(release("aarch64").unwrap().1, AARCH64);
        assert!(release("riscv64").is_none());
        assert!(![X86_64, AARCH64].iter().any(|sha| sha.len() != 64));
    }
    #[test]
    fn reads_versions_and_rejects_old_ones() {
        assert_eq!(parse_version("limactl version 2.2.1\n"), Some([2, 2, 1]));
        assert_eq!(parse_version("limactl version v2.2.1"), Some([2, 2, 1]));
        assert_eq!(parse_version("nonsense"), None);
        for pre in ["2.3.0-beta.1", "2.3.0-rc.1", "2.3.0-alpha.0", "2.2.1-", "2.2.1.4", "2.2.1-12-gabc", "2.2.1-12-gabc-dirty", "2.2.1-dirty", "2.2.+1", "2..1"] {
            assert_eq!(parse_version(&format!("limactl version {pre}")), None, "{pre}");
        }
        let ok = |text: &str| parse_version(text).is_some_and(acceptable);
        assert!(ok("limactl version 2.2.1") && ok("limactl version 2.10.0"));
        assert!(!ok("limactl version 1.2.0") && !ok("limactl version 2.2.0") && !ok("limactl version 3.0.0") && !ok("limactl version 2.3.0-rc.1") && !ok("limactl version 2.2.2-3-gdeadbee"));
    }
    #[tokio::test]
    async fn a_wrong_hash_installs_and_runs_nothing() {
        let root = temp();
        let mark = root.join("ran");
        let body = archive(&root.join("release"), &mark);
        let data = root.join("data");
        let error = install_from(&serve(body), &"0".repeat(64), &data).await.unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0, "nothing stays behind");
        assert!(!mark.exists());
        let _ = fs::remove_dir_all(&root);
    }
    #[tokio::test]
    async fn keeps_bin_and_share_together_and_replaces_only_older_releases() {
        let root = temp();
        let body = archive(&root.join("release"), &root.join("ran"));
        let sha = format!("{:x}", Sha256::digest(&body));
        let data = root.join("data");
        fs::create_dir_all(data.join("lima-2.0.0/bin")).unwrap();
        fs::create_dir_all(data.join("lima/pc")).unwrap();
        let limactl = install_from(&serve(body), &sha, &data).await.unwrap();
        assert_eq!(limactl, data.join(format!("lima-{VERSION}/bin/limactl")));
        assert!(data.join(format!("lima-{VERSION}/share/lima/templates")).is_dir());
        assert!(!data.join("lima-2.0.0").exists() && data.join("lima/pc").is_dir());
        assert_eq!(fs::read_dir(&data).unwrap().count(), 2, "the work folder is gone");
        let _ = fs::remove_dir_all(&root);
    }
    #[tokio::test]
    async fn a_failed_download_says_so() {
        let root = temp();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        });
        let error = install_from(&url, X86_64, &root).await.unwrap_err();
        assert!(error.contains("HTTP 404"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }
    /// The real download into `$XDG_DATA_HOME`: `cargo test --lib -- --ignored vm::lima::install --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_install() {
        let limactl = install().await.unwrap();
        eprintln!("installed {}", limactl.display());
        assert_eq!(version_of(&limactl), parse_version(&format!("limactl version {VERSION}")));
        assert!(limactl.with_file_name("../share/lima/templates/ubuntu-lts.yaml").exists());
    }
}
