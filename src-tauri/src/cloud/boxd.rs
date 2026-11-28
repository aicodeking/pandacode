//! boxd (boxd.sh) machines for cloud agents (docs/cloud-agents.md): persistent Ubuntu 24.04
//! microVMs with a 100 GB disk that go to standby when idle and wake on the next call.
//!
//! boxd's API is gRPC. PandaCode speaks its grpc-web form (binary protobuf in
//! `[flag][length]` frames, POSTed over HTTPS/1.1), which the API serves on the same port,
//! through the shared `reqwest` client. The few messages needed are encoded by hand in
//! `wire` with field numbers from boxd's public `proto/api/v1/api.proto`, so no gRPC or
//! protobuf crate is added. The API key is sent as the bearer token.
//!
//! Machines are created isolated (no in-VM boxd CLI, metadata endpoint or integrations, so
//! an agent can't reach the account's other machines) and labelled `created-by=pandacode`;
//! `list` shows only those, and every other call refuses a machine without the label.
//! `exec` runs the Exec RPC half-duplex: the command goes whole, then the output streams
//! back until the exit code. Files move with FsWrite/FsRead, which run as the machine's
//! user, create parents and read from an offset.
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde_json::Value;

use super::{http, sandbox::{Info, Sandbox}, Machine};
use crate::Result;

pub const DEFAULT_API: &str = "https://boxd.sh:9443";
const KEY: &str = "boxd_key";
const RPC: &str = "boxd.api.v1.BoxdApi";
/// Labels on every machine PandaCode creates; `list` shows only these.
const LABEL: (&str, &str) = ("created-by", "pandacode");
/// Idle minutes before a new machine goes to standby (processes and memory kept).
const IDLE_MINUTES: u32 = 15;
/// After standby, a machine hibernates (memory to disk, no compute billed) an hour later.
const HIBERNATE_AFTER: u32 = 60 * 60;
/// Output an `exec` keeps (the contract asks for at least 4 MiB); older bytes are dropped.
const KEEP: usize = 8 * 1024 * 1024;
/// The most a reply other than `exec`'s output may carry.
const LIMIT: usize = 16 * 1024 * 1024;
/// File bytes per FsWrite frame (gRPC's default message cap is 4 MiB).
const PIECE: usize = 1024 * 1024;
/// Waits before an `exec` is sent again when the machine's agent was not up yet.
const AGENT_RETRIES: [u64; 3] = if cfg!(test) { [0; 3] } else { [1, 3, 5] };
// gRPC status codes boxd answers with.
const NOT_FOUND: u32 = 5;
const ALREADY_EXISTS: u32 = 6;
const PERMISSION_DENIED: u32 = 7;
const FAILED_PRECONDITION: u32 = 9;
const UNAVAILABLE: u32 = 14;
const UNAUTHENTICATED: u32 = 16;

pub struct Boxd {
    /// Account calls (the key check, regions).
    home: String,
    /// Machine calls: the chosen region's API, else home.
    machines: String,
    key: String,
    /// Labels and an auto-delete timer added at create; the live test marks its machines.
    extra_labels: Vec<(String, String)>,
    delete_after_secs: Option<u64>,
}

/// A failed call: a gRPC status from boxd, or a transport problem already put in words.
#[derive(Debug, PartialEq)]
enum Failure {
    Status(u32, String),
    Other(String),
}

