//! Deploys by agents: one approval-gated tool runs the Vercel, Wrangler (Cloudflare),
//! Railway, AWS or Google Cloud CLI in the task's checkout, signed in with the connected account. Credentials go
//! only into that process's environment and are scrubbed from its output, so they never
//! reach the agent.
use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use crate::agent_tools::{spec, validate_spec};
use crate::providers::ToolHost;
use crate::workspace::run_process;

const VERCEL: &str = "vercel@64.3.1";
const WRANGLER: &str = "wrangler@4.151.0";
const RAILWAY: &str = "@railway/cli@5.71.0";
const OUTPUT: usize = 128 * 1024;

/// Approval tools that ask on every call, even in full-access mode. Scheduled messages to
/// other tasks are approval tools only while Settings asks first (`schedules::tools`).
pub const ALWAYS_ASK: &[&str] = &["pandacode_cloud_cli", "pandacode_schedule_message"];

/// AWS global options that take a value, so the value is not mistaken for the service.
const AWS_VALUE_FLAGS: &[&str] = &["--region", "--profile", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format"];
/// Railway commands agents may run (with aliases). Everything else is refused: login,
/// local runs and shells with the token in their environment (`run`/`local`, `dev`,
/// `shell`, `ssh`, `connect`), the raw API, local agents and installers, self-updates.
const RAILWAY_ALLOWED: &[&str] = &["init", "new", "link", "unlink", "up", "deploy", "deployment", "deployments", "redeploy", "restart", "down", "domain", "add", "service", "environment", "env", "variable", "variables", "vars", "var", "logs", "status", "list", "project", "projects", "whoami", "volume", "volumes", "scale", "templates", "template", "metrics"];
/// gcloud global options that take a value, so the value is not mistaken for a command.
const GCLOUD_VALUE_FLAGS: &[&str] = &["--project", "--account", "--configuration", "--format", "--verbosity", "--billing-project", "--impersonate-service-account", "--access-token-file", "--trace-token", "--flatten", "--region", "--zone"];
/// gcloud commands that print, create or replace credentials, or change the login or config.
const GCLOUD_REFUSED: &[&[&str]] = &[&["auth"], &["config"], &["iam", "service-accounts", "keys", "create"], &["iam", "service-accounts", "sign-jwt"], &["iam", "service-accounts", "sign-blob"]];
/// Read-only exceptions inside the refused groups.
const GCLOUD_ALLOWED: &[&[&str]] = &[&["auth", "list"], &["config", "list"], &["config", "get-value"], &["config", "get"]];
/// Keys whose JSON values are Google credentials in gcloud output.
const GCLOUD_SECRET_KEYS: &[&str] = &["\"private_key\"", "\"access_token\"", "\"refresh_token\"", "\"id_token\"", "\"client_secret\""];
/// sts operations that hand back credentials.
const STS_CREDENTIALS: &[&str] = &["get-session-token", "get-federation-token", "assume-role", "assume-role-with-saml", "assume-role-with-web-identity", "assume-root"];
/// Keys whose values are AWS secrets in CLI output (matched case-insensitively).
const AWS_SECRET_KEYS: &[&str] = &["aws_secret_access_key", "aws_session_token", "aws_security_token", "secretaccesskey", "sessiontoken"];

pub fn catalog() -> Vec<Value> {
    vec![spec("cloud_cli", "Run the Vercel CLI (tool vercel), Cloudflare's Wrangler (tool wrangler), the Railway CLI (tool railway), the AWS CLI (tool aws) or the Google Cloud CLI (tool gcloud) in this task's checkout, already signed in to the user's connected account: never ask for or print tokens. Use it to deploy end to end, e.g. vercel `deploy --yes` then `deploy --prod --yes`; wrangler `deploy` or `pages deploy dist --project-name app`; railway `init --name app` then `up --ci`; aws `s3 sync ./dist s3://bucket`; gcloud `run deploy app --source .`. args is the argument list as you would type it after the tool name (quotes allowed, no pipes or redirects). directory is relative to the checkout. Returns the exit code and output. Creating paid cloud resources costs the user money: confirm first.", json!({
        "tool":{"type":"string","enum":["vercel","wrangler","railway","aws","gcloud"]},
        "args":{"type":"string","maxLength":4000},
        "directory":{"type":"string","maxLength":1024,"description":"Relative to the checkout (default .)."},
        "timeoutSeconds":{"type":"integer","description":"1–1800, default 600."},
    }), &["tool", "args"])]
}

/// The working directory: inside the checkout, never above it.
pub fn inside(checkout: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative.trim());
    if relative.is_absolute() || relative.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err("directory must be a path inside the checkout.".into());
    }
    let path = checkout.join(relative);
    let real = path.canonicalize().map_err(|_| format!("{} does not exist in the checkout.", relative.display()))?;
    let root = checkout.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) || !real.is_dir() {
        return Err("directory must be a folder inside the checkout.".into());
    }
    Ok(real)
}

