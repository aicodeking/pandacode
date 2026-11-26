//! ACP v1 transport for OpenCode, Kilo, Antigravity, Grok Build, Command Code, Cline,
//! GitHub Copilot CLI, Devin, Hermes and Cursor. Kimi retains its provider-specific mode mapping.
use super::*;
use crate::slash_commands::claude::Pipe;

const DISCOVERY_STARTUP: Duration = Duration::from_secs(60);
const COMMAND_GRACE: Duration = Duration::from_secs(1);
pub(crate) const ACP_STARTUP_TIMEOUT: &str = "ACP startup timed out after 60 seconds. Check the harness installation and sign-in, then refresh.";

pub(super) fn rpc_error(frame: &Value, stage: &str) -> String {
    let message = model_text(frame["error"]["message"].as_str(), "ACP request failed", 1000);
    let data = &frame["error"]["data"];
    let detail = data.as_str().or_else(|| data["message"].as_str()).or_else(|| data["details"].as_str()).unwrap_or("");
    super::diagnostics::failure(&format!("ACP {stage}: {message}"), detail)
}

fn transport_error(pipe: &Pipe, stage: &str) -> String {
    if pipe.timed_out() {
        ACP_STARTUP_TIMEOUT.into()
    } else {
        format!("ACP {stage} ended before a valid response. Check the harness installation and sign-in, then refresh.")
    }
}

/// Shown when Grok Build has no usable cached credentials.
pub(super) const GROK_SIGN_IN: &str =
    "Grok Build is not signed in. Run `grok login` in a terminal, then send again.";
/// Shown when Antigravity has no usable cached credentials.
pub(super) const ANTIGRAVITY_SIGN_IN: &str =
    "Antigravity is not signed in. Run `agy acp --login` in a terminal, then retry.";
/// For ACP harnesses with no read-only session mode (Grok Build, DeepSeek, Muse,
/// Hermes): plan mode is enforced by declining state-changing permission requests
/// and telling the model up front with this prefix.
pub(super) const READ_ONLY_PLAN_PREFIX: &str = "Plan mode is on for this session: work read-only. Investigate with read-only tools, then reply with a concrete, step-by-step plan. Do not edit files or run commands that change state; requests to do so will be declined.";

/// DeepSeek Harness serves ACP from its `acp` profile.
pub(super) const DEEPSEEK_ARGS: [&str; 2] = ["--profile", "acp"];
/// dsh reports every tool as kind "other"; these are its file-editing tools.
const DEEPSEEK_EDIT_TOOLS: [&str; 3] = ["edit", "write", "str_replace_editor"];

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    match config.provider.as_str() {
        "deepseek" => {
            command.args(DEEPSEEK_ARGS);
            // Overrides any inherited value so PandaCode's mode picks the sandbox.
            command.env(super::deepseek::PERMISSION_ENV, super::deepseek::sandbox(&config.mode));
        }
        "commandcode" => {
            // Modes are Command Code's own session modes; the saved key is set by the run.
            command.args(super::commandcode::ACP_ARGS);
        }
        "opencode" => {
            command.arg("acp");
            command.env("OPENCODE_CONFIG_CONTENT", configuration(&config.mode));
        }
        "grok" => {
            // Global flags precede `agent`; agent flags precede the `stdio` transport.
            // The permission mode overrides the user's config.toml so PandaCode's
            // approval choice, not the TUI's saved yolo setting, decides prompts.
            command.args(["--no-auto-update", "--permission-mode", grok_permission_mode(&config.mode), "agent"]);
            if config.mode == "full" {
                command.arg("--always-approve");
            }
            if !config.model.is_empty() && config.model != "default" {
                command.args(["--model", &config.model]);
            }
            if let Some(effort) = &config.reasoning_effort {
                command.args(["--reasoning-effort", effort]);
            }
            command.arg("stdio");
        }
        "github-copilot" => {
            command.args(["--no-auto-update", "--acp", "--stdio"]);
        }
        "cline" => super::cline::configure(command, config),
        "kilo" => super::kilo::configure(command),
        "devin" => super::devin::configure(command),
        "cursor" => super::cursor::configure(command),
        "hermes" => super::hermes::configure(command, config),
        "antigravity" => {
            configure_antigravity_base(command, config);
            antigravity_gemini_dir(command);
        }
        _ => {
            #[cfg(target_os = "linux")]
            command.arg("--uid=");
        }
    }
}

/// Whether `path` points to the standalone `agy` CLI rather than `agy_acp_server`.
pub(crate) fn is_agy_cli(path: &Path) -> bool {
    path.file_stem()
        .is_some_and(|stem| stem.eq_ignore_ascii_case("agy"))
}

fn command_env(command: &Command, name: &str) -> Option<PathBuf> {
    command
        .as_std()
        .get_envs()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value)
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn command_home(command: &Command) -> Option<PathBuf> {
    if cfg!(windows) {
        command_env(command, "USERPROFILE")
            .filter(|path| path.is_absolute())
            .or_else(|| command_env(command, "HOME").filter(|path| path.is_absolute()))
    } else {
        command_env(command, "HOME")
            .filter(|path| path.is_absolute())
            .or_else(|| command_env(command, "USERPROFILE").filter(|path| path.is_absolute()))
    }
}

/// Drops every `GEMINI_DIR` and `ANTIGRAVITY_GEMINI_DIR` spelling already on the command,
/// then blocks inheritance of `GEMINI_DIR`. Unix environments are case-sensitive, so one
/// `env_remove` leaves `gemini_dir` in place.
fn remove_gemini_dir_envs(command: &mut Command) {
    let keys: Vec<std::ffi::OsString> = command
        .as_std()
        .get_envs()
        .filter(|(key, _)| is_gemini_dir_var(key))
        .map(|(key, _)| key.to_os_string())
        .collect();
    for key in keys {
        command.env_remove(key);
    }
    command.env_remove("GEMINI_DIR");
}

fn is_gemini_dir_var(key: &std::ffi::OsStr) -> bool {
    let key = key.to_string_lossy();
    key.eq_ignore_ascii_case("GEMINI_DIR") || key.eq_ignore_ascii_case("ANTIGRAVITY_GEMINI_DIR")
}

fn is_gemini_dir_arg(arg: &std::ffi::OsStr) -> bool {
    let arg = arg.to_string_lossy();
    ["--gemini-dir", "--gemini_dir"]
        .iter()
        .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
}

fn is_home_var(key: &std::ffi::OsStr) -> bool {
    let key = key.to_string_lossy();
    key.eq_ignore_ascii_case("HOME") || key.eq_ignore_ascii_case("USERPROFILE")
}

/// The Gemini directory chosen on `command`: PandaCode's `GEMINI_DIR` (a named
/// connection's config folder or the provider environment), else agy's own
/// `ANTIGRAVITY_GEMINI_DIR`. agy's ACP server reads neither; it takes its
/// directory from `--gemini-dir` alone.
fn chosen_gemini_dir(command: &Command) -> Option<PathBuf> {
    let chosen: Vec<(String, PathBuf)> = command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| Some((key.to_string_lossy().into_owned(), PathBuf::from(value?))))
        .filter(|(key, value)| is_gemini_dir_var(std::ffi::OsStr::new(key)) && !value.to_string_lossy().trim().is_empty())
        .collect();
    ["GEMINI_DIR", "ANTIGRAVITY_GEMINI_DIR"]
        .iter()
        .find_map(|name| chosen.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)))
        .map(|(_, dir)| dir.clone())
}

/// True when this Named Connection's own environment sets `HOME` or `USERPROFILE`.
pub(super) fn connection_overrides_home(env: &[(String, String)]) -> bool {
    env.iter().any(|(key, value)| {
        (key.eq_ignore_ascii_case("HOME") || key.eq_ignore_ascii_case("USERPROFILE"))
            && !value.trim().is_empty()
    })
}

/// True when this Named Connection's own env or args choose a Gemini directory.
pub(super) fn connection_sets_gemini_dir(env: &[(String, String)], args: &[String]) -> bool {
    env.iter()
        .any(|(key, value)| is_gemini_dir_var(std::ffi::OsStr::new(key)) && !value.trim().is_empty())
        || args.iter().any(|arg| is_gemini_dir_arg(std::ffi::OsStr::new(arg)))
}

/// The Gemini directory this Named Connection's own env chooses: `GEMINI_DIR`, else
/// `ANTIGRAVITY_GEMINI_DIR` (any letter case, non-empty). Provider-wide settings are
/// not consulted, so a connection's choice beats them.
pub(super) fn connection_gemini_dir(env: &[(String, String)]) -> Option<PathBuf> {
    ["GEMINI_DIR", "ANTIGRAVITY_GEMINI_DIR"].iter().find_map(|name| {
        env.iter()
            .find(|(key, value)| key.eq_ignore_ascii_case(name) && !value.trim().is_empty())
            .map(|(_, value)| PathBuf::from(value.trim()))
    })
}

/// Rejects a `--gemini-dir` / `--gemini_dir` argument whose value is missing, blank or
/// relative: agy would resolve it against the project folder.
fn check_gemini_dir_args(command: &Command) -> Result<(), String> {
    let args: Vec<String> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    for (index, arg) in args.iter().enumerate() {
        let value = ["--gemini-dir", "--gemini_dir"].iter().find_map(|flag| {
            if arg == flag {
                Some(args.get(index + 1).map(String::as_str))
            } else {
                arg.strip_prefix(&format!("{flag}=")).map(Some)
            }
        });
        let Some(value) = value else { continue };
        let usable = value.is_some_and(|value| !value.trim().is_empty() && Path::new(value.trim()).is_absolute());
        if !usable {
            return Err("Antigravity needs an absolute path for --gemini-dir in this named connection.".into());
        }
    }
    Ok(())
}

fn antigravity_base_args(command: &mut Command) {
    let program = Path::new(command.as_std().get_program());
    if is_agy_cli(program) {
        command
            .args(["acp", "--process-per-session"])
            .args(super::privacy::antigravity_arguments());
        command.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    } else if cfg!(target_os = "linux") {
        command.arg("--uid=");
    }
}

pub(super) fn configure_antigravity_base(command: &mut Command, config: &RunConfig) {
    antigravity_base_args(command);
    let program = Path::new(command.as_std().get_program());
    if config.mode == "full" && is_agy_cli(program) {
        command.arg("--dangerously-skip-permissions");
    }
}

fn antigravity_gemini_dir_with(
    command: &mut Command,
    process_home: Option<PathBuf>,
    connection_overrides_home: bool,
    connection_sets_gemini_dir: bool,
    connection_dir: Option<PathBuf>,
) {
    let program = Path::new(command.as_std().get_program());
    if !is_agy_cli(program) {
        return;
    }
    let command_home = command_home(command);
    // A Named Connection that relocates HOME without choosing its own Gemini dir
    // must not keep a global, provider, or host GEMINI_DIR.
    if connection_overrides_home && !connection_sets_gemini_dir {
        remove_gemini_dir_envs(command);
        if let Some(home) = command_home {
            command.arg("--gemini-dir").arg(home.join(".gemini"));
        }
        return;
    }
    // agy reads its directory from `--gemini-dir` alone, so a `GEMINI_DIR` or
    // `ANTIGRAVITY_GEMINI_DIR` on the command (a named connection's config folder or
    // the provider environment) is passed on and removed, the host's is never
    // inherited, and an explicit argument wins. A Named Connection's own choice beats
    // a provider-wide one, whatever spelling each uses.
    let chosen = connection_dir
        .filter(|path| path.is_absolute())
        .or_else(|| chosen_gemini_dir(command));
    remove_gemini_dir_envs(command);
    if command.as_std().get_args().any(is_gemini_dir_arg) {
        return;
    }
    if let Some(dir) = chosen.filter(|path| path.is_absolute()) {
        command.arg("--gemini-dir").arg(dir);
    } else if let Some(home) = command_home {
        command.arg("--gemini-dir").arg(home.join(".gemini"));
    } else if let Some(home) = process_home.filter(|path| path.is_absolute()) {
        command.arg("--gemini-dir").arg(home.join(".gemini"));
    }
}

/// Appends `--gemini-dir` for the standalone `agy` CLI: the directory chosen on
/// `command` (an argument, `GEMINI_DIR` or `ANTIGRAVITY_GEMINI_DIR`), else
/// `HOME`/`USERPROFILE`'s `.gemini`, else the process home's.
pub(super) fn antigravity_gemini_dir(command: &mut Command) {
    antigravity_gemini_dir_with(command, crate::agent_usage_providers::home(), false, false, None);
}

/// Like `antigravity_gemini_dir`, with provenance from the Named Connection's own
/// env and args (before they are mixed with global or provider settings). agy
/// resolves a relative path against the project folder, which would put the Gemini
/// directory (settings, conversation store, credentials) inside it, so the task
/// fails here, before the process starts. `connection_env` and `connection_args` are
/// the connection's own (empty when there is none).
pub(super) fn antigravity_gemini_dir_isolated(
    command: &mut Command,
    connection_env: &[(String, String)],
    connection_args: &[String],
) -> Result<(), String> {
    for (key, value) in command.as_std().get_envs() {
        if !is_home_var(key) && !is_gemini_dir_var(key) {
            continue;
        }
        let relative = value.is_some_and(|value| {
            !value.to_string_lossy().trim().is_empty() && !Path::new(value).is_absolute()
        });
        if relative {
            return Err(format!(
                "Antigravity needs an absolute path for {} in this named connection.",
                key.to_string_lossy().to_ascii_uppercase()
            ));
        }
    }
    check_gemini_dir_args(command)?;
    antigravity_gemini_dir_with(
        command,
        crate::agent_usage_providers::home(),
        connection_overrides_home(connection_env),
        connection_sets_gemini_dir(connection_env, connection_args),
        connection_gemini_dir(connection_env),
    );
    Ok(())
}

/// The `agy` CLI needs a worker per session to accept editor-configured HTTP MCP servers.
pub(crate) fn antigravity_args(command: &mut Command) {
    antigravity_base_args(command);
    antigravity_gemini_dir(command);
}

pub(super) fn is_acp_provider(provider: &str) -> bool {
    matches!(
        provider,
        "kimi"
            | "opencode"
            | "antigravity"
            | "grok"
            | "deepseek"
            | "commandcode"
            | "cline"
            | "kilo"
            | "github-copilot"
            | "devin"
            | "hermes"
            | "cursor"
    )
}

fn session_capability(capabilities: &Value, name: &str) -> bool {
    capabilities["sessionCapabilities"]
        .get(name)
        .is_some_and(|v| v.is_object() || v == true)
}

fn acp_missing_session_error(frame: &Value) -> bool {
    let error = &frame["error"];
    if error["code"].as_i64() == Some(-32002) {
        return true;
    }
    let mut parts = Vec::new();
    for candidate in [
        error["message"].as_str(),
        error["data"].as_str(),
        error["data"]["message"].as_str(),
        error["data"]["details"].as_str(),
        error["data"]["error"].as_str(),
    ] {
        if let Some(part) = candidate.filter(|s| !s.is_empty()) {
            parts.push(part);
        }
    }
    let lower = parts.join(" ").to_ascii_lowercase();
    [
        "failed to read session",
        "session not found",
        "no such session",
        "unknown session",
        "session does not exist",
        "cannot read session",
        "could not find session",
        "invalid session",
        "or load it with session/load",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || (lower.contains("conversation") && lower.contains("not found"))
}

/// An error's message and data text, lowercased.
fn acp_error_text(frame: &Value) -> String {
    let error = &frame["error"];
    [
        error["message"].as_str(),
        error["data"].as_str(),
        error["data"]["message"].as_str(),
        error["data"]["details"].as_str(),
        error["data"]["error"].as_str(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
}

/// Antigravity answers -32000 for its context window as well. That limit is per
/// conversation: neither a sign-in problem nor an account limit to rotate on.
fn antigravity_context_error(frame: &Value) -> bool {
    acp_error_text(frame).contains("context")
}

/// Whether an error's text names a sign-in problem (stems, so "Not authenticated"
/// counts), as opposed to a session agy cannot find on resume, which it also
/// answers with -32000.
fn acp_sign_in_error(frame: &Value) -> bool {
    let text = acp_error_text(frame);
    [
        "authenticat", "login", "log in", "credential", "unauthori", "oauth", "signed in", "sign in",
        "auth token", "access token", "refresh token", "id token",
    ]
        .iter()
        .any(|needle| text.contains(needle))
}

pub(crate) fn grok_permission_mode(mode: &str) -> &'static str {
    match mode {
        "full" => "bypassPermissions",
        "auto" => "acceptEdits",
        _ => "default",
    }
}

/// The auth method Grok Build advertises for its cached credentials, if any.
fn cached_auth_method(result: &Value) -> Option<String> {
    let methods = result["authMethods"].as_array()?;
    let advertised = |id: &str| methods.iter().any(|method| method["id"] == id);
    result["_meta"]["defaultAuthMethodId"]
        .as_str()
        .filter(|id| advertised(id))
        .or_else(|| advertised("cached_token").then_some("cached_token"))
        .map(str::to_owned)
}

/// Read-only tools stay automatic in plan mode; anything that changes state is declined.
fn grok_read_only(tool: &Value) -> bool {
    tool["_meta"]["x.ai/tool"]["read_only"] == true
        || matches!(field(tool, "kind"), "read" | "search" | "fetch" | "think")
}

pub(super) fn configuration(mode: &str) -> String {
    let permission = match mode {
        "full" => json!({"*":"allow"}),
        "auto" => json!({"*":"ask","read":"allow","glob":"allow","grep":"allow","edit":"allow"}),
        // Investigation stays open: web lookups run; reads outside the project ask.
        "plan" => json!({"*":"deny","read":"allow","glob":"allow","grep":"allow","list":"allow","lsp":"allow","webfetch":"allow","websearch":"allow","external_directory":"ask"}),
        _ => json!({"*":"ask","read":"allow","glob":"allow","grep":"allow"}),
    };
    // Inline settings have the highest documented precedence and are private
    // to this process. Preserve existing inline settings, except permissions
    // which must follow the explicitly selected PandaCode policy.
    let mut inline = std::env::var("OPENCODE_CONFIG_CONTENT")
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    inline["permission"] = permission.clone();
    if !inline["agent"].is_object() {
        inline["agent"] = json!({});
    }
    for mode in ["build", "plan"] {
        if !inline["agent"][mode].is_object() {
            inline["agent"][mode] = json!({});
        }
        inline["agent"][mode]["permission"] = permission.clone();
    }
    inline.to_string()
}

/// How much a harness's own mode ID approves without asking: 1 asks, 2 edits,
/// 3 anything. A guess from the name, used only to refuse a fallback.
fn mode_reach(provider: &str, id: &str) -> u8 {
    if provider == "antigravity" && id.eq_ignore_ascii_case("auto") {
        return 3;
    }
    let id = id.to_ascii_lowercase();
    if ["bypass", "yolo", "full", "danger", "dont", "trust", "unsafe"].iter().any(|word| id.contains(word)) {
        3
    } else if ["accept", "auto", "edit"].iter().any(|word| id.contains(word)) {
        2
    } else {
        1
    }
}
/// Why a task did not start: the server advertises no mode for the approval choice.
fn mode_unadvertised(provider: &str) -> String {
    if provider == "antigravity" {
        // agy 1.5.7+ opens new sessions in Auto, so running in agy's own default mode
        // would approve more than the task allows; the standalone ACP server is older
        // and advertises no mode at all.
        "Antigravity did not offer this task's approval mode, so the task did not start; it would have run in agy's own default mode. Run `agy update` in a terminal outside PandaCode (or use its official installer), or select the agy CLI instead of the standalone ACP server, then retry.".into()
    } else {
        "This harness does not advertise the selected task mode.".into()
    }
}
pub(super) fn options<'a>(config: &'a Value, category: &str) -> Option<&'a Value> {
    let selects = || config["configOptions"].as_array().into_iter().flatten().take(64).filter(|option| option["type"] == "select");
    // An exact ID wins: Cline files its account `provider` option under the model category too.
    selects()
        .find(|option| option["id"] == category)
        .or_else(|| selects().find(|option| option["category"] == category))
}
pub(super) fn choices(option: &Value) -> Vec<&Value> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry["options"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_else(|| std::slice::from_ref(entry))
        })
        // Match discovery's catalog limit and bound the flattened total, rather
        // than discarding valid choices after the first 1,000 in each group.
        .take(MODEL_CATALOG_LIMIT)
        .collect()
}
/// Phrases of the ACP startup errors for a reasoning effort the harness refuses (no adjustable
/// effort; a level it does not offer), shared with the team scheduler that relaunches a worker
/// without the effort (`architect::model_efforts::rejected`). The messages read as before.
pub(crate) const NO_ADJUSTABLE_EFFORT: &str = "does not advertise an adjustable reasoning effort";
pub(crate) const UNADVERTISED_CHOICE: &str = "does not advertise the selected";
fn choice_request(session: &str, id: u64, option: &Value, value: &str) -> Result<Value, String> {
    let offered = choices(option);
    if !offered.iter().any(|entry| entry["value"] == value) {
        // Name the setting, the rejected value and what the harness actually offers
        // (issue #209): the generic sentence left no way to see which side disagreed.
        let setting = ["id", "category"]
            .into_iter()
            .find_map(|field| option[field].as_str().filter(|name| !name.is_empty()))
            .unwrap_or("setting");
        let names: Vec<&str> = offered
            .iter()
            .filter_map(|entry| entry["value"].as_str())
            .collect();
        let take = names.len().min(12);
        let shown = names[..take].join(", ");
        let offers = if names.len() > take {
            format!("{shown}, …")
        } else if names.is_empty() {
            "nothing".to_owned()
        } else {
            shown
        };
        return Err(format!(
            "The harness {UNADVERTISED_CHOICE} {setting} \"{value}\". It offers: {offers}. Refresh its models or choose the harness default."
        ));
    }
    Ok(
        json!({"jsonrpc":"2.0","id":id,"method":"session/set_config_option","params":{"sessionId":session,"configId":option["id"],"value":value}}),
    )
}

