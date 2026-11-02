//! Installs the agent runtime on a cloud machine (docs/cloud-agents.md, step 2).
use crate::cloud::sandbox::Sandbox;
use crate::Result;
use std::time::Duration;

/// Harnesses that can run on a cloud machine.
pub(crate) const HARNESSES: [&str; 5] = ["claude", "glm", "mimo", "codex", "opencode"];

/// Suffix of the runtime-marker sibling naming a host version npm does not publish.
const UNPUBLISHED: &str = ".unpublished";

/// Makes sure `harness` can run on the machine; returns the absolute path of the program
/// to execute there (for `glm`/`mimo`, Claude Code). `version` is the harness's own
/// `--version` line on this computer, when known: the machine then runs exactly that
/// version instead of the npm latest, whose model catalog can differ (issue #206).
/// Idempotent and quick when installed.
pub(crate) fn ensure_runtime(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
    version: Option<&str>,
    progress: &dyn Fn(&str),
) -> Result<String> {
    if !HARNESSES.contains(&harness) {
        return Err(format!(
            "Unsupported cloud agent harness '{harness}'. Supported harnesses: {}.",
            HARNESSES.join(", ")
        ));
    }
    let cli = match harness {
        "claude" | "glm" | "mimo" => "claude",
        "codex" => "codex",
        "opencode" => "opencode",
        _ => unreachable!(),
    };
    let onboarding = if matches!(harness, "claude" | "glm" | "mimo") {
        r#"  if [ ! -e "$HOME/.claude.json" ]; then
    (umask 077; printf '{"hasCompletedOnboarding":true}\n' > "$HOME/.claude.json")
    chmod 600 "$HOME/.claude.json"
  fi"#
    } else {
        ""
    };
    // OpenCode's marker is keyed by the host's generation, so a machine provisioned
    // for one never reuses another's runtime (issue #209); the rest keep their name.
    let runtime = if harness == "opencode" {
        opencode_runtime(version)
    } else {
        harness.to_owned()
    };
    // The cache gate compares the machine's own `--version` line, so it asks for the
    // parsed pin, not the raw host output: a bare `2` or a prefixed line like
    // "OpenCode 2.1.2" would otherwise never match a freshly installed CLI and
    // reinstall on every run.
    let pin = opencode_pin(version);
    if let Some(path) = cached_program(sandbox, native, &runtime, pin.as_deref(), onboarding)? {
        return Ok(path);
    }

    let (arch, libc) = detect_linux(sandbox, native)?;
    let mut tools = vec!["git", "curl", "tar"];
    if matches!(harness, "claude" | "glm" | "mimo") {
        tools.push("bash");
    }
    ensure_tools(sandbox, native, &tools, progress)?;
    match harness {
        "claude" | "glm" | "mimo" => {
            progress("Installing Claude Code…");
            let attempt = sandbox.exec(native, r#"set -u
home=$(cd "$HOME" && pwd -P)
export PATH="$home/.local/bin:$home/.pandacode/npm/bin:$home/.pandacode/node/bin:$PATH"
if curl -fsSL https://claude.ai/install.sh | bash && command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1; then exit 0; fi
exit 31
"#, Duration::from_secs(900))?;
            if attempt.0 != Some(0) {
                ensure_node(sandbox, native, &arch, &libc, progress)?;
                progress("Installing Claude Code with npm…");
                execute(
                    sandbox,
                    native,
                    r#"set -eu
home=$(cd "$HOME" && pwd -P)
export PATH="$home/.pandacode/node/bin:$home/.pandacode/npm/bin:$home/.local/bin:$PATH"
mkdir -p "$home/.pandacode/npm"
npm install -g --prefix "$home/.pandacode/npm" @anthropic-ai/claude-code
"#,
                )?;
            }
        }
        "codex" | "opencode" => {
            ensure_node(sandbox, native, &arch, &libc, progress)?;
            let (label, steps) = if harness == "codex" {
                ("Installing Codex CLI…".to_owned(), npm_install("@openai/codex"))
            } else {
                let label = match &pin {
                    Some(pin) => format!("Installing OpenCode {pin}…"),
                    None => "Installing OpenCode…".to_owned(),
                };
                (label, opencode_install_steps(version, &runtime))
            };
            progress(&label);
            execute(
                sandbox,
                native,
                &format!(
                    r#"set -eu
home=$(cd "$HOME" && pwd -P)
export PATH="$home/.pandacode/node/bin:$home/.pandacode/npm/bin:$home/.local/bin:$PATH"
mkdir -p "$home/.pandacode/npm" "$home/.pandacode/runtime"
{steps}
"#
                ),
            )?;
        }
        _ => unreachable!(),
    }
    let path = mark_runtime(sandbox, native, &runtime, cli)?;
    if matches!(harness, "claude" | "glm" | "mimo") {
        ensure_onboarding_file(sandbox, native)?;
    }
    Ok(path)
}

/// The harness installed by a previous run, when its program still runs and — for a pinned
/// version — reports exactly that version, or that version is recorded as unpublished on
/// npm, so the latest release stands in until the host's version changes. The comparison
/// asks the program itself (stdout only, both sides) rather than the marker's stored line,
/// whose capture merges stderr on the machine: an asymmetric channel would reinstall on
/// every run (review finding).
fn cached_program(
    sandbox: &dyn Sandbox,
    native: &str,
    runtime: &str,
    version: Option<&str>,
    onboarding: &str,
) -> Result<Option<String>> {
    let version_clause = match version {
        Some(version) => {
            let version = crate::cloud::shell_quote(version);
            format!(
                " && {{ [ \"$(\"$program\" --version 2>/dev/null | sed -n '1p')\" = {version} ] || [ \"$(cat \"$marker{UNPUBLISHED}\" 2>/dev/null)\" = {version} ]; }}"
            )
        }
        None => String::new(),
    };
    let cached = execute(
        sandbox,
        native,
        &format!(
            r#"set -eu
marker="$HOME/.pandacode/runtime/{runtime}"
if [ -s "$marker" ]; then
  program=$(sed -n '1p' "$marker")
  if [ "${{program#/}}" != "$program" ] && [ -x "$program" ] && "$program" --version >/dev/null 2>&1{version_clause}; then
{onboarding}
    printf '%s\n' "$program"
  fi
fi
"#,
            onboarding = onboarding,
            version_clause = version_clause,
        ),
    )?;
    Ok(cached
        .lines()
        .last()
        .filter(|line| line.starts_with('/'))
        .map(str::to_owned))
}

/// The npm pin from a harness's `--version` output: the first `vMAJOR.MINOR.PATCH` token
/// on any line (a pre-release or build suffix rides along). None for anything else, which
/// installs the latest release as before.
pub(crate) fn parse_version(raw: &str) -> Option<String> {
    raw.lines()
        .find_map(|line| line.split_whitespace().find(|token| is_version(token)))
        .map(|token| token.trim_start_matches('v').to_owned())
}

fn is_version(token: &str) -> bool {
    let core = token.trim_start_matches('v');
    // A pre-release (-beta.3) or build (+build) suffix may hold dots, so it splits off
    // before the numeric core is checked.
    let (numbers, suffix) = match core.split_once(['-', '+']) {
        Some((numbers, suffix)) => (numbers, Some(suffix)),
        None => (core, None),
    };
    let mut parts = numbers.split('.');
    let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(major), Some(minor), Some(patch), None) => {
            let suffix_ok = suffix.is_none_or(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
            });
            numeric(major) && numeric(minor) && numeric(patch) && suffix_ok
        }
        _ => false,
    }
}

