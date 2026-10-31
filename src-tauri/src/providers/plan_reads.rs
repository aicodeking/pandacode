//! Which read-only Claude tools Plan mode runs without asking, even outside the
//! project. Paths are resolved (`~`, relative, `..`, symlinks when they exist) and
//! compared by component, case-insensitively; anything that could reach
//! credentials, keys, browser profiles or app data goes to the user. When unsure, ask.
use serde_json::Value;
use std::path::Path;

const READ_ONLY: &[&str] = &["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"];
/// Hidden names that are ordinary project files; every other dot-name may hold secrets
/// (`.ssh`, `.aws`, `.codex`, `.claude`, `.config`, `.local`, `.docker`, `.kube`, `.netrc`, `.env`…).
const PLAIN_DOT_NAMES: &[&str] = &[".github", ".gitignore", ".gitattributes", ".editorconfig"];
/// Top-level system folders with process environments, devices, service tokens or keychains.
const SYSTEM_ROOTS: &[&str] = &["proc", "sys", "dev", "root", "etc", "var", "library", "private"];
/// Folders directly in the home directory that hold keychains, browser profiles and app data.
const HOME_PRIVATE: &[&str] = &["library", "appdata"];
const NAMES: &[&str] = &["auth.json", "hosts.yml", "hosts.yaml", "kubeconfig", "login data", "cookies", "cookies.sqlite", "key4.db", "logins.json"];
const PREFIXES: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "ai.pandacode"];
const CONTAINS: &[&str] = &["credential", "secret", "keychain", "password"];
const EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".gpg", ".asc", ".env", ".ovpn"];

pub(super) fn plan_read_only(tool: &str, input: &Value, cwd: &Path) -> bool {
    if !READ_ONLY.contains(&tool) {
        return false;
    }
    let home = ["HOME", "USERPROFILE"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|home| !home.is_empty()));
    allowed(tool, input, &cwd.to_string_lossy(), home.as_deref())
}

fn allowed(tool: &str, input: &Value, cwd: &str, home: Option<&str>) -> bool {
    let field = |key: &str| input.get(key).map(|value| value.as_str().map(str::to_owned));
    let Some(home) = home.and_then(|home| resolve(home, "/", None)) else {
        return false;
    };
    let path = |raw: &str| resolve(raw, cwd, Some(&home));
    match tool {
        "WebFetch" | "WebSearch" => true,
        "Read" | "LS" | "NotebookRead" => {
            let key = match tool { "Read" => "file_path", "LS" => "path", _ => "notebook_path" };
            matches!(field(key), Some(Some(raw)) if path(&raw).is_some_and(|parts| safe_path(&parts, &home)))
        }
        // Grep's `pattern` is a regex over contents; its `glob` filters file names.
        // Glob's `pattern` is a path relative to `path`.
        _ => {
            let Some(Some(root)) = field("path").or(Some(Some(cwd.to_owned()))) else { return false };
            let Some(root) = path(&root) else { return false };
            let key = if tool == "Glob" { "pattern" } else { "glob" };
            let parts = match field(key) {
                None => root,
                Some(None) => return false,
                Some(Some(pattern)) => match resolve(&pattern, &join(&root), Some(&home)) {
                    Some(parts) => parts,
                    None => return false,
                },
            };
            let search_root: Vec<String> = parts.iter().take_while(|part| !part.contains(['*', '?', '[', '{'])).cloned().collect();
            // A search from home or above could walk into any credential folder.
            safe_path(&parts, &home) && safe_path(&search_root, &home) && !lower(&home).starts_with(&lower(&search_root))
        }
    }
}

fn join(parts: &[String]) -> String {
    format!("/{}", parts.join("/"))
}

fn lower(parts: &[String]) -> Vec<String> {
    parts.iter().map(|part| part.to_lowercase()).collect()
}

/// Components of an absolute path (drive letter dropped), or None when it can't be resolved safely.
fn resolve(raw: &str, cwd: &str, home: Option<&[String]>) -> Option<Vec<String>> {
    let raw = raw.replace('\\', "/");
    if raw.contains(['$', '%', '\0']) || raw.starts_with("//") {
        return None;
    }
    let full = if raw == "~" || raw.starts_with("~/") {
        format!("{}/{}", join(home?), &raw[1..])
    } else if raw.starts_with('~') {
        return None;
    } else if raw.starts_with('/') || raw.as_bytes().get(1) == Some(&b':') {
        raw
    } else {
        format!("{}/{raw}", cwd.replace('\\', "/"))
    };
    let mut parts: Vec<String> = Vec::new();
    for part in full.split('/') {
        match part {
            "" | "." => {}
            ".." => { parts.pop(); }
            part => parts.push(part.to_owned()),
        }
    }
    if parts.first().is_some_and(|drive| drive.len() == 2 && drive.ends_with(':')) {
        parts.remove(0);
    }
    Some(parts)
}

fn safe_path(parts: &[String], home: &[String]) -> bool {
    let home = lower(home);
    if !safe_parts(&lower(parts), &home) {
        return false;
    }
    // A symlink inside an ordinary folder may point at a key.
    match std::fs::canonicalize(join(parts)) {
        Ok(real) => resolve(&real.to_string_lossy(), "/", None).is_some_and(|real| {
            let real = lower(&real);
            // macOS keeps /tmp under /private.
            let real = match real.as_slice() {
                [private, rest @ ..] if private == "private" && rest.first().is_some_and(|top| top == "tmp") => rest.to_vec(),
                _ => real,
            };
            safe_parts(&real, &home)
        }),
        Err(_) => true,
    }
}