impl Protocol {
    /// `mcpServers` for `session/new`, `session/load` and `session/resume`: the
    /// bridge's HTTP entry (when the agent takes HTTP MCP) and any extra stdio
    /// servers, which every ACP agent accepts without a capability.
    pub(super) fn acp_mcp_servers(&self) -> Vec<Value> {
        self.mcp_server.iter().chain(&self.extra_mcp_servers).cloned().collect()
    }
    pub(super) fn acp(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        let grok = self.config.provider == "grok";
        if self.acp_live_answered(&value, &mut step)? {
            return Ok(step);
        }
        if value.get("error").is_some() {
            let stage = match value["id"].as_u64() {
                Some(1) => "initialize",
                Some(2) => "session creation or resume",
                Some(3) => "session/prompt",
                Some(4) => "mode selection",
                Some(5) => "model selection",
                Some(6) => "reasoning selection",
                _ => "request",
            };
            // Hermes uses -32000 for several provider-specific conditions; check
            // them first so they are not masked by generic authentication guidance.
            if self.config.provider == "hermes" {
                let err_str = value["error"]["data"].as_str()
                    .or_else(|| value["error"]["data"]["details"].as_str())
                    .or_else(|| value["error"]["message"].as_str())
                    .unwrap_or("");
                if err_str.contains("No LLM provider configured") || err_str.contains("ProviderNotConfiguredError") {
                    return Err("Hermes Agent has no inference provider configured. Run `hermes model` or set model.provider in ~/.hermes/config.yaml (e.g. 'openrouter'), then retry.".into());
                }
                if err_str.contains("No endpoints found that support tool use") {
                    return Err("The configured Hermes Agent model does not support tool use. Run `hermes model` to select a model that supports function calling, then retry.".into());
                }
                if err_str.contains("Key limit exceeded") {
                    return Err("Hermes Agent inference failed: API key quota or credit limit exceeded. Check your provider account credits/limits or choose a free model with `hermes model`.".into());
                }
                if err_str.contains("storage_unavailable") || value["error"]["code"] == -32000 {
                    return Err("Hermes Agent is not configured with a default model. Run `hermes model` or `hermes acp --setup` in a terminal (or set model.default in ~/.hermes/config.yaml), then retry.".into());
                }
            }
            // Antigravity answers -32000 for sign-in and for an exhausted quota
            // or rate limit. Reporting a limit surfaces the quota/reset notice
            // instead of asking for a login (and rotates any pooled account if
            // enabled), and wins over a missing-session retry quoting it.
            let limit = (self.config.provider == "antigravity")
                .then(|| super::limits::antigravity_rpc_limited(&value, super::limits::now_epoch_ms()))
                .flatten();
            if let Some(resets_at) = limit {
                step.events.push(self.limited_event(resets_at, None));
                step.failure = Some(format!(
                    "{}: {}",
                    self.config.provider,
                    rpc_error(&value, stage)
                ));
                return Ok(step);
            }
            // Check -32000 authentication errors BEFORE missing-session fallback
            // so an auth error mentioning "not found" is never misreported. agy
            // answers a resume of a missing session with -32000 as well: with no
            // sign-in word that is the missing session, and telling a signed-in
            // user to log in would never recover the thread.
            let missing_resume = self.config.provider == "antigravity"
                && value["id"] == 2
                && self.acp_resuming
                && acp_missing_session_error(&value)
                && !acp_sign_in_error(&value);
            if value["error"]["code"] == -32000
                || (grok && value["id"] == 7)
                || (self.config.provider == "cursor" && value["id"] == 7)
            {
                // OpenCode can open a session before the model's upstream provider
                // rejects the prompt for missing credentials (#391).
                if self.config.provider == "opencode"
                    && value["error"]["code"] == -32000
                    && value["id"] == 3
                    && self.phase == 1
                    && !self.remote_id.is_empty()
                {
                    if let Some(error) = self.opencode_prompt_auth_error() {
                        return Err(error);
                    }
                }
                if self.config.provider == "antigravity" && antigravity_context_error(&value) {
                    return Err(format!("{}: {}", self.config.provider, rpc_error(&value, stage)));
                }
                // The server's own words stay visible: an unexpected -32000 (an
                // unknown model, for instance) is then not hidden behind a login hint.
                if !missing_resume {
                    return Err(match self.config.provider.as_str() {
                        "antigravity" => format!("{ANTIGRAVITY_SIGN_IN} (The server said: {})", rpc_error(&value, stage)),
                        "github-copilot" => "GitHub Copilot CLI requires sign-in. Run `copilot login` in a terminal, then retry.".into(),
                        "grok" => GROK_SIGN_IN.into(),
                        "commandcode" => super::commandcode::SIGN_IN.into(),
                        "cline" => super::cline::SIGN_IN.into(),
                        "kilo" => super::kilo::SIGN_IN.into(),
                        "devin" => super::devin::SIGN_IN.into(),
                        "cursor" => super::cursor::SIGN_IN.into(),
                        other => format!("{other} requires authentication. Sign in using its own CLI or official extension, then retry."),
                    });
                }
            }
            if value["id"] == 2 && self.acp_resuming && acp_missing_session_error(&value) {
                if self.acp_can_load && !self.acp_load_fallback_tried {
                    self.acp_load_fallback_tried = true;
                    self.acp_config = Value::Null;
                    self.acp_context_window = None;
                    self.acp_pending_phase0_usage = None;
                    self.acp_saw_any_usage_update = false;
                    self.early_kimi_commands = None;
                    let params = self.acp_resume_params.take().unwrap_or_else(|| {
                        json!({
                            "cwd": launch::external_path(&self.config.cwd),
                            "mcpServers": self.mcp_server.iter().collect::<Vec<_>>(),
                            "sessionId": self.remote_id,
                        })
                    });
                    step.write.push(json!({"jsonrpc":"2.0","id":2,"method":"session/load","params":params}));
                    self.acp_startup_status(&mut step);
                    return Ok(step);
                }
                if !self.acp_fresh_fallback_tried {
                    if self.config.no_fresh_resume_fallback {
                        // Account-pool rotation already rewrote the prompt as a resume.
                        // An empty session/new would treat that text as a new task.
                        self.acp_pending_phase0_usage = None;
                    } else {
                        self.acp_fresh_fallback_tried = true;
                        self.acp_resuming = false;
                        self.remote_id.clear();
                        self.config.resume_id = None;
                        self.acp_resume_params = None;
                        self.acp_config = Value::Null;
                        self.acp_context_window = None;
                        self.acp_pending_phase0_usage = None;
                        self.acp_saw_any_usage_update = false;
                        self.early_kimi_commands = None;
                        step.events.push(self.event(
                            "note",
                            "Saved session could not be resumed; started a fresh session.",
                            None,
                        ));
                        step.write.push(json!({
                            "jsonrpc": "2.0",
                            "id": 2,
                            "method": "session/new",
                            "params": {
                                "cwd": launch::external_path(&self.config.cwd),
                                "mcpServers": self.mcp_server.iter().collect::<Vec<_>>(),
                            }
                        }));
                        self.acp_startup_status(&mut step);
                        return Ok(step);
                    }
                }
            }
            return Err(format!("{}: {}", self.config.provider, rpc_error(&value, stage)));
        }
        if grok {
            self.grok_observe(&value, &mut step);
        }
        if let Some(id) = value["id"]
            .as_u64()
            .filter(|_| value.get("result").is_some())
        {
            let result = &value["result"];
            match id {
                1 => {
                    if self.config.provider == "deepseek" && !self.remote_id.is_empty() {
                        match super::deepseek::saved_session(&self.remote_id, &self.config.mode) {
                            Some(id) => self.remote_id = id,
                            None => {
                                self.remote_id.clear();
                                step.events.push(self.event("status", "Approval mode changed: starting a fresh DeepSeek session", None));
                            }
                        }
                    }
                    if result["protocolVersion"] != 1 {
                        return Err("This harness does not support ACP protocol v1.".into());
                    }
                    let capabilities = &result["agentCapabilities"];
                    self.acp_can_load = capabilities["loadSession"] == true
                        || session_capability(capabilities, "load");
                    self.acp_can_close = session_capability(capabilities, "close");
                    self.acp_resuming = false;
                    self.acp_load_fallback_tried = false;
                    self.acp_fresh_fallback_tried = false;
                    self.acp_resume_params = None;
                    if !self.image_blocks.is_empty()
                        && capabilities["promptCapabilities"]["image"] != true
                    {
                        return Err(if grok {
                            "Grok Build does not accept images yet. Remove them and describe what they show.".into()
                        } else {
                            "This harness does not advertise image input. Remove the images or update the harness.".into()
                        });
                    }
                    if self.mcp_server.is_some() && capabilities["mcpCapabilities"]["http"] != true
                    {
                        if self.mcp_required {
                            return Err("This harness does not advertise HTTP MCP support required for PandaCode tools. Update its ACP server.".into());
                        }
                        // Title suggestions and host tools are optional capabilities.
                        // Older ACP agents or harnesses without HTTP MCP can continue
                        // normally using the local fallback.
                        self.mcp_server = None;
                        self.mcp_tool_names.clear();
                    }
                    let mut params = json!({"cwd":launch::external_path(&self.config.cwd),"mcpServers":self.acp_mcp_servers()});
                    let method = if self.remote_id.is_empty() {
                        "session/new"
                    } else {
                        params["sessionId"] = json!(self.remote_id);
                        if session_capability(capabilities, "resume") {
                            self.acp_resuming = true;
                            self.acp_resume_params = Some(params.clone());
                            "session/resume"
                        } else if self.acp_can_load {
                            self.acp_resuming = true;
                            self.acp_load_fallback_tried = true;
                            "session/load"
                        } else {
                            return Err("This ACP server cannot resume saved tasks. Update the server or start a new task.".into());
                        }
                    };
                    let session = json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
                    if grok {
                        // Grok Build wants an explicit authenticate before any session call,
                        // even with cached credentials. No cached method means no sign-in.
                        let method = cached_auth_method(result).ok_or(GROK_SIGN_IN)?;
                        self.acp_pending_session = Some(session);
                        step.write.push(json!({"jsonrpc":"2.0","id":7,"method":"authenticate","params":{"methodId":method}}));
                    } else if let Some(method) = super::cursor::login_method(self.config.provider.as_str(), result) {
                        // Cursor's documented flow is initialize, then authenticate
                        // with the advertised cursor_login method, then the session.
                        self.acp_pending_session = Some(session);
                        step.write.push(json!({"jsonrpc":"2.0","id":7,"method":"authenticate","params":{"methodId":method}}));
                    } else {
                        step.write.push(session);
                    }
                }
                7 => {
                    if let Some(session) = self.acp_pending_session.take() {
                        step.write.push(session);
                    }
                }
                2 => {
                    self.acp_resuming = false;
                    self.acp_resume_params = None;
                    let returned = field(result, "sessionId");
                    if !returned.is_empty() && returned.len() <= 256 {
                        self.remote_id = returned.into();
                    }
                    if self.remote_id.is_empty() {
                        return Err("ACP did not return a session ID".into());
                    }
                    self.flush_pending_phase0_usage(&mut step);
                    self.acp_merge_config(result);
                    if let Some(bytes) = self.early_kimi_commands.take() {
                        if let Ok(frame) = serde_json::from_slice::<Value>(&bytes) {
                            if frame["params"]["sessionId"] == self.remote_id {
                                self.commands_changed(&frame, &mut step);
                            }
                        }
                    }
                    let saved = if self.config.provider == "deepseek" {
                        super::deepseek::resume_id(&self.remote_id, &self.config.mode)
                    } else {
                        self.remote_id.clone()
                    };
                    step.events.push(self.event("session", saved, None));
                    self.acp_mode(&mut step)?;
                }
                4 => {
                    self.acp_update_config(result);
                    if self.config.provider == "github-copilot" {
                        self.acp_copilot_permissions(&mut step)?;
                    } else {
                        self.acp_model(&mut step)?;
                    }
                }
                8 if self.config.provider == "github-copilot" => {
                    self.acp_update_config(result);
                    self.acp_model(&mut step)?;
                }
                5 => {
                    // A previous model's window must not bleed into the model just selected.
                    self.acp_context_window = None;
                    self.acp_update_config(result);
                    self.acp_effort(&mut step)?;
                }
                6 => self.kimi_prompt(&mut step),
                3 => {
                    if let Some(total) = result["_meta"]["totalTokens"].as_u64().filter(|_| grok) {
                        let window = self.grok_context_window();
                        self.usage(total, window, &mut step);
                    } else if self.config.provider == "antigravity" && !self.acp_saw_usage_update {
                        // Only Antigravity's turn-end `usage` was recorded as window
                        // occupancy; other agents report a per-call sum, which would
                        // make their meter jump at each turn end.
                        let usage = &result["usage"];
                        let used = usage["inputTokens"].as_u64().or_else(|| {
                            (!self.acp_saw_any_usage_update)
                                .then(|| usage["totalTokens"].as_u64())
                                .flatten()
                        });
                        if let Some(used) = used {
                            let window = usage["contextWindow"]
                                .as_u64()
                                .filter(|&n| n > 0 && n <= 1_000_000_000)
                                .or(self.acp_context_window);
                            self.usage(used, window, &mut step);
                        }
                    }
                    self.acp_turn_end(result, &mut step)?;
                }
                _ => {}
            }
            self.acp_startup_status(&mut step);
            return Ok(step);
        }
        if !self.remote_id.is_empty()
            && value["method"] == "session/update"
            && value["params"]["sessionId"] == self.remote_id
            && value["params"]["update"]["sessionUpdate"] == "config_option_update"
        {
            self.acp_update_config(&value["params"]["update"]);
        }
        if self.config.provider == "devin" && super::devin::subagent_usage(&value) {
            return Ok(step);
        }
        if self.config.provider == "cursor" && self.cursor_request(&value, &mut step) {
            return Ok(step);
        }
        if value["method"] == "session/request_permission" {
            if value["params"]["sessionId"]
                .as_str()
                .is_some_and(|id| id != self.remote_id)
            {
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                return Ok(step);
            }
            // ACP modes aren't universally approval policies. Keep user prompts
            // intact unless Full access, or Auto edits for an explicit edit call.
            let options = value["params"]["options"].as_array();
            let one_allow = options.is_some_and(|values| {
                values
                    .iter()
                    .filter(|entry| entry["kind"] == "allow_once")
                    .count()
                    == 1
            });
            let structured_question = options.is_some_and(|options| {
                options.iter().any(|option| {
                    field(option, "optionId")
                        .strip_prefix('q')
                        .and_then(|id| id.split_once("_opt_"))
                        .is_some_and(|(number, _)| number.parse::<usize>().is_ok())
                })
            });
            // As for Claude: a registered self-scoped host tool can't touch the checkout.
            if one_allow
                && !structured_question
                && self.self_scoped_mcp_tool(&value["params"]["toolCall"]).is_some()
            {
                let allow = options
                    .unwrap()
                    .iter()
                    .find(|entry| entry["kind"] == "allow_once")
                    .unwrap();
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":allow["optionId"]}}}));
                return Ok(step);
            }
            let deepseek = self.config.provider == "deepseek";
            let copilot = self.config.provider == "github-copilot";
            let policy: Option<fn(&str, &str) -> Option<&'static str>> = match self.config.provider.as_str() {
                "kilo" => Some(super::kilo::permission),
                "cursor" => Some(super::cursor::permission),
                _ => None,
            };
            if let Some(policy) = policy {
                let tool = &value["params"]["toolCall"];
                if let Some(wanted) = policy(&self.config.mode, field(tool, "kind")) {
                    let selected = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                    let outcome = match selected {
                        Some(selected) => json!({"outcome":"selected","optionId":selected["optionId"]}),
                        None => json!({"outcome":"cancelled"}),
                    };
                    if wanted == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":outcome}}));
                    return Ok(step);
                }
            }
            if deepseek && self.config.mode == "plan" {
                // dsh runs read-only here and asks only to escalate past it.
                if let Some(selected) = options.and_then(|values| values.iter().find(|entry| entry["kind"] == "reject_once")) {
                    let name = self.tools.get(field(&value["params"]["toolCall"], "toolCallId")).map_or("a state-changing action", |tool| tool.name.as_str());
                    step.events.push(self.event("status", format!("Plan mode declined: {}", model_text(Some(name), "a state-changing action", 200)), None));
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            if grok && self.config.mode == "plan" {
                let tool = &value["params"]["toolCall"];
                let wanted = if grok_read_only(tool) { "allow_once" } else { "reject_once" };
                let choice = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if wanted == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            // Read, search and fetch requests keep the ordinary approval path, as in Standard mode.
            if copilot
                && self.config.mode == "plan"
                && !matches!(field(&value["params"]["toolCall"], "kind"), "read" | "search" | "fetch")
            {
                let tool = &value["params"]["toolCall"];
                let kind = field(tool, "kind");
                let read_only = kind == "think";
                let wanted = if read_only {
                    "allow_once"
                } else {
                    "reject_once"
                };
                let choice =
                    options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if !read_only {
                        let title =
                            model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event(
                            "status",
                            format!("Plan mode declined: {title}"),
                            None,
                        ));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                } else {
                    // A Plan task must not turn an unrecognized ACP permission
                    // request into a user-overridable write approval.
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                }
                return Ok(step);
            }
            if self.config.provider == "hermes" && self.config.mode == "plan" {
                let tool = &value["params"]["toolCall"];
                let kind = field(tool, "kind");
                let read_only = matches!(kind, "read" | "search" | "fetch" | "think");
                let wanted = if read_only { "allow_once" } else { "reject_once" };
                let choice = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if wanted == "reject_once" {
                        let title = model_text(tool["title"].as_str().or_else(|| self.tools.get(field(tool, "toolCallId")).map(|t| t.name.as_str())), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            if self.config.provider == "devin" {
                return self.devin_permission(value, step);
            }
            if self.config.provider == "cline" {
                let tool = &value["params"]["toolCall"];
                let wanted = super::cline::permission(&self.config.mode, field(tool, "kind"));
                if let Some(selected) = wanted.and_then(|wanted| options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted))) {
                    if selected["kind"] == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a file change", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            if self.plan_fallback {
                // The harness runs in its own mode, so PandaCode enforces the
                // plan rules itself: reads pass, anything else is declined.
                let tool = &value["params"]["toolCall"];
                let read_only = matches!(field(tool, "kind"), "read" | "search" | "fetch" | "think");
                let wanted = if read_only { "allow_once" } else { "reject_once" };
                let choice = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if !read_only {
                        let title = model_text(tool["title"].as_str().or_else(|| self.tools.get(field(tool, "toolCallId")).map(|t| t.name.as_str())), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
                if !read_only {
                    // A plan task must not turn an unrecognized ACP permission
                    // request into a user-overridable write approval.
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                    return Ok(step);
                }
                // Read, search and fetch requests keep the ordinary approval
                // path, as in Standard mode.
            }
            let edit = value["params"]["toolCall"]["kind"] == "edit"
                || (deepseek
                    && self.tools.get(field(&value["params"]["toolCall"], "toolCallId"))
                        .is_some_and(|tool| DEEPSEEK_EDIT_TOOLS.contains(&tool.name.as_str())));
            let auto = self.config.mode == "full" || (self.config.mode == "auto" && edit);
            if auto && one_allow && !structured_question {
                let selected = options
                    .unwrap()
                    .iter()
                    .find(|entry| entry["kind"] == "allow_once")
                    .unwrap();
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                return Ok(step);
            }
        }
        // ACP's streaming text, tools, usage, cancel, and interactive approvals
        // share the same schema as Kimi, without Kimi's initialization rules.
        // Provider observations gathered above lead the shared step.
        let mut inner = self.kimi(value)?;
        if step.events.is_empty() && step.write.is_empty() {
            return Ok(inner);
        }
        step.events.append(&mut inner.events);
        step.write.append(&mut inner.write);
        step.calls.append(&mut inner.calls);
        step.goal_acknowledgements.append(&mut inner.goal_acknowledgements);
        step.done |= inner.done;
        step.failure = step.failure.or(inner.failure);
        Ok(step)
    }
    fn self_scoped_mcp_tool<'a>(&self, tool_call: &'a Value) -> Option<&'a str> {
        // Auto-approval is only for the two harnesses whose MCP titles we can verify.
        // Every other ACP agent keeps the normal permission prompt.
        // Cline injects the host through its private settings file, so `mcp_server`
        // stays empty while `mcp_tool_names` still lists the tools registered for this run.
        // Antigravity only auto-approves while that ACP server is attached.
        let tool_call_id = field(tool_call, "toolCallId");
        if tool_call_id.is_empty()
            || self.non_mcp_tools.contains(tool_call_id)
            || self.non_mcp_tools.contains(&limited(tool_call_id, 256))
        {
            return None;
        }
        if !matches!(field(tool_call, "kind"), "" | "other") {
            return None;
        }
        // A tool call that names filesystem locations is not a self-scoped host tool.
        // Only an absent, null or empty `locations` qualifies: any other value fails closed.
        let locations = &tool_call["locations"];
        if !locations.is_null() && !locations.as_array().is_some_and(Vec::is_empty) {
            return None;
        }
        let title = field(tool_call, "title");
        let candidate = match self.config.provider.as_str() {
            "cline" => super::cline::host_tool(title)?,
            "antigravity" => {
                self.mcp_server.as_ref()?;
                let trimmed = title.trim();
                trimmed
                    .strip_prefix("mcp__pandacode_architect__")
                    .or_else(|| trimmed.strip_prefix("mcp_pandacode_architect_"))?
            }
            _ => return None,
        };
        (super::self_scoped_host_tool(candidate) && self.mcp_tool_names.contains(candidate))
            .then_some(candidate)
    }

    fn acp_merge_config(&mut self, result: &Value) {
        if let Some(incoming) = result.as_object() {
            if !self.acp_config.is_object() {
                self.acp_config = json!({});
            }
            let target = self.acp_config.as_object_mut().unwrap();
            for (key, value) in incoming {
                if value.is_null() {
                    continue;
                }
                if key == "configOptions" {
                    let Some(items) = value.as_array() else {
                        continue;
                    };
                    if items.is_empty()
                        && target
                            .get("configOptions")
                            .and_then(Value::as_array)
                            .is_some_and(|existing| !existing.is_empty())
                    {
                        continue;
                    }
                }
                target.insert(key.clone(), value.clone());
            }
        } else if !self.acp_config.is_object() {
            self.acp_config = result.clone();
        }
    }

    fn acp_update_config(&mut self, result: &Value) {
        if let Some(items) = result["configOptions"].as_array() {
            if items.is_empty()
                && self.acp_config["configOptions"]
                    .as_array()
                    .is_some_and(|existing| !existing.is_empty())
            {
                return;
            }
            if !self.acp_config.is_object() {
                self.acp_config = json!({});
            }
            self.acp_config["configOptions"] = result["configOptions"].clone();
        }
    }

    fn acp_startup_status(&mut self, step: &mut Step) {
        let label = step.write.iter().find_map(|request| match field(request, "method") {
            "authenticate" => Some("Checking harness sign-in"),
            "session/new" => Some("Opening session"),
            "session/load" | "session/resume" => Some("Restoring session"),
            "session/set_mode" => Some("Applying task mode"),
            "session/set_model" => Some("Applying model settings"),
            "session/set_config_option" => Some(match request["id"].as_u64() {
                Some(4) => "Applying task mode",
                Some(6) => "Applying reasoning settings",
                _ => "Applying model settings",
            }),
            "session/prompt" => Some("Waiting for response"),
            _ => None,
        });
        if label == Some("Waiting for response") {
            if let Some(note) = self.mode_note.take() {
                step.events.push(self.event("status", note, None));
                return;
            }
        }
        if let Some(label) = label { step.events.push(self.event("status", label, None)); }
    }
    /// Grok Build annotates every frame with the context it currently holds and
    /// reports model switches on its own notification channel.
    fn grok_observe(&mut self, value: &Value, step: &mut Step) {
        let params = &value["params"];
        if params["sessionId"] != self.remote_id || self.remote_id.is_empty() {
            return;
        }
        if value["method"] == "session/update" {
            if let Some(total) = value["_meta"]["totalTokens"].as_u64() {
                if total != self.grok_context_used {
                    self.grok_context_used = total;
                    let window = self.grok_context_window();
                    self.usage(total, window, step);
                }
            }
            match field(&params["update"], "sessionUpdate") {
                "agent_thought_chunk" if !self.grok_reasoning => {
                    self.grok_reasoning = true;
                    step.events.push(self.event("status", "Reasoning", None));
                }
                "agent_message_chunk" | "tool_call" => self.grok_reasoning = false,
                _ => {}
            }
        } else if value["method"] == "_x.ai/session_notification"
            && params["update"]["sessionUpdate"] == "model_changed"
        {
            let model = field(&params["update"], "model_id");
            if valid_model_id(model) {
                self.active_model = model.into();
            }
        }
    }
    fn grok_context_window(&self) -> Option<u64> {
        let models = &self.acp_config["models"];
        let current = if self.active_model.is_empty() || self.active_model == "default" {
            field(models, "currentModelId")
        } else {
            self.active_model.as_str()
        };
        models["availableModels"]
            .as_array()?
            .iter()
            .find(|model| model["modelId"] == current)
            .and_then(|model| model["_meta"]["totalContextTokens"].as_u64())
    }
    fn acp_mode(&mut self, step: &mut Step) -> Result<(), String> {
        if matches!(self.config.provider.as_str(), "grok" | "deepseek") {
            // No session modes over ACP; plan mode lives in the permission policy.
            return self.acp_model(step);
        }
        let candidates: &[&str] = if self.config.provider == "commandcode" {
            // Command Code's ACP modes are its permission modes, so each PandaCode
            // choice has exactly one, and a missing one must not widen access.
            &[super::commandcode::mode_id(&self.config.mode)]
        } else if self.config.provider == "kilo" {
            &[super::kilo::mode_id(&self.config.mode)]
        } else if self.config.provider == "devin" {
            &[super::devin::mode_id(&self.config.mode)]
        } else if self.config.provider == "cursor" {
            &[super::cursor::mode_id(&self.config.mode)]
        } else if self.config.provider == "hermes" {
            match self.config.mode.as_str() {
                "auto" => &["accept_edits", "default"],
                "full" => &["dont_ask", "default"],
                _ => &["default"],
            }
        } else if self.config.provider == "cline" {
            // Cline has Plan and Act; approvals ride on permission requests.
            &[if self.config.mode == "plan" { "plan" } else { "act" }]
        } else if self.config.provider == "github-copilot" {
            let suffix = if self.config.mode == "plan" {
                "#plan"
            } else {
                "#agent"
            };
            if let Some(option) = options(&self.acp_config, "mode") {
                let mode_choices = choices(option);
                let found = mode_choices
                    .iter()
                    .find(|entry| field(entry, "value").ends_with(suffix));
                let Some(found) = found else {
                    return Err("GitHub Copilot CLI does not advertise the selected task mode. Update Copilot CLI, then refresh.".into());
                };
                step.write.push(choice_request(
                    &self.remote_id,
                    4,
                    option,
                    field(found, "value"),
                )?);
                return Ok(());
            }
            let Some(mode) = self.acp_config["modes"]["availableModes"]
                .as_array()
                .and_then(|modes| {
                    modes
                        .iter()
                        .find(|mode| field(mode, "id").ends_with(suffix))
                })
            else {
                return Err("GitHub Copilot CLI does not advertise the selected task mode. Update Copilot CLI, then refresh.".into());
            };
            step.write.push(json!({"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":self.remote_id,"modeId":mode["id"]}}));
            return Ok(());
        } else if self.config.provider == "opencode" {
            if self.config.mode == "plan" {
                &["plan"]
            } else {
                &["build"]
            }
        } else if self.config.provider == "antigravity" {
            match self.config.mode.as_str() {
                "plan" => &["plan", "planning"],
                "auto" => &["accept-edits", "default"],
                "full" => &["auto", "default"],
                _ => &["default"],
            }
        } else if self.config.mode == "plan" {
            &["plan", "planning"]
        } else {
            &["default", "ask", "code"]
        };
        // On these harnesses the ACP mode is the approval policy, so a missing
        // one must fail the run rather than silently widen access.
        let permission_modes = matches!(
            self.config.provider.as_str(),
            "opencode" | "kilo" | "commandcode" | "cline" | "devin" | "cursor" | "antigravity"
        );
        if let Some(option) = options(&self.acp_config, "mode") {
            let found = candidates
                .iter()
                .find(|id| choices(option).iter().any(|entry| entry["value"] == **id));
            if let Some(id) = found {
                if self.unchanged(option, id) {
                    return self.acp_model(step);
                }
                step.write
                    .push(choice_request(&self.remote_id, 4, option, id)?);
                return Ok(());
            }
            if permission_modes {
                return Err(mode_unadvertised(&self.config.provider));
            }
            self.mode_fallback()?;
        } else if let Some(modes) = self.acp_config["modes"]["availableModes"].as_array() {
            if let Some(mode) = candidates
                .iter()
                .find_map(|id| modes.iter().find(|mode| mode["id"] == *id))
            {
                step.write.push(json!({"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":self.remote_id,"modeId":mode["id"]}}));
                return Ok(());
            }
            if permission_modes {
                return Err(mode_unadvertised(&self.config.provider));
            }
            self.mode_fallback()?;
        } else if self.config.mode == "plan"
            || matches!(
                self.config.provider.as_str(),
                "kilo" | "devin" | "cursor" | "antigravity"
            )
        {
            // With no mode information at all (a bare resumed session, for
            // instance) the run still fails rather than guess.
            return Err(if matches!(
                self.config.provider.as_str(),
                "kilo" | "devin" | "cursor" | "antigravity"
            ) {
                mode_unadvertised(&self.config.provider)
            } else {
                "This harness does not advertise a read-only planning mode.".to_owned()
            });
        }
        self.acp_model(step)
    }
    /// A generic harness without the selected mode keeps running in its own
    /// mode, with a note naming that mode instead of a failed session (#269).
    /// It never runs in a mode that approves more than the task allows, and a
    /// plan task keeps its read-only rules on PandaCode's side.
    fn mode_fallback(&mut self) -> Result<(), String> {
        let (id, name) = match options(&self.acp_config, "mode") {
            Some(option) => {
                let id = field(option, "currentValue");
                (id, choices(option).into_iter().find(|entry| entry["value"] == id).map_or("", |entry| field(entry, "name")))
            }
            None => {
                let id = field(&self.acp_config["modes"], "currentModeId");
                let modes = self.acp_config["modes"]["availableModes"].as_array();
                (id, modes.and_then(|modes| modes.iter().find(|mode| mode["id"] == id)).map_or("", |mode| field(mode, "name")))
            }
        };
        let current = model_text(Some(if name.is_empty() { id } else { name }), "default", 80);
        let reach = mode_reach(&self.config.provider, id);
        let chosen = match self.config.mode.as_str() { "plan" => 0, "auto" => 2, "full" => 3, _ => 1 };
        let label = match chosen { 0 => "Plan", 2 => "Accept edits", 3 => "Full access", _ => "Standard" };
        if reach > chosen.max(1) {
            return Err(format!("This harness does not advertise a {label} mode, and its own mode ({current}) approves more than {label} allows."));
        }
        self.plan_fallback = chosen == 0;
        self.mode_note = match chosen {
            0 => Some(format!("This harness has no Plan mode; it runs in its {current} mode, and PandaCode asks for a plan and declines changes.")),
            1 => None,
            _ => Some(format!("This harness has no {label} mode; it runs in its {current} mode.")),
        };
        Ok(())
    }
    /// Devin, Cursor and Antigravity keep each setting on the session, so a run
    /// skips the round trip for any value it already has.
    fn unchanged(&self, option: &Value, value: &str) -> bool {
        matches!(self.config.provider.as_str(), "devin" | "cursor" | "antigravity")
            && option["currentValue"] == value
    }
    /// Devin's permission requests carry only the tool call ID and options, and
    /// several allow options grant standing access, so the generic path (which
    /// treats more than one allow as a question) does not apply.
    fn devin_permission(&mut self, value: Value, mut step: Step) -> Result<Step, String> {
        let plan_exit = super::devin::is_plan_exit(&value);
        let one_allow = value["params"]["options"].as_array().is_some_and(|options| options.iter().any(|option| option["optionId"] == "allow_once"));
        if self.config.mode == "full" && one_allow && !plan_exit {
            step.write.push(super::devin::decision(&value, true));
            return Ok(step);
        }
        let tool = self.tools.get(field(&value["params"]["toolCall"], "toolCallId"));
        let label = super::devin::approval_label(&value, tool);
        self.approval(value, label, &mut step);
        Ok(step)
    }
    fn acp_copilot_permissions(&mut self, step: &mut Step) -> Result<(), String> {
        let option = options(&self.acp_config, "allow_all")
            .ok_or("GitHub Copilot CLI does not advertise the Allow All setting required for PandaCode permissions. Update Copilot CLI, then retry.")?;
        let wanted = if self.config.mode == "full" {
            "on"
        } else {
            "off"
        };
        step.write
            .push(choice_request(&self.remote_id, 8, option, wanted)?);
        Ok(())
    }
    fn acp_model(&mut self, step: &mut Step) -> Result<(), String> {
        if self.config.provider == "devin" && !self.image_blocks.is_empty() && super::devin::rejects_images(&self.acp_config, &self.config.model) {
            return Err("This Devin model does not accept images. Choose another model, or remove the images and describe them.".into());
        }
        if self.config.model.is_empty() || self.config.model == "default" {
            return self.acp_effort(step);
        }
        if let Some(option) = options(&self.acp_config, "model") {
            if self.unchanged(option, &self.config.model) {
                return self.acp_effort(step);
            }
            step.write.push(choice_request(
                &self.remote_id,
                5,
                option,
                &self.config.model,
            )?);
        } else {
            // Legacy ACP servers expose availableModels + session/set_model.
            if !self.acp_config["models"]["availableModels"]
                .as_array()
                .is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| model["modelId"] == self.config.model)
                })
            {
                if self.config.provider == "grok" {
                    // A resumed Grok session may not re-advertise options; the
                    // launch flags already selected the model.
                    return self.acp_effort(step);
                }
                return Err(
                    "This harness does not advertise the selected model. Refresh the model list."
                        .into(),
                );
            }
            step.write.push(json!({"jsonrpc":"2.0","id":5,"method":"session/set_model","params":{"sessionId":self.remote_id,"modelId":self.config.model}}));
        }
        Ok(())
    }
    /// OpenCode can open a session before the model's upstream provider
    /// rejects the prompt for missing credentials (#391).
    fn opencode_prompt_auth_error(&self) -> Option<String> {
        let model_option = options(&self.acp_config, "model");
        // An explicit choice was acknowledged before prompting. For Default,
        // use the concrete model OpenCode reported for this session.
        let model = [
            Some(self.config.model.as_str()),
            model_option.and_then(|option| option["currentValue"].as_str()),
            self.acp_config["models"]["currentModelId"].as_str(),
        ]
        .into_iter()
        .flatten()
        .find(|id| *id != "default" && !id.trim().is_empty() && valid_model_id(id))?;
        let credentials = match model.split_once('/') {
            Some((provider, _)) if !provider.is_empty() => format!("Add {provider} credentials"),
            _ => "Add its provider's credentials".to_owned(),
        };
        let free_model = model_option
            .into_iter()
            .flat_map(choices)
            .filter_map(|entry| entry["value"].as_str())
            .find(|id| id.starts_with("opencode/") && id.ends_with("-free") && valid_model_id(id));
        let free_hint = free_model.map_or_else(
            || " OpenCode's free models need no key.".to_owned(),
            |id| format!(" OpenCode's free models need no key, for example \"{id}\"."),
        );
        Some(format!(
            "{} cannot use the selected model \"{model}\": {credentials} or choose another model.{free_hint}",
            self.config.provider
        ))
    }

    fn acp_effort(&mut self, step: &mut Step) -> Result<(), String> {
        if let Some(effort) = &self.config.reasoning_effort {
            let option = if self.config.provider == "cursor" {
                super::cursor::effort_option(&self.acp_config, Some(effort))
            } else {
                options(&self.acp_config, "thought_level").or_else(|| options(&self.acp_config, "effort"))
            };
            match option {
                Some(option) if self.unchanged(option, effort) => self.kimi_prompt(step),
                Some(option) => step
                    .write
                    .push(choice_request(&self.remote_id, 6, option, effort)?),
                // Grok and Cline take the effort as a launch flag.
                None if matches!(self.config.provider.as_str(), "grok" | "cline") => self.kimi_prompt(step),
                None => return Err(format!("This model {NO_ADJUSTABLE_EFFORT}. Choose harness settings.")),
            }
        } else {
            self.kimi_prompt(step);
        }
        Ok(())
    }
}

