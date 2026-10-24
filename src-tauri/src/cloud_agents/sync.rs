//! Moves the checkout between the mirror worktree and a cloud machine with git bundles
//! (docs/cloud-agents.md, steps 4 and 7).
use crate::cloud::sandbox::Sandbox;
use crate::Result;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const DOWNLOAD_CHUNK: usize = 96 * 1024;
const UPLOAD_CHUNK: usize = 46 * 1024;
const STATE_LIMIT: u64 = 64 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

/// What a pull brought back.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Pulled {
    /// New commits fetched from the machine.
    pub commits: usize,
    /// The mirror worktree was fast-forwarded; false when it had local edits (the commits
    /// wait on `refs/pandacode/cloud/<task id>`).
    pub applied: bool,
    /// A short sentence for the task when something needs the user's attention.
    pub note: Option<String>,
}

/// Sends the mirror worktree's HEAD to `remote_dir` (absolute) as a fresh clone on the
/// branch `branch`; returns the commit the machine starts from.
pub(crate) fn upload_checkout(
    sandbox: &dyn Sandbox,
    native: &str,
    local: &Path,
    remote_dir: &str,
    branch: &str,
) -> Result<String> {
    validate_branch(branch)?;
    let bundle = TempPath::new("checkout.bundle");
    local_git(
        local,
        &[
            "bundle",
            "create",
            bundle.as_str(),
            &format!("refs/heads/{branch}"),
        ],
    )?;
    let bytes = fs::read(&bundle.0).map_err(|_| "Could not read the local checkout bundle.")?;
    let remote_bundle = format!(
        "{remote_dir}.pandacode-upload-{}.bundle",
        uuid::Uuid::new_v4()
    );
    upload_file(sandbox, native, &remote_bundle, &bytes, false)?;
    let command = format!(
        r#"set -eu
bundle={bundle}
dir={dir}
trap 'rm -f "$bundle"' EXIT
mkdir -p "$(dirname "$dir")"
git clone --branch {branch} "$bundle" "$dir"
git -C "$dir" config user.name >/dev/null 2>&1 || git -C "$dir" config user.name 'PandaCode Cloud Agent'
git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email 'cloud-agent@pandacode.invalid'
printf 'PANDACODE_HEAD %s\n' "$(git -C "$dir" rev-parse HEAD)"
"#,
        bundle = crate::cloud::shell_quote(&remote_bundle),
        dir = crate::cloud::shell_quote(remote_dir),
        branch = crate::cloud::shell_quote(branch),
    );
    let output = remote_exec(sandbox, native, &command, COMMAND_TIMEOUT)?;
    output
        .lines()
        .find_map(|line| line.strip_prefix("PANDACODE_HEAD "))
        .filter(|sha| is_sha(sha))
        .map(str::to_owned)
        .ok_or_else(|| {
            "The cloud machine cloned the checkout but did not return its starting revision.".into()
        })
}
/// Commits the machine's changes (`message`), fetches commits after `base` into the
/// mirror worktree and fast-forwards it when clean. `task_id` names the waiting ref.
pub(crate) fn pull_changes(
    sandbox: &dyn Sandbox,
    native: &str,
    remote_dir: &str,
    local: &Path,
    task_id: &str,
    message: &str,
) -> Result<Pulled> {
    validate_ref_component(task_id)?;
    let base = local_git(local, &["rev-parse", "HEAD"])?;
    if !is_sha(&base) {
        return Err("The mirror worktree did not return a valid Git revision.".into());
    }
    let home = remote_home(sandbox, native)?;
    let remote_bundle = format!("{home}/.pandacode/pull-{}.bundle", uuid::Uuid::new_v4());
    let base_q = crate::cloud::shell_quote(&base);
    let dir_q = crate::cloud::shell_quote(remote_dir);
    let bundle_q = crate::cloud::shell_quote(&remote_bundle);
    let message = if message.trim().is_empty() {
        "Cloud changes"
    } else {
        message
    };
    let message_q = crate::cloud::shell_quote(message);
    let prepare = format!(
        r#"set -eu
dir={dir_q}
bundle={bundle_q}
mkdir -p "$(dirname "$bundle")"
if [ -n "$(git -C "$dir" status --porcelain)" ]; then
  git -C "$dir" config user.name >/dev/null 2>&1 || git -C "$dir" config user.name 'PandaCode Cloud Agent'
  git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email 'cloud-agent@pandacode.invalid'
  git -C "$dir" add -A
  git -C "$dir" -c core.hooksPath=/dev/null commit -m {message_q}
fi
if git -C "$dir" cat-file -e {base_q}^{{commit}} 2>/dev/null; then
  count=$(git -C "$dir" rev-list --count {base_q}..HEAD)
  if [ "$count" -eq 0 ]; then printf 'PANDACODE_NO_CHANGES\n'; exit 0; fi
  git -C "$dir" bundle create "$bundle" {base_q}..HEAD
else
  git -C "$dir" bundle create "$bundle" HEAD
fi
printf 'PANDACODE_BUNDLE %s\n' "$bundle"
"#
    );
    let output = remote_exec(sandbox, native, &prepare, COMMAND_TIMEOUT)?;
    if output.lines().any(|line| line == "PANDACODE_NO_CHANGES") {
        return Ok(Pulled {
            commits: 0,
            applied: false,
            note: None,
        });
    }
    let remote_bundle = output
        .lines()
        .find_map(|line| line.strip_prefix("PANDACODE_BUNDLE "))
        .ok_or("The cloud machine did not prepare a Git bundle.")?;
    if !remote_bundle.starts_with('/') {
        return Err("The cloud machine did not return an absolute Git bundle path.".into());
    }
    let bundle_local = TempPath::new("pull.bundle");
    download_file(sandbox, native, remote_bundle, &bundle_local.0)?;
    let cleanup = format!("rm -f {}", crate::cloud::shell_quote(remote_bundle));
    let _ = remote_exec(sandbox, native, &cleanup, Duration::from_secs(30));

    let reference = format!("refs/pandacode/cloud/{task_id}");
    local_git(
        local,
        &["fetch", bundle_local.as_str(), &format!("HEAD:{reference}")],
    )?;
    let commits = local_git(
        local,
        &["rev-list", "--count", &format!("{base}..{reference}")],
    )?
    .parse::<usize>()
    .map_err(|_| "Could not count the fetched cloud commits.")?;
    let clean = local_git(local, &["status", "--porcelain"])?.is_empty();
    if !clean {
        return Ok(Pulled { commits, applied: false, note: Some(format!("The mirror worktree has local edits; cloud changes are available at `{reference}`.")) });
    }
    if !local_is_ancestor(local, &base, &reference)? {
        return Ok(Pulled { commits, applied: false, note: Some(format!("Cloud changes diverged from the mirror worktree; they are available at `{reference}`.")) });
    }
    local_git(local, &["merge", "--ff-only", &reference])?;
    Ok(Pulled {
        commits,
        applied: true,
        note: None,
    })
}
/// Sends local commits the machine lacks (the mirror worktree moved ahead) before a run.
pub(crate) fn push_local(
    sandbox: &dyn Sandbox,
    native: &str,
    remote_dir: &str,
    local: &Path,
) -> Result<()> {
    let local_head = local_git(local, &["rev-parse", "HEAD"])?;
    if !is_sha(&local_head) {
        return Err("The mirror worktree did not return a valid Git revision.".into());
    }
    let dir_q = crate::cloud::shell_quote(remote_dir);
    let commit_remote = format!(
        r#"set -eu
dir={dir_q}
if [ -n "$(git -C "$dir" status --porcelain)" ]; then
  git -C "$dir" config user.name >/dev/null 2>&1 || git -C "$dir" config user.name 'PandaCode Cloud Agent'
  git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email 'cloud-agent@pandacode.invalid'
  git -C "$dir" add -A
  git -C "$dir" -c core.hooksPath=/dev/null commit -m 'Cloud changes before mirror sync'
fi
printf 'PANDACODE_HEAD %s\n' "$(git -C "$dir" rev-parse HEAD)"
"#
    );
    let base = remote_exec(sandbox, native, &commit_remote, Duration::from_secs(120))?;
    let remote_head = base
        .lines()
        .find_map(|line| line.strip_prefix("PANDACODE_HEAD "))
        .unwrap_or_default();
    if !is_sha(remote_head) {
        return Err("The cloud checkout did not return a valid Git revision.".into());
    }
    let local_head_q = crate::cloud::shell_quote(&local_head);
    let relation = format!(
        r#"if git -C {dir_q} cat-file -e {local_head_q}^{{commit}} 2>/dev/null; then
  if git -C {dir_q} merge-base --is-ancestor {local_head_q} HEAD; then printf yes; else code=$?; [ "$code" -eq 1 ] || exit "$code"; printf no; fi
else printf no; fi"#
    );
    if remote_exec(sandbox, native, &relation, Duration::from_secs(30))?.trim() == "yes" {
        return Ok(());
    }

    let bundle = TempPath::new("push.bundle");
    let local_has_remote = local_has_commit(local, remote_head)?;
    if local_has_remote {
        local_git(
            local,
            &[
                "bundle",
                "create",
                bundle.as_str(),
                &format!("{remote_head}..HEAD"),
            ],
        )?;
    } else {
        local_git(local, &["bundle", "create", bundle.as_str(), "HEAD"])?;
    }
    let bytes = fs::read(&bundle.0).map_err(|_| "Could not read the local commits bundle.")?;
    let home = remote_home(sandbox, native)?;
    let remote_bundle = format!("{home}/.pandacode/push-{}.bundle", uuid::Uuid::new_v4());
    upload_file(sandbox, native, &remote_bundle, &bytes, false)?;
    let remote_ref = format!("refs/pandacode/local-sync/{}", uuid::Uuid::new_v4());
    let command = format!(
        r#"set -eu
dir={dir}
bundle={bundle}
ref={reference}
trap 'rm -f "$bundle"' EXIT
git -C "$dir" fetch "$bundle" HEAD:"$ref"
git -C "$dir" merge --ff-only "$ref"
"#,
        dir = dir_q,
        bundle = crate::cloud::shell_quote(&remote_bundle),
        reference = crate::cloud::shell_quote(&remote_ref),
    );
    remote_exec(sandbox, native, &command, COMMAND_TIMEOUT)
        .map(|_| ())
        .map_err(|_| "The local mirror commits cannot be fast-forwarded onto the cloud checkout. Pull the cloud changes and resolve the histories in the mirror worktree first.".into())
}
/// Saves the harness's session files for `remote_dir` from the machine into `store`.
pub(crate) fn save_harness_state(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
    remote_dir: &str,
    store: &Path,
) -> Result<()> {
    let home = remote_home(sandbox, native)?;
    let state = state_dir(harness, remote_dir, &home)?;
    let archive = format!("{home}/.pandacode/state-{}.tgz", uuid::Uuid::new_v4());
    let parent = Path::new(&state)
        .parent()
        .ok_or("Could not find the harness session folder.")?;
    let name = Path::new(&state)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Could not identify the harness session folder.")?;
    let command = format!(
        r#"set -eu
umask 077
state={state}
archive={archive}
if [ ! -d "$state" ]; then printf 'PANDACODE_NO_STATE\n'; exit 0; fi
mkdir -p "$(dirname "$archive")"
tar -czf "$archive" -C {parent} -- {name}
size=$(wc -c < "$archive" | tr -d ' ')
if [ "$size" -gt {limit} ]; then rm -f "$archive"; printf 'PANDACODE_TOO_LARGE %s\n' "$size"; exit 0; fi
printf 'PANDACODE_STATE %s\n' "$size"
"#,
        state = crate::cloud::shell_quote(&state),
        archive = crate::cloud::shell_quote(&archive),
        parent = crate::cloud::shell_quote(&parent.to_string_lossy()),
        name = crate::cloud::shell_quote(name),
        limit = STATE_LIMIT,
    );
    let output = remote_exec(sandbox, native, &command, COMMAND_TIMEOUT)?;
    if output.contains("PANDACODE_NO_STATE") {
        return Ok(());
    }
    if output.contains("PANDACODE_TOO_LARGE") {
        return Err("Harness state was skipped because its compressed archive exceeds the 64 MiB transfer limit.".into());
    }
    if !output.contains("PANDACODE_STATE") {
        return Err("The cloud machine did not prepare the harness session archive.".into());
    }
    let local_archive = TempPath::new("state.tgz");
    download_file(sandbox, native, &archive, &local_archive.0)?;
    let _ = remote_exec(
        sandbox,
        native,
        &format!("rm -f {}", crate::cloud::shell_quote(&archive)),
        Duration::from_secs(30),
    );
    let bytes = fs::read(&local_archive.0)
        .map_err(|_| "Could not read the downloaded harness state archive.")?;
    if bytes.len() as u64 > STATE_LIMIT {
        return Err("Harness state was skipped because its compressed archive exceeds the 64 MiB transfer limit.".into());
    }
    fs::create_dir_all(store).map_err(|_| "Could not create the local harness state folder.")?;
    write_atomic(&store.join(format!("{harness}.tgz")), &bytes)
}
/// Puts saved session files back on a recreated machine.
pub(crate) fn restore_harness_state(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
    remote_dir: &str,
    store: &Path,
) -> Result<()> {
    let local_archive = store.join(format!("{harness}.tgz"));
    let bytes = match fs::read(&local_archive) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Could not read the saved harness state archive.".into()),
    };
    if bytes.len() as u64 > STATE_LIMIT {
        return Err("Harness state restore was skipped because its archive exceeds the 64 MiB transfer limit.".into());
    }
    let home = remote_home(sandbox, native)?;
    let state = state_dir(harness, remote_dir, &home)?;
    let parent = Path::new(&state)
        .parent()
        .ok_or("Could not find the harness session folder.")?;
    let remote_archive = format!("{home}/.pandacode/restore-{}.tgz", uuid::Uuid::new_v4());
    upload_file(sandbox, native, &remote_archive, &bytes, true)?;
    let command = format!(
        r#"set -eu
archive={archive}
mkdir -p {parent}
tar -xzf "$archive" -C {parent}
rm -f "$archive"
"#,
        archive = crate::cloud::shell_quote(&remote_archive),
        parent = crate::cloud::shell_quote(&parent.to_string_lossy()),
    );
    remote_exec(sandbox, native, &command, COMMAND_TIMEOUT).map(|_| ())
}

