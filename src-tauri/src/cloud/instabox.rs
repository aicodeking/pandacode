//! InstaBox (instabox.sh) machines for cloud agents (docs/cloud-agents.md), over the v1 REST
//! API with an `X-API-Key`. Lifecycle calls return operations, polled at `/operations/{id}`;
//! every mutation carries a fresh `Idempotency-Key`. Machines suspend with their memory, so
//! processes freeze rather than die.
//!
//! `exec` runs `bash -lc`, waits at most 600 s and keeps only the *first* 1 MiB of output, so
//! each command runs from a script on the machine with its output in a file: small output
//! comes back in the same call, larger output is read back in 128 KiB pieces keeping the
//! tail. Longer commands run detached and are polled for an exit-code file.
//!
//! New machines start from the image chosen in Settings → Cloud (`snapshotId` or `template`
//! in `Settings.providers["instabox"]`), else from agent-browser.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use super::{http, sandbox::{checked, download_command, Info, Sandbox}, Machine};
use crate::Result;

const SERVICE: &str = "InstaBox";
const DEFAULT_API: &str = "https://api.instabox.sh/v1";
const KEY: &str = "instabox_key";
/// The default template, and the only one the free plan creates from.
const TEMPLATE: &str = "agent-browser";
/// Metadata on every machine PandaCode creates; `list` shows only these.
const LABEL: (&str, &str) = ("created-by", "pandacode");
/// InstaBox's longest waiting `exec`, in seconds.
const WAIT_MAX: u64 = 600;
/// Output returned in the command's own reply; InstaBox keeps the first 1 MiB of stdout.
const INLINE: u64 = 1_000_000;
/// Output kept for a caller (the `exec` contract asks for at least 4 MiB).
const KEEP: u64 = 4 * 1024 * 1024;
/// Bytes per read-back call.
const PIECE: usize = 128 * 1024;
/// The longest activity lease InstaBox grants, in seconds.
const LEASE_MAX: u64 = 3600;
/// PandaCode's lease on each machine (`PUT /machines/{id}/activity-leases/{lease}`).
const LEASE: &str = "pandacode";
/// A create from a snapshot with storage took 93–560 s live (from a template: seconds).
const OPERATION_MAX: Duration = Duration::from_secs(20 * 60);
const POLL: Duration = if cfg!(test) { Duration::from_millis(10) } else { Duration::from_secs(3) };

/// A pause freezes every process, and after a resume clients still reuse keep-alive sockets
/// whose connections are gone: a harness alive across the pause sends its next model request
/// into a dead socket and hangs. This watcher (started once per boot) notices the wall clock
/// jumping ahead of the frozen uptime and closes outbound HTTP(S) connections so clients
/// reconnect. `ss -K` needs passwordless sudo, which agent-browser has; without it the
/// watcher runs but closes nothing.
const RECONNECT: &str = r#"d="$HOME/.pandacode"; mkdir -p "$d" || exit 1
[ -f "$d/reconnect.pid" ] && kill -0 "$(cat "$d/reconnect.pid")" 2>/dev/null && exit 0
cat > "$d/reconnect.sh" <<'EOF'
echo $$ > "$HOME/.pandacode/reconnect.pid"
gap() { echo $(( $(date +%s) - $(cut -d. -f1 /proc/uptime) )); }
last=$(gap)
while sleep 5; do
  now=$(gap)
  [ $((now - last)) -gt 20 ] && sudo -n ss -K state established '( dport = :443 or dport = :80 )' > /dev/null 2>&1
  last=$now
done
EOF
setsid nohup sh "$d/reconnect.sh" > /dev/null 2>&1 < /dev/null &"#;

pub struct InstaBox {
    api: String,
    key: String,
    /// What new machines start from: (`templateId` or `snapshotId`, ID).
    image: (&'static str, String),
}

/// A machine image the Settings → Cloud select offers; `value` is `template:<id>` or
/// `snapshot:<id>`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Image {
    pub value: String,
    pub label: String,
}
#[derive(Debug, Serialize)]
pub struct Images {
    pub images: Vec<Image>,
    /// The saved choice, as an `Image::value`.
    pub selected: String,
}

