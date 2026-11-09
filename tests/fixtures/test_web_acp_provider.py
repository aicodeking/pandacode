import json
import pathlib
import subprocess
import sys


SCRIPT = pathlib.Path(__file__).with_name("web-acp-provider.py")


def run(requests):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input="".join(json.dumps(item) + "\n" for item in requests),
        text=True,
        capture_output=True,
        check=True,
    )
    return [json.loads(line) for line in proc.stdout.splitlines()]


def test_initialize_and_session_new_are_offline_and_deterministic():
    frames = run([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/fixture", "mcpServers": []}},
    ])
    assert frames[0]["result"]["protocolVersion"] == 1
    assert frames[0]["result"]["agentCapabilities"]["mcpCapabilities"]["http"] is True
    assert frames[1]["result"]["sessionId"] == "fixture-session"
    assert frames[1]["result"]["models"]["availableModels"][0]["modelId"] == "fixture-model"


def test_prompt_streams_update_then_finishes():
    frames = run([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": "fixture-session", "prompt": [{"type": "text", "text": "hello"}]}},
        {"jsonrpc": "2.0", "id": 4, "method": "session/cancel", "params": {"sessionId": "fixture-session"}},
    ])
    assert frames[2]["method"] == "session/update"
    assert frames[2]["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
    assert "hello" in frames[2]["params"]["update"]["content"]["text"]
    assert frames[3]["id"] == 3 and frames[3]["result"]["stopReason"] == "end_turn"
    assert frames[4]["id"] == 4 and frames[4]["result"] == {}


def test_prompt_can_pause_for_and_accept_a_permission_request():
    frames = run([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": "fixture-session", "prompt": [{"type": "text", "text": "approval please"}]}},
        {"jsonrpc": "2.0", "id": "permission-1", "result": {"outcome": {"optionId": "allow", "outcome": "selected"}}},
    ])
    assert frames[2]["method"] == "session/request_permission"
    assert frames[2]["params"]["options"][0]["optionId"] == "allow"
    assert frames[3]["method"] == "session/update"
    assert frames[4]["id"] == 3 and frames[4]["result"]["stopReason"] == "end_turn"


def test_cancel_notification_while_waiting_does_not_emit_text_or_null_id():
    frames = run([
        {"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": "approval please"}]}},
        {"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture-session"}},
    ])
    assert len(frames) == 2
    assert frames[0]["method"] == "session/request_permission"
    assert frames[1] == {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "cancelled"}}