fn safe_parts(parts: &[String], home: &[String]) -> bool {
    if parts.first().is_some_and(|first| SYSTEM_ROOTS.contains(&first.as_str())) {
        return false;
    }
    if parts.starts_with(home) && parts.get(home.len()).is_some_and(|top| HOME_PRIVATE.contains(&top.as_str())) {
        return false;
    }
    !parts.iter().any(|part| sensitive(part))
}

fn sensitive(name: &str) -> bool {
    (name.starts_with('.') && !PLAIN_DOT_NAMES.contains(&name))
        || NAMES.contains(&name)
        || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
        || CONTAINS.iter().any(|needle| name.contains(needle))
        || EXTENSIONS.iter().any(|extension| name.ends_with(extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOME: Option<&str> = Some("/Users/Me");
    const CWD: &str = "/Users/Me/project";

    fn runs(tool: &str, input: Value) -> bool {
        allowed(tool, &input, CWD, HOME)
    }

    #[test]
    fn ordinary_reads_and_searches_outside_the_project_run() {
        for (tool, input) in [
            ("Read", json!({"file_path":"/Users/Me/other-repo/README.md"})),
            ("Read", json!({"file_path":"src/main.rs"})),
            ("Read", json!({"file_path":"/Users/Me/other-repo/.github/workflows/ci.yml"})),
            ("LS", json!({"path":"/Users/Me/other-repo"})),
            ("Grep", json!({"pattern":"token","path":"/opt/lib"})),
            ("Grep", json!({"pattern":"token"})),
            ("Glob", json!({"pattern":"**/*.md","path":"/Users/Me/docs"})),
            ("Glob", json!({"pattern":"src/**/*.ts"})),
            ("WebFetch", json!({"url":"https://docs.example.com"})),
        ] {
            assert!(runs(tool, input.clone()), "{tool} {input}");
        }
    }

    #[test]
    fn credential_files_ask_however_the_path_is_written() {
        for path in [
            "~/.codex/auth.json",
            "~/.config/opencode/opencode.json",
            "~/.local/share/opencode/auth.json",
            "~/.claude/.credentials.json",
            "~/.config/gh/hosts.yml",
            "~/.netrc",
            "~/.npmrc",
            "~/.docker/config.json",
            "~/.kube/config",
            "~/.gnupg/private-keys-v1.d/a.key",
            "~/.ssh/id_ed25519",
            "/Users/Me/Library/Keychains/login.keychain-db",
            "/users/me/library/application support/google/chrome/default/cookies",
            "~/.mozilla/firefox/x.default/logins.json",
            "/Users/Me/Library/Application Support/ai.pandacode.app/secrets.json",
            "~/.local/share/ai.pandacode.app/secrets.json",
            "/Users/Me/PROJECT/../.SSH/ID_RSA",
            "../.aws/credentials",
            "./../../Me/.netrc",
            "sub/../../.codex/auth.json",
            "C:\\Users\\Me\\AppData\\Roaming\\gh\\hosts.yml",
            "C:\\Users\\Me\\.aws\\config",
            "/Users/Me/project/.env",
            "/Users/Me/project/prod.env",
            "/proc/self/environ",
            "/var/run/secrets/kubernetes.io/serviceaccount/token",
            "~other/.ssh/id_rsa",
            "$HOME/.ssh/id_rsa",
        ] {
            assert!(!runs("Read", json!({"file_path": path})), "{path}");
            assert!(!runs("LS", json!({"path": path})), "{path}");
            assert!(!runs("Glob", json!({"pattern": path})), "{path}");
            assert!(!runs("Grep", json!({"pattern":"x","path": path})), "{path}");
        }
    }

    #[test]
    fn searches_that_could_cover_credentials_ask() {
        for (tool, input) in [
            ("Glob", json!({"pattern":"**/*","path":"/Users/Me"})),
            ("Glob", json!({"pattern":"**/auth.json","path":"/Users/Me/project"})),
            ("Glob", json!({"pattern":"../**/*.json"})),
            ("Glob", json!({"pattern":"/**/*.json"})),
            ("Glob", json!({"pattern":"~/*/config"})),
            ("Glob", json!({"pattern":"~/.*/*"})),
            ("Glob", json!({"pattern":"*.pem","path":"/opt"})),
            ("Glob", json!({"pattern":"/Users/*/.ssh/*"})),
            ("Grep", json!({"pattern":"token","path":"~"})),
            ("Grep", json!({"pattern":"token","path":"/"})),
            ("Grep", json!({"pattern":"token","path":"/Users"})),
            ("Grep", json!({"pattern":"token","path":".."})),
            ("Grep", json!({"pattern":"token","path":"/opt","glob":"*.pem"})),
            ("Grep", json!({"pattern":"token","glob":"**/.env*"})),
            ("Read", json!({})),
            ("Read", json!({"file_path": 7})),
        ] {
            assert!(!runs(tool, input.clone()), "{tool} {input}");
        }
        assert!(!allowed("Read", &json!({"file_path":"/opt/a"}), CWD, None), "no home: ask");
    }

    #[test]
    fn other_tools_never_run_here() {
        for tool in ["Write", "Edit", "Bash", "NotebookEdit"] {
            assert!(!plan_read_only(tool, &json!({"file_path":"/tmp/a"}), Path::new(CWD)));
        }
    }
}
