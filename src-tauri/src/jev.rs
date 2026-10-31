//! Optional, externally installed Jev browser testing. Secrets only cross private stdin.
use crate::{providers::ProcessGroup, AppState, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

const SOURCE: &str = "https://github.com/browser-use/jev-ultrafast/archive/1231850a0bf1a0c0341fe408ef1668dbbfdfac46.zip";
const MAX_LINE: usize = 64 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_REPORT: usize = 256 * 1024;
const MAX_SCREENSHOT: u64 = 2 * 1024 * 1024;
const MAX_LIVE_FRAME: u64 = 256 * 1024;
const WATCH_TTL: Duration = Duration::from_secs(10);
const HISTORY: usize = 20;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    #[serde(default)]
    pub decisions_enabled: bool,
    /// "typesafe" (default) or "openrouter"; the OpenRouter key lives in `secret_store`.
    #[serde(default = "default_provider")]
    pub decision_provider: String,
    #[serde(default)]
    pub decision_model: String,
    pub python_path: String,
    pub chrome_path: String,
    pub text_model: String,
    pub text_base_url: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            decisions_enabled: false,
            decision_provider: default_provider(),
            decision_model: String::new(),
            python_path: String::new(),
            chrome_path: String::new(),
            text_model: "inception/mercury-2.5".into(),
            text_base_url: "https://openrouter.ai/api/v1".into(),
        }
    }
}
fn default_provider() -> String {
    "typesafe".into()
}
const SECRET_SERVICE: &str = "app.pandacode.jev";
const OPENROUTER_ACCOUNT: &str = "openrouter";
fn openrouter_key() -> Option<String> {
    crate::secret_store::get(SECRET_SERVICE, OPENROUTER_ACCOUNT)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    typesafe_key: String,
    #[serde(default)]
    text_key: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    #[serde(flatten)]
    settings: Settings,
    typesafe_key_saved: bool,
    text_key_saved: bool,
    openrouter_key_saved: bool,
}
impl From<&Saved> for Configuration {
    fn from(saved: &Saved) -> Self {
        Self {
            settings: saved.settings.clone(),
            typesafe_key_saved: !saved.typesafe_key.is_empty(),
            text_key_saved: !saved.text_key.is_empty(),
            openrouter_key_saved: openrouter_key().is_some(),
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Doctor {
    pub ready: bool,
    #[serde(default)]
    pub python_version: String,
    #[serde(default)]
    pub jev_version: String,
    #[serde(default)]
    pub chrome_path: String,
    #[serde(default)]
    pub issues: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub url: String,
    pub goal: String,
    #[serde(default = "default_steps")]
    pub max_steps: u32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
    #[serde(default = "default_viewport")]
    pub viewport: String,
    #[serde(default)]
    pub expected_text: Option<String>,
    #[serde(default)]
    pub expected_title: Option<String>,
    #[serde(default)]
    pub expected_url: Option<String>,
}
fn default_steps() -> u32 {
    20
}
fn default_timeout() -> u32 {
    180
}
fn default_viewport() -> String {
    "desktop".into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub passed: bool,
    pub expected: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub step: u32,
    pub operation: String,
    pub target: String,
    pub url: String,
    pub elapsed_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub session_id: String,
    pub url: String,
    pub goal: String,
    pub viewport: String,
    pub status: String,
    pub verification: String,
    pub summary: String,
    pub created_at: i64,
    pub duration_ms: u64,
    pub steps: u32,
    pub checks: Vec<Check>,
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
impl Report {
    fn starting(session_id: &str, request: &Request) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            url: request.url.clone(),
            goal: request.goal.clone(),
            viewport: request.viewport.clone(),
            status: "starting".into(),
            verification: "not_checked".into(),
            summary: "Starting isolated browser…".into(),
            created_at: crate::storage::now(),
            duration_ms: 0,
            steps: 0,
            checks: Vec::new(),
            events: Vec::new(),
            screenshot: None,
            title: None,
        }
    }
}
struct Active {
    report: Report,
    stopped: Arc<AtomicBool>,
    watch_until: Option<Instant>,
    watch_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveFrame {
    session_id: String,
    run_id: String,
    sequence: u64,
    data_url: String,
    width: u32,
    height: u32,
    elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrameNotice {
    #[serde(rename = "type")]
    kind: String,
    sequence: u64,
    sha256: String,
    width: u32,
    height: u32,
    elapsed_ms: u64,
}
struct Runtime {
    dir: PathBuf,
    saved: Saved,
    active: HashMap<String, Active>,
    installing: bool,
    setup_warning: Option<String>,
}
static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
fn runtime() -> Result<std::sync::MutexGuard<'static, Runtime>> {
    RUNTIME
        .get()
        .ok_or("Jev settings are not initialized.")?
        .lock()
        .map_err(|_| "Jev settings are unavailable.".into())
}

pub fn setup(parent: &Path) -> Result<()> {
    let dir = parent.join("jev");
    private_dir(&dir)?;
    let path = dir.join("settings.json");
    let (saved, setup_warning) = load_saved(&path);
    cleanup_interrupted_profiles(&dir);
    RUNTIME
        .set(Mutex::new(Runtime {
            dir,
            saved,
            active: HashMap::new(),
            installing: false,
            setup_warning,
        }))
        .map_err(|_| "Jev settings are already initialized.".into())
}
fn load_saved(path: &Path) -> (Saved, Option<String>) {
    if !path.exists() {
        return (Saved::default(), None);
    }
    match read_json(path, MAX_LINE).and_then(validate_saved) {
        Ok(saved) => (saved, None),
        Err(_) => (Saved::default(), Some("Saved Jev settings could not be read. Browser testing is disabled; enter and save its settings again. The original settings file has been preserved.".into())),
    }
}
pub fn enabled() -> bool {
    runtime().is_ok_and(|state| state.saved.settings.enabled)
}
pub fn decisions_enabled() -> bool {
    runtime().is_ok_and(|state| state.saved.settings.decisions_enabled)
}
pub(crate) fn decision_credentials() -> Result<(bool, String, crate::jev_decisions::Provider)> {
    use crate::jev_decisions::Provider;
    let state = runtime()?;
    let settings = &state.saved.settings;
    let (key, provider) = if settings.decision_provider == "openrouter" {
        (
            openrouter_key().unwrap_or_default(),
            Provider::OpenRouter { model: settings.decision_model.clone() },
        )
    } else {
        (state.saved.typesafe_key.clone(), Provider::TypeSafe)
    };
    Ok((settings.decisions_enabled, key, provider))
}
pub fn is_busy() -> bool {
    crate::jev_decisions::is_busy()
        || runtime().is_ok_and(|state| state.installing || !state.active.is_empty())
}
pub(crate) fn active_for_tasks(ids: &[String]) -> Result<bool> {
    let Some(runtime) = RUNTIME.get() else {
        return Ok(false);
    };
    let state = runtime.lock().map_err(|_| "Jev settings are unavailable.")?;
    Ok(has_active_tasks(&state, ids))
}
fn has_active_tasks(state: &Runtime, ids: &[String]) -> bool {
    // A cancelled run remains active until its process and final persistence finish.
    state
        .active
        .values()
        .any(|run| ids.contains(&run.report.session_id))
}

pub(crate) fn with_task_admission<T>(
    state: &AppState,
    sid: &str,
    reserve: impl FnOnce(&crate::storage::Session) -> Result<T>,
) -> Result<T> {
    let _admission = state
        .agents
        .lock()
        .map_err(|_| "Task registry is unavailable.")?;
    admission(state.shutdown.load(Ordering::SeqCst))?;
    // Validation before taking admission is insufficient: deletion may have
    // committed while this request prepared its evidence or browser parameters.
    let task = state
        .store
        .lock()
        .map_err(|_| "Task storage is unavailable.")?
        .session(sid)?;
    reserve(&task)
}
fn admission(shutdown: u8) -> Result<()> {
    if shutdown != 0 {
        return Err("PandaCode is closing. Reopen it to use Jev.".into());
    }
    Ok(())
}
pub fn shutdown() {
    if let Ok(state) = runtime() {
        for active in state.active.values() {
            active.stopped.store(true, Ordering::SeqCst);
        }
    }
    // ProcessGroup registers runners and installers in the shared exit cleanup registry.
}
fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)
        .map_err(|_| "Could not create private Jev storage.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect Jev storage.".to_string())?;
    }
    Ok(())
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Invalid Jev storage location.")?;
    private_dir(parent)?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temp)
            .map_err(|_| "Could not save Jev settings.".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save Jev settings.".to_string())?;
        std::fs::rename(&temp, path).map_err(|_| "Could not replace Jev settings.".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, limit: usize) -> Result<T> {
    let file = std::fs::File::open(path).map_err(|_| "Jev data could not be read.".to_string())?;
    if file
        .metadata()
        .map_err(|_| "Jev data could not be read.")?
        .len()
        > limit as u64
    {
        return Err("Jev data exceeds the storage limit.".into());
    }
    serde_json::from_reader(file).map_err(|_| "Jev data is invalid.".into())
}
fn key(value: String) -> Result<String> {
    let value = value.trim();
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Enter a valid API key.".into());
    }
    Ok(value.into())
}
fn path_setting(path: &str) -> Result<()> {
    if !path.is_empty()
        && (path.len() > 4096
            || !Path::new(path).is_absolute()
            || path.chars().any(char::is_control))
    {
        return Err(
            "Use an absolute executable path, or leave it empty for automatic discovery.".into(),
        );
    }
    Ok(())
}
fn validate_saved(mut saved: Saved) -> Result<Saved> {
    saved.settings.python_path = saved.settings.python_path.trim().into();
    saved.settings.chrome_path = saved.settings.chrome_path.trim().into();
    path_setting(&saved.settings.python_path)?;
    path_setting(&saved.settings.chrome_path)?;
    saved.settings.text_model = saved.settings.text_model.trim().into();
    if saved.settings.text_model.is_empty()
        || saved.settings.text_model.len() > 200
        || saved.settings.text_model.chars().any(char::is_control)
    {
        return Err("Enter a text model identifier.".into());
    }
    let base = normalized_url(&saved.settings.text_base_url)?;
    let parsed = reqwest::Url::parse(&base).map_err(|_| "Enter a valid text model API URL.")?;
    if parsed.scheme() != "https" || base.len() > 2048 {
        return Err("Text model API URLs must use HTTPS and be under 2,048 characters.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Text model API URLs cannot contain query parameters or fragments.".into());
    }
    saved.settings.text_base_url = base.trim_end_matches('/').into();
    saved.settings.decision_model = saved.settings.decision_model.trim().into();
    match saved.settings.decision_provider.as_str() {
        "typesafe" => saved.settings.decision_model.clear(),
        "openrouter" => {
            let model = &saved.settings.decision_model;
            if model.len() > 200 || model.chars().any(char::is_control) {
                return Err("Choose a valid OpenRouter decision model.".into());
            }
            if model.is_empty() && saved.settings.decisions_enabled {
                return Err("Choose an OpenRouter decision model.".into());
            }
        }
        _ => return Err("Choose TypeSafe or OpenRouter for decisions.".into()),
    }
    saved.typesafe_key = key(saved.typesafe_key)?;
    saved.text_key = key(saved.text_key)?;
    Ok(saved)
}
fn normalized_url(input: &str) -> Result<String> {
    if input.len() > 4096 || input.chars().any(char::is_control) {
        return Err("Enter a valid HTTP or HTTPS URL.".into());
    }
    let url = reqwest::Url::parse(input.trim())
        .map_err(|_| "Enter a full HTTP or HTTPS URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP or HTTPS URLs without embedded credentials are supported.".into());
    }
    Ok(url.to_string())
}
fn validate_request(mut request: Request) -> Result<Request> {
    request.url = normalized_url(&request.url)?;
    request.goal = request.goal.trim().into();
    if request.goal.is_empty() || request.goal.len() > 8192 || request.goal.contains('\0') {
        return Err("Describe the browser test in 8,192 characters or fewer.".into());
    }
    if !(1..=60).contains(&request.max_steps) {
        return Err("Choose between 1 and 60 browser steps.".into());
    }
    if !(30..=600).contains(&request.timeout_seconds) {
        return Err("Choose a timeout between 30 and 600 seconds.".into());
    }
    if !matches!(request.viewport.as_str(), "desktop" | "mobile") {
        return Err("Choose a desktop or mobile viewport.".into());
    }
    for (expectation, limit) in [
        (&mut request.expected_text, 2000),
        (&mut request.expected_title, 500),
        (&mut request.expected_url, 4096),
    ] {
        if let Some(value) = expectation {
            *value = value.trim().into();
            if value.len() > limit || value.contains('\0') {
                return Err(format!(
                    "Keep this expected result under {limit} characters."
                ));
            }
            if value.is_empty() {
                *expectation = None;
            }
        }
    }
    if let Some(expected) = request.expected_url.as_mut() {
        *expected = normalized_url(expected)?;
        let expected_origin = reqwest::Url::parse(expected)
            .map_err(|_| "Invalid expected URL.")?
            .origin();
        let origin = reqwest::Url::parse(&request.url)
            .map_err(|_| "Invalid test URL.")?
            .origin();
        if expected_origin != origin {
            return Err("The expected URL must use the test's starting origin.".into());
        }
    }
    Ok(request)
}