impl From<Failure> for String {
    fn from(failure: Failure) -> String {
        match failure {
            Failure::Other(message) => message,
            Failure::Status(UNAUTHENTICATED, message) => match safe_detail(&message) {
                Some(detail) => format!("boxd refused the API key: {detail}. Check it in Settings → Cloud."),
                None => "boxd refused the API key. Check it in Settings → Cloud.".into(),
            },
            Failure::Status(PERMISSION_DENIED, message) => match safe_detail(&message) {
                Some(detail) => format!("boxd did not allow that: {detail}."),
                None => "boxd did not allow that with this API key.".into(),
            },
            Failure::Status(code, message) if message.trim().is_empty() => format!("boxd answered with gRPC status {code}."),
            Failure::Status(_, message) => format!("boxd: {}", message.trim()),
        }
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Failure {
        Failure::Other(message)
    }
}

/// A refusal's text, unless a long word in it could be a credential echoed back.
fn safe_detail(message: &str) -> Option<String> {
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() || line.split(' ').any(|word| word.chars().count() >= 20) {
        return None;
    }
    Some(line.chars().take(300).collect::<String>().trim_end_matches('.').to_string())
}

/// The few protobuf wire rules boxd's messages need: varints, length-delimited fields and
/// skipping what this file does not read.
mod wire {
    /// A message being written. proto3 defaults (0, empty) are left out like protoc does.
    #[derive(Default, Clone)]
    pub struct Out(pub Vec<u8>);

    impl Out {
        fn varint(&mut self, mut value: u64) {
            while value >= 0x80 {
                self.0.push(value as u8 | 0x80);
                value >>= 7;
            }
            self.0.push(value as u8);
        }
        fn key(&mut self, field: u32, kind: u64) {
            self.varint(u64::from(field) << 3 | kind);
        }
        pub fn uint(mut self, field: u32, value: u64) -> Self {
            if value != 0 {
                self.key(field, 0);
                self.varint(value);
            }
            self
        }
        /// An `optional` scalar, written even when zero.
        pub fn optional(mut self, field: u32, value: u64) -> Self {
            self.key(field, 0);
            self.varint(value);
            self
        }
        pub fn flag(self, field: u32, value: bool) -> Self {
            self.uint(field, u64::from(value))
        }
        pub fn bytes(mut self, field: u32, value: &[u8]) -> Self {
            if !value.is_empty() {
                self.key(field, 2);
                self.varint(value.len() as u64);
                self.0.extend_from_slice(value);
            }
            self
        }
        pub fn text(self, field: u32, value: &str) -> Self {
            self.bytes(field, value.as_bytes())
        }
        /// One entry of a `map<string, string>` field.
        pub fn entry(mut self, field: u32, key: &str, value: &str) -> Self {
            let entry = Out::default().text(1, key).text(2, value);
            self.key(field, 2);
            self.varint(entry.0.len() as u64);
            self.0.extend_from_slice(&entry.0);
            self
        }
    }

    pub enum Value<'a> {
        Int(u64),
        Bytes(&'a [u8]),
    }

    /// A decoded message: its fields in wire order.
    pub struct In<'a>(Vec<(u32, Value<'a>)>);

    const UNREADABLE: &str = "boxd sent a reply PandaCode could not read.";

    fn varint(buf: &[u8], at: &mut usize) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *buf.get(*at).ok_or(UNREADABLE)?;
            *at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(UNREADABLE.into())
    }

    pub fn parse(buf: &[u8]) -> Result<In<'_>, String> {
        let (mut at, mut fields) = (0, Vec::new());
        while at < buf.len() {
            let key = varint(buf, &mut at)?;
            let field = (key >> 3) as u32;
            let width = match key & 7 {
                0 => {
                    fields.push((field, Value::Int(varint(buf, &mut at)?)));
                    continue;
                }
                1 => 8,
                2 => varint(buf, &mut at)? as usize,
                5 => 4,
                _ => return Err(UNREADABLE.into()),
            };
            let end = at.checked_add(width).filter(|end| *end <= buf.len()).ok_or(UNREADABLE)?;
            if key & 7 == 2 {
                fields.push((field, Value::Bytes(&buf[at..end])));
            }
            at = end;
        }
        Ok(In(fields))
    }

    impl<'a> In<'a> {
        /// The last value of a scalar field, 0 when absent.
        pub fn int(&self, field: u32) -> u64 {
            self.0.iter().rev().find_map(|(f, v)| match v { Value::Int(n) if *f == field => Some(*n), _ => None }).unwrap_or(0)
        }
        pub fn has(&self, field: u32) -> bool {
            self.0.iter().any(|(f, _)| *f == field)
        }
        pub fn bytes(&self, field: u32) -> &'a [u8] {
            self.all(field).last().copied().unwrap_or(&[])
        }
        pub fn text(&self, field: u32) -> String {
            String::from_utf8_lossy(self.bytes(field)).into_owned()
        }
        /// Every value of a repeated length-delimited field.
        pub fn all(&self, field: u32) -> Vec<&'a [u8]> {
            self.0.iter().filter_map(|(f, v)| match v { Value::Bytes(b) if *f == field => Some(*b), _ => None }).collect()
        }
        /// A `map<string, string>` field.
        pub fn map(&self, field: u32) -> Vec<(String, String)> {
            self.all(field).into_iter().filter_map(|entry| parse(entry).ok()).map(|entry| (entry.text(1), entry.text(2))).collect()
        }
    }
}
use wire::{parse, Out};

