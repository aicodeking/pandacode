use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::{sync::watch, task::JoinSet};

const FILE_LIMIT: usize = 512 * 1024;
const OUTPUT_LIMIT: usize = 256 * 1024;
const CALL_LIMIT: usize = 16;
type Jobs = JoinSet<(Value, Value)>;

pub(super) fn enabled(provider: &str) -> bool {
    matches!(provider, "codebuddy" | "qoder" | "kiro")
}

pub(super) fn capabilities(provider: &str) -> Value {
    if enabled(provider) {
        json!({"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true})
    } else {
        json!({})
    }
}

pub(super) struct Client {
    pending: HashMap<String, Value>,
    active: HashSet<String>,
    shared: Arc<Shared>,
    sequence: u64,
}

struct Shared {
    root: PathBuf,
    closed: AtomicBool,
    terminals: Mutex<HashMap<String, Terminal>>,
}

struct Terminal {
    output: Arc<Mutex<Output>>,
    exit: watch::Receiver<Option<Value>>,
    kill: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.kill.send(true);
        self.task.abort();
    }
}

#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    truncated: bool,
    limit: usize,
}

impl Output {
    fn snapshot(&self) -> Value {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        let expanded = text.len() > self.limit;
        if expanded {
            let mut trim = text.len() - self.limit;
            while !text.is_char_boundary(trim) {
                trim += 1;
            }
            text.drain(..trim);
        }
        json!({"output":text,"truncated":self.truncated || expanded})
    }
}

fn reply(id: Value, result: Result<Value, String>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}}),
    }
}

fn key(id: &Value) -> Option<String> {
    match id {
        Value::String(s) if !s.is_empty() && s.len() <= 256 => Some(format!("s:{s}")),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(format!("n:{n}")),
        _ => None,
    }
}

pub(super) fn accepts(frame: &Value) -> bool {
    frame.get("id").is_some()
        && matches!(
            field(frame, "method"),
            "fs/read_text_file"
                | "fs/write_text_file"
                | "terminal/create"
                | "terminal/output"
                | "terminal/wait_for_exit"
                | "terminal/kill"
                | "terminal/release"
        )
}

impl Client {
    pub(super) fn new(root: &Path) -> Result<Self, String> {
        Ok(Self {
            pending: HashMap::new(),
            active: HashSet::new(),
            shared: Arc::new(Shared {
                root: root
                    .canonicalize()
                    .map_err(|_| "ACP-Arbeitsverzeichnis ist nicht verfügbar")?,
                closed: AtomicBool::new(false),
                terminals: Mutex::new(HashMap::new()),
            }),
            sequence: 0,
        })
    }

    pub(super) fn request(&mut self, request: Value, protocol: &Protocol, jobs: &mut Jobs) -> Step {
        let mut step = Step::default();
        let id = request["id"].clone();
        let Some(rpc) = key(&id) else {
            step.write
                .push(reply(id, Err("Ungültige ACP-Client-Anfrage-ID".into())));
            return step;
        };
        if protocol.remote_id.is_empty() || request["params"]["sessionId"] != protocol.remote_id {
            step.write.push(reply(
                id,
                Err("ACP-Client-Anfrage gehört zu einer anderen Session".into()),
            ));
            return step;
        }
        if self.active.len() >= CALL_LIMIT || !self.active.insert(rpc) {
            step.write.push(reply(
                id,
                Err("Zu viele oder doppelte ACP-Client-Anfragen".into()),
            ));
            return step;
        }
        let method = field(&request, "method");
        let write = method == "fs/write_text_file";
        let create = method == "terminal/create";
        if (write || create) && (protocol.config.mode == "plan" || protocol.phase == 0) {
            self.finish(&id);
            step.write.push(reply(
                id,
                Err("Diese Aufgabe erlaubt die angeforderte ACP-Aktion nicht".into()),
            ));
        } else if (write && !matches!(protocol.config.mode.as_str(), "auto" | "full"))
            || (create && protocol.config.mode != "full")
        {
            self.sequence += 1;
            let approval = format!("acp-client-{}", self.sequence);
            let params = &request["params"];
            let text = if write {
                format!(
                    "Datei schreiben: {}",
                    model_text(params["path"].as_str(), "Datei", 1000)
                )
            } else {
                format!(
                    "Befehl ausführen: {} {}",
                    model_text(params["command"].as_str(), "Befehl", 1000),
                    preview_json(&params["args"], 2000)
                )
            };
            let mut event = protocol.event("approval", text, None);
            event.request_id = Some(approval.clone());
            step.events.push(event);
            self.pending.insert(approval, request);
        } else {
            self.launch(request, jobs);
        }
        step
    }

