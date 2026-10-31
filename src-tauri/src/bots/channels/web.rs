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
            let inbound = gateway::Inbound { bot_id: channel.bot_id.clone(), channel_id: channel.id.clone(), thread: THREAD.into(), sender_id: "web".into(), sender_name: "You (web)".into(), text, trusted: true, image_ids: None, moodboard_ids: None };
            match gateway::deliver(app, inbound).await {
                Ok(_) => Response::json(200, &json!({"ok": true, "busy": busy(app, &channel)})),
                Err(error) => Response::json(400, &json!({"error": error})),
            }
        }
        _ => Response::json(405, &json!({"error": "Not supported."})),
    }
}

pub(crate) fn page(channel_id: &str, accept_language: Option<&str>) -> Response {
    if !channel_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || channel_id.len() > 64 {
        return Response::text(404, "Not found.");
    }
    let lang = ui_language(accept_language);
    let strings = serde_json::to_string(&STRINGS.iter().find(|(id, _)| *id == lang).map(|(_, table)| table).unwrap_or(&ENGLISH).iter().cloned().collect::<std::collections::HashMap<&str, &str>>()).expect("string table is valid JSON");
    Response::html(
        PAGE.replace("__CHANNEL__", channel_id)
            .replace("__LANG__", lang)
            .replace("__STRINGS__", &strings),
    )
}

/// Same resolution rules as the frontend's resolveSystemLocale; English needs no table.
pub(crate) fn ui_language(accept_language: Option<&str>) -> &'static str {
    for part in accept_language.unwrap_or_default().split(',') {
        let tag = part.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
        let has = |region: &str| tag.split(['-', '_', '.']).any(|piece| piece == region);
        if tag.starts_with("zh") {
            if tag.contains("hant") {
                if has("tw") { return "zh-Hant-TW"; }
                if has("hk") || has("mo") { return "zh-Hant-HK"; }
                return "zh-Hant-TW";
            }
            if has("tw") { return "zh-Hant-TW"; }
            if has("hk") || has("mo") { return "zh-Hant-HK"; }
            return "zh-Hans";
        }
        if tag.starts_with("en") {
            if ["gb", "au", "ie", "nz", "za", "sg", "in"].iter().any(|r| has(r)) { return "en-GB"; }
            return "en-US";
        }
        if tag.starts_with("de") { return "de"; }
        if tag.starts_with("es") { return "es"; }
        if tag.starts_with("fr") { return "fr"; }
        if tag.starts_with("it") { return "it"; }
        if tag.starts_with("ja") { return "ja"; }
        if tag.starts_with("ko") { return "ko"; }
        if tag.starts_with("pl") { return "pl"; }
        if tag.starts_with("pt") { return "pt-BR"; }
        if tag.starts_with("ru") { return "ru"; }
    }
    "en-US"
}