/// One grpc-web data frame around a message.
fn frame(message: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(message.len() + 5);
    framed.push(0);
    framed.extend_from_slice(&(message.len() as u32).to_be_bytes());
    framed.extend_from_slice(message);
    framed
}

/// Reads a grpc-web response body as it arrives: data frames are messages, the frame with the
/// 0x80 flag is the trailer that carries the call's status.
#[derive(Default)]
struct Frames {
    pending: Vec<u8>,
    messages: Vec<Vec<u8>>,
    status: Option<(u32, String)>,
}

impl Frames {
    fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        while self.pending.len() >= 5 {
            let length = u32::from_be_bytes([self.pending[1], self.pending[2], self.pending[3], self.pending[4]]) as usize;
            if self.pending.len() < 5 + length {
                break;
            }
            let payload = self.pending[5..5 + length].to_vec();
            let trailer = self.pending[0] & 0x80 != 0;
            self.pending.drain(..5 + length);
            if trailer {
                let text = String::from_utf8_lossy(&payload);
                let field = |name: &str| text.split("\r\n").find_map(|line| line.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()));
                let code = field("grpc-status").and_then(|c| c.parse().ok()).unwrap_or(0);
                self.status = Some((code, percent_decode(&field("grpc-message").unwrap_or_default())));
            } else {
                self.messages.push(payload);
            }
        }
    }
    /// The messages, unless the trailer reported an error.
    fn finish(self) -> std::result::Result<Vec<Vec<u8>>, Failure> {
        match self.status {
            Some((0, _)) => Ok(self.messages),
            Some((code, message)) => Err(Failure::Status(code, message)),
            None => Err(Failure::Other("boxd ended the reply early.".into())),
        }
    }
}

/// `grpc-message` is percent-encoded.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let (mut out, mut at) = (Vec::with_capacity(bytes.len()), 0);
    while at < bytes.len() {
        let hex = (bytes[at] == b'%').then(|| text.get(at + 1..at + 3)).flatten().and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn network(error: reqwest::Error) -> Failure {
    Failure::Other(if error.is_timeout() { "boxd did not answer in time.".into() } else if error.is_connect() { "Could not reach boxd. Check your connection.".into() } else { "The boxd request failed.".into() })
}

fn state(status: &str) -> &'static str {
    match status {
        // Standby keeps memory and wakes on the next call, so it counts as running.
        "running" | "suspended" => "running",
        "pending" | "starting" | "migrating" | "creating" => "starting",
        "stopping" | "suspending" | "hibernating" | "destroying" => "stopping",
        "stopped" | "hibernated" => "stopped",
        _ => "error",
    }
}

