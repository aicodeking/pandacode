//! Web chat: a page served on this computer that talks to one bot. Holding the
//! channel's token (carried in the link's fragment, never sent as a query string)
//! makes the visitor the owner, so web messages skip pairing. Replies wait in a
//! small in-memory outbox that the page long-polls.

use super::http::{same, Request, Response};
use super::Channel;
use crate::{bots::gateway, AppState};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const THREAD: &str = "web";
const OUTBOX: usize = 300;
const POSTS_PER_MINUTE: usize = 30;

#[derive(Clone)]
struct Outgoing {
    id: u64,
    channel_id: String,
    thread: String,
    text: String,
    at: i64,
}

#[derive(Default)]
struct Outbox {
    next: u64,
    items: VecDeque<Outgoing>,
}

fn outbox() -> &'static Mutex<Outbox> {
    static OUTBOX_STATE: std::sync::OnceLock<Mutex<Outbox>> = std::sync::OnceLock::new();
    OUTBOX_STATE.get_or_init(|| Mutex::new(Outbox { next: 1, items: VecDeque::new() }))
}

fn wake() -> &'static tokio::sync::Notify {
    static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

pub(crate) fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub(crate) fn send(channel: &Channel, thread: &str, text: &str) -> crate::Result<()> {
    let mut state = outbox().lock().map_err(|e| e.to_string())?;
    let id = state.next;
    state.next += 1;
    state.items.push_back(Outgoing { id, channel_id: channel.id.clone(), thread: thread.to_owned(), text: text.to_owned(), at: crate::storage::now() });
    while state.items.len() > OUTBOX {
        state.items.pop_front();
    }
    drop(state);
    wake().notify_waiters();
    Ok(())
}

fn cursor() -> u64 {
    outbox().lock().map(|state| state.next - 1).unwrap_or(0)
}

fn pending_after(channel_id: &str, after: u64) -> Vec<Outgoing> {
    outbox().lock().map(|state| state.items.iter().filter(|item| item.channel_id == channel_id && item.id > after).cloned().collect()).unwrap_or_default()
}

fn allow_post(channel_id: &str) -> bool {
    static POSTS: std::sync::OnceLock<Mutex<HashMap<String, VecDeque<i64>>>> = std::sync::OnceLock::new();
    let Ok(mut map) = POSTS.get_or_init(Default::default).lock() else { return false };
    let now = crate::storage::now();
    let times = map.entry(channel_id.to_owned()).or_default();
    while times.front().is_some_and(|at| now - at > 60_000) {
        times.pop_front();
    }
    if times.len() >= POSTS_PER_MINUTE {
        return false;
    }
    times.push_back(now);
    true
}

/// Strips context blocks (the bot brief, attachments) that the desktop app folds.
pub(crate) fn visible(text: &str) -> String {
    let cut = ["\n\nBot brief:", "\n\nDocument context:", "\n\nFolder context:"].iter().filter_map(|marker| text.find(marker)).min().unwrap_or(text.len());
    text[..cut].trim().to_owned()
}

fn authorized(app: &tauri::AppHandle, channel_id: &str, request: &Request) -> Option<Channel> {
    let state = app.state::<AppState>();
    let store = state.store.lock().ok()?;
    let channel = super::get(&store, channel_id).ok().filter(|c| c.kind == "web" && c.enabled)?;
    let token = super::web_token(&store, &channel.id)?;
    request.bearer().is_some_and(|given| same(given, &token)).then_some(channel)
}