#[tauri::command]
pub async fn jev_configuration() -> Result<Configuration> {
    Ok(Configuration::from(&runtime()?.saved))
}
#[tauri::command]
pub async fn jev_save_configuration(
    settings: Settings,
    typesafe_key: Option<String>,
    text_key: Option<String>,
    openrouter_key: Option<String>,
) -> Result<Configuration> {
    crate::blocking(move || {
        let mut state = runtime()?;
        if state.installing {
            return Err(
                "Wait for the Jev installation to finish before changing its settings.".into(),
            );
        }
        let mut next = state.saved.clone();
        next.settings = settings;
        if let Some(value) = typesafe_key {
            next.typesafe_key = value;
        }
        if let Some(value) = text_key {
            next.text_key = value;
        }
        let next = validate_saved(next)?;
        let openrouter_key = openrouter_key.map(key).transpose()?;
        if decision_needs_key(&next, &openrouter_key) {
            return Err("Add your OpenRouter API key to use it for decisions.".into());
        }
        private_write(
            &state.dir.join("settings.json"),
            &serde_json::to_vec(&next).map_err(|_| "Could not encode Jev settings.")?,
        )?;
        match openrouter_key.as_deref() {
            Some("") => crate::secret_store::remove(SECRET_SERVICE, OPENROUTER_ACCOUNT),
            Some(value) => crate::secret_store::set(SECRET_SERVICE, OPENROUTER_ACCOUNT, value)?,
            None => {}
        }
        if !next.settings.enabled {
            for active in state.active.values() {
                active.stopped.store(true, Ordering::SeqCst);
            }
        }
        state.saved = next;
        state.setup_warning = None;
        Ok(Configuration::from(&state.saved))
    })
    .await
}

