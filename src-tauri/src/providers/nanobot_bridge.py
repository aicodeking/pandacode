"""
PandaCode ACP Bridge for Nanobot.
Speaks Agent Client Protocol (ACP) v1 over stdio (JSON-RPC 2.0).
Drives HKUDS Nanobot via its Python API.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

# Configure unbuffered utf-8 output for stdout
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Silence debug/info logging from loguru to keep stderr clean
try:
    from loguru import logger
    logger.remove()
    logger.add(sys.stderr, level="WARNING")
except Exception:
    pass

# Enable loopback access for host MCP tools and local endpoints
try:
    from nanobot.security.network import configure_ssrf_whitelist
    configure_ssrf_whitelist(["127.0.0.0/8", "::1/128"])
except Exception:
    pass

try:
    import nanobot.agent.tools.mcp as _mcp

    _orig_validate = _mcp.validate_url_target
    _orig_resolve = _mcp.resolve_url_target

    def _patched_validate(url: str, *, allow_loopback: bool = True) -> tuple[bool, str]:
        return _orig_validate(url, allow_loopback=True)

    def _patched_resolve(
        url: str,
        *,
        allow_loopback: bool = True,
        trust_remote_dns: bool = False,
    ) -> tuple[bool, str, tuple[str, ...]]:
        return _orig_resolve(url, allow_loopback=True, trust_remote_dns=trust_remote_dns)

    _mcp.validate_url_target = _patched_validate
    _mcp.resolve_url_target = _patched_resolve
except Exception:
    pass

sessions: dict[str, dict[str, Any]] = {}
active_tasks: dict[str, asyncio.Task[Any]] = {}


def send_response(req_id: Any, result: Any = None, error: Any = None) -> None:
    frame: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        frame["error"] = error
    else:
        frame["result"] = result if result is not None else {}
    line = json.dumps(frame, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def send_notification(method: str, params: Any) -> None:
    frame = {"jsonrpc": "2.0", "method": method, "params": params}
    line = json.dumps(frame, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def get_available_models() -> list[dict[str, str]]:
    models: list[dict[str, str]] = [
        {"value": "default", "name": "Default (from Nanobot config)"}
    ]
    try:
        from nanobot.config.loader import load_config
        cfg_path = Path("~/.nanobot/config.json").expanduser()
        if cfg_path.exists():
            cfg = load_config(cfg_path)
            # Add configured model presets
            for p_name, p_cfg in getattr(cfg, "model_presets", {}).items():
                val = getattr(p_cfg, "model", p_name) or p_name
                if val and not any(m["value"] == val for m in models):
                    models.append({"value": val, "name": f"{val} ({p_name})"})
            current = getattr(cfg.agents.defaults, "model", None)
            if current and current != "default" and not any(m["value"] == current for m in models):
                models.append({"value": current, "name": current})
            fallback = getattr(cfg.agents.defaults, "fallback_models", []) or []
            for fb in fallback:
                if fb and fb != "default" and not any(m["value"] == fb for m in models):
                    models.append({"value": fb, "name": fb})
    except Exception:
        pass
    return models


async def handle_initialize(req_id: Any, _params: dict[str, Any]) -> None:
    caps = {
        "loadSession": True,
        "promptCapabilities": {
            "image": True,
            "audio": False,
            "embeddedContext": True,
        },
        "mcpCapabilities": {
            "http": True,
            "sse": True,
        },
        "sessionCapabilities": {
            "list": {},
            "resume": {},
            "close": {},
        },
    }
    send_response(req_id, {
        "protocolVersion": 1,
        "serverInfo": {"name": "nanobot", "version": "0.3.5"},
        "agentInfo": {"name": "nanobot", "version": "0.3.5"},
        "agentCapabilities": caps,
        "capabilities": caps,
    })


async def handle_session_new_or_load(req_id: Any, params: dict[str, Any]) -> None:
    session_id = params.get("sessionId") or f"nanobot-{uuid.uuid4().hex[:12]}"
    cwd = params.get("cwd") or os.getcwd()
    mcp_servers = params.get("mcpServers") or []
    models = get_available_models()
    default_model = models[1]["value"] if len(models) > 1 else "default"

    if session_id not in sessions:
        sessions[session_id] = {
            "cwd": cwd,
            "mode": "default",
            "model": None,
            "mcpServers": mcp_servers,
        }
    else:
        if cwd:
            sessions[session_id]["cwd"] = cwd
        if mcp_servers:
            sessions[session_id]["mcpServers"] = mcp_servers

    send_response(req_id, {
        "sessionId": session_id,
        "modes": {
            "currentModeId": sessions[session_id].get("mode", "default"),
            "availableModes": [
                {"id": "default", "name": "Default"},
                {"id": "accept_edits", "name": "Accept Edits"},
                {"id": "dont_ask", "name": "Don't Ask"},
            ],
        },
        "configOptions": [
            {
                "type": "select",
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": default_model,
                "options": models,
            }
        ],
    })


async def handle_set_mode(req_id: Any, params: dict[str, Any]) -> None:
    session_id = params.get("sessionId")
    mode_id = params.get("modeId", "default")
    if session_id and session_id in sessions:
        sessions[session_id]["mode"] = mode_id
    if mode_id == "dont_ask":
        os.environ["NANOBOT_YOLO_MODE"] = "1"
    else:
        os.environ.pop("NANOBOT_YOLO_MODE", None)
    send_response(req_id, {})


async def handle_set_model(req_id: Any, params: dict[str, Any]) -> None:
    session_id = params.get("sessionId")
    model_id = params.get("modelId")
    if session_id and session_id in sessions:
        sessions[session_id]["model"] = None if model_id == "default" else model_id
    send_response(req_id, {})


async def handle_set_config_option(req_id: Any, params: dict[str, Any]) -> None:
    session_id = params.get("sessionId")
    config_id = params.get("configId")
    value = params.get("value")
    if session_id and session_id in sessions and config_id == "model":
        sessions[session_id]["model"] = None if value == "default" else value
    models = get_available_models()
    curr_model = sessions.get(session_id, {}).get("model") or (
        models[1]["value"] if len(models) > 1 else "default"
    )
    send_response(req_id, {
        "configOptions": [
            {
                "type": "select",
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": curr_model,
                "options": models,
            }
        ]
    })


async def handle_prompt(req_id: Any, params: dict[str, Any]) -> None:
    session_id = params.get("sessionId", "default")
    sess = sessions.get(session_id, {})
    cwd = sess.get("cwd", os.getcwd())
    model = sess.get("model")
    mode = sess.get("mode", "default")
    if mode == "dont_ask":
        os.environ["NANOBOT_YOLO_MODE"] = "1"
    else:
        os.environ.pop("NANOBOT_YOLO_MODE", None)
    mcp_servers = sess.get("mcpServers") or []

    prompt_items = params.get("prompt", [])
    message = "".join(
        item.get("text", "") for item in prompt_items if item.get("type") == "text"
    )
    temp_files_to_cleanup: list[str] = []
    media: list[str] = []
    for item in prompt_items:
        if item.get("type") == "image":
            path_val = item.get("path")
            if path_val and os.path.exists(path_val):
                media.append(str(path_val))
            elif item.get("data"):
                try:
                    import base64
                    import tempfile
                    raw_b64 = item["data"]
                    if "," in raw_b64:
                        raw_b64 = raw_b64.split(",", 1)[1]
                    img_bytes = base64.b64decode(raw_b64)
                    mime = item.get("mimeType") or ""
                    suffix = ".png"
                    if "jpeg" in mime or "jpg" in mime:
                        suffix = ".jpg"
                    elif "webp" in mime:
                        suffix = ".webp"
                    elif "gif" in mime:
                        suffix = ".gif"
                    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
                    tmp.write(img_bytes)
                    tmp.close()
                    media.append(tmp.name)
                    temp_files_to_cleanup.append(tmp.name)
                except Exception as b64_err:
                    try:
                        logger.warning("Failed to decode base64 image: {}", b64_err)
                    except Exception:
                        pass

    try:
        try:
            from nanobot import Nanobot
            from nanobot.sdk.types import (
                STREAM_EVENT_TEXT_DELTA,
                STREAM_EVENT_REASONING_DELTA,
                STREAM_EVENT_TOOL_STARTED,
                STREAM_EVENT_TOOL_COMPLETED,
                STREAM_EVENT_RUN_COMPLETED,
                STREAM_EVENT_RUN_FAILED,
            )

            bot = Nanobot.from_config(workspace=cwd, model=model)

            if mcp_servers and hasattr(bot, "_mcp_provider") and bot._mcp_provider is not None:
                try:
                    from nanobot.config.schema import MCPServerConfig
                    for idx, s in enumerate(mcp_servers):
                        if not isinstance(s, dict):
                            continue
                        name = s.get("name") or f"pandacode_mcp_{idx}"
                        url = s.get("url") or s.get("uri")
                        if not url:
                            continue
                        raw_headers = s.get("headers")
                        headers_dict: dict[str, str] = {}
                        if isinstance(raw_headers, list):
                            for h in raw_headers:
                                if isinstance(h, dict) and "name" in h and "value" in h:
                                    headers_dict[str(h["name"])] = str(h["value"])
                        elif isinstance(raw_headers, dict):
                            headers_dict = {str(k): str(v) for k, v in raw_headers.items()}

                        bot._mcp_provider._servers[name] = MCPServerConfig(
                            type="streamableHttp",
                            url=url,
                            headers=headers_dict,
                            enabled_tools=["*"],
                        )
                except Exception as mcp_err:
                    try:
                        logger.warning("Could not register PandaCode MCP servers: {}", mcp_err)
                    except Exception:
                        pass
        except Exception as exc:
            send_response(req_id, error={
                "code": -32603,
                "message": str(exc),
                "data": {"details": str(exc)}
            })
            return

        try:
            run = await bot.run_streamed(
                message,
                session_key=session_id,
                media=media or None,
            )
            delivered_chunks = 0
            async for event in run.stream_events():
                event_type = getattr(event, "type", "")
                if event_type in ("text.delta", STREAM_EVENT_TEXT_DELTA):
                    delta = getattr(event, "delta", "") or getattr(event, "content", "")
                    if delta:
                        delivered_chunks += 1
                        send_notification("session/update", {
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": delta}
                            }
                        })
                elif event_type in ("reasoning.delta", STREAM_EVENT_REASONING_DELTA):
                    delta = getattr(event, "delta", "") or getattr(event, "content", "")
                    if delta:
                        send_notification("session/update", {
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "agent_thought_chunk",
                                "content": {"type": "text", "text": delta}
                            }
                        })
                elif event_type in ("tool.started", STREAM_EVENT_TOOL_STARTED):
                    call_id = getattr(event, "tool_call_id", None) or f"tool-{uuid.uuid4().hex[:8]}"
                    sessions.setdefault(session_id, {})["last_tool_call_id"] = call_id
                    name = getattr(event, "name", None) or "Tool execution"
                    args = getattr(event, "arguments", None) or {}
                    send_notification("session/update", {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": call_id,
                            "title": name,
                            "status": "in_progress",
                            "rawInput": args
                        }
                    })
                elif event_type in ("tool.completed", STREAM_EVENT_TOOL_COMPLETED):
                    fallback_id = sessions.get(session_id, {}).get("last_tool_call_id") or "tool"
                    call_id = getattr(event, "tool_call_id", None) or fallback_id
                    content = getattr(event, "content", "")
                    send_notification("session/update", {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": call_id,
                            "status": "completed",
                            "rawOutput": {"content": content}
                        }
                    })
                elif event_type in ("run.completed", STREAM_EVENT_RUN_COMPLETED):
                    content = getattr(event, "content", "") or ""
                    if delivered_chunks == 0 and content:
                        if (
                            content.startswith("[Assistant reply unavailable")
                            or content.startswith("Error:")
                            or "LLM returned error" in content
                        ):
                            send_response(req_id, error={
                                "code": -32603,
                                "message": str(content),
                                "data": {"details": str(content)}
                            })
                            await bot.aclose()
                            return
                        else:
                            delivered_chunks += 1
                            send_notification("session/update", {
                                "sessionId": session_id,
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": {"type": "text", "text": content}
                                }
                            })
                elif event_type in ("run.failed", STREAM_EVENT_RUN_FAILED):
                    err = getattr(event, "error", "Turn execution failed")
                    send_response(req_id, error={
                        "code": -32603,
                        "message": str(err),
                        "data": {"details": str(err)}
                    })
                    await bot.aclose()
                    return

            await bot.aclose()
            send_response(req_id, {"stopReason": "end_turn"})
        except Exception as exc:
            send_response(req_id, error={
                "code": -32603,
                "message": str(exc),
                "data": {"details": str(exc)}
            })
    finally:
        for p in temp_files_to_cleanup:
            try:
                os.remove(p)
            except OSError:
                pass


async def handle_cancel(params: dict[str, Any]) -> None:
    session_id = params.get("sessionId")
    if session_id and session_id in active_tasks:
        active_tasks[session_id].cancel()


async def process_messages() -> None:
    while True:
        line_str = await asyncio.to_thread(sys.stdin.readline)
        if not line_str:
            break
        line = line_str.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue

        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})

        if method == "initialize":
            await handle_initialize(req_id, params)
        elif method in ("session/new", "session/load", "session/resume"):
            await handle_session_new_or_load(req_id, params)
        elif method == "session/set_mode":
            await handle_set_mode(req_id, params)
        elif method == "session/set_model":
            await handle_set_model(req_id, params)
        elif method == "session/set_config_option":
            await handle_set_config_option(req_id, params)
        elif method == "session/prompt":
            task = asyncio.create_task(handle_prompt(req_id, params))
            session_id = params.get("sessionId", "default")
            active_tasks[session_id] = task
        elif method == "session/cancel":
            await handle_cancel(params)
        elif req_id is not None:
            send_response(req_id, {})


if __name__ == "__main__":
    try:
        asyncio.run(process_messages())
    except (KeyboardInterrupt, SystemExit):
        pass