fn history(app: &tauri::AppHandle, channel: &Channel) -> Value {
    let state = app.state::<AppState>();
    let Ok(store) = state.store.lock() else { return json!({"messages": [], "busy": false}) };
    let bot = crate::bots::get(&store, &channel.bot_id).ok();
    let session: Option<String> = store
        .db
        .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2 AND external_id=?3", rusqlite::params![channel.bot_id, channel.id, THREAD], |r| r.get(0))
        .ok();
    let messages: Vec<Value> = session
        .as_deref()
        .and_then(|session| {
            let mut statement = store.db.prepare("SELECT role,content,created_at FROM (SELECT id,role,content,created_at FROM messages WHERE session_id=?1 AND role IN ('user','assistant') ORDER BY id DESC LIMIT 80) ORDER BY id").ok()?;
            let rows = statement.query_map([session], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).ok()?;
            Some(rows.flatten().map(|(role, content, at)| json!({"role": role, "text": if role == "user" { visible(&content) } else { content }, "at": at})).collect())
        })
        .unwrap_or_default();
    let busy = session.as_deref().is_some_and(|session| state.agents.lock().map(|agents| agents.contains_key(session)).unwrap_or(false));
    json!({
        "bot": bot.map(|bot| json!({"name": bot.name, "role": bot.role, "avatar": bot.avatar, "paused": bot.paused})),
        "messages": messages,
        "busy": busy,
        "cursor": cursor(),
    })
}

fn busy(app: &tauri::AppHandle, channel: &Channel) -> bool {
    let state = app.state::<AppState>();
    let session: Option<String> = state.store.lock().ok().and_then(|store| {
        store
            .db
            .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2 AND external_id=?3", rusqlite::params![channel.bot_id, channel.id, THREAD], |r| r.get(0))
            .ok()
    });
    session.is_some_and(|session| state.agents.lock().map(|agents| agents.contains_key(&session)).unwrap_or(false))
}

async fn events(app: &tauri::AppHandle, channel: &Channel, after: u64) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let was_busy = busy(app, channel);
    loop {
        let notified = wake().notified();
        let items = pending_after(&channel.id, after);
        let now_busy = busy(app, channel);
        if !items.is_empty() || now_busy != was_busy || tokio::time::Instant::now() >= deadline {
            let cursor = items.last().map_or(after.max(cursor()), |item| item.id);
            return json!({
                "events": items.iter().map(|item| json!({"id": item.id, "text": item.text, "thread": item.thread, "at": item.at})).collect::<Vec<_>>(),
                "busy": now_busy,
                "cursor": cursor,
            });
        }
        // Wake on a new reply, or every few seconds to notice the run starting or ending.
        let wait = Duration::from_secs(3).min(deadline.saturating_duration_since(tokio::time::Instant::now()));
        let _ = tokio::time::timeout(wait, notified).await;
    }
}

pub(crate) async fn api(app: &tauri::AppHandle, channel_id: &str, action: &str, request: &Request) -> Response {
    let Some(channel) = authorized(app, channel_id, request) else { return Response::json(401, &json!({"error": "This link is no longer valid. Copy a fresh one from PandaCode."})) };
    // Other host names mean a tunnel or a rebound domain; allow them only when the owner turned on remote access.
    if !request.loopback_host() && channel.config["remote"].as_bool() != Some(true) {
        return Response::json(403, &json!({"error": "Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat)."}));
    }
    match (request.method.as_str(), action) {
        ("GET", "history") => Response::json(200, &history(app, &channel)),
        ("GET", "events") => {
            let after = request.query.get("after").and_then(|value| value.parse().ok()).unwrap_or(0);
            Response::json(200, &events(app, &channel, after).await)
        }
        ("POST", "messages") => {
            if !allow_post(&channel.id) {
                return Response::json(429, &json!({"error": "Too many messages. Wait a minute and try again."}));
            }
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let text = body["text"].as_str().unwrap_or_default().to_owned();
            let inbound = gateway::Inbound { bot_id: channel.bot_id.clone(), channel_id: channel.id.clone(), thread: THREAD.into(), sender_id: "web".into(), sender_name: "You (web)".into(), text, trusted: true };
            match gateway::deliver(app, inbound).await {
                Ok(_) => Response::json(200, &json!({"ok": true, "busy": busy(app, &channel)})),
                Err(error) => Response::json(400, &json!({"error": error})),
            }
        }
        _ => Response::json(405, &json!({"error": "Not supported."})),
    }
}

