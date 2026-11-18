//! Projections of PandaCode that are not desktop windows (docs/extensions/bot-conversation.md#bot-web-chat-projection).
//! The bot web chat is a fixed page served by this computer to whoever holds the channel's link: it renders the
//! conversation's text only. No extension action, contribution, view or desktop HTML is ever forwarded to it, and its
//! history reports the withheld state with a stable reason. Like placement, the report is recomputed per request from
//! the host's own registry and authorizes nothing.
use serde_json::{json, Value};

/// The stable reason a bot web chat reports while extensions are enabled on this computer.
pub const BOT_WEB_WITHHELD: &str = "UnsupportedCapability: the bot web chat is a text-only projection. Extension actions, contributions and desktop HTML stay in the PandaCode desktop app.";

/// Nothing is projected; with any enabled package the page is told so, with the reason.
pub fn bot_web_policy(enabled: usize) -> Value {
    if enabled == 0 { json!({"apiVersion": 1, "projected": [], "state": "none"}) }
    else { json!({"apiVersion": 1, "projected": [], "state": "withheld", "reason": BOT_WEB_WITHHELD}) }
}

/// The policy for this registry: safe mode lists no package.
pub fn bot_web(packages: &super::Packages) -> Value {
    bot_web_policy(packages.snapshot().packages.iter().filter(|package| package.enabled).count())
}

/// The policy for the running app. A registry that cannot be read reports withheld rather than nothing.
pub fn bot_web_for(app: &tauri::AppHandle) -> Value {
    use tauri::Manager;
    let Some(state) = app.try_state::<super::ExtensionPackages>() else { return bot_web_policy(0) };
    let packages = state.0.lock();
    match packages { Ok(packages) => bot_web(&packages), Err(_) => bot_web_policy(1) }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{archive, Storage};
    use super::*;
    use crate::bots::{self, channels, BotInput};

    const CONVERSATION: &[u8] = include_bytes!("../../../tests/fixtures/extensions/bot-conversation/extension.json");
    const RICH: &[u8] = include_bytes!("../../../tests/fixtures/extensions/rich-view/extension.json");
    const HTML: &[u8] = include_bytes!("../../../tests/fixtures/extensions/rich-view/assets/view.html");
    const CSS: &[u8] = include_bytes!("../../../tests/fixtures/extensions/rich-view/assets/view.css");
    const SCRIPT: &[u8] = include_bytes!("../../../tests/fixtures/extensions/rich-view/assets/view.js");

    /// A bot with a web chat channel whose thread holds user and assistant text plus rows the page must never see.
    fn web_chat(root: &std::path::Path) -> (crate::storage::Store, String, String, String) {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let input = BotInput { name: "Scout".into(), role: "Research".into(), instructions: "Be brief.".into(), provider: "claude".into(), model: "default".into(), mode: "ask".into(), ..Default::default() };
        let bot = bots::create(&store, &input, root).unwrap();
        let channel = channels::add(&store, &bot.id, &channels::ChannelInput { kind: "web".into(), label: "Web chat".into(), ..Default::default() }).unwrap();
        let (session, _) = bots::thread_session(&store, &bot, &channel.id, "web", "Scout · You (web)").unwrap();
        for (role, content, at) in [
            ("user", "What changed today?\n\nBot brief: private instructions", 10),
            ("assistant", "Inbox at **zero**.", 20),
            ("tool", "<iframe srcdoc=\"<script>steal()</script>\"></iframe>", 30),
            ("system", "sample.bot-conversation/thread contributed Bot notes", 40),
        ] {
            store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,?2,?3,?4)", rusqlite::params![session, role, content, at]).unwrap();
        }
        let token = channels::web_token(&store, &channel.id).unwrap();
        (store, bot.id, channel.id, token)
    }

    #[test]
    fn bot_web_projection_never_forwards_package_actions_contributions_or_desktop_html() {
        let root = std::env::temp_dir().join(format!("pandacode-bot-web-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (store, bot, channel, token) = web_chat(&root);
        let storage = Storage::new(); let packages = storage.packages(false);
        // Zero extensions: nothing to withhold.
        let (session, baseline) = bots::web_projection(&store, &bot, &channel, "web", bot_web(&packages));
        assert!(session.is_some());
        assert_eq!(baseline["extensions"], json!({"apiVersion": 1, "projected": [], "state": "none"}));
        // A contributing package and a rich desktop view, both enabled.
        packages.install(&archive(&[("extension.json", CONVERSATION)])).unwrap();
        packages.enable("sample.bot-conversation", true).unwrap();
        packages.install(&archive(&[("extension.json", RICH), ("assets/view.html", HTML), ("assets/view.css", CSS), ("assets/view.js", SCRIPT)])).unwrap();
        // A rich view is package code (ADR-0001), so it needs the executable trust before it can be enabled.
        let digest = packages.snapshot().packages.iter().find(|package| package.manifest["id"] == "sample.rich-view").unwrap().executable_digest().unwrap().to_owned();
        packages.trust("sample.rich-view", &digest, true).unwrap();
        packages.enable("sample.rich-view", true).unwrap();
        assert_eq!(packages.snapshot().packages.iter().filter(|package| package.enabled).count(), 2);
        let (_, projected) = bots::web_projection(&store, &bot, &channel, "web", bot_web(&packages));
        // The stable withheld state, and nothing else changes: the page sees exactly the zero-extension chat.
        assert_eq!(projected["extensions"], json!({"apiVersion": 1, "projected": [], "state": "withheld", "reason": BOT_WEB_WITHHELD}));
        let (mut left, mut right) = (baseline.clone(), projected.clone());
        left.as_object_mut().unwrap().remove("extensions"); right.as_object_mut().unwrap().remove("extensions");
        assert_eq!(left, right);
        let keys: Vec<&str> = projected.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["bot", "extensions", "messages"]);
        // Only user and assistant text, the folded brief left out; no tool or system row.
        assert_eq!(projected["messages"], json!([{"role": "user", "text": "What changed today?", "at": 10}, {"role": "assistant", "text": "Inbox at **zero**.", "at": 20}]));
        let text = projected.to_string();
        for forbidden in ["sample.bot-conversation", "sample.rich-view", "Bot notes", "Channel notes", "panda.bot", "showDialog", "Local rich report", "<main", "<iframe", "<script", "steal()", "Bot brief", "private instructions", token.as_str()] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        // Disable and safe mode report nothing to withhold and keep the stored preferences.
        packages.enable("sample.bot-conversation", false).unwrap();
        packages.enable("sample.rich-view", false).unwrap();
        assert_eq!(bots::web_projection(&store, &bot, &channel, "web", bot_web(&packages)).1, baseline);
        packages.enable("sample.rich-view", true).unwrap();
        assert_eq!(bots::web_projection(&store, &bot, &channel, "web", bot_web(&storage.packages(true))).1, baseline);
        assert_eq!(bot_web(&storage.packages(false))["state"], "withheld");
        assert_eq!(bot_web_policy(3), bot_web_policy(1));
        let _ = std::fs::remove_dir_all(&root);
    }
}
