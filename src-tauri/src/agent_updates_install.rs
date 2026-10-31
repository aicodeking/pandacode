//! Install ownership and fixed update commands. No command text comes from IPC.
use super::{family, Installation, Version};
use crate::Result;
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

#[derive(Clone, Debug)]
pub(super) enum Plan {
    Native {
        path: PathBuf,
        provider: String,
    },
    Npm {
        node: PathBuf,
        cli: PathBuf,
        prefix: PathBuf,
        package: &'static str,
    },
    Brew {
        executable: PathBuf,
        package: String,
        cask: bool,
    },
    Uv {
        executable: PathBuf,
        root: PathBuf,
    },
}
impl Plan {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Native { .. } => "Native updater",
            Self::Npm { .. } => "npm",
            Self::Brew { .. } => "Homebrew",
            Self::Uv { .. } => "uv",
        }
    }
}

pub(super) fn docs(provider: &str) -> &'static str {
    match provider {
        "claude" => "https://code.claude.com/docs/en/setup",
        "codex" => "https://developers.openai.com/codex/cli/",
        "kimi" => "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html",
        "opencode" => "https://opencode.ai/docs/",
        "grok" => "https://docs.x.ai/build",
        _ => "https://antigravity.google/docs/ide/extensions",
    }
}

fn command(path: &Path) -> Result<Command> {
    let prepared = crate::providers::command(path)?;
    let mut command = Command::new(prepared.as_std().get_program());
    command.args(prepared.as_std().get_args());
    // Keep the launch environment too: AppImage cleanup and the telemetry opt-outs.
    for (name, value) in prepared.as_std().get_envs() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    if let Some(home) = crate::agent_usage_providers::home() {
        command.current_dir(home);
    }
    command.env("DISABLE_AUTOUPDATER", "1");
    command
        .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
        .env("KIMI_CLI_NO_AUTO_UPDATE", "1")
        .env("OPENCODE_DISABLE_AUTOUPDATE", "true");
    Ok(command)
}

fn run(command: Command, timeout: Duration) -> Result<String> {
    run_output(command, timeout, false)
}

fn run_output(command: Command, timeout: Duration, allow_truncated: bool) -> Result<String> {
    let output = crate::workspace::run_process(command, "Agent updater", 16 * 1024, timeout)
        .map_err(|_| {
            "The agent command did not finish. Check its installation before trying again."
                .to_string()
        })?;
    if !output.status.success() || (output.stdout.truncated && !allow_truncated) {
        return Err("The agent command failed. Check installation permissions or use the official update guide.".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout.bytes).into_owned())
}

fn version_command(path: &Path, provider: &str) -> Result<Command> {
    let mut command = command(path)?;
    if provider == "grok" {
        command.arg("--no-auto-update");
    }
    command.arg("--version");
    Ok(command)
}

pub(super) fn version(path: &Path, provider: &str) -> Result<Version> {
    super::parse_version(&run(
        version_command(path, provider)?,
        Duration::from_secs(5),
    )?)
    .ok_or("The agent did not report a recognized version.".into())
}

fn native_owned(provider: &str, selected: &Path, canonical: &Path, home: &Path) -> bool {
    let bin = if cfg!(windows) {
        format!("{provider}.exe")
    } else {
        provider.into()
    };
    match provider {
        "claude" => {
            selected == home.join(".local/bin").join(&bin)
                && canonical.starts_with(home.join(".local/share/claude/versions"))
        }
        "grok" => {
            [
                home.join(".grok/bin").join(&bin),
                home.join(".local/bin").join(&bin),
            ]
            .contains(&selected.to_path_buf())
                && (canonical.starts_with(home.join(".grok/downloads"))
                    || canonical == home.join(".grok/bin").join(&bin))
        }
        "kimi" => {
            [
                home.join(".kimi-code/bin").join(&bin),
                home.join(".local/bin").join(&bin),
            ]
            .contains(&selected.to_path_buf())
                && canonical == home.join(".kimi-code/bin").join(&bin)
        }
        "opencode" => selected == home.join(".opencode/bin").join(&bin) && canonical == selected,
        _ => false,
    }
}