// Decisions on OpenRouter need a key, either already saved or arriving with this save.
fn decision_needs_key(next: &Saved, incoming: &Option<String>) -> bool {
    next.settings.decisions_enabled
        && next.settings.decision_provider == "openrouter"
        && match incoming.as_deref() {
            Some(value) => value.is_empty(),
            None => openrouter_key().is_none(),
        }
}
#[tauri::command]
pub async fn jev_decision_models(provider: String) -> Result<Vec<crate::jev_decisions::DecisionModel>> {
    crate::jev_decisions::models::list(&provider).await
}

fn venv_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("venv/Scripts/python.exe")
    } else {
        dir.join("venv/bin/python")
    }
}
fn runner_path(dir: &Path) -> PathBuf {
    dir.join("runner.py")
}
fn write_runner(dir: &Path) -> Result<PathBuf> {
    let path = runner_path(dir);
    private_write(&path, include_bytes!("../scripts/jev_runner.py"))?;
    Ok(path)
}
fn sanitized_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}
struct OwnedProcess {
    child: Child,
    group: Option<ProcessGroup>,
}
impl OwnedProcess {
    fn spawn(command: &mut Command) -> Result<Self> {
        let child = command.spawn().map_err(|_| {
            "Could not start the Jev runtime. Check the executable in Settings.".to_string()
        })?;
        let group = Some(ProcessGroup::register(child.id()));
        Ok(Self { child, group })
    }
    async fn finish(&mut self) {
        // Let the runner close its browser and delete the disposable profile.
        // The group guard remains the hard stop for unresponsive descendants.
        if self.child.try_wait().ok().flatten().is_none() {
            #[cfg(unix)]
            if let Some(pid) = self.child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            let _ = self.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        }
        self.group.take();
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.group.take();
        let _ = self.child.start_kill();
    }
}
async fn process_output(
    mut command: Command,
    input: Option<Value>,
    seconds: u64,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut process = OwnedProcess::spawn(&mut command)?;
    let operation = async {
        if let Some(mut stdin) = process.child.stdin.take() {
            if let Some(input) = input {
                let bytes = serde_json::to_vec(&input).map_err(|_| "Invalid runtime request.")?;
                if bytes.len() > MAX_LINE {
                    return Err("Runtime request exceeds its limit.".into());
                }
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|_| "Could not send the runtime request.")?;
            }
            stdin
                .shutdown()
                .await
                .map_err(|_| "Could not close runtime input.")?;
        }
        let mut bytes = Vec::new();
        process
            .child
            .stdout
            .take()
            .ok_or("Runtime output unavailable.")?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Could not read runtime output.")?;
        if bytes.len() > limit {
            return Err("Jev runtime output exceeded its limit.".into());
        }
        let status = process
            .child
            .wait()
            .await
            .map_err(|_| "Could not await Jev runtime.")?;
        if !status.success() {
            return Err(
                "Jev runtime command failed. Check its installation and Python version.".into(),
            );
        }
        Ok(bytes)
    };
    let result = tokio::time::timeout(Duration::from_secs(seconds), operation)
        .await
        .unwrap_or_else(|_| Err("Jev runtime command timed out.".into()));
    process.finish().await;
    result
}
async fn doctor() -> Result<Doctor> {
    let (dir, saved, setup_warning) = {
        let state = runtime()?;
        (
            state.dir.clone(),
            state.saved.clone(),
            state.setup_warning.clone(),
        )
    };
    let python = venv_python(&dir);
    let mut result = if python.is_file() {
        let runner = write_runner(&dir)?;
        let mut command = sanitized_command(&python);
        command
            .args(["-I", "-u"])
            .arg(runner)
            .arg("--doctor")
            .current_dir(&dir);
        match process_output(
            command,
            Some(json!({"chromePath":saved.settings.chrome_path})),
            12,
            MAX_LINE,
        )
        .await
        {
            Ok(bytes) => serde_json::from_slice::<Doctor>(&bytes).unwrap_or_else(|_| Doctor {
                issues: vec!["Jev returned an invalid installation report.".into()],
                ..Doctor::default()
            }),
            Err(error) => Doctor {
                issues: vec![error],
                ..Doctor::default()
            },
        }
    } else {
        Doctor {
            issues: vec!["Install the optional Jev runtime.".into()],
            ..Doctor::default()
        }
    };
    if !saved.settings.enabled {
        result.issues.push("Enable Jev browser testing.".into());
    }
    if saved.typesafe_key.is_empty() {
        result.issues.push("Add a TypeSafe API key.".into());
    }
    if saved.text_key.is_empty() {
        result.issues.push("Add a text model API key.".into());
    }
    if let Some(warning) = setup_warning {
        result.issues.push(warning);
    }
    result.ready = result.ready && result.issues.is_empty();
    Ok(result)
}
#[tauri::command]
pub async fn jev_doctor() -> Result<Doctor> {
    doctor().await
}
struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = runtime() {
            state.installing = false;
        }
    }
}
#[tauri::command]
pub async fn jev_install_runtime(app: tauri::AppHandle) -> Result<Doctor> {
    let (dir, settings) = {
        let app_state = app.state::<AppState>();
        let _admission = app_state
            .agents
            .lock()
            .map_err(|_| "Task registry is unavailable.")?;
        admission(app_state.shutdown.load(Ordering::SeqCst))?;
        let mut state = runtime()?;
        if state.installing {
            return Err("Jev is already being installed.".into());
        }
        if !state.active.is_empty() {
            return Err("Stop browser tests before changing their runtime.".into());
        }
        state.installing = true;
        (state.dir.clone(), state.saved.settings.clone())
    };
    let _guard = InstallGuard;
    let uv = crate::providers::executable("uv");
    let python = venv_python(&dir);
    let _ = app.emit(
        "jev-install",
        json!({"status":"installing","message":"Preparing Python 3.12 environment…"}),
    );
    if !python.is_file() {
        let mut command = if let Some(uv) = &uv {
            let mut command = sanitized_command(uv);
            command.args(["venv", "--python"]);
            command.arg(if settings.python_path.is_empty() {
                "3.12"
            } else {
                &settings.python_path
            });
            command.arg(dir.join("venv"));
            command
        } else {
            let executable = if settings.python_path.is_empty() {
                crate::providers::executable("python3.12")
                    .or_else(|| crate::providers::executable("python3"))
                    .or_else(|| crate::providers::executable("python"))
            } else {
                Some(PathBuf::from(&settings.python_path))
            }
            .ok_or(
                "Install uv or Python 3.12+, then retry. You can also set an absolute Python path.",
            )?;
            let mut version = sanitized_command(&executable);
            version.args([
                "-I",
                "-c",
                "import sys;sys.exit(0 if sys.version_info >= (3,12) else 1)",
            ]);
            process_output(version, None, 10, MAX_LINE)
                .await
                .map_err(|_| {
                    "Jev requires Python 3.12 or newer. Install it or uv, then retry.".to_string()
                })?;
            let mut command = sanitized_command(&executable);
            command.args(["-I", "-m", "venv"]).arg(dir.join("venv"));
            command
        };
        command.current_dir(&dir);
        process_output(command, None, 240, MAX_OUTPUT).await?;
    }
    let _ = app.emit(
        "jev-install",
        json!({"status":"installing","message":"Installing the pinned Jev browser runtime…"}),
    );
    let package = format!("jev-ultrafast @ {SOURCE}");
    let mut command = if let Some(uv) = uv {
        let mut command = sanitized_command(&uv);
        command
            .args(["pip", "install", "--python"])
            .arg(&python)
            .args([package.as_str(), "browser-harness==0.1.13"]);
        command
    } else {
        let mut command = sanitized_command(&python);
        command.args([
            "-I",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--disable-pip-version-check",
            package.as_str(),
            "browser-harness==0.1.13",
        ]);
        command
    };
    command.current_dir(&dir);
    process_output(command, None, 300, MAX_OUTPUT).await.map_err(|_| "Jev installation failed. Check your internet connection and Python installation, then retry.".to_string())?;
    write_runner(&dir)?;
    let report = doctor().await?;
    let _ = app.emit(
        "jev-install",
        json!({"status":"finished","message":"Jev runtime installed."}),
    );
    Ok(report)
}