/// Grok Build lists its models, context sizes and reasoning efforts in the
/// `initialize` result, so discovery never has to create a session.
pub(super) async fn grok_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = super::provider_command("grok", path)?;
    command.args(["--no-auto-update", "agent", "stdio"]);
    let capabilities = handshake(command, &std::env::temp_dir()).await?;
    let models = parse_grok_models(&capabilities["_meta"]["modelState"]);
    if models.len() > 1 {
        return Ok(models);
    }
    let mut command = super::provider_command("grok", path)?;
    command.args(["--no-auto-update", "agent", "stdio"]);
    let (metadata, _) = inspect_with(command, &std::env::temp_dir(), false, true).await?;
    Ok(parse_models_for("grok", &metadata))
}

pub(super) fn parse_grok_models(state: &Value) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo::default_choice()];
    for entry in state["availableModels"].as_array().into_iter().flatten().take(MODEL_CATALOG_LIMIT) {
        let id = field(entry, "modelId");
        if !valid_model_id(id) {
            continue;
        }
        let meta = &entry["_meta"];
        let mut efforts: Vec<ReasoningEffortInfo> = meta["reasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .take(16)
            .filter_map(|choice| {
                let id = choice["id"].as_str().or_else(|| choice["value"].as_str())?;
                super::validate_reasoning_effort("grok", Some(id)).ok()?;
                Some(ReasoningEffortInfo {
                    id: id.into(),
                    name: model_text(choice["label"].as_str().or_else(|| choice["name"].as_str()), id, 80),
                    description: model_text(choice["description"].as_str(), "", 500),
                })
            })
            .collect();
        // Grok lists efforts strongest first; the slider reads least to most, like the other harnesses.
        let rank = |id: &str| ["low", "medium", "high", "xhigh"].iter().position(|known| *known == id).unwrap_or(usize::MAX);
        efforts.sort_by_key(|effort| rank(&effort.id));
        let default_effort = meta["reasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|choice| choice["default"] == true)
            .and_then(|choice| choice["id"].as_str().or_else(|| choice["value"].as_str()))
            .or_else(|| meta["reasoningEffort"].as_str())
            .filter(|id| efforts.iter().any(|effort| effort.id == *id))
            .map(str::to_owned);
        models.push(ModelInfo {
            speed_tiers: Vec::new(),
            id: id.into(),
            name: model_text(entry["name"].as_str(), id, 160),
            description: model_text(entry["description"].as_str(), "", 500),
            reasoning_efforts: efforts,
            default_reasoning_effort: default_effort,
            context_window: meta["totalContextTokens"].as_u64().filter(|value| *value > 0 && *value <= 1_000_000_000),
        });
    }
    models
}

/// Send `initialize` alone and return its result; the process is then stopped.
pub(crate) async fn handshake(command: Command, cwd: &Path) -> Result<Value, String> {
    let mut pipe = Pipe::spawn(command, cwd, DISCOVERY_STARTUP)
        .map_err(|_| "Could not start ACP metadata discovery")?;
    let result = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})).await.map_err(|_| transport_error(&pipe, "initialize"))?;
        loop {
            let frame = pipe.read().await.map_err(|_| transport_error(&pipe, "initialize"))?;
            if frame.get("method").is_some() && frame.get("id").is_some() {
                pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await.map_err(|_| transport_error(&pipe, "initialize"))?;
            } else if frame["id"] == 1 {
                if frame.get("error").is_some() { return Err(rpc_error(&frame, "initialize")); }
                if frame["result"]["protocolVersion"] != 1 { return Err("This harness does not support ACP protocol v1.".into()); }
                return Ok(frame["result"].clone());
            }
        }
    }.await;
    pipe.finish().await;
    result.map_err(|error| super::diagnostics::failure(&error, pipe.diagnostic()))
}

/// Private empty working directory for ACP metadata discovery so servers never
/// scan or write into the shared system temp folder; removed on drop.
struct ScratchDir(PathBuf);
impl ScratchDir {
    fn new(prefix: &str) -> Result<Self, String> {
        let parent = crate::secret_store::dir()
            .ok_or("Could not create ACP scratch directory: secret store is not ready")?
            .join(super::AGENT_TEMP_DIR);
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder
            .create(&parent)
            .map_err(|e| format!("Could not create ACP scratch directory: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("Could not create ACP scratch directory: {e}"))?;
        }
        super::AgentTemp::sweep_once(&parent);
        let dir = parent.join(format!("pandacode-{prefix}-{}", uuid::Uuid::new_v4()));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut child = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut child, 0o700);
        child
            .create(&dir)
            .map_err(|e| format!("Could not create ACP scratch directory: {e}"))?;
        Ok(Self(dir))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for ScratchDir {
    fn drop(&mut self) {
        let dir = std::mem::take(&mut self.0);
        if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
            return;
        }
        // Windows holds a killed process's files for a moment. Off the async workers.
        std::thread::spawn(move || {
            for _ in 0..5 {
                std::thread::sleep(Duration::from_secs(1));
                if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
                    return;
                }
            }
        });
    }
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = super::acp_catalog::get("antigravity", path) { return Ok(models); }
    let _refresh = super::acp_catalog::refresh_lock("antigravity", path).await;
    if let Some(models) = super::acp_catalog::get("antigravity", path) { return Ok(models); }
    let discovery = super::acp_catalog::begin("antigravity", path);
    let mut command = super::provider_command("antigravity", path)?;
    antigravity_args(&mut command);
    let _temp = super::AgentTemp::redirect(&mut command);
    let scratch = ScratchDir::new("acp-models")?;
    let (metadata, _) = inspect_antigravity(command, scratch.path(), false).await?;
    super::acp_catalog::store(discovery, &metadata);
    Ok(parse_models_for("antigravity", &metadata))
}
/// The Antigravity model list; only tests call it directly, discovery goes through `parse_models_for`.
#[cfg(test)]
pub(crate) fn parse_models(metadata: &Value) -> Vec<ModelInfo> {
    parse_models_for("antigravity", metadata)
}

pub(crate) fn parse_models_for(provider: &str, metadata: &Value) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo::default_choice()];
    let has_model_option = options(metadata, "model").is_some();
    if let Some(option) = options(metadata, "model") {
        for choice in choices(option) {
            let id = field(choice, "value");
            if !valid_model_id(id) {
                continue;
            }
            models.push(ModelInfo {
                speed_tiers: Vec::new(),
                id: id.into(),
                name: model_text(choice["name"].as_str(), id, 160),
                description: model_text(choice["description"].as_str(), "", 500),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                context_window: None,
            });
        }
    } else if let Some(available) = metadata["models"]["availableModels"].as_array() {
        for entry in available.iter().take(MODEL_CATALOG_LIMIT) {
            let id = field(entry, "modelId");
            if !valid_model_id(id) {
                continue;
            }
            models.push(ModelInfo {
                speed_tiers: Vec::new(),
                id: id.into(),
                name: model_text(entry["name"].as_str(), id, 160),
                description: model_text(entry["description"].as_str(), "", 500),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                context_window: None,
            });
        }
    }
    // dsh shares its effort option across models. Other ACP harnesses report
    // choices for the current model only.
    let current = options(metadata, "model")
        .map(|option| field(option, "currentValue"))
        .unwrap_or_else(|| field(&metadata["models"], "currentModelId"));
    let effort_option = options(metadata, "thought_level").or_else(|| options(metadata, "effort"));
    let mut advertised_effort_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    if let Some(effort) = effort_option {
        for choice in choices(effort) {
            let id = field(choice, "value");
            if super::validate_reasoning_effort(provider, Some(id)).is_ok() {
                let name = choice["name"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| model_text(Some(name), id, 80));
                let description = choice["description"]
                    .as_str()
                    .filter(|desc| !desc.trim().is_empty())
                    .map(|desc| model_text(Some(desc), "", 500));
                advertised_effort_meta.insert(id.into(), (name, description));
            }
        }
        for model in models.iter_mut().filter(|model| {
            model.id == current || (provider == "deepseek" && model.id != "default")
        }) {
            model.reasoning_efforts = choices(effort)
                .into_iter()
                .filter_map(|choice| {
                    let id = field(choice, "value");
                    super::validate_reasoning_effort(provider, Some(id)).ok()?;
                    let mut info = effort_info(id, choice["description"].as_str());
                    if let Some(name) = choice["name"].as_str().filter(|name| !name.trim().is_empty()) {
                        info.name = model_text(Some(name), &info.name, 80);
                    }
                    Some(info)
                })
                .collect();
            model.default_reasoning_effort = effort["currentValue"]
                .as_str()
                .filter(|id| {
                    model
                        .reasoning_efforts
                        .iter()
                        .any(|effort| effort.id == *id)
                })
                .map(str::to_owned);
        }
    }
    // Antigravity advertises base models in `configOptions["model"]` and full
    // `{base_id}-{level}` variants in `models.availableModels`. Keep the current
    // model's `thought_level` authoritative, and derive efforts for every other
    // base model from matching variant suffixes.
    if provider == "antigravity" && has_model_option {
        if let Some(available) = metadata["models"]["availableModels"].as_array() {
            let base_ids: HashSet<String> = models
                .iter()
                .filter(|model| model.id != "default")
                .map(|model| model.id.clone())
                .collect();
            let available_ids: HashSet<&str> = available
                .iter()
                .take(MODEL_CATALOG_LIMIT)
                .filter_map(|entry| entry["modelId"].as_str())
                .collect();
            const LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
            for model in models.iter_mut().filter(|model| {
                model.id != "default"
                    && model.reasoning_efforts.is_empty()
                    && !(effort_option.is_some() && model.id == current)
            }) {
                let mut derived = Vec::new();
                for level in LEVELS {
                    let variant = format!("{}-{level}", model.id);
                    if available_ids.contains(variant.as_str())
                        && !base_ids.contains(variant.as_str())
                        && super::validate_reasoning_effort("antigravity", Some(level)).is_ok()
                    {
                        let meta = advertised_effort_meta.get(level);
                        let mut info = effort_info(level, meta.and_then(|(_, desc)| desc.as_deref()));
                        if let Some(name) = meta.and_then(|(name, _)| name.as_deref()) {
                            info.name = name.to_owned();
                        }
                        derived.push(info);
                    }
                }
                if !derived.is_empty() {
                    model.default_reasoning_effort = if derived.iter().any(|e| e.id == "high") {
                        Some("high".into())
                    } else if derived.iter().any(|e| e.id == "medium") {
                        Some("medium".into())
                    } else {
                        derived.first().map(|e| e.id.clone())
                    };
                    model.reasoning_efforts = derived;
                }
            }
        }
    }
    models
}

pub(crate) async fn inspect(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
) -> Result<(Value, Option<Value>), String> {
    inspect_with(command, cwd, wait_commands, false).await
}

/// `authenticate` runs between `initialize` and `session/new` when the server
/// advertises cached credentials (Grok Build refuses sessions without it).
pub(crate) async fn inspect_with(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
    authenticate: bool,
) -> Result<(Value, Option<Value>), String> {
    inspect_state(command, cwd, wait_commands, authenticate, false, DISCOVERY_STARTUP, COMMAND_GRACE)
        .await.map_err(|failure| failure.message)
}

/// Antigravity discovery, whichever executable starts it (the `agy` CLI or the
/// standalone server): a -32000 quota, credit or 429 error is a limit, not a sign-in.
pub(crate) async fn inspect_antigravity(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
) -> Result<(Value, Option<Value>), String> {
    inspect_state(command, cwd, wait_commands, false, true, DISCOVERY_STARTUP, COMMAND_GRACE)
        .await.map_err(|failure| failure.message)
}

#[derive(Debug)]
struct DiscoveryFailure {
    acp_ready: bool,
    authentication_required: bool,
    message: String,
}

