//! Extra stdio MCP servers (Colab's MCP) beside the bridge in each harness's config.
use super::*;

fn colab() -> Vec<Stdio> {
    vec![Stdio::new(COLAB_MCP, "/bin/uvx".into(), vec!["colab-mcp".into()])]
}

#[test]
fn disabled_extra_servers_leave_every_config_untouched() {
    let claude = json!({"mcpServers":{SERVER_NAME:{"type":"http","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer t"}}}});
    let codex = json!({SERVER_NAME:{"url":"http://127.0.0.1:1/mcp","enabled":true,"required":false}});
    assert_eq!(claude_mcp_config(Some(claude.clone()), &[]).unwrap().to_string(), claude.to_string());
    assert_eq!(codex_mcp_servers(Some(codex.clone()), &[]).unwrap().to_string(), codex.to_string());
    assert_eq!(claude_mcp_config(None, &[]), None);
    assert_eq!(codex_mcp_servers(None, &[]), None);
    assert!(acp_mcp_servers(&[]).is_empty());
}

#[test]
fn colab_mcp_joins_claude_and_codex_beside_the_bridge_or_alone() {
    let claude = json!({"mcpServers":{SERVER_NAME:{"type":"http","url":"http://127.0.0.1:1/mcp"}}});
    let merged = claude_mcp_config(Some(claude.clone()), &colab()).unwrap();
    assert_eq!(merged["mcpServers"][SERVER_NAME], claude["mcpServers"][SERVER_NAME]);
    assert_eq!(merged["mcpServers"]["colab-mcp"], json!({"command":"/bin/uvx","args":["colab-mcp"]}));
    assert_eq!(
        claude_mcp_config(None, &colab()).unwrap(),
        json!({"mcpServers":{"colab-mcp":{"command":"/bin/uvx","args":["colab-mcp"]}}})
    );
    let codex_entry = json!({"command":"/bin/uvx","args":["colab-mcp"],"enabled":true,"required":false,"startup_timeout_sec":90,"tool_timeout_sec":300});
    let codex = json!({SERVER_NAME:{"url":"http://127.0.0.1:1/mcp"}});
    let merged = codex_mcp_servers(Some(codex.clone()), &colab()).unwrap();
    assert_eq!(merged[SERVER_NAME], codex[SERVER_NAME]);
    assert_eq!(merged["colab-mcp"], codex_entry);
    assert_eq!(codex_mcp_servers(None, &colab()).unwrap(), json!({"colab-mcp":codex_entry}));
    // Codex applies each one as a dotted override, so the user's servers stay.
    let mut protocol = Protocol::new(crate::providers::tests::config("codex"));
    protocol.codex_mcp_servers = codex_mcp_servers(None, &colab());
    let step = protocol.receive(json!({"id":1,"result":{}})).unwrap();
    let thread = step.write.iter().find(|frame| frame["id"] == 2).expect("thread/start");
    assert_eq!(thread["method"], "thread/start");
    assert_eq!(thread["params"]["config"]["mcp_servers.colab-mcp"], codex_entry);
}

#[test]
fn colab_mcp_reaches_kimi_even_without_http_mcp() {
    let mut protocol = Protocol::new(crate::providers::tests::config("kimi"));
    protocol.mcp_server = Some(json!({"type":"http","name":SERVER_NAME,"url":"http://127.0.0.1:1/mcp","headers":[]}));
    protocol.extra_mcp_servers = acp_mcp_servers(&colab());
    let step = protocol
        .receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}}))
        .unwrap();
    let servers = &step.write[0]["params"]["mcpServers"];
    assert_eq!(servers[0]["name"], SERVER_NAME);
    assert_eq!(servers[1], json!({"name":"colab-mcp","command":"/bin/uvx","args":["colab-mcp"],"env":[]}));
    let mut protocol = Protocol::new(crate::providers::tests::config("kimi"));
    protocol.mcp_server = Some(json!({"type":"http","name":SERVER_NAME}));
    protocol.mcp_required = false;
    protocol.extra_mcp_servers = acp_mcp_servers(&colab());
    let step = protocol
        .receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}))
        .unwrap();
    assert_eq!(step.write[0]["params"]["mcpServers"], json!(acp_mcp_servers(&colab())));
}
