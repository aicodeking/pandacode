//! Platform-aware harness launch without putting model settings through a batch shell.
use std::{
    ffi::OsString,
    io::Read,
    path::{Component, Path, PathBuf},
};

struct Launch {
    program: PathBuf,
    args: Vec<OsString>,
}

/// Canonical Windows paths are useful for native file operations, but Node and
/// ACP servers may interpret the extended namespace as part of the drive name.
/// Only simplify paths with ordinary Win32 semantics; device/long/special paths
/// must retain their prefix rather than silently refer to a different file.
pub(crate) fn external_path(path: &Path) -> PathBuf {
    external_path_for(path, cfg!(windows))
}

fn external_path_for(path: &Path, windows: bool) -> PathBuf {
    if windows {
        if let Some(text) = path.to_str() {
            if let Some(path) = ordinary_windows_path(text) {
                return path.into();
            }
        }
    }
    path.to_owned()
}

fn ordinary_windows_path(path: &str) -> Option<String> {
    let extended = path.strip_prefix(r"\\?\")?;
    let ordinary = if let Some(unc) = extended.strip_prefix(r"UNC\") {
        if unc.split('\\').filter(|part| !part.is_empty()).count() < 2 {
            return None;
        }
        format!(r"\\{unc}")
    } else if extended.as_bytes().get(1..3) == Some(b":\\")
        && extended.as_bytes()[0].is_ascii_alphabetic()
    {
        extended.to_owned()
    } else {
        return None;
    };
    if ordinary.encode_utf16().count() >= 260 {
        return None;
    }
    for part in ordinary.split('\\').filter(|part| !part.is_empty()) {
        let name = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
        if part.ends_with([' ', '.'])
            || part.contains(['/', '*', '?'])
            || matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || (name.len() == 4
                && (name.starts_with("COM") || name.starts_with("LPT"))
                && matches!(name.as_bytes()[3], b'1'..=b'9'))
            || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&name.as_str())
        {
            return None;
        }
    }
    Some(ordinary)
}

fn resolve(path: &Path, windows: bool) -> Result<Launch, String> {
    let batch = path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    });
    if !windows || !batch {
        return Ok(Launch {
            program: external_path_for(path, windows),
            args: Vec::new(),
        });
    }
    // npm shims forward arguments through cmd.exe. Launch their declared bin
    // directly instead, so paths, JSON and model names never become shell syntax.
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let package =
        match name.as_str() {
            "codex" => "@openai/codex",
            "claude" => "@anthropic-ai/claude-code",
            "opencode" => "opencode-ai",
            "pi" => "@earendil-works/pi-coding-agent",
            "dsh" => "@deepseek-ai/dsh",
            "command-code" | "cmdc" | "commandcode" => "command-code",
            "copilot" => "@github/copilot",
            "cline" => "cline",
            "kilo" | "kilocode" => "@kilocode/cli",
            _ => return Err(
                "This batch launcher is unsupported. Select the native harness executable instead."
                    .into(),
            ),
        };
    let directory = path
        .parent()
        .ok_or("The npm launcher has no installation folder.")?;
    let modules = if directory.file_name().is_some_and(|name| name == ".bin") {
        directory
            .parent()
            .ok_or("The npm launcher has no package folder.")?
            .to_path_buf()
    } else {
        directory.join("node_modules")
    };
    let script = match modules.join(package).canonicalize() {
        Ok(package) => declared_entry(&package, &name)?,
        Err(_) => shim_entry(path, directory, &name)
            .or_else(|| sibling_launcher(path, directory))
            .ok_or_else(|| format!("The npm harness package could not be found. Reinstall it with `npm install -g {package}` or select its native executable."))?,
    };
    let host = script.file_name().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
    if ["cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe"].contains(&host.as_str()) {
        return Err("The npm harness executable must not be a shell.".into());
    }
    if script
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Ok(Launch {
            program: external_path_for(&script, windows),
            args: Vec::new(),
        });
    }
    let adjacent_node = directory.join("node.exe");
    let node = adjacent_node.is_file().then_some(adjacent_node)
        .or_else(|| find_native_node(search_directories(true, &|key| std::env::var_os(key))))
        .ok_or("Node.js is required by this npm-installed harness. Install Node.js or use the native harness installer.")?;
    Ok(Launch {
        program: external_path_for(&node, windows),
        args: vec![external_path_for(&script, windows).into_os_string()],
    })
}