fn bytes(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn codex_owned(installation: &Installation, home: &Path) -> bool {
    let data = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let root = data.join("packages/standalone");
    let bin = if cfg!(windows) { "codex.exe" } else { "codex" };
    let launcher_dir = std::env::var_os("CODEX_INSTALL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join("AppData/Local"))
                    .join("Programs/OpenAI/Codex/bin")
            } else {
                home.join(".local/bin")
            }
        });
    codex_owned_at(installation, &root, &launcher_dir, bin)
}

fn codex_owned_at(
    installation: &Installation,
    root: &Path,
    launcher_dir: &Path,
    bin: &str,
) -> bool {
    let Ok(root) = root
        .canonicalize()
        .map(|path| crate::providers::external_path(&path))
    else {
        return false;
    };
    if !root.is_absolute()
        || !launcher_dir.is_absolute()
        || installation.path != launcher_dir.join(bin)
    {
        return false;
    }
    // The auto-update marker controls background updates. An explicit Update
    // can advance a verified current launcher even for older markerless installs.
    installation.canonical.starts_with(root.join("releases"))
        && [
            root.join("current").join(bin),
            root.join("current/bin").join(bin),
        ]
        .iter()
        .any(|path| {
            path.canonicalize()
                .is_ok_and(|path| crate::providers::external_path(&path) == installation.canonical)
        })
}

fn package(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        "opencode" => Some("opencode-ai"),
        _ => None,
    }
}

fn npm_package(installation: &Installation, package: &str, windows: bool) -> Option<PathBuf> {
    let mut roots: Vec<_> = installation
        .canonical
        .ancestors()
        .take(8)
        .map(Path::to_path_buf)
        .collect();
    if windows {
        roots.push(
            installation
                .path
                .parent()?
                .join("node_modules")
                .join(package),
        );
    }
    for root in roots {
        let Some(metadata) = bytes(&root.join("package.json"), 64 * 1024)
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        else {
            continue;
        };
        if metadata["name"].as_str() != Some(package) {
            continue;
        }
        let name = family(&installation.provider);
        let Some(bin) = metadata["bin"]
            .as_str()
            .or_else(|| metadata["bin"][name].as_str())
        else {
            continue;
        };
        if bin.contains('\\')
            || Path::new(bin)
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            continue;
        }
        let (Ok(root), Ok(entry)) = (root.canonicalize(), root.join(bin).canonicalize()) else {
            continue;
        };
        if !entry.starts_with(&root) {
            continue;
        }
        if crate::providers::external_path(&entry) == installation.canonical {
            return Some(root);
        }
        if windows
            && installation
                .path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("cmd"))
        {
            let Some(shim) =
                bytes(&installation.path, 8192).and_then(|b| String::from_utf8(b).ok())
            else {
                continue;
            };
            let declared = format!(
                "%dp0%\\node_modules\\{}\\{}",
                package.replace('/', "\\"),
                bin.replace('/', "\\")
            );
            if shim.contains(&format!("\"{declared}\""))
                && shim.contains("%_prog%")
                && shim.contains("node.exe")
            {
                return Some(root);
            }
        }
    }
    None
}

fn global_prefix(package_root: &Path, package: &str, windows: bool) -> Option<PathBuf> {
    let mut modules = package_root;
    for _ in package.split('/') {
        modules = modules.parent()?;
    }
    if modules.file_name()? != "node_modules" {
        return None;
    }
    let parent = modules.parent()?;
    if windows {
        Some(parent.to_path_buf())
    } else if parent.file_name()? == "lib" {
        Some(parent.parent()?.to_path_buf())
    } else {
        None
    }
}

