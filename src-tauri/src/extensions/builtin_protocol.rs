//! Compatibility facade over the original wire engine, compiled as a providers child.
//! Deref is deliberately internal: existing core lifecycle/tool helpers retain their state.
use super::*;
use crate::extensions::providers::{BuiltinProvider, Operation};

pub(super) struct Session {
    provider: BuiltinProvider,
    legacy: Protocol,
}

impl Session {
    pub(super) fn new(config: RunConfig) -> Result<Self, String> {
        let provider = BuiltinProvider::get(&config.provider)?;
        provider.require(if config.resume_id.is_some() { Operation::Resume } else { Operation::Start })?;
        Ok(Self { provider, legacy: Protocol::new(config) })
    }

    pub(super) fn initial(&self) -> Value { self.legacy.initial() }
    pub(super) fn receive(&mut self, frame: Value) -> Result<Step, String> { self.legacy.receive(frame) }
    pub(super) fn cancel(&self) -> Value { self.legacy.cancel() }
    pub(super) fn approval_step(&mut self, id: &str, approved: bool) -> Step {
        self.legacy.approval_step(id, approved)
    }
    pub(super) fn steer(&mut self, id: String, text: String, reply: goals::RpcReply) -> Step {
        self.legacy.steer(id, text, reply)
    }
    pub(super) fn question(&mut self, id: &str, response: Value) -> Result<Step, String> {
        self.provider.require(Operation::Question)?;
        if self.provider.id == "muse" { self.legacy.muse_user_input(id, response) }
        else { self.legacy.user_input(id, response) }
    }
}

impl std::ops::Deref for Session {
    type Target = Protocol;
    fn deref(&self) -> &Protocol { &self.legacy }
}
impl std::ops::DerefMut for Session {
    fn deref_mut(&mut self) -> &mut Protocol { &mut self.legacy }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::providers::{all, Capability, OPERATIONS};

    // Only generated correlation UUIDs differ. All wire IDs, session/turn IDs,
    // policy values, text, event order and completion flags remain compared.
    fn stable(value: &mut Value) {
        match value {
            Value::String(text) if text != "01a15ba3-9096-76db-bd69-35168c0ecfa9" && uuid::Uuid::parse_str(text).is_ok() => *text = "<generated-uuid>".into(),
            Value::Array(values) => values.iter_mut().for_each(stable),
            Value::Object(values) => values.values_mut().for_each(stable),
            _ => {},
        }
    }
    fn effect(step: &Step) -> Value {
        assert!(step.calls.is_empty());
        assert!(step.goal_acknowledgements.is_empty());
        let mut value = json!({"events":step.events,"write":step.write,"done":step.done,"failure":step.failure});
        stable(&mut value);
        value
    }
    fn same_value(mut old: Value, mut new: Value) {
        stable(&mut old); stable(&mut new); assert_eq!(old, new);
    }

    #[test]
    fn builtin_adapter_roster_and_capabilities_are_additive_and_fail_closed() {
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/builtin-provider-parity.json")).unwrap();
        assert_eq!(fixture["providers"].as_object().unwrap().len(), PROVIDERS.len());
        assert_eq!(all().map(|p| (p.id, p.name)).collect::<Vec<_>>(), PROVIDERS);
        for provider in all() {
            assert!(fixture["providers"][provider.id].is_string());
            for op in OPERATIONS {
                assert_eq!(provider.require(op).is_ok(), provider.capability(op) == Capability::Enabled);
            }
            let descriptor = serde_json::to_value(provider.descriptor()).unwrap();
            assert_eq!(descriptor["apiVersion"], 1);
            assert_eq!(descriptor["id"], provider.id);
            let mut session = Session::new(super::super::tests::config(provider.id)).unwrap();
            let answer = session.question("missing", json!({})).err().unwrap();
            if !matches!(provider.id, "codex" | "muse") {
                assert!(answer.starts_with("UnsupportedCapability:"));
                assert!(session.inputs.is_empty());
            }
        }
        assert!(BuiltinProvider::get("sample.provider/cli").is_err());
        assert!(BuiltinProvider::get("not-a-provider").is_err());
    }

