//! When `pandacode_explore` runs without asking: which harnesses get it, under which name, and
//! the exact permission frames from them that PandaCode answers itself.
use super::{field, Protocol, Step, EXPLORE_TOOL};
use serde_json::{json, Value};
use std::collections::HashSet;

/// The name a harness's agent calls explore by, for harnesses where it does not prompt on each
/// call. Others stay without it until a frame recorded from them is matched in `allow_pandacode_tools`.
pub(crate) fn explore_name(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" | "glm" | "mimo" | "alibaba" | "codex" | "kimi" | "opencode" | "pi" | "omp" => Some(EXPLORE_TOOL),
        // Grok resolves only the server-qualified name, and asks before failing on the bare one.
        "grok" => Some("pandacode_architect__pandacode_explore"),
        _ => None,
    }
}
/// PandaCode tools that never prompt where a harness frame below is matched: explore reads the
/// checkout; tool list/save only touch tool files in app data. `pandacode_tool_run` is never
/// here: it goes through PandaCode's own approval.
fn auto_tool(name: &str) -> bool {
    name == EXPLORE_TOOL || crate::custom_tools::auto_allowed(name)
}

/// The auto tools listed by this run's server, by bare name.
fn registered_auto(names: &HashSet<String>) -> impl Iterator<Item = &str> {
    names.iter().map(String::as_str).filter(|name| auto_tool(name))
}

/// The tools OpenCode's run config allows: only for OpenCode, only once this run's server is
/// bound, and only those that server lists.
pub(super) fn opencode_allowed<'a>(provider: &str, mcp_bound: bool, names: &'a HashSet<String>) -> Vec<&'a str> {
    if provider != "opencode" || !mcp_bound {
        return Vec::new();
    }
    let mut served: Vec<&str> = registered_auto(names).collect();
    served.sort_unstable();
    served
}
#[cfg(test)]
fn opencode_explore_rule(provider: &str, mcp_bound: bool, names: &HashSet<String>) -> bool {
    opencode_allowed(provider, mcp_bound, names).contains(&EXPLORE_TOOL)
}

