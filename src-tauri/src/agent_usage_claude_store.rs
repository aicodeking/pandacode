//! Where Claude Code keeps a login, and how PandaCode reads it (never writes
//! it): the Keychain item (macOS) or `<config>/.credentials.json`.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

/// Where a login is kept.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Store {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Keychain(String),
    File(PathBuf),
}

impl Store {
    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Keychain(_) => "Claude Code login · Keychain",
            Self::File(_) => "Claude Code login · local credential file",
        }
    }
}

/// Why a store could not be read; each has its own message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unread {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    KeychainLocked,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Keychain,
    /// macOS denied `security`, or it was not answered (see `usage_keychain`).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    KeychainLatched,
    File,
}

impl Unread {
    /// The Keychain store failed (Claude Code would have used the Keychain).
    pub(crate) fn keychain(self) -> bool {
        self != Self::File
    }
}

pub(crate) enum Read {
    Found(Vec<u8>),
    Missing,
    Failed(Unread),
}

pub(crate) async fn read_store(store: &Store) -> Read {
    read_with(store, false).await
}

/// A read for a Refresh the user pressed: `security` gets time to be answered.
pub(crate) async fn read_store_manual(store: &Store) -> Read {
    read_with(store, true).await
}

async fn read_with(store: &Store, manual: bool) -> Read {
    match store {
        Store::Keychain(service) => read_keychain(service, manual).await,
        Store::File(path) => match crate::agent_usage_providers::credential_bytes(path).await {
            Ok(Some(bytes)) => Read::Found(bytes),
            Ok(None) => Read::Missing,
            Err(()) => Read::Failed(Unread::File),
        },
    }
}

#[cfg(target_os = "macos")]
async fn read_keychain(service: &str, manual: bool) -> Read {
    use crate::usage_keychain::{read_claude, ReadError};
    let service = service.to_owned();
    match tokio::task::spawn_blocking(move || read_claude(&service, manual)).await {
        Ok(Ok(Some(bytes))) => Read::Found(bytes),
        Ok(Ok(None)) => Read::Missing,
        Ok(Err(ReadError::Locked)) => Read::Failed(Unread::KeychainLocked),
        Ok(Err(ReadError::Latched)) => Read::Failed(Unread::KeychainLatched),
        _ => Read::Failed(Unread::Keychain),
    }
}

/// No Keychain off macOS.
#[cfg(not(target_os = "macos"))]
async fn read_keychain(_: &str, _: bool) -> Read {
    Read::Missing
}

/// When a Keychain item last changed (attribute-only lookup, no secret, no
/// prompt): `Some(None)` when gone; `None` when unknown or not a Keychain item.
pub(crate) async fn keychain_item_stamp(store: &Store) -> Option<Option<String>> {
    match store {
        #[cfg(target_os = "macos")]
        Store::Keychain(service) => {
            let service = service.clone();
            tokio::task::spawn_blocking(move || crate::usage_keychain::claude_item_stamp(&service)).await.ok().flatten()
        }
        _ => None,
    }
}

/// Whether a store can be read without unlocking anything: a file always;
/// a Keychain item only while the login Keychain is unlocked (checked before
/// any run of Claude Code, which must neither prompt nor fail on it).
pub(crate) fn keychain_unlocked(store: &Store) -> bool {
    match store {
        #[cfg(target_os = "macos")]
        Store::Keychain(service) => crate::usage_keychain::keychain_unlocked(service),
        _ => true,
    }
}

/// Writes one of PandaCode's own files (the saved reading, its key)
/// atomically and owner-only, following a symlink so the link survives.
pub(crate) fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    let temp = dir.join(format!(".pandacode-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = options
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, &target));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
        return result;
    }
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}
