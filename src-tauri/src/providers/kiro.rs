use super::*;

pub(crate) const COMMANDS: &str = "_kiro.dev/commands/available";

pub(crate) fn native_command(name: &str) -> bool {
    matches!(
        name,
        "/help" | "/context" | "/usage" | "/compact" | "/tools" | "/model" | "/agent" | "/effort"
    )
}

pub(crate) fn command_frame(frame: &Value) -> Option<Value> {
    if frame["method"] != COMMANDS
        || !frame["params"]["commands"].is_array()
        || frame.to_string().len() > 128 * 1024
    {
        return None;
    }
    let mut entries = frame["params"]["commands"].clone();
    for entry in entries.as_array_mut()? {
        if entry["meta"]["hint"].is_string() {
            entry["input"] = json!({"hint":entry["meta"]["hint"]});
        }
    }
    Some(
        json!({"method":"session/update","kiroLegacyCommands":true,"params":{"sessionId":frame["params"]["sessionId"],"update":{"sessionUpdate":"available_commands_update","availableCommands":entries}}}),
    )
}

impl Protocol {
    pub(super) fn kiro_commands(&mut self, frame: &Value) -> Option<Step> {
        if self.config.provider != "kiro" {
            return None;
        }
        let (frame, legacy) = if let Some(frame) = command_frame(frame) {
            (frame, true)
        } else if frame["method"] == "session/update"
            && frame["params"]["update"]["sessionUpdate"] == "available_commands_update"
        {
            (frame.clone(), false)
        } else {
            return None;
        };
        let id = field(&frame["params"], "sessionId");
        let mut step = Step::default();
        if id.is_empty() || id.len() > 256 || (!self.remote_id.is_empty() && id != self.remote_id) {
            return Some(step);
        }
        self.kiro_commands = Some((frame.clone(), legacy));
        if !self.remote_id.is_empty() {
            self.commands_changed(&frame, &mut step);
            if self.kiro_prompt_waiting {
                self.kiro_prompt_waiting = false;
                self.kimi_prompt(&mut step);
            }
        }
        Some(step)
    }

    pub(super) fn kiro_prompt(&mut self, step: &mut Step) -> bool {
        if self.config.provider != "kiro" {
            return false;
        }
        let Some((name, arguments)) = crate::slash_commands::split_command(&self.config.prompt)
        else {
            return false;
        };
        let Some((frame, legacy)) = &self.kiro_commands else {
            self.kiro_prompt_waiting = true;
            return true;
        };
        let entries = frame["params"]["update"]["availableCommands"].as_array();
        if frame["params"]["sessionId"] != self.remote_id
            || !entries.is_some_and(|entries| {
                entries.iter().any(|entry| {
                    field(entry, "name").trim_start_matches('/') == name.trim_start_matches('/')
                })
            })
        {
            step.failure = Some("Kiro meldet diesen Befehl für die aktive Session nicht. Befehlsliste aktualisieren.".into());
            return true;
        }
        if !*legacy {
            return false;
        }
        if !native_command(name) || !self.image_blocks.is_empty() {
            step.failure = Some("Dieser Kiro-Befehl benötigt die interaktive CLI. Bilder sind für Kiro-Slash-Commands nicht unterstützt.".into());
            return true;
        }
        let args = if matches!(name, "/model" | "/agent" | "/effort") {
            if arguments.split_whitespace().count() > 1 {
                step.failure = Some("Für diesen Kiro-Befehl genau eine Auswahl-ID angeben.".into());
                return true;
            }
            if arguments.is_empty() {
                json!({})
            } else {
                json!({"value":arguments})
            }
        } else {
            if !arguments.is_empty() {
                step.failure = Some(
                    "Unterbefehle dieses Kiro-Panels werden in der interaktiven CLI ausgeführt."
                        .into(),
                );
                return true;
            }
            json!({})
        };
        self.kiro_command_active = true;
        self.phase = 1;
        step.write.push(json!({"jsonrpc":"2.0","id":3,"method":"_kiro.dev/commands/execute","params":{"sessionId":self.remote_id,"command":{"command":name.trim_start_matches('/'),"args":args}}}));
        true
    }