fn upload_file(
    sandbox: &dyn Sandbox,
    native: &str,
    destination: &str,
    bytes: &[u8],
    private: bool,
) -> Result<()> {
    if bytes.len() <= UPLOAD_CHUNK {
        return sandbox
            .upload(native, destination, bytes, private)
            .map_err(|_| "Could not upload a file to the cloud machine.".into());
    }
    let directory = format!("{destination}.parts-{}", uuid::Uuid::new_v4());
    for (index, chunk) in bytes.chunks(UPLOAD_CHUNK).enumerate() {
        let part = format!("{directory}/chunk-{index:08}");
        if sandbox.upload(native, &part, chunk, private).is_err() {
            let _ = remote_exec(
                sandbox,
                native,
                &format!("rm -rf {}", crate::cloud::shell_quote(&directory)),
                Duration::from_secs(30),
            );
            return Err("Could not upload a file to the cloud machine.".into());
        }
    }
    let command = format!(
        "set -eu; umask {}; dir={}; trap 'rm -rf \"$dir\"' EXIT; cat \"$dir\"/chunk-* > {}",
        if private { "077" } else { "022" },
        crate::cloud::shell_quote(&directory),
        crate::cloud::shell_quote(destination),
    );
    remote_exec(sandbox, native, &command, COMMAND_TIMEOUT).map(|_| ())
}