/// The create field and ID for the image saved in `Settings.providers["instabox"]`.
fn saved_image(options: Option<&BTreeMap<String, String>>) -> (&'static str, String) {
    let saved = |name: &str| options.and_then(|o| o.get(name)).filter(|id| !id.is_empty()).cloned();
    match (saved("snapshotId"), saved("template")) {
        (Some(id), _) => ("snapshotId", id),
        (None, Some(id)) => ("templateId", id),
        (None, None) => ("templateId", TEMPLATE.into()),
    }
}
fn image_value((field, id): &(&'static str, String)) -> String {
    format!("{}:{id}", if *field == "snapshotId" { "snapshot" } else { "template" })
}
/// What `set_image` saves for an image value: snapshotId or template (none for agent-browser).
fn image_options(value: &str) -> Option<(&'static str, &str)> {
    match value.split_once(':')? {
        ("snapshot", id) => Some(("snapshotId", id)),
        ("template", id) if id != TEMPLATE => Some(("template", id)),
        _ => None,
    }
}

fn machine(vm: &Value) -> Machine {
    let id = vm["id"].as_str().unwrap_or_default();
    let state = match vm["state"].as_str().unwrap_or("unknown") {
        "running" if vm["runtime"]["ready"].as_bool() == Some(false) => "starting",
        "running" => "running",
        "creating" | "starting" | "resuming" => "starting",
        "stopping" | "suspending" | "deleting" => "stopping",
        "suspended" | "stopped" => "stopped",
        other => other,
    };
    Machine {
        id: format!("instabox:{id}"),
        provider: "instabox".into(),
        name: vm["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("InstaBox · {}", vm["snapshot"]["id"].as_str().or(vm["template"]["id"].as_str()).unwrap_or(TEMPLATE)),
    }
}

/// InstaBox machine IDs go into URL paths, so only plain IDs are accepted.
fn valid_id(id: &str) -> Result<&str> {
    let plain = (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    plain.then_some(id).ok_or_else(|| "Unknown InstaBox machine.".into())
}

/// Prints `<exit code> <output bytes>`, then the output itself (and cleans up) when it fits.
fn report(file: &str) -> String {
    format!("s=$(wc -c <{file}.out | tr -d ' '); echo \"$(cat {file}.code) $s\"; if [ \"$s\" -le {INLINE} ]; then cat {file}.out; rm -f {file}.*; fi")
}

impl InstaBox {
    pub fn new(api: Option<String>, key: String) -> Self {
        InstaBox { api: api.unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key, image: ("templateId", TEMPLATE.into()) }
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value> {
        let mut request = http::client(timeout)?.request(method.clone(), format!("{}{path}", self.api)).header("X-API-Key", &self.key);
        if method != reqwest::Method::GET {
            request = request.header("Idempotency-Key", uuid::Uuid::new_v4().to_string());
        }
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    /// Wait for an operation to succeed and return its final state.
    async fn settle(&self, operation: Value) -> Result<Value> {
        let id = operation["id"].as_str().ok_or("InstaBox did not return an operation.")?.to_string();
        let (deadline, mut current) = (Instant::now() + OPERATION_MAX, operation);
        loop {
            match current["state"].as_str() {
                Some("succeeded") => return Ok(current),
                Some("failed" | "canceled" | "cancelled") => {
                    let what = current["type"].as_str().unwrap_or("operation");
                    return Err(format!("InstaBox could not finish the {what}: {}", current["error"]["message"].as_str().unwrap_or("no reason given")));
                }
                _ if Instant::now() >= deadline => return Err("InstaBox is still working on it; try again in a minute.".into()),
                _ => {}
            }
            tokio::time::sleep(POLL).await;
            current = self.call(reqwest::Method::GET, &format!("/operations/{id}"), None, Duration::from_secs(30)).await?;
        }
    }
    async fn get(&self, id: &str) -> Result<Value> {
        let id = valid_id(id)?;
        self.call(reqwest::Method::GET, &format!("/machines/{id}"), None, Duration::from_secs(30)).await
    }
    async fn list(&self) -> Result<Vec<Machine>> {
        let (mut machines, mut cursor) = (Vec::new(), None::<String>);
        loop {
            let mut query = reqwest::Url::parse("https://x/").map_err(|e| e.to_string())?;
            query.query_pairs_mut().append_pair("metadata", &format!("{}:{}", LABEL.0, LABEL.1)).extend_pairs(cursor.iter().map(|c| ("cursor", c)));
            let page = self.call(reqwest::Method::GET, &format!("/machines?{}", query.query().unwrap_or_default()), None, Duration::from_secs(30)).await?;
            // Filter again: never show or touch a machine without PandaCode's label.
            machines.extend(page["machines"].as_array().into_iter().flatten().filter(|m| m["metadata"][LABEL.0] == LABEL.1).map(machine));
            cursor = page["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
            if cursor.is_none() {
                return Ok(machines);
            }
        }
    }
    async fn create(&self, name: &str) -> Result<Machine> {
        let mut body = json!({"name": name, "metadata": {LABEL.0: LABEL.1}});
        body[self.image.0] = self.image.1.as_str().into();
        let operation = self.call(reqwest::Method::POST, "/machines", Some(body), Duration::from_secs(60)).await?;
        let id = operation["machineId"].as_str().map(str::to_string);
        let done = self.settle(operation).await?;
        let id = done["machineId"].as_str().map(str::to_string).or(id).ok_or("InstaBox did not return a machine ID.")?;
        Ok(machine(&self.get(&id).await?))
    }
    /// The machine, only when PandaCode created it.
    async fn owned(&self, id: &str) -> Result<Value> {
        let vm = self.get(id).await?;
        if vm["metadata"][LABEL.0] != LABEL.1 {
            return Err("PandaCode only controls InstaBox machines it created.".into());
        }
        Ok(vm)
    }
    async fn power(&self, id: &str, action: &str) -> Result<()> {
        let timeout = Duration::from_secs(60);
        if !matches!(action, "start" | "stop" | "delete") {
            return Err(format!("InstaBox machines can start, stop or be deleted, not {action}."));
        }
        let state = self.owned(id).await?["state"].as_str().unwrap_or_default().to_string();
        let operation = match (action, state.as_str()) {
            ("start", "suspended") => self.call(reqwest::Method::POST, &format!("/machines/{id}/resume"), Some(json!({})), timeout).await?,
            ("start", "stopped") => self.call(reqwest::Method::POST, &format!("/machines/{id}/start"), Some(json!({})), timeout).await?,
            ("stop", "running") => self.call(reqwest::Method::POST, &format!("/machines/{id}/suspend"), Some(json!({})), timeout).await?,
            ("delete", _) => self.call(reqwest::Method::DELETE, &format!("/machines/{id}"), None, timeout).await?,
            _ => return Ok(()),
        };
        if operation.is_null() { Ok(()) } else { self.settle(operation).await.map(|_| ()) }
    }
    /// An activity lease (at most an hour; it wakes a paused machine first) holds off the idle
    /// pause, and a full idle period starts when it expires. The idle pause itself changes
    /// only for accounts with manual lifecycle: every other plan answers the PATCH with its
    /// fixed 30 minutes, so the lease is always taken. Then the reconnect watcher starts.
    async fn keep_alive(&self, id: &str, minutes: u32) -> Result<()> {
        self.owned(id).await?;
        let seconds = u64::from(minutes.max(1)) * 60;
        let lease = json!({"ttlSeconds": seconds.clamp(30, LEASE_MAX)});
        self.call(reqwest::Method::PUT, &format!("/machines/{id}/activity-leases/{LEASE}"), Some(lease), Duration::from_secs(30)).await?;
        // A key with only `machines:exec` may lease but not PATCH; the lease is what counts.
        let _ = self.call(reqwest::Method::PATCH, &format!("/machines/{id}"), Some(json!({"autoSuspendAfterSeconds": seconds.clamp(120, 86_400)})), Duration::from_secs(30)).await;
        checked(self.exec(id, RECONNECT, Duration::from_secs(30)).await?)
    }
    /// What new machines can start from: agent-browser, the account's ready snapshots, and
    /// other templates when the org new machines go to (the key's workspace, else the
    /// personal one) is on a paid plan; the free plan creates from agent-browser only.
    async fn images(&self) -> Result<Vec<Image>> {
        let get = |path: &'static str| self.call(reqwest::Method::GET, path, None, Duration::from_secs(30));
        let (snapshots, me, orgs) = (get("/snapshots").await?, get("/me").await?, get("/orgs").await?);
        let mut images = vec![Image { value: format!("template:{TEMPLATE}"), label: format!("{TEMPLATE} (default, includes the open-computer-use desktop tool)") }];
        images.extend(snapshots["snapshots"].as_array().into_iter().flatten().filter(|s| s["status"] == "ready").filter_map(|s| {
            let id = s["id"].as_str()?;
            Some(Image { value: format!("snapshot:{id}"), label: format!("{} · {id}", s["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("snapshot")) })
        }));
        let home = orgs["orgs"].as_array().into_iter().flatten().find(|org| match me["orgId"].as_str() {
            Some(workspace) => org["id"] == workspace,
            None => org["personal"] == true,
        });
        if home.is_some_and(|org| org["tier"].as_str().is_some_and(|tier| tier != "free")) {
            let templates = get("/templates").await?;
            let mut ids: Vec<&str> = templates["templates"].as_array().into_iter().flatten().filter(|t| t["hidden"] != true).filter_map(|t| t["id"].as_str()).filter(|id| *id != TEMPLATE).collect();
            ids.sort_unstable();
            ids.dedup();
            images.extend(ids.into_iter().map(|id| Image { value: format!("template:{id}"), label: id.to_string() }));
        }
        Ok(images)
    }
    /// The images, when `value` is one of them.
    async fn check_image(&self, value: &str) -> Result<Vec<Image>> {
        let images = self.images().await?;
        if !images.iter().any(|image| image.value == value) {
            return Err("InstaBox can't create machines from that image on this account. Pick another one.".into());
        }
        Ok(images)
    }
    /// One `exec` call; the reply's stdout, or None when InstaBox stopped it at `seconds`.
    async fn run(&self, id: &str, cmd: &str, stdin: Option<&str>, seconds: u64) -> Result<Option<String>> {
        let mut body = json!({"cmd": cmd, "timeoutSeconds": seconds.clamp(1, WAIT_MAX)});
        if let Some(stdin) = stdin {
            body["stdin"] = stdin.into();
        }
        let result = self.call(reqwest::Method::POST, &format!("/machines/{id}/exec"), Some(body), Duration::from_secs(seconds + 70)).await?;
        Ok((result["timedOut"].as_bool() != Some(true)).then(|| result["stdout"].as_str().unwrap_or_default().to_string()))
    }
    async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        self.owned(id).await?;
        let file = format!("/tmp/pandacode-exec-{}", uuid::Uuid::new_v4().simple());
        let seconds = timeout.as_secs().max(1);
        // The command arrives on stdin, so it needs no quoting and stays within the 64 KiB `cmd`.
        let save = format!("cat >{file}.sh; ");
        let reply = if seconds <= WAIT_MAX {
            let script = format!("{save}bash {file}.sh >{file}.out 2>&1 </dev/null; echo $? >{file}.code; {}", report(&file));
            match self.run(id, &script, Some(command), seconds).await? {
                Some(reply) => reply,
                None => {
                    let _ = self.run(id, &format!("rm -f {file}.*"), None, 30).await;
                    return Ok((None, format!("Timed out after {seconds} s.")));
                }
            }
        } else {
            let detached = format!("bash {file}.sh >{file}.out 2>&1 </dev/null; echo $? >{file}.tmp; mv {file}.tmp {file}.code");
            let script = format!("{save}setsid nohup sh -c '{detached}' >/dev/null 2>&1 </dev/null & echo $! >{file}.pid");
            self.run(id, &script, Some(command), 60).await?.ok_or("InstaBox did not start the command.")?;
            let (deadline, poll) = (Instant::now() + timeout, format!("[ -f {file}.code ] && {{ {}; }}", report(&file)));
            loop {
                if let Some(reply) = self.run(id, &poll, None, 60).await?.filter(|r| !r.is_empty()) {
                    break reply;
                }
                if Instant::now() >= deadline {
                    let _ = self.run(id, &format!("kill -TERM -- -$(cat {file}.pid) 2>/dev/null; rm -f {file}.*"), None, 30).await;
                    return Ok((None, format!("Timed out after {seconds} s.")));
                }
                tokio::time::sleep(POLL).await;
            }
        };
        self.collect(id, &file, &reply).await
    }
    /// The exit code and output from a `report` reply, reading large output back in pieces.
    async fn collect(&self, id: &str, file: &str, reply: &str) -> Result<(Option<i32>, String)> {
        let (header, inline) = reply.split_once('\n').unwrap_or((reply, ""));
        let mut fields = header.split_whitespace();
        let code = fields.next().and_then(|c| c.parse().ok());
        let size: u64 = fields.next().and_then(|s| s.parse().ok()).ok_or("InstaBox sent an unreadable command result.")?;
        if size <= INLINE {
            return Ok((code, inline.to_string()));
        }
        let (output, mut offset, mut bytes) = (format!("{file}.out"), size.saturating_sub(KEEP), Vec::new());
        while offset < size {
            let piece = self.run(id, &download_command(&output, offset, PIECE), None, 120).await?.unwrap_or_default();
            let piece = STANDARD.decode(piece.trim()).map_err(|_| "The cloud machine sent output PandaCode could not read.")?;
            if piece.is_empty() {
                break;
            }
            offset += piece.len() as u64;
            bytes.extend(piece);
        }
        let _ = self.run(id, &format!("rm -f {file}.*"), None, 30).await;
        Ok((code, String::from_utf8_lossy(&bytes).into_owned()))
    }
}

impl Sandbox for InstaBox {
    /// Suspended machines keep disk and memory. The activity lease keeps one awake for up to
    /// an hour; after it, InstaBox's idle pause applies.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        http::block(InstaBox::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        http::block(InstaBox::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        http::block(InstaBox::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        http::block(InstaBox::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        http::block(InstaBox::keep_alive(self, native, minutes))
    }
}

/// Check the key with a real request, then save it.
pub fn connect(key: &str, _options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter an InstaBox API key (ibk_…).".into());
    }
    let count = http::block(InstaBox::new(None, key.to_string()).list())?.len();
    super::set_secret(KEY, key)?;
    let mut settings = super::settings();
    settings.providers.insert("instabox".into(), [("detail".to_string(), format!("InstaBox · {count} PandaCode machines"))].into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret(KEY);
    let mut settings = super::settings();
    settings.providers.remove("instabox");
    super::save_settings(&settings)
}
fn connected() -> Result<InstaBox> {
    let key = super::secret(KEY).ok_or("Connect InstaBox in Settings → Cloud first.")?;
    let mut instabox = InstaBox::new(None, key);
    instabox.image = saved_image(super::settings().providers.get("instabox"));
    Ok(instabox)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(connected()?))
}
/// The machine images for Settings → Cloud, with the saved one.
pub fn images() -> Result<Images> {
    let instabox = connected()?;
    Ok(Images { images: http::block(instabox.images())?, selected: image_value(&instabox.image) })
}
/// Save the image new machines start from, once InstaBox shows the account can use it.
pub fn set_image(value: &str) -> Result<Images> {
    let images = http::block(connected()?.check_image(value))?;
    let mut settings = super::settings();
    let options = settings.providers.entry("instabox".into()).or_default();
    options.remove("snapshotId");
    options.remove("template");
    if let Some((name, id)) = image_options(value) {
        options.insert(name.into(), id.into());
    }
    super::save_settings(&settings)?;
    Ok(Images { images, selected: value.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{http::mock, sandbox::checked};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// 1.5 MB of output whose only error is on the last line.
    fn big() -> Vec<u8> {
        let mut out = b"ok\n".repeat(500_000 - 4);
        out.extend_from_slice(b"error: boom\n");
        out
    }

    fn exec_reply(stdout: &str) -> (u16, Vec<u8>) {
        (200, json!({"stdout": stdout, "stderr": "", "exitCode": 0, "timedOut": false, "truncated": false}).to_string().into_bytes())
    }

    fn instabox() -> (InstaBox, mock::Seen) {
        instabox_on("free")
    }

    /// The API for an account whose new machines go to a workspace on `tier`.
    fn instabox_on(tier: &'static str) -> (InstaBox, mock::Seen) {
        let (polls, operations) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (base, seen) = mock::serve(move |request, _| -> (u16, Vec<u8>) {
            let body: Value = serde_json::from_str(&request.body).unwrap_or_default();
            let (cmd, stdin) = (body["cmd"].as_str().unwrap_or_default(), body["stdin"].as_str().unwrap_or_default());
            let text = |s: &str| (200, s.as_bytes().to_vec());
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/v1/machines?metadata=created-by%3Apandacode") => text(r#"{"machines":[{"id":"m_1","name":"pc-a","state":"running","runtime":{"ready":true},"metadata":{"created-by":"pandacode"}},{"id":"m_9","name":"other","state":"running"}],"nextCursor":"c/2"}"#),
                ("GET", "/v1/machines?metadata=created-by%3Apandacode&cursor=c%2F2") => text(r#"{"machines":[{"id":"m_2","name":"","state":"suspended","metadata":{"created-by":"pandacode"}}],"nextCursor":null}"#),
                // From a snapshot, the new machine is m_4.
                ("POST", "/v1/machines") if request.body.contains("snapshotId") => (202, br#"{"id":"op_4","machineId":"m_4","type":"create","state":"succeeded"}"#.to_vec()),
                ("POST", "/v1/machines") => (202, br#"{"id":"op_1","machineId":"m_3","type":"create","state":"pending"}"#.to_vec()),
                ("GET", "/v1/machines/m_4") => text(r#"{"id":"m_4","name":"pc-snap","state":"running","snapshot":{"id":"sn_ok"},"template":{"id":"agent-browser"}}"#),
                ("GET", "/v1/snapshots") => text(r#"{"snapshots":[{"id":"sn_ok","name":"clean","status":"ready"},{"id":"sn_new","name":"half","status":"pending"},{"id":"sn_x","name":"","status":"ready"}]}"#),
                ("GET", "/v1/me") => text(r#"{"login":"octo","orgId":"org_w","manualLifecycle":false}"#),
                ("GET", "/v1/orgs") => text(&format!(r#"{{"orgs":[{{"id":"org_p","personal":true,"tier":"free"}},{{"id":"org_w","personal":false,"tier":"{tier}"}}]}}"#)),
                ("GET", "/v1/templates") => text(r#"{"templates":[{"id":"agent-browser"},{"id":"herdr","version":"1"},{"id":"herdr","version":"2"},{"id":"base","hidden":true},{"id":"universal"}]}"#),
                ("GET", "/v1/operations/op_1") if operations.fetch_add(1, Ordering::SeqCst) == 0 => text(r#"{"id":"op_1","machineId":"m_3","state":"running"}"#),
                ("GET", "/v1/operations/op_1") => text(r#"{"id":"op_1","machineId":"m_3","state":"succeeded"}"#),
                ("GET", "/v1/machines/m_3") => text(r#"{"id":"m_3","name":"pc-new","state":"running","runtime":{"ready":false}}"#),
                ("GET", "/v1/machines/m_2") => text(r#"{"id":"m_2","state":"suspended","metadata":{"created-by":"pandacode"}}"#),
                ("GET", "/v1/machines/m_1") => text(r#"{"id":"m_1","state":"running","metadata":{"created-by":"pandacode"}}"#),
                ("GET", "/v1/machines/m_9") => text(r#"{"id":"m_9","state":"running","metadata":{}}"#),
                ("POST", "/v1/machines/m_2/resume") => (202, br#"{"id":"op_2","state":"succeeded"}"#.to_vec()),
                ("DELETE", "/v1/machines/m_2") => (202, br#"{"id":"op_3","type":"delete","state":"failed","error":{"message":"busy"}}"#.to_vec()),
                // As live on the free plan: the PATCH succeeds but keeps the fixed 30 minutes.
                ("PATCH", "/v1/machines/m_1") => text(r#"{"id":"m_1","autoSuspendAfterSeconds":1800}"#),
                ("PUT", "/v1/machines/m_1/activity-leases/pandacode") => text(r#"{"id":"pandacode","machineId":"m_1","expiresAt":"2026-10-24T07:30:21Z"}"#),
                ("POST", "/v1/machines/m_1/exec") if stdin.contains("reconnect.sh") => exec_reply("0 0\n"),
                ("POST", "/v1/machines/m_1/exec") if cmd.contains("tail -c +") => {
                    let number = |after: &str| cmd.split(after).nth(1).and_then(|r| r.split(' ').next()).and_then(|n| n.parse::<usize>().ok()).unwrap();
                    let (start, max, all) = (number("tail -c +") - 1, number("head -c "), big());
                    exec_reply(&STANDARD.encode(&all[start.min(all.len())..(start + max).min(all.len())]))
                }
                ("POST", "/v1/machines/m_1/exec") if cmd.contains("setsid") => exec_reply(""),
                ("POST", "/v1/machines/m_1/exec") if cmd.starts_with("[ -f") => exec_reply(if polls.fetch_add(1, Ordering::SeqCst) == 0 { "" } else { "0 4\nlong" }),
                ("POST", "/v1/machines/m_1/exec") if stdin == "ls" => exec_reply("2 6\nouterr"),
                ("POST", "/v1/machines/m_1/exec") if stdin == "big" => exec_reply(&format!("1 {}\n", big().len())),
                ("POST", "/v1/machines/m_1/exec") if stdin == "sleep" => (200, json!({"stdout": "", "exitCode": -1, "timedOut": true}).to_string().into_bytes()),
                ("POST", "/v1/machines/m_1/exec") => exec_reply(""),
                _ => (404, br#"{"error":{"message":"not found"}}"#.to_vec()),
            }
        });
        (InstaBox::new(Some(format!("{base}/v1/")), "ibk_k".into()), seen)
    }

    #[tokio::test]
    async fn lists_creates_and_controls_machines_through_operations() {
        let (instabox, seen) = instabox();
        let listed = instabox.list().await.unwrap();
        assert_eq!(listed.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("instabox:m_1", "pc-a", "running"), ("instabox:m_2", "m_2", "stopped")]);
        let created = instabox.create("pc-new").await.unwrap();
        assert_eq!((created.id.as_str(), created.state.as_str()), ("instabox:m_3", "starting"));
        instabox.power("m_2", "start").await.unwrap();
        assert!(instabox.power("m_2", "delete").await.unwrap_err().contains("busy"));
        assert!(instabox.power("m_2", "pause").await.is_err());
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().filter(|r| r.path == "/v1/operations/op_1").count(), 2, "polled until it succeeded");
        assert!(log.iter().all(|r| r.headers.iter().any(|(n, v)| n == "x-api-key" && v == "ibk_k")));
        let keys: Vec<&str> = log.iter().filter(|r| r.method != "GET").map(|r| r.headers.iter().find(|(n, _)| n == "idempotency-key").map(|(_, v)| v.as_str()).expect("mutation without an Idempotency-Key")).collect();
        assert_eq!(keys.len(), 3);
        assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), keys.len(), "each mutation gets its own key");
        assert!(log.iter().filter(|r| r.method == "GET").all(|r| !r.headers.iter().any(|(n, _)| n == "idempotency-key")));
        let create: Value = serde_json::from_str(&log.iter().find(|r| r.method == "POST" && r.path == "/v1/machines").unwrap().body).unwrap();
        assert_eq!(create, json!({"name": "pc-new", "templateId": "agent-browser", "metadata": {"created-by": "pandacode"}}));
    }

    #[tokio::test]
    async fn keep_alive_takes_the_machine_lease_even_when_the_idle_patch_succeeds() {
        let (instabox, seen) = instabox();
        instabox.keep_alive("m_1", 60).await.unwrap();
        instabox.keep_alive("m_1", 15).await.unwrap();
        // Over the hour InstaBox grants, the lease is capped.
        instabox.keep_alive("m_1", 24 * 60).await.unwrap();
        let log = seen.lock().unwrap();
        let leases: Vec<Value> = log.iter().filter(|r| r.method == "PUT").map(|r| {
            assert_eq!(r.path, "/v1/machines/m_1/activity-leases/pandacode");
            serde_json::from_str(&r.body).unwrap()
        }).collect();
        assert_eq!(leases, vec![json!({"ttlSeconds": 3600}), json!({"ttlSeconds": 900}), json!({"ttlSeconds": 3600})]);
        let idle: Vec<Value> = log.iter().filter(|r| r.method == "PATCH").map(|r| serde_json::from_str(&r.body).unwrap()).collect();
        assert_eq!(idle, vec![json!({"autoSuspendAfterSeconds": 3600}), json!({"autoSuspendAfterSeconds": 900}), json!({"autoSuspendAfterSeconds": 86400})]);
    }

    #[tokio::test]
    async fn keep_alive_starts_the_reconnect_watcher_and_fails_when_it_cannot() {
        let (instabox, seen) = instabox();
        instabox.keep_alive("m_1", 60).await.unwrap();
        {
            let log = seen.lock().unwrap();
            let watcher: Vec<Value> = log.iter().filter(|r| r.path == "/v1/machines/m_1/exec").map(|r| serde_json::from_str(&r.body).unwrap()).collect();
            assert_eq!(watcher.len(), 1);
            let script = watcher[0]["stdin"].as_str().unwrap();
            assert!(script.contains("sudo -n ss -K state established '( dport = :443 or dport = :80 )'"), "{script}");
            assert!(script.contains("kill -0") && script.contains("/proc/uptime") && script.contains("setsid nohup"), "{script}");
        }
        // A machine where the watcher can't start (here: no writable HOME) fails the keep-alive.
        let (base, _) = mock::serve(|request, _| -> (u16, Vec<u8>) {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/v1/machines/m_1") => (200, br#"{"id":"m_1","state":"running","metadata":{"created-by":"pandacode"}}"#.to_vec()),
                ("POST", "/v1/machines/m_1/exec") => exec_reply("1 9\nread-only"),
                _ => (200, b"{}".to_vec()),
            }
        });
        let error = InstaBox::new(Some(format!("{base}/v1")), "test-key".into()).keep_alive("m_1", 60).await.unwrap_err();
        assert!(error.contains("read-only"), "{error}");
    }

    #[tokio::test]
    async fn offers_agent_browser_ready_snapshots_and_templates_only_on_a_paid_plan() {
        let values = |images: &[Image]| images.iter().map(|i| i.value.clone()).collect::<Vec<_>>();
        let (free, seen) = instabox_on("free");
        let images = free.images().await.unwrap();
        assert_eq!(values(&images), ["template:agent-browser", "snapshot:sn_ok", "snapshot:sn_x"]);
        assert_eq!(images[0].label, "agent-browser (default, includes the open-computer-use desktop tool)");
        assert_eq!((images[1].label.as_str(), images[2].label.as_str()), ("clean · sn_ok", "snapshot · sn_x"));
        assert!(seen.lock().unwrap().iter().all(|r| r.path != "/v1/templates"), "free plans never list templates");
        // The key's workspace is on Pro (its personal org stays free): every visible template.
        let (pro, _) = instabox_on("pro");
        assert_eq!(values(&pro.images().await.unwrap()), ["template:agent-browser", "snapshot:sn_ok", "snapshot:sn_x", "template:herdr", "template:universal"]);

        for refused in ["template:herdr", "snapshot:sn_new", "snapshot:sn_gone", "template:base", "sn_ok", ""] {
            assert!(free.check_image(refused).await.unwrap_err().contains("can't create machines from that image"), "{refused}");
        }
        free.check_image("snapshot:sn_ok").await.unwrap();
        pro.check_image("template:herdr").await.unwrap();
        assert!(pro.check_image("template:base").await.is_err(), "hidden templates can't be chosen");
    }

    #[tokio::test]
    async fn new_machines_start_from_the_saved_snapshot_or_template() {
        let saved = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
        for (value, stored) in [("snapshot:sn_ok", Some(("snapshotId", "sn_ok"))), ("template:herdr", Some(("template", "herdr"))), ("template:agent-browser", None)] {
            assert_eq!(image_options(value), stored, "{value}");
            let options = saved(&stored.map(|s| vec![s]).unwrap_or_default());
            assert_eq!(image_value(&saved_image(Some(&options))), value, "round trip");
        }
        assert_eq!(saved_image(None), ("templateId", TEMPLATE.into()));
        assert_eq!(saved_image(Some(&saved(&[("snapshotId", "sn_ok"), ("template", "herdr")]))), ("snapshotId", "sn_ok".into()), "a snapshot wins");

        let (mut instabox, seen) = instabox();
        instabox.image = saved_image(Some(&saved(&[("snapshotId", "sn_ok")])));
        let made = instabox.create("pc-snap").await.unwrap();
        assert_eq!((made.id.as_str(), made.state.as_str(), made.detail.as_str()), ("instabox:m_4", "running", "InstaBox · sn_ok"));
        instabox.image = saved_image(Some(&saved(&[("template", "herdr")])));
        instabox.create("pc-new").await.unwrap();
        let log = seen.lock().unwrap();
        let creates: Vec<Value> = log.iter().filter(|r| r.method == "POST" && r.path == "/v1/machines").map(|r| serde_json::from_str(&r.body).unwrap()).collect();
        assert_eq!(creates, vec![json!({"name": "pc-snap", "snapshotId": "sn_ok", "metadata": {"created-by": "pandacode"}}), json!({"name": "pc-new", "templateId": "herdr", "metadata": {"created-by": "pandacode"}})]);
    }

    #[tokio::test]
    async fn runs_commands_from_stdin_and_reads_large_output_tail() {
        let (instabox, seen) = instabox();
        assert_eq!(instabox.exec("m_1", "ls", Duration::from_secs(30)).await.unwrap(), (Some(2), "outerr".into()));
        let (code, output) = instabox.exec("m_1", "big", Duration::from_secs(30)).await.unwrap();
        assert_eq!((code, output.len()), (Some(1), big().len()));
        assert!(output.ends_with("error: boom\n"));
        assert!(checked((code, output)).unwrap_err().contains("error: boom"));
        assert_eq!(instabox.exec("m_1", "sleep", Duration::from_secs(5)).await.unwrap().0, None);
        let log = seen.lock().unwrap();
        let bodies: Vec<Value> = log.iter().filter(|r| r.method == "POST").map(|r| serde_json::from_str(&r.body).unwrap()).collect();
        let pieces: Vec<&Value> = bodies.iter().filter(|b| b["cmd"].as_str().unwrap().contains("tail -c +")).collect();
        assert_eq!(pieces.len(), big().len().div_ceil(PIECE));
        assert!(pieces.iter().all(|b| b["cmd"].as_str().unwrap().contains(&format!("head -c {PIECE}"))));
        let first = &bodies[0];
        assert_eq!((first["stdin"].as_str(), first["timeoutSeconds"].as_u64()), (Some("ls"), Some(30)));
        assert!(bodies.iter().all(|b| b["timeoutSeconds"].as_u64().unwrap() <= WAIT_MAX && b["cmd"].as_str().unwrap().len() < 64 * 1024));
    }

    #[tokio::test]
    async fn polls_commands_longer_than_ten_minutes() {
        let (instabox, seen) = instabox();
        assert_eq!(instabox.exec("m_1", "build", Duration::from_secs(1800)).await.unwrap(), (Some(0), "long".into()));
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().filter(|r| r.body.contains("[ -f")).count(), 2);
    }

    #[tokio::test]
    async fn refuses_unlabelled_machines_and_unsafe_ids() {
        let (instabox, seen) = instabox();
        for action in ["start", "stop", "delete"] {
            assert!(instabox.power("m_9", action).await.unwrap_err().contains("it created"), "{action}");
        }
        assert!(instabox.exec("m_9", "ls", Duration::from_secs(30)).await.unwrap_err().contains("it created"));
        assert!(instabox.keep_alive("m_9", 30).await.unwrap_err().contains("it created"));
        for id in ["m_1/exec", "m_1?x", "m_1#x", "..", "../operations/op_1", "", &"a".repeat(129)] {
            assert_eq!(instabox.exec(id, "ls", Duration::from_secs(30)).await.unwrap_err(), "Unknown InstaBox machine.", "{id}");
            assert!(instabox.power(id, "delete").await.is_err(), "{id}");
        }
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.method == "GET" && r.path == "/v1/machines/m_9"), "nothing else was sent");
    }

    /// `INSTABOX_API_KEY=… cargo test --lib instabox_live -- --ignored --nocapture`. Creates
    /// one agent-browser machine and always deletes it.
    #[test]
    #[ignore = "needs INSTABOX_API_KEY"]
    fn instabox_live() {
        let api = InstaBox::new(None, std::env::var("INSTABOX_API_KEY").expect("INSTABOX_API_KEY"));
        let started = Instant::now();
        let made = Sandbox::create(&api, &format!("pc-live-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])).unwrap();
        let id = made.id.trim_start_matches("instabox:").to_string();
        eprintln!("instabox_live: created {id} ({}) in {} s", made.detail, started.elapsed().as_secs());
        let run = || -> Result<()> {
            let wait_running = || -> Result<()> {
                let started = Instant::now();
                while Sandbox::state(&api, &id)? != "running" {
                    assert!(started.elapsed() < Duration::from_secs(600), "never ran");
                    std::thread::sleep(Duration::from_secs(3));
                }
                Ok(())
            };
            wait_running()?;
            // The lease (the old /activity-leases path answered 404) and one watcher, however
            // often keep_alive runs.
            Sandbox::keep_alive(&api, &id, 60)?;
            Sandbox::keep_alive(&api, &id, 60)?;
            assert_eq!(Sandbox::exec(&api, &id, "pgrep -fc reconnect.sh", Duration::from_secs(30))?.1.trim(), "1", "one watcher only");
            // Pause with an open HTTPS connection: after the resume it is closed, processes kept.
            Sandbox::spawn(&api, &id, "exec sleep 3000")?;
            let sleeper = "pgrep -x sleep -a | grep ' 3000$' | cut -d' ' -f1";
            let (_, pid) = Sandbox::exec(&api, &id, sleeper, Duration::from_secs(30))?;
            assert!(!pid.trim().is_empty(), "background process died");
            Sandbox::spawn(&api, &id, "exec python3 -c 'import socket,ssl,time; s=ssl.create_default_context().wrap_socket(socket.create_connection((\"api.github.com\",443)),server_hostname=\"api.github.com\"); time.sleep(3600)'")?;
            std::thread::sleep(Duration::from_secs(3));
            let open = "ss -Htnp state established '( dport = :443 )' | grep -c python3";
            assert_eq!(Sandbox::exec(&api, &id, open, Duration::from_secs(30))?.1.trim(), "1");
            Sandbox::power(&api, &id, "stop")?;
            assert_eq!(Sandbox::state(&api, &id)?, "stopped");
            std::thread::sleep(Duration::from_secs(30));
            Sandbox::power(&api, &id, "start")?;
            wait_running()?;
            std::thread::sleep(Duration::from_secs(12));
            assert_eq!(Sandbox::exec(&api, &id, open, Duration::from_secs(30))?.1.trim(), "0", "stale connection left open");
            assert_eq!(Sandbox::exec(&api, &id, sleeper, Duration::from_secs(30))?.1, pid, "processes were not kept across the pause");
            eprintln!("instabox_live: all steps passed");
            Ok(())
        };
        // Delete even when a step panics, and wait until InstaBox answers 404.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
        Sandbox::power(&api, &id, "delete").unwrap();
        let deleted = Instant::now();
        loop {
            match http::block(api.get(&id)) {
                Err(error) if error.contains("not found") => break eprintln!("instabox_live: {id} deleted, GET answers 404 ({error})"),
                _ => assert!(deleted.elapsed() < Duration::from_secs(180), "{id} still exists"),
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        result.unwrap().unwrap();
    }

    #[test]
    fn connect_refuses_empty_keys() {
        assert!(connect(" ", &json!({})).is_err());
    }
}