fn search(name: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<_> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = crate::agent_usage_providers::home() {
        dirs.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    if !cfg!(windows) {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    }
    dirs.into_iter()
        .filter(|d| d.is_absolute())
        .take(96)
        .map(|d| d.join(name))
        .filter(|p| p.is_file())
        .collect()
}

fn distinct_files(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|p| p.is_file() && p.canonicalize().is_ok_and(|p| seen.insert(p)))
        .collect()
}

fn npm_manager(prefix: &Path) -> Option<(PathBuf, PathBuf)> {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut nodes = vec![prefix.join(if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    })];
    nodes.extend(search(node_name));
    let mut npm_paths = search(if cfg!(windows) { "npm.cmd" } else { "npm" });
    npm_paths.insert(
        0,
        prefix.join(if cfg!(windows) {
            "node_modules/npm/bin/npm-cli.js"
        } else {
            "lib/node_modules/npm/bin/npm-cli.js"
        }),
    );
    npm_manager_with(
        prefix,
        distinct_files(nodes),
        distinct_files(npm_paths),
        run,
    )
}

fn npm_manager_with(
    prefix: &Path,
    nodes: Vec<PathBuf>,
    npm_paths: Vec<PathBuf>,
    mut probe: impl FnMut(Command, Duration) -> Result<String>,
) -> Option<(PathBuf, PathBuf)> {
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut attempts = 0;
    for npm in npm_paths.into_iter().take(3) {
        let cli = if cfg!(windows)
            && npm
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
        {
            npm.parent()?.join("node_modules/npm/bin/npm-cli.js")
        } else {
            npm
        };
        let Ok(cli) = cli.canonicalize() else {
            continue;
        };
        let root = cli.parent()?.parent()?;
        let Some(metadata) = bytes(&root.join("package.json"), 64 * 1024)
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        else {
            continue;
        };
        if metadata["name"].as_str() != Some("npm") || cli.file_name()? != "npm-cli.js" {
            continue;
        }
        for node in nodes.iter().filter(|n| n.is_file()).take(3) {
            if attempts == 3 {
                return None;
            }
            attempts += 1;
            let mut cmd = Command::new(crate::providers::external_path(node));
            cmd.arg(crate::providers::external_path(&cli))
                .args(["prefix", "--global"])
                .current_dir(prefix);
            let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
            let Ok(actual) = probe(cmd, remaining.min(Duration::from_secs(3))) else {
                continue;
            };
            if Path::new(actual.trim()).canonicalize().ok() == prefix.canonicalize().ok() {
                return Some((node.clone(), cli));
            }
        }
    }
    None
}

fn brew_owned(installation: &Installation) -> Option<Plan> {
    for prefix in [Path::new("/opt/homebrew"), Path::new("/usr/local")] {
        let executable = prefix.join("bin/brew");
        if !executable.is_file() {
            continue;
        }
        for (directory, cask) in [("Caskroom", true), ("Cellar", false)] {
            let Ok(relative) = installation.canonical.strip_prefix(prefix.join(directory)) else {
                continue;
            };
            let mut parts = relative.components();
            let pkg = parts.next()?.as_os_str().to_str()?;
            let keg = parts.next()?.as_os_str();
            let provider = family(&installation.provider);
            if installation.path != prefix.join("bin").join(provider) {
                continue;
            }
            let supported = if cask {
                matches!(
                    (provider, pkg),
                    ("codex", "codex") | ("claude", "claude-code" | "claude-code@latest")
                )
            } else {
                provider == "opencode" && pkg == "opencode"
            };
            if !supported {
                continue;
            }
            if !cask {
                let receipt = prefix
                    .join(directory)
                    .join(pkg)
                    .join(keg)
                    .join("INSTALL_RECEIPT.json");
                let receipt: serde_json::Value =
                    serde_json::from_slice(&bytes(&receipt, 256 * 1024)?).ok()?;
                if receipt["source"]["tap"].as_str() != Some("homebrew/core") {
                    continue;
                }
            }
            return Some(Plan::Brew {
                executable,
                package: pkg.into(),
                cask,
            });
        }
    }
    None
}