/// The executable a package declares in `package.json` `bin`, kept inside the package.
fn declared_entry(package: &Path, name: &str) -> Result<PathBuf, String> {
    let file = std::fs::File::open(package.join("package.json"))
        .map_err(|_| "Could not read the npm harness package metadata.")?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the npm harness package metadata.")?;
    if bytes.len() > 64 * 1024 {
        return Err("The npm harness metadata is too large.".into());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The npm harness package metadata is invalid.")?;
    let bin = metadata["bin"]
        .as_str()
        .or_else(|| metadata["bin"][name].as_str())
        .ok_or("The npm harness package has no matching executable entry.")?
        .replace('\\', "/");
    if bin.is_empty()
        || bin.chars().any(char::is_control)
        || Path::new(&bin)
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("The npm harness executable must stay inside its package.".into());
    }
    let script = package
        .join(bin)
        .canonicalize()
        .map_err(|_| "The npm harness executable could not be found.")?;
    if !script.starts_with(package) || !script.is_file() {
        return Err("The npm harness executable must stay inside its package.".into());
    }
    Ok(script)
}

/// pnpm global shims point into a hashed store instead of a `node_modules` beside
/// them. Accept a `%~dp0`-relative target the shim names only when it is exactly the
/// entry its own package declares, so the shim never chooses what runs.
fn shim_entry(shim: &Path, directory: &Path, name: &str) -> Option<PathBuf> {
    shim_tokens(shim)?.into_iter().find_map(|token| {
        let target = shim_target(directory, &token)?;
        target
            .ancestors()
            .skip(1)
            .take(8)
            .any(|package| declared_entry(package, name).ok().as_ref() == Some(&target))
            .then_some(target)
    })
}

/// Standalone installers (pi.dev's managed install) write `"%node%" "%~dp0pi-launcher.js" %*`.
/// Accept only a Node script that sits beside the shim itself and is started by node.
fn sibling_launcher(shim: &Path, directory: &Path) -> Option<PathBuf> {
    let directory = directory.canonicalize().ok()?;
    shim_tokens(shim)?.windows(2).find_map(|pair| {
        let host = pair[0].rsplit(['\\', '/']).next()?.to_ascii_lowercase();
        if !matches!(host.as_str(), "%node%" | "node" | "node.exe") {
            return None;
        }
        let target = shim_target(&directory, &pair[1])?;
        (target.parent() == Some(directory.as_path())
            && target.is_file()
            && target.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("js")))
        .then_some(target)
    })
}

