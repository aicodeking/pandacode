//! Copies the harness's local login to a cloud machine (docs/cloud-agents.md, step 3).
use crate::cloud::sandbox::Sandbox;
use crate::Result;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const UPLOAD_CHUNK: usize = 46 * 1024;

/// Writes the login files `harness` needs and returns environment variables for the agent
/// process. Called before every run. Never logs secret values.
pub(crate) fn push(
    sandbox: &dyn Sandbox,
    native: &str,
    harness: &str,
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
        "opencode" => push_file_login(
            sandbox,
            native,
            &home.join(".local/share/opencode/auth.json"),
            &format!("{remote_home}/.local/share/opencode/auth.json"),
            "Sign in to OpenCode on this computer first (run `opencode auth login`).",
        )?,
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

fn push_file_login(
    sandbox: &dyn Sandbox,
    native: &str,
    local: &Path,
    remote: &str,
    missing: &str,
) -> Result<()> {
    match std::fs::read(local) {
        Ok(bytes) => upload_file(sandbox, native, remote, &bytes, true)
            .map_err(|_| "Could not copy the OpenCode login to the cloud machine.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(missing.into()),
        Err(_) => Err("Could not read the local OpenCode login file. Check its permissions and sign in again if needed.".into()),
    }
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
            .map_err(|_| "Could not upload a login file to the cloud machine.".into());
    }
    let directory = format!("{destination}.parts-{}", uuid::Uuid::new_v4());
    for (index, chunk) in bytes.chunks(UPLOAD_CHUNK).enumerate() {
        let part = format!("{directory}/chunk-{index:08}");
        if sandbox.upload(native, &part, chunk, private).is_err() {
            let cleanup = format!("rm -rf {}", crate::cloud::shell_quote(&directory));
            let _ = sandbox.exec(native, &cleanup, Duration::from_secs(30));
            return Err("Could not upload a login file to the cloud machine.".into());
        }
    }
    let command = format!(
        "set -eu; umask {}; dir={}; trap 'rm -rf \"$dir\"' EXIT; cat \"$dir\"/chunk-* > {}",
        if private { "077" } else { "022" },
        crate::cloud::shell_quote(&directory),
        crate::cloud::shell_quote(destination),
    );
    if command.len() >= 64 * 1024 {
        return Err("Cloud credential copy command exceeded the sandbox limit.".into());
    }
    let (code, output) = sandbox.exec(native, &command, Duration::from_secs(120))?;
    crate::cloud::sandbox::checked((code, output))
        .map_err(|_| "Could not upload a login file to the cloud machine.".into())
}
