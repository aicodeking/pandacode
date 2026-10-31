//! Copies the harness's local login to a cloud machine (docs/cloud-agents.md, step 3).
use crate::cloud::sandbox::Sandbox;
use crate::Result;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// Writes the login files `harness` needs and returns environment variables for the agent
/// process. `program` is the harness executable installed on the machine. Called before
/// every run. Never logs secret values.
pub(crate) fn push(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
    program: &str,
) -> Result<Vec<(String, String)>> {
    if !["claude", "glm", "mimo", "codex", "opencode"].contains(&harness) {
        return Err(format!("Unsupported cloud agent harness '{harness}'."));
    }
    let home = local_home()?;
    let remote_home = remote_home(sandbox, native)?;
    let mut env = vec![("IS_SANDBOX".into(), "1".into())];
    match harness {
        "claude" => push_claude(sandbox, native, &remote_home, &mut env)?,
        "glm" | "mimo" => push_relay_key(harness, &mut env)?,
        "codex" => push_codex(sandbox, native, &home, &remote_home, &mut env)?,
        "opencode" => push_opencode(sandbox, native, &home, &remote_home, program, &export_host_opencode)?,
        _ => return Err(format!("Unsupported cloud agent harness '{harness}'.")),
    }
    if let Some(token) = local_gh_token() {
        configure_github_helper(sandbox, native)?;
        env.push(("GH_TOKEN".into(), token));
    }
    if let Some(value) = global_git_config("user.name") {
        env.push(("GIT_AUTHOR_NAME".into(), value.clone()));
        env.push(("GIT_COMMITTER_NAME".into(), value));
    }
    if let Some(value) = global_git_config("user.email") {
        env.push(("GIT_AUTHOR_EMAIL".into(), value.clone()));
        env.push(("GIT_COMMITTER_EMAIL".into(), value));
    }
    Ok(env)
}

fn local_home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "This computer has no home folder to read harness credentials from.".into())
}

fn remote_home(sandbox: &dyn Sandbox, native: &str) -> Result<String> {
    let (code, output) =
        sandbox.exec(native, "printf '%s\\n' \"$HOME\"", Duration::from_secs(30))?;
    crate::cloud::sandbox::checked((code, output.clone()))?;
    let home = output.trim();
    if !home.starts_with('/') {
        return Err("The cloud machine did not report an absolute home folder.".into());
    }
    Ok(home.to_owned())
}

fn push_claude(
    sandbox: &dyn Sandbox,
    native: &str,
    remote_home: &str,
    env: &mut Vec<(String, String)>,
) -> Result<()> {
    if let Some(token) =
        crate::cloud::secret("claude_setup_token").filter(|token| !token.trim().is_empty())
    {
        env.push(("CLAUDE_CODE_OAUTH_TOKEN".into(), token));
        return Ok(());
    }
    let credentials = local_claude_credentials()?;
    if let Some(credentials) = &credentials {
        upload_file(
            sandbox,
            native,
            &format!("{remote_home}/.claude/.credentials.json"),
            credentials,
            true,
        )
        .map_err(|_| "Could not copy the Claude Code login to the cloud machine.")?;
    }
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            env.push(("ANTHROPIC_API_KEY".into(), key));
        }
    }
    if credentials.is_some() || env.iter().any(|(key, _)| key == "ANTHROPIC_API_KEY") {
        return Ok(());
    }
    Err("Sign in to Claude Code on this computer first (or set ANTHROPIC_API_KEY).".into())
}

fn local_claude_credentials() -> Result<Option<Vec<u8>>> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("security");
        command.args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ]);
        if let Ok(output) = crate::workspace::run_process(
            command,
            "Claude credentials",
            8 * 1024 * 1024,
            Duration::from_secs(20),
        ) {
            if output.status.success() && !output.stdout.bytes.is_empty() {
                return Ok(Some(output.stdout.bytes));
            }
        }
    }
    read_optional(
        &local_home()?.join(".claude/.credentials.json"),
        "Claude Code",
    )
}