/// Remove each secret and ANSI colour codes from CLI output.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() { break; }
            }
            continue;
        }
        clean.push(ch);
    }
    secrets.iter().filter(|s| s.len() >= 8).fold(clean, |text, secret| text.replace(secret.as_str(), "[redacted]"))
}

/// Refuse AWS commands that print the signed-in credentials.
fn aws_refusal(words: &[String]) -> Result<(), String> {
    if words.iter().any(|w| w == "--debug") {
        return Err("--debug prints request credentials; leave it out.".into());
    }
    let mut positional = Vec::new();
    let mut iter = words.iter();
    while let Some(word) = iter.next() {
        if AWS_VALUE_FLAGS.contains(&word.as_str()) {
            iter.next();
        } else if !word.starts_with('-') {
            positional.push(word.as_str());
        }
    }
    match positional.as_slice() {
        ["configure", ..] => Err("aws configure is not available: PandaCode manages the AWS login.".into()),
        ["sts", op, ..] if STS_CREDENTIALS.contains(op) => Err(format!("aws sts {op} returns credentials, which never reach the agent.")),
        _ => Ok(()),
    }
}

/// Refuse Railway commands outside deploys: the login, local shells, the raw API.
fn railway_refusal(words: &[String]) -> Result<(), String> {
    match words.iter().find(|w| !w.starts_with('-')) {
        Some(command) if !RAILWAY_ALLOWED.contains(&command.as_str()) => Err(format!("railway {command} is not available here: PandaCode manages the Railway login, and this tool runs deploy commands (init, link, up, domain, variable, logs, status…).")),
        _ => Ok(()),
    }
}

/// New Railway projects go to the connected workspace unless the agent names one.
fn railway_args(args: &[String], workspace: Option<&str>) -> Vec<String> {
    let init = args.iter().find(|w| !w.starts_with('-')).is_some_and(|w| w == "init" || w == "new");
    let named = args.iter().any(|w| w == "-w" || w.starts_with("--workspace"));
    match workspace {
        Some(workspace) if init && !named => args.iter().cloned().chain(["--workspace".into(), workspace.into()]).collect(),
        _ => args.to_vec(),
    }
}

/// Refuse gcloud commands that print or create credentials, or change the login.
fn gcloud_refusal(words: &[String]) -> Result<(), String> {
    // --log-http prints bearer tokens; a flags file could carry it.
    if words.iter().any(|w| ["--log-http", "--flags-file"].iter().any(|f| w == f || w.starts_with(&format!("{f}=")))) {
        return Err("--log-http and --flags-file are not available: they can print credentials.".into());
    }
    let mut positional = Vec::new();
    let mut iter = words.iter();
    while let Some(word) = iter.next() {
        if GCLOUD_VALUE_FLAGS.contains(&word.as_str()) {
            iter.next();
        } else if !word.starts_with('-') {
            positional.push(word.as_str());
        }
    }
    // Release tracks run the same commands.
    let command = match positional.first() { Some(&("alpha" | "beta" | "preview")) => &positional[1..], _ => &positional[..] };
    let starts = |prefix: &&[&str]| command.starts_with(prefix);
    if GCLOUD_REFUSED.iter().any(starts) && !GCLOUD_ALLOWED.iter().any(starts) {
        return Err(format!("gcloud {} is not available here: PandaCode uses your gcloud login, and credentials never reach the agent.", command.iter().take(4).copied().collect::<Vec<_>>().join(" ")));
    }
    Ok(())
}