struct TempPath(PathBuf);
impl TempPath {
    fn new(suffix: &str) -> Self {
        Self(
            std::env::temp_dir().join(format!("pandacode-cloud-{}-{suffix}", uuid::Uuid::new_v4())),
        )
    }
    fn as_str(&self) -> &str {
        self.0.to_str().expect("temporary paths are UTF-8")
    }
}
impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn local_git(root: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    let output =
        crate::workspace::run_process(command, "Git cloud sync", 4 * 1024 * 1024, COMMAND_TIMEOUT)?;
    let capture = crate::workspace::checked(output)?;
    Ok(String::from_utf8_lossy(&capture.bytes).trim().to_owned())
}

fn local_git_status(root: &Path, args: &[&str]) -> Result<bool> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    let output =
        crate::workspace::run_process(command, "Git cloud sync", 4 * 1024 * 1024, COMMAND_TIMEOUT)?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => crate::workspace::checked(output).map(|_| true),
    }
}

fn local_has_commit(root: &Path, sha: &str) -> Result<bool> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["cat-file", "-e", &format!("{sha}^{{commit}}")]);
    let output = crate::workspace::run_process(command, "Git cloud sync", 1024, COMMAND_TIMEOUT)?;
    Ok(output.status.success())
}

fn local_is_ancestor(root: &Path, base: &str, target: &str) -> Result<bool> {
    local_git_status(root, &["merge-base", "--is-ancestor", base, target])
}

