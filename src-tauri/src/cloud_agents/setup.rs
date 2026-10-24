//! Installs the agent runtime on a cloud machine (docs/cloud-agents.md, step 2).
use crate::cloud::sandbox::Sandbox;
use crate::Result;
use std::time::Duration;

/// Harnesses that can run on a cloud machine.
pub(crate) const HARNESSES: [&str; 5] = ["claude", "glm", "mimo", "codex", "opencode"];

/// Makes sure `harness` can run on the machine; returns the absolute path of the program
/// to execute there (for `glm`/`mimo`, Claude Code). Idempotent and quick when installed.
pub(crate) fn ensure_runtime(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
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
    let cached = execute(
        sandbox,
        native,
        &format!(
            r#"set -eu
marker="$HOME/.pandacode/runtime/{harness}"
if [ -s "$marker" ]; then
  program=$(sed -n '1p' "$marker")
  if [ "${{program#/}}" != "$program" ] && [ -x "$program" ] && "$program" --version >/dev/null 2>&1; then
{onboarding}
    printf '%s\n' "$program"
  fi
fi
"#,
            onboarding = onboarding,
        ),
    )?;
    if let Some(path) = cached.lines().last().filter(|line| line.starts_with('/')) {
        return Ok(path.to_owned());
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
            let (label, package) = if harness == "codex" {
                ("Installing Codex CLI…", "@openai/codex")
            } else {
                ("Installing OpenCode…", "opencode-ai")
            };
            progress(label);
            execute(
                sandbox,
                native,
                &format!(
                    r#"set -eu
home=$(cd "$HOME" && pwd -P)
export PATH="$home/.pandacode/node/bin:$home/.pandacode/npm/bin:$home/.local/bin:$PATH"
mkdir -p "$home/.pandacode/npm"
npm install -g --prefix "$home/.pandacode/npm" {}
"#,
                    crate::cloud::shell_quote(package)
                ),
            )?;
        }
        _ => unreachable!(),
    }
    let path = mark_runtime(sandbox, native, harness, cli)?;
    if matches!(harness, "claude" | "glm" | "mimo") {
        ensure_onboarding_file(sandbox, native)?;
    }
    Ok(path)
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

fn mark_runtime(sandbox: &dyn Sandbox, native: &str, harness: &str, cli: &str) -> Result<String> {
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
tmp="$home/.pandacode/runtime/.{harness}.$$"
printf '%s\n%s\n' "$program" "$version" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$home/.pandacode/runtime/{harness}"
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
        let path = ensure_runtime(&sandbox, "fake", "claude", &|label| {
            progress.borrow_mut().push(label.to_owned())
        })
        .unwrap();

        assert_eq!(path, executable.to_string_lossy());
        assert_eq!(sandbox.calls.load(Ordering::Relaxed), 1);
        assert!(progress.borrow().is_empty());
    }
}