fn read_optional(path: &Path, label: &str) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("Could not read the local {label} login file. Check its permissions and sign in again if needed.")),
    }
}

fn push_relay_key(harness: &str, env: &mut Vec<(String, String)>) -> Result<()> {
    let (saved, variable) = if harness == "glm" {
        (crate::provider_settings::glm_key(), "ZAI_API_KEY")
    } else {
        (crate::provider_settings::mimo_key(), "MIMO_API_KEY")
    };
    let key = match saved {
        Ok(Some(key)) => crate::provider_settings::validate_key(&key)?.to_owned(),
        saved => {
            if let Some(key) = std::env::var(variable)
                .ok()
                .filter(|key| !key.trim().is_empty())
            {
                crate::provider_settings::validate_key(&key)?.to_owned()
            } else if let Err(error) = saved {
                return Err(error);
            } else if harness == "glm" {
                return Err(
                    "Add your Z.AI Coding Plan API key in Settings → Agents, or set ZAI_API_KEY."
                        .into(),
                );
            } else {
                return Err("Add your MiMo API key in Settings → Agents → Provider connections, or set MIMO_API_KEY.".into());
            }
        }
    };
    let base_url = if harness == "glm" {
        "https://api.z.ai/api/anthropic".to_owned()
    } else {
        crate::provider_settings::mimo_endpoint()
            .and_then(|id| crate::providers::mimo_endpoint_url(&id).map(str::to_owned))
            .ok_or(
                "Choose your MiMo Token Plan cluster in Settings → Agents → Provider connections.",
            )?
    };
    let (model, fast_model) = if harness == "glm" {
        ("glm-5.3", "glm-5.3-flash")
    } else {
        ("mimo-v2.6-pro", "mimo-v2.6-flash")
    };
    env.extend([
        ("ANTHROPIC_AUTH_TOKEN".into(), key),
        ("ANTHROPIC_BASE_URL".into(), base_url),
        ("ANTHROPIC_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), model.into()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), fast_model.into()),
    ]);
    if harness == "mimo" {
        env.push((
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        ));
    }
    Ok(())
}

fn push_codex(
    sandbox: &dyn Sandbox,
    native: &str,
    home: &Path,
    remote_home: &str,
    env: &mut Vec<(String, String)>,
) -> Result<()> {
    let auth_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let auth = auth_home.join("auth.json");
    if auth.is_file() {
        let bytes = std::fs::read(&auth).map_err(|_| "Could not read the local Codex login file. Check its permissions and sign in again if needed.")?;
        upload_file(
            sandbox,
            native,
            &format!("{remote_home}/.codex/auth.json"),
            &bytes,
            true,
        )
        .map_err(|_| "Could not copy the Codex login to the cloud machine.")?;
        env.push(("CODEX_HOME".into(), format!("{remote_home}/.codex")));
        return Ok(());
    }
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        if !key.trim().is_empty() {
            env.push(("OPENAI_API_KEY".into(), key));
            return Ok(());
        }
    }
    Err("Sign in to Codex on this computer first (or set OPENAI_API_KEY).".into())
}