/// Redact Google access tokens and credential values from gcloud output.
pub fn scrub_gcloud(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut hidden = vec![false; bytes.len()];
    for (at, _) in text.match_indices("ya29.") {
        let end = at + bytes[at..].iter().take_while(|b| b.is_ascii_alphanumeric() || b"._-".contains(b)).count();
        hidden[at..end].fill(true);
    }
    for key in GCLOUD_SECRET_KEYS {
        for (at, _) in text.match_indices(key) {
            let open = at + key.len() + bytes[at + key.len()..].iter().take_while(|b| b" \t:".contains(b)).count();
            if bytes.get(open) != Some(&b'"') { continue; }
            let mut end = open + 1;
            while end < bytes.len() && bytes[end] != b'"' {
                end += if bytes[end] == b'\\' { 2 } else { 1 };
            }
            hidden[open + 1..end.min(bytes.len())].fill(true);
        }
    }
    redact(text, &hidden)
}

/// Replace each run of hidden bytes with one `[redacted]`.
fn redact(text: &str, hidden: &[bool]) -> String {
    let mut clean = String::with_capacity(text.len());
    for (at, ch) in text.char_indices() {
        if !hidden[at] {
            clean.push(ch);
        } else if at == 0 || !hidden[at - 1] {
            clean.push_str("[redacted]");
        }
    }
    clean
}

/// gcloud with the user's own login, the connected project and region, and no prompts or usage reports.
pub fn gcloud(project: &str, region: Option<&str>) -> Result<Command, String> {
    let path = crate::token_saver::find_tool("gcloud").ok_or("The Google Cloud CLI (gcloud) is not installed. Install it from cloud.google.com/sdk and run `gcloud auth login`.")?;
    Ok(gcloud_at(path, project, region))
}

fn gcloud_at(path: impl AsRef<std::ffi::OsStr>, project: &str, region: Option<&str>) -> Command {
    let mut command = Command::new(path);
    command
        .env("CLOUDSDK_CORE_PROJECT", project)
        .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
        .env("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING", "true")
        .env("CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK", "true")
        .env("CLOUDSDK_CORE_LOG_HTTP", "false");
    if let Some(region) = region {
        command.env("CLOUDSDK_RUN_REGION", region).env("CLOUDSDK_COMPUTE_REGION", region);
    }
    command
}

/// Check that the user's gcloud login can open the project.
pub fn gcloud_verify(project: &str, region: Option<&str>) -> Result<(), String> {
    let mut command = gcloud(project, region)?;
    command.args(["projects", "describe", project, "--format=value(projectId)"]);
    let out = run_process(command, "gcloud", 64 * 1024, Duration::from_secs(60))?;
    if out.status.success() {
        return Ok(());
    }
    let error = scrub_gcloud(&String::from_utf8_lossy(&out.stderr.bytes));
    let reason = error.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gcloud failed");
    Err(format!("gcloud could not open project {project} ({reason}). Sign in with `gcloud auth login` in a terminal, then try again."))
}

/// Redact AWS access key IDs and secret key/token values from AWS CLI output.
pub fn scrub_aws(text: &str) -> String {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let mut hidden = vec![false; bytes.len()];
    for at in 0..bytes.len().saturating_sub(19) {
        if (bytes[at..].starts_with(b"AKIA") || bytes[at..].starts_with(b"ASIA")) && bytes[at + 4..at + 20].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
            hidden[at..at + 20].fill(true);
        }
    }
    for key in AWS_SECRET_KEYS {
        for (at, _) in lower.match_indices(key) {
            let start = at + key.len() + bytes[at + key.len()..].iter().take_while(|b| b" \t\"':=".contains(b)).count();
            let end = start + bytes[start..].iter().take_while(|b| !b" \t\r\n\"',}".contains(b)).count();
            hidden[start..end].fill(true);
        }
    }
    redact(text, &hidden)
}

