//! Multiple GitHub accounts per project: every signed-in account from `gh auth status`,
//! the per-project account pin, and token resolution through the user's own gh keyring.
//! PandaCode still stores no tokens.
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub host: String,
    pub active: bool,
}

/// Every signed-in account in a combined `gh auth status` report, in file order.
/// A `✓ Logged in to <host> account <login> …` line creates an account; `- Active
/// account: true/false` markers attach to the most recent one; an account no marker
/// reached keeps the legacy default (the only account on its host is the active one),
/// and a host never shows more than one active account — the first claim wins.
pub fn parse_status(report: &str) -> Vec<Account> {
    let mut accounts: Vec<Account> = Vec::new();
    let mut marked = Vec::new();
    for line in report.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("✓ Logged in to ") {
            let Some((host, login)) = rest.split_once(" account ") else { continue };
            let (host, login) = (host.trim(), login.split_whitespace().next().unwrap_or_default());
            if host.is_empty() || login.is_empty() {
                continue;
            }
            accounts.push(Account { login: login.to_string(), host: host.to_string(), active: false });
            marked.push(false);
        } else if let Some(rest) = line.strip_prefix("- Active account: ") {
            let Some(latest) = marked.len().checked_sub(1) else { continue };
            marked[latest] = true;
            if rest.trim() != "true" {
                continue;
            }
            let host = accounts[latest].host.clone();
            if accounts.iter().any(|account| account.host == host && account.active) {
                continue;
            }
            accounts[latest].active = true;
        }
    }
    for (index, reached) in marked.iter().enumerate() {
        if *reached {
            continue;
        }
        let host = accounts[index].host.clone();
        if accounts.iter().filter(|account| account.host == host).count() == 1 {
            accounts[index].active = true;
        }
    }
    accounts
}

/// Non-secret per-project account pins. A pin names a gh login only; the token is
/// resolved from the user's own gh keyring when a call runs and is never stored here.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub projects: std::collections::BTreeMap<String, String>,
}

const SERVICE: &str = "app.pandacode.github";

pub fn settings() -> Settings {
    crate::secret_store::get(SERVICE, "settings")
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}
pub fn save_settings(settings: &Settings) -> crate::Result<()> {
    crate::secret_store::set(SERVICE, "settings", &serde_json::to_string(settings).map_err(|e| e.to_string())?)
}
pub fn pinned_login(project_id: &str) -> Option<String> {
    settings().projects.get(project_id).cloned()
}
pub fn set_pinned_login(project_id: &str, login: Option<&str>) -> crate::Result<()> {
    let mut all = settings();
    match login {
        Some(login) => { all.projects.insert(project_id.to_string(), login.to_string()); }
        None => { all.projects.remove(project_id); }
    }
    save_settings(&all)
}

/// The token `gh auth token` printed, if it printed one.
pub fn token_from_output(output: &str) -> Option<String> {
    let token = output.trim();
    (!token.is_empty()).then(|| token.to_string())
}

pub fn token_error(login: &str) -> String {
    format!("GitHub account {login} is not signed in. Run `gh auth login` to add it.")
}

/// The pinned account's token, resolved fresh from the user's own gh keyring on every
/// call. The token travels only to the child process's environment; it is never logged
/// or stored. A missing or failed lookup is an error, never another account's token.
pub fn token_for(login: Option<&str>) -> Result<Option<String>, String> {
    let Some(login) = login else { return Ok(None) };
    let program = crate::providers::tool_path("gh").unwrap_or_else(|| "gh".into());
    let mut command = Command::new(program);
    command
        .args(["auth", "token"])
        // The `--flag=value` form keeps the login out of the CLI's option parser.
        .arg(format!("--user={login}"))
        .current_dir(home());
    let output = crate::workspace::run_process(command, "GitHub CLI", crate::github::OUTPUT_LIMIT, Duration::from_secs(20))
        .map_err(|_| token_error(login))?;
    if !output.status.success() {
        return Err(token_error(login));
    }
    token_from_output(&String::from_utf8_lossy(&output.stdout.bytes)).map(Some).ok_or_else(|| token_error(login))
}