/// `antigravity` comes from the caller that knows the harness; the program name
/// does not tell the `agy` CLI from the standalone server.
async fn inspect_state(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
    authenticate: bool,
    antigravity: bool,
    startup_timeout: Duration,
    command_grace: Duration,
) -> Result<(Value, Option<Value>), DiscoveryFailure> {
    if is_agy_cli(Path::new(command.as_std().get_program())) {
        super::antigravity_spawn_gate().await;
    }
    let mut pipe = Pipe::spawn(command, cwd, startup_timeout)
        .map_err(|_| DiscoveryFailure { acp_ready: false, authentication_required: false, message: "Could not start ACP metadata discovery. Check the selected executable.".into() })?;
    let mut acp_ready = false;
    let mut authentication_required = false;
    let mut can_close = false;
    let mut session_id: Option<String> = None;
    let mut stage = "initialize";
    let result: Result<(Value, Option<Value>), String> = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})).await.map_err(|_| transport_error(&pipe, stage))?;
        let mut metadata = None;
        let mut commands = None;
        let session = json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":launch::external_path(cwd),"mcpServers":[]}});
        loop {
            let frame = match pipe.read().await {
                Ok(frame) => frame,
                // A command notification is optional. Once session creation
                // succeeded, neither silence nor exit can erase its models.
                Err(()) if metadata.is_some() => return Ok((metadata.unwrap(), commands)),
                Err(()) => return Err(transport_error(&pipe, stage)),
            };
            if frame.get("method").is_some() && frame.get("id").is_some() {
                pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await.map_err(|_| transport_error(&pipe, stage))?;
            } else if matches!(frame["id"].as_u64(), Some(1 | 2 | 7)) && frame.get("error").is_some() {
                let error = rpc_error(&frame, stage);
                // Antigravity answers -32000 for an exhausted quota or a 429 as
                // well as for sign-in: only the latter asks for a login.
                if antigravity && super::limits::antigravity_rpc_limited(&frame, super::limits::now_epoch_ms()).is_some() {
                    return Err(format!("The Antigravity account has reached its quota, is out of credits or is rate limited. Wait for the quota to reset or add credits, then check again.\n{error}"));
                }
                // Its context window is a per-conversation limit: the server's own error, not a login.
                let context_window = antigravity && frame["error"]["code"] == -32000 && antigravity_context_error(&frame);
                authentication_required = !context_window && (frame["error"]["code"] == -32000 || frame["id"] == 7);
                return Err(if authentication_required {
                    format!("Authentication is required by the ACP server. Sign in using its CLI (such as `agy acp --login`) or official extension, then check again.\n{error}")
                } else { error });
            } else if frame["id"] == 1 {
                if frame["result"]["protocolVersion"] != 1 { return Err("This harness does not support ACP protocol v1.".into()); }
                acp_ready = true;
                can_close = session_capability(&frame["result"]["agentCapabilities"], "close");
                match cached_auth_method(&frame["result"]).filter(|_| authenticate) {
                    Some(method) => {
                        stage = "authenticate";
                        pipe.send(&json!({"jsonrpc":"2.0","id":7,"method":"authenticate","params":{"methodId":method}})).await.map_err(|_| transport_error(&pipe, stage))?;
                    }
                    None => {
                        stage = "session/new";
                        pipe.send(&session).await.map_err(|_| transport_error(&pipe, stage))?;
                    }
                }
            } else if frame["id"] == 7 {
                stage = "session/new";
                pipe.send(&session).await.map_err(|_| transport_error(&pipe, stage))?;
            } else if frame["id"] == 2 {
                let Some(id) = frame["result"]["sessionId"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                else {
                    return Err("ACP session/new did not return a valid session ID.".into());
                };
                session_id = Some(id.to_owned());
                metadata = Some(frame["result"].clone());
                pipe.set_deadline_after(command_grace);
            } else if frame["method"] == "session/update" && frame["params"]["update"]["sessionUpdate"] == "available_commands_update" {
                commands = Some(frame);
            }
            if let Some(metadata) = &metadata {
                if commands.as_ref().is_some_and(|frame| frame["params"]["sessionId"] != metadata["sessionId"]) { commands = None; }
                if !wait_commands || commands.is_some() { return Ok((metadata.clone(),commands)); }
            }
        }
    }.await;
    if can_close {
        if let Some(id) = session_id {
            pipe.set_deadline_after(Duration::from_secs(2));
            if pipe
                .send(&json!({"jsonrpc":"2.0","id":9,"method":"session/close","params":{"sessionId":id}}))
                .await
                .is_ok()
            {
                for _ in 0..64 {
                    match pipe.read().await {
                        Ok(frame) if frame.get("method").is_some() && frame.get("id").is_some() => {
                            if pipe
                                .send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}}))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(frame) if frame["id"] == 9 && frame.get("method").is_none() => break,
                        Ok(_) => continue,
                        Err(()) => break,
                    }
                }
            }
        }
    }
    pipe.finish().await;
    result.map_err(|error| DiscoveryFailure {
        acp_ready,
        authentication_required,
        message: super::diagnostics::failure(&error, pipe.diagnostic()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    installed: bool,
    acp_ready: bool,
    session_ready: bool,
    state: &'static str,
    message: String,
}

/// The readiness check's wording when the server advertises no `default` mode.
const ANTIGRAVITY_CHECK_MODE_UNADVERTISED: &str = "This Antigravity server does not advertise the default approval mode, so tasks will not start; they would run in agy's own default mode. Run `agy update` in a terminal outside PandaCode (or use its official installer), or select the agy CLI instead of the standalone ACP server, then retry.";

/// Whether the server offers the `default` mode: Standard requires it, and Accept
/// edits and Full access fall back to it, so without it tasks refuse to start.
fn antigravity_advertises_mode(metadata: &Value) -> bool {
    let known = |id: &Value| id.as_str() == Some("default");
    let config_choice = options(metadata, "mode")
        .is_some_and(|option| choices(option).into_iter().any(|choice| known(&choice["value"])));
    let session_mode = metadata["modes"]["availableModes"]
        .as_array()
        .is_some_and(|modes| modes.iter().any(|mode| known(&mode["id"])));
    config_choice || session_mode
}

fn connection_status(result: Result<(Value, Option<Value>), DiscoveryFailure>) -> ConnectionStatus {
    match result {
        Ok((metadata, _)) if !antigravity_advertises_mode(&metadata) => ConnectionStatus { installed: true, acp_ready: true, session_ready: false, state: "sessionFailed", message: ANTIGRAVITY_CHECK_MODE_UNADVERTISED.into() },
        Ok(_) => ConnectionStatus { installed: true, acp_ready: true, session_ready: true, state: "ready", message: "Antigravity ACP initialized and opened a session. No prompt was sent; model access and quota are checked when you send. A named connection is checked when a task that uses it runs.".into() },
        Err(failure) => ConnectionStatus { installed: true, acp_ready: failure.acp_ready, session_ready: false,
            state: if failure.authentication_required { "authenticationRequired" } else if failure.acp_ready { "sessionFailed" } else { "startupFailed" },
            message: failure.message },
    }
}

/// Explicit Settings check. Never authenticates, sends a prompt, or accepts an
/// agent request. The official ACP server owns its sign-in; finding its binary
/// alone does not establish that its account can open a session.
#[tauri::command]
pub async fn provider_check_connection(provider: String) -> Result<ConnectionStatus, String> {
    if provider != "antigravity" { return Err("Connection checks are supported for Antigravity ACP.".into()); }
    let Some(path) = super::executable(&provider).filter(|path| path.is_file()) else {
        return Ok(ConnectionStatus { installed: false, acp_ready: false, session_ready: false, state: "missing", message: "Install the agy CLI or select the official Antigravity ACP server executable.".into() });
    };
    let command = match super::provider_command(&provider, &path) {
        Ok(command) => command,
        Err(message) => return Ok(connection_status(Err(DiscoveryFailure { acp_ready: false, authentication_required: false, message }))),
    };
    let mut command = command;
    antigravity_args(&mut command);
    let discovery = super::acp_catalog::begin("antigravity", &path);
    let _temp = super::AgentTemp::redirect(&mut command);
    let scratch = match ScratchDir::new("acp-check") {
        Ok(dir) => dir,
        Err(message) => {
            return Ok(connection_status(Err(DiscoveryFailure {
                acp_ready: false,
                authentication_required: false,
                message,
            })));
        }
    };
    let result = inspect_state(command, scratch.path(), false, false, true, DISCOVERY_STARTUP, COMMAND_GRACE).await;
    if let Ok((metadata, _)) = &result { super::acp_catalog::store(discovery, metadata); }
    Ok(connection_status(result))
}

const MAX_STEERS: usize = 16;
/// Request ids for live steering prompts, clear of startup (1-7), cancel (900) and goals (10000+).
const STEER_IDS: std::ops::Range<u64> = 2000..9000;

/// Steering for ACP runs. OpenCode and Devin fold a second `session/prompt` into the
/// running loop at its next step (both requests answer at turn end), so they steer live.
/// Kimi rejects a busy prompt and Grok only queues one natively as a later turn,
/// so for every other agent the text waits here and goes out as the next
/// `session/prompt` on the same session when the current one ends.
#[derive(Default)]
pub(super) struct Steers {
    held: Vec<(String, String)>,
    live: Vec<(u64, String, String)>,
    next: u64,
    /// The opening prompt answered while live steers were still outstanding.
    turn_over: bool,
}

impl Steers {
    /// True when `id` is a live steer request still waiting for a reply.
    pub(super) fn has_live(&self, id: u64) -> bool {
        self.live.iter().any(|(live_id, _, _)| *live_id == id)
    }
}

impl Protocol {
    pub(super) fn steer_event(&self, id: &str, text: &str, status: &str, mode: &str) -> AgentEvent {
        // `event()` keeps only generic metadata keys; a steer needs its mode too.
        let mut event = self.event("steer", text, None);
        event.data = Some(json!({"id":id,"status":status,"mode":mode}));
        event
    }

    pub(super) fn acp_steer(&mut self, id: String, text: String, reply: super::goals::RpcReply) -> Step {
        let mut step = Step::default();
        let text = text.trim().to_owned();
        if text.is_empty() || text.len() > crate::MESSAGE_LIMIT {
            let _ = reply.send(Err("Write a steering message under 16 MiB.".into()));
            return step;
        }
        let steers = &mut self.acp_steers;
        if steers.held.len() + steers.live.len() >= MAX_STEERS {
            let _ = reply.send(Err("Too many steering messages are waiting; the message stays queued.".into()));
            return step;
        }
        let live = matches!(self.config.provider.as_str(), "opencode" | "devin") && self.phase == 1 && !steers.turn_over && !self.remote_id.is_empty();
        let mode = if live { "live" } else { "next-turn" };
        step.events.push(self.steer_event(&id, &text, "pending", mode));
        if live {
            let steers = &mut self.acp_steers;
            let request = STEER_IDS.start + steers.next % (STEER_IDS.end - STEER_IDS.start);
            steers.next += 1;
            step.write.push(json!({"jsonrpc":"2.0","id":request,"method":"session/prompt","params":{"sessionId":self.remote_id,"prompt":[{"type":"text","text":text}]}}));
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
            self.acp_steers.live.push((request, id.clone(), text));
        } else {
            self.acp_steers.held.push((id.clone(), text));
        }
        let _ = reply.send(Ok(json!({"steered":true,"id":id,"mode":mode})));
        step
    }

    /// Steers that will never reach the agent (stop, error, process exit).
    pub(super) fn acp_steers_failed(&mut self) -> Step {
        let mut step = Step::default();
        for (id, text) in std::mem::take(&mut self.acp_steers.held) {
            step.events.push(self.steer_event(&id, &text, "failed", "next-turn"));
        }
        self.acp_steers.live.clear();
        step
    }

    /// The running `session/prompt` answered: send held steers as the next turn, or finish.
    fn acp_turn_end(&mut self, result: &Value, step: &mut Step) -> Result<(), String> {
        if result["stopReason"] == "cancelled" {
            let mut failed = self.acp_steers_failed();
            step.events.append(&mut failed.events);
            step.done = true;
            return Ok(());
        }
        if self.config.provider == "antigravity" {
            if let Some(soft) = super::limits::antigravity_soft_error(
                &self.acp_turn_text,
                super::limits::now_epoch_ms(),
            ) {
                let mut failed = self.acp_steers_failed();
                step.events.append(&mut failed.events);
                if soft.limited {
                    step.events.push(self.limited_event(soft.resets_at, None));
                    step.failure = Some(soft.message);
                    return Ok(());
                }
                if !step.events.is_empty() {
                    step.failure = Some(soft.message);
                    return Ok(());
                }
                return Err(soft.message);
            }
        }
        if !self.acp_steers.live.is_empty() {
            self.acp_steers.turn_over = true;
            return Ok(());
        }
        self.acp_steers.turn_over = false;
        let held = std::mem::take(&mut self.acp_steers.held);
        if held.is_empty() {
            step.done = true;
            return Ok(());
        }
        self.config.prompt = held.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n\n");
        self.kimi_prompt(step);
        for (id, text) in held {
            step.events.push(self.steer_event(&id, &text, "delivered", "next-turn"));
        }
        Ok(())
    }

    /// Kimi's ACP frames, with its turn end routed through held steers.
    pub(super) fn kimi_steered(&mut self, value: Value) -> Result<Step, String> {
        let result = (value["id"] == 3).then(|| value["result"].clone()).filter(|result| !result.is_null());
        let mut step = self.kimi(value)?;
        if let Some(result) = result.filter(|_| step.done) {
            step.done = false;
            self.acp_turn_end(&result, &mut step)?;
        }
        Ok(step)
    }

    /// A live steer request answered. Returns false when the id is not one.
    fn acp_live_answered(&mut self, value: &Value, step: &mut Step) -> Result<bool, String> {
        let Some(index) = value["id"].as_u64().and_then(|id| self.acp_steers.live.iter().position(|(request, ..)| *request == id)) else {
            return Ok(false);
        };
        let (_, id, text) = self.acp_steers.live.remove(index);
        if value.get("error").is_some() {
            // Refused mid-turn: carry it into the next turn instead of failing the run.
            self.acp_steers.held.push((id, text));
        }
        if self.acp_steers.turn_over && self.acp_steers.live.is_empty() {
            self.acp_turn_end(&value["result"], step)?;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn antigravity_args_give_acp_only_to_the_agy_cli() {
        let args = |program: &str| {
            let mut command = tokio::process::Command::new(program);
            super::antigravity_args(&mut command);
            let args = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
            let disable_update = command.as_std().get_envs().find(|(k, _)| *k == "AGY_CLI_DISABLE_AUTO_UPDATE").and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
            (args, disable_update)
        };
        for telemetry_off in [false, true] {
            super::super::privacy::FORCE.with(|force| force.set(Some(telemetry_off)));
            let mut expected_agy = vec!["acp".to_owned(), "--process-per-session".to_owned()];
            if telemetry_off {
                expected_agy.push("--disable-telemetry".to_owned());
            }
            if let Some(home) = crate::agent_usage_providers::home().filter(|p| p.is_absolute()) {
                expected_agy.push("--gemini-dir".to_owned());
                expected_agy.push(home.join(".gemini").to_string_lossy().into_owned());
            }
            let mut agy = vec!["agy", "agy.exe", "AGY.EXE", "/usr/local/bin/agy", "/custom/dir/agy"];
            if cfg!(windows) {
                agy.push(r"C:\Program Files\Antigravity\agy.exe");
            }
            for program in agy {
                let (got, env) = args(program);
                assert_eq!(got, expected_agy, "{program} (telemetry_off={telemetry_off})");
                assert_eq!(env.as_deref(), Some("true"), "{program}");
                assert!(!got.iter().any(|a| a == "--dangerously-skip-permissions"), "discovery args stay clean");
            }
            let server: &[&str] = if cfg!(target_os = "linux") { &["--uid="] } else { &[] };
            for program in ["agy_acp_server.par", "agy_acp_server.exe", "/opt/agy_acp_server.par", "/opt/agy/server", "agy-wrapper"] {
                let (got, env) = args(program);
                assert_eq!(got, server, "{program}");
                assert_eq!(env, None, "{program}");
            }
        }
        super::super::privacy::FORCE.with(|force| force.set(None));
    }

    #[test]
    fn antigravity_gemini_dir_respects_command_home_and_overrides() {
        let custom_home = if cfg!(windows) { r"C:\custom-home" } else { "/custom/conn-home" };
        let fallback_home = if cfg!(windows) { r"C:\fallback-home" } else { "/fallback/home" };
        let chosen = if cfg!(windows) { r"C:\chosen\gemini" } else { "/chosen/gemini" };
        let custom = PathBuf::from(custom_home).join(".gemini").to_string_lossy().into_owned();
        let fallback = PathBuf::from(fallback_home).join(".gemini").to_string_lossy().into_owned();
        let arg_list = |command: &tokio::process::Command| {
            command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let gemini_arg = |command: &tokio::process::Command| {
            let args = arg_list(command);
            args.iter().position(|a| a == "--gemini-dir").map(|pos| args[pos + 1].clone())
        };
        let host_blocked = |command: &tokio::process::Command| {
            command
                .as_std()
                .get_envs()
                .any(|(k, v)| k == "GEMINI_DIR" && v.is_none())
        };

        // No GEMINI_DIR anywhere: the command `HOME` (such as a named connection's) pins
        // `--gemini-dir`, and an inherited host GEMINI_DIR is never passed on.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("HOME", custom_home);
        super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
        assert_eq!(gemini_arg(&command), Some(custom.clone()));
        assert!(host_blocked(&command), "Named Connection HOME must keep the host GEMINI_DIR out");

        // Without a command `HOME`/`USERPROFILE`, the process home's `.gemini` is pinned:
        // a host GEMINI_DIR does not suppress it, since agy reads no variable.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
        assert_eq!(gemini_arg(&command), Some(fallback.clone()));
        assert!(host_blocked(&command));

        // A `GEMINI_DIR` (any letter case) or `ANTIGRAVITY_GEMINI_DIR` on the command, from a
        // named connection or the provider environment, is the directory the user chose: agy
        // reads no variable, so it is passed as `--gemini-dir` and removed.
        for key in ["GEMINI_DIR", "gemini_dir", "ANTIGRAVITY_GEMINI_DIR"] {
            let mut command = tokio::process::Command::new("/usr/local/bin/agy");
            command.env("HOME", custom_home);
            command.env(key, chosen);
            super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
            assert_eq!(gemini_arg(&command), Some(chosen.to_owned()), "{key}");
            assert_eq!(arg_list(&command).iter().filter(|arg| arg.starts_with("--gemini")).count(), 1, "{key}");
            assert!(
                command.as_std().get_envs().all(|(name, value)| name != key || value.is_none()),
                "{key} must be removed"
            );
        }

        // Case-insensitive `home` / `userprofile` matching on `command`.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("home", custom_home);
        super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
        assert_eq!(gemini_arg(&command), Some(custom.clone()));

        // Relative `HOME` falls back to absolute `USERPROFILE` rather than dropping `--gemini-dir`.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("HOME", "relative/home");
        command.env("userprofile", custom_home);
        super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
        assert_eq!(gemini_arg(&command), Some(custom.clone()));

        // Relative `HOME` with no `USERPROFILE` falls back to absolute process home.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("HOME", "relative/home");
        super::antigravity_gemini_dir_with(&mut command, Some(PathBuf::from(fallback_home)), false, false, None);
        assert_eq!(gemini_arg(&command), Some(fallback.clone()));

        // Existing `--gemini-dir` or `--gemini_dir` arg suppresses adding a second one and
        // wins over a GEMINI_DIR variable, which is still removed.
        for existing in [
            vec!["--gemini-dir", "/explicit/gemini"],
            vec!["--gemini-dir=/explicit/gemini"],
            vec!["--gemini_dir", "/explicit/gemini"],
            vec!["--gemini_dir=/explicit/gemini"],
        ] {
            let mut command = tokio::process::Command::new("/usr/local/bin/agy");
            command.args(&existing).env("GEMINI_DIR", chosen);
            super::antigravity_gemini_dir(&mut command);
            let count = arg_list(&command)
                .iter()
                .filter(|arg| arg.starts_with("--gemini-dir") || arg.starts_with("--gemini_dir"))
                .count();
            assert_eq!(count, 1, "existing={existing:?}");
            assert!(host_blocked(&command), "existing={existing:?}");
        }
    }

    #[test]
    fn antigravity_named_connection_relative_paths_fail_before_launch() {
        let custom_home = if cfg!(windows) { r"C:\conn-home" } else { "/conn-home" };
        // agy resolves a relative path against the project folder, which would put the
        // Gemini directory (settings, conversation store, credentials) inside it.
        for (key, value) in [
            ("HOME", "relative/home"),
            ("userprofile", "relative/profile"),
            ("GEMINI_DIR", "relative/gemini"),
            ("antigravity_gemini_dir", "relative/gemini"),
        ] {
            let mut command = tokio::process::Command::new("/usr/local/bin/agy");
            command.env(key, value);
            let err = super::antigravity_gemini_dir_isolated(&mut command, &[("HOME".into(), custom_home.into())], &[])
                .expect_err("a relative path must fail the launch");
            assert_eq!(
                err,
                format!("Antigravity needs an absolute path for {} in this named connection.", key.to_ascii_uppercase()),
                "{key}"
            );
            assert!(command.as_std().get_args().next().is_none(), "a refused launch is not prepared");
        }
        assert!(super::connection_overrides_home(&[("HOME".into(), "relative/home".into())]));

        // The same connection with an absolute HOME launches as before.
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("HOME", custom_home);
        super::antigravity_gemini_dir_isolated(&mut command, &[("HOME".into(), custom_home.into())], &[]).unwrap();
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--gemini-dir".to_owned(), PathBuf::from(custom_home).join(".gemini").to_string_lossy().into_owned()]);
    }

    #[test]
    fn named_connection_gemini_dir_beats_provider_gemini_dir() {
        let shared = if cfg!(windows) { r"C:\shared" } else { "/shared" };
        let isolated = if cfg!(windows) { r"C:\isolated" } else { "/isolated" };
        for key in ["ANTIGRAVITY_GEMINI_DIR", "gemini_dir"] {
            // Merged command env: provider GEMINI_DIR plus the connection's own variable.
            let mut command = tokio::process::Command::new("/usr/local/bin/agy");
            command.env("GEMINI_DIR", shared).env(key, isolated);
            super::antigravity_gemini_dir_isolated(&mut command, &[(key.into(), isolated.into())], &[]).unwrap();
            let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(args, ["--gemini-dir".to_owned(), isolated.to_owned()], "{key}");
        }
        assert_eq!(super::connection_gemini_dir(&[("PATH".into(), "/bin".into())]), None);
        assert_eq!(
            super::connection_gemini_dir(&[("antigravity_gemini_dir".into(), "/b".into()), ("Gemini_Dir".into(), "/a".into())]),
            Some(PathBuf::from("/a"))
        );
    }

    #[test]
    fn named_connection_relative_gemini_dir_args_fail_before_launch() {
        let expected = "Antigravity needs an absolute path for --gemini-dir in this named connection.";
        for args in [
            vec!["--gemini-dir", "rel"],
            vec!["--gemini-dir=rel"],
            vec!["--gemini_dir=rel"],
            vec!["--gemini_dir", "rel"],
            vec!["--gemini-dir"],
            vec!["--gemini-dir=  "],
        ] {
            let mut command = tokio::process::Command::new("/usr/local/bin/agy");
            command.args(&args);
            let owned: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
            let err = super::antigravity_gemini_dir_isolated(&mut command, &[], &owned).expect_err("relative must fail");
            assert_eq!(err, expected, "{args:?}");
            assert_eq!(command.as_std().get_args().count(), args.len(), "a refused launch is not prepared");
        }
        let explicit = if cfg!(windows) { r"C:\abs\path" } else { "/abs/path" };
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.args(["--gemini-dir", explicit]).env("GEMINI_DIR", "/shared");
        super::antigravity_gemini_dir_isolated(
            &mut command,
            &[("ANTIGRAVITY_GEMINI_DIR".into(), "/isolated".into())],
            &["--gemini-dir".into(), explicit.into()],
        )
        .unwrap();
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--gemini-dir".to_owned(), explicit.to_owned()]);
    }

    use super::super::tests::config;
    use super::*;

    #[test]
    fn acp_errors_preserve_structured_cause_without_serializing_opaque_data() {
        let mut p = Protocol::new(config("antigravity"));
        let error = p.receive(json!({"id":2,"error":{"code":-32603,"message":"Internal error","data":{"message":"ValueError: invalid working directory","apiKey":"fixture-secret","stack":"private opaque metadata"}}})).err().unwrap();
        assert!(error.contains("session creation or resume"));
        assert!(error.contains("ValueError: invalid working directory"));
        assert!(!error.contains("fixture-secret"));
        assert!(!error.contains("private opaque metadata"));
    }

    // OpenCode ACP 2.3.2 prompt error from issue #391.
    fn prompt_auth_error(id: u64) -> Value {
        json!({"jsonrpc":"2.0","id":id,"error":{
            "code":-32000,"message":"Authentication required: provider authentication required","data":{}
        }})
    }

    #[test]
    fn opencode_prompt_auth_error_names_the_resolved_default_model() {
        let mut p = Protocol::new(config("opencode"));
        assert_eq!(p.receive(capabilities()).unwrap().write[0]["method"], "session/new");
        // Model selection reported by session/new in the issue recording.
        let session = json!({"sessionId":"ses_fixture","configOptions":[
            {"id":"model","category":"model","type":"select","currentValue":"openai/gpt-6.2-sol","options":[
                {"value":"openai/gpt-6.2-sol","name":"GPT-6.2 Sol"},
                {"value":"opencode/deepseek-v4.1-flash-free","name":"DeepSeek V4.1 Flash Free"}]}
        ]});
        let prompt = p.receive(response(2, session)).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");
        let error = p.receive(prompt_auth_error(3)).err().unwrap();
        assert!(error.contains("cannot use the selected model \"openai/gpt-6.2-sol\""), "{error}");
        assert!(error.contains("Add openai credentials"), "{error}");
        assert!(error.contains("opencode/deepseek-v4.1-flash-free"), "{error}");
        assert!(!error.contains("Sign in using its own CLI"), "{error}");
    }

    #[test]
    fn antigravity_prompt_auth_error_keeps_the_cli_sign_in_hint() {
        let mut p = Protocol::new(config("antigravity"));
        p.receive(capabilities()).unwrap();
        // Antigravity must advertise the task's approval mode before any prompt is sent.
        let session = json!({"sessionId":"remote","modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}});
        let set_mode = p.receive(response(2, session)).unwrap();
        assert_eq!(set_mode.write[0]["method"], "session/set_mode");
        let set_mode_id = set_mode.write[0]["id"].as_u64().unwrap();
        let prompt = p.receive(response(set_mode_id, json!({}))).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");
        assert_eq!(prompt.write[0]["id"], 3);
        // Antigravity keeps its own `agy` sign-in hint (with the server's words), never
        // OpenCode's model-credential message.
        let error = p.receive(prompt_auth_error(3)).err().unwrap();
        assert!(error.starts_with(ANTIGRAVITY_SIGN_IN), "{error}");
        assert!(error.contains("Authentication required"), "{error}");
        assert!(!error.contains("cannot use the selected model"), "{error}");
    }

    #[test]
    fn opencode_pre_prompt_auth_errors_keep_the_cli_sign_in_hint() {
        for id in [1, 2, 5] {
            let mut cfg = config("opencode");
            cfg.model = "vendor/b".into();
            cfg.resume_id = Some("remote".into());
            let mut p = Protocol::new(cfg);
            assert_eq!(p.initial()["method"], "initialize");
            if id >= 2 {
                assert_eq!(p.receive(capabilities()).unwrap().write[0]["method"], "session/load");
            }
            if id == 5 {
                p.receive(response(2, metadata())).unwrap();
                let selection = p.receive(response(4, json!({}))).unwrap();
                assert_eq!(selection.write[0]["id"], 5);
                assert_eq!(selection.write[0]["params"]["configId"], "model");
            }
            assert_eq!(
                p.receive(prompt_auth_error(id)).err().unwrap(),
                "opencode requires authentication. Sign in using its own CLI or official extension, then retry."
            );
        }
    }

    #[cfg(unix)]
    fn fixture(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn metadata_survives_missing_commands_after_slow_startup() {
        assert!(DISCOVERY_STARTUP >= Duration::from_secs(60));
        let command = fixture(r#"
            sleep 0.1
            read -r initialize
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            read -r session
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"fixture","models":{"availableModels":[{"modelId":"model-fixture","name":"Model fixture"}]}}}'
            read -r forbidden
        "#);
        let start = std::time::Instant::now();
        let (metadata, commands) = inspect_state(command, &std::env::temp_dir(), true, false, false, Duration::from_secs(2), Duration::from_millis(20)).await.unwrap();
        assert_eq!(metadata["sessionId"], "fixture");
        assert!(parse_models(&metadata).iter().any(|model| model.id == "model-fixture"));
        assert!(commands.is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_distinguishes_startup_authentication_and_session_failures() {
        for (reply, state, acp_ready) in [
            (r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}"#, "startupFailed", false),
            (r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Login required"}}"#, "authenticationRequired", true),
            (r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Invalid working directory"}}"#, "sessionFailed", true),
            (r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ready","modes":{"availableModes":[{"id":"default"}]}}}"#, "ready", true),
        ] {
            let startup = if acp_ready { "read -r init; printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}';" } else { "" };
            let command = fixture(&format!("{startup} read -r request; printf '%s\\n' '{reply}'; read -r forbidden"));
            let status = connection_status(inspect_state(command, &std::env::temp_dir(), false, false, false, Duration::from_secs(2), Duration::from_millis(20)).await);
            assert_eq!(status.state, state);
            assert!(status.installed);
            assert_eq!(status.acp_ready, acp_ready);
            assert_eq!(status.session_ready, state == "ready");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_reports_timeout_and_stderr_cause_without_credentials() {
        let failure = inspect_state(fixture("read -r init; sleep 2"), &std::env::temp_dir(), false, false, false, Duration::from_millis(20), COMMAND_GRACE).await.unwrap_err();
        assert_eq!(failure.message, ACP_STARTUP_TIMEOUT);
        assert!(!failure.acp_ready);
        let failure = inspect_state(fixture("printf '%s\\n' 'FutureWarning: Python is deprecated' 'Authorization: Bearer fixture-secret' 'ValueError: invalid cwd' >&2; exit 1"), &std::env::temp_dir(), false, false, false, Duration::from_secs(2), COMMAND_GRACE).await.unwrap_err();
        assert!(failure.message.contains("ValueError: invalid cwd"));
        assert!(!failure.message.contains("fixture-secret"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_declines_agent_requests_without_authentication_or_prompts() {
        let command = fixture(r#"
            read -r request
            case "$request" in *'"method":"initialize"'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"oauth-personal"}]}}'
            read -r request
            case "$request" in *'"method":"session/new"'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":90,"method":"fs/write_text_file","params":{"path":"unused","content":"must not write"}}'
            read -r request
            case "$request" in *'"code":-32601'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ready","modes":{"availableModes":[{"id":"default"}]}}}'
            read -r forbidden
        "#);
        let status = connection_status(inspect_state(command, &std::env::temp_dir(), false, false, false, Duration::from_secs(2), COMMAND_GRACE).await);
        assert_eq!(status.state, "ready");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_reports_session_failed_when_no_approval_mode_is_advertised() {
        // A mode-less server and a plan-only one both lack `default`, which Standard
        // needs and Accept edits / Full access fall back to.
        for session in [r#"{"sessionId":"ready"}"#, r#"{"sessionId":"ready","modes":{"availableModes":[{"id":"plan"}]}}"#] {
            let script = format!(
                r#"read -r init; printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1}}}}'; read -r request; printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{session}}}'; read -r forbidden"#
            );
            let status = connection_status(inspect_state(fixture(&script), &std::env::temp_dir(), false, false, false, Duration::from_secs(2), Duration::from_millis(20)).await);
            assert_eq!(status.state, "sessionFailed", "{session}");
            assert!(status.installed);
            assert!(status.acp_ready);
            assert!(!status.session_ready);
            assert_eq!(status.message, ANTIGRAVITY_CHECK_MODE_UNADVERTISED, "{session}");
            assert!(!status.message.contains("this task's approval mode"));
        }
        let plan_only = json!({"modes":{"availableModes":[{"id":"plan"}]}});
        assert!(!antigravity_advertises_mode(&plan_only));
        assert!(antigravity_advertises_mode(&json!({"modes":{"availableModes":[{"id":"plan"},{"id":"default"}]}})));
        assert_eq!(connection_status(Ok((json!({"modes":{"availableModes":[{"id":"default"}]}}), None))).state, "ready");
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_new_and_resumed_sessions_use_ordinary_windows_cwd() {
        for resume_id in [None, Some("saved-session".into())] {
            let mut cfg = config("antigravity");
            cfg.cwd = PathBuf::from(r"\\?\C:\project");
            cfg.resume_id = resume_id;
            let request = Protocol::new(cfg).receive(capabilities()).unwrap().write.remove(0);
            assert_eq!(request["params"]["cwd"], r"C:\project");
        }
    }

    #[tokio::test]
    #[ignore = "Needs installed and signed-in official Antigravity ACP server; never sends a prompt"]
    async fn installed_antigravity_opens_session_without_prompt() {
        let owned_root = if crate::secret_store::dir().is_none() {
            let root = std::env::temp_dir().join(format!(
                "pandacode-acp-antigravity-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            crate::secret_store::setup(&root);
            Some(root)
        } else {
            None
        };
        let status = provider_check_connection("antigravity".into()).await;
        if let Some(root) = &owned_root {
            let _ = std::fs::remove_dir_all(root);
        }
        let status = status.unwrap();
        assert_eq!(status.state, "ready", "{}", status.message);
    }
    fn capabilities() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},"mcpCapabilities":{"http":true}}}})
    }
    fn metadata() -> Value {
        json!({"sessionId":"remote","configOptions":[
            {"id":"model","category":"model","type":"select","currentValue":"vendor/a","options":[{"value":"vendor/a","name":"Model A"},{"value":"vendor/b","name":"Model B"}]},
            {"id":"mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"Build"},{"value":"plan","name":"Plan"}]}
        ]})
    }
    fn response(id: u64, result: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":result})
    }
    fn copilot_session() -> Value {
        json!({"sessionId":"copilot-session","configOptions":[
            {"type":"select","id":"mode","category":"mode","currentValue":"https://agentclientprotocol.com/protocol/session-modes#agent","options":[
                {"value":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}]},
            {"type":"select","id":"allow_all","category":"permissions","currentValue":"off","options":[{"value":"on"},{"value":"off"}]}],
            "modes":{"availableModes":[
                {"id":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}]}})
    }
    #[test]
    fn copilot_initializes_via_acp_and_applies_only_advertised_mode_and_permission_values() {
        for (mode, expected_mode, expected_allow_all) in [
            ("ask", "#agent", "off"),
            ("plan", "#plan", "off"),
            ("full", "#agent", "on"),
        ] {
            let mut cfg = config("github-copilot");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            assert_eq!(p.initial()["method"], "initialize");
            assert_eq!(
                p.receive(capabilities()).unwrap().write[0]["method"],
                "session/new"
            );
            let selected_mode = p.receive(response(2, copilot_session())).unwrap();
            assert_eq!(
                selected_mode.write[0]["method"],
                "session/set_config_option"
            );
            assert!(selected_mode.write[0]["params"]["value"]
                .as_str()
                .unwrap()
                .ends_with(expected_mode));
            let permissions = p.receive(response(4, json!({}))).unwrap();
            assert_eq!(permissions.write[0]["params"]["configId"], "allow_all");
            assert_eq!(permissions.write[0]["params"]["value"], expected_allow_all);
            let prompt = p.receive(response(8, json!({}))).unwrap();
            assert_eq!(prompt.write[0]["id"], 3);
            assert_eq!(prompt.write[0]["method"], "session/prompt");
        }
    }
    #[test]
    fn copilot_plan_mode_allows_think_and_declines_other_permissions() {
        let mut cfg = config("github-copilot");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "copilot-session".into();
        for (kind, expected) in [
            ("think", "yes"),
            ("execute", "no"),
            ("edit", "no"),
            ("other", "cancelled"),
        ] {
            let mut request = json!({"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"copilot-session","toolCall":{"title":"Requested action","kind":kind},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}});
            if expected == "cancelled" {
                request["params"]["options"] = json!([]);
            }
            let step = p.receive(request).unwrap();
            assert_eq!(
                step.write[0]["result"]["outcome"]["outcome"],
                if expected == "cancelled" {
                    "cancelled"
                } else {
                    "selected"
                }
            );
            if expected != "cancelled" {
                assert_eq!(step.write[0]["result"]["outcome"]["optionId"], expected);
            }
            if expected == "no" {
                assert!(step
                    .events
                    .iter()
                    .any(|event| event.text.contains("Plan mode declined")));
            }
        }
    }
    #[test]
    fn copilot_plan_mode_sends_read_search_and_fetch_through_normal_approval() {
        let mut cfg = config("github-copilot");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "copilot-session".into();
        for kind in ["read", "search", "fetch"] {
            let request = json!({"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"copilot-session","toolCall":{"title":"Requested action","kind":kind},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}});
            let step = p.receive(request).unwrap();
            assert!(step.write.is_empty(), "{kind} must wait for the user");
        }
    }
    #[test]
    fn copilot_requires_advertised_permission_and_model_settings() {
        let mut p = Protocol::new(config("github-copilot"));
        p.receive(capabilities()).unwrap();
        let mut session = copilot_session();
        session["configOptions"] = json!([session["configOptions"][0].clone()]);
        p.receive(response(2, session)).unwrap();
        assert!(p
            .receive(response(4, json!({})))
            .err()
            .unwrap()
            .contains("Allow All"));
        let mut p = Protocol::new(config("github-copilot"));
        p.remote_id = "copilot-session".into();
        p.acp_config = copilot_session();
        let mut cfg = config("github-copilot");
        cfg.model = "unadvertised-model".into();
        p.config = cfg;
        assert!(p
            .receive(response(8, json!({})))
            .err()
            .unwrap()
            .contains("does not advertise the selected model"));
    }
    #[test]
    fn copilot_authentication_errors_name_its_login_command() {
        let mut p = Protocol::new(config("github-copilot"));
        let error = p
            .receive(
                json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Unauthorized"}}),
            )
            .err()
            .unwrap();
        assert!(error.contains("copilot login"));
    }
    #[test]
    fn copilot_launch_uses_direct_stdio_acp_arguments() {
        let mut command = Command::new("copilot");
        configure(&mut command, &config("github-copilot"));
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            [
                std::ffi::OsStr::new("--no-auto-update"),
                std::ffi::OsStr::new("--acp"),
                std::ffi::OsStr::new("--stdio"),
            ]
        );
    }
    #[test]
    fn startup_status_identifies_each_acknowledged_acp_stage() {
        let status = |step: &Step| step.events.iter().filter(|event| event.kind == "status").map(|event| event.text.as_str()).collect::<Vec<_>>().join(", ");
        for (resume, expected) in [(None, "Opening session"), (Some("saved".into()), "Restoring session")] {
            let mut cfg = config("antigravity");
            cfg.model = "vendor/b".into();
            cfg.reasoning_effort = Some("high".into());
            cfg.resume_id = resume;
            let mut p = Protocol::new(cfg);
            assert_eq!(status(&p.receive(capabilities()).unwrap()), expected);
            let metadata = json!({"sessionId":"remote","configOptions":[
                {"id":"mode","category":"mode","type":"select","options":[{"value":"default"}]},
                {"id":"model","category":"model","type":"select","options":[{"value":"vendor/b"}]},
                {"id":"effort","category":"thought_level","type":"select","options":[{"value":"high"}]}
            ]});
            assert_eq!(status(&p.receive(response(2, metadata)).unwrap()), "Applying task mode");
            assert_eq!(status(&p.receive(response(4, json!({}))).unwrap()), "Applying model settings");
            assert_eq!(status(&p.receive(response(5, json!({}))).unwrap()), "Applying reasoning settings");
            let prompt = p.receive(response(6, json!({}))).unwrap();
            assert_eq!(status(&prompt), "Waiting for response");
            assert_eq!(prompt.write[0]["method"], "session/prompt");
            assert!(p.receive(response(3, json!({}))).unwrap().done);
        }
    }
    #[test]
    fn opencode_waits_for_mode_model_and_dynamic_effort_before_prompt() {
        let mut cfg = config("opencode");
        cfg.model = "vendor/b".into();
        cfg.reasoning_effort = Some("high".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["params"]["protocolVersion"], 1);
        assert_eq!(
            p.receive(capabilities()).unwrap().write[0]["method"],
            "session/new"
        );
        let step = p.receive(response(2, metadata())).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "mode");
        assert_eq!(step.write[0]["params"]["value"], "build");
        let step = p.receive(response(4, json!({}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "model");
        assert_eq!(step.write[0]["params"]["value"], "vendor/b");
        let step=p.receive(response(5,json!({"configOptions":[{"id":"variant","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}]}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "variant");
        assert_eq!(step.write[0]["params"]["value"], "high");
        assert_eq!(p.phase, 0);
        assert_eq!(
            p.receive(response(6, json!({}))).unwrap().write[0]["method"],
            "session/prompt"
        );
        assert_eq!(p.phase, 1);
    }
    /// Frames recorded from `opencode acp` 2.2.5: `effort` appears only once a model
    /// with variants is selected, and its reply still says `default` right after a
    /// change (session.list then shows the variant applied).
    #[test]
    fn opencode_v2_recorded_config_options_apply_the_effort() {
        let model = |current: &str| json!({"id":"model","name":"Model","category":"model","type":"select","currentValue":current,"options":[{"value":"opencode/big-pickle","name":"opencode/Big Pickle"},{"value":"opencode/deepseek-v4.1-flash-free","name":"opencode/DeepSeek V4.1 Flash Free"}]});
        let mode = json!({"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"build"},{"value":"plan","name":"plan"}]});
        let effort = json!({"id":"effort","name":"Effort","description":"Available effort levels for this model","category":"thought_level","type":"select","currentValue":"default","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"},{"value":"default","name":"Default"}]});
        let mut cfg = config("opencode");
        cfg.model = "opencode/deepseek-v4.1-flash-free".into();
        cfg.reasoning_effort = Some("max".into());
        let mut p = Protocol::new(cfg);
        p.initial();
        p.receive(capabilities()).unwrap();
        let session = json!({"sessionId":"ses_e65e2baf1ffefwvoiHNuedS9dv","configOptions":[model("opencode/big-pickle"),mode.clone()]});
        assert_eq!(p.receive(response(2, session)).unwrap().write[0]["params"]["configId"], "mode");
        let selected = p.receive(response(4, json!({"configOptions":[model("opencode/big-pickle"),mode.clone()]}))).unwrap();
        assert_eq!(selected.write[0]["params"]["configId"], "model");
        let chosen = p.receive(response(5, json!({"configOptions":[model("opencode/deepseek-v4.1-flash-free"),effort.clone(),mode.clone()]}))).unwrap();
        assert_eq!(chosen.write[0]["params"]["configId"], "effort");
        assert_eq!(chosen.write[0]["params"]["value"], "max");
        let prompt = p.receive(response(6, json!({"configOptions":[model("opencode/deepseek-v4.1-flash-free"),effort,mode]}))).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");
    }

    #[test]
    fn opencode_selects_later_models_from_large_flat_and_grouped_catalogs() {
        for grouped in [false, true] {
            for effort in [None, Some("max")] {
                let mut cfg = config("opencode");
                cfg.model = "deepseek/deepseek-flash".into();
                cfg.reasoning_effort = effort.map(str::to_owned);
                let mut options: Vec<Value> = (0..2023)
                    .map(|index| json!({"value":format!("vendor/model-{index}"),"name":format!("Model {index}")}))
                    .collect();
                options[1996] = json!({"value":cfg.model,"name":"DeepSeek Flash"});
                let mut session = metadata();
                session["configOptions"][0]["options"] = if grouped {
                    json!([{"group":"provider","name":"Provider","options":options}])
                } else {
                    json!(options)
                };
                assert!(parse_models(&session).iter().any(|model| model.id == cfg.model));
                assert!(choice_request("remote", 5, &session["configOptions"][0], "vendor/missing").is_err());
                let mut p = Protocol::new(cfg);
                p.receive(capabilities()).unwrap();
                let mode = p.receive(response(2, session)).unwrap();
                assert_eq!(mode.write[0]["params"]["value"], "build");
                let model = p.receive(response(4, json!({}))).unwrap();
                assert_eq!(model.write[0]["method"], "session/set_config_option");
                assert_eq!(model.write[0]["params"]["value"], "deepseek/deepseek-flash");
                let configured = p.receive(response(5, json!({"configOptions":[{
                    "id":"effort","category":"thought_level","type":"select",
                    "currentValue":"default","options":[{"value":"default"},{"value":"max"}]
                }]}))).unwrap();
                let prompt = if effort.is_some() {
                    assert_eq!(configured.write[0]["params"]["configId"], "effort");
                    assert_eq!(configured.write[0]["params"]["value"], "max");
                    p.receive(response(6, json!({}))).unwrap()
                } else {
                    configured
                };
                assert_eq!(prompt.write[0]["method"], "session/prompt");
            }
        }
    }
    #[test]
    fn acp_catalog_limit_bounds_the_flattened_total() {
        let per_group = 20;
        let groups: Vec<Value> = (0..1000)
            .map(|group| json!({"group":format!("group-{group}"),"options":(0..per_group)
                .map(|index| json!({"value":format!("vendor/model-{}",group*per_group+index)}))
                .collect::<Vec<_>>()}))
            .collect();
        let option = json!({"id":"model","options":groups});
        let selected = choices(&option);
        assert_eq!(selected.len(), MODEL_CATALOG_LIMIT);
        let last = format!("vendor/model-{}", MODEL_CATALOG_LIMIT - 1);
        assert_eq!(selected.last().unwrap()["value"], last);
        assert!(choice_request("remote", 5, &option, &last).is_ok());
        assert!(choice_request("remote", 5, &option, "vendor/model-10000").is_err());
    }
    /// Issue #209: a value the harness does not offer fails with an error that names
    /// what was rejected and what is actually available, instead of the generic
    /// "selected setting" line that names nothing.
    #[test]
    fn choice_request_names_the_rejected_setting_value_and_offered_choices() {
        let option = &metadata()["configOptions"][0];
        let error = choice_request("remote", 5, option, "vendor/missing")
            .err()
            .unwrap();
        assert!(
            error.contains("does not advertise the selected model \"vendor/missing\""),
            "{error}"
        );
        assert!(error.contains("It offers:"), "{error}");
        assert!(error.contains("vendor/a"), "{error}");
        assert!(error.contains("vendor/b"), "{error}");
        assert!(!error.contains("…"), "{error}");
        assert!(
            error.contains("Refresh its models or choose the harness default."),
            "{error}"
        );
    }
    #[test]
    fn choice_request_caps_the_offered_list_at_twelve_values() {
        let options: Vec<Value> = (0..20)
            .map(|index| json!({"value": format!("vendor/model-{index:02}")}))
            .collect();
        let option = json!({"id":"model","category":"model","type":"select","options":options});
        let error = choice_request("remote", 5, &option, "vendor/missing")
            .err()
            .unwrap();
        for listed in 0..12 {
            assert!(
                error.contains(&format!("vendor/model-{listed:02}")),
                "{error}"
            );
        }
        for cut in 12..20 {
            assert!(
                !error.contains(&format!("vendor/model-{cut:02}")),
                "{error}"
            );
        }
        assert!(error.contains("…"), "{error}");
        assert!(
            error.contains("Refresh its models or choose the harness default."),
            "{error}"
        );
    }
    /// The named setting falls back from a missing or empty option id to its category,
    /// then to the word "setting".
    #[test]
    fn choice_request_names_the_category_then_setting_when_the_option_has_no_id() {
        for option in [
            json!({"id":"","category":"thought_level","type":"select","options":[{"value":"low"},{"value":"high"}]}),
            json!({"category":"thought_level","type":"select","options":[{"value":"low"},{"value":"high"}]}),
        ] {
            let error = choice_request("remote", 5, &option, "turbo").err().unwrap();
            assert!(
                error.contains("does not advertise the selected thought_level \"turbo\""),
                "{error}"
            );
            assert!(error.contains("low"), "{error}");
        }
        let anonymous = json!({"type":"select","options":[{"value":"low"},{"value":"high"}]});
        let error = choice_request("remote", 5, &anonymous, "turbo")
            .err()
            .unwrap();
        assert!(
            error.contains("does not advertise the selected setting \"turbo\""),
            "{error}"
        );
        assert!(error.contains("high"), "{error}");
    }
    #[test]
    fn legacy_acp_catalog_keeps_later_models() {
        let available: Vec<Value> = (0..2023)
            .map(|index| json!({"modelId":format!("vendor/model-{index}"),"name":format!("Model {index}")}))
            .collect();
        let models = parse_models(&json!({"models":{"availableModels":available}}));
        assert_eq!(models.len(), 2024);
        assert_eq!(models.last().unwrap().id, "vendor/model-2022");
    }
    #[tokio::test]
    #[ignore = "Needs installed OpenCode; metadata only, never sends a prompt"]
    async fn installed_opencode_negotiates_selected_model_without_prompt() {
        let mut cfg = config("opencode");
        cfg.model = std::env::var("PANDACODE_OPENCODE_SMOKE_MODEL")
            .expect("Set PANDACODE_OPENCODE_SMOKE_MODEL to an available provider/model ID");
        cfg.reasoning_effort = std::env::var("PANDACODE_OPENCODE_SMOKE_EFFORT").ok();
        cfg.cwd = std::env::temp_dir().join(format!("pandacode-acp-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cfg.cwd).unwrap();
        let path = executable("opencode").expect("Install OpenCode first");
        let mut command = super::super::command(&path).unwrap();
        configure(&mut command, &cfg);
        let mut pipe = Pipe::spawn(command, &cfg.cwd, Duration::from_secs(30)).unwrap();
        let mut protocol = Protocol::new(cfg.clone());
        let result: Result<(), String> = async {
            pipe.send(&protocol.initial()).await.map_err(|_| "Could not initialize OpenCode")?;
            loop {
                let frame = pipe.read().await.map_err(|_| "Could not read OpenCode metadata")?;
                if frame.get("method").is_some() && frame.get("id").is_some() {
                    pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata smoke test does not execute requests"}}))
                        .await.map_err(|_| "Could not reject server request")?;
                    continue;
                }
                for request in protocol.receive(frame)?.write {
                    if request["method"] == "session/prompt" {
                        // Reaching this boundary proves settings were accepted.
                        // Never submit the prompt or spend model tokens.
                        return Ok(());
                    }
                    pipe.send(&request).await.map_err(|_| "Could not negotiate OpenCode settings")?;
                }
            }
        }.await;
        pipe.finish().await;
        let _ = std::fs::remove_dir(&cfg.cwd);
        result.unwrap();
    }
    // Shapes recorded from `grok agent stdio` 1.0.30/1.0.40 on 2026-09-21.
    fn grok_capabilities() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
            "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},
            "authMethods":[{"id":"cached_token","name":"cached_token","description":"Cached token from ~/.grok/auth.json"},{"id":"grok.com","name":"Grok","description":"Sign in with Grok"}],
            "_meta":{"defaultAuthMethodId":"cached_token","agentVersion":"1.0.40","modelState":grok_model_state()}}})
    }
    fn grok_model_state() -> Value {
        json!({"currentModelId":"grok-4.7","availableModels":[
            {"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[
                {"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},
                {"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},
                {"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},
                {"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},
            {"modelId":"grok-4.6","name":"Grok 4.6","description":"","_meta":{"totalContextTokens":256000,"supportsReasoningEffort":false}},
            {"modelId":"my-model","name":"GLM Coding Plan","description":"","_meta":{}}]})
    }
    fn grok_session() -> Value {
        json!({"sessionId":"01a0c6e4-07e8-7751-a18f-902b23e7446c","models":grok_model_state(),"configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"grok-4.7","options":[{"value":"grok-4.7","name":"Grok 4.7"},{"value":"grok-4.7-build-fast","name":"Grok 4.7 Fast"},{"value":"grok-4.6","name":"Grok 4.6"}]},
            {"id":"reasoning_effort","name":"Reasoning Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"xhigh","name":"Extra High"},{"value":"high","name":"High"},{"value":"medium","name":"Medium"},{"value":"low","name":"Low"}]}]})
    }
    fn grok_permission(kind: &str, read_only: bool) -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"01a0c6e4-07e8-7751-a18f-902b23e7446c",
            "toolCall":{"toolCallId":"call-1","kind":kind,"title":"Write `hello.txt`","rawInput":{"file_path":"hello.txt"},"_meta":{"x.ai/tool":{"name":"write","read_only":read_only}}},
            "options":[{"optionId":"allow-edits-session","name":"Yes, allow all edits during this session","kind":"allow_always"},{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"reject-once","name":"No, and tell Grok what to do differently","kind":"reject_once"}]}})
    }
    /// A Grok protocol past its handshake, plus the prompt text it sent.
    fn grok_ready(mode: &str) -> (Protocol, String) {
        let mut cfg = config("grok");
        cfg.mode = mode.into();
        let mut p = Protocol::new(cfg);
        p.receive(grok_capabilities()).unwrap();
        p.receive(response(7, json!({"_meta":{"email":"you@example.com"}}))).unwrap();
        let step = p.receive(response(2, grok_session())).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt", "default model and effort go straight to the prompt");
        let text = step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().to_owned();
        (p, text)
    }

    #[test]
    fn grok_authenticates_with_cached_credentials_then_sets_model_and_effort_before_prompting() {
        let mut cfg = config("grok");
        cfg.model = "grok-4.7-build-fast".into();
        cfg.reasoning_effort = Some("medium".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["method"], "initialize");
        let step = p.receive(grok_capabilities()).unwrap();
        assert_eq!(step.write.len(), 1);
        assert_eq!(step.write[0]["id"], 7);
        assert_eq!(step.write[0]["method"], "authenticate");
        assert_eq!(step.write[0]["params"]["methodId"], "cached_token");
        let step = p.receive(response(7, json!({"_meta":{"subscription_tier":"X Premium"}}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        assert_eq!(step.write[0]["params"]["cwd"], "/tmp");
        // No session mode exists for Grok, so the model is configured directly.
        let step = p.receive(response(2, grok_session())).unwrap();
        assert!(step.events.iter().any(|event| event.kind == "session"));
        assert_eq!(step.write[0]["method"], "session/set_config_option");
        assert_eq!(step.write[0]["params"]["configId"], "model");
        assert_eq!(step.write[0]["params"]["value"], "grok-4.7-build-fast");
        let step = p.receive(response(5, json!({}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "reasoning_effort");
        assert_eq!(step.write[0]["params"]["value"], "medium");
        let step = p.receive(response(6, json!({}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "Explain this project");
        assert_eq!(p.phase, 1);
    }

    #[test]
    fn grok_without_cached_credentials_or_with_a_failed_authenticate_asks_to_sign_in() {
        let mut p = Protocol::new(config("grok"));
        let mut capabilities = grok_capabilities();
        capabilities["result"]["authMethods"] = json!([{"id":"grok.com","name":"Grok"}]);
        capabilities["result"]["_meta"]["defaultAuthMethodId"] = Value::Null;
        assert_eq!(p.receive(capabilities).err().unwrap(), GROK_SIGN_IN);
        let mut p = Protocol::new(config("grok"));
        p.receive(grok_capabilities()).unwrap();
        let failed = json!({"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"token expired"}});
        assert_eq!(p.receive(failed).err().unwrap(), GROK_SIGN_IN);
        // Images are refused up front because the agent does not advertise them.
        let mut p = Protocol::new(config("grok"));
        p.image_blocks.push(json!({"type":"image"}));
        assert!(p.receive(grok_capabilities()).err().unwrap().contains("does not accept images"));
    }

    #[test]
    fn grok_plan_mode_prefixes_the_prompt_and_declines_state_changing_permissions() {
        let (mut p, text) = grok_ready("plan");
        assert!(text.starts_with(READ_ONLY_PLAN_PREFIX));
        assert!(text.ends_with("Explain this project"));
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "reject-once");
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("Plan mode declined")));
        assert!(p.pending.is_empty(), "nothing waits on the user");
        let step = p.receive(grok_permission("read", true)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow-once");
        // Other modes keep the user in the loop for edits and leave the prompt alone.
        let (mut p, text) = grok_ready("ask");
        assert_eq!(text, "Explain this project");
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert!(step.write.is_empty());
        let approval = step.events.iter().find(|event| event.kind == "approval").unwrap();
        // Approving takes the one-time choice, never "allow all edits during this session".
        assert!(approval.data.as_ref().is_none_or(|data| data[crate::providers::LASTING_ONLY].is_null()));
        assert_eq!(p.approve(approval.request_id.as_ref().unwrap(), true).unwrap()["result"]["outcome"]["optionId"], "allow-once");
        let (mut p, text) = grok_ready("auto");
        assert!(!text.contains("Plan mode"));
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn grok_reports_context_usage_from_frame_metadata_and_follows_model_switches() {
        let (mut p, _) = grok_ready("ask");
        p.phase = 1;
        let session = "01a0c6e4-07e8-7751-a18f-902b23e7446c";
        let chunk = |text: &str, total: u64| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}},"_meta":{"totalTokens":total}});
        let step = p.receive(chunk("OK", 2281)).unwrap();
        let usage = step.events.iter().find(|event| event.kind == "usage").expect("usage");
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 2281);
        assert_eq!(usage.data.as_ref().unwrap()["contextWindow"], 500000);
        assert!(step.events.iter().any(|event| event.kind == "text" && event.text == "OK"));
        // The same total again is not re-announced.
        assert!(!p.receive(chunk(" then", 2281)).unwrap().events.iter().any(|event| event.kind == "usage"));
        p.receive(json!({"jsonrpc":"2.0","method":"_x.ai/session_notification","params":{"sessionId":session,"update":{"sessionUpdate":"model_changed","model_id":"grok-4.6","reasoning_effort":"high"}}})).unwrap();
        assert_eq!(p.active_model, "grok-4.6");
        let step = p.receive(chunk(".", 4000)).unwrap();
        assert_eq!(step.events.iter().find(|event| event.kind == "usage").unwrap().data.as_ref().unwrap()["contextWindow"], 256000);
        // Extension notifications for other sessions and unknown methods are ignored.
        assert!(p.receive(json!({"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":session,"entries":[]}})).unwrap().events.is_empty());
        let step = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"totalTokens":27703,"modelId":"grok-4.7"}}})).unwrap();
        assert!(step.done);
        assert_eq!(step.events.iter().find(|event| event.kind == "usage").unwrap().data.as_ref().unwrap()["usedTokens"], 27703);
    }

    #[test]
    fn grok_thoughts_surface_as_one_reasoning_status_per_stretch() {
        let (mut p, _) = grok_ready("ask");
        p.phase = 1;
        let session = "01a0c6e4-07e8-7751-a18f-902b23e7446c";
        let thought = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The user"}}}});
        let statuses = |step: &Step| step.events.iter().filter(|event| event.kind == "status" && event.text == "Reasoning").count();
        assert_eq!(statuses(&p.receive(thought.clone()).unwrap()), 1);
        assert_eq!(statuses(&p.receive(thought.clone()).unwrap()), 0);
        p.receive(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"}}}})).unwrap();
        assert_eq!(statuses(&p.receive(thought).unwrap()), 1);
    }

    #[test]
    fn grok_launch_flags_follow_the_approval_mode_and_selection() {
        let args = |mode: &str, model: &str, effort: Option<&str>| {
            let mut cfg = config("grok");
            cfg.mode = mode.into();
            cfg.model = model.into();
            cfg.reasoning_effort = effort.map(str::to_owned);
            let mut command = Command::new("grok");
            configure(&mut command, &cfg);
            command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(args("ask", "default", None), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
        assert_eq!(args("plan", "default", None), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
        assert_eq!(args("auto", "grok-4.7", Some("low")), ["--no-auto-update", "--permission-mode", "acceptEdits", "agent", "--model", "grok-4.7", "--reasoning-effort", "low", "stdio"]);
        assert_eq!(args("full", "default", None), ["--no-auto-update", "--permission-mode", "bypassPermissions", "agent", "--always-approve", "stdio"]);
    }

    #[test]
    fn grok_models_come_from_the_initialize_model_state_with_context_and_efforts() {
        let models = parse_grok_models(&grok_model_state());
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "grok-4.7", "grok-4.6", "my-model"]);
        let flagship = &models[1];
        assert_eq!(flagship.name, "Grok 4.7");
        assert_eq!(flagship.context_window, Some(500000));
        assert_eq!(flagship.reasoning_efforts.iter().map(|effort| effort.id.as_str()).collect::<Vec<_>>(), ["low", "medium", "high", "xhigh"]);
        assert_eq!(flagship.reasoning_efforts[3].name, "Extra High");
        assert_eq!(flagship.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[2].context_window, Some(256000));
        assert!(models[2].reasoning_efforts.is_empty());
        assert_eq!(models[3].context_window, None);
        assert_eq!(parse_grok_models(&json!({})).len(), 1, "no state means only the default choice");
    }

    #[tokio::test]
    #[ignore = "Needs installed and signed-in Grok Build; metadata only, never sends a prompt"]
    async fn installed_grok_negotiates_settings_without_prompt() {
        let path = executable("grok").expect("Install Grok Build first");
        let models = grok_models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
        let chosen = models.iter().find(|model| model.id != "default" && !model.reasoning_efforts.is_empty()).expect("a model with efforts");
        let mut cfg = config("grok");
        cfg.model = chosen.id.clone();
        cfg.reasoning_effort = Some(chosen.reasoning_efforts.last().unwrap().id.clone());
        cfg.cwd = std::env::temp_dir().join(format!("pandacode-grok-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cfg.cwd).unwrap();
        let mut command = super::super::command(&path).unwrap();
        configure(&mut command, &cfg);
        let mut pipe = Pipe::spawn(command, &cfg.cwd, Duration::from_secs(30)).unwrap();
        let mut protocol = Protocol::new(cfg.clone());
        let result: Result<(), String> = async {
            pipe.send(&protocol.initial()).await.map_err(|_| "Could not initialize Grok")?;
            loop {
                let frame = pipe.read().await.map_err(|_| "Could not read Grok metadata")?;
                if frame.get("method").is_some() && frame.get("id").is_some() {
                    pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata smoke test does not execute requests"}}))
                        .await.map_err(|_| "Could not reject server request")?;
                    continue;
                }
                for request in protocol.receive(frame)?.write {
                    if request["method"] == "session/prompt" {
                        return Ok(());
                    }
                    pipe.send(&request).await.map_err(|_| "Could not negotiate Grok settings")?;
                }
            }
        }.await;
        pipe.finish().await;
        let _ = std::fs::remove_dir(&cfg.cwd);
        result.unwrap();
    }

    #[test]
    fn resume_uses_capabilities_without_silently_starting_fresh() {
        for provider in ["opencode", "antigravity"] {
            let mut cfg = config(provider);
            cfg.resume_id = Some("existing".into());
            let mut p = Protocol::new(cfg.clone());
            let request = p.receive(capabilities()).unwrap().write.remove(0);
            assert_eq!(request["method"], "session/load");
            assert_eq!(request["params"]["sessionId"], "existing");
            let mut supported = capabilities();
            supported["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume":{}});
            let mut p = Protocol::new(cfg.clone());
            assert_eq!(
                p.receive(supported).unwrap().write[0]["method"],
                "session/resume"
            );
            let mut unsupported = capabilities();
            unsupported["result"]["agentCapabilities"]["loadSession"] = json!(false);
            assert!(Protocol::new(cfg)
                .receive(unsupported)
                .err()
                .unwrap()
                .contains("resume"));
        }
    }
    #[test]
    fn colab_mcp_rides_beside_the_bridge_on_new_load_and_resume() {
        let colab = super::mcp_host::acp_mcp_servers(&[super::mcp_host::Stdio::new(
            super::mcp_host::COLAB_MCP,
            "/bin/uvx".into(),
            vec!["colab-mcp".into()],
        )]);
        assert_eq!(colab, vec![json!({"name":"colab-mcp","command":"/bin/uvx","args":["colab-mcp"],"env":[]})]);
        let bridge = json!({"type":"http","name":"pandacode_architect","url":"http://127.0.0.1:1/mcp","headers":[]});
        for (provider, saved, resume, method) in [
            ("antigravity", false, false, "session/new"),
            ("opencode", true, false, "session/load"),
            ("kilo", true, true, "session/resume"),
            ("hermes", false, false, "session/new"),
        ] {
            let mut cfg = config(provider);
            cfg.resume_id = saved.then(|| "saved".into());
            let mut p = Protocol::new(cfg);
            p.mcp_server = Some(bridge.clone());
            p.extra_mcp_servers = colab.clone();
            let mut cap = capabilities();
            if resume {
                cap["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume":{}});
            }
            let step = p.receive(cap).unwrap();
            let session = &step.write[0];
            assert_eq!(session["method"], method, "{provider}");
            assert_eq!(session["params"]["mcpServers"], json!([bridge, colab[0]]), "{provider}");
        }
        // Without HTTP MCP the optional bridge drops out but stdio Colab still goes.
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(bridge.clone());
        p.mcp_required = false;
        p.extra_mcp_servers = colab.clone();
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["mcpCapabilities"] = json!({});
        let step = p.receive(cap).unwrap();
        assert_eq!(step.write[0]["params"]["mcpServers"], json!(colab));
        // Off by default: the session carries exactly what it did before.
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(bridge.clone());
        assert!(p.extra_mcp_servers.is_empty());
        let step = p.receive(capabilities()).unwrap();
        assert_eq!(step.write[0]["params"]["mcpServers"], json!([bridge]));
    }

    #[test]
    fn unsupported_images_mcp_or_effort_fail_before_any_prompt() {
        let mut p = Protocol::new(config("antigravity"));
        p.image_blocks.push(json!({"type":"image"}));
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["promptCapabilities"]["image"] = json!(false);
        assert!(p.receive(cap).err().unwrap().contains("image"));
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(json!({}));
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["mcpCapabilities"]["http"] = json!(false);
        assert!(p.receive(cap).err().unwrap().contains("MCP"));
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(json!({}));
        p.mcp_required = false;
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["mcpCapabilities"]["http"] = json!(false);
        let step = p.receive(cap).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        assert_eq!(step.write[0]["params"]["mcpServers"], json!([]));
        let mut cfg = config("opencode");
        cfg.reasoning_effort = Some("ultra".into());
        let mut p = Protocol::new(cfg);
        p.acp_config = metadata();
        p.remote_id = "remote".into();
        assert!(p.receive(response(4, json!({}))).is_err());
    }

    #[test]
    fn a_generic_harness_without_the_selected_mode_runs_in_its_own_mode() {
        // A generic harness whose own modes lack a plan choice (#269) keeps the session
        // alive and PandaCode enforces the read-only plan rules instead.
        let mut cfg = config("hermes");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["method"], "initialize");
        p.receive(capabilities()).unwrap();
        let step = p.receive(response(2, json!({"sessionId":"remote","modes":{"currentModeId":"agent","availableModes":[{"id":"agent","name":"Agent"}]}}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert!(step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().starts_with(READ_ONLY_PLAN_PREFIX));
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("no Plan mode; it runs in its Agent mode")));
        let edit = json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Edit src/main.rs","kind":"edit"},"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"reject","kind":"reject_once"}]}});
        let declined = p.receive(edit).unwrap();
        assert_eq!(declined.write[0]["result"]["outcome"]["optionId"], "reject");
        assert!(declined.events.iter().any(|event| event.kind == "status" && event.text.contains("Plan mode declined")));
        let read = json!({"jsonrpc":"2.0","id":"p2","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Read Cargo.toml","kind":"read"},"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"reject","kind":"reject_once"}]}});
        assert_eq!(p.receive(read).unwrap().write[0]["result"]["outcome"]["optionId"], "allow");
        // Reads without an allow option keep the ordinary approval path.
        let fetch = json!({"jsonrpc":"2.0","id":"p4","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Fetch docs","kind":"fetch"},"options":[{"optionId":"always","kind":"allow_always"},{"optionId":"reject","kind":"reject_once"}]}});
        let asked = p.receive(fetch).unwrap();
        assert!(asked.write.is_empty());
        assert!(asked.events.iter().any(|event| event.kind == "approval"));
        let write_only = json!({"jsonrpc":"2.0","id":"p3","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Run deploy","kind":"execute"},"options":[{"optionId":"allow","kind":"allow_once"}]}});
        assert_eq!(p.receive(write_only).unwrap().write[0]["result"]["outcome"]["outcome"], "cancelled");

        // Hermes reaches the same fallback when its mode option lacks a
        // counterpart; its own plan rules keep applying first.
        let mut cfg = config("hermes");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.receive(capabilities()).unwrap();
        let step = p.receive(response(2, json!({"sessionId":"remote","configOptions":[{"id":"mode","category":"mode","type":"select","currentValue":"chat","options":[{"value":"chat","name":"Chat"}]}]}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert!(step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().starts_with(READ_ONLY_PLAN_PREFIX));
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("no Plan mode; it runs in its Chat mode")));
        let read = json!({"jsonrpc":"2.0","id":"p5","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Read Cargo.toml","kind":"read"},"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"reject","kind":"reject_once"}]}});
        assert_eq!(p.receive(read).unwrap().write[0]["result"]["outcome"]["optionId"], "allow");

        // Accept edits runs in the harness's own mode with a status note and no plan prefix.
        let mut cfg = config("hermes");
        cfg.mode = "auto".into();
        let mut p = Protocol::new(cfg);
        p.receive(capabilities()).unwrap();
        let step = p.receive(response(2, json!({"sessionId":"remote","modes":{"currentModeId":"agent","availableModes":[{"id":"agent","name":"Agent"}]}}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert!(step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().starts_with("Explain this project"));
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("Accept edits")));

        // The same fallback applies when the harness advertises its modes as a
        // mode option without a plan choice.
        let mut cfg = config("hermes");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.receive(capabilities()).unwrap();
        let step = p.receive(response(2, json!({"sessionId":"remote","configOptions":[{"id":"mode","category":"mode","type":"select","currentValue":"agent","options":[{"value":"agent","name":"Agent"}]}]}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert!(step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().starts_with(READ_ONLY_PLAN_PREFIX));
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("no Plan mode; it runs in its Agent mode")));

        // A harness whose own mode approves more than the chosen one is never
        // a fallback: Plan and Standard refuse an edit or bypass mode, Accept
        // edits refuses a bypass mode, and Full access takes any.
        for (mode, current, fails) in [("plan", "autoEdit", true), ("default", "yolo", true), ("auto", "accept-edits", false), ("auto", "bypassPermissions", true), ("full", "yolo", false)] {
            let mut cfg = config("hermes");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            p.receive(capabilities()).unwrap();
            let result = p.receive(response(2, json!({"sessionId":"remote","modes":{"currentModeId":current,"availableModes":[{"id":current}]}})));
            assert_eq!(result.is_err(), fails, "{mode} in {current}");
            if fails { assert!(result.err().unwrap().contains("approves more than")); }
        }

        // With no mode information at all the run still fails rather than
        // guess what the harness would allow.
        let mut cfg = config("hermes");
        cfg.mode = "plan".into();
        assert!(Protocol::new(cfg)
            .receive(response(2, json!({"sessionId":"remote"})))
            .err()
            .unwrap()
            .contains("planning"));

        // Harnesses whose modes are their approval policy still fail rather
        // than widen access; Antigravity's message says what to do about it.
        for (provider, expected) in [
            ("opencode", "This harness does not advertise the selected task mode."),
            ("antigravity", "Antigravity did not offer this task's approval mode, so the task did not start; it would have run in agy's own default mode. Run `agy update` in a terminal outside PandaCode (or use its official installer), or select the agy CLI instead of the standalone ACP server, then retry."),
        ] {
            let mut cfg = config(provider);
            cfg.mode = "plan".into();
            let mut p = Protocol::new(cfg);
            p.receive(capabilities()).unwrap();
            assert_eq!(
                p.receive(response(2, json!({"sessionId":"remote","modes":{"availableModes":[{"id":"build"}]}})))
                    .err()
                    .unwrap(),
                expected,
                "{provider}"
            );
        }
    }

    #[test]
    fn antigravity_mode_reach_and_bare_resumed_session_fail_closed() {
        assert_eq!(mode_reach("antigravity", "auto"), 3);
        assert_eq!(mode_reach("antigravity", "AUTO"), 3);
        assert_eq!(mode_reach("antigravity", "accept-edits"), 2);
        assert_eq!(mode_reach("hermes", "auto"), 2);

        // Bare resumed Antigravity session (missing configOptions and modes)
        // must fail closed in every approval mode rather than silently keep a
        // previously persisted `auto` mode.
        for mode in ["ask", "auto", "plan", "full"] {
            let mut cfg = config("antigravity");
            cfg.mode = mode.into();
            cfg.resume_id = Some("saved-sess".into());
            let mut p = Protocol::new(cfg);
            p.receive(capabilities()).unwrap();
            let err = p
                .receive(response(2, json!({"sessionId": "saved-sess"})))
                .err()
                .unwrap();
            assert!(
                err.contains("Antigravity did not offer this task's approval mode") && err.contains("agy update"),
                "mode={mode}: {err}"
            );
        }
    }
    fn permission() -> Value {
        json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Run command","kind":"execute"},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}})
    }
    #[test]
    fn acp_approvals_wait_in_standard_and_auto_edit_modes_and_cancel_foreign_requests() {
        for provider in ["opencode", "antigravity"] {
            for mode in ["ask", "auto"] {
                let mut cfg = config(provider);
                cfg.mode = mode.into();
                let mut p = Protocol::new(cfg);
                p.remote_id = "remote".into();
                let step = p.receive(permission()).unwrap();
                assert!(step.write.is_empty());
                let request = step
                    .events
                    .iter()
                    .find(|event| event.kind == "approval")
                    .unwrap()
                    .request_id
                    .as_ref()
                    .unwrap();
                assert_eq!(
                    p.approve(request, false).unwrap()["result"]["outcome"]["optionId"],
                    "no"
                );
                let mut foreign = permission();
                foreign["params"]["sessionId"] = json!("other");
                assert_eq!(
                    p.receive(foreign).unwrap().write[0]["result"]["outcome"]["outcome"],
                    "cancelled"
                );
            }
            let mut cfg = config(provider);
            cfg.mode = "full".into();
            let mut p = Protocol::new(cfg);
            p.remote_id = "remote".into();
            assert_eq!(
                p.receive(permission()).unwrap().write[0]["result"]["outcome"]["optionId"],
                "yes"
            );
        }
    }
    #[test]
    fn full_acp_permissions_do_not_answer_questions_or_guess_between_grants() {
        for provider in ["opencode", "antigravity"] {
            for options in [
                json!([{"optionId":"q0_opt_0","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]),
                json!([{"optionId":"one","kind":"allow_once"},{"optionId":"two","kind":"allow_once"}]),
            ] {
                let mut cfg = config(provider);
                cfg.mode = "full".into();
                let mut p = Protocol::new(cfg);
                p.remote_id = "remote".into();
                let mut request = permission();
                request["params"]["options"] = options;
                let step = p.receive(request).unwrap();
                assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "cancelled");
                assert!(step.events.iter().any(|event| event.kind == "status"));
            }
        }
        let full: Value = serde_json::from_str(&configuration("full")).unwrap();
        assert_eq!(full["permission"]["*"], "allow");
        assert_eq!(full["agent"]["build"]["permission"]["*"], "allow");
        assert_eq!(full["agent"]["plan"]["permission"]["*"], "allow");
    }

    #[test]
    fn acp_streaming_preserves_boundaries_tools_usage_and_isolation() {
        for provider in ["opencode", "antigravity"] {
            let mut p = Protocol::new(config(provider));
            p.remote_id = "remote".into();
            let chunk = json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}});
            assert!(p.receive(chunk.clone()).unwrap().events.is_empty());
            p.phase = 1;
            let before = p.receive(chunk.clone()).unwrap();
            assert_eq!(before.events.last().unwrap().text, "hello");
            let tool = json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"tool_call","toolCallId":"one","title":"Read file","status":"in_progress","rawInput":{"path":"src/main.ts"}}}});
            assert!(p.receive(tool).unwrap().events.iter().any(|event| event
                .tool
                .as_ref()
                .is_some_and(|tool| tool.input.contains("main.ts"))));
            let after = p.receive(chunk.clone()).unwrap();
            assert_ne!(before.events[0].data, after.events[0].data);
            let mut foreign = chunk;
            foreign["params"]["sessionId"] = json!("other");
            assert!(p.receive(foreign).unwrap().events.is_empty());
            assert_eq!(p.cancel()["method"], "session/cancel");
            assert!(
                p.receive(response(3, json!({"stopReason":"end_turn"})))
                    .unwrap()
                    .done
            );
        }
    }
    #[test]
    fn commands_use_supported_binary_args_and_permissions_are_process_local() {
        let mut c = Command::new("opencode");
        let mut cfg = config("opencode");
        cfg.mode = "plan".into();
        configure(&mut c, &cfg);
        assert_eq!(
            c.as_std().get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("acp")]
        );
        let inline = c
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1
            .unwrap();
        let value: Value = serde_json::from_str(inline.to_str().unwrap()).unwrap();
        assert_eq!(value["permission"]["*"], "deny");
        assert_eq!(value["permission"]["read"], "allow");
        for (tool, expected) in [("webfetch", "allow"), ("websearch", "allow"), ("list", "allow"), ("external_directory", "ask"), ("edit", "deny"), ("bash", "deny")] {
            let actual = value["permission"].get(tool).unwrap_or(&value["permission"]["*"]);
            assert_eq!(actual, expected, "{tool}");
        }
        assert_eq!(value["agent"]["plan"]["permission"]["*"], "deny");
        let mut c = Command::new("agy_acp_server.par");
        configure(&mut c, &config("antigravity"));
        assert!(!c.as_std().get_args().any(|arg| arg == "acp"));
        let mut c = Command::new("/usr/local/bin/agy");
        super::super::privacy::FORCE.with(|force| force.set(Some(true)));
        configure(&mut c, &config("antigravity"));
        let agy_args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(&agy_args[..3], ["acp", "--process-per-session", "--disable-telemetry"]);
        assert!(!agy_args.iter().any(|arg| arg == "--dangerously-skip-permissions"));
        let mut full_cfg = config("antigravity");
        full_cfg.mode = "full".into();
        let mut c_full = Command::new("/usr/local/bin/agy");
        configure(&mut c_full, &full_cfg);
        assert!(c_full.as_std().get_args().any(|arg| arg == "--dangerously-skip-permissions"));
        super::super::privacy::FORCE.with(|force| force.set(None));
        let mut c_hermes = Command::new("hermes");
        configure(&mut c_hermes, &config("hermes"));
        assert!(c_hermes.as_std().get_args().any(|arg| arg == "acp"));
    }

    #[test]
    fn hermes_storage_unavailable_reports_setup_and_model_guidance() {
        let mut p = Protocol::new(config("hermes"));
        assert_eq!(p.initial()["method"], "initialize");
        let step = p.receive(capabilities()).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        let error = p.receive(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "error": {
                "code": -32603,
                "message": "Internal error",
                "data": { "details": "storage_unavailable" }
            }
        })).err().unwrap();
        assert!(error.contains("Hermes Agent is not configured with a default model"));
        assert!(error.contains("hermes model"));
    }

    #[test]
    fn hermes_provider_not_configured_reports_provider_guidance() {
        let mut p = Protocol::new(config("hermes"));
        assert_eq!(p.initial()["method"], "initialize");
        let step = p.receive(capabilities()).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        let error = p.receive(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "error": {
                "code": -32603,
                "message": "Internal error",
                "data": "admitted_turn_failed\nagent.auxiliary_unavailable.ProviderNotConfiguredError: No LLM provider configured."
            }
        })).err().unwrap();
        assert!(error.contains("Hermes Agent has no inference provider configured"));
        assert!(error.contains("model.provider"));
    }

    #[test]
    fn hermes_full_access_sets_yolo_env_and_selects_dont_ask_mode() {
        let mut cfg = config("hermes");
        cfg.mode = "full".into();
        let mut c = Command::new("hermes");
        configure(&mut c, &cfg);
        assert_eq!(c.as_std().get_envs().find(|(k, _)| *k == "HERMES_YOLO_MODE").unwrap().1.unwrap(), "1");

        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["method"], "initialize");
        p.receive(capabilities()).unwrap();
        let session = json!({
            "sessionId": "hermes-123",
            "modes": {
                "availableModes": [
                    { "id": "default", "name": "Default" },
                    { "id": "accept_edits", "name": "Accept Edits" },
                    { "id": "dont_ask", "name": "Don't Ask" }
                ],
                "currentModeId": "default"
            }
        });
        let step = p.receive(response(2, session)).unwrap();
        assert_eq!(step.write[0]["method"], "session/set_mode");
        assert_eq!(step.write[0]["params"]["modeId"], "dont_ask");
    }

    #[test]
    fn hermes_specific_errors_not_masked_by_code_32000() {
        let mut p = Protocol::new(config("hermes"));
        assert_eq!(p.initial()["method"], "initialize");
        let step = p.receive(capabilities()).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        let error = p.receive(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "error": {
                "code": -32000,
                "message": "Server error",
                "data": "agent.auxiliary_unavailable.ProviderNotConfiguredError: No LLM provider configured."
            }
        })).err().unwrap();
        assert!(error.contains("Hermes Agent has no inference provider configured"), "{error}");

        let mut p2 = Protocol::new(config("hermes"));
        p2.receive(capabilities()).unwrap();
        let error2 = p2.receive(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "error": {
                "code": -32000,
                "message": "Key limit exceeded",
                "data": "Key limit exceeded (total limit)"
            }
        })).err().unwrap();
        assert!(error2.contains("API key quota or credit limit exceeded"), "{error2}");
    }

    #[test]
    fn hermes_plan_mode_declines_state_changing_tools_and_allows_reads() {
        let mut cfg = config("hermes");
        cfg.mode = "plan".into();
        cfg.prompt = "Audit the codebase".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "hermes-session-plan".into();
        let mut prompt_step = Step::default();
        p.kimi_prompt(&mut prompt_step);
        let prompt_text = prompt_step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(prompt_text.starts_with(READ_ONLY_PLAN_PREFIX));

        let edit_req = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "session/request_permission",
            "params": {
                "sessionId": "hermes-session-plan",
                "toolCall": {
                    "toolCallId": "call-1",
                    "title": "Edit src/main.rs",
                    "kind": "edit"
                },
                "options": [
                    { "optionId": "allow", "kind": "allow_once" },
                    { "optionId": "reject", "kind": "reject_once" }
                ]
            }
        });
        let edit_step = p.receive(edit_req).unwrap();
        assert_eq!(edit_step.write[0]["result"]["outcome"]["optionId"], "reject");
        assert!(edit_step.events.iter().any(|e| e.kind == "status" && e.text.contains("Plan mode declined")));

        let read_req = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "session/request_permission",
            "params": {
                "sessionId": "hermes-session-plan",
                "toolCall": {
                    "toolCallId": "call-2",
                    "title": "Read Cargo.toml",
                    "kind": "read"
                },
                "options": [
                    { "optionId": "allow", "kind": "allow_once" },
                    { "optionId": "reject", "kind": "reject_once" }
                ]
            }
        });
        let read_step = p.receive(read_req).unwrap();
        assert_eq!(read_step.write[0]["result"]["outcome"]["optionId"], "allow");
    }
    #[test]
    fn glm_explicit_model_remains_a_cli_override_and_default_is_real_glm() {
        for model in ["default", "glm-5.3-flash"] {
            let mut cfg = config("glm");
            cfg.model = model.into();
            let mut command = Command::new("claude");
            super::super::configure_command(&mut command, &cfg);
            let args = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            let index = args.iter().position(|arg| arg == "--model").unwrap();
            assert_eq!(
                args[index + 1],
                if model == "default" { "glm-5.3" } else { model }
            );
        }
    }

    #[test]
    fn grouped_acp_models_keep_labels_and_do_not_infer_effort_for_other_models() {
        let models = parse_models(
            &json!({"configOptions":[{"id":"model","category":"model","type":"select","currentValue":"a","options":[{"group":"vendor","options":[{"value":"a","name":"Actual A"},{"value":"b","name":"Actual B"}]}]},{"id":"effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"high"}]}]}),
        );
        assert_eq!(models[1].name, "Actual A");
        assert_eq!(models[2].name, "Actual B");
        assert_eq!(models[1].reasoning_efforts.len(), 1);
        assert!(models[2].reasoning_efforts.is_empty());
    }

    fn acp_steer(p: &mut Protocol, id: &str, text: &str) -> (Step, Result<Value, String>) {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let step = p.acp_steer(id.into(), text.into(), tx);
        (step, rx.try_recv().unwrap())
    }

    fn steer_statuses(step: &Step) -> Vec<(String, String, String)> {
        step.events.iter().filter(|event| event.kind == "steer").map(|event| {
            let data = event.data.as_ref().unwrap();
            (data["id"].as_str().unwrap().into(), data["status"].as_str().unwrap().into(), data["mode"].as_str().unwrap().into())
        }).collect()
    }

    // Recorded from grok 1.0.62 `agent stdio`: a turn end, trimmed to the fields read here.
    fn grok_turn_end() -> Value {
        json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"sessionId":"01a16446-2e56-77e2-8bb5-ed2ce3a57f81","requestId":"59162bb0-f403-47e6-a050-70c29e8c39e9","promptId":"59162bb0-f403-47e6-a050-70c29e8c39e9","totalTokens":27887,"modelId":"grok-4.7","inputTokens":27849,"outputTokens":31}}})
    }

    #[test]
    fn held_steers_go_out_as_the_next_prompt_and_keep_the_run_open() {
        let (mut p, _) = grok_ready("plan");
        let (step, reply) = acp_steer(&mut p, "s1", "  use the parser  ");
        assert!(step.write.is_empty(), "Grok cannot take input mid-turn");
        assert_eq!(reply.unwrap(), json!({"steered":true,"id":"s1","mode":"next-turn"}));
        assert_eq!(steer_statuses(&step), [("s1".into(), "pending".into(), "next-turn".into())]);
        acp_steer(&mut p, "s2", "and add tests").1.unwrap();

        let step = p.receive(grok_turn_end()).unwrap();
        assert!(!step.done, "the run waits for the steered turn");
        assert_eq!(step.write.len(), 1);
        let prompt = &step.write[0];
        assert_eq!(prompt["method"], "session/prompt");
        assert_eq!(prompt["id"], 3);
        assert_eq!(prompt["params"]["sessionId"], p.remote_id);
        let text = prompt["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(text.starts_with(READ_ONLY_PLAN_PREFIX) && text.ends_with("use the parser\n\nand add tests"), "{text}");
        let delivered: Vec<_> = steer_statuses(&step).into_iter().map(|(id, status, _)| (id, status)).collect();
        assert_eq!(delivered, [("s1".into(), "delivered".into()), ("s2".into(), "delivered".into())]);

        let step = p.receive(grok_turn_end()).unwrap();
        assert!(step.done && step.write.is_empty());
    }

    #[test]
    fn steers_before_the_first_prompt_wait_and_cancelled_turns_fail_them() {
        let mut p = Protocol::new(config("kimi"));
        let (step, reply) = acp_steer(&mut p, "early", "hi");
        assert!(step.write.is_empty());
        assert_eq!(reply.unwrap()["mode"], "next-turn");
        p.remote_id = "main".into();
        p.phase = 1;
        // Recorded Kimi Code 0.26 cancel answer.
        let step = p.kimi_steered(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}})).unwrap();
        assert!(step.done && step.write.is_empty());
        assert_eq!(steer_statuses(&step), [("early".into(), "failed".into(), "next-turn".into())]);

        let mut p = Protocol::new(config("kimi"));
        p.remote_id = "main".into();
        p.phase = 1;
        acp_steer(&mut p, "k", "next").1.unwrap();
        let step = p.kimi_steered(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap();
        assert!(!step.done);
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "next");
        acp_steer(&mut p, "lost", "never sent").1.unwrap();
        assert_eq!(steer_statuses(&p.acp_steers_failed()), [("lost".into(), "failed".into(), "next-turn".into())]);
    }

    #[test]
    fn steers_are_bounded_and_validated() {
        let mut p = Protocol::new(config("deepseek"));
        assert!(acp_steer(&mut p, "a", "   ").1.is_err());
        assert!(acp_steer(&mut p, "a", &"x".repeat(crate::MESSAGE_LIMIT + 1)).1.is_err());
        for n in 0..MAX_STEERS {
            acp_steer(&mut p, &n.to_string(), "ok").1.unwrap();
        }
        let (step, reply) = acp_steer(&mut p, "over", "ok");
        assert!(reply.is_err() && step.events.is_empty());
    }

    #[test]
    fn opencode_steers_live_and_finishes_when_both_prompts_answer() {
        let mut p = Protocol::new(config("opencode"));
        p.remote_id = "ses_e9bb8a9f5ffeWeueZ0ePLK1srM".into();
        p.phase = 1;
        let (step, reply) = acp_steer(&mut p, "live", "The codeword is BANANA.");
        assert_eq!(reply.unwrap(), json!({"steered":true,"id":"live","mode":"live"}));
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "The codeword is BANANA.");
        let request = step.write[0]["id"].as_u64().unwrap();
        assert!(STEER_IDS.contains(&request));
        let statuses: Vec<_> = steer_statuses(&step).into_iter().map(|(_, status, _)| status).collect();
        assert_eq!(statuses, ["pending", "delivered"]);
        // Recorded from OpenCode 1.19.0: both requests answer together at turn end.
        let usage = json!({"inputTokens":113,"outputTokens":4,"totalTokens":23054,"thoughtTokens":25,"cachedReadTokens":22912});
        let first = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":usage,"_meta":{}}})).unwrap();
        assert!(!first.done, "the live steer is still open");
        let (step, reply) = acp_steer(&mut p, "late", "one more");
        assert!(step.write.is_empty(), "after the turn answered, a steer waits for the next turn");
        assert_eq!(reply.unwrap()["mode"], "next-turn");
        let second = p.receive(json!({"jsonrpc":"2.0","id":request,"result":{"stopReason":"end_turn","usage":usage,"_meta":{}}})).unwrap();
        assert!(!second.done);
        assert_eq!(second.write[0]["params"]["prompt"][0]["text"], "one more");
        assert!(p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{}}})).unwrap().done);

        // A refused live steer never fails the run; it goes with the next turn instead.
        let mut p = Protocol::new(config("opencode"));
        p.remote_id = "s".into();
        p.phase = 1;
        let request = acp_steer(&mut p, "busy", "retry me").0.write[0]["id"].clone();
        let step = p.receive(json!({"jsonrpc":"2.0","id":request,"error":{"code":-32603,"message":"busy"}})).unwrap();
        assert!(!step.done);
        let step = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap();
        assert!(!step.done);
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "retry me");
    }

    #[test]
    fn antigravity_soft_errors_fail_turn_and_emit_limited_only_for_quota_and_credits() {
        let chunk = |text: &str| {
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "ag-1",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text}
                    }
                }
            })
        };

        // Credits exhausted -> emits `limited` event (resetsAt: null) and fails via `step.failure`.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("⚠ Your AI credits balance is too low to continue.")).unwrap();
        let step = p.receive(response(3, json!({"stopReason": "end_turn"}))).unwrap();
        assert!(!step.done);
        let limited = step.events.iter().find(|e| e.kind == "limited").expect("limited event");
        assert!(limited.data.as_ref().unwrap()["resetsAt"].is_null());
        assert!(step.failure.as_deref().unwrap().contains("AI credits balance"));

        // Individual quota reached -> emits `limited` event with parsed `resetsAt` and fails.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("⚠ Individual quota reached for Gemini 4 Neon. Resets in 2h 15m.")).unwrap();
        let step = p.receive(response(3, json!({"stopReason": "end_turn"}))).unwrap();
        let limited = step.events.iter().find(|e| e.kind == "limited").expect("limited event");
        assert!(limited.data.as_ref().unwrap()["resetsAt"].as_i64().is_some());
        assert!(step.failure.as_deref().unwrap().contains("Individual quota reached"));

        // Stream interrupted -> fails without emitting `limited`.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("⚠ The stream was interrupted.")).unwrap();
        let err = p.receive(response(3, json!({"stopReason": "end_turn"}))).err().unwrap();
        assert!(err.contains("stream was interrupted"));

        // Model produced invalid output -> fails without emitting `limited`.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("⚠ Model produced invalid output.")).unwrap();
        let err = p.receive(response(3, json!({"stopReason": "end_turn"}))).err().unwrap();
        assert!(err.contains("invalid output"));

        // Trailing fatal `⚠` after partial prose -> detected.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("Starting analysis...\n⚠ The stream was interrupted.")).unwrap();
        let err = p.receive(response(3, json!({"stopReason": "end_turn"}))).err().unwrap();
        assert!(err.contains("stream was interrupted"));

        // Verbose >2 KiB warning retries stay within rolling 4096-byte tail and still detect.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        let padding = format!("⚠ API error (attempt 1/3): {}\n", "x".repeat(2500));
        p.receive(chunk(&padding)).unwrap();
        p.receive(chunk("⚠ API error (attempt 2/3): RESOURCE_EXHAUSTED (code 429). Resets in 45m.\n⚠ The stream was interrupted.")).unwrap();
        let step = p.receive(response(3, json!({"stopReason": "end_turn"}))).unwrap();
        assert!(!step.done);
        let limited = step.events.iter().find(|e| e.kind == "limited").expect("limited event");
        assert!(limited.data.as_ref().unwrap()["resetsAt"].as_i64().is_some());

        // `agent_thought_chunk` clears preceding turn text so earlier prose does not pollute later segment.
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-1".into();
        p.phase = 1;
        p.receive(chunk("⚠ Individual quota reached. Resets in 2h.")).unwrap();
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "ag-1",
                "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Continuing"}}
            }
        })).unwrap();
        p.receive(chunk("All done.")).unwrap();
        let step = p.receive(response(3, json!({"stopReason": "end_turn"}))).unwrap();
        assert!(step.done && step.failure.is_none());

        // Normal reply mentioning `⚠` mid-sentence or with prose after `⚠` -> succeeds cleanly.
        for benign in [
            "When quota runs out, agy prints \"⚠ Individual quota reached. Resets in 2h.\" on stderr.",
            "⚠ Individual quota reached. Resets in 2h.\nThat is the message agy prints when your quota is full.",
        ] {
            let mut p = Protocol::new(config("antigravity"));
            p.remote_id = "ag-1".into();
            p.phase = 1;
            p.receive(chunk(benign)).unwrap();
            let step = p.receive(response(3, json!({"stopReason": "end_turn"}))).unwrap();
            assert!(step.done, "{benign}");
            assert!(step.failure.is_none(), "{benign}");
            assert!(!step.events.iter().any(|e| e.kind == "limited"), "{benign}");
        }
    }

    #[test]
    fn antigravity_rpc_errors_classify_rate_limits_and_sign_in() {
        let mut p = Protocol::new(config("antigravity"));
        let step = p
            .receive(json!({
                "jsonrpc": "2.0",
                "id": 3,
                "error": {
                    "code": -32603,
                    "message": "API error: RESOURCE_EXHAUSTED (code 429). Resets in 45m."
                }
            }))
            .unwrap();
        let limited = step.events.iter().find(|e| e.kind == "limited").expect("limited event");
        assert!(limited.data.as_ref().unwrap()["resetsAt"].as_i64().is_some());
        assert!(step.failure.as_deref().unwrap().contains("RESOURCE_EXHAUSTED"));

        let mut p = Protocol::new(config("antigravity"));
        let err = p
            .receive(json!({
                "jsonrpc": "2.0",
                "id": 2,
                "error": {"code": -32000, "message": "Authentication required"}
            }))
            .err()
            .unwrap();
        assert!(err.contains("agy acp --login"), "{err}");

        // -32000 with explicit credit/quota/429 error on Antigravity classifies as rate-limited
        // rather than ANTIGRAVITY_SIGN_IN.
        for message in [
            "Your AI credits balance is too low",
            "API error: RESOURCE_EXHAUSTED (code 429). Resets in 20m.",
            "Individual quota reached. Resets in 1h.",
        ] {
            let mut p = Protocol::new(config("antigravity"));
            let step = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "id": 3,
                    "error": {"code": -32000, "message": message}
                }))
                .unwrap();
            assert!(
                step.events.iter().any(|e| e.kind == "limited"),
                "-32000 credit/quota error must emit limited event: {message}"
            );
            assert!(
                step.failure.as_deref().is_some_and(|f| f.contains(message)),
                "-32000 credit/quota error must set step.failure: {message}"
            );
        }

        // Otherwise -32000 auth error STILL returns ANTIGRAVITY_SIGN_IN BEFORE
        // missing-session fallback, even if its message mentions "not found" / "session not found",
        // followed by what the server said (agy's own texts included).
        for message in [
            "Authentication required",
            "authentication required. Run 'agy acp --login' to log in.",
            "Credentials not found; session not found",
            "Not authenticated: failed to read session",
        ] {
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("saved-sess".into());
            let mut p = Protocol::new(cfg);
            let mut caps = capabilities();
            caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
            p.receive(caps).unwrap();
            let err = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "error": {"code": -32000, "message": message}
                }))
                .err()
                .unwrap_or_else(|| panic!("expected a sign-in error for {message:?}"));
            assert_eq!(
                err,
                format!("{ANTIGRAVITY_SIGN_IN} (The server said: ACP session creation or resume: {message})"),
                "{message}"
            );
        }
    }

    #[test]
    fn antigravity_missing_session_resume_answered_with_32000_recovers_the_thread() {
        let frame = |message: &str| json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":message}});
        assert!(!acp_sign_in_error(&frame("Session not found: saved-sess")));
        assert!(acp_sign_in_error(&frame("Credentials not found; session not found")));
        // A missing session that merely mentions a token still recovers the thread.
        assert!(!acp_sign_in_error(&frame("Session not found: saved-sess (token budget unchanged)")));
        for message in ["Invalid access token", "refresh token expired", "OAuth failed", "missing auth token", "bad id token"] {
            assert!(acp_sign_in_error(&frame(message)), "{message}");
        }
        // agy's real resume failures, both answered with -32000.
        for message in [
            "Session not found: saved-sess",
            "Failed to read session saved-sess; retry, or load it with session/load",
        ] {
            // With the load capability the session is loaded.
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("saved-sess".into());
            let mut p = Protocol::new(cfg);
            let mut caps = capabilities();
            caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
            p.receive(caps).unwrap();
            let step = p.receive(frame(message)).unwrap();
            assert_eq!(step.write[0]["method"], "session/load", "{message}");
            assert!(step.events.iter().all(|e| e.kind != "limited"), "{message}");

            // Without it, a fresh session starts with the note.
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("saved-sess".into());
            let mut p = Protocol::new(cfg);
            let mut caps = capabilities();
            caps["result"]["agentCapabilities"]["loadSession"] = json!(false);
            caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}});
            p.receive(caps).unwrap();
            let step = p.receive(frame(message)).unwrap();
            assert_eq!(step.write[0]["method"], "session/new", "{message}");
            assert!(
                step.events.iter().any(|e| e.kind == "note" && e.text == "Saved session could not be resumed; started a fresh session."),
                "{message}"
            );
        }

        // Any other harness keeps its sign-in text for the same frame.
        let mut cfg = config("opencode");
        cfg.resume_id = Some("saved-sess".into());
        let mut p = Protocol::new(cfg);
        p.receive(capabilities()).unwrap();
        assert_eq!(
            p.receive(frame("Session not found: saved-sess")).err().unwrap(),
            "opencode requires authentication. Sign in using its own CLI or official extension, then retry."
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_context_window_errors_are_neither_sign_in_nor_account_limits() {
        const CONTEXT: &str = "context window quota exceeded, try a shorter prompt";
        assert!(antigravity_context_error(&json!({"error":{"code":-32000,"message":"The CONTEXT window is full"}})));
        assert!(antigravity_context_error(&json!({"error":{"code":-32000,"message":"Quota","data":{"details":"context length exceeded"}}})));
        assert!(!antigravity_context_error(&json!({"error":{"code":-32000,"message":"Login required"}})));

        // Live, at session/prompt: the server's own text, with no sign-in advice.
        let mut p = Protocol::new(config("antigravity"));
        let err = p
            .receive(json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":CONTEXT}}))
            .err()
            .expect("the server's own error");
        assert_eq!(err, format!("antigravity: ACP session/prompt: {CONTEXT}"));

        // Live, at session/resume: the same, and no session/load or session/new retry.
        let mut cfg = config("antigravity");
        cfg.resume_id = Some("saved-sess".into());
        let mut p = Protocol::new(cfg);
        let mut caps = capabilities();
        caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
        p.receive(caps).unwrap();
        let err = p
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":CONTEXT}}))
            .err()
            .expect("the server's own error");
        assert_eq!(err, format!("antigravity: ACP session creation or resume: {CONTEXT}"));
        assert!(!p.acp_load_fallback_tried && !p.acp_fresh_fallback_tried);

        // Any other harness keeps its sign-in text for the same frame.
        let mut p = Protocol::new(config("opencode"));
        assert_eq!(
            p.receive(json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":CONTEXT}})).err().unwrap(),
            "opencode requires authentication. Sign in using its own CLI or official extension, then retry."
        );

        // Discovery: no sign-in wording either.
        let dir = std::env::temp_dir().join(format!("pandacode-agy-context-{}", uuid::Uuid::new_v4()));
        let failure = named_server_failure(&dir, "agy", true, r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"context window quota exceeded, try a shorter prompt"}}"#, true).await;
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!failure.authentication_required, "{}", failure.message);
        assert_eq!(failure.message, "ACP session/new: context window quota exceeded, try a shorter prompt");
        assert_eq!(connection_status(Err(failure)).state, "sessionFailed");
    }

    #[test]
    fn acp_missing_session_error_rejects_generic_not_found_and_bare_method_names() {
        // ACP standard RESOURCE_NOT_FOUND (-32002) matches regardless of wording.
        assert!(acp_missing_session_error(&json!({
            "error": {"code": -32002, "message": "Resource not found"}
        })));
        for matched in [
            "Failed to read session abc",
            "Session not found",
            "No such session: abc",
            "Unknown session id",
            "Session does not exist",
            "Cannot read session",
            "Could not find session",
            "Invalid session",
            "Please create a session or load it with session/load",
            "Conversation abc was not found",
        ] {
            assert!(
                acp_missing_session_error(&json!({"error": {"code": -32603, "message": matched}})),
                "should match: {matched}"
            );
        }
        for unmatched in [
            "File /Users/me/project/foo.rs not found",
            "Method session/load is not supported by this server",
            "Model gemini-9 not found",
            "Command not found: git",
        ] {
            assert!(
                !acp_missing_session_error(&json!({"error": {"code": -32603, "message": unmatched}})),
                "must NOT match: {unmatched}"
            );
        }
    }

    #[test]
    fn session_resume_error_falls_back_to_session_load_and_merges_config() {
        let mut cfg = config("antigravity");
        cfg.resume_id = Some("saved-sess".into());
        cfg.model = "gemini-4-neon".into();
        let mut p = Protocol::new(cfg);

        let mut caps = capabilities();
        caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
        let step = p.receive(caps).unwrap();
        assert_eq!(step.write[0]["method"], "session/resume");
        assert_eq!(step.write[0]["params"]["sessionId"], "saved-sess");

        // Streamed stale state during failed `session/resume` must be cleared before
        // `session/load` fallback runs.
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "saved-sess",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "type": "select", "currentValue": "plan", "options": [{"value": "plan"}]}
                    ]
                }
            }
        }))
        .unwrap();
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "saved-sess",
                "update": {"sessionUpdate": "usage_update", "used": 999, "size": 500000}
            }
        }))
        .unwrap();
        p.early_kimi_commands = Some(b"stale".to_vec());
        assert!(!p.acp_config.is_null());
        assert_eq!(p.acp_context_window, Some(500000));
        assert!(p.acp_saw_any_usage_update);

        // `session/resume` fails with unreadable session -> retries id 2 as `session/load`
        // and resets stale session state.
        let retry = p
            .receive(json!({
                "jsonrpc": "2.0",
                "id": 2,
                "error": {"code": -32603, "message": "Failed to read session saved-sess"}
            }))
            .unwrap();
        assert_eq!(retry.write[0]["id"], 2);
        assert_eq!(retry.write[0]["method"], "session/load");
        assert_eq!(retry.write[0]["params"]["sessionId"], "saved-sess");
        assert!(p.acp_config.is_null(), "stale acp_config must be cleared on session/load fallback");
        assert_eq!(p.acp_context_window, None);
        assert!(!p.acp_saw_any_usage_update);
        assert!(p.early_kimi_commands.is_none());

        // Streamed `config_option_update` arrives before `id == 2` response.
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "saved-sess",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{"value": "default"}]},
                        {"id": "model", "category": "model", "type": "select", "currentValue": "gemini-4-neon", "options": [{"value": "gemini-4-neon"}]}
                    ]
                }
            }
        }))
        .unwrap();

        // Empty `config_option_update` (`configOptions: []`) must NOT wipe previously streamed options!
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "saved-sess",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": []
                }
            }
        }))
        .unwrap();

        // `id == 2` response lacks `configOptions` -> previously streamed options are preserved!
        let loaded = p
            .receive(response(2, json!({"sessionId": "saved-sess", "configOptions": null})))
            .unwrap();
        // Both mode and model already match currentValue, so `unchanged()` skips straight to prompt.
        assert_eq!(loaded.write[0]["method"], "session/prompt");

        // Dead `resume_id`: `session/resume` (-32002) -> `session/load` -> fresh `session/new`, and never loops!
        let mut cfg2 = config("antigravity");
        cfg2.resume_id = Some("gone-sess".into());
        let mut p2 = Protocol::new(cfg2);
        let mut caps2 = capabilities();
        caps2["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}});
        p2.receive(caps2).unwrap();
        let retry2 = p2
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found"}}))
            .unwrap();
        assert_eq!(retry2.write[0]["method"], "session/load");
        assert_eq!(retry2.write[0]["params"]["sessionId"], "gone-sess");

        // Stale config/usage streamed during the doomed `session/load` must be wiped on fresh `session/new`.
        p2.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "gone-sess",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{"value": "default"}]}
                    ]
                }
            }
        }))
        .unwrap();
        p2.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "gone-sess",
                "update": {"sessionUpdate": "usage_update", "used": 42, "size": 128000}
            }
        }))
        .unwrap();
        p2.early_kimi_commands = Some(b"stale".to_vec());

        let fresh = p2
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found"}}))
            .unwrap();
        assert_eq!(fresh.write[0]["id"], 2);
        assert_eq!(fresh.write[0]["method"], "session/new");
        assert!(fresh.write[0]["params"].get("sessionId").is_none());
        assert!(p2.remote_id.is_empty());
        assert!(p2.config.resume_id.is_none());
        assert!(p2.acp_config.is_null(), "stale acp_config must be cleared on session/new fallback");
        assert_eq!(p2.acp_context_window, None);
        assert!(p2.acp_pending_phase0_usage.is_none(), "phase-0 usage from the dead session is discarded");
        assert!(!p2.acp_saw_any_usage_update);
        assert!(p2.early_kimi_commands.is_none());
        assert!(
            fresh.events.iter().any(|e| e.kind == "note" && e.text == "Saved session could not be resumed; started a fresh session."),
            "fresh fallback must emit a persisted note event"
        );
        assert!(
            fresh.events.iter().any(|e| e.kind == "status" && e.text == "Opening session"),
            "fresh fallback must update startup status"
        );

        // With `remote_id` empty, a `config_option_update` with `sessionId: ""` must be ignored.
        p2.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{"value": "default"}]}
                    ]
                }
            }
        }))
        .unwrap();
        assert!(p2.acp_config.is_null(), "config_option_update must be ignored when remote_id is empty");

        // If the fresh `session/new` ALSO fails, return the RPC error (never loop!).
        let err = p2
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Session not found"}}))
            .err()
            .unwrap();
        assert!(err.contains("Session not found"), "{err}");

        // Direct `session/load` (no `resume` capability) also falls back to fresh `session/new`.
        let mut cfg3 = config("antigravity");
        cfg3.resume_id = Some("gone-direct".into());
        let mut p3 = Protocol::new(cfg3);
        let step3 = p3.receive(capabilities()).unwrap();
        assert_eq!(step3.write[0]["method"], "session/load");
        let fresh3 = p3
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Session not found"}}))
            .unwrap();
        assert_eq!(fresh3.write[0]["method"], "session/new");
        assert!(fresh3.write[0]["params"].get("sessionId").is_none());
        assert!(fresh3.events.iter().any(|e| e.kind == "status" && e.text == "Opening session"));
    }

    #[test]
    fn rotated_account_does_not_open_a_fresh_session_for_a_missing_resume() {
        let mut cfg = config("antigravity");
        cfg.resume_id = Some("rotated".into());
        cfg.no_fresh_resume_fallback = true;
        let mut p = Protocol::new(cfg);
        let mut caps = capabilities();
        caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
        p.receive(caps).unwrap();
        p.acp_pending_phase0_usage = Some((9, Some(100)));
        let load = p
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Session not found"}}))
            .unwrap();
        assert_eq!(load.write[0]["method"], "session/load");
        assert!(p.acp_pending_phase0_usage.is_none());
        let err = p
            .receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Session not found"}}))
            .err()
            .unwrap();
        assert!(err.contains("Session not found"), "{err}");
        assert!(!p.acp_fresh_fallback_tried);
    }

    #[test]
    fn antigravity_resume_error_that_quotes_a_limit_rotates_instead_of_retrying() {
        let frame = json!({"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"session not found: quota exceeded for this model"}});
        assert!(acp_missing_session_error(&frame), "the frame also reads as a missing session");
        for rotated in [false, true] {
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("saved-sess".into());
            cfg.no_fresh_resume_fallback = rotated;
            let mut p = Protocol::new(cfg);
            let mut caps = capabilities();
            caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}, "load": {}});
            p.receive(caps).unwrap();
            let step = p.receive(frame.clone()).unwrap();
            assert_eq!(step.events.iter().filter(|e| e.kind == "limited").count(), 1, "one limited event rotates the account");
            assert!(step.failure.as_deref().is_some_and(|failure| failure.contains("quota exceeded for this model")), "{:?}", step.failure);
            assert!(step.write.is_empty(), "neither session/load nor session/new is written: {:?}", step.write);
            assert!(!p.acp_load_fallback_tried && !p.acp_fresh_fallback_tried);
        }

        // Any other harness keeps its missing-session retry for the same frame.
        let mut cfg = config("opencode");
        cfg.resume_id = Some("saved-sess".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.receive(capabilities()).unwrap().write[0]["method"], "session/load");
        let step = p.receive(frame).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        assert!(!step.events.iter().any(|e| e.kind == "limited"));
    }

    #[test]
    fn resume_without_a_load_capability_goes_straight_to_a_fresh_session() {
        let mut caps = capabilities();
        caps["result"]["agentCapabilities"]["loadSession"] = json!(false);
        caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume": {}});
        for rotated in [false, true] {
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("saved-sess".into());
            cfg.no_fresh_resume_fallback = rotated;
            let mut p = Protocol::new(cfg);
            assert_eq!(p.receive(caps.clone()).unwrap().write[0]["method"], "session/resume");
            let outcome = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Session not found"}}));
            if rotated {
                let err = outcome.err().expect("a rotated account returns the error");
                assert!(err.contains("Session not found"), "{err}");
                assert!(!p.acp_fresh_fallback_tried);
            } else {
                let step = outcome.unwrap();
                assert_eq!(step.write.len(), 1, "only the fresh session/new: {:?}", step.write);
                assert_eq!(step.write[0]["method"], "session/new");
                assert!(step.write[0]["params"].get("sessionId").is_none());
                assert!(step.events.iter().any(|e| e.kind == "note" && e.text == "Saved session could not be resumed; started a fresh session."));
            }
            assert!(!p.acp_load_fallback_tried, "an agent that cannot load sessions never sees session/load");
        }
    }

    #[test]
    fn model_switch_clears_the_previous_context_window() {
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-model".into();
        p.acp_context_window = Some(500_000);
        p.acp_config = json!({"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"gemini-4-neon","options":[{"value":"gemini-4-neon"}]}]});
        let step = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{"configOptions":[{"id":"model","type":"select","category":"model","currentValue":"gemini-4-neon","options":[{"value":"gemini-4-neon"}]}]}})).unwrap();
        assert_eq!(p.acp_context_window, None);
        assert!(step.write.iter().any(|request| request["method"] == "session/prompt"));
    }

    #[test]
    fn grok_catalog_does_not_inherit_antigravity_effort_variants() {
        let metadata = json!({
            "configOptions": [{
                "id": "model",
                "type": "select",
                "category": "model",
                "options": [{"value": "gemini-base", "name": "Gemini Base"}]
            }],
            "models": {"availableModels": [
                {"modelId": "gemini-base-high"},
                {"modelId": "gemini-base-low"}
            ]}
        });
        let grok = parse_models_for("grok", &metadata);
        let grok_base = grok.iter().find(|model| model.id == "gemini-base").unwrap();
        assert!(grok_base.reasoning_efforts.is_empty(), "grok must not derive antigravity efforts");
        let agy = parse_models(&metadata);
        let agy_base = agy.iter().find(|model| model.id == "gemini-base").unwrap();
        assert!(agy_base.reasoning_efforts.iter().any(|effort| effort.id == "high"));
        assert!(agy_base.reasoning_efforts.iter().any(|effort| effort.id == "low"));
    }

    #[test]
    fn named_connection_home_strips_global_gemini_dir_spellings() {
        let custom_home = if cfg!(windows) { r"C:\conn-home" } else { "/conn-home" };
        let chosen = if cfg!(windows) { r"C:\connection\gemini" } else { "/connection/gemini" };
        let mut command = tokio::process::Command::new("/usr/local/bin/agy");
        command.env("HOME", custom_home);
        command.env("GEMINI_DIR", "/global/gemini");
        command.env("gemini_dir", "/global/other");
        super::antigravity_gemini_dir_with(
            &mut command,
            Some(PathBuf::from("/process/home")),
            true,
            false,
            None,
        );
        let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let pos = args.iter().position(|arg| arg == "--gemini-dir").expect("pinned gemini dir");
        assert_eq!(args[pos + 1], PathBuf::from(custom_home).join(".gemini").to_string_lossy());
        assert_eq!(args.iter().filter(|arg| arg.starts_with("--gemini")).count(), 1);
        for key in ["GEMINI_DIR", "gemini_dir"] {
            assert!(
                command.as_std().get_envs().any(|(name, value)| name == key && value.is_none()),
                "{key} must be removed"
            );
        }

        // A connection that relocates HOME and chooses its own directory keeps that
        // choice, as the argument agy reads; the variable itself is removed.
        let mut kept = tokio::process::Command::new("/usr/local/bin/agy");
        kept.env("HOME", custom_home);
        kept.env("GEMINI_DIR", chosen);
        super::antigravity_gemini_dir_with(&mut kept, None, true, true, None);
        let args: Vec<_> = kept.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--gemini-dir".to_owned(), chosen.to_owned()]);
        assert!(kept.as_std().get_envs().any(|(name, value)| name == "GEMINI_DIR" && value.is_none()));
        assert!(super::connection_overrides_home(&[("HOME".into(), custom_home.into())]));
        assert!(!super::connection_overrides_home(&[("PATH".into(), "/bin".into())]));
        assert!(super::connection_sets_gemini_dir(&[("gemini_dir".into(), "/g".into())], &[]));
        assert!(super::connection_sets_gemini_dir(&[("ANTIGRAVITY_GEMINI_DIR".into(), "/g".into())], &[]));
        assert!(super::connection_sets_gemini_dir(&[], &["--gemini-dir".into(), "/g".into()]));
        assert!(!super::connection_sets_gemini_dir(&[("HOME".into(), custom_home.into())], &["--other".into()]));
    }

    #[test]
    fn live_steer_reply_settles_a_stopped_acp_run() {
        let mut p = Protocol::new(config("opencode"));
        p.acp_steers.live.push((2000, "steer-1".into(), "keep going".into()));
        assert!(p.acp_stop_settled(&json!({"jsonrpc":"2.0","id":2000,"result":{"stopReason":"end_turn"}})));
        assert!(p.acp_stop_settled(&json!({"jsonrpc":"2.0","id":3,"error":{"code":-32800,"message":"cancelled"}})));
        assert!(!p.acp_stop_settled(&json!({"jsonrpc":"2.0","id":2000,"method":"session/update"})));
        assert!(!p.acp_stop_settled(&json!({"jsonrpc":"2.0","id":2001,"result":{}})));
    }

    #[test]
    fn session_capabilities_reject_null_and_false() {
        for bad in [Value::Null, json!(false), json!("yes"), json!(1)] {
            let mut cfg = config("antigravity");
            cfg.resume_id = Some("existing".into());
            let mut caps = capabilities();
            caps["result"]["agentCapabilities"]["loadSession"] = json!(false);
            caps["result"]["agentCapabilities"]["sessionCapabilities"] = json!({
                "resume": bad,
                "load": bad,
                "close": bad,
            });
            assert!(!session_capability(&caps["result"]["agentCapabilities"], "resume"));
            assert!(!session_capability(&caps["result"]["agentCapabilities"], "load"));
            assert!(!session_capability(&caps["result"]["agentCapabilities"], "close"));
            let err = Protocol::new(cfg).receive(caps).err().unwrap();
            assert!(err.contains("cannot resume"), "{bad}: {err}");
        }
        let valid_obj = json!({"sessionCapabilities": {"resume": {}, "load": true, "close": {}}});
        assert!(session_capability(&valid_obj, "resume"));
        assert!(session_capability(&valid_obj, "load"));
        assert!(session_capability(&valid_obj, "close"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inspect_state_delivers_session_close_after_grace_timeout_and_mentions_agy_login() {
        let closed = std::env::temp_dir().join(format!("pandacode-close-{}", uuid::Uuid::new_v4()));
        let command = fixture(&format!(
            r#"
            read -r init
            printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"sessionCapabilities":{{"close":{{}}}}}}}}}}'
            read -r sess
            printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"close-me"}}}}'
            read -r close_req
            case "$close_req" in
                *'"method":"session/close"'*'"sessionId":"close-me"'*)
                    printf 'closed' > '{}'
                    printf '%s\n' '{{"jsonrpc":"2.0","id":9,"result":{{}}}}'
                    ;;
            esac
            "#,
            closed.display()
        ));
        // wait_commands=true with short grace forces the command-grace timeout before session/close.
        let (metadata, commands) = inspect_state(
            command,
            &std::env::temp_dir(),
            true,
            false,
            false,
            Duration::from_secs(2),
            Duration::from_millis(25),
        )
        .await
        .unwrap();
        assert_eq!(metadata["sessionId"], "close-me");
        assert!(commands.is_none());
        assert_eq!(std::fs::read_to_string(&closed).unwrap_or_default(), "closed");
        let _ = std::fs::remove_file(&closed);

        // `sessionCapabilities.close: null` or `false` must NOT send `session/close`.
        for bad in ["null", "false"] {
            let unexpected = std::env::temp_dir().join(format!("pandacode-noclose-{}", uuid::Uuid::new_v4()));
            let command = fixture(&format!(
                r#"
                read -r init
                printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"sessionCapabilities":{{"close":{bad}}}}}}}}}'
                read -r sess
                printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"keep-open"}}}}'
                if read -r next; then
                    printf '%s' "$next" > '{}'
                fi
                "#,
                unexpected.display()
            ));
            inspect_state(
                command,
                &std::env::temp_dir(),
                false,
                false,
                false,
                Duration::from_secs(2),
                Duration::from_millis(20),
            )
            .await
            .unwrap();
            assert!(!unexpected.exists(), "close={bad} must not send session/close");
        }

        // `-32000` auth error mentions `agy acp --login`.
        let auth_cmd = fixture(
            r#"
            read -r init
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            read -r sess
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Login required"}}'
            read -r hold
            "#,
        );
        let failure = inspect_state(
            auth_cmd,
            &std::env::temp_dir(),
            false,
            false,
            false,
            Duration::from_secs(2),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert!(failure.authentication_required);
        assert!(failure.message.contains("agy acp --login"), "{}", failure.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inspect_state_rejects_server_requests_while_closing() {
        let replied = std::env::temp_dir().join(format!("pandacode-close-reply-{}", uuid::Uuid::new_v4()));
        let command = fixture(&format!(
            r#"
            read -r init
            printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"sessionCapabilities":{{"close":{{}}}}}}}}}}'
            read -r sess
            printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"close-me"}}}}'
            read -r close_req
            printf '%s\n' '{{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{{}}}}'
            read -r first
            printf '%s\n' "$first" > '{}'
            printf '%s\n' '{{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{{}}}}'
            read -r second
            printf '%s\n' "$second" >> '{}'
            printf '%s\n' '{{"jsonrpc":"2.0","id":9,"result":{{}}}}'
            "#,
            replied.display(),
            replied.display()
        ));
        let (metadata, _) = inspect_state(
            command,
            &std::env::temp_dir(),
            false,
            false,
            false,
            Duration::from_secs(2),
            Duration::from_millis(50),
        )
        .await
        .unwrap();
        assert_eq!(metadata["sessionId"], "close-me");
        let replies = std::fs::read_to_string(&replied).unwrap_or_default();
        assert!(replies.contains("\"id\":9"), "{replies}");
        assert!(replies.contains("\"id\":77"), "{replies}");
        assert_eq!(replies.matches("-32601").count(), 2, "{replies}");
        let _ = std::fs::remove_file(&replied);
    }

    #[cfg(unix)]
    const INITIALIZED: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#;

    #[cfg(unix)]
    /// `/bin/sh` behind an `agy` or `agy_acp_server.par` link, so discovery runs
    /// under that executable's real program name. `reply` answers `initialize`,
    /// or the `session/new` after it once `ready`.
    async fn named_server_failure(dir: &Path, program: &str, ready: bool, reply: &str, antigravity: bool) -> DiscoveryFailure {
        std::fs::create_dir_all(dir).unwrap();
        let link = dir.join(program);
        if !link.exists() {
            std::os::unix::fs::symlink("/bin/sh", &link).unwrap();
        }
        let script = if ready {
            format!("read -r init; printf '%s\\n' '{INITIALIZED}'; read -r sess; printf '%s\\n' '{reply}'; read -r hold")
        } else {
            format!("read -r init; printf '%s\\n' '{reply}'; read -r hold")
        };
        let mut command = Command::new(dir.join(program));
        command.args(["-c", &script]);
        inspect_state(command, &std::env::temp_dir(), false, false, antigravity, Duration::from_secs(2), Duration::from_millis(20))
            .await
            .unwrap_err()
    }

    #[cfg(unix)]
    fn assert_account_limit(failure: DiscoveryFailure, acp_ready: bool, own_text: &str, state: &str) {
        assert_eq!(failure.acp_ready, acp_ready, "{}", failure.message);
        assert!(!failure.authentication_required, "{}", failure.message);
        for forbidden in ["Sign in", "Authentication is required", "agy acp --login"] {
            assert!(!failure.message.contains(forbidden), "{forbidden} must not appear in: {}", failure.message);
        }
        assert!(
            failure
                .message
                .starts_with("The Antigravity account has reached its quota, is out of credits or is rate limited."),
            "{}",
            failure.message
        );
        assert!(failure.message.ends_with(own_text), "the server's own text must follow: {}", failure.message);
        let status = connection_status(Err(failure));
        assert_eq!(status.state, state);
        assert!(!status.session_ready);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_discovery_reports_out_of_credits_as_a_limit_not_sign_in() {
        let dir = std::env::temp_dir().join(format!("pandacode-agy-credits-{}", uuid::Uuid::new_v4()));
        // Both Antigravity launch paths: the agy CLI and the standalone server binary.
        for program in ["agy", "agy_acp_server.par"] {
            assert_account_limit(
                named_server_failure(&dir, program, true, r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"AI credits balance is too low. Add credits to continue."}}"#, true).await,
                true,
                "ACP session/new: AI credits balance is too low. Add credits to continue.",
                "sessionFailed",
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_discovery_reports_a_429_as_a_limit_not_sign_in() {
        let dir = std::env::temp_dir().join(format!("pandacode-agy-429-{}", uuid::Uuid::new_v4()));
        let frame = |id: u64| {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"RESOURCE_EXHAUSTED: Too many requests (code 429). Resets in 45m."}}).to_string()
        };
        // A 429 on `initialize` fails startup; on `session/new` it fails the session.
        for (program, ready, stage, state) in [
            ("agy", true, "session/new", "sessionFailed"),
            ("agy_acp_server.par", false, "initialize", "startupFailed"),
        ] {
            assert_account_limit(
                named_server_failure(&dir, program, ready, &frame(if ready { 2 } else { 1 }), true).await,
                ready,
                &format!("ACP {stage}: RESOURCE_EXHAUSTED: Too many requests (code 429). Resets in 45m."),
                state,
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_keeps_sign_in_for_a_real_sign_in_error_and_for_other_harnesses() {
        let dir = std::env::temp_dir().join(format!("pandacode-agy-login-{}", uuid::Uuid::new_v4()));
        // A genuine Antigravity sign-in error still asks for `agy acp --login`: the old
        // fixture and agy's own "Authentication required".
        for message in ["Login required", "Authentication required"] {
            let failure = named_server_failure(&dir, "agy", true, &json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":message}}).to_string(), true).await;
            assert!(failure.authentication_required, "{message}");
            assert_eq!(
                failure.message,
                format!("Authentication is required by the ACP server. Sign in using its CLI (such as `agy acp --login`) or official extension, then check again.\nACP session/new: {message}"),
                "{message}"
            );
            assert_eq!(connection_status(Err(failure)).state, "authenticationRequired", "{message}");
        }
        let _ = std::fs::remove_dir_all(&dir);

        // Another harness answering the same credits frame is reported as before.
        let command = fixture(&format!(
            "read -r init; printf '%s\\n' '{INITIALIZED}'; read -r sess; printf '%s\\n' '{}'; read -r hold",
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"AI credits balance is too low. Add credits to continue."}}"#
        ));
        let failure = inspect_state(command, &std::env::temp_dir(), false, false, false, Duration::from_secs(2), Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(failure.authentication_required);
        assert_eq!(
            failure.message,
            "Authentication is required by the ACP server. Sign in using its CLI (such as `agy acp --login`) or official extension, then check again.\nACP session/new: AI credits balance is too low. Add credits to continue."
        );
        assert_eq!(connection_status(Err(failure)).state, "authenticationRequired");
    }

    #[cfg(unix)]
    #[test]
    fn agent_temp_is_swept_once_per_process_across_discoveries() {
        if crate::secret_store::dir().is_none() {
            let root = std::env::temp_dir().join(format!("pandacode-acp-sweep-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            crate::secret_store::setup(&root);
        }
        // A running agent keeps its unpacked runtime in agent-temp, so a second discovery
        // or connection check must not sweep under it.
        let before = super::super::agent_temp_sweeps();
        let _first = ScratchDir::new("acp-sweep").unwrap();
        let _second = ScratchDir::new("acp-sweep").unwrap();
        assert_eq!(super::super::agent_temp_sweeps(), before.max(1), "one sweep per process");
    }

    #[cfg(unix)]
    #[test]
    fn scratch_dir_lives_in_the_private_agent_temp_folder() {
        use std::os::unix::fs::PermissionsExt;
        if crate::secret_store::dir().is_none() {
            let root = std::env::temp_dir().join(format!("pandacode-acp-scratch-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            crate::secret_store::setup(&root);
        }
        let base = crate::secret_store::dir().unwrap().join(super::super::AGENT_TEMP_DIR);
        let scratch = ScratchDir::new("acp-models").unwrap();
        let path = scratch.path().to_path_buf();
        assert!(path.starts_with(&base), "{}", path.display());
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "agent-temp");
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("pandacode-acp-models-"));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        drop(scratch);
        assert!(!path.exists());
    }

    #[test]
    fn agy_1_5_13_models_derive_per_model_efforts_from_available_models() {
        // Recorded shape from `agy 1.5.13 acp` `session/new`.
        let session = json!({
            "sessionId": "agy-session-1",
            "configOptions": [
                {
                    "id": "mode",
                    "category": "mode",
                    "type": "select",
                    "currentValue": "default",
                    "options": [
                        {"value": "default", "name": "Default"},
                        {"value": "accept-edits", "name": "Accept Edits"},
                        {"value": "plan", "name": "Plan"},
                        {"value": "auto", "name": "Auto"}
                    ]
                },
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gemini-4-neon",
                    "options": [
                        {"value": "gemini-4-neon", "name": "Gemini 4 Neon"},
                        {"value": "gemini-4-carbon", "name": "Gemini 4 Carbon"},
                        {"value": "gemini-pro-orchestrator-2", "name": "Gemini Pro Orchestrator"},
                        {"value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)"}
                    ]
                },
                {
                    "id": "thought_level",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "high",
                    "options": [
                        {"value": "low", "name": "Low"},
                        {"value": "medium", "name": "Medium"},
                        {"value": "high", "name": "High"},
                        {"value": "xhigh", "name": "Extra"}
                    ]
                }
            ],
            "models": {
                "currentModelId": "gemini-4-neon-high",
                "availableModels": [
                    {"modelId": "gemini-4-neon-low", "name": "Gemini 4 Neon (Low)"},
                    {"modelId": "gemini-4-neon-medium", "name": "Gemini 4 Neon (Medium)"},
                    {"modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)"},
                    {"modelId": "gemini-4-neon-xhigh", "name": "Gemini 4 Neon (Extra)"},
                    {"modelId": "gemini-4-carbon-low", "name": "Gemini 4 Carbon (Low)"},
                    {"modelId": "gemini-4-carbon-medium", "name": "Gemini 4 Carbon (Medium)"},
                    {"modelId": "gemini-4-carbon-high", "name": "Gemini 4 Carbon (High)"},
                    {"modelId": "gemini-pro-orchestrator-2", "name": "Gemini Pro Orchestrator"},
                    {"modelId": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)"}
                ]
            }
        });
        let models = parse_models(&session);
        let find = |id: &str| models.iter().find(|m| m.id == id).unwrap();

        let neon = find("gemini-4-neon");
        assert_eq!(
            neon.reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["low", "medium", "high", "xhigh"]
        );
        assert_eq!(neon.reasoning_efforts[3].name, "Extra");
        assert_eq!(neon.default_reasoning_effort.as_deref(), Some("high"));

        let carbon = find("gemini-4-carbon");
        assert_eq!(
            carbon.reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        assert_eq!(carbon.default_reasoning_effort.as_deref(), Some("high"));

        assert!(find("gemini-pro-orchestrator-2").reasoning_efforts.is_empty());
        assert!(find("gpt-oss-120b-medium").reasoning_efforts.is_empty());

        // Guards: explicit empty `thought_level: []` on `current` stays authoritative,
        // and standalone base models like `foo-max` in `configOptions["model"]` are not
        // misread as effort variants of `foo`.
        let guarded = json!({
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gemini-4-neon",
                    "options": [
                        {"value": "gemini-4-neon", "name": "Gemini 4 Neon"},
                        {"value": "foo", "name": "Foo"},
                        {"value": "foo-max", "name": "Foo Max"}
                    ]
                },
                {
                    "id": "thought_level",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "",
                    "options": []
                }
            ],
            "models": {
                "currentModelId": "gemini-4-neon",
                "availableModels": [
                    {"modelId": "gemini-4-neon-high"},
                    {"modelId": "foo"},
                    {"modelId": "foo-low"},
                    {"modelId": "foo-max"}
                ]
            }
        });
        let guarded_models = parse_models(&guarded);
        let find_g = |id: &str| guarded_models.iter().find(|m| m.id == id).unwrap();
        assert!(
            find_g("gemini-4-neon").reasoning_efforts.is_empty(),
            "explicit empty thought_level on current model must stay empty"
        );
        assert_eq!(
            find_g("foo").reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["low"],
            "standalone base model foo-max must not be derived as an effort variant of foo"
        );
    }

    #[test]
    fn antigravity_modes_unchanged_skips_redundant_rpcs_and_stop_settled() {
        let mode_options = json!([
            {"value": "default", "name": "Default"},
            {"value": "accept-edits", "name": "Accept Edits"},
            {"value": "plan", "name": "Plan"},
            {"value": "auto", "name": "Auto"}
        ]);
        for (mode, expected) in [
            ("ask", "default"),
            ("auto", "accept-edits"),
            ("plan", "plan"),
            ("full", "auto"),
        ] {
            let mut cfg = config("antigravity");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            p.receive(capabilities()).unwrap();
            let current = if expected == "default" { "plan" } else { "default" };
            let step = p
                .receive(response(
                    2,
                    json!({
                        "sessionId": "ag-mode",
                        "configOptions": [{
                            "id": "mode",
                            "category": "mode",
                            "type": "select",
                            "currentValue": current,
                            "options": mode_options
                        }]
                    }),
                ))
                .unwrap();
            assert_eq!(step.write[0]["method"], "session/set_config_option", "{mode}");
            assert_eq!(step.write[0]["params"]["value"], expected, "{mode}");
        }

        // Unchanged mode/model/thought_level skips all 3 `session/set_config_option` RPCs.
        let mut cfg = config("antigravity");
        cfg.mode = "ask".into();
        cfg.model = "gemini-4-neon".into();
        cfg.reasoning_effort = Some("high".into());
        let mut p = Protocol::new(cfg);
        p.receive(capabilities()).unwrap();
        let step = p
            .receive(response(
                2,
                json!({
                    "sessionId": "ag-fast",
                    "configOptions": [
                        {"id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": mode_options},
                        {"id": "model", "category": "model", "type": "select", "currentValue": "gemini-4-neon", "options": [{"value": "gemini-4-neon"}]},
                        {"id": "thought_level", "category": "thought_level", "type": "select", "currentValue": "high", "options": [{"value": "high"}]}
                    ]
                }),
            ))
            .unwrap();
        assert_eq!(step.write.len(), 1);
        assert_eq!(step.write[0]["method"], "session/prompt");

        // `acp_stop_settled` recognizes ACP `id == 3` replies and ignores notifications or other ids.
        let settled = Protocol::new(config("antigravity"));
        assert!(settled.acp_stop_settled(&json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}})));
        assert!(Protocol::new(config("opencode")).acp_stop_settled(&json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"cancelled"}})));
        assert!(!settled.acp_stop_settled(&json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"s"}})));
        assert!(!settled.acp_stop_settled(&json!({"jsonrpc":"2.0","method":"session/update","params":{}})));
        assert!(!Protocol::new(config("claude")).acp_stop_settled(&json!({"jsonrpc":"2.0","id":3,"result":{}})));
    }

    #[test]
    fn turn_end_usage_fallback_is_antigravity_only() {
        // Antigravity's turn-end `result.usage` is window occupancy; other agents report a
        // per-call sum there, so their meter keeps the last `usage_update`.
        let end = response(3, json!({"stopReason": "end_turn", "usage": {"inputTokens": 500, "totalTokens": 600}}));
        let mut agy = Protocol::new(config("antigravity"));
        agy.remote_id = "ag-end".into();
        let step = agy.receive(end.clone()).unwrap();
        assert_eq!(step.events.iter().find(|e| e.kind == "usage").expect("antigravity turn-end usage").data.as_ref().unwrap()["usedTokens"], 500);
        for provider in ["opencode", "cline"] {
            let mut p = Protocol::new(config(provider));
            p.remote_id = "remote".into();
            let step = p.receive(end.clone()).unwrap();
            assert!(step.done, "{provider}");
            assert!(step.events.iter().all(|e| e.kind != "usage"), "{provider} keeps its last usage_update");
        }
    }

    #[test]
    fn antigravity_usage_update_before_prompt_thought_null_type_and_turn_end_usage() {
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-u".into();
        // Phase 0 `usage_update` is kept, but not emitted until the session is open.
        let step = p
            .receive(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "ag-u",
                    "update": {"sessionUpdate": "usage_update", "used": 12000, "size": 1000000}
                }
            }))
            .unwrap();
        assert!(step.events.iter().all(|e| e.kind != "usage"), "phase 0 usage waits");
        assert_eq!(p.acp_pending_phase0_usage, Some((12000, Some(1_000_000))));
        assert_eq!(p.acp_context_window, Some(1_000_000));
        assert!(p.acp_saw_any_usage_update);
        assert!(!p.acp_saw_usage_update);
        let mut flushed = Step::default();
        p.flush_pending_phase0_usage(&mut flushed);
        let usage = flushed.events.iter().find(|e| e.kind == "usage").expect("deferred phase 0 usage");
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 12000);
        assert_eq!(usage.data.as_ref().unwrap()["contextWindow"], 1000000);
        assert!(p.acp_pending_phase0_usage.is_none());
        assert!(!p.acp_saw_usage_update);

        // `agent_thought_chunk` with missing `type` is accepted.
        p.phase = 1;
        let thought = p
            .receive(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "ag-u",
                    "update": {"sessionUpdate": "agent_thought_chunk", "content": {"text": "Thinking..."}}
                }
            }))
            .unwrap();
        assert!(thought.events.iter().any(|e| e.kind == "thinking" && e.text == "Thinking..."));

        // Turn-end `result.usage` reported when no turn-phase `usage_update` arrived:
        // prefers `inputTokens` and preserves `contextWindow` from phase-0 `usage_update`,
        // including when turn-end reports `contextWindow: 0`.
        let end = p
            .receive(response(
                3,
                json!({"stopReason": "end_turn", "usage": {"inputTokens": 500, "outputTokens": 100, "totalTokens": 600, "contextWindow": 0}}),
            ))
            .unwrap();
        assert!(end.done);
        let end_usage = end.events.iter().find(|e| e.kind == "usage").expect("turn-end usage");
        assert_eq!(end_usage.data.as_ref().unwrap()["usedTokens"], 500);
        assert_eq!(end_usage.data.as_ref().unwrap()["contextWindow"], 1000000);

        // `usage_update` with `size: 0` preserves cached `acp_context_window` instead of dropping usage.
        let zero_size = p
            .receive(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "ag-u",
                    "update": {"sessionUpdate": "usage_update", "used": 18000, "size": 0}
                }
            }))
            .unwrap();
        let zero_size_usage = zero_size.events.iter().find(|e| e.kind == "usage").expect("size: 0 usage");
        assert_eq!(zero_size_usage.data.as_ref().unwrap()["usedTokens"], 18000);
        assert_eq!(zero_size_usage.data.as_ref().unwrap()["contextWindow"], 1000000);
        p.acp_saw_usage_update = false;

        // Invalid `usage_update` (`used > 1_000_000_000`) must not mark usage as seen or block turn-end fallback.
        let mut p_overflow = Protocol::new(config("antigravity"));
        p_overflow.remote_id = "ag-ovf".into();
        p_overflow.phase = 1;
        let ovf = p_overflow
            .receive(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "ag-ovf",
                    "update": {"sessionUpdate": "usage_update", "used": 2_000_000_000u64, "size": 200000}
                }
            }))
            .unwrap();
        assert!(!ovf.events.iter().any(|e| e.kind == "usage"));
        assert!(!p_overflow.acp_saw_any_usage_update);
        assert!(!p_overflow.acp_saw_usage_update);
        let ovf_end = p_overflow
            .receive(response(3, json!({"stopReason": "end_turn", "usage": {"totalTokens": 321, "contextWindow": 0}})))
            .unwrap();
        let ovf_usage = ovf_end.events.iter().find(|e| e.kind == "usage").expect("fallback after overflow");
        assert_eq!(ovf_usage.data.as_ref().unwrap()["usedTokens"], 321);
        assert_eq!(ovf_usage.data.as_ref().unwrap()["contextWindow"], 200000);

        // When `usage_update` has been seen earlier in the session, a turn-end `totalTokens`-only
        // payload must NOT clobber accurate context occupancy.
        let end_total_only = p
            .receive(response(
                3,
                json!({"stopReason": "end_turn", "usage": {"totalTokens": 99999}}),
            ))
            .unwrap();
        assert!(!end_total_only.events.iter().any(|e| e.kind == "usage"));

        // When NO `usage_update` was ever seen, `totalTokens` fallback is still used.
        let mut p_fresh = Protocol::new(config("antigravity"));
        p_fresh.remote_id = "ag-fresh".into();
        p_fresh.phase = 1;
        let end_fresh = p_fresh
            .receive(response(
                3,
                json!({"stopReason": "end_turn", "usage": {"totalTokens": 777}}),
            ))
            .unwrap();
        let fresh_usage = end_fresh.events.iter().find(|e| e.kind == "usage").expect("fresh fallback usage");
        assert_eq!(fresh_usage.data.as_ref().unwrap()["usedTokens"], 777);
        assert!(fresh_usage.data.as_ref().unwrap()["contextWindow"].is_null());

        // When a turn-phase `usage_update` arrived, turn-end `result.usage` is skipped completely.
        p.receive(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "ag-u",
                "update": {"sessionUpdate": "usage_update", "used": 25000, "size": 1000000}
            }
        }))
        .unwrap();
        let end_after_live = p
            .receive(response(
                3,
                json!({"stopReason": "end_turn", "usage": {"inputTokens": 500, "totalTokens": 600}}),
            ))
            .unwrap();
        assert!(!end_after_live.events.iter().any(|e| e.kind == "usage"));
    }

    #[test]
    fn antigravity_self_scoped_mcp_auto_approval_and_deduplication() {
        let mut p = Protocol::new(config("antigravity"));
        p.remote_id = "ag-mcp".into();
        p.phase = 1;
        p.mcp_server = Some(json!({}));
        p.mcp_tool_names.insert("pandacode_title".into());
        p.mcp_tool_names.insert("pandacode_run_project".into());

        // Self-scoped MCP tool auto-approved with single `allow_once` ONLY for the
        // exact Antigravity MCP prefixes and `"" | "other"` kind.
        let perm = |title: &str, kind: &str| {
            json!({
                "jsonrpc": "2.0",
                "id": 42,
                "method": "session/request_permission",
                "params": {
                    "sessionId": "ag-mcp",
                    "toolCall": {"toolCallId": "tc1", "title": title, "kind": kind},
                    "options": [
                        {"optionId": "allow", "kind": "allow_once"},
                        {"optionId": "deny", "kind": "reject_once"}
                    ]
                }
            })
        };
        // Only an absent, null or empty `locations` qualifies: an object, string,
        // number or boolean is not "no locations" and must wait for the user.
        let locations_gate = |p: &mut Protocol, title: &str| {
            for locations in [json!({"path": "src/main.rs"}), json!("src/main.rs"), json!(1), json!(true)] {
                let mut request = perm(title, "other");
                request["params"]["toolCall"]["locations"] = locations.clone();
                assert!(p.receive(request).unwrap().write.is_empty(), "locations={locations} must wait for the user");
            }
            for locations in [Value::Null, json!([])] {
                let mut request = perm(title, "other");
                request["params"]["toolCall"]["locations"] = locations.clone();
                assert_eq!(p.receive(request).unwrap().write[0]["result"]["outcome"]["optionId"], "allow", "locations={locations}");
            }
        };
        for title in [
            "mcp__pandacode_architect__pandacode_title",
            "mcp_pandacode_architect_pandacode_title",
        ] {
            for kind in ["", "other"] {
                let step = p.receive(perm(title, kind)).unwrap();
                assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow", "{title} ({kind})");
            }
        }
        for rejected in [
            "pandacode_architect__pandacode_title",
            "pandacode_architect:pandacode_title",
        ] {
            assert!(
                p.receive(perm(rejected, "other")).unwrap().write.is_empty(),
                "{rejected} is not an Antigravity MCP prefix"
            );
        }
        // Path-like `/` and `.` prefixes and bare unprefixed titles must NEVER auto-approve!
        for rejected in [
            "pandacode_title",
            "pandacode_architect/pandacode_title",
            "pandacode_architect.pandacode_title",
        ] {
            assert!(
                p.receive(perm(rejected, "other")).unwrap().write.is_empty(),
                "{rejected} must wait for user"
            );
        }
        // State-changing or built-in tool kinds must NEVER bypass approval even with explicit prefix!
        for kind in ["execute", "edit", "delete", "move", "fetch", "read", "search", "think"] {
            assert!(
                p.receive(perm("mcp__pandacode_architect__pandacode_title", kind))
                    .unwrap()
                    .write
                    .is_empty(),
                "kind={kind} must never auto-approve"
            );
        }
        // Non-self-scoped registered tool still asks the user.
        assert!(p.receive(perm("mcp__pandacode_architect__pandacode_run_project", "other")).unwrap().write.is_empty());

        // Filesystem locations, a missing id, or a non-MCP id block auto-approval.
        let mut located = perm("mcp__pandacode_architect__pandacode_title", "other");
        located["params"]["toolCall"]["locations"] = json!([{"path": "src/main.rs"}]);
        assert!(p.receive(located).unwrap().write.is_empty(), "locations must wait for the user");
        locations_gate(&mut p, "mcp__pandacode_architect__pandacode_title");
        let mut empty_id = perm("mcp__pandacode_architect__pandacode_title", "other");
        empty_id["params"]["toolCall"]["toolCallId"] = json!("");
        assert!(p.receive(empty_id).unwrap().write.is_empty(), "empty toolCallId must wait");
        p.non_mcp_tools.insert("tc1".into());
        assert!(
            p.receive(perm("mcp__pandacode_architect__pandacode_title", "")).unwrap().write.is_empty(),
            "a non-MCP tool id must not auto-approve"
        );
        p.non_mcp_tools.clear();
        let long_id = "t".repeat(300);
        p.non_mcp_tools.insert(super::super::limited(&long_id, 256));
        let mut truncated = perm("mcp__pandacode_architect__pandacode_title", "other");
        truncated["params"]["toolCall"]["toolCallId"] = json!(long_id);
        assert!(p.receive(truncated).unwrap().write.is_empty(), "truncated non-MCP id must not auto-approve");
        p.non_mcp_tools.clear();

        // Without the registered MCP server, even a perfect title waits.
        p.mcp_server = None;
        assert!(p.receive(perm("mcp__pandacode_architect__pandacode_title", "other")).unwrap().write.is_empty());
        p.mcp_server = Some(json!({}));

        // DeepSeek (`dsh`) reports every tool as `kind: "other"`, so `self_scoped_mcp_tool`
        // must always refuse auto-approval on `"deepseek"`.
        let mut p_ds = Protocol::new(config("deepseek"));
        p_ds.remote_id = "ag-mcp".into();
        p_ds.phase = 1;
        p_ds.mcp_server = Some(json!({}));
        p_ds.mcp_tool_names.insert("pandacode_title".into());
        assert!(
            p_ds.receive(perm("mcp__pandacode_architect__pandacode_title", "other"))
                .unwrap()
                .write
                .is_empty(),
            "deepseek must never auto-approve via self_scoped_mcp_tool"
        );

        // Other ACP harnesses are not in the auto-approval set.
        let mut p_open = Protocol::new(config("opencode"));
        p_open.remote_id = "ag-mcp".into();
        p_open.phase = 1;
        p_open.mcp_server = Some(json!({}));
        p_open.mcp_tool_names.insert("pandacode_title".into());
        assert!(
            p_open.receive(perm("mcp__pandacode_architect__pandacode_title", "other")).unwrap().write.is_empty(),
            "opencode must not auto-approve MCP titles"
        );

        // On Cline, require `cline::host_tool` (no fallback to bare title or other prefixes).
        // Cline has no ACP `mcp_server`; the registered names are enough.
        let mut p_cline = Protocol::new(config("cline"));
        p_cline.remote_id = "ag-mcp".into();
        p_cline.phase = 1;
        p_cline.mcp_server = None;
        p_cline.mcp_tool_names.insert("pandacode_title".into());
        assert_eq!(
            p_cline.receive(perm("pandacode_architect__pandacode_title: {}", "other")).unwrap().write[0]["result"]["outcome"]["optionId"],
            "allow"
        );
        for rejected in [
            "pandacode_title",
            "mcp__pandacode_architect__pandacode_title",
            "pandacode_architect:pandacode_title",
        ] {
            assert!(
                p_cline.receive(perm(rejected, "other")).unwrap().write.is_empty(),
                "cline must reject {rejected}"
            );
        }
        assert!(
            p_cline.receive(perm("pandacode_architect__pandacode_title: {}", "execute")).unwrap().write.is_empty(),
            "cline must reject non-other kind"
        );
        locations_gate(&mut p_cline, "pandacode_architect__pandacode_title: {}");

        // Unambiguous prefixed MCP tool calls are deduplicated in `tool_update`.
        for title in [
            "mcp__pandacode_architect__pandacode_title",
            "mcp_pandacode_architect_pandacode_title",
            "pandacode_architect__pandacode_title",
            "pandacode_architect:pandacode_title",
        ] {
            let step = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "ag-mcp",
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": title,
                            "title": title,
                            "status": "in_progress"
                        }
                    }
                }))
                .unwrap();
            assert!(!step.events.iter().any(|e| e.kind == "tool"), "{title} should be deduplicated");
        }
        // Path-like `/` and `.` prefixes are NOT treated as MCP namespaces and stay visible.
        for title in [
            "pandacode_architect/pandacode_title",
            "pandacode_architect.pandacode_title",
        ] {
            let step = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "ag-mcp",
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": title,
                            "title": title,
                            "status": "in_progress"
                        }
                    }
                }))
                .unwrap();
            assert!(step.events.iter().any(|e| e.kind == "tool"), "{title} must stay visible");
        }

        // Built-in / non-MCP tool with `kind: "execute"` must NOT be hidden even with an
        // explicit MCP prefix, must stay visible across `tool_call_update` omitting `kind`,
        // AND its `toolCallId` must NEVER auto-approve when a later permission omits `kind`.
        for (call_id, title) in [
            ("exec-conflict", "pandacode_title"),
            ("exec-prefixed", "pandacode_architect:pandacode_title"),
        ] {
            let exec_start = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "ag-mcp",
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": call_id,
                            "title": title,
                            "kind": "execute",
                            "status": "in_progress"
                        }
                    }
                }))
                .unwrap();
            assert!(
                exec_start.events.iter().any(|e| e.kind == "tool"),
                "non-MCP execute tool ({title}) must stay visible"
            );
            let perm_no_kind = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "id": 43,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "ag-mcp",
                        "toolCall": {"toolCallId": call_id, "title": "pandacode_architect:pandacode_title"},
                        "options": [
                            {"optionId": "allow", "kind": "allow_once"},
                            {"optionId": "deny", "kind": "reject_once"}
                        ]
                    }
                }))
                .unwrap();
            assert!(
                perm_no_kind.write.is_empty(),
                "toolCallId {call_id} recorded in non_mcp_tools must NEVER auto-approve when permission omits kind"
            );
            let exec_done = p
                .receive(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "ag-mcp",
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": call_id,
                            "status": "completed"
                        }
                    }
                }))
                .unwrap();
            assert!(
                exec_done.events.iter().any(|e| e.kind == "tool"),
                "subsequent update for non-MCP execute tool ({title}) must stay visible"
            );
        }
    }
}