/// The command for a tool with its credentials, or why it cannot run.
pub fn prepare(tool: &str, args: &[String]) -> Result<(Command, Vec<String>), String> {
    let settings = super::settings();
    let npx = || crate::token_saver::find_tool("npx").ok_or("Node.js (npx) is needed to run this CLI. Install Node.js and try again.");
    let (mut command, secrets) = match tool {
        "vercel" => {
            let token = super::secret("vercel_token").ok_or("Connect Vercel in Settings → Agents → Cloud first.")?;
            let mut command = match crate::token_saver::find_tool("vercel") { Some(path) => Command::new(path), None => { let mut c = Command::new(npx()?); c.args(["--yes", VERCEL]); c } };
            // The environment keeps the token out of the process list.
            command.args(args).env("VERCEL_TOKEN", &token);
            if let Some(team) = &settings.vercel_team {
                command.args(["--scope", team]);
            }
            (command, vec![token])
        }
        "wrangler" => {
            let token = super::secret("cloudflare_token").ok_or("Connect Cloudflare in Settings → Agents → Cloud first.")?;
            let account = settings.cloudflare_account.ok_or("Connect Cloudflare in Settings → Agents → Cloud first.")?;
            let mut command = match crate::token_saver::find_tool("wrangler") { Some(path) => Command::new(path), None => { let mut c = Command::new(npx()?); c.args(["--yes", WRANGLER]); c } };
            command.args(args).env("CLOUDFLARE_API_TOKEN", &token).env("CLOUDFLARE_ACCOUNT_ID", account).env("WRANGLER_SEND_METRICS", "false");
            (command, vec![token])
        }
        "railway" => {
            let token = super::secret("railway_token").ok_or("Connect Railway in Settings → Agents → Cloud first.")?;
            let mut command = match crate::token_saver::find_tool("railway") { Some(path) => Command::new(path), None => { let mut c = Command::new(npx()?); c.args(["--yes", RAILWAY]); c } };
            // A project token in the user's environment would win over the connected token.
            command.args(railway_args(args, settings.railway_workspace.as_deref())).env_remove("RAILWAY_TOKEN").env("RAILWAY_API_TOKEN", &token)
                .env("RAILWAY_NO_TELEMETRY", "1").env("DO_NOT_TRACK", "1").env("RAILWAY_NO_AUTO_UPDATE", "1");
            (command, vec![token])
        }
        "aws" => {
            let aws = super::aws::Aws::connected().map_err(|_| "Connect AWS in Settings → Agents → Cloud first.".to_string())?;
            let mut command = Command::new(crate::token_saver::find_tool("aws").ok_or("The AWS CLI is not installed.")?);
            command.args(args).env("AWS_REGION", &aws.region).env("AWS_DEFAULT_REGION", &aws.region).env("AWS_PAGER", "");
            if let Some(profile) = &aws.profile {
                command.env("AWS_PROFILE", profile);
            }
            (command, Vec::new())
        }
        "gcloud" => {
            let project = settings.gcloud_project.ok_or("Connect Google Cloud in Settings → Agents → Cloud first.")?;
            let mut command = gcloud(&project, settings.gcloud_region.as_deref())?;
            command.args(args);
            (command, Vec::new())
        }
        _ => return Err("tool is vercel, wrangler, railway, aws or gcloud.".into()),
    };
    command.env("CI", "1").env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    Ok((command, secrets))
}