    pub(super) fn approve(&mut self, id: &str, approved: bool, jobs: &mut Jobs) -> Option<Step> {
        let request = self.pending.remove(id)?;
        let mut step = Step::default();
        if approved {
            self.launch(request, jobs);
        } else {
            self.finish(&request["id"]);
            step.write.push(reply(
                request["id"].clone(),
                Err("ACP-Aktion abgelehnt".into()),
            ));
        }
        Some(step)
    }

    fn launch(&self, request: Value, jobs: &mut Jobs) {
        let shared = self.shared.clone();
        jobs.spawn(async move {
            let id = request["id"].clone();
            let result = execute(shared, field(&request, "method"), &request["params"]).await;
            (id.clone(), reply(id, result))
        });
    }

    pub(super) fn finish(&mut self, id: &Value) -> bool {
        key(id).is_some_and(|key| self.active.remove(&key))
    }

    pub(super) fn cancel(&mut self, protocol: &Protocol) -> Step {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        let mut step = Step::default();
        for (id, request) in self.pending.drain() {
            step.write.push(reply(
                request["id"].clone(),
                Err("ACP-Aktion abgebrochen".into()),
            ));
            let mut event = protocol.event("approval_cancelled", "", None);
            event.request_id = Some(id);
            step.events.push(event);
        }
        self.active.clear();
        step
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}

fn scoped(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || value.len() > 4096 || !path.is_absolute() || value.contains('\0') {
        return Err("ACP-Pfade müssen absolute Pfade im Arbeitsverzeichnis sein".into());
    }
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("ACP-Pfad liegt außerhalb des Aufgabenverzeichnisses".into());
    }
    let mut ancestor = path;
    let resolved = loop {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let resolved = ancestor
                    .canonicalize()
                    .map_err(|_| "ACP-Pfad ist nicht verfügbar")?;
                if !resolved.starts_with(root) {
                    return Err("ACP-Symlink verweist außerhalb des Aufgabenverzeichnisses".into());
                }
                let suffix = path
                    .strip_prefix(ancestor)
                    .map_err(|_| "Ungültiger ACP-Pfad")?;
                break if suffix.as_os_str().is_empty() {
                    resolved
                } else {
                    resolved.join(suffix)
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or("Ungültiger ACP-Pfad")?;
            }
            Err(_) => return Err("ACP-Pfad ist nicht verfügbar".into()),
        }
    };
    if resolved
        .strip_prefix(root)
        .map_err(|_| "ACP-Pfad liegt außerhalb des Aufgabenverzeichnisses")?
        .components()
        .any(|p| p.as_os_str() == ".git")
    {
        return Err("ACP-Dateizugriffe dürfen Git-Metadaten nicht verändern".into());
    }
    Ok(resolved)
}