/// The double-quoted words of a batch shim.
fn shim_tokens(shim: &Path) -> Option<Vec<String>> {
    let mut text = String::new();
    std::fs::File::open(shim)
        .ok()?
        .take(64 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    Some(text.split('"').skip(1).step_by(2).map(str::to_owned).collect())
}

/// A `%~dp0`-relative shim word as a real path, refusing other variables.
fn shim_target(directory: &Path, token: &str) -> Option<PathBuf> {
    let prefix = token.get(..5)?;
    if !prefix.eq_ignore_ascii_case("%~dp0") && !prefix.eq_ignore_ascii_case("%dp0%") {
        return None;
    }
    let relative = token[5..].trim_start_matches(['\\', '/']).replace('\\', "/");
    if relative.contains(['%', '!']) {
        return None;
    }
    directory.join(relative).canonicalize().ok()
}

fn find_native_node(directories: Vec<PathBuf>) -> Option<PathBuf> {
    directories
        .into_iter()
        .map(|dir| dir.join("node.exe"))
        .find(|path| path.is_file())
}
pub(crate) fn command(path: &Path) -> Result<tokio::process::Command, String> {
    let launch = resolve(path, cfg!(windows))?;
    let mut command = tokio::process::Command::new(launch.program);
    command.args(launch.args);
    crate::child_env::sanitize(&mut command);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: stdio adapters have no console UI.
    Ok(command)
}

pub(super) fn std_command(path: &Path) -> Result<std::process::Command, String> {
    let launch = resolve(path, cfg!(windows))?;
    let mut command = std::process::Command::new(launch.program);
    command.args(launch.args);
    crate::child_env::sanitize(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub(crate) fn pty_command(path: &Path) -> Result<portable_pty::CommandBuilder, String> {
    let launch = resolve(path, cfg!(windows))?;
    let mut command = portable_pty::CommandBuilder::new(launch.program);
    command.args(launch.args);
    crate::child_env::sanitize(&mut command);
    Ok(command)
}

fn home_directory(windows: bool, env: &impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let first = if windows { "USERPROFILE" } else { "HOME" };
    let second = if windows { "HOME" } else { "USERPROFILE" };
    env(first)
        .filter(|value| !value.is_empty())
        .or_else(|| env(second).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .or_else(|| {
            windows
                .then(|| {
                    let mut drive = env("HOMEDRIVE")?;
                    drive.push(env("HOMEPATH")?);
                    Some(PathBuf::from(drive))
                })
                .flatten()
        })
}

fn search_directories(windows: bool, env: &impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = env("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let home = home_directory(windows, env);
    if let Some(home) = &home {
        for dir in [
            ".local/bin",
            ".kimi-code/bin",
            ".kimi-code/Scripts",
            ".opencode/bin",
            ".kilo/bin",
            ".cargo/bin",
            ".bun/bin",
            ".grok/bin",
            ".volta/bin",
            ".npm-global/bin",
        ] {
            dirs.push(home.join(dir));
        }
    }
    dirs.extend(node_manager_dirs(windows, env, home.as_deref()));
    if windows {
        if let Some(appdata) = env("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join("AppData/Roaming")))
        {
            dirs.push(appdata.join("npm"));
        }
        if let Some(local) = env("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join("AppData/Local")))
        {
            dirs.push(local.join("Microsoft/WinGet/Links"));
            // The standalone Node the pi.dev installer can add.
            dirs.push(local.join("pi-node/current"));
        }
        if let Some(programs) = env("ProgramFiles").filter(|value| !value.is_empty()) {
            dirs.push(PathBuf::from(programs).join("nodejs"));
        }
        if let Some(system) = env("SystemRoot").filter(|value| !value.is_empty()) {
            dirs.push(PathBuf::from(system).join("System32/WindowsPowerShell/v1.0"));
        }
    } else {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            dirs.push(PathBuf::from(dir));
        }
    }
    let npm = npm_global_bin(windows, env, home.as_deref(), &dirs);
    dirs.extend(npm);
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// Node installed by a version manager (fnm, nvm, mise, asdf, nvm-windows), whose shell
/// exports never reach an app opened from the Dock: its default version, else the newest.
fn node_manager_dirs(
    windows: bool,
    env: &impl Fn(&str) -> Option<OsString>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let var = |key: &str| env(key).filter(|value| !value.is_empty()).map(PathBuf::from);
    let under_home = |dir: &str| home.map(|home| home.join(dir));
    let bin = |dir: PathBuf| if windows { dir } else { dir.join("bin") };
    let mut dirs = Vec::new();
    let fnm = [
        var("FNM_DIR"),
        under_home(".local/share/fnm"),
        under_home("Library/Application Support/fnm"),
        windows.then(|| var("APPDATA").map(|data| data.join("fnm"))).flatten(),
    ];
    for root in fnm.into_iter().flatten() {
        let default = root.join("aliases/default");
        let installation = if default.exists() {
            Some(default)
        } else {
            newest_version(&root.join("node-versions"), "").map(|dir| dir.join("installation"))
        };
        dirs.extend(installation.map(bin));
    }
    if let Some(root) = var("NVM_DIR").or_else(|| under_home(".nvm")) {
        let versions = root.join("versions/node");
        let alias = std::fs::read_to_string(root.join("alias/default")).unwrap_or_default();
        let alias = alias.trim();
        let prefix = match alias.strip_prefix('v').unwrap_or(alias) {
            number if number.starts_with(|c: char| c.is_ascii_digit()) => format!("v{number}"),
            _ => String::new(),
        };
        let version = newest_version(&versions, &prefix).or_else(|| newest_version(&versions, ""));
        dirs.extend(version.map(|dir| dir.join("bin")));
    }
    for (root, installs) in [
        (var("MISE_DATA_DIR").or_else(|| under_home(".local/share/mise")), "installs/node"),
        (var("ASDF_DATA_DIR").or_else(|| under_home(".asdf")), "installs/nodejs"),
    ] {
        dirs.extend(root.and_then(|root| newest_version(&root.join(installs), "")).map(bin));
    }
    if windows {
        dirs.extend(var("NVM_SYMLINK"));
        dirs.extend(var("NVM_HOME").and_then(|root| newest_version(&root, "")));
    }
    dirs
}

/// The newest `v1.2.3`/`1.2.3` folder in `dir` (numeric comparison), optionally only
/// those equal to `prefix` or under it (`v22` matches `v22.1.0`, not `v220.0.0`).
fn newest_version(dir: &Path, prefix: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !prefix.is_empty() && name != prefix && !name.starts_with(&format!("{prefix}.")) {
                return None;
            }
            let version = name
                .strip_prefix('v')
                .unwrap_or(&name)
                .split('.')
                .map(|part| part.parse::<u64>().ok())
                .collect::<Option<Vec<_>>>()?;
            Some((version, entry.path()))
        })
        .max()
        .map(|(_, path)| path)
}

/// Where `npm i -g` puts CLIs, located the way npm does, without running it: a configured
/// `prefix` (environment, then `~/.npmrc`), else the prefix of the real `node` binary, so
/// a node reached through a symlink (`~/.local/bin/node`, a version manager) still counts.
fn npm_global_bin(
    windows: bool,
    env: &impl Fn(&str) -> Option<OsString>,
    home: Option<&Path>,
    dirs: &[PathBuf],
) -> Option<PathBuf> {
    let npmrc = || {
        let text = std::fs::read_to_string(home?.join(".npmrc")).ok()?;
        let value = text.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "prefix").then(|| value.trim().trim_matches('"').to_owned())
        })?;
        Some(match (value.strip_prefix("~/"), home) {
            (Some(rest), Some(home)) => home.join(rest),
            _ => PathBuf::from(value),
        })
    };
    let configured = ["NPM_CONFIG_PREFIX", "npm_config_prefix"]
        .iter()
        .find_map(|key| env(key).filter(|value| !value.is_empty()).map(PathBuf::from))
        .or_else(npmrc)
        .filter(|prefix| prefix.is_absolute());
    // Windows' default prefix (%APPDATA%\npm) is already searched and holds the shims itself.
    if windows {
        return configured;
    }
    let prefix = configured.or_else(|| {
        let node = find_in_directories("node", dirs.to_vec(), false)?.canonicalize().ok()?;
        Some(node.parent()?.parent()?.to_path_buf())
    })?;
    Some(prefix.join("bin"))
}

/// GUI launches inherit a minimal PATH. Use the same ordered locations as CLI
/// discovery for scripts, without evaluating a user's shell startup files.
pub(crate) fn executable_path() -> Result<OsString, String> {
    executable_path_for(cfg!(windows), &|name| std::env::var_os(name))
}

/// Widens this process's PATH to the installed-tool locations, once, at startup. Apps opened
/// from Finder or the Dock start with PATH=/usr/bin:/bin, and every agent, script and helper
/// PandaCode launches inherits it: without this, an agent cannot run `gh`, `node` or anything
/// else installed with Homebrew, even though the user's terminal can. Existing entries keep
/// their order; missing standard locations are appended.
pub(crate) fn widen_process_path() {
    if let Ok(path) = executable_path() {
        std::env::set_var("PATH", path);
    }
}

fn executable_path_for(
    windows: bool,
    env: &impl Fn(&str) -> Option<OsString>,
) -> Result<OsString, String> {
    std::env::join_paths(search_directories(windows, env))
        .map_err(|_| "Could not prepare the installed tools search path.".into())
}

fn find_in_directories(name: &str, dirs: Vec<PathBuf>, windows: bool) -> Option<PathBuf> {
    let extensions: &[&str] = if windows {
        &[".exe", ".com", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    for dir in dirs {
        for extension in extensions {
            let path = dir.join(format!("{name}{extension}"));
            let Ok(metadata) = path.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            #[cfg(unix)]
            if !windows {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(path);
        }
    }
    None
}

pub(super) fn find(name: &str) -> Option<PathBuf> {
    find_in_directories(
        name,
        search_directories(cfg!(windows), &|key| std::env::var_os(key)),
        cfg!(windows),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn windows_external_paths_remove_only_safe_namespace_prefixes() {
        for (extended, ordinary) in [
            (r"\\?\C:\project", r"C:\project"),
            (r"\\?\D:\npm path & spaces\node_modules\@openai\codex\bin\codex.js", r"D:\npm path & spaces\node_modules\@openai\codex\bin\codex.js"),
            (r"\\?\UNC\server\share\project", r"\\server\share\project"),
            (r"\\?\C:\", r"C:\"),
        ] {
            assert_eq!(ordinary_windows_path(extended).as_deref(), Some(ordinary));
            assert_eq!(external_path_for(Path::new(extended), true), Path::new(ordinary));
            assert_eq!(external_path_for(Path::new(extended), false), Path::new(extended));
        }
        for path in [r"C:\project", "/tmp/project", r"\\.\pipe\agent", r"\\?\Volume{abc}\project", r"\\?\C:\trailing.", r"\\?\C:\trailing ", r"\\?\C:\NUL.txt", r"\\?\C:\COM1", r"\\?\C:\a\..\b", r"\\?\UNC\server"] {
            assert_eq!(ordinary_windows_path(path), None, "{path}");
            assert_eq!(external_path_for(Path::new(path), true), Path::new(path));
        }
        assert!(ordinary_windows_path(&format!(r"\\?\C:\{}", "x".repeat(260))).is_none());
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("pandacode-launch-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn file(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn executable(f: &Fixture, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = f.file(name, "#!/bin/sh\n");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn npm_global_clis_are_found_beside_the_real_node_or_a_configured_prefix() {
        let f = Fixture::new();
        // node installed under its own prefix, reached only through a symlink on PATH.
        let node = executable(&f, "runtime/bin/node");
        // A name no system directory holds, so a real Homebrew CLI cannot answer first.
        let cli = "pandacode-fixture-npm-cli";
        let dsh = executable(&f, &format!("runtime/bin/{cli}"));
        fs::create_dir_all(f.0.join("links")).unwrap();
        std::os::unix::fs::symlink(&node, f.0.join("links/node")).unwrap();
        let path = f.0.join("links").into_os_string();
        let home = f.0.join("home").into_os_string();
        let env = |key: &str| match key {
            "PATH" => Some(path.clone()),
            "HOME" => Some(home.clone()),
            _ => None,
        };
        assert_eq!(find_in_directories(cli, search_directories(false, &env), false), Some(dsh));
        // A prefix set with `npm config set prefix` wins over node's own.
        let configured = executable(&f, &format!("home/.npm-packages/bin/{cli}"));
        f.file("home/.npmrc", "fund=false\nprefix = ~/.npm-packages\n");
        assert_eq!(find_in_directories(cli, search_directories(false, &env), false), Some(configured));
    }

    #[cfg(unix)]
    #[test]
    fn grok_installer_directory_is_searched() {
        let f = Fixture::new();
        // The official Grok Build installer puts the CLI in ~/.grok/bin only.
        let grok = executable(&f, "home/.grok/bin/pandacode-fixture-grok");
        let home = f.0.join("home").into_os_string();
        let env = |key: &str| (key == "HOME").then(|| home.clone());
        assert_eq!(
            find_in_directories("pandacode-fixture-grok", search_directories(false, &env), false),
            Some(grok)
        );
    }

    #[test]
    fn windows_npm_launches_node_entry_without_a_batch_shell() {
        let f = Fixture::new();
        let shim = f.file("npm path & spaces/codex.cmd", "@echo off\r\n");
        let node = f.file("npm path & spaces/node.exe", "");
        f.file(
            "npm path & spaces/node_modules/@openai/codex/package.json",
            r#"{"bin":{"codex":"bin/codex.js"}}"#,
        );
        let script = f.file(
            "npm path & spaces/node_modules/@openai/codex/bin/codex.js",
            "#!/usr/bin/env node\n",
        );
        let launch = resolve(&shim, true).unwrap();
        assert_eq!(launch.program, external_path_for(&node, true));
        assert_eq!(launch.args, [external_path_for(&script, true).into_os_string()]);
    }

    #[test]
    fn windows_pnpm_shims_run_only_the_entry_their_package_declares() {
        let f = Fixture::new();
        let package = "pnpm/global/v11/hash/node_modules/opencode-ai";
        f.file(&format!("{package}/package.json"), r#"{"bin":{"opencode":"./bin/opencode.exe"}}"#);
        let binary = f.file(&format!("{package}/bin/opencode.exe"), "");
        f.file(&format!("{package}/bin/other.exe"), "");
        let shim = f.file(
            "pnpm/bin/opencode.cmd",
            "@SETLOCAL\r\n@\"%~dp0\\..\\global\\v11\\hash\\node_modules\\opencode-ai\\bin\\opencode.exe\"  %*\r\n",
        );
        let launch = resolve(&shim, true).unwrap();
        assert_eq!(launch.program, external_path_for(&binary, true));
        assert!(launch.args.is_empty());
        f.file(
            "pnpm/bin/opencode.cmd",
            "@\"%~dp0\\..\\global\\v11\\hash\\node_modules\\opencode-ai\\bin\\other.exe\" %*\r\n",
        );
        assert!(resolve(&shim, true).is_err());
    }

    #[test]
    fn windows_pnpm_node_shims_run_the_declared_script_with_the_adjacent_node() {
        let f = Fixture::new();
        let node = f.file("pnpm/bin/node.exe", "");
        let package = "pnpm/global/v11/hash/node_modules/@earendil-works/pi-coding-agent";
        f.file(&format!("{package}/package.json"), r#"{"bin":{"pi":"dist/bundle/cli.js"}}"#);
        let script = f.file(&format!("{package}/dist/bundle/cli.js"), "");
        let shim = f.file(
            "pnpm/bin/pi.cmd",
            "@SETLOCAL\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\global\\v11\\hash\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*\r\n)\r\n",
        );
        let launch = resolve(&shim, true).unwrap();
        assert_eq!(launch.program, external_path_for(&node, true));
        assert_eq!(launch.args, [external_path_for(&script, true).into_os_string()]);
    }

    #[test]
    fn windows_pi_managed_install_runs_its_sibling_launcher_with_node() {
        let f = Fixture::new();
        let node = f.file("pi/agent/bin/node.exe", "");
        f.file("pi/agent/install/managed-install.json", "{}");
        let launcher = f.file("pi/agent/bin/pi-launcher.js", "");
        let shim = f.file(
            "pi/agent/bin/pi.cmd",
            "@ECHO off\r\nSETLOCAL\r\nSET \"node=node\"\r\n\"%node%\" \"%~dp0pi-launcher.js\" %*\r\n",
        );
        let launch = resolve(&shim, true).unwrap();
        assert_eq!(launch.program, external_path_for(&node, true));
        assert_eq!(launch.args, [external_path_for(&launcher, true).into_os_string()]);
        // Not node, not beside the shim, or not a script: refused, with the npm hint.
        f.file("pi/agent/elsewhere.js", "");
        f.file("pi/agent/bin/pi-launcher.exe", "");
        for body in [
            "\"%other%\" \"%~dp0pi-launcher.js\" %*",
            "\"%node%\" \"%~dp0..\\elsewhere.js\" %*",
            "\"%node%\" \"%~dp0pi-launcher.exe\" %*",
            "\"%node%\" \"%~dp0missing.js\" %*",
        ] {
            f.file("pi/agent/bin/pi.cmd", body);
            let error = resolve(&shim, true).err().unwrap();
            assert!(error.contains("npm install -g @earendil-works/pi-coding-agent"), "{body}: {error}");
        }
    }

    #[test]
    fn version_manager_node_folders_prefer_the_default_then_the_newest() {
        let f = Fixture::new();
        for dir in [
            "fnm/node-versions/v24.9.0/installation/bin",
            "fnm/node-versions/v24.21.0/installation/bin",
            "fnm/node-versions/.downloads",
            "home/.nvm/versions/node/v20.1.0/bin",
            "home/.nvm/versions/node/v22.3.0/bin",
            "home/.nvm/versions/node/v220.0.0/bin",
            "home/.local/share/mise/installs/node/22/bin",
            "home/.local/share/mise/installs/node/22.10.1/bin",
            "home/.local/share/mise/installs/node/latest/bin",
            "home/.asdf/installs/nodejs/18.20.0/bin",
        ] {
            fs::create_dir_all(f.0.join(dir)).unwrap();
        }
        f.file("home/.nvm/alias/default", "22\n");
        let fnm = f.0.join("fnm").into_os_string();
        let home = f.0.join("home").into_os_string();
        let env = |key: &str| match key {
            "HOME" => Some(home.clone()),
            "FNM_DIR" => Some(fnm.clone()),
            _ => None,
        };
        let dirs = node_manager_dirs(false, &env, Some(&f.0.join("home")));
        assert_eq!(
            dirs,
            [
                f.0.join("fnm/node-versions/v24.21.0/installation/bin"),
                f.0.join("home/.nvm/versions/node/v22.3.0/bin"),
                f.0.join("home/.local/share/mise/installs/node/22.10.1/bin"),
                f.0.join("home/.asdf/installs/nodejs/18.20.0/bin"),
            ]
        );
        // They follow PATH and the per-user folders, ahead of the system ones.
        let all = search_directories(false, &env);
        let at = |dir: &Path| all.iter().position(|item| item == dir).unwrap();
        assert!(at(&f.0.join("home/.npm-global/bin")) < at(&dirs[0]));
        assert!(at(&dirs[3]) < at(Path::new("/usr/bin")));
        // An fnm default alias wins over the newest version.
        fs::create_dir_all(f.0.join("fnm/aliases/default")).unwrap();
        assert_eq!(node_manager_dirs(false, &env, None), [f.0.join("fnm/aliases/default/bin")]);
    }

    #[test]
    fn nvm_windows_folders_are_searched() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("nvm/v18.0.0")).unwrap();
        fs::create_dir_all(f.0.join("nvm/v22.11.0")).unwrap();
        f.file("nvm/settings.txt", "");
        let nvm = f.0.join("nvm").into_os_string();
        let env = |key: &str| match key {
            "NVM_HOME" => Some(nvm.clone()),
            "NVM_SYMLINK" => Some("C:/nvm4w/nodejs".into()),
            _ => None,
        };
        assert_eq!(
            node_manager_dirs(true, &env, None),
            [PathBuf::from("C:/nvm4w/nodejs"), f.0.join("nvm/v22.11.0")]
        );
    }

    #[test]
    fn windows_shims_never_launch_a_shell_host() {
        let f = Fixture::new();
        f.file("npm/node_modules/opencode-ai/package.json", r#"{"bin":{"opencode":"CMD.exe"}}"#);
        f.file("npm/node_modules/opencode-ai/CMD.exe", "");
        let shim = f.file("npm/opencode.cmd", "");
        assert!(resolve(&shim, true).is_err());
    }

    #[test]
    fn rejects_unknown_batch_files_and_npm_entries_outside_the_package() {
        let f = Fixture::new();
        let unknown = f.file("custom.cmd", "@echo off\r\n");
        assert!(resolve(&unknown, true).is_err());
        let shim = f.file("codex.cmd", "");
        f.file(
            "node_modules/@openai/codex/package.json",
            r#"{"bin":{"codex":"../../outside.js"}}"#,
        );
        assert!(resolve(&shim, true).is_err());
    }

    #[test]
    fn native_and_unix_program_paths_remain_direct() {
        for (path, windows) in [
            ("C:/tools/codex.exe", true),
            ("/opt/homebrew/bin/codex", false),
            ("/home/user/.local/bin/claude", false),
        ] {
            let launch = resolve(Path::new(path), windows).unwrap();
            assert_eq!(launch.program, Path::new(path));
            assert!(launch.args.is_empty());
        }
    }

    #[test]
    fn node_discovery_never_falls_back_to_a_batch_shell() {
        let f = Fixture::new();
        f.file("first/node.cmd", "@echo off");
        f.file("first/node.bat", "@echo off");
        f.file("first/node", "");
        assert!(find_native_node(vec![f.0.join("first")]).is_none());
        let node = f.file("second/node.exe", "");
        assert_eq!(
            find_native_node(vec![f.0.join("first"), f.0.join("second")]),
            Some(node)
        );
    }

    #[test]
    fn modern_native_bins_and_local_npm_shims_are_supported() {
        let f = Fixture::new();
        for (name, package) in [
            ("claude", "@anthropic-ai/claude-code"),
            ("opencode", "opencode-ai"),
            ("pi", "@earendil-works/pi-coding-agent"),
            ("copilot", "@github/copilot"),
            ("cline", "cline"),
            ("kilo", "@kilocode/cli"),
            ("kilocode", "@kilocode/cli"),
        ] {
            let shim = f.file(&format!("node_modules/.bin/{name}.cmd"), "@echo off");
            f.file(
                &format!("node_modules/{package}/package.json"),
                &serde_json::json!({"bin":{name:format!("bin/{name}.exe")}}).to_string(),
            );
            let binary = f.file(&format!("node_modules/{package}/bin/{name}.exe"), "");
            let launch = resolve(&shim, true).unwrap();
            assert_eq!(launch.program, external_path_for(&binary, true));
            assert!(launch.args.is_empty());
        }
    }

    #[test]
    fn platform_search_uses_real_windows_profile_and_appdata_locations() {
        let env = |name: &str| {
            Some(OsString::from(match name {
                "USERPROFILE" => "C:/Users/Person",
                "HOME" => "/git/home/person",
                "APPDATA" => "D:/Roaming Data",
                "LOCALAPPDATA" => "D:/Local Data",
                "ProgramFiles" => "C:/Program Files",
                "SystemRoot" => "C:/Windows",
                _ => return None,
            }))
        };
        let dirs = search_directories(true, &env);
        for path in [
            "C:/Users/Person/.local/bin",
            "C:/Users/Person/.kilo/bin",
            "C:/Users/Person/.kimi-code/Scripts",
            "D:/Roaming Data/npm",
            "D:/Local Data/Microsoft/WinGet/Links",
            "C:/Program Files/nodejs",
            "C:/Windows/System32/WindowsPowerShell/v1.0",
        ] {
            assert!(dirs.contains(&PathBuf::from(path)), "missing {path}");
        }
        assert!(!dirs.contains(&PathBuf::from("/git/home/person/.local/bin")));
        assert_eq!(
            home_directory(false, &env),
            Some(PathBuf::from("/git/home/person"))
        );
        let env = |name: &str| match name {
            "HOMEDRIVE" => Some("C:".into()),
            "HOMEPATH" => Some("/Users/Person".into()),
            _ => None,
        };
        assert_eq!(
            home_directory(true, &env),
            Some(PathBuf::from("C:/Users/Person"))
        );
    }

    #[test]
    fn script_path_preserves_existing_order_and_adds_installed_tool_locations() {
        let inherited = std::env::join_paths(["/custom/bin", "/usr/bin", "/custom/bin"]).unwrap();
        let env = |name: &str| match name {
            "PATH" => Some(inherited.clone()),
            "HOME" => Some("/Users/Person".into()),
            _ => None,
        };
        let path = executable_path_for(false, &env).unwrap();
        let dirs: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(&dirs[..2], &[PathBuf::from("/custom/bin"), PathBuf::from("/usr/bin")]);
        for path in ["/Users/Person/.local/bin", "/Users/Person/.volta/bin", "/Users/Person/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/bin"] {
            assert!(dirs.contains(&PathBuf::from(path)), "missing {path}");
        }
        assert_eq!(dirs.iter().filter(|path| path.as_path() == Path::new("/custom/bin")).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn scripts_find_installed_user_tools_with_a_minimal_gui_path() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let tool = f.file(".local/bin/pandacode-test-tool", "#!/bin/sh\nprintf 'found installed tool'\n");
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        let script = f.file("script.sh", "#!/bin/sh\npandacode-test-tool\n");
        let env = |name: &str| match name {
            "PATH" => Some("/usr/bin:/bin".into()),
            "HOME" => Some(f.0.clone().into_os_string()),
            _ => None,
        };
        let mut command = std::process::Command::new("/bin/sh");
        command.arg(script).current_dir(&f.0).env("PATH", executable_path_for(false, &env).unwrap());
        let output = crate::workspace::run_process(command, "GUI Run Script PATH test", 1024, std::time::Duration::from_secs(3)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.bytes, b"found installed tool");
    }

    #[test]
    fn native_executables_win_over_shims_and_missing_directories_do_not_stop_search() {
        let f = Fixture::new();
        f.file("tools/codex.cmd", "");
        let exe = f.file("tools/codex.exe", "");
        assert_eq!(
            find_in_directories("codex", vec![f.0.join("missing"), f.0.join("tools")], true),
            Some(exe)
        );
    }
}