fn machine(vm: &wire::In) -> Machine {
    let (id, name, status) = (vm.text(1), vm.text(2), vm.text(5));
    let mut detail = String::from("boxd");
    if vm.int(15) > 0 {
        detail.push_str(&format!(" · {} vCPU · {} GB", vm.int(15), vm.int(16) >> 30));
    }
    let region = vm.text(42);
    if !region.is_empty() {
        detail.push_str(&format!(" · {region}"));
    }
    if matches!(status.as_str(), "suspended" | "hibernated") {
        detail.push_str(if status == "suspended" { " · standby" } else { " · hibernated" });
    }
    Machine { id: format!("boxd:{id}"), provider: "boxd".into(), name: if name.is_empty() { id.clone() } else { name }, state: state(&status).into(), os: "linux".into(), desktop: false, detail }
}

fn labelled(vm: &wire::In) -> bool {
    vm.map(34).iter().any(|(k, v)| k == LABEL.0 && v == LABEL.1)
}

/// Machine IDs already seen with PandaCode's label, so `exec` checks each one once.
fn owned_ids() -> &'static Mutex<HashSet<String>> {
    static OWNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    OWNED.get_or_init(Mutex::default)
}

impl Boxd {
    pub fn new(home: Option<String>, machines: Option<String>, key: String) -> Self {
        let home = home.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string();
        let machines = machines.filter(|u| !u.trim().is_empty()).map(|u| u.trim_end_matches('/').to_string()).unwrap_or_else(|| home.clone());
        Boxd { home, machines, key, extra_labels: Vec::new(), delete_after_secs: None }
    }
    fn connected() -> Result<Self> {
        let key = super::secret(KEY).ok_or("Connect boxd in Settings → Cloud first.")?;
        let options = super::settings().providers.get("boxd").cloned().unwrap_or_default();
        Ok(Boxd::new(options.get("apiUrl").cloned(), options.get("regionApi").cloned(), key))
    }

    async fn post(&self, base: &str, method: &str, body: Vec<u8>, timeout: Duration) -> std::result::Result<reqwest::Response, Failure> {
        let request = http::client(timeout)?
            .post(format!("{base}/{RPC}/{method}"))
            .bearer_auth(&self.key)
            .header(reqwest::header::CONTENT_TYPE, "application/grpc-web+proto")
            .header("x-grpc-web", "1")
            .body(body);
        let response = request.send().await.map_err(network)?;
        // A call refused before any message comes back as headers only.
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        if let Some(code) = header("grpc-status").and_then(|c| c.parse::<u32>().ok()).filter(|c| *c != 0) {
            return Err(Failure::Status(code, percent_decode(&header("grpc-message").unwrap_or_default())));
        }
        if !response.status().is_success() {
            return Err(Failure::Other(format!("boxd returned HTTP {}.", response.status().as_u16())));
        }
        Ok(response)
    }

    /// Sends `frames` (one message, or a client stream sent whole) and reads every reply message.
    async fn call(&self, base: &str, method: &str, frames: Vec<u8>, timeout: Duration) -> std::result::Result<Vec<Vec<u8>>, Failure> {
        let mut response = self.post(base, method, frames, timeout).await?;
        let mut reply = Frames::default();
        while let Some(bytes) = response.chunk().await.map_err(network)? {
            reply.push(&bytes);
            if reply.pending.len() + reply.messages.iter().map(Vec::len).sum::<usize>() > LIMIT {
                return Err(Failure::Other("boxd sent a reply that is too large.".into()));
            }
        }
        reply.finish()
    }
    async fn unary(&self, base: &str, method: &str, message: Out) -> std::result::Result<Vec<u8>, Failure> {
        Ok(self.call(base, method, frame(&message.0), Duration::from_secs(60)).await?.pop().unwrap_or_default())
    }