async fn execute(shared: Arc<Shared>, method: &str, params: &Value) -> Result<Value, String> {
    if shared.closed.load(Ordering::SeqCst) {
        return Err("ACP-Session wurde beendet".into());
    }
    match method {
        "fs/read_text_file" => {
            let path = scoped(&shared.root, field(params, "path"))?;
            let mut file = tokio::fs::File::open(path)
                .await
                .map_err(|_| "ACP-Datei konnte nicht geöffnet werden")?;
            let mut bytes = Vec::new();
            (&mut file)
                .take((FILE_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "ACP-Datei konnte nicht gelesen werden")?;
            if bytes.len() > FILE_LIMIT {
                return Err("ACP-Textdatei ist größer als 512 KiB".into());
            }
            let text =
                String::from_utf8(bytes).map_err(|_| "ACP-Datei enthält keinen UTF-8-Text")?;
            let line = number(params, "line", 1)?;
            if line == 0 {
                return Err("ACP-Zeilennummern beginnen bei 1".into());
            }
            let limit = number(params, "limit", usize::MAX)?;
            let content: String = text
                .split_inclusive('\n')
                .skip(line - 1)
                .take(limit)
                .collect();
            Ok(json!({"content":content}))
        }
        "fs/write_text_file" => {
            let path = scoped(&shared.root, field(params, "path"))?;
            let content = params["content"]
                .as_str()
                .filter(|s| s.len() <= FILE_LIMIT)
                .ok_or("ACP-Schreibinhalt ist ungültig oder größer als 512 KiB")?;
            // Do not create arbitrary directory trees from an agent callback.
            tokio::fs::write(path, content)
                .await
                .map_err(|_| "ACP-Datei konnte nicht geschrieben werden")?;
            Ok(json!({}))
        }
        "terminal/create" => create_terminal(&shared, params).await,
        method => {
            let id = params["terminalId"]
                .as_str()
                .ok_or("ACP-Terminal-ID fehlt")?;
            let (output, mut exit, kill) = {
                let mut terminals = shared.terminals.lock().unwrap_or_else(|p| p.into_inner());
                if method == "terminal/release" {
                    terminals.remove(id).ok_or("Unbekanntes ACP-Terminal")?;
                    return Ok(json!({}));
                }
                let terminal = terminals.get(id).ok_or("Unbekanntes ACP-Terminal")?;
                (
                    terminal.output.clone(),
                    terminal.exit.clone(),
                    terminal.kill.clone(),
                )
            };
            match method {
                "terminal/output" => {
                    let output = output.lock().unwrap_or_else(|p| p.into_inner());
                    let mut result = output.snapshot();
                    if let Some(status) = exit.borrow().clone() {
                        result["exitStatus"] = status;
                    }
                    Ok(result)
                }
                "terminal/wait_for_exit" => {
                    exit.wait_for(|status| status.is_some())
                        .await
                        .map_err(|_| "ACP-Terminal wurde beendet")?;
                    let status = exit
                        .borrow()
                        .clone()
                        .ok_or("ACP-Terminal-Exit-Status ist nicht verfügbar")?;
                    Ok(status)
                }
                "terminal/kill" => {
                    let _ = kill.send(true);
                    Ok(json!({}))
                }
                _ => Err("Nicht unterstützte ACP-Client-Methode".into()),
            }
        }
    }
}

fn number(params: &Value, name: &str, default: usize) -> Result<usize, String> {
    match &params[name] {
        Value::Null => Ok(default),
        value => value
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| format!("Ungültiger ACP-Wert: {name}")),
    }
}