fn remote_exec(
    sandbox: &dyn Sandbox,
    native: &str,
    command: &str,
    timeout: Duration,
) -> Result<String> {
    if command.len() >= 64 * 1024 {
        return Err("Cloud Git command exceeded the sandbox limit.".into());
    }
    let (code, output) = sandbox.exec(native, command, timeout)?;
    crate::cloud::sandbox::checked((code, output.clone()))?;
    Ok(output.trim().to_owned())
}

fn remote_home(sandbox: &dyn Sandbox, native: &str) -> Result<String> {
    let home = remote_exec(
        sandbox,
        native,
        "printf '%s\\n' \"$HOME\"",
        Duration::from_secs(30),
    )?;
    if !home.starts_with('/') {
        return Err("The cloud machine did not report an absolute home folder.".into());
    }
    Ok(home)
}

fn download_file(sandbox: &dyn Sandbox, native: &str, remote: &str, local: &Path) -> Result<()> {
    let mut file =
        fs::File::create(local).map_err(|_| "Could not create a temporary cloud bundle file.")?;
    let mut offset = 0u64;
    loop {
        let bytes = sandbox.download(native, remote, offset, DOWNLOAD_CHUNK)?;
        if bytes.len() > DOWNLOAD_CHUNK {
            return Err("The cloud machine returned an oversized file chunk.".into());
        }
        if bytes.is_empty() {
            break;
        }
        use std::io::Write;
        file.write_all(&bytes)
            .map_err(|_| "Could not write a downloaded cloud bundle.")?;
        offset = offset.saturating_add(bytes.len() as u64);
    }
    if offset == 0 {
        return Err("The cloud machine did not return a Git bundle.".into());
    }
    Ok(())
}