    /// One roster by name: native table, contract, team harnesses, web identity/types/Skills
    /// names, preview mocks, console policy and both fixtures. A built-in added upstream
    /// that misses any of them fails here instead of becoming an unknown identity.
    #[test]
    fn builtin_roster_agrees_by_name_across_native_web_preview_and_fixtures() {
        fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
            let from = source.find(start).unwrap_or_else(|| panic!("{start:?} not found")) + start.len();
            &source[from..from + source[from..].find(end).unwrap_or_else(|| panic!("{end:?} not found after {start:?}"))]
        }
        fn quoted(text: &str) -> Vec<String> {
            regex::Regex::new(r"'([a-z][a-z-]*)'").unwrap().captures_iter(text).map(|c| c[1].to_owned()).collect()
        }
        fn sorted(mut ids: Vec<String>) -> Vec<String> { ids.sort(); ids }
        fn keys(value: &Value) -> Vec<String> { sorted(value.as_object().unwrap().keys().cloned().collect()) }
        let native: Vec<(String, String)> = PROVIDERS.iter().map(|(id, name)| ((*id).into(), (*name).into())).collect();
        let ids: Vec<String> = native.iter().map(|(id, _)| id.clone()).collect();
        assert!(ids.iter().any(|id| id == "alibaba") && ids.iter().any(|id| id == "cursor"));
        assert_eq!(all().map(|p| (p.id.to_owned(), p.name.to_owned())).collect::<Vec<_>>(), native, "contract roster");
        assert_eq!(sorted(crate::architect::HARNESSES.iter().map(|id| (*id).to_owned()).collect()), sorted(ids.clone()),
            "every built-in, ZCode included, is a team harness");

        let identity = include_str!("../../../src/extensions/provider-identity.ts");
        assert_eq!(quoted(between(identity, "BUILTIN_PROVIDER_IDS = [", "]")), ids, "web identity roster, in native order");
        let types = include_str!("../../../src/types.ts");
        assert_eq!(sorted(quoted(between(types, "export type BuiltinProviderId =", ";"))), sorted(ids.clone()), "BuiltinProviderId");
        let skills = include_str!("../../../src/skill-manager-model.ts");
        let names = between(skills, "const HARNESS_NAMES", "};");
        let skill_ids = regex::Regex::new(r"'?([a-z][a-z-]*)'?: '").unwrap().captures_iter(names).map(|c| c[1].to_owned()).collect();
        assert_eq!(sorted(skill_ids), sorted(ids.clone()), "Skills manager HARNESS_NAMES");
        let preview = include_str!("../../../src/preview.ts");
        let mocks: Vec<(String, String)> = regex::Regex::new(r"\{ id: '([^']+)', name: '([^']+)'").unwrap()
            .captures_iter(between(preview, "const providers: Provider[] = [", "];"))
            .map(|c| (c[1].to_owned(), c[2].to_owned())).collect();
        assert_eq!(mocks, native, "preview provider mocks by id and name");

        // The web console hint and native terminal admission name the same built-ins.
        let cli = include_str!("../../../src/extensions/provider-cli.ts");
        let refused = quoted(between(cli, "providerOwner(id) || [", "]"));
        let natively_refused: Vec<String> = ids.iter().filter(|id| crate::extensions::providers::require_console(id).is_err()).cloned().collect();
        assert_eq!(sorted(refused), sorted(natively_refused), "console policy");