fn uv_owned(installation: &Installation) -> Option<Plan> {
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    for executable in distinct_files(search(name)).into_iter().take(3) {
        let mut cmd = Command::new(crate::providers::external_path(&executable));
        cmd.args(["tool", "dir"]);
        let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
        let Ok(root) = run(cmd, remaining.min(Duration::from_secs(3))).and_then(|s| {
            Path::new(s.trim())
                .canonicalize()
                .map_err(|_| "uv tool storage is unavailable.".into())
        }) else {
            continue;
        };
        let tool = root.join("kimi-cli");
        let bin = tool.join(if cfg!(windows) {
            "Scripts/kimi.exe"
        } else {
            "bin/kimi"
        });
        if bin
            .canonicalize()
            .ok()
            .map(|p| crate::providers::external_path(&p))
            .as_ref()
            != Some(&installation.canonical)
        {
            continue;
        }
        let receipt = bytes(&tool.join("uv-receipt.toml"), 64 * 1024)?;
        let receipt: toml::Value = toml::from_str(std::str::from_utf8(&receipt).ok()?).ok()?;
        let requirements = receipt.get("tool")?.get("requirements")?.as_array()?;
        if !requirements
            .iter()
            .any(|r| r.get("name").and_then(toml::Value::as_str) == Some("kimi-cli"))
        {
            continue;
        }
        return Some(Plan::Uv { executable, root });
    }
    None
}