fn run(checkout: &Path, args: &Value) -> Result<Value, String> {
    let tool = args["tool"].as_str().unwrap_or_default();
    let words = shell_words::split(args["args"].as_str().unwrap_or_default()).map_err(|_| "args has an unclosed quote.".to_string())?;
    if words.iter().any(|w| matches!(w.as_str(), "|" | ">" | ">>" | "<" | "&&" | "||" | ";")) {
        return Err("args runs one CLI command; pipes, redirects and chaining are not supported.".into());
    }
    if words.iter().any(|w| w == "--token" || w.starts_with("--token=")) {
        return Err("PandaCode adds the credentials itself; leave out --token.".into());
    }
    match tool {
        "aws" => aws_refusal(&words)?,
        "railway" => railway_refusal(&words)?,
        "gcloud" => gcloud_refusal(&words)?,
        _ => {}
    }
    let directory = inside(checkout, args["directory"].as_str().unwrap_or("."))?;
    let timeout = Duration::from_secs(args["timeoutSeconds"].as_u64().unwrap_or(600).clamp(1, 1800));
    let (mut command, secrets) = prepare(tool, &words)?;
    command.current_dir(&directory);
    let out = run_process(command, tool, OUTPUT, timeout)?;
    let clean = |bytes: &[u8]| {
        let text = scrub(&String::from_utf8_lossy(bytes), &secrets);
        match tool { "aws" => scrub_aws(&text), "gcloud" => scrub_gcloud(&text), _ => text }
    };
    let (stdout, stderr) = (clean(&out.stdout.bytes), clean(&out.stderr.bytes));
    Ok(json!({"exitCode": out.status.code(), "stdout": stdout, "stderr": stderr, "truncated": out.stdout.truncated || out.stderr.truncated}))
}

/// The task's checkout: its worktree, else its project folder.
fn checkout(app: &tauri::AppHandle, session_id: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().ok()?;
    let task = store.session(session_id).ok()?;
    task.worktree_path.map(Into::into).or_else(|| store.project(&task.project_id).ok().map(|project| project.path.into()))
}

