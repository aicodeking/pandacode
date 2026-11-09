#!/usr/bin/env python3
"""Offline ACP v1 provider used only by the native fixture harness.

The process speaks newline-delimited JSON-RPC on stdin/stdout. It deliberately
accepts HTTP MCP configuration but never calls a tool or opens a network connection.
It has no filesystem or credential behavior beyond reading requests.
"""
import json
import sys


def reply(request_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": request_id}
    message["error" if error is not None else "result"] = error if error is not None else result
    print(json.dumps(message, separators=(",", ":")), flush=True)


def update(session_id, text):
    print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": session_id,
        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}},
    }}, separators=(",", ":")), flush=True)


def permission(session_id):
    print(json.dumps({"jsonrpc": "2.0", "id": "permission-1", "method": "session/request_permission", "params": {
        "sessionId": session_id,
        "toolCall": {"toolCallId": "fixture-check", "title": "Run fixture check", "kind": "execute"},
        "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}],
    }}, separators=(",", ":")), flush=True)


def main():
    session_id = "fixture-session"
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = request.get("method")
        request_id = request.get("id")
        if method == "initialize":
            reply(request_id, {"protocolVersion": 1, "agentCapabilities": {
                "loadSession": False,
                "promptCapabilities": {"image": True, "audio": False, "embeddedContext": False},
                "mcpCapabilities": {"http": True},
            }, "agentInfo": {"name": "PandaCode offline ACP fixture", "version": "0.1.0"}})
        elif method == "session/new":
            reply(request_id, {"sessionId": session_id, "models": {"availableModels": [
                {"modelId": "fixture-model", "name": "Offline fixture model"}
            ], "currentModelId": "fixture-model"}})
        elif method == "session/prompt":
            prompt = request.get("params", {}).get("prompt", [])
            text = " ".join(item.get("text", "") for item in prompt if isinstance(item, dict))
            if "approval" in text.lower():
                permission(session_id)
                try:
                    decision = json.loads(next(sys.stdin))
                except (StopIteration, json.JSONDecodeError):
                    return
                if decision.get("method") == "session/cancel":
                    if decision.get("id") is not None:
                        reply(decision["id"], {})
                    reply(request_id, {"stopReason": "cancelled"})
                    continue
                if decision.get("id") == "permission-1":
                    outcome = decision.get("result", {}).get("outcome", {})
                    if outcome.get("outcome") != "selected" or outcome.get("optionId") != "allow":
                        reply(request_id, {"stopReason": "cancelled"})
                        continue
            update(session_id, "Fixture received: " + text[:400])
            images = sum(1 for item in prompt if isinstance(item, dict) and item.get("type") == "image")
            if images:
                update(session_id, "\nFixture images: " + str(images))
            reply(request_id, {"stopReason": "end_turn"})
        elif method == "session/cancel":
            if request_id is not None:
                reply(request_id, {})
        elif method in {"session/set_config_option", "session/set_mode", "session/set_model"}:
            reply(request_id, {})
        elif request_id is not None:
            reply(request_id, error={"code": -32601, "message": "Unsupported fixture method"})


if __name__ == "__main__":
    main()