fn validate_branch(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains("@{")
        || branch.contains("//")
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with('.'))
        || !branch
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/-_ .".contains(ch) && ch != ' ')
    {
        return Err("Invalid cloud checkout branch name.".into());
    }
    Ok(())
}

fn validate_ref_component(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Invalid cloud task identifier for Git reference.".into());
    }
    Ok(())
}

fn is_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn state_dir(harness: &str, remote_dir: &str, home: &str) -> Result<String> {
    let relative = match harness {
        "claude" | "glm" | "mimo" => {
            if !remote_dir.starts_with('/') {
                return Err("Cloud checkout paths must be absolute.".into());
            }
            let project = remote_dir
                .chars()
                .map(|ch| if ch == '/' || ch == '.' { '-' } else { ch })
                .collect::<String>();
            format!(".claude/projects/{project}")
        }
        "codex" => ".codex/sessions".into(),
        "opencode" => ".local/share/opencode/storage".into(),
        _ => return Err(format!("Unsupported cloud agent harness '{harness}'.")),
    };
    Ok(format!("{home}/{relative}"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or("Could not find the local harness state folder.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the local harness state folder.")?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| "Could not save the local harness state archive.")?;
    use std::io::Write;
    file.write_all(bytes)
        .map_err(|_| "Could not save the local harness state archive.")?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "Could not replace the saved harness state archive.")?;
    }
    fs::rename(&temp, path).map_err(|_| {
        let _ = fs::remove_file(&temp);
        "Could not save the local harness state archive.".to_owned()
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::cloud::{sandbox::Info, Machine};
    use std::{fs, path::PathBuf, process::Command, sync::Mutex, time::Duration};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("pandacode-cloud-{label}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FakeSandbox {
        root: PathBuf,
        uploads: Mutex<Vec<usize>>,
        downloads: Mutex<Vec<usize>>,
    }
    impl FakeSandbox {
        fn new(root: &Path) -> Self {
            let home = root.join("home");
            fs::create_dir_all(&home).unwrap();
            Self {
                root: root.into(),
                uploads: Mutex::new(Vec::new()),
                downloads: Mutex::new(Vec::new()),
            }
        }
    }
    impl Sandbox for FakeSandbox {
        fn info(&self) -> Info {
            Info {
                persistent: true,
                max_unattended_minutes: 60,
            }
        }
        fn list(&self) -> Result<Vec<Machine>> {
            Ok(Vec::new())
        }
        fn create(&self, _name: &str) -> Result<Machine> {
            Err("unused".into())
        }
        fn power(&self, _native: &str, _action: &str) -> Result<()> {
            Ok(())
        }
        fn exec(
            &self,
            _native: &str,
            command: &str,
            _timeout: Duration,
        ) -> Result<(Option<i32>, String)> {
            assert!(command.len() < 64 * 1024);
            if command.contains("base64 -d") {
                let start = command.find("printf %s ").unwrap() + "printf %s ".len();
                let end = command[start..].find(" | base64 -d").unwrap() + start;
                let encoded = &command[start..end];
                let padding = encoded.ends_with("==") as usize
                    + (encoded.ends_with('=') && !encoded.ends_with("==")) as usize;
                self.uploads
                    .lock()
                    .unwrap()
                    .push(encoded.len() * 3 / 4 - padding);
            }
            let output = Command::new("sh")
                .args(["-c", command])
                .current_dir(&self.root)
                .env("HOME", self.root.join("home"))
                .output()
                .map_err(|e| e.to_string())?;
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            Ok((output.status.code(), text))
        }
        fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
            Ok(())
        }
        fn download(&self, _native: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
            assert!(max <= 128 * 1024);
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error.to_string()),
            };
            let start = usize::try_from(offset)
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            let chunk = bytes[start..bytes.len().min(start.saturating_add(max))].to_vec();
            self.downloads.lock().unwrap().push(chunk.len());
            Ok(chunk)
        }
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        command.arg("-C").arg(root).args(args);
        let output = crate::workspace::run_process(
            command,
            "Git test",
            1024 * 1024,
            Duration::from_secs(30),
        )
        .unwrap();
        let capture = crate::workspace::checked(output).unwrap();
        String::from_utf8_lossy(&capture.bytes).trim().to_owned()
    }

    fn repo(root: &Path, large: bool) -> PathBuf {
        let path = root.join("local");
        fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-b", "main"]);
        git(&path, &["config", "user.name", "Test User"]);
        git(&path, &["config", "user.email", "test@example.invalid"]);
        fs::write(path.join("README.md"), "initial\n").unwrap();
        if large {
            let mut data = vec![0u8; 512 * 1024];
            let mut state = 0x1234_5678u32;
            for byte in &mut data {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = state as u8;
            }
            fs::write(path.join("large.bin"), data).unwrap();
        }
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-m", "initial"]);
        path
    }

    fn checkout(root: &Path) -> (FakeSandbox, PathBuf, String) {
        let local = repo(root, true);
        let sandbox = FakeSandbox::new(&root.join("sandbox"));
        let remote = root.join("sandbox/home/pandacode/task");
        let remote = remote.to_string_lossy().into_owned();
        let sha = upload_checkout(&sandbox, "fake", &local, &remote, "main").unwrap();
        assert_eq!(git(Path::new(&remote), &["rev-parse", "HEAD"]), sha);
        (sandbox, local, remote)
    }

    #[test]
    fn checkout_pull_fast_forwards_and_transfers_large_bundles_in_bounded_chunks() {
        let temp = TempDir::new("roundtrip");
        let (sandbox, local, remote) = checkout(&temp.0);
        let upload_commands = sandbox.uploads.lock().unwrap();
        assert!(upload_commands.len() > 1);
        assert!(upload_commands.iter().sum::<usize>() > 200 * 1024);

        let mut remote_data = vec![0u8; 512 * 1024];
        let mut state = 0x8765_4321u32;
        for byte in &mut remote_data {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *byte = state as u8;
        }
        fs::write(Path::new(&remote).join("remote.bin"), remote_data).unwrap();
        git(Path::new(&remote), &["add", "-A"]);
        git(Path::new(&remote), &["commit", "-m", "remote change"]);

        let pulled =
            pull_changes(&sandbox, "fake", &remote, &local, "task-1", "Cloud changes").unwrap();
        assert!(pulled.applied);
        assert!(pulled.commits >= 1);
        assert!(local.join("remote.bin").exists());
        let downloaded_chunks = sandbox.downloads.lock().unwrap();
        assert!(downloaded_chunks.len() >= 3);
        assert!(downloaded_chunks.iter().all(|size| *size <= 128 * 1024));
        assert!(downloaded_chunks.iter().sum::<usize>() > 200 * 1024);
    }

    #[test]
    fn dirty_local_checkout_keeps_cloud_ref_without_applying() {
        let temp = TempDir::new("dirty");
        let (sandbox, local, remote) = checkout(&temp.0);
        fs::write(Path::new(&remote).join("remote.txt"), "cloud\n").unwrap();
        git(Path::new(&remote), &["add", "-A"]);
        git(Path::new(&remote), &["commit", "-m", "cloud change"]);
        fs::write(local.join("README.md"), "local dirty\n").unwrap();

        let pulled = pull_changes(
            &sandbox,
            "fake",
            &remote,
            &local,
            "task-dirty",
            "Cloud changes",
        )
        .unwrap();
        assert!(!pulled.applied);
        assert!(pulled.note.is_some());
        assert!(!git(
            &local,
            &["rev-parse", "--verify", "refs/pandacode/cloud/task-dirty"]
        )
        .is_empty());
        assert_eq!(
            fs::read_to_string(local.join("README.md")).unwrap(),
            "local dirty\n"
        );
    }

    #[test]
    fn push_local_sends_mirror_commits_to_machine() {
        let temp = TempDir::new("push");
        let (sandbox, local, remote) = checkout(&temp.0);
        fs::write(local.join("local.txt"), "local commit\n").unwrap();
        git(&local, &["add", "-A"]);
        git(&local, &["commit", "-m", "local change"]);

        push_local(&sandbox, "fake", &remote, &local).unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]),
            git(Path::new(&remote), &["rev-parse", "HEAD"])
        );
        assert_eq!(
            fs::read_to_string(Path::new(&remote).join("local.txt")).unwrap(),
            "local commit\n"
        );
    }

    #[test]
    fn claude_harness_state_round_trips() {
        let temp = TempDir::new("state");
        let (sandbox, _local, remote) = checkout(&temp.0);
        let project_name = remote
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect::<String>();
        let state = temp
            .0
            .join("sandbox/home/.claude/projects")
            .join(project_name);
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("session.jsonl"), "session state\n").unwrap();
        let store = temp.0.join("store");
        save_harness_state(&sandbox, "fake", "claude", &remote, &store).unwrap();
        fs::remove_dir_all(&state).unwrap();
        restore_harness_state(&sandbox, "fake", "claude", &remote, &store).unwrap();
        assert_eq!(
            fs::read_to_string(state.join("session.jsonl")).unwrap(),
            "session state\n"
        );
    }
}