/// OpenCode's login: the `auth.json` file for v1, and from v2 the provider credentials live
/// in OpenCode's own database (that file is ignored there), so they also move as an
/// `opencode auth export` payload imported on the machine (issue #206: without it a 2.x
/// sandbox saw only the free `opencode/*` models). `export` returns the host's exported
/// credential JSON, if any.
fn push_opencode(
    sandbox: &dyn Sandbox,
    native: &str,
    home: &Path,
    remote_home: &str,
    program: &str,
    export: &dyn Fn() -> Option<String>,
) -> Result<()> {
    let mut signed_in = false;
    match std::fs::read(home.join(".local/share/opencode/auth.json")) {
        Ok(bytes) => {
            upload_file(
                sandbox,
                native,
                &format!("{remote_home}/.local/share/opencode/auth.json"),
                &bytes,
                true,
            )
            .map_err(|_| "Could not copy the OpenCode login to the cloud machine.")?;
            signed_in = true;
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("Could not read the local OpenCode login file. Check its permissions and sign in again if needed.".into());
        }
        Err(_) => {}
    }
    if !program.is_empty() {
        if let Some(credentials) = export() {
            let trimmed = credentials.trim();
            let stored = serde_json::from_str::<serde_json::Value>(trimmed)
                .ok()
                .and_then(|value| value.as_array().map(|items| items.len()))
                .unwrap_or(0);
            if stored > 0 {
                // One fixed name: a run killed mid-import leaves at most one staging file,
                // and the next run replaces it instead of accumulating leftovers.
                let file = format!("{remote_home}/.pandacode/opencode-auth.json");
                upload_file(sandbox, native, &file, trimmed.as_bytes(), true)
                    .map_err(|_| "Could not copy the OpenCode logins to the cloud machine.")?;
                let import = format!(
                    "set -eu\nfile={file}\ntrap 'rm -f \"$file\"' EXIT\n{program} auth import --standalone \"$file\"",
                    program = crate::cloud::shell_quote(program),
                    file = crate::cloud::shell_quote(&file),
                );
                let (code, output) = sandbox.exec(native, &import, Duration::from_secs(300))?;
                crate::cloud::sandbox::checked((code, output)).map_err(|error| {
                    format!("The cloud machine could not import the OpenCode logins: {error}")
                })?;
                signed_in = true;
            }
        }
    }
    if signed_in {
        return Ok(());
    }
    Err("Sign in to OpenCode on this computer first (run `opencode auth login`).".into())
}

/// The host's `opencode auth export --standalone` payload: a JSON array of every stored
/// credential. OpenCode 2.x stores credentials in its database; older versions have no
/// export and report a command error, which lands as None.
fn export_host_opencode() -> Option<String> {
    crate::providers::run_provider(
        "opencode",
        &["auth", "export", "--standalone"],
        Duration::from_secs(120),
    )
}

fn local_gh_token() -> Option<String> {
    let mut command = Command::new("gh");
    command.args(["auth", "token"]);
    let output = crate::workspace::run_process(
        command,
        "GitHub authentication",
        8192,
        Duration::from_secs(20),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout.bytes)
        .ok()?
        .trim()
        .to_owned();
    (!token.is_empty()).then_some(token)
}

fn configure_github_helper(sandbox: &dyn Sandbox, native: &str) -> Result<()> {
    let helper = "!f() { [ \"$1\" = get ] || exit 0; host=; while IFS= read -r line; do case \"$line\" in host=*) host=${line#host=};; esac; done; [ \"$host\" = github.com ] || exit 0; printf 'username=x-access-token\\npassword=%s\\n' \"$GH_TOKEN\"; }; f";
    let command = format!(
        "git config --global --replace-all credential.helper {}",
        crate::cloud::shell_quote(helper)
    );
    if command.len() >= 64 * 1024 {
        return Err("Cloud GitHub credential helper command exceeded the sandbox limit.".into());
    }
    crate::cloud::sandbox::checked(sandbox.exec(native, &command, Duration::from_secs(30))?)?;
    Ok(())
}