fn validate_task(app: &tauri::AppHandle, session_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    state
        .store
        .lock()
        .map_err(|_| "Task storage is unavailable.")?
        .session(session_id)?;
    Ok(())
}
fn task_dir(dir: &Path, session_id: &str) -> PathBuf {
    dir.join("runs")
        .join(format!("{:x}", Sha256::digest(session_id.as_bytes())))
}
fn run_dir(dir: &Path, session_id: &str, run_id: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(run_id).map_err(|_| "Invalid browser test identifier.")?;
    if parsed.to_string() != run_id {
        return Err("Invalid browser test identifier.".into());
    }
    Ok(task_dir(dir, session_id).join(run_id))
}
#[derive(Serialize, Deserialize)]
struct ProfileOwner {
    run_id: String,
    process_id: u32,
}
fn profile_dir(run_id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(run_id).map_err(|_| "Invalid browser test identifier.")?;
    let parent = if cfg!(unix) {
        PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    Ok(parent.join(format!("bj-{}", &id.simple().to_string()[..12])))
}
struct ProfileDirectory {
    run_id: String,
    path: PathBuf,
}
impl ProfileDirectory {
    fn create(run_id: &str) -> Result<Self> {
        let path = profile_dir(run_id)?;
        // Exclusive creation means a coincidentally existing folder is never reused.
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&path).map_err(|_| {
            "Could not create an isolated browser profile. Retry the test.".to_string()
        })?;
        let owner = ProfileOwner {
            run_id: run_id.into(),
            process_id: std::process::id(),
        };
        if let Err(error) = private_write(
            &path.join(".pandacode-owner.json"),
            &serde_json::to_vec(&owner)
                .map_err(|_| "Could not encode browser profile ownership.")?,
        ) {
            let _ = std::fs::remove_dir(&path);
            return Err(error);
        }
        Ok(Self {
            run_id: run_id.into(),
            path,
        })
    }
}
impl Drop for ProfileDirectory {
    fn drop(&mut self) {
        cleanup_profile(&self.run_id, false);
    }
}
fn owner_alive(pid: u32) -> bool {
    if pid <= 1 || pid > i32::MAX as u32 {
        return true;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };
        match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(handle) => {
                let _ = unsafe { CloseHandle(handle) };
                true
            }
            // ERROR_INVALID_PARAMETER: the process no longer exists. Permission failures are live.
            Err(error) => error.code().0 != 0x80070057_u32 as i32,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}