pub(super) fn detect(installation: &Installation, version: &Version) -> Result<Plan> {
    let provider = family(&installation.provider);
    if version.pre.is_some() {
        return Err("Preview versions use their own release channel. Update this installation with its official CLI or package manager.".into());
    }
    if let Some(brew) = brew_owned(installation) {
        return Ok(brew);
    }
    if let Some(package) = package(provider) {
        if let Some(prefix) = npm_package(installation, package, cfg!(windows))
            .and_then(|root| global_prefix(&root, package, cfg!(windows)))
        {
            if let Some((node, cli)) = npm_manager(&prefix) {
                return Ok(Plan::Npm {
                    node,
                    cli,
                    prefix,
                    package,
                });
            }
        }
    }
    if let Some(home) = crate::agent_usage_providers::home() {
        if [
            "GROK_BIN_DIR",
            "KIMI_INSTALL_DIR",
            "OPENCODE_INSTALL_DIR",
            "XDG_BIN_DIR",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
            && matches!(provider, "grok" | "kimi" | "opencode")
        {
            return Err("This agent uses a custom installation directory. Use its official updater to preserve that configuration.".into());
        }
        if native_owned(provider, &installation.path, &installation.canonical, &home)
            || (provider == "codex" && codex_owned(installation, &home))
        {
            if provider == "kimi" && version.numbers < [2, 0, 2] {
                return Err("This Kimi version does not support a verified unattended upgrade. Update it once using the official installation guide.".into());
            }
            if provider == "codex" && version.numbers < [0, 154, 0] {
                return Err("This Codex version predates the verified native update command. Use the official installation guide.".into());
            }
            if provider == "opencode" && version.numbers[0] != 1 {
                return Err("This OpenCode major version uses a different updater. Use its official installation guide.".into());
            }
            return Ok(Plan::Native {
                path: installation.path.clone(),
                provider: provider.into(),
            });
        }
    }
    if provider == "kimi" {
        if let Some(uv) = uv_owned(installation) {
            return Ok(uv);
        }
    }
    Err("This installation is not managed by a supported updater. Follow the official installation guide to update it.".into())
}

pub(super) fn source(
    installation: &Installation,
    version: &Version,
    plan: Option<&Plan>,
) -> Result<String> {
    let provider = family(&installation.provider);
    if provider == "claude"
        && std::env::var("DISABLE_UPDATES").is_ok_and(|v| !v.is_empty() && v != "0")
    {
        return Err("Claude updates are disabled by this environment. Follow your administrator's update policy.".into());
    }
    if provider == "opencode" && version.numbers[0] != 1 {
        return Err("This OpenCode major version uses a different release feed. Use its official installation guide.".into());
    }
    Ok(match plan {
        Some(Plan::Npm { .. }) => format!("npm:{provider}"),
        Some(Plan::Brew { package, cask, .. }) => {
            format!("brew:{}:{package}", if *cask { "cask" } else { "formula" })
        }
        Some(Plan::Uv { .. }) => "kimi-python".into(),
        _ if provider == "kimi" => {
            let home = crate::agent_usage_providers::home()
                .ok_or("Kimi's installation family could not be verified.")?;
            if native_owned("kimi", &installation.path, &installation.canonical, &home) {
                "kimi".into()
            } else {
                return Err("This Kimi installation could not be matched to the native or Python release line. Follow its official installation guide.".into());
            }
        }
        _ if provider == "claude" || provider == "grok" => native_channel(provider)?,
        _ => provider.into(),
    })
}

fn native_channel(provider: &str) -> Result<String> {
    let home =
        crate::agent_usage_providers::home().ok_or("The agent's home directory is unavailable.")?;
    if provider == "claude" {
        if std::env::var("DISABLE_UPDATES").is_ok_and(|v| !v.is_empty() && v != "0") {
            return Err("Claude updates are disabled by this environment. Follow your administrator's update policy.".into());
        }
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        let path = root.join("settings.json");
        if !path.exists() {
            return Ok("claude".into());
        }
        let data = bytes(&path, 256 * 1024).ok_or(
            "Claude's release channel could not be read. Update it with its official CLI.",
        )?;
        return claude_channel(&data);
    }
    let root = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"));
    if [
        root.join("managed_config.toml"),
        root.join("requirements.toml"),
        PathBuf::from("/etc/grok/managed_config.toml"),
        PathBuf::from("/etc/grok/requirements.toml"),
    ]
    .iter()
    .any(|p| p.exists())
    {
        return Err("Grok uses managed update policy. Use its official CLI or ask your administrator to update it.".into());
    }
    let path = root.join("config.toml");
    if !path.exists() {
        return Ok("grok".into());
    }
    let data = bytes(&path, 256 * 1024)
        .ok_or("Grok's release channel could not be read. Update it with its official CLI.")?;
    grok_channel(&data)
}

fn claude_channel(data: &[u8]) -> Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Settings {
        auto_updates_channel: Option<String>,
        required_maximum_version: Option<String>,
    }
    let settings: Settings =
        serde_json::from_slice(data).map_err(|_| "Claude's release channel could not be read.")?;
    if settings.required_maximum_version.is_some() {
        return Err(
            "Claude has a version policy. Use its official CLI to update within that policy."
                .into(),
        );
    }
    match settings.auto_updates_channel.as_deref() {
        None | Some("latest") => Ok("claude".into()),
        Some("stable") => Ok("claude:stable".into()),
        _ => Err("Claude's release channel is not supported for updates here.".into()),
    }
}

fn grok_channel(data: &[u8]) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct Config {
        cli: Option<Cli>,
    }
    #[derive(serde::Deserialize)]
    struct Cli {
        channel: Option<String>,
    }
    let config: Config = toml::from_str(
        std::str::from_utf8(data).map_err(|_| "Grok's release channel could not be read.")?,
    )
    .map_err(|_| "Grok's release channel could not be read.")?;
    match config.cli.and_then(|cli| cli.channel).as_deref() {
        None | Some("stable") => Ok("grok".into()),
        Some("alpha") => Ok("grok:alpha".into()),
        Some("enterprise") => Ok("grok:enterprise".into()),
        _ => Err("Grok's release channel is not supported for updates here.".into()),
    }
}