    /// The account's display name, which also proves the key works.
    pub async fn whoami(&self) -> Result<String> {
        let reply = self.unary(&self.home, "Whoami", Out::default()).await?;
        let me = parse(&reply)?;
        Ok(Some(me.text(5)).filter(|n| !n.is_empty()).unwrap_or_else(|| "boxd account".into()))
    }
    /// The API of `region` (an ID like `fra`), from the regions the key's org can use.
    pub async fn region_api(&self, region: &str) -> Result<String> {
        let reply = self.unary(&self.home, "ListRegions", Out::default()).await?;
        let answer = parse(&reply)?;
        let regions: Vec<wire::In> = answer.all(1).into_iter().map(parse).collect::<Result<_>>()?;
        let found = regions.iter().find(|r| r.text(1).eq_ignore_ascii_case(region));
        match found {
            Some(r) if r.text(9) == "enabled" && r.text(4).starts_with("https://") => Ok(r.text(4)),
            Some(_) => Err(format!("boxd region {region} is not enabled for this API key's organization yet.")),
            None => Err(format!("boxd has no region {region}. Regions: {}.", regions.iter().map(|r| r.text(1)).collect::<Vec<_>>().join(", "))),
        }
    }

    async fn list(&self) -> Result<Vec<Machine>> {
        let request = Out::default().text(3, &format!("{}={}", LABEL.0, LABEL.1));
        let reply = self.unary(&self.machines, "ListVms", request).await?;
        let answer = parse(&reply)?;
        let mut machines = Vec::new();
        for vm in answer.all(1) {
            let vm = parse(vm)?;
            // Filter again: never show or touch a machine without PandaCode's label.
            if labelled(&vm) && vm.text(5) != "destroyed" && super::valid_native(&vm.text(1)) {
                machines.push(machine(&vm));
            }
        }
        Ok(machines)
    }

    async fn get(&self, id: &str) -> std::result::Result<Vec<u8>, Failure> {
        if !super::valid_native(id) {
            return Err(Failure::Other("That is not a boxd machine ID.".into()));
        }
        self.unary(&self.machines, "GetVm", Out::default().text(1, id)).await
    }
    /// The machine's status, only when PandaCode created it.
    async fn owned(&self, id: &str) -> Result<String> {
        let reply = match self.get(id).await {
            Err(Failure::Status(NOT_FOUND, _)) => return Err("That cloud machine no longer exists.".into()),
            other => other?,
        };
        let vm = parse(&reply)?;
        if !labelled(&vm) {
            return Err("PandaCode only controls boxd machines it created.".into());
        }
        owned_ids().lock().map_err(|e| e.to_string())?.insert(id.to_string());
        Ok(vm.text(5))
    }
    async fn check_owned(&self, id: &str) -> Result<()> {
        if owned_ids().lock().map_err(|e| e.to_string())?.contains(id) {
            return Ok(());
        }
        self.owned(id).await.map(|_| ())
    }