pub(crate) fn page(channel_id: &str) -> Response {
    if !channel_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || channel_id.len() > 64 {
        return Response::text(404, "Not found.");
    }
    Response::html(PAGE.replace("__CHANNEL__", channel_id))
}

const PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Bot chat</title>
<style>
:root{--bg:#f6f4ef;--panel:#fffdf8;--ink:#1d1b16;--muted:#77716a;--line:#e7e1d6;--bubble:#efebe2;--accent:#f5c842;--accent-ink:#3d3000;--ok:#2f8f5b;--danger:#b4432f}
@media (prefers-color-scheme:dark){:root{--bg:#141310;--panel:#1d1b17;--ink:#f1ede4;--muted:#a39c90;--line:#33302a;--bubble:#2a2722;--accent:#e2b93b;--accent-ink:#2a2000;--ok:#4fb07c;--danger:#e06a52}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:radial-gradient(1200px 500px at 50% -200px,color-mix(in srgb,var(--accent) 16%,transparent),transparent),var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column}
header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 82%,transparent);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.ring{position:relative;display:grid;place-items:center;width:42px;height:42px;border-radius:50%;flex:none}
.ring::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(var(--accent),var(--ok),color-mix(in srgb,var(--accent) 20%,transparent),var(--accent));opacity:.3;transition:opacity .3s}
.ring::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--panel)}
body.busy .ring::before{opacity:1;animation:spin 2.4s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.avatar{position:relative;z-index:1;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 60%,var(--bubble));color:var(--accent-ink);font-weight:650;font-size:17px}
.who{display:flex;flex-direction:column;min-width:0}.who b{font-weight:620}.who small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{flex:1;overflow-y:auto;padding:20px 16px 10px;display:flex;flex-direction:column;gap:10px;max-width:760px;width:100%;margin:0 auto}
.msg{display:flex;align-items:flex-end;gap:8px;max-width:min(88%,640px)}
.msg .b{padding:9px 14px;border-radius:19px;overflow-wrap:anywhere}
.bot{align-self:flex-start}.bot .b{background:var(--bubble);border-bottom-left-radius:6px}
.me{align-self:flex-end}.me .b{background:var(--accent);color:var(--accent-ink);border-bottom-right-radius:6px;white-space:pre-wrap}
.mini{width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:12px;font-weight:650;background:color-mix(in srgb,var(--accent) 60%,var(--bubble));color:var(--accent-ink)}
.b p{margin:.35em 0}.b>:first-child{margin-top:0}.b>:last-child{margin-bottom:0}.b ul,.b ol{margin:.35em 0;padding-left:1.3em}
.b a{color:inherit;text-decoration-thickness:1px;text-underline-offset:2px}
.b h1,.b h2,.b h3{font-size:1em}.b blockquote{margin:.4em 0;padding-left:10px;border-left:2px solid var(--line);color:var(--muted)}
.b .task{list-style:none;margin-left:-1.1em}.b .task::before{content:"☐ ";color:var(--muted)}.b .task.done::before{content:"☑ ";color:var(--ok)}.b .task.done{color:var(--muted)}
.b aside.note{margin:.5em 0;padding:6px 10px;border-radius:10px;border:1px solid var(--line);background:rgba(127,127,127,.08)}.b aside.note>b{display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.b aside.warning,.b aside.caution{border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.b .table{overflow-x:auto;margin:.4em 0}.b table{border-collapse:collapse;font-size:13px}.b th,.b td{border:1px solid var(--line);padding:4px 8px}
.b hr{border:0;border-top:1px solid var(--line);margin:.6em 0}
.b pre{white-space:pre-wrap;background:rgba(127,127,127,.13);padding:8px 10px;border-radius:10px;margin:6px 0;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.b code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(127,127,127,.15);padding:1px 4px;border-radius:5px}.b pre code{background:none;padding:0}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.actions button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.actions button.yes{background:var(--ink);color:var(--panel);border-color:transparent}
.typing{display:flex;align-items:center;gap:8px;align-self:flex-start;color:var(--muted);font-size:13px;margin-left:32px}
.dots{display:inline-flex;gap:3px;padding:8px 10px;border-radius:12px;background:var(--bubble)}.dots i{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:bob 1.2s ease-in-out infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes bob{0%,60%,100%{transform:none;opacity:.45}30%{transform:translateY(-3px);opacity:1}}
.hello{margin:auto;text-align:center;color:var(--muted);max-width:420px;display:flex;flex-direction:column;align-items:center;gap:8px}
:is(.avatar,.mini) img{width:100%;height:100%;border-radius:50%;object-fit:cover}
.hello .avatar{width:64px;height:64px;font-size:30px;box-shadow:0 10px 30px color-mix(in srgb,var(--accent) 40%,transparent)}
.hello b{color:var(--ink);font-size:17px;margin-top:6px}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:8px}.chips button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.chips button:hover{border-color:var(--accent)}
.error{color:var(--danger);text-align:center;font-size:13px}
form{display:flex;align-items:flex-end;gap:8px;padding:10px 16px calc(12px + env(safe-area-inset-bottom));max-width:760px;width:100%;margin:0 auto}
.box{flex:1;display:flex;align-items:flex-end;gap:8px;border:1px solid var(--line);background:var(--panel);border-radius:22px;padding:6px 6px 6px 16px;box-shadow:0 6px 24px rgba(0,0,0,.06)}
.box:focus-within{border-color:color-mix(in srgb,var(--accent) 80%,var(--line))}
textarea{flex:1;resize:none;border:0;background:transparent;color:var(--ink);padding:6px 0;font:inherit;max-height:180px;outline:none}
.send{flex:none;width:34px;height:34px;border:0;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;cursor:pointer}
.send:disabled{opacity:.4;cursor:default}
@media (prefers-reduced-motion:no-preference){.msg,.actions{animation:in .24s cubic-bezier(.2,.8,.2,1)}@keyframes in{from{opacity:0;transform:translateY(6px)}}}
@media (prefers-reduced-motion:reduce){body.busy .ring::before,.dots i{animation:none}}
</style></head>
<body>
<header><span class="ring"><span class="avatar" id="avatar">·</span></span><div class="who"><b id="name">Bot</b><small id="status">Connecting…</small></div></header>
<main id="log" aria-live="polite"></main>
<form id="form"><div class="box"><textarea id="input" rows="1" placeholder="Message" aria-label="Message" autocomplete="off"></textarea><button id="send" class="send" type="submit" aria-label="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div></form>
<script>
(() => {
  const channel = "__CHANNEL__";
  const key = "pandacode-bot-" + channel;
  let token = location.hash.slice(1);
  try { if (token) sessionStorage.setItem(key, token); else token = sessionStorage.getItem(key) || ""; } catch {}
  if (location.hash) history.replaceState(null, "", location.pathname);
  const log = document.getElementById("log"), input = document.getElementById("input"), form = document.getElementById("form");
  const status = document.getElementById("status"), sendButton = document.getElementById("send");
  let cursor = 0, botName = "Bot", glyph = "·", image = "", role = "", typing = null;
  const api = (path, init = {}) => fetch("/api/chat/" + channel + "/" + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token, "Content-Type": "application/json" } })
    .then(async r => { const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(body.error || "Something went wrong."), { revoked: r.status === 401 }); return body; });
  const escape = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inline = s => s.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Replies render through Enriched Markdown's parser (md4c), the same engine as the desktop app.
  let parseMarkdown = null;
  const engine = import("/assets/md4c.js").then(m => m.default()).then(wasm => {
    const parse = wasm.cwrap("parseMarkdown", "string", ["string", "number", "number", "number", "number", "number", "number", "number", "number"]);
    parseMarkdown = text => JSON.parse(parse(text, 0, 1, 0, 0, 0, 0, 0, 1));
  }).catch(() => {});
  const NOTES = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };
  const plain = n => n.content ?? (n.children || []).map(plain).join("");
  function renderNode(n) {
    const a = n.attributes || {}, kids = () => (n.children || []).map(renderNode).join("");
    const cell = tag => "<" + tag + (["left", "center", "right"].includes(a.align) ? ' style="text-align:' + a.align + '"' : "") + ">" + kids() + "</" + tag + ">";
    switch (n.type) {
      case "Document": return kids();
      case "Paragraph": return a.tight === "true" ? kids() : "<p>" + kids() + "</p>";
      case "Text": return escape(n.content || "");
      case "SoftBreak": return "\n";
      case "LineBreak": return "<br>";
      case "Heading": return "<p><b>" + kids() + "</b></p>";
      case "Strong": return "<b>" + kids() + "</b>";
      case "Emphasis": return "<em>" + kids() + "</em>";
      case "Strikethrough": return "<del>" + kids() + "</del>";
      case "Code": return "<code>" + escape(plain(n)) + "</code>";
      case "Link": case "Image": case "Video": {
        const url = a.url || "", label = n.type === "Link" ? kids() : escape(plain(n) || "Image");
        return /^https?:\/\//i.test(url) ? '<a href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : label;
      }
      case "Blockquote": return "<blockquote>" + kids() + "</blockquote>";
      case "Admonition": { const t = NOTES[a.admonitionType] ? a.admonitionType : "note"; return '<aside class="note ' + t + '"><b>' + NOTES[t] + "</b>" + kids() + "</aside>"; }
      case "UnorderedList": return "<ul>" + kids() + "</ul>";
      case "OrderedList": return "<ol" + (Number(a.start) > 1 ? ' start="' + Number(a.start) + '"' : "") + ">" + kids() + "</ol>";
      case "ListItem": return a.isTask === "true" ? '<li class="task' + (a.taskChecked === "true" ? " done" : "") + '">' + kids() + "</li>" : "<li>" + kids() + "</li>";
      case "CodeBlock": return "<pre><code>" + escape(plain(n)) + "</code></pre>";
      case "LatexMathInline": return '<code class="math">' + escape(plain(n)) + "</code>";
      case "LatexMathDisplay": return '<pre class="math"><code>' + escape(plain(n)) + "</code></pre>";
      case "ThematicBreak": return "<hr>";
      case "Table": return '<div class="table"><table>' + kids() + "</table></div>";
      case "TableHead": return "<thead>" + kids() + "</thead>";
      case "TableBody": return "<tbody>" + kids() + "</tbody>";
      case "TableRow": return "<tr>" + kids() + "</tr>";
      case "TableHeaderCell": return cell("th");
      case "TableCell": return cell("td");
      default: return kids();
    }
  }
  function render(text) {
    if (parseMarkdown) { try { return renderNode(parseMarkdown(text)); } catch {} }
    return renderFallback(text);
  }
  function renderFallback(text) {
    const out = [], code = [];
    text = escape(text).replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, (_, body) => { code.push(body); return "\u0000" + (code.length - 1) + "\u0000"; });
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split("\n");
      if (/^\u0000\d+\u0000$/.test(block.trim())) out.push("<pre><code>" + code[Number(block.trim().slice(1, -1))] + "</code></pre>");
      else if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const tag = /^\s*\d/.test(lines[0]) ? "ol" : "ul";
        out.push("<" + tag + ">" + lines.map(l => "<li>" + inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, "")) + "</li>").join("") + "</" + tag + ">");
      } else out.push("<p>" + inline(lines.map(l => l.replace(/^#{1,6}\s+(.*)$/, "<b>$1</b>")).join("<br>")) + "</p>");
    }
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + code[Number(i)] + "</code>");
  }
  const scroll = () => log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  function place(node) { if (typing) typing.before(node); else log.append(node); }
  function add(who, text) {
    log.querySelector(".hello")?.remove();
    const row = document.createElement("div");
    row.className = "msg " + (who === "user" ? "me" : "bot");
    if (who !== "user") { const mini = document.createElement("span"); mini.className = "mini"; showAvatar(mini); row.append(mini); }
    const body = document.createElement("div"); body.className = "b";
    if (who === "user") body.textContent = text; else body.innerHTML = render(text);
    if (who !== "user" && text.startsWith("Approval needed:")) {
      const actions = document.createElement("div"); actions.className = "actions";
      for (const [label, reply, cls] of [["Allow once", "yes", "yes"], ["Always allow", "always", ""], ["Deny", "no", ""]]) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (cls) b.className = cls;
        b.onclick = () => { actions.remove(); post(reply); };
        actions.append(b);
      }
      body.append(actions);
    }
    row.append(body); place(row); scroll();
  }
  function setBusy(value) {
    document.body.classList.toggle("busy", Boolean(value));
    if (value && !typing) { typing = document.createElement("div"); typing.className = "typing"; typing.setAttribute("role", "status"); typing.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'; typing.append(botName + " is working…"); log.append(typing); scroll(); }
    if (!value && typing) { typing.remove(); typing = null; }
  }
  // Uploaded icons are data: URLs, set through .src so they are never parsed as markup.
  function showAvatar(el) {
    if (!image) { el.textContent = glyph; return; }
    const img = document.createElement("img"); img.alt = ""; img.src = image; el.replaceChildren(img);
  }
  function hello() {
    const box = document.createElement("div"); box.className = "hello";
    box.innerHTML = '<span class="avatar"></span><b></b><span></span><div class="chips"></div>';
    showAvatar(box.querySelector(".avatar")); box.querySelector("b").textContent = "Say hi to " + botName;
    box.querySelector("span:not(.avatar)").textContent = (role || "Your always-on assistant") + ". Type /stop to stop work, /new to start over.";
    for (const text of ["What can you do for me?", "Remember that I like short answers", "What are you working on?"]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = () => post(text); box.querySelector(".chips").append(b);
    }
    log.append(box);
  }
  function error(text) { const e = document.createElement("div"); e.className = "error"; e.textContent = text; place(e); scroll(); }
  async function post(text) {
    add("user", text); setBusy(true);
    try { const r = await api("messages", { method: "POST", body: JSON.stringify({ text }) }); setBusy(r.busy); }
    catch (e) { setBusy(false); error(e.message); if (e.revoked) { sendButton.disabled = true; input.disabled = true; } }
  }
  async function poll() {
    for (;;) {
      try {
        const r = await api("events?after=" + cursor);
        for (const event of r.events) add("assistant", event.text);
        cursor = r.cursor; setBusy(r.busy); status.textContent = r.busy ? "Working on it…" : (role || "On your computer");
      } catch (e) {
        status.textContent = e.message;
        // A revoked link stays revoked; stop polling instead of retrying forever.
        if (e.revoked) { setBusy(false); sendButton.disabled = true; input.disabled = true; return; }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  async function start() {
    if (!token) { status.textContent = "Open this page from the link in PandaCode."; sendButton.disabled = true; return; }
    try {
      // Give the parser a moment so history renders with it; replies never wait on it.
      await Promise.race([engine, new Promise(resolve => setTimeout(resolve, 1500))]);
      const r = await api("history");
      if (r.bot) {
        botName = r.bot.name; role = r.bot.role || ""; image = /^data:image\/(png|jpeg|webp|gif);base64,/.test(r.bot.avatar || "") ? r.bot.avatar : ""; glyph = (r.bot.avatar && !image && !r.bot.avatar.startsWith("panda:")) ? r.bot.avatar : r.bot.name.slice(0, 1).toUpperCase();
        document.getElementById("name").textContent = r.bot.name; document.title = r.bot.name; showAvatar(document.getElementById("avatar"));
        status.textContent = r.bot.paused ? "Paused" : (role || "On your computer");
      }
      if (!r.messages.length) hello();
      for (const m of r.messages) add(m.role, m.text);
      cursor = r.cursor; setBusy(r.busy); poll();
    } catch (e) { status.textContent = e.message; sendButton.disabled = true; }
  }
  form.addEventListener("submit", event => { event.preventDefault(); const text = input.value.trim(); if (!text) return; input.value = ""; input.style.height = ""; post(text); });
  input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
  start();
})();
</script></body></html>"#;