fn home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    // The test secret store is one map shared by the whole test binary, so the two
    // settings-writing tests serialize on it instead of racing on `app.pandacode.github`.
    static STORE: Mutex<()> = Mutex::new(());

    fn account(login: &str, host: &str, active: bool) -> Account {
        Account { login: login.into(), host: host.into(), active }
    }

    /// Real `gh auth status` shape since 2.40: several accounts per host, one marked
    /// active, plus a GHES host; output reaches the parser as combined stdout+stderr.
    const MODERN: &str = "\
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'
  ✓ Logged in to github.com account bob-dev (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'
ghe.acme.dev
  ✓ Logged in to ghe.acme.dev account corp-user (token file)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'
";

    #[test]
    fn parse_status_reads_every_signed_in_account_across_hosts() {
        assert_eq!(
            parse_status(MODERN),
            vec![
                account("alice", "github.com", true),
                account("bob-dev", "github.com", false),
                account("corp-user", "ghe.acme.dev", true),
            ]
        );
    }

    /// gh before 2.40 prints no `Active account` line; that one account is the one gh uses.
    #[test]
    fn parse_status_marks_the_sole_legacy_account_active() {
        assert_eq!(
            parse_status(
                "\
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'
"
            ),
            vec![account("alice", "github.com", true)]
        );
    }

    #[test]
    fn parse_status_skips_unparsable_lines_and_returns_nothing_for_empty_input() {
        assert_eq!(
            parse_status(
                "\
github.com
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'
✗ Logged in to github.com account eve (token file)
not a status line at all
"
            ),
            Vec::<Account>::new()
        );
        assert_eq!(parse_status(""), Vec::<Account>::new());
    }

    /// A marker-less host block keeps the legacy default (its account is active), while
    /// the host that does carry markers still ends with exactly one active account.
    #[test]
    fn parse_status_defaults_an_unmarked_host_block_to_one_active_account() {
        assert_eq!(
            parse_status(
                "\
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  ✓ Logged in to github.com account bob (keyring)
  - Active account: false
  - Git operations protocol: https
ghe.acme.dev
  ✓ Logged in to ghe.acme.dev account corp (keyring)
  - Git operations protocol: https
"
            ),
            vec![
                account("alice", "github.com", true),
                account("bob", "github.com", false),
                account("corp", "ghe.acme.dev", true),
            ]
        );
    }

    #[test]
    fn parse_status_keeps_only_the_first_active_account_on_a_host() {
        assert_eq!(
            parse_status(
                "\
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  ✓ Logged in to github.com account bob (keyring)
  - Active account: true
  ✓ Logged in to github.com account carol (keyring)
  ✓ Logged in to github.com account dave (keyring)
"
            ),
            vec![
                account("alice", "github.com", true),
                account("bob", "github.com", false),
                account("carol", "github.com", false),
                account("dave", "github.com", false),
            ]
        );
    }

    #[test]
    fn settings_round_trip_through_the_secure_store() {
        let _guard = STORE.lock().unwrap();
        let saved = Settings { projects: BTreeMap::from([("proj-1".into(), "alice".into()), ("proj-2".into(), "corp-user".into())]) };
        save_settings(&saved).unwrap();
        assert_eq!(settings(), saved);
    }

    #[test]
    fn set_pinned_login_sets_overwrites_and_clears() {
        let _guard = STORE.lock().unwrap();
        let project = "github-accounts-test-project";
        assert_eq!(pinned_login(project), None, "unset pins read as none");
        set_pinned_login(project, Some("alice")).unwrap();
        assert_eq!(pinned_login(project).as_deref(), Some("alice"));
        set_pinned_login(project, Some("bob-dev")).unwrap();
        assert_eq!(pinned_login(project).as_deref(), Some("bob-dev"));
        set_pinned_login(project, None).unwrap();
        assert_eq!(pinned_login(project), None, "None removes the pin");
    }

    #[test]
    fn token_from_output_trims_and_rejects_blank_output() {
        assert_eq!(token_from_output("gho_abc123\n"), Some("gho_abc123".into()));
        assert_eq!(token_from_output("  gho_abc123  \n"), Some("gho_abc123".into()));
        assert_eq!(token_from_output(""), None);
        assert_eq!(token_from_output(" \n\t"), None);
    }

    #[test]
    fn token_error_names_the_account_and_how_to_add_it() {
        assert_eq!(token_error("alice"), "GitHub account alice is not signed in. Run `gh auth login` to add it.");
    }
}
