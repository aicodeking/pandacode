//! One workspace-owned launch script and its optional browser destination.
use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub const FILE_NAME: &str = "pandacode-run.sh";
const PREVIEW_HEADER: &str = "# pandacode-preview:";
const MAX_SCRIPT: u64 = 64 * 1024;

pub const INSTRUCTIONS: &str = r#"
Run and preview workflow: When your edits affect a runnable app and commands are needed to preview it, maintain a POSIX shell script named pandacode-run.sh at the primary workspace/worktree root. Use the project's actual, verified commands and installed tools; do not invent dependency commands, install dependencies unnecessarily, or include destructive setup. Keep long-running servers in the foreground so the managed terminal can stop them. If the script opens a browser preview, include one comment `# pandacode-preview: http://127.0.0.1:PORT` with the actual server URL, or a workspace-relative HTML/SVG path the script produces. Do not create a Run Script for static HTML/SVG alone: use pandacode_preview_file({"path":"relative/file.html"}) instead. After applicable edits, if PandaCode preview tools are available, use pandacode_run_project (no arguments) to run the maintained script and open its declared preview, or pandacode_preview_file for static output. If the harness cannot use app tools, maintain the script and provide the preview path or URL for the user instead. Respect the user's restrictions on running commands or opening previews. Parallel workers should maintain the script as needed and leave final execution/preview to the architect to avoid duplicate servers and competing UI actions. Opening a preview alone does not establish that testing or review passed; inspect and verify the result separately.
"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunScript {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
}

/// Inspection is bounded and never executes code or guesses dependency commands.
pub fn inspect(root: &Path) -> Result<Option<RunScript>, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable.")?;
    let candidate = root.join(FILE_NAME);
    match fs::symlink_metadata(&candidate) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect pandacode-run.sh.".into()),
        Ok(_) => {}
    }
    let script = candidate
        .canonicalize()
        .map_err(|_| "Run Script is unavailable.")?;
    if !script.starts_with(&root) || !script.is_file() {
        return Err("Run Script must be a regular file inside this workspace.".into());
    }
    let file = fs::File::open(&script).map_err(|_| "Could not read pandacode-run.sh.")?;
    if file
        .metadata()
        .map_err(|_| "Could not inspect Run Script.")?
        .len()
        > MAX_SCRIPT
    {
        return Err("Run Script must be no larger than 64 KiB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SCRIPT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read pandacode-run.sh.")?;
    if bytes.len() as u64 > MAX_SCRIPT {
        return Err("Run Script must be no larger than 64 KiB.".into());
    }
    let content = std::str::from_utf8(&bytes).map_err(|_| "Run Script must contain UTF-8 text.")?;
    if content.trim().is_empty() || content.contains('\0') {
        return Err("Run Script must contain a shell script.".into());
    }
    let mut script = RunScript {
        path: FILE_NAME.into(),
        preview_url: None,
        preview_path: None,
    };
    let mut headers = content
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix(PREVIEW_HEADER));
    if let Some(value) = headers.next() {
        if headers.next().is_some() {
            return Err("Run Script must have only one pandacode-preview header.".into());
        }
        let value = value.trim();
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("Run Script has an invalid preview destination.".into());
        }
        if value.contains("://") {
            let url =
                tauri::Url::parse(value).map_err(|_| "Run Script has an invalid preview URL.")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(
                    "Run Script preview URLs must use HTTP or HTTPS without credentials.".into(),
                );
            }
            script.preview_url = Some(url.to_string());
        } else {
            script.preview_path = Some(preview_path(&root, value)?);
        }
    }
    Ok(Some(script))
}

// Build scripts may create the destination later. Check every existing ancestor
// now; file_preview revalidates the real file when the browser is opened.
fn preview_path(root: &Path, value: &str) -> Result<String, String> {
    let path = Path::new(value);
    // Windows components consume backslashes, so reject them before parsing.
    if value.contains('\\') || path.components().any(|part| match part {
        Component::Normal(name) => name
            .to_str()
            .is_none_or(|name| name.starts_with('.') || name.contains(['\\', ':'])),
        Component::CurDir => false,
        _ => true,
    }) || !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "html" | "htm" | "svg"
            )
        })
    {
        return Err("Run Script previews must be workspace-relative HTML or SVG files.".into());
    }
    let candidate = root.join(path);
    for ancestor in candidate.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let resolved = ancestor
                    .canonicalize()
                    .map_err(|_| "Run Script preview is unavailable.")?;
                if !resolved.starts_with(root) || (ancestor == candidate && !resolved.is_file())
                    || (ancestor != candidate && !metadata.is_dir() && !resolved.is_dir())
                    || resolved.strip_prefix(root).is_ok_and(|relative| relative.components().any(|part| {
                        matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with('.'))
                    }))
                {
                    return Err("Run Script preview must stay inside this workspace.".into());
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Run Script preview is unavailable.".into()),
        }
    }
    Ok(path
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

pub fn script_path(root: &Path) -> Result<PathBuf, String> {
    inspect(root)?.ok_or("Add pandacode-run.sh to this workspace before running it.")?;
    root.join(FILE_NAME)
        .canonicalize()
        .map_err(|_| "Run Script is unavailable.".into())
}

pub fn command(root: &Path) -> Result<CommandBuilder, String> {
    script_path(root)?;
    let mut command = script_command(
        cfg!(windows),
        &|name| std::env::var_os(name),
        &crate::providers::executable,
        &|path| path.is_file(),
    )?;
    command.env("PATH", crate::providers::executable_path()?);
    Ok(command)
}

/// Poll only a declared loopback server. Remote destinations can be navigated
/// directly, without sending an extra background request from the native app.
pub async fn url_ready(value: &str) -> bool {
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if !local {
        return true;
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(750))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if url.host_str() == Some("localhost") {
        let port = url.port_or_known_default().unwrap_or(80);
        builder = builder.resolve_to_addrs(
            "localhost",
            &[
                std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
                std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            ],
        );
    }
    let Ok(client) = builder.build() else {
        return false;
    };
    client
        .get(url)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success() || response.status().is_redirection())
}

