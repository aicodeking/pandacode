//! Typed document reads reuse the native workspace scope and 64 MiB limit.
use serde::Deserialize;
use std::path::{Component, Path};
use tauri::Manager;

pub const MAX_BYTES: usize = crate::workspace::DOCUMENT_LIMIT as usize;
pub type ReadFuture = futures_util::future::BoxFuture<'static, crate::Result<Vec<u8>>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRequest {
    pub project_id: String,
    pub session_id: Option<String>,
    pub path: String,
}

impl DocumentRequest {
    pub fn validate(&self) -> crate::Result<()> {
        let identifier = |value: &str| {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        };
        if !identifier(&self.project_id)
            || self.session_id.as_deref().is_some_and(|id| !identifier(id))
        {
            return Err("A valid project and task are required.".into());
        }
        let path = Path::new(&self.path);
        if self.path.is_empty()
            || self.path.len() > 4096
            || self.path.chars().any(char::is_control)
            || path.is_absolute()
            || path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("A relative workspace document path is required.".into());
        }
        Ok(())
    }
}

pub fn read(app: tauri::AppHandle, request: DocumentRequest) -> ReadFuture {
    Box::pin(async move {
        request.validate()?;
        crate::blocking(move || {
            let state = app.state::<crate::AppState>();
            let root = state.root(&request.project_id, request.session_id.as_deref())?;
            read_from_root(&root, &request)
        })
        .await
    })
}

/// The caller supplies a root obtained from AppState, never from an HTTP path.
/// Kept separate so fixture brokers exercise the same native document validator.
pub fn read_from_root(root: &Path, request: &DocumentRequest) -> crate::Result<Vec<u8>> {
    request.validate()?;
    let bytes = crate::workspace::read_document_bytes(root, &request.path)?;
    if bytes.len() > MAX_BYTES {
        return Err("Document exceeds the native viewer limit.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("pandacode-web-documents-{}", uuid::Uuid::new_v4()));
            let root = base.join("workspace");
            fs::create_dir(&base).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("report.pdf"), b"%PDF-fixture\0binary").unwrap();
            fs::write(base.join("outside.pdf"), b"outside fixture").unwrap();
            Self { base, root }
        }
        fn request(&self, path: &str) -> DocumentRequest {
            DocumentRequest {
                project_id: "fixture-project".into(),
                session_id: None,
                path: path.into(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for name in ["report.pdf", "escape.pdf", "large.pdf"] {
                let _ = fs::remove_file(self.root.join(name));
            }
            let _ = fs::remove_file(self.base.join("outside.pdf"));
            let _ = fs::remove_dir(&self.root);
            let _ = fs::remove_dir(&self.base);
        }
    }

    #[test]
    fn binary_reads_preserve_bytes_and_reject_unscoped_paths() {
        let fixture = Fixture::new();
        assert_eq!(
            read_from_root(&fixture.root, &fixture.request("report.pdf")).unwrap(),
            b"%PDF-fixture\0binary"
        );
        for path in ["../outside.pdf", "/etc/passwd", "report.pdf\n"] {
            assert!(read_from_root(&fixture.root, &fixture.request(path)).is_err());
        }
    }

    #[test]
    fn native_document_limit_is_enforced_before_reading_a_large_file() {
        let fixture = Fixture::new();
        let file = fs::File::create(fixture.root.join("large.pdf")).unwrap();
        file.set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(read_from_root(&fixture.root, &fixture.request("large.pdf")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_outside_symlink_cannot_be_downloaded() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(
            fixture.base.join("outside.pdf"),
            fixture.root.join("escape.pdf"),
        )
        .unwrap();
        assert!(read_from_root(&fixture.root, &fixture.request("escape.pdf")).is_err());
    }
}