fn global_git_config(key: &str) -> Option<String> {
    let mut command = Command::new("git");
    command.args(["config", "--global", "--get", key]);
    let output =
        crate::workspace::run_process(command, "Git configuration", 8192, Duration::from_secs(20))
            .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout.bytes)
        .ok()?
        .trim()
        .to_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::cloud::{sandbox::Info, Machine};
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command, time::Duration};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("pandacode-credentials-{label}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A machine that runs commands for real in `root`, like the cloud one would.
    struct FakeSandbox {
        root: PathBuf,
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
    }

    fn machine(label: &str) -> (TempDir, FakeSandbox, String) {
        let temp = TempDir::new(label);
        let root = temp.0.join("machine");
        fs::create_dir_all(root.join("home")).unwrap();
        let program = root.join("bin/opencode");
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        // `auth import --standalone <file>`: copies the payload where the test reads it.
        fs::write(
            &program,
            "#!/bin/sh\n[ \"$1\" = auth ] && [ \"$2\" = import ] || exit 9\ncat \"$4\" > \"$HOME/imported.json\"\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&program).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&program, permissions).unwrap();
        let remote_home = root.join("home").to_string_lossy().into_owned();
        (temp, FakeSandbox { root }, remote_home)
    }

    const EXPORT: &str =
        r#"[{"id":"deepseek","integrationID":"deepseek","value":{"type":"api","key":"sk-1"},"active":true}]"#;

    /// Issue #206: OpenCode 2.x keeps provider credentials in its database, so the host's
    /// `auth export` payload is imported on the machine and the staging file is gone after.
    #[test]
    fn opencode_login_imports_the_host_credential_export() {
        let (temp, sandbox, remote_home) = machine("import");
        let program = temp.0.join("machine/bin/opencode");
        let host = temp.0.join("host-home");
        fs::create_dir_all(&host).unwrap();
        let export = || Some(EXPORT.to_owned());

        push_opencode(
            &sandbox,
            "fake",
            &host,
            &remote_home,
            &program.to_string_lossy(),
            &export,
        )
        .unwrap();
        let imported = fs::read_to_string(sandbox.root.join("home/imported.json")).unwrap();
        assert_eq!(imported.trim(), EXPORT);
        let staging = fs::read_dir(sandbox.root.join("home/.pandacode")).unwrap().count();
        assert_eq!(staging, 0, "the exported credentials file must not stay behind");
    }

    /// The `auth.json` path keeps working for v1 hosts; the export rides along on 2.x.
    #[test]
    fn opencode_login_still_copies_auth_json_alongside_the_export() {
        let (temp, sandbox, remote_home) = machine("auth-json");
        let program = temp.0.join("machine/bin/opencode");
        let host = temp.0.join("host-home");
        fs::create_dir_all(host.join(".local/share/opencode")).unwrap();
        fs::write(host.join(".local/share/opencode/auth.json"), r#"{"opencode":""}"#).unwrap();
        let export = || Some(EXPORT.to_owned());

        push_opencode(
            &sandbox,
            "fake",
            &host,
            &remote_home,
            &program.to_string_lossy(),
            &export,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(sandbox.root.join("home/.local/share/opencode/auth.json")).unwrap(),
            r#"{"opencode":""}"#
        );
        assert!(sandbox.root.join("home/imported.json").exists());
    }

    #[test]
    fn opencode_login_without_any_credential_is_an_error_and_a_failed_import_says_why() {
        let (temp, sandbox, remote_home) = machine("errors");
        let program = temp.0.join("machine/bin/opencode").to_string_lossy().into_owned();
        let host = temp.0.join("host-home");
        fs::create_dir_all(&host).unwrap();

        let none = || None;
        let result = push_opencode(&sandbox, "fake", &host, &remote_home, &program, &none);
        assert_eq!(
            result.unwrap_err(),
            "Sign in to OpenCode on this computer first (run `opencode auth login`)."
        );

        // An empty export is also not a login.
        let empty = || Some("[]".to_owned());
        let result = push_opencode(&sandbox, "fake", &host, &remote_home, &program, &empty);
        assert_eq!(
            result.unwrap_err(),
            "Sign in to OpenCode on this computer first (run `opencode auth login`)."
        );

        // A failing import surfaces the machine's own message.
        fs::write(temp.0.join("machine/bin/opencode"), "#!/bin/sh\nexit 3\n").unwrap();
        let export = || Some(EXPORT.to_owned());
        let result = push_opencode(&sandbox, "fake", &host, &remote_home, &program, &export);
        let error = result.unwrap_err().to_string();
        assert!(error.contains("could not import the OpenCode logins"), "{error}");
    }
}

/// Hands the whole login file to the sandbox in one call; the chunked trait default still
/// covers providers without a whole-file API.
fn upload_file(
    sandbox: &dyn Sandbox,
    native: &str,
    destination: &str,
    bytes: &[u8],
    private: bool,
) -> Result<()> {
    sandbox
        .upload(native, destination, bytes, private)
        .map_err(|_| "Could not upload a login file to the cloud machine.".into())
}