/// Offer the tool only when at least one deploy account is connected; every call asks.
pub fn with_deploy(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    let settings = super::settings();
    let any = super::secret("vercel_token").is_some() || super::secret("cloudflare_token").is_some() || super::secret("railway_token").is_some() || settings.aws_region.is_some() || settings.gcloud_project.is_some();
    if !any {
        return base;
    }
    let own = catalog();
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let mut approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    approval_tools.insert("pandacode_cloud_cli".to_owned());
    tools.extend(own);
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, stopped, session_id) = (base.clone(), app.clone(), stopped.clone(), session_id.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if name != "pandacode_cloud_cli" {
                    return match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    };
                }
                validate_spec(&catalog(), &name, &args)?;
                crate::blocking(move || run(&checkout(&app, &session_id).ok_or("This task's folder is unknown.")?, &args)).await
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_inside_the_checkout() {
        let root = std::env::temp_dir().join(format!("pandacode-deploy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("web/dist")).unwrap();
        assert_eq!(inside(&root, "web/dist").unwrap(), root.join("web/dist").canonicalize().unwrap());
        assert_eq!(inside(&root, ".").unwrap(), root.canonicalize().unwrap());
        assert!(inside(&root, "../other").is_err());
        assert!(inside(&root, "/etc").is_err());
        assert!(inside(&root, "missing").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scrubs_secrets_and_colour_codes() {
        let text = "\u{1b}[32m✔ Production:\u{1b}[0m https://app.vercel.app using vcp_secret_token_123";
        assert_eq!(scrub(text, &["vcp_secret_token_123".into()]), "✔ Production: https://app.vercel.app using [redacted]");
    }

    #[test]
    fn refuses_shell_tricks_and_explicit_tokens() {
        let root = std::env::temp_dir();
        assert!(run(&root, &json!({"tool":"vercel","args":"deploy | tee x"})).unwrap_err().contains("pipes"));
        assert!(run(&root, &json!({"tool":"vercel","args":"deploy --token=abc"})).unwrap_err().contains("leave out --token"));
        assert!(run(&root, &json!({"tool":"aws","args":"s3 ls 'unclosed"})).unwrap_err().contains("unclosed quote"));
        assert!(validate_spec(&catalog(), "pandacode_cloud_cli", &json!({"tool":"heroku","args":"deploy"})).is_err());
    }

    #[test]
    fn refuses_aws_commands_that_print_credentials() {
        let root = std::env::temp_dir();
        for args in ["configure export-credentials", "--region us-east-1 --profile dev configure get aws_secret_access_key", "--output json sts get-session-token", "sts assume-role --role-arn x --role-session-name y", "--debug s3 ls"] {
            assert!(run(&root, &json!({"tool":"aws","args":args})).is_err_and(|e| !e.contains("Connect AWS")), "{args}");
        }
        let words = |s: &str| shell_words::split(s).unwrap();
        assert!(aws_refusal(&words("--region us-east-1 sts get-caller-identity")).is_ok());
        assert!(aws_refusal(&words("s3 cp configure s3://bucket/configure")).is_ok());
    }

    #[test]
    fn refuses_railway_commands_outside_deploys() {
        let root = std::env::temp_dir();
        for args in ["login --browserless", "logout", "run printenv", "local printenv", "--json shell", "ssh", "connect postgres", "dev up", "develop", "api 'mutation { apiTokenCreate }'", "upgrade --yes", "ca", "code", "agent", "skills", "mcp", "telemetry disable"] {
            assert!(run(&root, &json!({"tool":"railway","args":args})).is_err_and(|e| e.contains("not available")), "{args}");
        }
        let words = |s: &str| shell_words::split(s).unwrap();
        assert!(railway_refusal(&words("up --ci --service web")).is_ok());
        assert!(railway_refusal(&words("variable set RUN=1")).is_ok());
        assert!(railway_refusal(&words("--help")).is_ok());
    }

    #[test]
    fn railway_gets_the_token_in_its_environment_only() {
        super::super::set_secret("railway_token", "railway_token_for_tests").unwrap();
        let Ok((command, secrets)) = prepare("railway", &["up".into(), "--ci".into()]) else { return };
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!args.iter().any(|a| a.contains("railway_token_for_tests")), "{args:?}");
        let env = |key: &str| command.get_envs().find(|(k, _)| *k == key).map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
        assert_eq!(env("RAILWAY_API_TOKEN"), Some(Some("railway_token_for_tests".into())));
        assert_eq!(env("RAILWAY_TOKEN"), Some(None));
        assert_eq!(env("RAILWAY_NO_TELEMETRY"), Some(Some("1".into())));
        assert_eq!(secrets, vec!["railway_token_for_tests".to_string()]);
    }

    #[test]
    fn railway_init_goes_to_the_connected_workspace() {
        let words = |s: &str| shell_words::split(s).unwrap();
        assert_eq!(railway_args(&words("init --name app"), Some("ws-1")), words("init --name app --workspace ws-1"));
        assert_eq!(railway_args(&words("new"), Some("ws-1")), words("new --workspace ws-1"));
        assert_eq!(railway_args(&words("init --workspace=other"), Some("ws-1")), words("init --workspace=other"));
        assert_eq!(railway_args(&words("init -w other"), Some("ws-1")), words("init -w other"));
        assert_eq!(railway_args(&words("up --ci"), Some("ws-1")), words("up --ci"));
        assert_eq!(railway_args(&words("init"), None), words("init"));
    }

    #[test]
    fn refuses_gcloud_commands_that_print_or_create_credentials() {
        let root = std::env::temp_dir();
        for args in ["auth print-access-token", "auth print-identity-token", "auth application-default print-access-token", "config config-helper", "auth login", "auth activate-service-account --key-file k.json", "iam service-accounts keys create key.json --iam-account a@p.iam.gserviceaccount.com", "--project p auth print-access-token", "beta auth print-access-token", "--format json config config-helper", "config set core/log_http true", "run deploy app --source . --log-http", "run services list --flags-file=f.yaml", "iam service-accounts sign-jwt in out --iam-account a"] {
            assert!(run(&root, &json!({"tool":"gcloud","args":args})).is_err_and(|e| e.contains("not available")), "{args}");
        }
        let words = |s: &str| shell_words::split(s).unwrap();
        assert!(gcloud_refusal(&words("run deploy app --source . --region us-central1 --labels pandacode=deploy")).is_ok());
        assert!(gcloud_refusal(&words("auth list")).is_ok());
        assert!(gcloud_refusal(&words("--project p config get-value account")).is_ok());
        assert!(gcloud_refusal(&words("storage cp auth s3://x")).is_ok());
    }

    #[test]
    fn scrubs_gcloud_tokens_and_private_keys() {
        assert_eq!(scrub_gcloud("Authorization: Bearer ya29.a0AfB_byC-1x.y\nok"), "Authorization: Bearer [redacted]\nok");
        let key = r#"{"type": "service_account", "private_key_id": "abc", "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE\"x\n-----END PRIVATE KEY-----\n", "client_email": "a@p.iam.gserviceaccount.com"}"#;
        assert_eq!(scrub_gcloud(key), r#"{"type": "service_account", "private_key_id": "abc", "private_key": "[redacted]", "client_email": "a@p.iam.gserviceaccount.com"}"#);
        assert_eq!(scrub_gcloud(r#"{"refresh_token":"1//0g-abc","x":1}"#), r#"{"refresh_token":"[redacted]","x":1}"#);
        assert_eq!(scrub_gcloud("Service URL: https://app-123.us-central1.run.app"), "Service URL: https://app-123.us-central1.run.app");
    }

    #[test]
    fn gcloud_gets_project_region_and_no_prompts() {
        let command = gcloud_at("gcloud", "my-project", Some("europe-west1"));
        let env = |key: &str| command.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v).map(|v| v.to_string_lossy().into_owned());
        assert_eq!(env("CLOUDSDK_CORE_PROJECT").as_deref(), Some("my-project"));
        assert_eq!(env("CLOUDSDK_RUN_REGION").as_deref(), Some("europe-west1"));
        assert_eq!(env("CLOUDSDK_COMPUTE_REGION").as_deref(), Some("europe-west1"));
        assert_eq!(env("CLOUDSDK_CORE_DISABLE_PROMPTS").as_deref(), Some("1"));
        assert_eq!(env("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING").as_deref(), Some("true"));
    }

    #[test]
    fn scrubs_aws_keys_and_secret_values() {
        let json = r#"{"AccessKeyId": "ASIAABCDEFGHIJKLMNOP", "SecretAccessKey": "wJalr/XUtnFEMI+K7MDENG", "SessionToken": "IQoJb3JpZ2lu=="}"#;
        assert_eq!(scrub_aws(json), r#"{"AccessKeyId": "[redacted]", "SecretAccessKey": "[redacted]", "SessionToken": "[redacted]"}"#);
        let env = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nexport AWS_SECRET_ACCESS_KEY=wJalr/XUtn\naws_session_token = tok\nok";
        assert_eq!(scrub_aws(env), "export AWS_ACCESS_KEY_ID=[redacted]\nexport AWS_SECRET_ACCESS_KEY=[redacted]\naws_session_token = [redacted]\nok");
        assert_eq!(scrub_aws("upload: ./a.txt to s3://AKIA-bucket/é"), "upload: ./a.txt to s3://AKIA-bucket/é");
    }

    #[test]
    fn wrangler_gets_the_token_in_its_environment_only() {
        super::super::set_secret("cloudflare_token", "cf_token_for_tests").unwrap();
        let mut settings = super::super::settings();
        settings.cloudflare_account = Some("0123456789abcdef0123456789abcdef".into());
        super::super::save_settings(&settings).unwrap();
        let Ok((command, secrets)) = prepare("wrangler", &["deploy".into()]) else { return };
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!args.iter().any(|a| a.contains("cf_token_for_tests")), "{args:?}");
        assert!(command.get_envs().any(|(k, v)| k == "CLOUDFLARE_API_TOKEN" && v.is_some_and(|v| v == "cf_token_for_tests")));
        assert_eq!(secrets, vec!["cf_token_for_tests".to_string()]);
    }
}
