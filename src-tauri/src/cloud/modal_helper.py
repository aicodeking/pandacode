# PandaCode's bridge to Modal sandboxes (src-tauri/src/cloud/modal.rs). Reads one JSON
# request on stdin, prints one JSON reply on stdout. Credentials arrive only as
# MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (and MODAL_ENVIRONMENT) in this process's environment.
import sys

# Run with `python3 -c`, which puts the current directory first on the path: drop it so a
# stray json.py or modal.py there never loads.
sys.path = [p for p in sys.path if p not in ("", ".")]

import base64
import json
import os
import time

TAG = {"pandacode": "sandbox"}
LIFETIME = 24 * 60 * 60
# PID 1 of every sandbox: runs until the deadline `keep_alive` writes, then exits, which
# ends the sandbox. No deadline file means run until Modal's own timeout.
WATCH = 'while [ "$(date +%s)" -lt "$(cat /tmp/.pandacode-deadline 2>/dev/null || echo 99999999999)" ]; do sleep 20; done'


def app(modal):
    environment = os.environ.get("MODAL_ENVIRONMENT") or None
    return modal.App.lookup("pandacode", create_if_missing=True, environment_name=environment)


def run(request):
    try:
        import modal
    except ImportError:
        return {"error": "missing-modal"}
    op = request["op"]
    if op == "check":
        return {"app": app(modal).app_id}
    if op == "list":
        found = modal.Sandbox.list(app_id=app(modal).app_id, tags=TAG)
        return {"sandboxes": [{"id": sb.object_id, "name": sb.get_tags().get("name", "")} for sb in found]}
    if op == "create":
        image = modal.Image.debian_slim().apt_install("git", "curl", "ca-certificates")
        sb = modal.Sandbox.create("sh", "-c", WATCH, app=app(modal), image=image, timeout=LIFETIME, cpu=2.0, memory=4096)
        # Modal ends the sandbox at its timeout; remember when, so PandaCode knows how long a run may last.
        sb.set_tags(dict(TAG, name=request["name"], expires=str(int(time.time()) + LIFETIME)))
        return {"id": sb.object_id}
    sb = modal.Sandbox.from_id(request["id"])
    if op == "running":
        expires = sb.get_tags().get("expires", "")
        remaining = int(expires) - int(time.time()) if expires.isdigit() else None
        return {"running": sb.poll() is None, "remaining": remaining}
    if op == "terminate":
        sb.terminate()
        return {}
    if op == "exec":
        process = sb.exec("sh", "-c", "exec 2>&1\n" + request["command"], timeout=int(request["timeout"]))
        if "stdin" in request:
            process.stdin.write(base64.b64decode(request["stdin"]))
            process.stdin.write_eof()
            process.stdin.drain()
        output = process.stdout.read()
        process.wait()
        return {"code": process.returncode, "output": output}
    return {"error": "unknown request " + op}


try:
    reply = run(json.load(sys.stdin))
except Exception as error:  # every failure becomes a readable reply
    reply = {"error": "%s: %s" % (type(error).__name__, error)}
print(json.dumps(reply))