type Table<'a> = &'a [(&'a str, &'a str)];
const ENGLISH: Table<'static> = &[];
/// Web-chat page strings per locale; missing keys fall back to the source English in the page.
const STRINGS: &[(&str, Table<'static>)] = &[
    ("zh-Hans", &[
        ("Bot chat", "Bot 聊天"),
        ("Message", "消息"),
        ("Send", "发送"),
        ("Connecting…", "连接中…"),
        ("Something went wrong.", "出错了。"),
        ("is working…", "正在工作中…"),
        ("Say hi to {0}", "跟 {0} 打个招呼吧"),
        ("Your always-on assistant", "你的全天候助手"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}。输入 /stop 停止工作，/new 重新开始。"),
        ("What can you do for me?", "你能为我做什么？"),
        ("Remember that I like short answers", "记住我喜欢简短的回答"),
        ("What are you working on?", "你在做什么？"),
        ("Allow once", "允许一次"),
        ("Always allow", "总是允许"),
        ("Deny", "拒绝"),
        ("Working on it…", "正在处理…"),
        ("On your computer", "在你的电脑上"),
        ("Paused", "已暂停"),
        ("Open this page from the link in PandaCode.", "请从 PandaCode 中的链接打开此页面。"),
        ("Too many messages. Wait a minute and try again.", "消息太多。请等一分钟再试。"),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "此链接已失效。请从 PandaCode 复制新的。"),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "此 Bot 已关闭其他设备使用。请在 PandaCode 中开启（Bots → Channels → Web chat）。"),
        ("Not supported.", "不支持。"),
        ("Not found.", "未找到。"),
    ]),
    ("zh-Hant-TW", &[
        ("Bot chat", "Bot 聊天"),
        ("Message", "訊息"),
        ("Send", "傳送"),
        ("Connecting…", "連線中…"),
        ("Something went wrong.", "發生錯誤。"),
        ("is working…", "正在工作中…"),
        ("Say hi to {0}", "跟 {0} 打個招呼吧"),
        ("Your always-on assistant", "你的全天候助理"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}。輸入 /stop 停止工作，/new 重新開始。"),
        ("What can you do for me?", "你能為我做什麼？"),
        ("Remember that I like short answers", "記得我喜歡簡短的回答"),
        ("What are you working on?", "你在做什麼？"),
        ("Allow once", "允許一次"),
        ("Always allow", "一律允許"),
        ("Deny", "拒絕"),
        ("Working on it…", "處理中…"),
        ("On your computer", "在你的電腦上"),
        ("Paused", "已暫停"),
        ("Open this page from the link in PandaCode.", "請從 PandaCode 中的連結開啟此頁面。"),
        ("Too many messages. Wait a minute and try again.", "訊息太多。請等一分鐘再試。"),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "此連結已失效。請從 PandaCode 複製新的。"),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "此 Bot 已關閉其他裝置使用。請在 PandaCode 中開啟（Bots → Channels → Web chat）。"),
        ("Not supported.", "不支援。"),
        ("Not found.", "找不到。"),
    ]),
    ("zh-Hant-HK", &[
        ("Bot chat", "Bot 聊天"),
        ("Message", "訊息"),
        ("Send", "傳送"),
        ("Connecting…", "連線中…"),
        ("Something went wrong.", "發生錯誤。"),
        ("is working…", "正在工作中…"),
        ("Say hi to {0}", "跟 {0} 打個招呼吧"),
        ("Your always-on assistant", "你的全天候助理"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}。輸入 /stop 停止工作，/new 重新開始。"),
        ("What can you do for me?", "你能為我做什麼？"),
        ("Remember that I like short answers", "記得我喜歡簡短的回答"),
        ("What are you working on?", "你在做什麼？"),
        ("Allow once", "允許一次"),
        ("Always allow", "一律允許"),
        ("Deny", "拒絕"),
        ("Working on it…", "處理中…"),
        ("On your computer", "在你的電腦上"),
        ("Paused", "已暫停"),
        ("Open this page from the link in PandaCode.", "請從 PandaCode 中的連結開啟此頁面。"),
        ("Too many messages. Wait a minute and try again.", "訊息太多。請等一分鐘再試。"),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "此連結已失效。請從 PandaCode 複製新的。"),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "此 Bot 已關閉其他裝置使用。請在 PandaCode 中開啟（Bots → Channels → Web chat）。"),
        ("Not supported.", "不支援。"),
        ("Not found.", "找不到。"),
    ]),
    ("de", &[
        ("Bot chat", "Bot-Chat"),
        ("Message", "Nachricht"),
        ("Send", "Senden"),
        ("Connecting…", "Verbindung wird hergestellt…"),
        ("Something went wrong.", "Etwas ist schiefgelaufen."),
        ("is working…", "arbeitet…"),
        ("Say hi to {0}", "Grüßen Sie {0}"),
        ("Your always-on assistant", "Ihr stets erreichbarer Assistent"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Geben Sie /stop ein, um die Arbeit zu stoppen, /new, um neu zu starten."),
        ("What can you do for me?", "Was können Sie für mich tun?"),
        ("Remember that I like short answers", "Denken Sie daran: Ich mag kurze Antworten"),
        ("What are you working on?", "Woran arbeiten Sie?"),
        ("Allow once", "Einmal erlauben"),
        ("Always allow", "Immer erlauben"),
        ("Deny", "Ablehnen"),
        ("Working on it…", "Wird bearbeitet…"),
        ("On your computer", "Auf Ihrem Computer"),
        ("Paused", "Pausiert"),
        ("Open this page from the link in PandaCode.", "Öffnen Sie diese Seite über den Link in PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Zu viele Nachrichten. Warten Sie eine Minute und versuchen Sie es erneut."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Dieser Link ist nicht mehr gültig. Kopieren Sie einen neuen aus PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "Die Nutzung von anderen Geräten ist für diesen Bot deaktiviert. Aktivieren Sie sie in PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Nicht unterstützt."),
        ("Not found.", "Nicht gefunden."),
    ]),
    ("es", &[
        ("Bot chat", "Chat del bot"),
        ("Message", "Mensaje"),
        ("Send", "Enviar"),
        ("Connecting…", "Conectando…"),
        ("Something went wrong.", "Algo salió mal."),
        ("is working…", "está trabajando…"),
        ("Say hi to {0}", "Salude a {0}"),
        ("Your always-on assistant", "Su asistente siempre activo"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Escriba /stop para detener el trabajo, /new para empezar de nuevo."),
        ("What can you do for me?", "¿Qué puede hacer por mí?"),
        ("Remember that I like short answers", "Recuerde que me gustan las respuestas cortas"),
        ("What are you working on?", "¿En qué está trabajando?"),
        ("Allow once", "Permitir una vez"),
        ("Always allow", "Permitir siempre"),
        ("Deny", "Denegar"),
        ("Working on it…", "Trabajando en ello…"),
        ("On your computer", "En su equipo"),
        ("Paused", "En pausa"),
        ("Open this page from the link in PandaCode.", "Abra esta página desde el enlace de PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Demasiados mensajes. Espere un minuto e inténtelo de nuevo."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Este enlace ya no es válido. Copie uno nuevo desde PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "El uso desde otros dispositivos está desactivado para este bot. Active la opción en PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "No admitido."),
        ("Not found.", "No encontrado."),
    ]),
    ("fr", &[
        ("Bot chat", "Chat du bot"),
        ("Message", "Message"),
        ("Send", "Envoyer"),
        ("Connecting…", "Connexion…"),
        ("Something went wrong.", "Une erreur est survenue."),
        ("is working…", "travaille…"),
        ("Say hi to {0}", "Dites bonjour à {0}"),
        ("Your always-on assistant", "Votre assistant toujours disponible"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Tapez /stop pour arrêter le travail, /new pour recommencer."),
        ("What can you do for me?", "Que pouvez-vous faire pour moi ?"),
        ("Remember that I like short answers", "N'oubliez pas que j'aime les réponses courtes"),
        ("What are you working on?", "Sur quoi travaillez-vous ?"),
        ("Allow once", "Autoriser une fois"),
        ("Always allow", "Toujours autoriser"),
        ("Deny", "Refuser"),
        ("Working on it…", "Travail en cours…"),
        ("On your computer", "Sur votre ordinateur"),
        ("Paused", "En pause"),
        ("Open this page from the link in PandaCode.", "Ouvrez cette page depuis le lien dans PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Trop de messages. Attendez une minute et réessayez."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Ce lien n'est plus valide. Copiez-en un nouveau depuis PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "L'utilisation depuis d'autres appareils est désactivée pour ce bot. Activez-la dans PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Non pris en charge."),
        ("Not found.", "Introuvable."),
    ]),
    ("it", &[
        ("Bot chat", "Chat del bot"),
        ("Message", "Messaggio"),
        ("Send", "Invia"),
        ("Connecting…", "Connessione…"),
        ("Something went wrong.", "Si è verificato un errore."),
        ("is working…", "sta lavorando…"),
        ("Say hi to {0}", "Saluta {0}"),
        ("Your always-on assistant", "Il tuo assistente sempre attivo"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Digita /stop per interrompere il lavoro, /new per ricominciare."),
        ("What can you do for me?", "Cosa puoi fare per me?"),
        ("Remember that I like short answers", "Ricorda che preferisco risposte brevi"),
        ("What are you working on?", "Su cosa stai lavorando?"),
        ("Allow once", "Consenti una volta"),
        ("Always allow", "Consenti sempre"),
        ("Deny", "Nega"),
        ("Working on it…", "Lavoro in corso…"),
        ("On your computer", "Sul tuo computer"),
        ("Paused", "In pausa"),
        ("Open this page from the link in PandaCode.", "Apri questa pagina dal link in PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Troppi messaggi. Attendi un minuto e riprova."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Questo link non è più valido. Copiane uno nuovo da PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "L'utilizzo da altri dispositivi è disattivato per questo bot. Attivalo in PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Non supportato."),
        ("Not found.", "Non trovato."),
    ]),
    ("pt-BR", &[
        ("Bot chat", "Chat do bot"),
        ("Message", "Mensagem"),
        ("Send", "Enviar"),
        ("Connecting…", "Conectando…"),
        ("Something went wrong.", "Algo deu errado."),
        ("is working…", "está trabalhando…"),
        ("Say hi to {0}", "Diga oi para {0}"),
        ("Your always-on assistant", "Seu assistente sempre ativo"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Digite /stop para parar o trabalho, /new para começar de novo."),
        ("What can you do for me?", "O que você pode fazer por mim?"),
        ("Remember that I like short answers", "Lembre-se de que gosto de respostas curtas"),
        ("What are you working on?", "No que você está trabalhando?"),
        ("Allow once", "Permitir uma vez"),
        ("Always allow", "Permitir sempre"),
        ("Deny", "Negar"),
        ("Working on it…", "Trabalhando nisso…"),
        ("On your computer", "No seu computador"),
        ("Paused", "Pausado"),
        ("Open this page from the link in PandaCode.", "Abra esta página pelo link no PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Mensagens demais. Aguarde um minuto e tente novamente."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Este link não é mais válido. Copie um novo no PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "O uso deste bot em outros dispositivos está desativado. Ative-o no PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Não suportado."),
        ("Not found.", "Não encontrado."),
    ]),
    ("ja", &[
        ("Bot chat", "Bot チャット"),
        ("Message", "メッセージ"),
        ("Send", "送信"),
        ("Connecting…", "接続中…"),
        ("Something went wrong.", "問題が発生しました。"),
        ("is working…", "作業中…"),
        ("Say hi to {0}", "{0} に挨拶する"),
        ("Your always-on assistant", "あなたの常駐アシスタント"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}。/stop で作業を停止、/new で最初からやり直します。"),
        ("What can you do for me?", "何をお願いできますか？"),
        ("Remember that I like short answers", "短い回答を好むことを覚えておいてください"),
        ("What are you working on?", "何をしていますか？"),
        ("Allow once", "1回だけ許可"),
        ("Always allow", "常に許可"),
        ("Deny", "拒否"),
        ("Working on it…", "対応中…"),
        ("On your computer", "お使いのコンピューター上"),
        ("Paused", "一時停止中"),
        ("Open this page from the link in PandaCode.", "PandaCode 内のリンクからこのページを開いてください。"),
        ("Too many messages. Wait a minute and try again.", "メッセージが多すぎます。1分待ってから再試行してください。"),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "このリンクは無効になりました。PandaCode から新しいリンクをコピーしてください。"),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "このボットの他のデバイスからの利用はオフになっています。PandaCode でオンにしてください（Bots → Channels → Web chat）。"),
        ("Not supported.", "サポートされていません。"),
        ("Not found.", "見つかりません。"),
    ]),
    ("ko", &[
        ("Bot chat", "봇 채팅"),
        ("Message", "메시지"),
        ("Send", "보내기"),
        ("Connecting…", "연결 중…"),
        ("Something went wrong.", "문제가 발생했습니다."),
        ("is working…", "작업 중…"),
        ("Say hi to {0}", "{0}에게 인사하기"),
        ("Your always-on assistant", "항상 활동 중인 어시스턴트"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. /stop으로 작업을 멈추고, /new으로 다시 시작하세요."),
        ("What can you do for me?", "저를 위해 무엇을 할 수 있나요?"),
        ("Remember that I like short answers", "짧은 답변을 좋아한다고 기억해 주세요"),
        ("What are you working on?", "지금 무엇을 하고 있나요?"),
        ("Allow once", "한 번만 허용"),
        ("Always allow", "항상 허용"),
        ("Deny", "거부"),
        ("Working on it…", "처리 중…"),
        ("On your computer", "컴퓨터에서"),
        ("Paused", "일시 중지됨"),
        ("Open this page from the link in PandaCode.", "PandaCode의 링크로 이 페이지를 열어 주세요."),
        ("Too many messages. Wait a minute and try again.", "메시지가 너무 많습니다. 1분 후에 다시 시도해 주세요."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "이 링크는 더 이상 유효하지 않습니다. PandaCode에서 새 링크를 복사해 주세요."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "이 봇은 다른 기기에서의 사용이 꺼져 있습니다. PandaCode에서 켜 주세요(Bots → Channels → Web chat)."),
        ("Not supported.", "지원되지 않습니다."),
        ("Not found.", "찾을 수 없습니다."),
    ]),
    ("pl", &[
        ("Bot chat", "Czat bota"),
        ("Message", "Wiadomość"),
        ("Send", "Wyślij"),
        ("Connecting…", "Łączenie…"),
        ("Something went wrong.", "Coś poszło nie tak."),
        ("is working…", "pracuje…"),
        ("Say hi to {0}", "Przywitaj się z {0}"),
        ("Your always-on assistant", "Twój zawsze dostępny asystent"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Wpisz /stop, aby zatrzymać pracę, /new, aby zacząć od nowa."),
        ("What can you do for me?", "Co możesz dla mnie zrobić?"),
        ("Remember that I like short answers", "Zapamiętaj, że lubię krótkie odpowiedzi"),
        ("What are you working on?", "Nad czym pracujesz?"),
        ("Allow once", "Zezwól raz"),
        ("Always allow", "Zezwól zawsze"),
        ("Deny", "Odmów"),
        ("Working on it…", "Praca w toku…"),
        ("On your computer", "Na Twoim komputerze"),
        ("Paused", "Wstrzymano"),
        ("Open this page from the link in PandaCode.", "Otwórz tę stronę z linku w PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Zbyt wiele wiadomości. Poczekaj minutę i spróbuj ponownie."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Ten link nie jest już ważny. Skopiuj nowy z PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "Korzystanie z innych urządzeń jest wyłączone dla tego bota. Włącz je w PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Nieobsługiwane."),
        ("Not found.", "Nie znaleziono."),
    ]),
    ("ru", &[
        ("Bot chat", "Чат бота"),
        ("Message", "Сообщение"),
        ("Send", "Отправить"),
        ("Connecting…", "Подключение…"),
        ("Something went wrong.", "Что-то пошло не так."),
        ("is working…", "работает…"),
        ("Say hi to {0}", "Поздоровайтесь с {0}"),
        ("Your always-on assistant", "Ваш всегда доступный помощник"),
        ("{0}. Type /stop to stop work, /new to start over.", "{0}. Введите /stop, чтобы остановить работу, /new, чтобы начать заново."),
        ("What can you do for me?", "Что вы можете для меня сделать?"),
        ("Remember that I like short answers", "Запомните, что я люблю короткие ответы"),
        ("What are you working on?", "Над чем вы работаете?"),
        ("Allow once", "Разрешить один раз"),
        ("Always allow", "Разрешать всегда"),
        ("Deny", "Отклонить"),
        ("Working on it…", "Работаю над этим…"),
        ("On your computer", "На вашем компьютере"),
        ("Paused", "Приостановлено"),
        ("Open this page from the link in PandaCode.", "Откройте эту страницу по ссылке из PandaCode."),
        ("Too many messages. Wait a minute and try again.", "Слишком много сообщений. Подождите минуту и попробуйте снова."),
        ("This link is no longer valid. Copy a fresh one from PandaCode.", "Ссылка больше недействительна. Скопируйте новую из PandaCode."),
        ("Use from other devices is off for this bot. Turn it on in PandaCode (Bots → Channels → Web chat).", "Использование с других устройств отключено для этого бота. Включите его в PandaCode (Bots → Channels → Web chat)."),
        ("Not supported.", "Не поддерживается."),
        ("Not found.", "Не найдено."),
    ]),
];

const PAGE: &str = r#"<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
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
</style>
<script>const L = __STRINGS__; const t = k => L[k] || k; const tf = (k, ...v) => t(k).replace(/\{(\d+)\}/g, (_, i) => v[+i] ?? t(k));</script>
</head>
<body>
<header><span class="ring"><span class="avatar" id="avatar">·</span></span><div class="who"><b id="name">Bot</b><small id="status">Connecting…</small></div></header>
<main id="log" aria-live="polite"></main>
<form id="form"><div class="box"><textarea id="input" rows="1" autocomplete="off"></textarea><button id="send" class="send" type="submit"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div></form>
<script>
(() => {
  const channel = "__CHANNEL__";
  const key = "pandacode-bot-" + channel;
  let token = location.hash.slice(1);
  try { if (token) sessionStorage.setItem(key, token); else token = sessionStorage.getItem(key) || ""; } catch {}
  if (location.hash) history.replaceState(null, "", location.pathname);
  const log = document.getElementById("log"), input = document.getElementById("input"), form = document.getElementById("form");
  const status = document.getElementById("status"), sendButton = document.getElementById("send");
  document.title = t("Bot chat");
  input.placeholder = t("Message"); input.setAttribute("aria-label", t("Message"));
  sendButton.setAttribute("aria-label", t("Send"));
  status.textContent = t("Connecting…");
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
      for (const [label, reply, cls] of [[t("Allow once"), "yes", "yes"], [t("Always allow"), "always", ""], [t("Deny"), "no", ""]]) {
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
    if (value && !typing) { typing = document.createElement("div"); typing.className = "typing"; typing.setAttribute("role", "status"); typing.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'; typing.append(botName + " " + t("is working…")); log.append(typing); scroll(); }
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
    showAvatar(box.querySelector(".avatar")); box.querySelector("b").textContent = tf("Say hi to {0}", botName);
    box.querySelector("span:not(.avatar)").textContent = tf("{0}. Type /stop to stop work, /new to start over.", role || t("Your always-on assistant"));
    for (const text of [t("What can you do for me?"), t("Remember that I like short answers"), t("What are you working on?")]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = () => post(text); box.querySelector(".chips").append(b);
    }
    log.append(box);
  }
  function error(text) { const e = document.createElement("div"); e.className = "error"; e.textContent = text; place(e); scroll(); }
  async function post(text) {
    add("user", text); setBusy(true);
    try { const r = await api("messages", { method: "POST", body: JSON.stringify({ text }) }); setBusy(r.busy); }
    catch (e) { setBusy(false); error(t(e.message)); if (e.revoked) { sendButton.disabled = true; input.disabled = true; } }
  }
  async function poll() {
    for (;;) {
      try {
        const r = await api("events?after=" + cursor);
        for (const event of r.events) add("assistant", event.text);
        cursor = r.cursor; setBusy(r.busy); status.textContent = r.busy ? t("Working on it…") : (role || t("On your computer"));
      } catch (e) {
        status.textContent = t(e.message);
        // A revoked link stays revoked; stop polling instead of retrying forever.
        if (e.revoked) { setBusy(false); sendButton.disabled = true; input.disabled = true; return; }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  async function start() {
    if (!token) { status.textContent = t("Open this page from the link in PandaCode."); sendButton.disabled = true; return; }
    try {
      // Give the parser a moment so history renders with it; replies never wait on it.
      await Promise.race([engine, new Promise(resolve => setTimeout(resolve, 1500))]);
      const r = await api("history");
      if (r.bot) {
        botName = r.bot.name; role = r.bot.role || ""; image = /^data:image\/(png|jpeg|webp|gif);base64,/.test(r.bot.avatar || "") ? r.bot.avatar : ""; glyph = (r.bot.avatar && !image && !r.bot.avatar.startsWith("panda:")) ? r.bot.avatar : r.bot.name.slice(0, 1).toUpperCase();
        document.getElementById("name").textContent = r.bot.name; document.title = r.bot.name; showAvatar(document.getElementById("avatar"));
        status.textContent = r.bot.paused ? t("Paused") : (role || t("On your computer"));
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