fn update_command(plan: &Plan, target: &Version) -> Result<Command> {
    let mut cmd = match plan {
        Plan::Native { path, provider } => {
            let mut cmd = command(path)?;
            match provider.as_str() {
                "grok" => {
                    cmd.args(["--no-auto-update", "update"]);
                }
                "kimi" => {
                    cmd.args(["upgrade", "--yes"]);
                }
                "opencode" => {
                    cmd.args(["upgrade", &target.text, "--method", "curl"]);
                }
                "claude" | "codex" => {
                    cmd.arg("update");
                }
                _ => return Err("Unsupported native updater.".into()),
            }
            cmd
        }
        Plan::Npm {
            node,
            cli,
            prefix,
            package,
        } => {
            let mut cmd = Command::new(crate::providers::external_path(node));
            let mut prefix_arg = std::ffi::OsString::from("--prefix=");
            prefix_arg.push(crate::providers::external_path(prefix));
            cmd.arg(crate::providers::external_path(cli))
                .args([
                    "install",
                    "--global",
                    "--no-audit",
                    "--no-fund",
                    "--registry=https://registry.npmjs.org",
                ])
                .arg(prefix_arg)
                .arg(format!("{package}@{}", target.text))
                .current_dir(prefix);
            if let Some(scope) = package
                .strip_prefix('@')
                .and_then(|p| p.split_once('/').map(|p| p.0))
            {
                cmd.arg(format!("--@{scope}:registry=https://registry.npmjs.org"));
            }
            cmd
        }
        Plan::Brew {
            executable,
            package,
            cask,
        } => {
            let mut cmd = Command::new(executable);
            cmd.arg("upgrade")
                .arg(if *cask { "--cask" } else { "--formula" })
                .arg(package)
                .env("HOMEBREW_NO_ENV_HINTS", "1");
            cmd
        }
        Plan::Uv { executable, root } => {
            let mut cmd = Command::new(crate::providers::external_path(executable));
            cmd.args(["tool", "upgrade", "kimi-cli", "--no-progress"])
                .env("UV_TOOL_DIR", crate::providers::external_path(root));
            cmd
        }
    };
    cmd.env_remove("DISABLE_AUTOUPDATER");
    Ok(cmd)
}

pub(super) fn apply(
    plan: &Plan,
    path: &Path,
    provider: &str,
    before: &Version,
    target: &Version,
    verifying: impl FnOnce(),
) -> Result<Version> {
    apply_with(plan, path, provider, before, target, verifying, run_output)
}