        let parity: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/builtin-provider-parity.json")).unwrap();
        assert_eq!(keys(&parity["providers"]), sorted(ids.clone()), "parity fixture");
        let matrix: Value = serde_json::from_str(include_str!("../../../tests/fixtures/skill-matrix.json")).unwrap();
        // Entry contents (enforcement, installAs) are compared with the native table by
        // skill_manager::matrix_tests::skill_manager_matrix_fixture_matches_the_native_table.
        assert_eq!(keys(&matrix), sorted(ids), "Skills matrix fixture");
    }

    #[test]
    fn builtin_adapter_recorded_frames_preserve_start_resume_events_responses_steer_and_stop() {
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/builtin-provider-parity.json")).unwrap();
        for provider in all() {
            let family = fixture["providers"][provider.id].as_str().unwrap();
            let frames = fixture["frames"][family].as_array().unwrap();
            for resume in [false, true] {
                for decision in [Some(false), Some(true), None] {
                    for steering in [false, true] {
                        let mut config = super::super::tests::config(provider.id);
                        config.cwd = PathBuf::from("/sample");
                        config.resume_id = resume.then(|| if family == "pi" { "01a15ba3-9096-76db-bd69-35168c0ecfa9" } else { "saved" }.into());
                        let mut old = Protocol::new(config.clone());
                        let mut new = Session::new(config).unwrap();
                        same_value(old.initial(), new.initial());
                        let mut seen_session = false;
                        let mut seen_text = false;
                        let mut seen_approval = false;
                        let mut seen_question = false;
                        let mut sent_prompt = false;
                        for (index, recorded) in frames.iter().enumerate() {
                            if family == "codex" && recorded["id"] == 10000 && !resume { continue; }
                            let mut frame = recorded.clone();
                            if family == "acp" && frame["id"] == 2 {
                                if let Some(mode) = fixture["sessionModes"][provider.id].as_str() {
                                    frame["result"]["modes"] = json!({"currentModeId":mode,"availableModes":[{"id":mode,"name":mode}]});
                                }
                                if fixture["sessionOverrides"][provider.id].is_object() {
                                    frame["result"] = fixture["sessionOverrides"][provider.id].clone();
                                }
                            }
                            if steering && index == frames.len() - 1 {
                                let (tx_old, mut rx_old) = tokio::sync::oneshot::channel();
                                let (tx_new, mut rx_new) = tokio::sync::oneshot::channel();
                                assert_eq!(effect(&old.steer("steer".into(), "check tests".into(), tx_old)),
                                    effect(&new.steer("steer".into(), "check tests".into(), tx_new)));
                                assert_eq!(rx_old.try_recv(), rx_new.try_recv());
                            }
                            let old_step = old.receive(frame.clone());
                            let new_step = new.receive(frame);
                            assert_eq!(old_step.as_ref().err(), new_step.as_ref().err(), "{} frame {index}", provider.id);
                            let old_step = old_step.unwrap_or_else(|error| panic!("{} resume={resume} frame {index}: {error}", provider.id));
                            let new_step = new_step.unwrap();
                            assert_eq!(effect(&old_step), effect(&new_step), "{} frame {index}", provider.id);
                            sent_prompt |= old_step.write.iter().any(|write| {
                                matches!(write["method"].as_str(), Some("session/prompt" | "session/send" | "turn/start"))
                                    || matches!(write["type"].as_str(), Some("user" | "prompt"))
                            });
                            assert_eq!(old.remote_id, new.remote_id);
                            assert_eq!(old.turn_id, new.turn_id);
                            assert_eq!(old.phase, new.phase);
                            for (old_event, new_event) in old_step.events.iter().zip(&new_step.events) {
                                seen_session |= old_event.kind == "session";
                                seen_text |= matches!(old_event.kind.as_str(), "text" | "thinking");
                                if old_event.kind == "approval" {
                                    seen_approval = true;
                                    if let Some(approved) = decision {
                                        assert_eq!(effect(&old.approval_step(old_event.request_id.as_deref().unwrap(), approved)),
                                            effect(&new.approval_step(new_event.request_id.as_deref().unwrap(), approved)));
                                    }
                                }
                                if old_event.kind == "input_request" {
                                    seen_question = true;
                                    if decision.is_none() { continue; }
                                    let response = json!({"answers":{"color":["Red"]}});
                                    let old_id = old_event.request_id.as_deref().unwrap();
                                    let old_answer = if provider.id == "muse" { old.muse_user_input(old_id, response.clone()) }
                                        else { old.user_input(old_id, response.clone()) }.unwrap();
                                    assert_eq!(effect(&old_answer), effect(&new.question(new_event.request_id.as_deref().unwrap(), response).unwrap()));
                                }
                            }
                            same_value(old.cancel(), new.cancel());
                        }
                        assert!(seen_session, "{} did not open its session", provider.id);
                        assert!(seen_text, "{} did not normalize content", provider.id);
                        assert!(seen_approval, "{} did not exercise approval", provider.id);
                        assert!(sent_prompt, "{} never sent its prompt", provider.id);
                        assert_eq!(seen_question, matches!(provider.id, "codex" | "muse"));
                        assert_eq!(effect(&old.cancel_requests()), effect(&new.cancel_requests()));
                        same_value(json!(old.steers_ended(false)), json!(new.steers_ended(false)));
                    }
                }
            }
        }
    }

    #[test]
    fn builtin_adapter_does_not_turn_failed_resume_or_cancel_into_success() {
        for provider in all().filter(|p| matches!(p.id, "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "devin" | "hermes")) {
            let mut config = super::super::tests::config(provider.id);
            config.resume_id = Some("saved".into());
            let mut old = Protocol::new(config.clone());
            let mut new = Session::new(config).unwrap();
            let frame = json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}});
            let error = old.receive(frame.clone()).err().unwrap();
            assert!(error.contains("cannot resume saved tasks"));
            assert_eq!(new.receive(frame).err().unwrap(), error);
            same_value(old.cancel(), new.cancel());
            assert_eq!(old.remote_id, "saved");
            assert_eq!(new.remote_id, "saved");
        }
        for provider in all() {
            let mut old = Protocol::new(super::super::tests::config(provider.id));
            let mut new = Session::new(super::super::tests::config(provider.id)).unwrap();
            // Stop is a native request even before startup completes, never a
            // synthetic completion event or an implicit successful approval.
            same_value(old.cancel(), new.cancel());
            assert_eq!(effect(&old.cancel_requests()), effect(&new.cancel_requests()));
            let old_step = old.approval_step("unknown", true);
            let new_step = new.approval_step("unknown", true);
            assert_eq!(effect(&old_step), effect(&new_step));
            assert!(new_step.write.is_empty());
        }
    }

    #[tokio::test]
    async fn builtin_adapter_discovery_and_catalog_keep_native_observations_and_failures() {
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/builtin-provider-parity.json")).unwrap();
        let catalogs = &fixture["catalogs"];
        let catalog = |id: &str| -> Result<Vec<ModelInfo>, String> {
            match id {
                "claude" => parse_claude_models(&catalogs["claude"]),
                "codex" => parse_codex_models(&catalogs["codex"]),
                "kimi" => kimi_models::parse(&serde_json::to_vec(&catalogs["kimi"]).unwrap()),
                "opencode" => parse_opencode_v2_models(&serde_json::to_vec(&catalogs["opencode"]).unwrap()),
                "glm" => Ok(glm::models()),
                "mimo" => Ok(mimo::models()),
                "grok" => Ok(acp::parse_grok_models(&catalogs["grok"]["models"])),
                "pi" | "omp" => pi::parse_models(&catalogs["pi"]),
                "muse" => muse::parse_models(&catalogs["muse"]),
                "zcode" => zcode::parse_models(&catalogs["zcode"]),
                "alibaba" => Ok(alibaba::models()),
                "cursor" => Ok(cursor::catalog(&catalogs["cursor"])),
                _ => Ok(acp::parse_models_for(id, &catalogs["acp"])),
            }
        };
        for provider in all() {
            // Dependency-injected host observations: the adapter must neither
            // probe a different executable nor replace saved/model metadata.
            for installed in [false, true] {
                let probe = |id: &str, name: &str| ProviderInfo {
                    id: id.into(), name: name.into(), installed,
                    path: installed.then(|| "/sample/cli".into()), version: "1.2.3".into(),
                    models: vec![ModelInfo::default_choice()],
                    metadata: None,
                };
                assert_eq!(serde_json::to_value(probe(provider.id, provider.name)).unwrap(),
                    serde_json::to_value(provider.discover_with(probe)).unwrap());
            }
            let old = catalog(provider.id).unwrap();
            assert!(old.len() > 1, "{} did not parse its recorded catalog", provider.id);
            let actual = provider.models_with(|id| async move {
                assert_eq!(id, provider.id);
                catalog(id)
            }).await.unwrap();
            assert_eq!(old, actual);
            let error = provider.models_with(|id| async move {
                assert_eq!(id, provider.id);
                Err("Discovery failed; retained native error".into())
            }).await.err().unwrap();
            assert_eq!(error, "Discovery failed; retained native error");
        }
        assert!(list_models("not-a-provider").await.is_err());
    }
}