    async fn create(&self, name: &str) -> Result<Machine> {
        let mut attempt = name.to_string();
        for retry in 0..3 {
            let mut request = Out::default().text(1, &attempt).flag(12, true).entry(14, LABEL.0, LABEL.1);
            for (key, value) in &self.extra_labels {
                request = request.entry(14, key, value);
            }
            if let Some(seconds) = self.delete_after_secs {
                request = request.optional(16, seconds);
            }
            // Machine names are global (they are also the machine's host name), so a taken one
            // gets a short random suffix.
            match self.call(&self.machines, "CreateVm", frame(&request.0), Duration::from_secs(120)).await {
                Err(Failure::Status(ALREADY_EXISTS, _)) if retry < 2 => attempt = format!("{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..4]),
                Err(failure) => return Err(failure.into()),
                Ok(mut reply) => {
                    let created = reply.pop().unwrap_or_default();
                    let created = parse(&created)?;
                    let id = created.text(1);
                    if !super::valid_native(&id) {
                        return Err("boxd returned a machine ID PandaCode cannot use.".into());
                    }
                    owned_ids().lock().map_err(|e| e.to_string())?.insert(id.clone());
                    // The reply carries the machine as GetVm shows it; older servers leave it out.
                    let vm = if created.has(9) { created.bytes(9).to_vec() } else { self.get(&id).await? };
                    let made = machine(&parse(&vm)?);
                    if let Err(error) = self.idle_timeouts(&id, IDLE_MINUTES).await {
                        let _ = self.unary(&self.machines, "DestroyVm", Out::default().text(1, &id)).await;
                        return Err(error);
                    }
                    return Ok(made);
                }
            }
        }
        Err("boxd kept refusing the machine name.".into())
    }

    async fn power(&self, id: &str, action: &str) -> Result<()> {
        if !matches!(action, "start" | "stop" | "delete") {
            return Err(format!("boxd machines can start, stop or be deleted, not {action}."));
        }
        let status = self.owned(id).await?;
        let method = match (action, status.as_str()) {
            ("delete", _) => "DestroyVm",
            ("start", "stopped") => "StartVm",
            ("start", "hibernated") => "WakeVm",
            ("start", "suspended") => "ResumeVm",
            ("stop", "running" | "suspended" | "starting") => "StopVm",
            _ => return Ok(()),
        };
        let reply = self.unary(&self.machines, method, Out::default().text(1, id)).await;
        if action == "delete" {
            owned_ids().lock().map_err(|e| e.to_string())?.remove(id);
        }
        match reply {
            // Already gone is what a delete asked for.
            Err(Failure::Status(NOT_FOUND, _)) if action == "delete" => Ok(()),
            other => other.map(|_| ()).map_err(String::from),
        }
    }

    /// Standby after `minutes` without network traffic in or out, hibernation an hour later.
    async fn idle_timeouts(&self, id: &str, minutes: u32) -> Result<()> {
        let seconds = minutes.max(1) * 60;
        self.unary(&self.machines, "SetAutoSuspendTimeout", Out::default().text(1, id).uint(2, u64::from(seconds))).await?;
        match self.unary(&self.machines, "SetAutoHibernateTimeout", Out::default().text(1, id).uint(2, u64::from(seconds + HIBERNATE_AFTER))).await {
            // A machine that can't capture its memory can't hibernate; standby still applies.
            Err(Failure::Status(FAILED_PRECONDITION, _)) => Ok(()),
            other => other.map(|_| ()).map_err(String::from),
        }
    }
    async fn keep_alive(&self, id: &str, minutes: u32) -> Result<()> {
        self.check_owned(id).await?;
        self.idle_timeouts(id, minutes).await
    }

    async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        self.check_owned(id).await?;
        let mut retries = AGENT_RETRIES.iter();
        loop {
            match self.exec_once(id, command, timeout).await {
                // The machine's agent was not up (just created or woken): nothing ran yet.
                Err(Failure::Status(UNAVAILABLE, message)) if message.starts_with("cannot connect to VM agent") => match retries.next() {
                    Some(wait) => tokio::time::sleep(Duration::from_secs(*wait)).await,
                    None => return Err(Failure::Status(UNAVAILABLE, message).into()),
                },
                result => return result.map_err(String::from),
            }
        }
    }
    /// One Exec call. At `timeout` the call is dropped, which makes boxd kill the command's
    /// process group; the output so far comes back with no exit code.
    async fn exec_once(&self, id: &str, command: &str, timeout: Duration) -> std::result::Result<(Option<i32>, String), Failure> {
        let start = Out::default().text(4, command).text(5, id);
        let mut output = Vec::new();
        let run = async {
            let mut response = self.post(&self.machines, "Exec", frame(&start.0), timeout + Duration::from_secs(60)).await?;
            let mut reply = Frames::default();
            let mut code = None;
            while let Some(bytes) = response.chunk().await.map_err(network)? {
                reply.push(&bytes);
                for message in reply.messages.drain(..) {
                    let chunk = parse(&message)?;
                    output.extend_from_slice(chunk.bytes(1));
                    if output.len() > KEEP {
                        output.drain(..output.len() - KEEP);
                    }
                    // The stream ends with the chunk that carries the exit code.
                    code = Some(chunk.int(6) as i64 as i32);
                }
            }
            reply.finish()?;
            Ok::<_, Failure>(code)
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(code) => Ok((code?, String::from_utf8_lossy(&output).into_owned())),
            Err(_) => Ok((None, format!("{}\nTimed out after {} s.", String::from_utf8_lossy(&output), timeout.as_secs()))),
        }
    }