/// The host's OpenCode generation (its `--version` major), looser than
/// `parse_version` so a bare `2`, `v2` or `2.x` still selects the right package.
fn parse_generation(raw: &str) -> Option<u32> {
    raw.lines().find_map(|line| {
        line.split_whitespace().find_map(|token| {
            let digits: String = token
                .trim_start_matches('v')
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
    })
}

/// The host's OpenCode generation (its `--version` major): the pin's major when
/// one parses, else a looser token read so a bare `2`, `v2` or `2.x` still
/// selects the right package and marker.
fn host_generation(version: Option<&str>) -> Option<u32> {
    version
        .and_then(parse_version)
        .and_then(|pin| pin.split('.').next().and_then(|major| major.parse().ok()))
        .or_else(|| version.and_then(parse_generation))
}

/// The version to pin: major 0 (`0.0.0-beta-19507`) is a local or preview build that npm
/// does not carry, so it installs unpinned.
fn opencode_pin(version: Option<&str>) -> Option<String> {
    version
        .and_then(parse_version)
        .filter(|pin| !pin.starts_with("0."))
}

/// The npm packages for the machine's OpenCode, its own generation's first: v2 hosts run
/// `@opencode/cli` because `opencode-ai` publishes only 1.x and npm has no
/// `opencode-ai@2.x` (issue #209).
fn opencode_packages(version: Option<&str>) -> (&'static str, &'static str) {
    if host_generation(version).unwrap_or(1) >= 2 {
        ("@opencode/cli", "opencode-ai")
    } else {
        ("opencode-ai", "@opencode/cli")
    }
}

/// `opencode_packages`' own package, pinned to the host's version when one parses.
fn opencode_package(version: Option<&str>) -> String {
    let (package, _) = opencode_packages(version);
    match opencode_pin(version) {
        Some(pin) => format!("{package}@{pin}"),
        None => package.to_owned(),
    }
}

fn npm_install(package: &str) -> String {
    format!(
        r#"npm install -g --prefix "$home/.pandacode/npm" {}"#,
        crate::cloud::shell_quote(package)
    )
}

/// Both OpenCode packages own `bin/opencode`, so the other generation's goes first or npm
/// fails with EEXIST. A pin npm does not publish falls back to the latest release and is
/// recorded beside the marker, so `cached_program` keeps that install instead of
/// reinstalling on every run.
fn opencode_install_steps(version: Option<&str>, runtime: &str) -> String {
    let (package, other) = opencode_packages(version);
    let uninstall = format!(
        r#"npm uninstall -g --prefix "$home/.pandacode/npm" {} >/dev/null 2>&1 || true"#,
        crate::cloud::shell_quote(other)
    );
    let unpublished = format!(r#""$home/.pandacode/runtime/{runtime}{UNPUBLISHED}""#);
    let latest = npm_install(package);
    match opencode_pin(version) {
        Some(pin) => format!(
            "{uninstall}\nif {pinned}; then\n  rm -f {unpublished}\nelse\n  {latest}\n  printf '%s\\n' {quoted} > {unpublished}\nfi",
            pinned = npm_install(&opencode_package(version)),
            quoted = crate::cloud::shell_quote(&pin),
        ),
        None => format!("{uninstall}\n{latest}\nrm -f {unpublished}"),
    }
}

/// The runtime marker id for the opencode harness, keyed by the host's
/// generation so a machine provisioned for one generation never reuses
/// another's marker, including the plain `opencode` marker of older builds.
fn opencode_runtime(version: Option<&str>) -> String {
    match host_generation(version) {
        Some(major) => format!("opencode-{major}"),
        None => "opencode".to_owned(),
    }
}

fn execute(sandbox: &dyn Sandbox, native: &str, command: &str) -> Result<String> {
    if command.len() >= 64 * 1024 {
        return Err("Cloud runtime setup command exceeded the sandbox limit.".into());
    }
    let (code, output) = sandbox.exec(native, command, Duration::from_secs(900))?;
    crate::cloud::sandbox::checked((code, output.clone()))?;
    Ok(output)
}

fn detect_linux(sandbox: &dyn Sandbox, native: &str) -> Result<(String, String)> {
    let output = execute(
        sandbox,
        native,
        r#"set -eu
[ "$(uname -s)" = Linux ] || { echo 'Cloud agent runtimes currently require Linux.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Cloud agent runtimes support x86_64 and arm64 Linux machines.' >&2; exit 1 ;;
esac
if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then libc=musl; else libc=glibc; fi
printf '%s %s\n' "$arch" "$libc"
"#,
    )?;
    let mut fields = output.split_whitespace();
    let arch = fields.next().unwrap_or_default();
    let libc = fields.next().unwrap_or_default();
    if !matches!(arch, "x64" | "arm64") || !matches!(libc, "glibc" | "musl") {
        return Err("Could not identify the cloud machine's Linux architecture.".into());
    }
    Ok((arch.to_owned(), libc.to_owned()))
}

fn ensure_tools(
    sandbox: &dyn Sandbox,
    native: &str,
    tools: &[&str],
    progress: &dyn Fn(&str),
) -> Result<()> {
    let checks = tools
        .iter()
        .map(|tool| {
            format!(
                "command -v {} >/dev/null 2>&1 || printf '%s\\n' {}",
                crate::cloud::shell_quote(tool),
                crate::cloud::shell_quote(tool)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let missing = execute(sandbox, native, &checks)?;
    let missing = missing.split_whitespace().collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    progress("Installing system tools…");
    let apt = package_names(&missing, "apt-get")?;
    let apk = package_names(&missing, "apk")?;
    let dnf = package_names(&missing, "dnf")?;
    let command = format!(
        r#"set -eu
as_root() {{ if [ "$(id -u)" -eq 0 ]; then "$@"; else command -v sudo >/dev/null 2>&1 || {{ echo 'Install the required tools as root or configure passwordless sudo.' >&2; return 1; }}; sudo -n "$@"; fi; }}
if command -v apt-get >/dev/null 2>&1; then as_root apt-get update -y; as_root apt-get install -y {apt}
elif command -v apk >/dev/null 2>&1; then as_root apk add --no-cache {apk}
elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y {dnf}
else echo 'Install the missing cloud agent tools with apt-get, apk, or dnf.' >&2; exit 1
fi
"#
    );
    execute(sandbox, native, &command)?;
    Ok(())
}

fn package_names(tools: &[&str], manager: &str) -> Result<String> {
    tools
        .iter()
        .map(|tool| match (*tool, manager) {
            ("git", _) => Ok("git"),
            ("curl", _) => Ok("curl"),
            ("tar", _) => Ok("tar"),
            ("bash", _) => Ok("bash"),
            ("xz", "apt-get") => Ok("xz-utils"),
            ("xz", _) => Ok("xz"),
            _ => Err("Unknown cloud runtime dependency.".into()),
        })
        .collect::<Result<Vec<_>>>()
        .map(|packages| packages.join(" "))
}

fn ensure_node(
    sandbox: &dyn Sandbox,
    native: &str,
    arch: &str,
    libc: &str,
    progress: &dyn Fn(&str),
) -> Result<()> {
    let ready = execute(
        sandbox,
        native,
        r#"home=$(cd "$HOME" && pwd -P)
export PATH="$home/.pandacode/node/bin:$PATH"
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null || printf 0)
  [ "$major" -ge 20 ] && printf yes || printf no
else printf no; fi
"#,
    )?;
    if ready.trim() == "yes" {
        return Ok(());
    }
    progress("Installing Node.js…");
    ensure_tools(sandbox, native, &["curl", "tar", "xz"], progress)?;
    let platform = if libc == "musl" {
        format!("linux-{arch}-musl")
    } else {
        format!("linux-{arch}")
    };
    let command = format!(
        r#"set -eu
home=$(cd "$HOME" && pwd -P)
root="$home/.pandacode"
mkdir -p "$root/node"
manifest=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
archive=$(printf '%s\n' "$manifest" | awk -v suffix="-{platform}.tar.xz" '$2 ~ /^node-v22\./ && substr($2, length($2)-length(suffix)+1) == suffix {{ print $2; exit }}')
[ -n "$archive" ] || {{ echo 'The official Node.js download did not list a compatible Linux tarball.' >&2; exit 1; }}
tmp="$root/node-download.tar.xz"
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$tmp"
xz -dc "$tmp" | tar -xf - -C "$root/node" --strip-components=1
rm -f "$tmp"
"$root/node/bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
"#
    );
    execute(sandbox, native, &command)?;
    Ok(())
}

fn mark_runtime(sandbox: &dyn Sandbox, native: &str, runtime: &str, cli: &str) -> Result<String> {
    let command = format!(
        r#"set -eu
home=$(cd "$HOME" && pwd -P)
export PATH="$home/.local/bin:$home/.pandacode/npm/bin:$home/.pandacode/node/bin:$PATH"
resolve() {{
  name=$1
  for dir in "$home/.local/bin" "$home/.pandacode/npm/bin" "$home/.pandacode/node/bin" /usr/local/bin /usr/bin /bin; do
    if [ -x "$dir/$name" ]; then printf '%s\n' "$dir/$name"; return 0; fi
  done
  found=$(command -v "$name" || true)
  case "$found" in /*) printf '%s\n' "$found" ;; *) return 1 ;; esac
}}
program=$(resolve {}) || {{ echo 'The harness installer completed, but its executable was not found.' >&2; exit 1; }}
"$program" --version >/dev/null 2>&1 || {{ echo 'The harness executable did not pass its version check.' >&2; exit 1; }}
version=$("$program" --version 2>&1 | sed -n '1p')
[ -n "$version" ] || {{ echo 'The harness executable did not return a version.' >&2; exit 1; }}
mkdir -p "$home/.pandacode/runtime"
tmp="$home/.pandacode/runtime/.{runtime}.$$"
printf '%s\n%s\n' "$program" "$version" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$home/.pandacode/runtime/{runtime}"
printf '%s\n' "$program"
"#,
        crate::cloud::shell_quote(cli)
    );
    let output = execute(sandbox, native, &command)?;
    let path = output.lines().last().unwrap_or_default();
    if !path.starts_with('/') {
        return Err("The cloud harness executable path was not absolute.".into());
    }
    Ok(path.to_owned())
}

fn ensure_onboarding_file(sandbox: &dyn Sandbox, native: &str) -> Result<()> {
    execute(
        sandbox,
        native,
        r#"set -eu
home=$(cd "$HOME" && pwd -P)
if [ ! -e "$home/.claude.json" ]; then
  umask 077
  printf '{"hasCompletedOnboarding":true}\n' > "$home/.claude.json"
  chmod 600 "$home/.claude.json"
fi
"#,
    )?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::cloud::{sandbox::Info, Machine};
    use std::{
        cell::RefCell,
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pandacode-setup-{}", uuid::Uuid::new_v4()));
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
        calls: AtomicUsize,
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
            self.calls.fetch_add(1, Ordering::Relaxed);
            assert!(command.len() < 64 * 1024);
            let output = Command::new("sh")
                .args(["-c", command])
                .current_dir(&self.root)
                .env("HOME", self.root.join("home"))
                .env(
                    "PATH",
                    format!(
                        "{}:{}",
                        self.root.join("bin").display(),
                        std::env::var("PATH").unwrap_or_default()
                    ),
                )
                .output()
                .map_err(|e| e.to_string())?;
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            Ok((output.status.code(), text))
        }
        fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn runtime_marker_with_working_cli_skips_installation() {
        let temp = TempDir::new();
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home/.pandacode/runtime")).unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        let executable = root.join("bin/claude");
        fs::write(&executable, "#!/bin/sh\nprintf 'Claude Code 1.0.0\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        fs::write(
            root.join("home/.pandacode/runtime/claude"),
            executable.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let sandbox = FakeSandbox {
            root,
            calls: AtomicUsize::new(0),
        };
        let progress = RefCell::new(Vec::new());
        let path = ensure_runtime(&sandbox, "fake", "claude", None, &|label| {
            progress.borrow_mut().push(label.to_owned())
        })
        .unwrap();

        assert_eq!(path, executable.to_string_lossy());
        assert_eq!(sandbox.calls.load(Ordering::Relaxed), 1);
        assert!(progress.borrow().is_empty());
    }

    /// Issue #206: the marker only satisfies a run when the machine's harness reports
    /// exactly the version this computer runs — asked of the program itself, so a marker
    /// without a stored version still compares — and a host upgrade reinstalls instead of
    /// reusing a machine whose model catalog has since drifted.
    #[test]
    fn opencode_runtime_marker_only_matches_the_pinned_version() {
        let temp = TempDir::new();
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home/.pandacode/runtime")).unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        let executable = root.join("bin/opencode");
        fs::write(&executable, "#!/bin/sh\nprintf '2.1.2\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let sandbox = FakeSandbox {
            root,
            calls: AtomicUsize::new(0),
        };
        let path = executable.to_string_lossy().into_owned();
        let cached = |version: Option<&str>, marker: &str| {
            fs::write(
                temp.0.join("machine/home/.pandacode/runtime/opencode"),
                marker,
            )
            .unwrap();
            cached_program(&sandbox, "fake", "opencode", version, "").unwrap()
        };

        assert_eq!(cached(Some("2.1.2"), &format!("{path}\n2.1.2\n")).as_deref(), Some(path.as_str()));
        assert_eq!(cached(None, &format!("{path}\n2.1.2\n")).as_deref(), Some(path.as_str()));
        // A marker from an older build without a stored version still compares, because
        // the running program is asked directly.
        assert_eq!(cached(Some("2.1.2"), &path).as_deref(), Some(path.as_str()));
        assert_eq!(cached(None, &path).as_deref(), Some(path.as_str()));
        assert_eq!(cached(Some("2.2.0"), &format!("{path}\n2.1.2\n")), None);
    }

    #[test]
    fn version_output_parses_into_an_npm_pin() {
        assert_eq!(parse_version("2.1.2").as_deref(), Some("2.1.2"));
        assert_eq!(parse_version("v2.1.2").as_deref(), Some("2.1.2"));
        assert_eq!(parse_version("2.2.0-beta.3").as_deref(), Some("2.2.0-beta.3"));
        assert_eq!(parse_version("2.1.2+build").as_deref(), Some("2.1.2+build"));
        assert_eq!(parse_version("opencode 2.1.2").as_deref(), Some("2.1.2"));
        assert_eq!(parse_version("npm warn deprecated foo\n2.1.2").as_deref(), Some("2.1.2"));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("latest"), None);
        assert_eq!(parse_version("2"), None);
        assert_eq!(parse_version("2.x").as_deref(), None);
    }

    /// Issue #209: OpenCode v2 is a separate npm package (`@opencode/cli`); `opencode-ai`
    /// publishes only 1.x. The machine must install the package of the host's own
    /// generation, pinned to the host's version when one was parsed.
    #[test]
    fn opencode_package_follows_the_host_generation_and_pins_its_version() {
        assert_eq!(opencode_package(Some("2.1.2")), "@opencode/cli@2.1.2");
        assert_eq!(opencode_package(Some("v2.1.2")), "@opencode/cli@2.1.2");
        assert_eq!(opencode_package(Some("OpenCode 2.1.2")), "@opencode/cli@2.1.2");
        assert_eq!(opencode_package(Some("opencode 2.1.2")), "@opencode/cli@2.1.2");
        assert_eq!(opencode_package(Some("2.2.0-beta.3")), "@opencode/cli@2.2.0-beta.3");
        assert_eq!(opencode_package(Some("1.19.5")), "opencode-ai@1.19.5");
        assert_eq!(opencode_package(None), "opencode-ai");
        assert_eq!(opencode_package(Some("junk")), "opencode-ai");
        assert_eq!(opencode_package(Some("latest")), "opencode-ai");
        assert_eq!(opencode_package(Some("")), "opencode-ai");
    }

    /// A bare major still selects its generation's package without a pin: npm has no
    /// `opencode-ai@2.x` and no `@opencode/cli@1.x`, so the package must never cross
    /// generations or invent a pin `parse_version` never found.
    #[test]
    fn opencode_package_selects_a_bare_major_without_inventing_a_pin() {
        assert_eq!(opencode_package(Some("2")), "@opencode/cli");
        assert_eq!(opencode_package(Some("v2")), "@opencode/cli");
        assert_eq!(opencode_package(Some("2.x")), "@opencode/cli");
        assert!(!opencode_package(Some("2.x")).starts_with("opencode-ai@"));
        assert!(!opencode_package(Some("2.1.2")).starts_with("opencode-ai@"));
        assert!(!opencode_package(Some("1.19.5")).starts_with("@opencode/cli"));
    }

    /// Both packages own `bin/opencode`, so the other generation's is removed first and a
    /// failed removal never stops the install.
    #[test]
    fn opencode_install_removes_the_other_generation_first() {
        let v2 = opencode_install_steps(Some("2.1.2"), "opencode-2");
        let removal = r#"npm uninstall -g --prefix "$home/.pandacode/npm" 'opencode-ai' >/dev/null 2>&1 || true"#;
        assert!(v2.starts_with(removal), "{v2}");

        let v1 = opencode_install_steps(Some("1.19.5"), "opencode-1");
        let removal = r#"npm uninstall -g --prefix "$home/.pandacode/npm" '@opencode/cli' >/dev/null 2>&1 || true"#;
        assert!(v1.starts_with(removal), "{v1}");
    }

    /// A version npm does not publish must not fail the run: the pinned install falls back
    /// to the same package unpinned, and major 0 never pins at all.
    #[test]
    fn opencode_install_falls_back_to_the_unpinned_package() {
        let steps = opencode_install_steps(Some("2.1.2"), "opencode-2");
        let pinned = r#"if npm install -g --prefix "$home/.pandacode/npm" '@opencode/cli@2.1.2'; then"#;
        let latest = r#"npm install -g --prefix "$home/.pandacode/npm" '@opencode/cli'"#;
        assert!(steps.contains(pinned), "{steps}");
        assert!(steps.contains(&format!("else\n  {latest}\n")), "{steps}");

        let beta = Some("0.0.0-beta-19507");
        assert_eq!(opencode_pin(beta), None);
        assert_eq!(opencode_package(beta), "opencode-ai");
        let steps = opencode_install_steps(beta, "opencode-0");
        assert!(steps.contains(r#"npm install -g --prefix "$home/.pandacode/npm" 'opencode-ai'"#), "{steps}");
        assert!(!steps.contains("0.0.0"), "{steps}");
    }

    /// The fallback runs for real: npm refuses the pin, the unpinned package installs, and
    /// the next run reuses that install instead of reinstalling. A later host version, or a
    /// successful pin, ends the exception.
    #[test]
    fn unpublished_pin_installs_latest_once_and_is_then_cached() {
        let temp = TempDir::new();
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        let npm = root.join("bin/npm");
        fs::write(
            &npm,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/npm.log\"\ncase \"$*\" in *@9.9.9*) echo 'npm error 404' >&2; exit 1 ;; esac\n",
        )
        .unwrap();
        let executable = root.join("home/.local/bin/opencode");
        fs::write(&executable, "#!/bin/sh\nprintf '2.1.2\\n'\n").unwrap();
        for file in [&npm, &executable] {
            let mut permissions = fs::metadata(file).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(file, permissions).unwrap();
        }
        let sandbox = FakeSandbox {
            root: root.clone(),
            calls: AtomicUsize::new(0),
        };
        let runtime = "opencode-9";
        // The steps run directly: ensure_runtime refuses any machine that is not Linux.
        let install = |host: &str| {
            let script = format!(
                "set -eu\nhome=$(cd \"$HOME\" && pwd -P)\nmkdir -p \"$home/.pandacode/runtime\"\n{}\n",
                opencode_install_steps(Some(host), runtime)
            );
            let (code, output) = sandbox.exec("fake", &script, Duration::from_secs(30)).unwrap();
            assert_eq!(code, Some(0), "{output}");
        };
        install("9.9.9");
        let path = mark_runtime(&sandbox, "fake", runtime, "opencode").unwrap();
        let log = fs::read_to_string(root.join("home/npm.log")).unwrap();
        assert!(log.contains("@opencode/cli@9.9.9"), "{log}");
        assert!(log.lines().last().unwrap().ends_with("@opencode/cli"), "{log}");
        let flag = root.join(format!("home/.pandacode/runtime/{runtime}{UNPUBLISHED}"));
        assert_eq!(fs::read_to_string(&flag).unwrap(), "9.9.9\n");

        // Same host version: the machine's 2.1.2 stands in, with no second install.
        assert_eq!(
            cached_program(&sandbox, "fake", runtime, Some("9.9.9"), "").unwrap().as_deref(),
            Some(path.as_str())
        );
        // A different host version is not covered by the exception.
        assert_eq!(cached_program(&sandbox, "fake", runtime, Some("9.9.10"), "").unwrap(), None);

        // A pin npm accepts clears the record, so the old version stops being excused.
        install("9.9.10");
        assert!(!flag.exists());
        assert_eq!(cached_program(&sandbox, "fake", runtime, Some("9.9.9"), "").unwrap(), None);
    }

    /// The runtime marker id carries the generation: a machine provisioned for one
    /// generation must never read another's marker, including the legacy plain
    /// `opencode` marker written by older builds.
    #[test]
    fn opencode_runtime_id_carries_the_host_generation() {
        assert_eq!(opencode_runtime(Some("2.1.2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("v2.1.2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("OpenCode 2.1.2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("opencode 2.1.2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("2.2.0-beta.3")), "opencode-2");
        assert_eq!(opencode_runtime(Some("2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("v2")), "opencode-2");
        assert_eq!(opencode_runtime(Some("2.x")), "opencode-2");
        assert_eq!(opencode_runtime(Some("1.19.5")), "opencode-1");
        assert_eq!(opencode_runtime(None), "opencode");
        assert_eq!(opencode_runtime(Some("junk")), "opencode");
        assert_eq!(opencode_runtime(Some("latest")), "opencode");
        assert_eq!(opencode_runtime(Some("")), "opencode");
    }

    /// `cached_program` and `mark_runtime` stay parametric in the runtime id: a
    /// generation-scoped id reads and writes `~/.pandacode/runtime/<id>` only, so a
    /// legacy plain `opencode` marker never satisfies a v2 lookup.
    #[test]
    fn runtime_markers_are_scoped_to_the_generation_id() {
        let temp = TempDir::new();
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        fs::create_dir_all(root.join("home/.pandacode/runtime")).unwrap();
        // resolve() checks $HOME/.local/bin before PATH and the system dirs, so the
        // fake harness there is what mark_runtime finds on any host.
        let executable = root.join("home/.local/bin/opencode");
        fs::write(&executable, "#!/bin/sh\nprintf '2.1.2\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let sandbox = FakeSandbox {
            root: root.clone(),
            calls: AtomicUsize::new(0),
        };
        // mark_runtime reports `pwd -P` paths, which on macOS resolve /var through
        // /private/var, so the expected path is canonicalized the same way.
        let path = fs::canonicalize(&executable)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        // A legacy plain marker never satisfies a v2-scoped lookup.
        fs::write(
            root.join("home/.pandacode/runtime/opencode"),
            format!("{path}\n2.1.2\n"),
        )
        .unwrap();
        assert_eq!(
            cached_program(&sandbox, "fake", "opencode-2", Some("2.1.2"), "").unwrap(),
            None
        );

        // mark_runtime stores the program and its version under the generation id.
        let marked = mark_runtime(&sandbox, "fake", "opencode-2", "opencode").unwrap();
        assert_eq!(marked, path);
        let marker = fs::read_to_string(root.join("home/.pandacode/runtime/opencode-2")).unwrap();
        assert_eq!(marker, format!("{path}\n2.1.2\n"));

        // That marker satisfies a pinned v2 lookup under the same id.
        assert_eq!(
            cached_program(&sandbox, "fake", "opencode-2", Some("2.1.2"), "")
                .unwrap()
                .as_deref(),
            Some(path.as_str())
        );
    }

    /// The cache gate is fed the parsed pin, not the raw host output: a prefixed
    /// line like "OpenCode 2.1.2" or a bare `2` must still recognize the machine's
    /// CLI, whose own `--version` prints only "2.1.2" (review finding: the raw
    /// comparison reinstalled on every run).
    #[test]
    fn opencode_cache_gate_matches_the_parsed_pin_not_the_raw_host_line() {
        let temp = TempDir::new();
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        fs::create_dir_all(root.join("home/.pandacode/runtime")).unwrap();
        let executable = root.join("home/.local/bin/opencode");
        fs::write(&executable, "#!/bin/sh\nprintf '2.1.2\\n'\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        let path = fs::canonicalize(&executable)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        fs::write(
            root.join("home/.pandacode/runtime/opencode-2"),
            format!("{path}\n2.1.2\n"),
        )
        .unwrap();

        // The unfixed seam asked cached_program for the raw host line; the miss it
        // produced is what sent every run back through the installer.
        let sandbox = FakeSandbox {
            root: root.clone(),
            calls: AtomicUsize::new(0),
        };
        assert_eq!(
            cached_program(&sandbox, "fake", "opencode-2", Some("OpenCode 2.1.2"), "").unwrap(),
            None
        );

        for host in [Some("OpenCode 2.1.2"), Some("2"), Some("v2.1.2")] {
            let sandbox = FakeSandbox {
                root: root.clone(),
                calls: AtomicUsize::new(0),
            };
            let progress = RefCell::new(Vec::new());
            let cached = ensure_runtime(&sandbox, "fake", "opencode", host, &|label| {
                progress.borrow_mut().push(label.to_owned())
            })
            .unwrap();
            assert_eq!(cached, path, "host {host:?}");
            // One exec: the marker check only — no tool, node or npm install ran.
            assert_eq!(sandbox.calls.load(Ordering::Relaxed), 1, "host {host:?}");
            assert!(progress.borrow().is_empty(), "host {host:?}");
        }
    }
}