fn cleanup_profile(run_id: &str, only_if_owner_exited: bool) {
    let Ok(path) = profile_dir(run_id) else {
        return;
    };
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return;
    }
    let marker = path.join(".pandacode-owner.json");
    if !std::fs::symlink_metadata(&marker)
        .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
    {
        return;
    }
    let Ok(owner) = read_json::<ProfileOwner>(&marker, 512) else {
        return;
    };
    if owner.run_id == run_id && (!only_if_owner_exited || !owner_alive(owner.process_id)) {
        let _ = std::fs::remove_dir_all(path);
    }
}
fn cleanup_interrupted_profiles(dir: &Path) {
    let Ok(tasks) = std::fs::read_dir(dir.join("runs")) else {
        return;
    };
    let mut remaining = 1000;
    for task in tasks.flatten().take(200) {
        let Ok(runs) = std::fs::read_dir(task.path()) else {
            continue;
        };
        for run in runs.flatten().take(HISTORY + 1) {
            if remaining == 0 {
                return;
            }
            remaining -= 1;
            let Some(id) = run.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            // Only exact recorded run IDs; never glob or delete another app's temp folders.
            let Ok(report) = read_json::<Report>(&run.path().join("report.json"), MAX_REPORT)
            else {
                continue;
            };
            if report.id == id {
                cleanup_profile(&id, true);
            }
        }
    }
}
fn stored_reports(dir: &Path, session_id: &str) -> Vec<Report> {
    let entries = match std::fs::read_dir(task_dir(dir, session_id)) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut reports = Vec::new();
    for entry in entries.flatten().take(1000) {
        let Ok(mut report) = read_json::<Report>(&entry.path().join("report.json"), MAX_REPORT)
        else {
            continue;
        };
        if report.session_id == session_id
            && run_dir(dir, session_id, &report.id).is_ok_and(|path| path == entry.path())
        {
            mark_interrupted(&mut report);
            reports.push(report);
        }
    }
    reports.sort_by_key(|report| std::cmp::Reverse(report.created_at));
    reports
}
fn persist_report(dir: &Path, report: &Report) -> Result<()> {
    let dest = run_dir(dir, &report.session_id, &report.id)?;
    private_write(
        &dest.join("report.json"),
        &serde_json::to_vec(report).map_err(|_| "Could not encode browser test report.")?,
    )?;
    for old in stored_reports(dir, &report.session_id)
        .into_iter()
        .skip(HISTORY)
    {
        if let Ok(path) = run_dir(dir, &old.session_id, &old.id) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    Ok(())
}
pub fn list_for_task(app: &tauri::AppHandle, session_id: &str) -> Result<Vec<Report>> {
    validate_task(app, session_id)?;
    let (dir, active) = {
        let state = runtime()?;
        (
            state.dir.clone(),
            state
                .active
                .values()
                .filter(|a| a.report.session_id == session_id)
                .map(|a| a.report.clone())
                .collect::<Vec<_>>(),
        )
    };
    let mut reports = stored_reports(&dir, session_id);
    for item in active {
        reports.retain(|r| r.id != item.id);
        reports.push(item);
    }
    reports.sort_by_key(|report| std::cmp::Reverse(report.created_at));
    reports.truncate(HISTORY);
    Ok(reports)
}
pub fn read_for_task(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    include_screenshot: bool,
) -> Result<Report> {
    validate_task(app, session_id)?;
    let (dir, active) = {
        let state = runtime()?;
        (
            state.dir.clone(),
            state.active.get(run_id).map(|a| a.report.clone()),
        )
    };
    let path = run_dir(&dir, session_id, run_id)?;
    let mut report: Report = match active {
        Some(report) => report,
        None => {
            let mut report = read_json(&path.join("report.json"), MAX_REPORT)?;
            mark_interrupted(&mut report);
            report
        }
    };
    if report.session_id != session_id || report.id != run_id {
        return Err("This browser test belongs to a different task.".into());
    }
    report.screenshot = if include_screenshot {
        screenshot(&path.join("final.jpg"))
    } else {
        None
    };
    Ok(report)
}
fn mark_interrupted(report: &mut Report) {
    if matches!(report.status.as_str(), "starting" | "running") {
        report.status = "failed".into();
        report.summary = "This browser test was interrupted when PandaCode closed. Start it again to continue testing.".into();
        report.verification = "not_checked".into();
    }
}
fn screenshot(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_SCREENSHOT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
pub fn cancel_for_task(app: &tauri::AppHandle, session_id: &str, run_id: &str) -> Result<()> {
    validate_task(app, session_id)?;
    let state = runtime()?;
    if let Some(active) = state.active.get(run_id) {
        if active.report.session_id != session_id {
            return Err("This browser test belongs to a different task.".into());
        }
        active.stopped.store(true, Ordering::SeqCst);
        return Ok(());
    }
    let report: Report = read_json(
        &run_dir(&state.dir, session_id, run_id)?.join("report.json"),
        MAX_REPORT,
    )?;
    if report.session_id != session_id {
        return Err("This browser test belongs to a different task.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn jev_list_runs(app: tauri::AppHandle, session_id: String) -> Result<Vec<Report>> {
    crate::blocking(move || list_for_task(&app, &session_id)).await
}
#[tauri::command]
pub async fn jev_read_run(
    app: tauri::AppHandle,
    session_id: String,
    run_id: String,
) -> Result<Report> {
    crate::blocking(move || read_for_task(&app, &session_id, &run_id, true)).await
}
#[tauri::command]
pub async fn jev_cancel(app: tauri::AppHandle, session_id: String, run_id: String) -> Result<()> {
    cancel_for_task(&app, &session_id, &run_id)
}
#[tauri::command]
pub async fn jev_watch_run(
    app: tauri::AppHandle,
    session_id: String,
    run_id: String,
    watching: bool,
) -> Result<()> {
    crate::blocking(move || {
        validate_task(&app, &session_id)?;
        let mut state = runtime()?;
        watch_run(&mut state, &session_id, &run_id, watching, Instant::now())
    })
    .await
}

fn watch_run(
    state: &mut Runtime,
    session_id: &str,
    run_id: &str,
    watching: bool,
    now: Instant,
) -> Result<()> {
    if let Some(active) = state.active.get_mut(run_id) {
        if active.report.session_id != session_id {
            return Err("This browser test belongs to a different task.".into());
        }
        if watching && active.watch_until.is_none_or(|until| until <= now) {
            active.watch_generation = active.watch_generation.saturating_add(1);
        }
        active.watch_until = watching.then_some(now + WATCH_TTL);
        return Ok(());
    }
    // A finishing run can race the viewer's next heartbeat. Validate its owner
    // but treat watching a completed run as a harmless no-op.
    let report: Report = read_json(
        &run_dir(&state.dir, session_id, run_id)?.join("report.json"),
        MAX_REPORT,
    )?;
    if report.id != run_id || report.session_id != session_id {
        return Err("This browser test belongs to a different task.".into());
    }
    Ok(())
}

fn active_watch(state: &Runtime, report: &Report, now: Instant) -> Option<(Instant, u64)> {
    state
        .active
        .get(&report.id)
        .filter(|active| {
            active.report.session_id == report.session_id && !active.stopped.load(Ordering::SeqCst)
        })
        .and_then(|active| {
            active
                .watch_until
                .map(|until| (until, active.watch_generation))
        })
        .filter(|(until, _)| *until > now)
}

#[tauri::command]
pub async fn jev_start(
    app: tauri::AppHandle,
    session_id: String,
    request: Request,
) -> Result<Report> {
    start(app, &session_id, request, None).await
}
pub async fn start_for_task(
    app: tauri::AppHandle,
    session_id: &str,
    request: Request,
    stopped: Arc<AtomicBool>,
) -> Result<Report> {
    start(app, session_id, request, Some(stopped)).await
}

async fn start(
    app: tauri::AppHandle,
    session_id: &str,
    request: Request,
    parent_stopped: Option<Arc<AtomicBool>>,
) -> Result<Report> {
    validate_task(&app, session_id)?;
    let request = validate_request(request)?;
    if parent_stopped
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return Err("The agent has stopped.".into());
    }
    let report = Report::starting(session_id, &request);
    let stopped = Arc::new(AtomicBool::new(false));
    let (dir, saved) = {
        // Shares the agent updater's admission lock. An agent update cannot pass
        // its idle check between this lifecycle check and reserving the browser test.
        let app_state = app.state::<AppState>();
        with_task_admission(&app_state, session_id, |_| {
            let mut state = runtime()?;
            reserve(&mut state, &report, stopped.clone())?;
            Ok((state.dir.clone(), state.saved.clone()))
        })?
    };
    let response = report.clone();
    let _ = app.emit("jev-run", &report);
    tauri::async_runtime::spawn(async move {
        execute(app, dir, saved, request, report, stopped, parent_stopped).await;
    });
    Ok(response)
}

fn reserve(state: &mut Runtime, report: &Report, stopped: Arc<AtomicBool>) -> Result<()> {
    if !state.saved.settings.enabled {
        return Err("Enable Jev browser testing in Settings first.".into());
    }
    if state.saved.typesafe_key.is_empty() || state.saved.text_key.is_empty() {
        return Err("Add the Jev API keys in Settings first.".into());
    }
    if state.installing {
        return Err("Wait for the Jev runtime installation to finish.".into());
    }
    if !venv_python(&state.dir).is_file() {
        return Err("Install the Jev runtime in Settings first.".into());
    }
    if state.active.len() >= 2 {
        return Err("Two browser tests are already running. Wait for one to finish.".into());
    }
    if state
        .active
        .values()
        .any(|a| a.report.session_id == report.session_id)
    {
        return Err("This task already has a browser test running.".into());
    }
    state.active.insert(
        report.id.clone(),
        Active {
            report: report.clone(),
            stopped,
            watch_until: None,
            watch_generation: 0,
        },
    );
    Ok(())
}

fn short(value: &str, limit: usize) -> String {
    let mut result: String = value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(limit)
        .collect();
    if result.len() > limit {
        let mut boundary = limit;
        while !result.is_char_boundary(boundary) {
            boundary -= 1;
        }
        result.truncate(boundary);
    }
    result
}
fn sanitized(value: &str, saved: &Saved, limit: usize) -> String {
    // Redact before truncating, otherwise a secret cut at the limit could leak a prefix.
    let mut value = value.to_owned();
    for secret in [&saved.typesafe_key, &saved.text_key] {
        if !secret.is_empty() {
            value = value.replace(secret, "[redacted]");
        }
    }
    short(&value, limit)
}
fn output_text(value: &Value, key: &str, saved: &Saved, limit: usize) -> String {
    sanitized(
        value.get(key).and_then(Value::as_str).unwrap_or(""),
        saved,
        limit,
    )
}
fn status_terminal(value: &str) -> bool {
    matches!(value, "done" | "blocked" | "failed" | "cancelled" | "limit")
}
fn apply_output(report: &mut Report, value: Value, saved: &Saved) -> Result<bool> {
    match value.get("type").and_then(Value::as_str) {
        Some("status") => {
            report.status = "running".into();
            let summary = output_text(&value, "summary", saved, 500);
            if !summary.is_empty() {
                report.summary = summary;
            }
            Ok(false)
        }
        Some("step") => {
            let step = value
                .get("step")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(60) as u32;
            let operation = output_text(&value, "operation", saved, 64);
            if !matches!(
                operation.as_str(),
                "CLICK"
                    | "TYPE_TEXT"
                    | "SELECT"
                    | "SCROLL_UP"
                    | "SCROLL_DOWN"
                    | "WAIT"
                    | "DONE"
                    | "BLOCKED"
                    | "OBSERVE"
                    | "CHECK"
            ) {
                return Err("Jev returned an unsupported browser operation.".into());
            }
            report.status = "running".into();
            report.steps = report.steps.max(step);
            report.events.push(Event {
                step,
                operation,
                target: output_text(&value, "target", saved, 300),
                url: output_text(&value, "url", saved, 2048),
                elapsed_ms: value
                    .get("elapsedMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(600_000),
            });
            if report.events.len() > 60 {
                report.events.remove(0);
            }
            Ok(false)
        }
        Some("result") => {
            let status = value
                .get("status")
                .and_then(Value::as_str)
                .ok_or("Jev result is missing its status.")?;
            if !status_terminal(status) {
                return Err("Jev returned an invalid final status.".into());
            }
            report.status = status.into();
            report.summary = output_text(&value, "summary", saved, 2000);
            report.steps = report.steps.max(
                value
                    .get("steps")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(60) as u32,
            );
            report.title = value
                .get("title")
                .and_then(Value::as_str)
                .map(|title| sanitized(title, saved, 300));
            report.checks = value
                .get("checks")
                .and_then(Value::as_array)
                .map(|checks| {
                    checks
                        .iter()
                        .take(3)
                        .map(|check| Check {
                            name: output_text(check, "name", saved, 100),
                            expected: output_text(check, "expected", saved, 2048),
                            passed: check
                                .get("passed")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default();
            // An LLM's DONE is never a pass: only independently evaluated assertions count.
            report.verification = if report.checks.is_empty() {
                "not_checked"
            } else if report.checks.iter().all(|check| check.passed) {
                "passed"
            } else {
                "failed"
            }
            .into();
            Ok(true)
        }
        _ => Err("Jev returned an invalid runtime event.".into()),
    }
}
fn publish(app: &tauri::AppHandle, report: &Report) {
    if let Ok(mut state) = runtime() {
        if let Some(active) = state.active.get_mut(&report.id) {
            active.report = report.clone();
        }
    }
    let _ = app.emit("jev-run", report);
}

fn sync_watch_marker(profile: &Path, report: &Report, previous: &mut Option<(Instant, u64)>) {
    let now = Instant::now();
    let watching = runtime()
        .ok()
        .and_then(|state| active_watch(&state, report, now));
    if watching == *previous {
        return;
    }
    let path = profile.join("live-watch.json");
    if let Some((until, generation)) = watching {
        let expires_at =
            crate::storage::now() + until.saturating_duration_since(now).as_millis() as i64;
        let marker = json!({"runId": report.id, "expiresAt": expires_at, "generation": generation});
        // This optional preview cannot interrupt an otherwise valid test.
        if private_write(&path, marker.to_string().as_bytes()).is_err() {
            return;
        }
    } else {
        let _ = std::fs::remove_file(path);
    }
    *previous = watching;
}

fn read_live_frame(
    profile: &Path,
    report: &Report,
    value: Value,
    previous_sequence: u64,
) -> Option<LiveFrame> {
    let notice: FrameNotice = serde_json::from_value(value).ok()?;
    let dimensions = if report.viewport == "mobile" {
        (390, 844)
    } else {
        (960, 600)
    };
    if notice.kind != "frame"
        || notice.sequence <= previous_sequence
        || notice.sequence > 1500
        || (notice.width, notice.height) != dimensions
        || notice.elapsed_ms > 650_000
        || notice.sha256.len() != 64
        || !notice.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    let path = profile.join("live-frame.jpg");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_LIVE_FRAME {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // A bounded read also protects against a file changing between stat/open.
    std::fs::File::open(path)
        .ok()?
        .take(MAX_LIVE_FRAME + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_LIVE_FRAME
        || !bytes.starts_with(&[0xff, 0xd8, 0xff])
        || format!("{:x}", Sha256::digest(&bytes)) != notice.sha256
    {
        return None;
    }
    Some(LiveFrame {
        session_id: report.session_id.clone(),
        run_id: report.id.clone(),
        sequence: notice.sequence,
        data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        width: notice.width,
        height: notice.height,
        elapsed_ms: notice.elapsed_ms,
    })
}

fn publish_frame(
    app: &tauri::AppHandle,
    profile: &Path,
    report: &Report,
    value: Value,
    last_sequence: &mut u64,
) {
    let now = Instant::now();
    if !runtime().is_ok_and(|state| active_watch(&state, report, now).is_some()) {
        return;
    }
    if let Some(frame) = read_live_frame(profile, report, value, *last_sequence) {
        // Recheck after IO in case the view was closed while its frame was read.
        if !runtime().is_ok_and(|state| active_watch(&state, report, Instant::now()).is_some()) {
            return;
        }
        *last_sequence = frame.sequence;
        let _ = app.emit_to("main", "jev-frame", &frame);
    }
}

async fn bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| "Could not read Jev runtime output.")?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let length = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |end| end + 1);
        if line.len() + length > MAX_LINE {
            return Err("Jev runtime event exceeded its size limit.".into());
        }
        let done = buffer[length - 1] == b'\n';
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if done {
            return Ok(Some(line));
        }
    }
}
async fn execute(
    app: tauri::AppHandle,
    dir: PathBuf,
    saved: Saved,
    request: Request,
    mut report: Report,
    stopped: Arc<AtomicBool>,
    parent_stopped: Option<Arc<AtomicBool>>,
) {
    let begin = Instant::now();
    let outcome: Result<()> = async {
        let output_dir = run_dir(&dir, &report.session_id, &report.id)?;
        private_dir(&output_dir)?;
        // A crash leaves a recoverable interrupted test instead of a phantom active run.
        persist_report(&dir, &report)?;
        let profile = ProfileDirectory::create(&report.id)?;
        let mut last_watch = None;
        let mut last_sequence = 0;
        sync_watch_marker(&profile.path, &report, &mut last_watch);
        let runner = write_runner(&dir)?;
        let mut command = sanitized_command(&venv_python(&dir)); command.args(["-I", "-u"]).arg(runner).arg("--run").current_dir(&output_dir);
        let mut process = OwnedProcess::spawn(&mut command)?;
        let mut payload = serde_json::to_value(&request).map_err(|_| "Could not prepare Jev request.")?;
        let object = payload.as_object_mut().ok_or("Invalid Jev request.")?;
        for (name, value) in [ ("runId", report.id.clone()), ("outputDir", output_dir.to_string_lossy().into_owned()), ("browserDir", profile.path.to_string_lossy().into_owned()), ("chromePath", saved.settings.chrome_path.clone()), ("textModel", saved.settings.text_model.clone()), ("textBaseUrl", saved.settings.text_base_url.clone()), ("typesafeKey", saved.typesafe_key.clone()), ("textKey", saved.text_key.clone()) ] { object.insert(name.into(), Value::String(value)); }
        let bytes = serde_json::to_vec(&payload).map_err(|_| "Invalid Jev request.")?;
        if bytes.len() > MAX_LINE { return Err("Browser test request is too large.".into()); }
        let operation = async {
            let mut stdin = process.child.stdin.take().ok_or("Jev input unavailable.")?;
            tokio::time::timeout(Duration::from_secs(5), stdin.write_all(&bytes)).await.map_err(|_| "Jev did not accept the test request.")?.map_err(|_| "Could not send the test request.")?;
            drop(stdin);
            let mut stdout = BufReader::new(process.child.stdout.take().ok_or("Jev output unavailable.")?);
            let mut total = 0;
            let mut heartbeat = tokio::time::interval(Duration::from_millis(100));
            loop {
                // Keep a partial JSON frame alive while servicing cancellation ticks.
                // Recreating this future in select would discard split stdout frames.
                let line = bounded_line(&mut stdout);
                tokio::pin!(line);
                let line = loop {
                    tokio::select! {
                        _ = heartbeat.tick() => {
                            if stopped.load(Ordering::SeqCst) || parent_stopped.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) { report.status = "cancelled".into(); report.summary = "Browser test cancelled.".into(); return Ok(()); }
                            if begin.elapsed() >= Duration::from_secs(request.timeout_seconds as u64) { report.status = "limit".into(); report.summary = "Browser test reached its time limit.".into(); return Ok(()); }
                            sync_watch_marker(&profile.path, &report, &mut last_watch);
                        }
                        result = &mut line => { break result?; }
                    }
                };
                let Some(line) = line else { return Err("Jev stopped without a final report. Check its runtime and API settings.".into()); };
                total += line.len(); if total > MAX_OUTPUT { return Err("Jev output exceeded its limit.".into()); }
                let value: Value = serde_json::from_slice(&line).map_err(|_| "Jev returned invalid output.")?;
                if value.get("type").and_then(Value::as_str) == Some("frame") {
                    publish_frame(&app, &profile.path, &report, value, &mut last_sequence);
                    continue;
                }
                let terminal = apply_output(&mut report, value, &saved)?;
                report.duration_ms = begin.elapsed().as_millis() as u64;
                publish(&app, &report);
                if terminal { return Ok(()); }
            }
        }.await;
        process.finish().await;
        operation
    }.await;
    if let Err(error) = outcome {
        report.status = "failed".into();
        report.summary = sanitized(&error, &saved, 2000);
    }
    report.duration_ms = begin.elapsed().as_millis() as u64;
    if let Err(error) = persist_report(&dir, &report) {
        report.summary.push_str(&format!(" {error}"));
    }
    if let Ok(mut state) = runtime() {
        state.active.remove(&report.id);
    }
    let _ = app.emit("jev-run", &report);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            url: "http://127.0.0.1:3000".into(),
            goal: "Open the settings".into(),
            max_steps: 20,
            timeout_seconds: 120,
            viewport: "desktop".into(),
            expected_text: None,
            expected_title: None,
            expected_url: None,
        }
    }
    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-jev-test-{}", uuid::Uuid::new_v4()));
        private_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn rejects_unsafe_urls_and_invalid_limits() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://name:secret@example.com",
            "http://localhost:3000\n",
        ] {
            assert!(normalized_url(url).is_err());
        }
        assert!(normalized_url("http://[::1]:3000/").is_ok());
        let mut req = request();
        req.max_steps = 61;
        assert!(validate_request(req).is_err());
        let mut req = request();
        req.timeout_seconds = 601;
        assert!(validate_request(req).is_err());
        let mut req = request();
        req.expected_url = Some("/relative".into());
        assert!(validate_request(req).is_err());
    }
    #[test]
    fn configuration_never_serializes_credentials() {
        let saved = Saved {
            typesafe_key: "super-secret-type".into(),
            text_key: "super-secret-text".into(),
            ..Saved::default()
        };
        let json = serde_json::to_string(&Configuration::from(&saved)).unwrap();
        assert!(!json.contains("super-secret"));
        assert!(json.contains("\"typesafeKeySaved\":true"));
        assert!(validate_saved(Saved {
            settings: Settings {
                text_base_url: "http://example.com/v1".into(),
                ..Settings::default()
            },
            ..saved
        })
        .is_err());
    }
    #[test]
    fn decision_provider_defaults_to_typesafe_and_validates_openrouter() {
        assert_eq!(Settings::default().decision_provider, "typesafe");
        let with = |provider: &str, model: &str, enabled: bool| {
            validate_saved(Saved {
                settings: Settings {
                    decisions_enabled: enabled,
                    decision_provider: provider.into(),
                    decision_model: model.into(),
                    ..Settings::default()
                },
                ..Saved::default()
            })
        };
        assert!(with("typesafe", "ignored", true).unwrap().settings.decision_model.is_empty());
        assert!(with("openrouter", "", true).is_err());
        assert!(with("openrouter", "", false).is_ok());
        assert_eq!(with("openrouter", " vendor/model ", true).unwrap().settings.decision_model, "vendor/model");
        assert!(with("other", "", false).is_err());
        let saved = Saved { settings: Settings { decisions_enabled: true, decision_provider: "openrouter".into(), decision_model: "v/m".into(), ..Settings::default() }, ..Saved::default() };
        assert!(decision_needs_key(&saved, &None));
        assert!(decision_needs_key(&saved, &Some(String::new())));
        assert!(!decision_needs_key(&saved, &Some("sk-or-test".into())));
    }
    #[test]
    fn verifies_assertions_instead_of_model_done() {
        let mut report = Report::starting("a", &request());
        apply_output(
            &mut report,
            json!({"type":"result","status":"done","verification":"passed","summary":"Done"}),
            &Saved::default(),
        )
        .unwrap();
        assert_eq!(report.verification, "not_checked");
        apply_output(&mut report, json!({"type":"result","status":"done","checks":[{"name":"Expected text","passed":false,"expected":"Settings"}]}), &Saved::default()).unwrap();
        assert_eq!(report.verification, "failed");
    }
    #[test]
    fn bounds_events_and_redacts_secrets() {
        let mut report = Report::starting("a", &request());
        let saved = Saved {
            typesafe_key: "secret-key".into(),
            ..Saved::default()
        };
        for step in 1..=70 {
            apply_output(
                &mut report,
                json!({"type":"step","step":step,"operation":"CLICK","target":"secret-key"}),
                &saved,
            )
            .unwrap();
        }
        assert_eq!(report.events.len(), 60);
        assert_eq!(report.events[0].step, 11);
        assert_eq!(report.events[0].target, "[redacted]");
        assert!(apply_output(
            &mut report,
            json!({"type":"step","operation":"EXECUTE_SHELL"}),
            &saved
        )
        .is_err());
    }
    #[test]
    fn report_paths_are_task_scoped_and_history_bounded() {
        let dir = temp();
        for i in 0..25 {
            let mut report = Report::starting("task/../../one", &request());
            report.created_at = i;
            persist_report(&dir, &report).unwrap();
        }
        assert_eq!(stored_reports(&dir, "task/../../one").len(), 20);
        assert!(stored_reports(&dir, "different").is_empty());
        assert!(run_dir(&dir, "a", "../../settings").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn private_files_and_oversized_storage() {
        let dir = temp();
        let file = dir.join("settings.json");
        private_write(&file, b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(read_json::<Value>(&file, 1).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_admission_never_replaces_an_active_task() {
        let dir = temp();
        private_write(&venv_python(&dir), b"fake executable for admission only").unwrap();
        let mut saved = Saved {
            typesafe_key: "test-typesafe".into(),
            text_key: "test-text".into(),
            ..Saved::default()
        };
        saved.settings.enabled = true;
        let mut state = Runtime {
            dir: dir.clone(),
            saved,
            active: HashMap::new(),
            installing: false,
            setup_warning: None,
        };
        let first = Report::starting("one", &request());
        reserve(&mut state, &first, Arc::new(AtomicBool::new(false))).unwrap();
        assert!(reserve(
            &mut state,
            &Report::starting("one", &request()),
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
        assert!(state.active.contains_key(&first.id));
        reserve(
            &mut state,
            &Report::starting("two", &request()),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(reserve(
            &mut state,
            &Report::starting("three", &request()),
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
        assert_eq!(state.active.len(), 2);
        assert!(has_active_tasks(&state, &["one".into()]));
        assert!(!has_active_tasks(&state, &["unrelated".into()]));
        state.active[&first.id].stopped.store(true, Ordering::SeqCst);
        assert!(has_active_tasks(&state, &["one".into()]), "Cancellation is not completed cleanup");
        state.active.remove(&first.id);
        assert!(!has_active_tasks(&state, &["one".into()]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn task_deletion_between_browser_validation_and_admission_prevents_reservation() {
        let (state, project) = crate::concurrent_task_tests::test_state();
        let sid = state.store.lock().unwrap()
            .create_session(&project, "codex", "default", "ask").unwrap().id;
        // The browser request passed its initial task validation.
        assert!(state.store.lock().unwrap().session(&sid).is_ok());
        crate::task_deletion::delete_state(&state, &sid).unwrap();
        let mut reserved = false;
        assert!(with_task_admission(&state, &sid, |_| {
            reserved = true;
            Ok(())
        }).is_err());
        assert!(!reserved);
    }

    #[test]
    fn request_defaults_and_partial_secret_redaction() {
        let req: Request =
            serde_json::from_value(json!({"url":"http://localhost:3000","goal":"Check a button"}))
                .unwrap();
        assert_eq!(
            (req.max_steps, req.timeout_seconds, req.viewport.as_str()),
            (20, 180, "desktop")
        );
        let saved = Saved {
            typesafe_key: "private-api-key".into(),
            ..Saved::default()
        };
        assert_eq!(sanitized("1234private-api-key", &saved, 8), "1234[red");
        assert_eq!(short("🦊🦊", 5), "🦊");
    }

    #[tokio::test]
    async fn fragmented_frames_survive_cancellation_ticks_and_reject_oversize() {
        let (mut input, output) = tokio::io::duplex(64);
        let writer = tokio::spawn(async move {
            input.write_all(b"{\"type\":").await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            input.write_all(b"\"step\"}\n").await.unwrap();
        });
        let mut reader = BufReader::new(output);
        let line = bounded_line(&mut reader);
        tokio::pin!(line);
        tokio::select! { _ = tokio::time::sleep(Duration::from_millis(5)) => {}, _ = &mut line => panic!("Expected a partial frame") }
        let bytes = line.await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["type"],
            "step"
        );
        writer.await.unwrap();
        let too_large = vec![b'x'; MAX_LINE + 1];
        let mut reader = BufReader::new(too_large.as_slice());
        assert!(bounded_line(&mut reader).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn owned_process_cleanup_leaves_other_processes_alive() {
        let mut first_command = sanitized_command(Path::new("/bin/sleep"));
        first_command.arg("30");
        let mut second_command = sanitized_command(Path::new("/bin/sleep"));
        second_command.arg("30");
        let mut first = OwnedProcess::spawn(&mut first_command).unwrap();
        let mut second = OwnedProcess::spawn(&mut second_command).unwrap();
        first.finish().await;
        assert!(first.child.try_wait().unwrap().is_some());
        assert!(second.child.try_wait().unwrap().is_none());
        second.finish().await;
        assert!(second.child.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_timeout_and_output_limits_are_bounded() {
        let mut timeout = sanitized_command(Path::new("/bin/sleep"));
        timeout.arg("30");
        let begin = Instant::now();
        assert!(process_output(timeout, None, 1, 100)
            .await
            .unwrap_err()
            .contains("timed out"));
        assert!(begin.elapsed() < Duration::from_secs(5));
        let yes = sanitized_command(Path::new("/usr/bin/yes"));
        assert!(process_output(yes, None, 2, 100)
            .await
            .unwrap_err()
            .contains("limit"));
    }

    #[test]
    fn corrupted_optional_settings_disable_jev_without_destroying_the_file() {
        let dir = temp();
        let path = dir.join("settings.json");
        private_write(&path, b"not json: this file must be preserved").unwrap();
        let (settings, warning) = load_saved(&path);
        assert!(!settings.settings.enabled);
        assert!(settings.typesafe_key.is_empty());
        assert!(warning.is_some());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "not json: this file must be preserved"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn lifecycle_admission_rejects_shutdown_and_updates() {
        assert!(admission(0).is_ok());
        assert!(admission(1).is_err());
        assert!(admission(2).is_err());
    }

    #[test]
    fn live_watch_is_scoped_expires_and_stops_without_persisting_frames() {
        let dir = temp();
        let mut state = Runtime {
            dir: dir.clone(),
            saved: Saved::default(),
            active: HashMap::new(),
            installing: false,
            setup_warning: None,
        };
        let mut report = Report::starting("live-task", &request());
        let stopped = Arc::new(AtomicBool::new(false));
        state.active.insert(
            report.id.clone(),
            Active {
                report: report.clone(),
                stopped: stopped.clone(),
                watch_until: None,
                watch_generation: 0,
            },
        );
        let now = Instant::now();
        assert!(active_watch(&state, &report, now).is_none());
        assert!(watch_run(&mut state, "other-task", &report.id, true, now).is_err());
        watch_run(&mut state, &report.session_id, &report.id, true, now).unwrap();
        let first_generation = active_watch(&state, &report, now).unwrap().1;
        watch_run(&mut state, &report.session_id, &report.id, true, now).unwrap();
        assert_eq!(
            active_watch(&state, &report, now).unwrap().1,
            first_generation
        );
        assert!(active_watch(&state, &report, now + Duration::from_secs(9)).is_some());
        assert!(active_watch(&state, &report, now + WATCH_TTL).is_none());
        watch_run(&mut state, &report.session_id, &report.id, false, now).unwrap();
        assert!(active_watch(&state, &report, now).is_none());
        watch_run(&mut state, &report.session_id, &report.id, true, now).unwrap();
        assert!(active_watch(&state, &report, now).unwrap().1 > first_generation);
        stopped.store(true, Ordering::SeqCst);
        assert!(active_watch(&state, &report, now).is_none());
        state.active.clear();
        report.status = "done".into();
        persist_report(&dir, &report).unwrap();
        assert!(watch_run(&mut state, &report.session_id, &report.id, true, now).is_ok());
        assert!(watch_run(&mut state, "other-task", &report.id, false, now).is_err());
        assert!(watch_run(&mut state, &report.session_id, "../../other", true, now).is_err());
        assert!(!serde_json::to_string(&report).unwrap().contains("dataUrl"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn live_frames_are_bounded_digest_checked_and_have_fixed_dimensions() {
        let dir = temp();
        let report = Report::starting("live-task", &request());
        let bytes = b"\xff\xd8\xfflive-fixture";
        let path = dir.join("live-frame.jpg");
        private_write(&path, bytes).unwrap();
        let notice = json!({"type":"frame","sequence":1,"sha256":format!("{:x}", Sha256::digest(bytes)),"width":960,"height":600,"elapsedMs":100});
        let frame = read_live_frame(&dir, &report, notice.clone(), 0).unwrap();
        assert_eq!(frame.session_id, report.session_id);
        assert_eq!(frame.run_id, report.id);
        assert!(frame.data_url.starts_with("data:image/jpeg;base64,"));
        assert!(read_live_frame(&dir, &report, notice.clone(), 1).is_none());
        for (key, value) in [
            ("sequence", json!(1501)),
            ("width", json!(4000)),
            ("elapsedMs", json!(700000)),
            ("sha256", json!("a".repeat(64))),
            ("path", json!("/etc/passwd")),
        ] {
            let mut invalid = notice.clone();
            invalid[key] = value;
            assert!(
                read_live_frame(&dir, &report, invalid, 0).is_none(),
                "{key}"
            );
        }
        private_write(&path, b"changed image").unwrap();
        assert!(read_live_frame(&dir, &report, notice.clone(), 0).is_none());
        private_write(&path, &vec![0; MAX_LIVE_FRAME as usize + 1]).unwrap();
        assert!(read_live_frame(&dir, &report, notice.clone(), 0).is_none());
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            let other = dir.join("other.jpg");
            private_write(&other, bytes).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            assert!(read_live_frame(&dir, &report, notice, 0).is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profile_cleanup_is_exclusive_owned_and_recovers_interrupted_runs() {
        let dir = temp();
        let report = Report::starting("profile-test", &request());
        persist_report(&dir, &report).unwrap();
        let profile = ProfileDirectory::create(&report.id).unwrap();
        assert!(ProfileDirectory::create(&report.id).is_err());
        cleanup_interrupted_profiles(&dir);
        assert!(
            profile.path.exists(),
            "A live process still owns this profile"
        );
        private_write(
            &profile.path.join(".pandacode-owner.json"),
            &serde_json::to_vec(&ProfileOwner {
                run_id: report.id.clone(),
                process_id: i32::MAX as u32,
            })
            .unwrap(),
        )
        .unwrap();
        cleanup_interrupted_profiles(&dir);
        assert!(!profile.path.exists());
        let reports = stored_reports(&dir, "profile-test");
        assert_eq!(reports[0].status, "failed");
        assert!(reports[0].summary.contains("interrupted"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
