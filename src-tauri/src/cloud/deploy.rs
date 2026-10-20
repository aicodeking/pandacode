//! Deploys by agents: one approval-gated tool runs the Vercel, Wrangler (Cloudflare) or
//! AWS CLI in the task's checkout, signed in with the connected account. Credentials go
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
const OUTPUT: usize = 128 * 1024;

pub fn catalog() -> Vec<Value> {
    vec![spec("cloud_cli", "Run the Vercel CLI (tool vercel), Cloudflare's Wrangler (tool wrangler) or the AWS CLI (tool aws) in this task's checkout, already signed in to the user's connected account: never ask for or print tokens. Use it to deploy end to end, e.g. vercel `deploy --yes` then `deploy --prod --yes`; wrangler `deploy` or `pages deploy dist --project-name app`; aws `s3 sync ./dist s3://bucket`. args is the argument list as you would type it after the tool name (quotes allowed, no pipes or redirects). directory is relative to the checkout. Returns the exit code and output. Creating paid cloud resources costs the user money: confirm first.", json!({
        "tool":{"type":"string","enum":["vercel","wrangler","aws"]},
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
    let clean = secrets.iter().filter(|s| s.len() >= 8).fold(clean, |text, secret| text.replace(secret.as_str(), "[redacted]"));
    scrub_aws(&clean)
}

const AWS_LABELS: [&str; 4] = ["aws_secret_access_key", "aws_session_token", "secretaccesskey", "sessiontoken"];

fn is_value_char(b: u8) -> bool {
    !(b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b',' | b'}' | b']' | b';'))
}

/// Redact AWS credentials the CLI may print: access key IDs, and the value after a secret-key or
/// session-token label in env, ini or JSON form. Pure ASCII scanning, so offsets stay valid.
fn scrub_aws(text: &str) -> String {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let lower = lower.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let key_id = (bytes[i..].starts_with(b"AKIA") || bytes[i..].starts_with(b"ASIA"))
            && bytes.len() >= i + 20
            && bytes[i + 4..i + 20].iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if key_id {
            out.extend_from_slice(b"[redacted]");
            i += 20;
            continue;
        }
        if let Some(label) = AWS_LABELS.iter().find(|l| lower[i..].starts_with(l.as_bytes())) {
            let mut j = i + label.len();
            let skip = |mut j: usize, set: &[u8]| { while j < bytes.len() && set.contains(&bytes[j]) { j += 1; } j };
            let after_label = skip(j, b"\"' \t");
            if after_label < bytes.len() && matches!(bytes[after_label], b'=' | b':') {
                j = skip(after_label + 1, b" \t\"'");
                let end = (j..bytes.len()).find(|&k| !is_value_char(bytes[k])).unwrap_or(bytes.len());
                if end > j {
                    out.extend_from_slice(&bytes[i..j]);
                    out.extend_from_slice(b"[redacted]");
                    i = end;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// AWS subcommands that write or mint long-lived credentials into the agent's reach.
fn refuse_aws(words: &[String]) -> Result<(), String> {
    if words.iter().any(|w| w == "configure") {
        return Err("PandaCode manages AWS credentials; `aws configure` is not available here.".into());
    }
    let positional: Vec<&str> = words.iter().map(String::as_str).filter(|w| !w.starts_with('-')).collect();
    if positional.windows(2).any(|p| p[0] == "sts" && p[1] == "get-session-token") {
        return Err("PandaCode manages AWS credentials; `aws sts get-session-token` is not available here.".into());
    }
    Ok(())
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
        "aws" => {
            let aws = super::aws::Aws::connected().map_err(|_| "Connect AWS in Settings → Agents → Cloud first.".to_string())?;
            let mut command = Command::new(crate::token_saver::find_tool("aws").ok_or("The AWS CLI is not installed.")?);
            command.args(args).env("AWS_REGION", &aws.region).env("AWS_DEFAULT_REGION", &aws.region).env("AWS_PAGER", "");
            if let Some(profile) = &aws.profile {
                command.env("AWS_PROFILE", profile);
            }
            (command, Vec::new())
        }
        _ => return Err("tool is vercel, wrangler or aws.".into()),
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
    if tool == "aws" {
        refuse_aws(&words)?;
    }
    let directory = inside(checkout, args["directory"].as_str().unwrap_or("."))?;
    let timeout = Duration::from_secs(args["timeoutSeconds"].as_u64().unwrap_or(600).clamp(1, 1800));
    let (mut command, secrets) = prepare(tool, &words)?;
    command.current_dir(&directory);
    let out = run_process(command, tool, OUTPUT, timeout)?;
    let stdout = scrub(&String::from_utf8_lossy(&out.stdout.bytes), &secrets);
    let stderr = scrub(&String::from_utf8_lossy(&out.stderr.bytes), &secrets);
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
    let any = super::secret("vercel_token").is_some() || super::secret("cloudflare_token").is_some() || settings.aws_region.is_some();
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
        assert!(validate_spec(&catalog(), "pandacode_cloud_cli", &json!({"tool":"gcloud","args":"deploy"})).is_err());
    }

    #[test]
    fn refuses_aws_credential_commands() {
        let root = std::env::temp_dir();
        for args in ["configure", "configure get aws_secret_access_key", "--profile x configure list", "sts get-session-token", "--region us-east-1 sts get-session-token --duration-seconds 60"] {
            let err = run(&root, &json!({"tool":"aws","args":args})).unwrap_err();
            assert!(err.contains("not available here"), "{args}: {err}");
        }
        assert!(refuse_aws(&["s3".into(), "ls".into()]).is_ok());
        assert!(refuse_aws(&["sts".into(), "get-caller-identity".into()]).is_ok());
    }

    #[test]
    fn scrubs_aws_credentials() {
        let env = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\naws_session_token = FwoGZXIvYXdz//token==\n";
        let clean = scrub(env, &[]);
        for leak in ["AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI", "FwoGZXIvYXdz"] { assert!(!clean.contains(leak), "{clean}"); }
        assert!(clean.contains("AWS_SECRET_ACCESS_KEY=[redacted]"), "{clean}");
        let json = r#"{"Credentials": {"AccessKeyId": "ASIAIOSFODNN7EXAMPLE", "SecretAccessKey": "abc/def+ghi", "SessionToken": "tok/en=="}}"#;
        assert_eq!(scrub(json, &[]), r#"{"Credentials": {"AccessKeyId": "[redacted]", "SecretAccessKey": "[redacted]", "SessionToken": "[redacted]"}}"#);
        assert_eq!(scrub("key AKIAIOSFODNN7EXAMPLE here", &[]), "key [redacted] here");
        assert_eq!(scrub("s3://bucket/AKIA-short and sessiontoken docs", &[]), "s3://bucket/AKIA-short and sessiontoken docs");
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