fn script_command(
    windows: bool,
    env: &impl Fn(&str) -> Option<OsString>,
    find: &impl Fn(&str) -> Option<PathBuf>,
    is_file: &impl Fn(&Path) -> bool,
) -> Result<CommandBuilder, String> {
    let mut command = if windows {
        // WSL's legacy bash.exe runs a different filesystem and is not Git Bash.
        let native_bash = |path: &PathBuf| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                && !path
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase()
                    .contains("/windows/system32/")
        };
        let bash = find("bash")
            .filter(native_bash)
            .or_else(|| {
                ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
                    .into_iter()
                    .filter_map(env)
                    .flat_map(|base| {
                        let base = PathBuf::from(base);
                        [
                            base.join("Git/bin/bash.exe"),
                            base.join("Programs/Git/bin/bash.exe"),
                        ]
                    })
                    .find(|path| is_file(path))
            })
            .ok_or(
                "Run Script needs Git Bash on Windows. Install Git for Windows and try again.",
            )?;
        let mut command = CommandBuilder::new(crate::providers::external_path(&bash));
        command.args(["--noprofile", "--norc", "--posix", "--"]);
        command
    } else {
        CommandBuilder::new("/bin/sh")
    };
    // The fixed path is one argv item and is resolved from start_command's cwd.
    command.arg(format!("./{FILE_NAME}"));
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("pandacode-run-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn script(&self, content: &str) {
            fs::write(self.0.join(FILE_NAME), content).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn inspection_is_optional_and_scoped_to_the_selected_checkout() {
        let project = Fixture::new();
        let worktree = Fixture::new();
        assert_eq!(inspect(&project.0).unwrap(), None);
        project.script("#!/bin/sh\n# pandacode-preview: http://127.0.0.1:3000\nexec npm run dev\n");
        worktree.script("#!/bin/sh\n# pandacode-preview: http://127.0.0.1:3001\nexec npm run dev\n");
        let result = inspect(&project.0).unwrap().unwrap();
        assert_eq!(result.path, FILE_NAME);
        assert_eq!(
            result.preview_url.as_deref(),
            Some("http://127.0.0.1:3000/")
        );
        assert_eq!(
            inspect(&worktree.0)
                .unwrap()
                .unwrap()
                .preview_url
                .as_deref(),
            Some("http://127.0.0.1:3001/")
        );
        project.script("#!/bin/sh\nprintf hello\n");
        assert_eq!(
            serde_json::to_value(inspect(&project.0).unwrap().unwrap()).unwrap(),
            serde_json::json!({"path": FILE_NAME})
        );
    }

    #[test]
    fn preview_files_may_be_created_by_the_run_script() {
        let f = Fixture::new();
        for value in [
            "index.html",
            "./dist/index.html",
            "my drawing.svg",
            "index.HTM",
        ] {
            f.script(&format!("#!/bin/sh\n# pandacode-preview: {value}\n:"));
            assert_eq!(
                inspect(&f.0).unwrap().unwrap().preview_path.unwrap(),
                value.trim_start_matches("./")
            );
        }
        fs::create_dir_all(f.0.join("index.html")).unwrap();
        f.script("# pandacode-preview: index.html\n:");
        assert!(inspect(&f.0).is_err());
    }

    #[test]
    fn inspection_rejects_unsafe_or_ambiguous_preview_destinations() {
        let f = Fixture::new();
        for value in [
            "",
            "../index.html",
            "/tmp/index.html",
            "C:\\project\\index.html",
            "folder\\index.html",
            ".private/index.html",
            "source.ts",
            "file:///tmp/index.html",
            "javascript:alert(1)",
            "http://user:secret@192.0.2.1",
            "http://192.0.2.1/\tsecret",
            "https://",
            "index.html\n# pandacode-preview: other.html",
        ] {
            f.script(&format!("#!/bin/sh\n# pandacode-preview: {value}\n:"));
            assert!(inspect(&f.0).is_err(), "{value:?}");
        }
    }

    #[test]
    fn inspection_requires_bounded_regular_utf8_scripts() {
        let f = Fixture::new();
        assert!(script_path(&f.0)
            .unwrap_err()
            .contains("Add pandacode-run.sh"));
        fs::create_dir(f.0.join(FILE_NAME)).unwrap();
        assert!(inspect(&f.0).is_err());
        fs::remove_dir(f.0.join(FILE_NAME)).unwrap();
        for content in [
            "".into(),
            " \n".into(),
            "printf hi\0".into(),
            "x".repeat(MAX_SCRIPT as usize + 1),
        ] {
            f.script(&content);
            assert!(inspect(&f.0).is_err());
        }
        fs::write(f.0.join(FILE_NAME), [0xff, 0xfe]).unwrap();
        assert!(inspect(&f.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn scripts_and_previews_cannot_follow_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.script("#!/bin/sh\n:");
        symlink(outside.0.join(FILE_NAME), f.0.join(FILE_NAME)).unwrap();
        assert!(inspect(&f.0).is_err());
        fs::remove_file(f.0.join(FILE_NAME)).unwrap();
        symlink(&outside.0, f.0.join("dist")).unwrap();
        f.script("# pandacode-preview: dist/index.html\n:");
        assert!(inspect(&f.0).is_err());
        fs::remove_file(f.0.join("dist")).unwrap();
        symlink(outside.0.join("missing"), f.0.join("dist")).unwrap();
        assert!(inspect(&f.0).is_err());
    }

    #[test]
    fn windows_uses_native_bash_with_literal_script_arguments_or_explains_requirement() {
        let no_env = |_: &str| None;
        let cmd = script_command(
            true,
            &no_env,
            &|_| Some(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")),
            &|_| false,
        )
        .unwrap();
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            argv,
            [
                r"C:\Program Files\Git\bin\bash.exe",
                "--noprofile",
                "--norc",
                "--posix",
                "--",
                "./pandacode-run.sh"
            ]
        );
        for value in [
            None,
            Some(PathBuf::from(r"C:\Windows\System32\bash.exe")),
            Some(PathBuf::from("bash.cmd")),
        ] {
            assert!(
                script_command(true, &no_env, &|_| value.clone(), &|_| false)
                    .unwrap_err()
                    .contains("Git Bash")
            );
        }
        let env = |name: &str| (name == "ProgramFiles").then(|| OsString::from("C:/Program Files"));
        let cmd = script_command(true, &env, &|_| None, &|path| {
            path == Path::new("C:/Program Files/Git/bin/bash.exe")
        })
        .unwrap();
        assert_eq!(
            Path::new(&cmd.get_argv()[0]),
            Path::new("C:/Program Files/Git/bin/bash.exe")
        );
    }

    #[cfg(unix)]
    #[test]
    fn posix_script_runs_from_its_workspace_without_executable_permissions() {
        let f = Fixture::new();
        let root = f.0.join("project & spaces ' $(ignored)");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(FILE_NAME),
            "#!/bin/sh\nprintf '%s' \"$PWD\" > actual-root\nprintf 'launched'\n",
        )
        .unwrap();
        let command = command(&root).unwrap();
        let path = command
            .get_env("PATH")
            .expect("Run Script must supply the installed tools PATH");
        assert!(std::env::split_paths(path).any(|path| path == Path::new("/opt/homebrew/bin")));
        assert_eq!(
            command.get_argv(),
            &[
                OsString::from("/bin/sh"),
                OsString::from("./pandacode-run.sh")
            ]
        );
        let mut process = std::process::Command::new(&command.get_argv()[0]);
        process
            .args(&command.get_argv()[1..])
            .env("PATH", path)
            .current_dir(&root);
        let output = crate::workspace::run_process(
            process,
            "Run Script test",
            1024,
            std::time::Duration::from_secs(3),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.bytes, b"launched");
        assert_eq!(
            fs::read_to_string(root.join("actual-root")).unwrap(),
            root.to_string_lossy()
        );
    }

    #[tokio::test]
    async fn localhost_readiness_supports_servers_bound_only_to_ipv6() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        assert!(url_ready(&format!("http://localhost:{port}/")).await);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn readiness_probes_only_declared_local_servers_without_following_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for status in [
            "200 OK",
            "302 Found",
            "404 Not Found",
            "503 Service Unavailable",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let reply = format!("HTTP/1.1 {status}\r\nLocation: http://192.0.2.1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let n = stream.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("GET /preview "));
                stream.write_all(reply.as_bytes()).await.unwrap();
            });
            assert_eq!(
                url_ready(&format!("http://{address}/preview")).await,
                status.starts_with(['2', '3']),
                "{status}"
            );
            server.await.unwrap();
        }
        // A valid remote destination is ready without a native network request.
        assert!(url_ready("http://192.0.2.1/preview").await);
        assert!(!url_ready("file:///tmp/index.html").await);
        assert!(!url_ready("http://user:secret@192.0.2.1").await);
        let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = unused.local_addr().unwrap();
        drop(unused);
        assert!(!url_ready(&format!("http://{address}/")).await);
    }
}
