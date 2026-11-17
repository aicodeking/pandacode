//! Source-qualified Codex declarations -> inventory -> targeted thread state.
//! This module does not probe installed CLIs or broaden the hook trust policy.
use serde_json::{json, Value};
use super::runtime_companion_lifetime::{self as lifetime, Companions, InstalledApi, Lease, Profile, Evidence};
pub const SOURCE: &str = "aea4c6ee4b652d84b416731b11c2b8299d767209";
pub const EVENTS: [&str; 3] = ["PreToolUse", "PermissionRequest", "PostToolUse"];
pub fn profile() -> Profile { Profile { id: "codex.command.v1".into(), harness: "codex".into(), versions: vec![SOURCE.into()], api: "codex.session-hooks.v1".into(), protocol: 1, evidence: Evidence::SourceFeasible } }
/// Only the pinned default cmd /C or POSIX shell dialect is admitted. No tool input is interpolated.
pub fn command(node: &str, script: &str, windows: bool) -> Result<String, &'static str> {
    let quote = |path: &str| -> Result<String, &'static str> {
        if path.is_empty() || path.chars().any(char::is_control) { return Err("UnsupportedCapability"); }
        if windows {
            if !path.chars().all(|c| c.is_alphanumeric() || " _:.\\/-".contains(c)) { return Err("UnsupportedCapability"); }
            Ok(format!("\"{path}\""))
        } else { Ok(format!("'{}'", path.replace('\'', "'\\''"))) }
    };
    Ok(format!("{} {}", quote(node)?, quote(script)?))
}
pub struct Session { lease: Lease, cwd: String, command: String, generation: u64, pending: Option<u64>, state: Option<Value>, closed: bool }
impl Session {
    pub fn new(host: &Companions, lease: Lease, installed: &InstalledApi, cwd: String, command: String) -> Result<Self, &'static str> {
        if lifetime::negotiate(installed, Some(&profile())).code.is_some() { return Err("UnsupportedCapability"); }
        if !host.current(&lease.key, &lease) { return Err("StaleContext"); }
        Ok(Self { lease, cwd, command, generation: 0, pending: None, state: None, closed: false })
    }
    fn current(&self, host: &Companions) -> Result<(), &'static str> { if self.closed || !host.current(&self.lease.key, &self.lease) { Err("StaleContext") } else { Ok(()) } }
    pub fn declarations(&self, host: &Companions) -> Result<Value, &'static str> {
        self.current(host)?;
        let mut config = json!({"features.hooks":true});
        for event in EVENTS { config[format!("hooks.{event}")] = json!([{"hooks":[{"type":"command","command":self.command,"commandWindows":self.command,"timeout":2}]}]); }
        Ok(config)
    }
    /// Stable process declarations precede initialize. Request inventory after initialized, before EACH load/resume.
    pub fn inventory(&mut self, host: &Companions) -> Result<Value, &'static str> {
        self.current(host)?; self.state = None; self.generation += 1; self.pending = Some(self.generation);
        Ok(json!({"id":self.generation,"method":"hooks/list","params":{"cwds":[self.cwd]}}))
    }
    pub fn accept_inventory(&mut self, host: &Companions, id: u64, result: &Value) -> Result<(), &'static str> {
        self.current(host)?; self.state = None;
        if self.pending != Some(id) { return Err("StaleContext"); } self.pending = None;
        super::runtime_hook_payload::frame_check(result)?;
        let rows = result["data"].as_array().filter(|r| r.len() == 1).ok_or("UnsupportedCapability")?;
        let row = &rows[0];
        if row["cwd"] != self.cwd || !row["errors"].as_array().is_some_and(Vec::is_empty) { return Err("UnsupportedCapability"); }
        let hooks = row["hooks"].as_array().ok_or("UnsupportedCapability")?;
        let mut state = serde_json::Map::new();
        for event in EVENTS {
            let own: Vec<_> = hooks.iter().filter(|h| h["eventName"] == event && h["source"] == "sessionFlags" && h["handler"]["type"] == "command" && h["handler"]["command"] == self.command).collect();
            if own.len() != 1 { return Err("UnsupportedCapability"); }
            let key = own[0]["key"].as_str().filter(|k| !k.is_empty() && k.len() <= 4096).ok_or("UnsupportedCapability")?;
            let hash = own[0]["currentHash"].as_str().filter(|h| !h.is_empty() && h.len() <= 4096).ok_or("UnsupportedCapability")?;
            if state.insert(key.into(), json!({"enabled":true,"trusted_hash":hash})).is_some() { return Err("UnsupportedCapability"); }
        }
        self.state = Some(Value::Object(state)); Ok(())
    }
    pub fn thread(&mut self, host: &Companions, thread: Option<&str>, config: Value) -> Result<Value, &'static str> {
        self.current(host)?; if !config.is_object() { return Err("InvalidShape"); }
        let state = self.state.take().ok_or("UnsupportedCapability")?;
        let mut config = config; config["hooks.state"] = state;
        let mut params = json!({"cwd":self.cwd,"config":config});
        if let Some(thread) = thread { params["threadId"] = json!(thread); }
        Ok(json!({"method":if thread.is_some() {"thread/resume"} else {"thread/start"},"params":params}))
    }
    pub fn close(&mut self) { self.closed = true; self.pending = None; self.state = None; }
}
pub fn reply(event: &str, answer: &Value) -> Value {
    let reason = answer["reason"].as_str().filter(|r| !r.trim().is_empty()).unwrap_or("Declined by an extension.");
    match (event, answer["decision"].as_str()) {
        ("PreToolUse", Some("deny")) => json!({"hookSpecificOutput":{"hookEventName":event,"permissionDecision":"deny","permissionDecisionReason":reason}}),
        ("PreToolUse", Some("rewrite")) if answer["input"].is_object() => json!({"hookSpecificOutput":{"hookEventName":event,"permissionDecision":"allow","updatedInput":answer["input"]}}),
        ("PermissionRequest", Some("approve")) => json!({"hookSpecificOutput":{"hookEventName":event,"decision":{"behavior":"allow"}}}),
        ("PermissionRequest", Some("deny")) => json!({"hookSpecificOutput":{"hookEventName":event,"decision":{"behavior":"deny","message":reason}}}),
        _ => json!({}),
    }
}
/// Bundled Node command forwarder. The future host transport must authenticate this per-run credential,
/// recheck the current lease after dispatch, and return the event-specific output above.
/// stdout is JSON only. Missing transport, timeout, invalid input and disconnect preserve ordinary approvals.
pub const FORWARDER: &str = r#"import { readFile } from 'node:fs/promises';
const limit=2*1024*1024;
let output={};
const timer=setTimeout(()=>{ process.stdout.write('{}\n'); process.exit(0); },1900);
try {
 const url=new URL(process.env.PANDACODE_COMPANION_ENDPOINT||'');
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/companion') throw 0;
 const credential=process.env.PANDACODE_COMPANION_CREDENTIAL;
 if(!credential||credential.length>512) throw 0;
 const manifest=JSON.parse(await readFile(process.env.PANDACODE_COMPANION_MANIFEST,'utf8'));
 let chunks=[],size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>limit) throw 0;chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!['PreToolUse','PermissionRequest','PostToolUse'].includes(input.hook_event_name)) throw 0;
 const response=await fetch(url,{method:'POST',redirect:'error',headers:{'authorization':'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({protocol:1,lease:manifest,input}),signal:AbortSignal.timeout(1500)});
 if(!response.ok) throw 0;
 let bytes=0,parts=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit) throw 0;parts.push(chunk);}
 const answer=JSON.parse(Buffer.concat(parts).toString('utf8'));
 if(answer&&typeof answer==='object'&&!Array.isArray(answer)) output=answer;
} catch { /* No decision is ever synthesized from a transport failure. */ }
clearTimeout(timer);process.stdout.write(JSON.stringify(output)+'\n');
"#;
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn distinct_event_powers_and_quoting() {
        assert_eq!(reply("PreToolUse", &json!({"decision":"approve"})), json!({}));
        assert_eq!(reply("PermissionRequest", &json!({"decision":"rewrite","input":{}})), json!({}));
        assert_eq!(reply("PermissionRequest", &json!({"decision":"deny","reason":"guard"}))["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(command("C:\\Program Files\\node.exe", "C:\\run\\forward.mjs", true).is_ok());
        assert!(command("C:\\%TEMP%\\node.exe", "x", true).is_err());
        assert!(FORWARDER.contains("AbortSignal.timeout"));
    }
}