    async fn upload(&self, id: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        self.check_owned(id).await?;
        let mut first = Out::default().text(1, id).text(2, path).optional(4, bytes.len() as u64);
        if private {
            first = first.optional(3, 0o600);
        }
        let mut pieces = bytes.chunks(PIECE);
        let mut frames = frame(&first.bytes(5, pieces.next().unwrap_or_default()).0);
        for piece in pieces {
            frames.extend(frame(&Out::default().bytes(5, piece).0));
        }
        let timeout = Duration::from_secs(120 + (bytes.len() / (256 * 1024)) as u64);
        let reply = self.call(&self.machines, "FsWrite", frames, timeout).await?.pop().unwrap_or_default();
        let written = parse(&reply)?.int(1);
        if written != bytes.len() as u64 {
            return Err(format!("boxd wrote {written} of {} bytes to {path}.", bytes.len()));
        }
        Ok(())
    }
    async fn download(&self, id: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        self.check_owned(id).await?;
        let request = Out::default().text(1, id).text(2, path).uint(3, offset).optional(4, max as u64);
        match self.call(&self.machines, "FsRead", frame(&request.0), Duration::from_secs(120)).await {
            Ok(chunks) => {
                let mut bytes = Vec::new();
                for chunk in &chunks {
                    bytes.extend_from_slice(parse(chunk)?.bytes(2));
                }
                bytes.truncate(max);
                Ok(bytes)
            }
            // Missing (or a directory): the contract says empty.
            Err(Failure::Status(NOT_FOUND | FAILED_PRECONDITION, _)) => Ok(Vec::new()),
            Err(failure) => Err(failure.into()),
        }
    }
}

impl Sandbox for Boxd {
    /// The disk stays until delete; standby and hibernation keep memory too.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        http::block(Boxd::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        http::block(Boxd::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        http::block(Boxd::power(self, native, action))
    }
    /// One GetVm instead of a list.
    fn state(&self, native: &str) -> Result<String> {
        http::block(async { self.owned(native).await.map(|status| state(&status).to_string()) })
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        http::block(Boxd::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        http::block(Boxd::keep_alive(self, native, minutes))
    }
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        http::block(Boxd::upload(self, native, path, bytes, private))
    }
    fn download(&self, native: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        http::block(Boxd::download(self, native, path, offset, max))
    }
}

/// Check the key with a real request, then save it. `options.region` (for example `fra` or
/// `nyc`) picks where new machines go; empty uses the account's home region.
pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a boxd API key (`boxd auth keys create pandacode`).".into());
    }
    let region = options["region"].as_str().map(str::trim).filter(|r| !r.is_empty()).map(str::to_ascii_lowercase);
    if region.as_deref().is_some_and(|r| !r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        return Err("A boxd region is a short code like fra or nyc.".into());
    }
    let api = Boxd::new(None, None, key.to_string());
    let login = http::block(api.whoami())?;
    let region_api = match &region {
        Some(region) => Some(http::block(api.region_api(region))?),
        None => None,
    };
    super::set_secret(KEY, key)?;
    let mut settings = super::settings();
    let mut saved = BTreeMap::from([("detail".to_string(), match &region { Some(r) => format!("{login} · {r}"), None => login })]);
    saved.extend(region.map(|r| ("region".to_string(), r)));
    saved.extend(region_api.map(|url| ("regionApi".to_string(), url)));
    settings.providers.insert("boxd".into(), saved);
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret(KEY);
    let mut settings = super::settings();
    settings.providers.remove("boxd");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Boxd::connected()?))
}

#[cfg(test)]
#[path = "boxd_tests.rs"]
mod tests;