async fn create_terminal(shared: &Shared, params: &Value) -> Result<Value, String> {
    let cwd = match params["cwd"].as_str() {
        Some(cwd) => scoped(&shared.root, cwd)?,
        None if params["cwd"].is_null() => shared.root.clone(),
        _ => return Err("Ungültiges ACP-Terminalverzeichnis".into()),
    };
    let binary = params["command"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or("Ungültiger ACP-Befehl")?;
    let mut command = super::command(Path::new(binary))?;
    if let Some(args) = params["args"].as_array() {
        if args.len() > 128 {
            return Err("Zu viele ACP-Befehlsargumente".into());
        }
        for arg in args {
            command.arg(
                arg.as_str()
                    .filter(|s| s.len() <= 32 * 1024 && !s.contains('\0'))
                    .ok_or("Ungültiges ACP-Befehlsargument")?,
            );
        }
    } else if !params["args"].is_null() {
        return Err("Ungültige ACP-Befehlsargumente".into());
    }
    if let Some(env) = params["env"].as_array() {
        if env.len() > 64 {
            return Err("Zu viele ACP-Umgebungsvariablen".into());
        }
        for entry in env {
            let name = entry["name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256 && !s.contains(['\0', '=']))
                .ok_or("Ungültiger ACP-Umgebungsvariablenname")?;
            let value = entry["value"]
                .as_str()
                .filter(|s| s.len() <= 32 * 1024 && !s.contains('\0'))
                .ok_or("Ungültiger ACP-Umgebungsvariablenwert")?;
            command.env(name, value);
        }
    } else if !params["env"].is_null() {
        return Err("Ungültige ACP-Umgebungsvariablen".into());
    }
    let cap = number(params, "outputByteLimit", OUTPUT_LIMIT)?.min(OUTPUT_LIMIT);
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut terminals = shared.terminals.lock().unwrap_or_else(|p| p.into_inner());
    if shared.closed.load(Ordering::SeqCst) || terminals.len() >= CALL_LIMIT {
        return Err("ACP-Terminalgrenze erreicht oder Session beendet".into());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "ACP-Befehl konnte nicht gestartet werden")?;
    let group = ProcessGroup::register(child.id());
    let stdout = child
        .stdout
        .take()
        .ok_or("ACP-Terminalausgabe ist nicht verfügbar")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("ACP-Terminalausgabe ist nicht verfügbar")?;
    let output = Arc::new(Mutex::new(Output {
        limit: cap,
        ..Output::default()
    }));
    let captured = output.clone();
    let (exit_tx, exit) = watch::channel(None);
    let (kill, mut canceled) = watch::channel(false);
    let task = tokio::spawn(async move {
        let _group = group;
        let mut readers = JoinSet::new();
        readers.spawn(capture(stdout, captured.clone(), cap));
        readers.spawn(capture(stderr, captured, cap));
        let status = tokio::select! {
            status = child.wait() => status,
            _ = canceled.changed() => {
                if let Some(pid) = child.id() { kill_group(pid); }
                let _ = child.start_kill();
                child.wait().await
            }
        };
        // Descendants must not retain pipes after the leader has exited.
        drop(_group);
        while readers.join_next().await.is_some() {}
        let result = status.map(|status| {
            #[cfg(unix)]
            { use std::os::unix::process::ExitStatusExt; json!({"exitCode":status.code(),"signal":status.signal().map(|s| s.to_string())}) }
            #[cfg(not(unix))]
            { json!({"exitCode":status.code()}) }
        }).unwrap_or_else(|_| json!({"signal":"unknown"}));
        let _ = exit_tx.send(Some(result));
    });
    let id = uuid::Uuid::new_v4().to_string();
    terminals.insert(
        id.clone(),
        Terminal {
            output,
            exit,
            kill,
            task,
        },
    );
    Ok(json!({"terminalId":id}))
}

async fn capture(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    output: Arc<Mutex<Output>>,
    cap: usize,
) {
    let mut bytes = [0u8; 8192];
    while let Ok(count) = reader.read(&mut bytes).await {
        if count == 0 {
            break;
        }
        let mut output = output.lock().unwrap_or_else(|p| p.into_inner());
        output.bytes.extend_from_slice(&bytes[..count]);
        if output.bytes.len() > cap {
            let mut trim = output.bytes.len() - cap;
            while trim < output.bytes.len() && output.bytes[trim] & 0xc0 == 0x80 {
                trim += 1;
            }
            output.bytes.drain(..trim);
            output.truncated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_output_keeps_utf8_within_the_byte_limit() {
        let output = Output {
            bytes: vec![0xc3],
            limit: 1,
            truncated: false,
        };
        assert_eq!(output.snapshot(), json!({"output":"","truncated":true}));
    }

    fn setup(mode: &str) -> (PathBuf, Client, Protocol, Jobs) {
        let root = std::env::temp_dir().join(format!("pandacode-client-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut config = super::super::tests::config("qoder");
        config.mode = mode.into();
        config.cwd = root.clone();
        let mut protocol = Protocol::new(config);
        protocol.remote_id = "session".into();
        protocol.phase = 1;
        (
            root.clone(),
            Client::new(&root).unwrap(),
            protocol,
            Jobs::new(),
        )
    }

    fn request(id: u64, method: &str, mut params: Value) -> Value {
        params["sessionId"] = json!("session");
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
    }

    async fn completed(client: &mut Client, jobs: &mut Jobs) -> Value {
        let (id, response) = tokio::time::timeout(Duration::from_secs(5), jobs.join_next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(client.finish(&id));
        response
    }

    #[tokio::test]
    async fn edits_wait_for_approval_and_decline_does_not_touch_disk() {
        let (root, mut client, protocol, mut jobs) = setup("ask");
        let path = root.join("file.txt");
        let frame = request(
            1,
            "fs/write_text_file",
            json!({"path":path,"content":"one\ntwo\nthree\n"}),
        );
        let step = client.request(frame.clone(), &protocol, &mut jobs);
        assert!(jobs.is_empty());
        assert!(!path.exists());
        let approval = step.events[0].request_id.as_ref().unwrap();
        let declined = client.approve(approval, false, &mut jobs).unwrap();
        assert!(declined.write[0]["error"].is_object());
        assert!(!path.exists());
        let step = client.request(frame, &protocol, &mut jobs);
        client
            .approve(step.events[0].request_id.as_ref().unwrap(), true, &mut jobs)
            .unwrap();
        assert_eq!(completed(&mut client, &mut jobs).await["result"], json!({}));
        client.request(
            request(
                2,
                "fs/read_text_file",
                json!({"path":path,"line":2,"limit":1}),
            ),
            &protocol,
            &mut jobs,
        );
        let read = completed(&mut client, &mut jobs).await;
        assert_eq!(read["result"]["content"], "two\n", "{read}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn foreign_sessions_plan_writes_and_escaped_paths_are_rejected() {
        let (root, mut client, protocol, mut jobs) = setup("plan");
        for method in ["fs/write_text_file", "terminal/create"] {
            let step = client.request(
                request(
                    1,
                    method,
                    json!({"command":"sh","path":root.join("file"),"content":"x"}),
                ),
                &protocol,
                &mut jobs,
            );
            assert!(step.write[0]["error"].is_object());
        }
        let mut frame = request(2, "fs/read_text_file", json!({"path":root.join("file")}));
        frame["params"]["sessionId"] = json!("foreign");
        assert!(client.request(frame, &protocol, &mut jobs).write[0]["error"].is_object());
        assert!(jobs.is_empty());
        assert!(scoped(&client.shared.root, "/etc/hosts").is_err());
        assert!(scoped(
            &client.shared.root,
            &root.join("../escape").to_string_lossy()
        )
        .is_err());
        assert!(scoped(
            &client.shared.root,
            &root.join(".git/config").to_string_lossy()
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
            assert!(scoped(
                &client.shared.root,
                &root.join("escape/hosts").to_string_lossy()
            )
            .is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminals_capture_bounded_output_exit_and_release() {
        let _lock = super::super::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let (root, mut client, protocol, mut jobs) = setup("full");
        client.request(request(1, "terminal/create", json!({"command":"/bin/sh","args":["-c","printf 'aé日xyz'; printf 'stderr' >&2; exit 7"],"outputByteLimit":6})), &protocol, &mut jobs);
        let created = completed(&mut client, &mut jobs).await;
        let id = created["result"]["terminalId"].as_str().unwrap();
        client.request(
            request(2, "terminal/wait_for_exit", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        assert_eq!(
            completed(&mut client, &mut jobs).await["result"]["exitCode"],
            7
        );
        client.request(
            request(3, "terminal/output", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        let output = completed(&mut client, &mut jobs).await;
        assert_eq!(output["result"]["truncated"], true);
        assert!(output["result"]["output"].as_str().unwrap().len() <= 6);
        assert_eq!(output["result"]["exitStatus"]["exitCode"], 7);
        client.request(
            request(4, "terminal/release", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        assert!(completed(&mut client, &mut jobs).await["result"].is_object());
        client.request(
            request(5, "terminal/output", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        assert!(completed(&mut client, &mut jobs).await["error"].is_object());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_cancels_pending_approval_and_running_terminal_waits() {
        let _lock = super::super::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let (root, mut client, mut protocol, mut jobs) = setup("auto");
        let frame = request(
            1,
            "terminal/create",
            json!({"command":"/bin/sh","args":["-c","sleep 60"]}),
        );
        let pending = client.request(frame.clone(), &protocol, &mut jobs);
        assert_eq!(pending.events[0].kind, "approval");
        let cancel = client.cancel(&protocol);
        assert_eq!(cancel.events[0].kind, "approval_cancelled");
        assert!(jobs.is_empty());
        drop(client);
        let mut client = Client::new(&root).unwrap();
        protocol.config.mode = "full".into();
        client.request(frame, &protocol, &mut jobs);
        let created = completed(&mut client, &mut jobs).await;
        let id = created["result"]["terminalId"].as_str().unwrap();
        client.request(
            request(2, "terminal/kill", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        completed(&mut client, &mut jobs).await;
        client.request(
            request(3, "terminal/wait_for_exit", json!({"terminalId":id})),
            &protocol,
            &mut jobs,
        );
        let status = completed(&mut client, &mut jobs).await;
        assert!(status["result"]["signal"].is_string());
        client.cancel(&protocol);
        assert!(client.shared.terminals.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