fn apply_with(
    plan: &Plan,
    path: &Path,
    provider: &str,
    before: &Version,
    target: &Version,
    verifying: impl FnOnce(),
    mut run: impl FnMut(Command, Duration, bool) -> Result<String>,
) -> Result<Version> {
    run(
        update_command(plan, target)?,
        Duration::from_secs(180),
        true,
    )?;
    verifying();
    let after = super::parse_version(&run(
        version_command(path, provider)?,
        Duration::from_secs(5),
        false,
    )?)
    .ok_or("Could not verify the updated executable's version.")?;
    if !after.at_least(target) {
        return Err(if after == *before {
            "The updater finished without changing this executable. It may be pinned or managed by a different release channel. Follow the official guide."
        } else { "The executable changed, but did not reach the checked release. Check its release channel in the official guide." }.into());
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_ownership_accepts_managed_launcher_but_never_a_pinned_version_or_wrapper() {
        let home = Path::new("/home/tester");
        let bin = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        let version = home.join(".local/share/claude/versions/2.1.280");
        assert!(native_owned(
            "claude",
            &home.join(".local/bin").join(bin),
            &version,
            home
        ));
        assert!(!native_owned("claude", &version, &version, home));
        assert!(!native_owned(
            "claude",
            &home.join("custom/claude"),
            &version,
            home
        ));
        assert!(!native_owned(
            "claude",
            &home.join(".local/bin").join(bin),
            &home.join("custom/claude"),
            home
        ));
        assert!(!native_owned(
            "antigravity",
            &home.join(".local/bin/agy_acp_server.par"),
            &version,
            home
        ));
    }

    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-updater-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn explicit_codex_update_accepts_legacy_current_launcher_without_auto_update_marker() {
        let dir = fixture();
        let root = dir.join("standalone");
        let release = root.join("releases/0.154.0-target");
        let launcher = dir.join("bin");
        std::fs::create_dir_all(release.join("bin")).unwrap();
        std::fs::create_dir_all(&launcher).unwrap();
        let binary = release.join("bin/codex");
        std::fs::write(&binary, "fixture").unwrap();
        std::os::unix::fs::symlink(&release, root.join("current")).unwrap();
        let selected = launcher.join("codex");
        std::os::unix::fs::symlink(root.join("current/bin/codex"), &selected).unwrap();
        assert!(codex_owned_at(
            &installation("codex", &selected),
            &root,
            &launcher,
            "codex"
        ));
        assert!(!codex_owned_at(
            &installation("codex", &binary),
            &root,
            &launcher,
            "codex"
        ));
        std::fs::write(root.join("auto-update-version"), "not-a-version").unwrap();
        assert!(codex_owned_at(
            &installation("codex", &selected),
            &root,
            &launcher,
            "codex"
        ));
        assert!(!codex_owned_at(
            &installation("codex", &binary),
            &root,
            &launcher,
            "codex"
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn installation(provider: &str, path: &Path) -> Installation {
        Installation {
            provider: provider.into(),
            name: provider.into(),
            providers: vec![provider.into()],
            path: path.to_path_buf(),
            canonical: path
                .canonicalize()
                .map(|p| crate::providers::external_path(&p))
                .unwrap_or_else(|_| path.to_path_buf()),
            modified: None,
            size: 0,
            compatible: true,
        }
    }

    #[test]
    fn npm_ownership_uses_declared_bin_and_rejects_local_or_escaping_packages() {
        let dir = fixture();
        let package = dir.join("lib/node_modules/@openai/codex");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        let bin = package.join("bin/codex.js");
        std::fs::write(&bin, "fixture").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        let install = installation("codex", &bin);
        let root = npm_package(&install, "@openai/codex", false).unwrap();
        assert_eq!(
            global_prefix(&root, "@openai/codex", false),
            Some(dir.canonicalize().unwrap())
        );
        assert!(global_prefix(
            &dir.join("node_modules/@openai/codex"),
            "@openai/codex",
            false
        )
        .is_none());
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","bin":{"codex":"../../outside.js"}}"#,
        )
        .unwrap();
        assert!(npm_package(&install, "@openai/codex", false).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn windows_npm_shim_must_name_the_exact_manifest_entry() {
        let dir = fixture();
        let package = dir.join("node_modules/@openai/codex");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(package.join("bin/codex.js"), "fixture").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        let shim = dir.join("codex.cmd");
        std::fs::write(&shim, "@ECHO off\nnode.exe\n\"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\n").unwrap();
        assert!(npm_package(&installation("codex", &shim), "@openai/codex", true).is_some());
        std::fs::write(&shim, "@ECHO off\nnode.exe custom.js %*\n").unwrap();
        assert!(npm_package(&installation("codex", &shim), "@openai/codex", true).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_manager_probes_are_deduplicated_and_stop_after_three_attempts() {
        let dir = fixture();
        let root = dir.join("npm");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let cli = root.join("bin/npm-cli.js");
        std::fs::write(&cli, "fixture").unwrap();
        std::fs::write(root.join("package.json"), r#"{"name":"npm"}"#).unwrap();
        let nodes: Vec<_> = (0..10)
            .map(|n| {
                let path = dir.join(format!("node{n}"));
                std::fs::write(&path, "fixture").unwrap();
                path
            })
            .collect();
        assert_eq!(distinct_files(vec![cli.clone(); 90]).len(), 1);
        let mut count = 0;
        let result = npm_manager_with(&dir, nodes, vec![cli; 90], |_, timeout| {
            count += 1;
            assert!(timeout <= Duration::from_secs(3));
            Err("fixture failure".into())
        });
        assert!(result.is_none());
        assert_eq!(count, 3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_channels_ignore_unrelated_settings_and_unknown_families_stay_manual() {
        assert_eq!(
            claude_channel(br#"{"autoUpdatesChannel":"stable","env":{"unrelated":"fixture"}}"#)
                .unwrap(),
            "claude:stable"
        );
        assert!(claude_channel(br#"{"autoUpdatesChannel":"other"}"#).is_err());
        assert_eq!(
            grok_channel(b"[cli]\nchannel='enterprise'\n[unrelated]\nvalue='fixture'").unwrap(),
            "grok:enterprise"
        );
        let version = super::super::parse_version("2.0.0").unwrap();
        assert!(source(
            &installation("opencode", Path::new("/unknown/opencode")),
            &version,
            None
        )
        .is_err());
        assert!(source(
            &installation("kimi", Path::new("/unknown/kimi")),
            &version,
            None
        )
        .is_err());
    }

    #[test]
    fn npm_update_has_fixed_registry_prefix_package_and_literal_arguments() {
        let plan = Plan::Npm {
            node: "/tools/node".into(),
            cli: "/tools/npm/bin/npm-cli.js".into(),
            prefix: "/tools/my prefix".into(),
            package: "@openai/codex",
        };
        let command =
            update_command(&plan, &super::super::parse_version("0.156.1").unwrap()).unwrap();
        assert_eq!(command.get_program(), "/tools/node");
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"--prefix=/tools/my prefix".into()));
        assert!(args.contains(&"@openai/codex@0.156.1".into()));
        assert!(args.contains(&"--@openai:registry=https://registry.npmjs.org".into()));
        assert!(!args.iter().any(|arg| arg == "-c" || arg.contains("curl")));
    }

    #[test]
    fn successful_installer_must_verify_current_version_and_failure_never_claims_success() {
        let plan = Plan::Native {
            path: "/fixture/claude".into(),
            provider: "claude".into(),
        };
        let before = super::super::parse_version("2.1.1").unwrap();
        let target = super::super::parse_version("2.1.2").unwrap();
        for (reported, success) in [
            ("2.1.2 (Claude Code)", true),
            ("2.1.1", false),
            ("invalid", false),
        ] {
            let mut commands = 0;
            let mut verifying = false;
            let result = apply_with(
                &plan,
                Path::new("/fixture/claude"),
                "claude",
                &before,
                &target,
                || verifying = true,
                |command, timeout, allow_truncated| {
                    commands += 1;
                    if commands == 1 {
                        assert_eq!(command.get_args().last().unwrap(), "update");
                        assert_eq!(timeout, Duration::from_secs(180));
                        assert!(allow_truncated);
                        Ok("installer output".repeat(2000))
                    } else {
                        assert_eq!(command.get_args().last().unwrap(), "--version");
                        assert!(!allow_truncated);
                        Ok(reported.into())
                    }
                },
            );
            assert_eq!(result.is_ok(), success);
            assert!(verifying);
            assert_eq!(commands, 2);
        }
        let mut verifying = false;
        assert!(apply_with(
            &plan,
            Path::new("/fixture/claude"),
            "claude",
            &before,
            &target,
            || verifying = true,
            |_, _, _| Err("fixture install failure".into())
        )
        .is_err());
        assert!(!verifying);
    }
}