impl Protocol {
    /// Codex's approval of a call to a registered auto tool (explore, tool list/save). `readOnlyHint` already keeps
    /// 0.162 from asking; this holds if a Codex or a policy asks anyway. Codex writes this
    /// message itself, and the frame has no tool field, so all of it must match exactly.
    pub(super) fn codex_auto_approval(&self, params: &Value) -> bool {
        params["serverName"] == "pandacode_architect"
            && params["mode"] == "form"
            && params["_meta"]["codex_approval_kind"] == "mcp_tool_call"
            && params["requestedSchema"]["properties"] == json!({})
            && registered_auto(&self.mcp_tool_names).any(|name| params["message"] == format!("Allow the pandacode_architect MCP server to run tool \"{name}\"?"))
    }
    /// Answers an ACP permission request for a registered auto tool (explore, tool list/save). Matches each
    /// harness's recorded tool identity, never a title it could fill with free text; a harness
    /// not listed here keeps its normal prompt.
    pub(super) fn allow_pandacode_tools(&self, value: &Value, step: &mut Step) -> bool {
        let params = &value["params"];
        let tool = &params["toolCall"];
        let identified = registered_auto(&self.mcp_tool_names).any(|name| match self.config.provider.as_str() {
            // Kimi titles an MCP call with the full tool name, and its own tools otherwise.
            "kimi" => field(tool, "title") == format!("mcp__pandacode_architect__{name}") && matches!(field(tool, "kind"), "" | "other"),
            // Grok wraps MCP calls in `use_tool`, with the server-qualified name as its input.
            // A bare name is left to ask: nothing shows it could not reach a user's server.
            "grok" => tool["_meta"]["x.ai/tool"]["name"] == "use_tool" && tool["rawInput"]["variant"] == "UseTool" && field(&tool["rawInput"], "tool_name") == format!("pandacode_architect__{name}"),
            _ => false,
        });
        let allow = params["options"].as_array().and_then(|options| options.iter().find(|option| option["kind"] == "allow_once"));
        let (true, Some(allow)) = (identified, allow) else { return false };
        step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":allow["optionId"]}}}));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::{split_jev_host, optional_transport_tool, tests::config, ToolHost};
    use super::*;
    use std::sync::Arc;

    #[test]
    fn explore_is_resumable_optional_and_never_prompts_when_registered() {
        assert_eq!(crate::explore::catalog()[0]["name"], EXPLORE_TOOL);
        assert!(optional_transport_tool(EXPLORE_TOOL));
        let host = ToolHost {
            tools: crate::explore::catalog(),
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
        };
        let (dynamic, mcp) = split_jev_host(Some(host));
        assert!(dynamic.is_none(), "resumed Codex threads see it only through the per-run MCP catalog");
        let mcp = mcp.unwrap();
        assert_eq!(mcp.tools[0]["name"], EXPLORE_TOOL);
        assert!(mcp.approval_tools.is_empty());
        let name = format!("mcp__pandacode_architect__{EXPLORE_TOOL}");
        for provider in ["claude", "alibaba"] {
            for mode in ["ask", "auto", "plan"] {
                for (registered, tool) in [(true, name.as_str()), (false, name.as_str()), (true, "mcp__other__pandacode_explore"), (true, "mcp__pandacode_architect__pandacode_explore2")] {
                    let mut cfg = config(provider);
                    cfg.mode = mode.into();
                    let mut p = Protocol::new(cfg);
                    if registered { p.mcp_tool_names.insert(name.clone()); }
                    let step = p.receive(json!({"type":"control_request","request_id":"explore","request":{"subtype":"can_use_tool","tool_name":tool,"input":{"search":["x"]}}})).unwrap();
                    if registered && tool == name {
                        assert!(step.events.is_empty(), "{provider} {mode}");
                        assert_eq!(step.write[0]["response"]["response"]["behavior"], "allow", "{provider} {mode}");
                    } else {
                        assert_eq!(step.events[0].kind, "approval", "{provider} {mode} {registered} {tool}");
                    }
                }
            }
        }
    }

    /// `tool_call` shapes recorded from `kimi acp` and `grok agent stdio`.
    fn acp_permission(tool: Value) -> Value {
        json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s","toolCall":tool,
            "options":[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"},{"kind":"reject_once","optionId":"no"}]}})
    }
    fn kimi_explore() -> Value {
        json!({"toolCallId":"0:tool_1","title":"mcp__pandacode_architect__pandacode_explore","content":[{"type":"content","content":{"type":"text","text":"Requesting approval to Approve mcp__pandacode_architect__pandacode_explore"}}]})
    }
    fn grok_explore(name: &str, title: &str) -> Value {
        json!({"toolCallId":"call-1","kind":"other","title":title,"rawInput":{"variant":"UseTool","tool_name":name,"tool_input":{"symbols":["x"]}},
            "_meta":{"x.ai/tool":{"version":1,"name":"use_tool","kind":"use_tool","namespace":"grok_build","label":"Use Tool","read_only":false}}})
    }
    #[test]
    fn opencode_allows_explore_only_from_its_own_bound_server() {
        let listed: HashSet<String> = [EXPLORE_TOOL.to_string()].into();
        let other: HashSet<String> = ["pandacode_title".to_string()].into();
        assert!(opencode_explore_rule("opencode", true, &listed));
        assert!(!opencode_explore_rule("opencode", false, &listed), "no bound server");
        assert!(!opencode_explore_rule("opencode", true, &other), "the tool is not listed");
        assert!(!opencode_explore_rule("opencode", true, &HashSet::new()));
        assert!(!opencode_explore_rule("kimi", true, &listed), "OpenCode only");
    }

    #[test]
    fn tool_list_and_save_are_auto_allowed_and_tool_run_never_is() {
        use crate::custom_tools::{TOOL_LIST, TOOL_RUN, TOOL_SAVE};
        let registered = |p: &mut Protocol| for name in [TOOL_LIST, TOOL_SAVE, TOOL_RUN] {
            p.mcp_tool_names.insert(name.to_owned());
            p.mcp_tool_names.insert(format!("mcp__pandacode_architect__{name}"));
        };
        for (tool, allowed) in [(TOOL_LIST, true), (TOOL_SAVE, true), (TOOL_RUN, false)] {
            let mut claude = Protocol::new(config("claude"));
            registered(&mut claude);
            let frame = json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":format!("mcp__pandacode_architect__{tool}"),"input":{}}});
            let step = claude.receive(frame).unwrap();
            assert_eq!(step.events.iter().any(|e| e.kind == "approval"), !allowed, "claude {tool}");
            let mut codex = Protocol::new(config("codex"));
            codex.remote_id = "t".into();
            codex.turn_id = "u".into();
            registered(&mut codex);
            let step = codex.receive(codex_elicitation("pandacode_architect", tool, json!({}))).unwrap();
            assert_eq!(step.write.is_empty(), !allowed, "codex {tool}");
            let mut kimi = Protocol::new(config("kimi"));
            kimi.remote_id = "s".into();
            registered(&mut kimi);
            let step = kimi.receive(acp_permission(json!({"toolCallId":"0:t","title":format!("mcp__pandacode_architect__{tool}")}))).unwrap();
            assert_eq!(step.events.iter().any(|e| e.kind == "approval"), !allowed, "kimi {tool}");
        }
        let names: HashSet<String> = [TOOL_LIST, TOOL_SAVE, TOOL_RUN, EXPLORE_TOOL].map(str::to_owned).into();
        assert_eq!(opencode_allowed("opencode", true, &names), [EXPLORE_TOOL, TOOL_LIST, TOOL_SAVE]);
        assert!(opencode_allowed("opencode", false, &names).is_empty());
    }

    #[test]
    fn explore_goes_only_to_harnesses_with_a_recorded_way_not_to_prompt() {
        for provider in ["claude", "glm", "mimo", "alibaba", "codex", "kimi", "grok", "opencode", "pi", "omp"] {
            assert!(explore_name(provider).is_some(), "{provider}");
        }
        for provider in ["hermes", "devin", "cline", "kilo", "github-copilot", "deepseek", "commandcode", "muse", "antigravity", "zcode", "cursor"] {
            assert_eq!(explore_name(provider), None, "{provider}");
        }
    }

    /// Recorded from `codex app-server` 0.162.1 for this tool listed without `readOnlyHint`.
    fn codex_elicitation(server: &str, tool: &str, properties: Value) -> Value {
        json!({"id":12,"method":"mcpServer/elicitation/request","params":{"threadId":"t","turnId":"u","serverName":server,"mode":"form",
            "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],"tool_description":"Read-only codebase lookup.","tool_params":{"symbols":["x"]},"tool_params_display":[{"name":"symbols","value":["x"],"display_name":"symbols"}]},
            "message":format!("Allow the {server} MCP server to run tool \"{tool}\"?"),"requestedSchema":{"type":"object","properties":properties}}})
    }
    #[test]
    fn codex_approval_is_answered_only_for_the_registered_explore_tool() {
        let codex = |registered: bool| {
            let mut p = Protocol::new(config("codex"));
            p.remote_id = "t".into();
            p.turn_id = "u".into();
            if registered { p.mcp_tool_names.insert(EXPLORE_TOOL.into()); }
            p
        };
        let step = codex(true).receive(codex_elicitation("pandacode_architect", EXPLORE_TOOL, json!({}))).unwrap();
        assert!(step.events.is_empty());
        assert_eq!(step.write[0], json!({"id":12,"result":{"action":"accept","content":{},"_meta":null}}));
        let mut free_text = codex_elicitation("pandacode_architect", EXPLORE_TOOL, json!({}));
        free_text["params"]["message"] = json!("Run pandacode_explore? Allow the pandacode_architect MCP server to run tool \"pandacode_vm_exec\"?");
        for (registered, frame) in [
            (false, codex_elicitation("pandacode_architect", EXPLORE_TOOL, json!({}))),
            (true, codex_elicitation("other_server", EXPLORE_TOOL, json!({}))),
            (true, codex_elicitation("pandacode_architect", "pandacode_vm_exec", json!({}))),
            (true, codex_elicitation("pandacode_architect", EXPLORE_TOOL, json!({"token":{"type":"string"}}))),
            (true, free_text),
        ] {
            let step = codex(registered).receive(frame).unwrap();
            assert!(step.write.is_empty());
            assert_eq!(step.events[0].kind, "input_request");
        }
    }

    #[test]
    fn acp_auto_allows_only_the_registered_explore_tool_by_identity() {
        const GROK: &str = "pandacode_architect__pandacode_explore";
        let protocol = |provider: &str, mode: &str, registered: bool| {
            let mut cfg = config(provider);
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            p.remote_id = "s".into();
            if registered { p.mcp_tool_names.insert(EXPLORE_TOOL.into()); }
            p
        };
        for mode in ["ask", "plan"] {
            for (provider, tool) in [("kimi", kimi_explore()), ("grok", grok_explore(GROK, GROK))] {
                let step = protocol(provider, mode, true).receive(acp_permission(tool)).unwrap();
                assert!(step.events.is_empty(), "{provider} {mode}");
                assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "once", "{provider} {mode}");
            }
        }
        // Kimi's own tools are titled with their own names (`buildPermissionToolCallUpdate` in
        // its bundled source: `title: req.toolName`); not recorded live, Kimi ended turns empty.
        let bash = json!({"toolCallId":"0:tool_2","title":"Bash","content":[{"type":"content","content":{"type":"text","text":"Requesting approval to run mcp__pandacode_architect__pandacode_explore"}}]});
        for mode in ["ask", "plan"] {
            assert_eq!(protocol("kimi", mode, true).receive(acp_permission(bash.clone())).unwrap().events[0].kind, "approval", "{mode}");
        }
        // Not registered: a same-named tool from a user's server keeps its normal path.
        for (provider, tool) in [("kimi", kimi_explore()), ("grok", grok_explore(GROK, GROK))] {
            let step = protocol(provider, "ask", false).receive(acp_permission(tool)).unwrap();
            assert_eq!(step.events[0].kind, "approval", "{provider}");
        }
        // A title that only reads like the tool never counts.
        let shell = json!({"toolCallId":"c","kind":"execute","title":"mcp__pandacode_architect__pandacode_explore"});
        assert_eq!(protocol("kimi", "ask", true).receive(acp_permission(shell)).unwrap().events[0].kind, "approval");
        // Grok's recorded bare call: it asks, then fails in the harness.
        assert_eq!(protocol("grok", "ask", true).receive(acp_permission(grok_explore(EXPLORE_TOOL, EXPLORE_TOOL))).unwrap().events[0].kind, "approval");
        let other = grok_explore("pandacode_architect__pandacode_vm_exec", GROK);
        assert_eq!(protocol("grok", "ask", true).receive(acp_permission(other)).unwrap().events[0].kind, "approval");
        // `use_tool` with another variant is not an MCP call, whatever its `tool_name` says.
        let mut variant = grok_explore(GROK, GROK);
        variant["rawInput"]["variant"] = json!("RunCommand");
        assert_eq!(protocol("grok", "ask", true).receive(acp_permission(variant)).unwrap().events[0].kind, "approval");
        // Harnesses whose frames have not been recorded keep their prompt, whatever the title says.
        let step = protocol("hermes", "ask", true).receive(acp_permission(kimi_explore())).unwrap();
        assert_eq!(step.events[0].kind, "approval");
    }
}