    pub(super) fn kiro_command_result(
        &mut self,
        result: &Value,
        step: &mut Step,
    ) -> Result<(), String> {
        self.kiro_command_active = false;
        if result["success"] == false {
            return Err(model_text(
                result["message"].as_str(),
                "Kiro-Befehl fehlgeschlagen",
                1000,
            ));
        }
        let message = model_text(result["message"].as_str(), "", 8192);
        if !message.is_empty() {
            self.text_delta("kiro-command", None, &message, step);
        }
        if let Some(commands) = result["data"]["commands"]
            .as_array()
            .filter(|_| message.is_empty())
        {
            let text = commands
                .iter()
                .take(100)
                .filter_map(|entry| {
                    entry["name"].as_str().map(|name| {
                        format!(
                            "{} – {}",
                            model_text(Some(name), "", 160),
                            model_text(entry["description"].as_str(), "", 500)
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                self.text_delta("kiro-command", None, &format!("\n{text}"), step);
            }
        }
        if let Some(percent) = result["data"]["contextUsagePercentage"]
            .as_f64()
            .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        {
            self.text_delta(
                "kiro-command",
                None,
                &format!("\nKontextnutzung: {percent:.1} %"),
                step,
            );
        }
        if let Some(tools) = result["data"]["tools"].as_array() {
            let text = tools
                .iter()
                .take(100)
                .filter_map(|tool| tool["name"].as_str())
                .map(|name| model_text(Some(name), "", 160))
                .collect::<Vec<_>>()
                .join(", ");
            if !text.is_empty() {
                self.text_delta("kiro-command", None, &format!("\n{text}"), step);
            }
        }
        if message.is_empty() && step.events.is_empty() {
            self.text_delta("kiro-command", None, "Kiro-Befehl ausgeführt.", step);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(session: &str) -> Value {
        json!({"method":COMMANDS,"params":{"sessionId":session,"commands":[
            {"name":"/help","description":"Help"},
            {"name":"/context","meta":{"hint":"add <path>"}},
            {"name":"/compact"}, {"name":"/tools"}, {"name":"/model"}
        ]}})
    }

    #[test]
    fn legacy_commands_wait_for_the_session_catalog_and_never_become_prompts() {
        let mut cfg = super::super::tests::config("kiro");
        cfg.prompt = "/help".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "active".into();
        let mut step = Step::default();
        p.kimi_prompt(&mut step);
        assert!(step.write.is_empty());
        assert!(p.kiro_prompt_waiting);
        assert!(p.kiro_commands(&frame("foreign")).unwrap().write.is_empty());
        assert!(p.kiro_prompt_waiting);
        let step = p.kiro_commands(&frame("active")).unwrap();
        assert_eq!(step.write[0]["method"], "_kiro.dev/commands/execute");
        assert_eq!(
            step.write[0]["params"]["command"],
            json!({"command":"help","args":{}})
        );
        assert!(step
            .write
            .iter()
            .all(|request| request["method"] != "session/prompt"));
        let step = p
            .receive(json!({"id":3,"result":{"success":true,"message":"Available commands"}}))
            .unwrap();
        assert!(step.done);
        assert!(step
            .events
            .iter()
            .any(|event| event.kind == "text" && event.text == "Available commands"));
    }

    #[test]
    fn panels_reject_unmapped_arguments_and_failed_commands_fail_the_turn() {
        for text in ["/tools trust-all", "/context add /private/file", "/unknown"] {
            let mut cfg = super::super::tests::config("kiro");
            cfg.prompt = text.into();
            let mut p = Protocol::new(cfg);
            p.remote_id = "active".into();
            p.kiro_commands(&frame("active"));
            let mut step = Step::default();
            p.kimi_prompt(&mut step);
            assert!(step.failure.is_some());
            assert!(step.write.is_empty());
        }
        let mut p = Protocol::new(super::super::tests::config("kiro"));
        p.kiro_command_active = true;
        assert!(p
            .receive(json!({"id":3,"result":{"success":false,"message":"Unavailable"}}))
            .is_err());
    }

    #[test]
    fn kiro_plan_uses_the_advertised_planner_and_model_before_prompt() {
        let mut cfg = super::super::tests::config("kiro");
        cfg.mode = "plan".into();
        cfg.model = "model-b".into();
        let mut p = Protocol::new(cfg);
        let step = p.receive(json!({"id":2,"result":{"sessionId":"active", "modes":{"availableModes":[{"id":"kiro_default"},{"id":"kiro_planner"}]},"models":{"availableModels":[{"modelId":"model-b"}]}}})).unwrap();
        assert_eq!(step.write[0]["params"]["modeId"], "kiro_planner");
        let step = p.receive(json!({"id":4,"result":{}})).unwrap();
        assert_eq!(step.write[0]["method"], "session/set_model");
        assert_eq!(step.write[0]["params"]["modelId"], "model-b");
        let step = p.receive(json!({"id":5,"result":{}})).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
    }
}
