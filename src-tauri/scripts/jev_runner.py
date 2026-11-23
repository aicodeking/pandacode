"""PandaCode's isolated, bounded adapter for the pinned Jev runtime.

The application embeds this small standard-library entry point; Python, Chrome,
and Jev are installed separately. stdout is a JSONL protocol, never a debug log.
Origin checks constrain agent interactions, not the browser's network requests.
"""

import base64
import contextlib
import hashlib
import importlib
import importlib.metadata
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit

COMMIT = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46"
REPOSITORY = "https://github.com/browser-use/jev-ultrafast"
MAX_REQUEST = 65536
MAX_SCREENSHOT = 8 * 1024 * 1024
MAX_LIVE_FRAME = 256 * 1024
OPERATIONS = {"CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"}
FIELDS = {
    "runId", "url", "goal", "maxSteps", "timeoutSeconds", "viewport", "expectedText",
    "expectedTitle", "expectedUrl", "chromePath", "typesafeKey", "textKey",
    "textModel", "textBaseUrl", "outputDir", "browserDir", "decisionBaseUrl",
}


class InvalidRequest(ValueError):
    pass


class OriginBoundary(RuntimeError):
    pass


class Cancelled(BaseException):
    pass


class Deadline(BaseException):
    pass


def http_url(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 33 for c in value):
        raise InvalidRequest("Use an HTTP or HTTPS URL without credentials.")
    try:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError()
        _ = parts.port
        if "\\" in value:
            raise ValueError()
    except ValueError:
        raise InvalidRequest("Use an HTTP or HTTPS URL without credentials.") from None
    return parts


def origin(value):
    parts = http_url(value)
    return parts.scheme, parts.hostname.lower(), parts.port or (443 if parts.scheme == "https" else 80)


def public_url(value):
    try:
        parts = http_url(value)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))[:1024]
    except InvalidRequest:
        return ""


def text_field(request, key, maximum, required=False):
    value = request.get(key, "")
    if value is None and not required:
        return ""
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value or (required and not value.strip()):
        raise InvalidRequest("Invalid browser test configuration.")
    return value.strip()


def validate_request(request):
    if not isinstance(request, dict) or set(request) - FIELDS:
        raise InvalidRequest("Invalid browser test configuration.")
    result = dict(request)
    for key, maximum, required in (
        ("runId", 64, True), ("url", 4096, True), ("goal", 8192, True),
        ("typesafeKey", 4096, False), ("textKey", 4096, False),
        ("textModel", 200, True), ("textBaseUrl", 2048, True),
        ("chromePath", 4096, False), ("outputDir", 4096, True), ("browserDir", 4096, False),
        ("expectedText", 2000, False), ("expectedTitle", 500, False), ("expectedUrl", 4096, False),
        ("decisionBaseUrl", 2048, False),
    ):
        result[key] = text_field(request, key, maximum, required)
    if not result["decisionBaseUrl"] and not result["typesafeKey"]:
        raise InvalidRequest("Invalid browser test configuration.")
    if result["decisionBaseUrl"]:
        parts = http_url(result["decisionBaseUrl"])
        # Matches the native loopback rule: localhost, ::1, and 127.0.0.0/8 only. Parsed as
        # an address so lookalike domains ("127.0.0.1.evil.com") cannot pass.
        try:
            local = parts.hostname == "localhost" or ipaddress.ip_address(parts.hostname).is_loopback
        except ValueError:
            local = False
        if not local or parts.query or parts.fragment:
            raise InvalidRequest("The local decision server must use a loopback HTTP address.")
        result["decisionBaseUrl"] = result["decisionBaseUrl"].rstrip("/")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", result["runId"]):
        raise InvalidRequest("Invalid browser test identifier.")
    for key, minimum, maximum in (("maxSteps", 1, 60), ("timeoutSeconds", 30, 600)):
        value = request.get(key)
        if type(value) is not int or not minimum <= value <= maximum:
            raise InvalidRequest("Invalid browser test limits.")
    if request.get("viewport") not in {"desktop", "mobile"}:
        raise InvalidRequest("Choose a desktop or mobile viewport.")
    http_url(result["url"])
    base = http_url(result["textBaseUrl"])
    if base.scheme != "https" or base.query or base.fragment:
        raise InvalidRequest("The text provider must use an HTTPS API base URL.")
    if result["expectedUrl"]:
        http_url(result["expectedUrl"])
        if origin(result["expectedUrl"]) != origin(result["url"]):
            raise InvalidRequest("The expected URL must belong to the test's starting origin.")
    output = Path(result["outputDir"])
    if not output.is_absolute() or output.is_symlink() or not output.is_dir():
        raise InvalidRequest("The private browser test output folder is unavailable.")
    if result["browserDir"]:
        browser_dir = Path(result["browserDir"])
        if not browser_dir.is_absolute() or browser_dir.is_symlink() or not browser_dir.is_dir():
            raise InvalidRequest("The private browser runtime folder is unavailable.")
    return result


def read_request(stream, optional=False):
    raw = stream.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise InvalidRequest("Browser test configuration exceeds the size limit.")
    if not raw.strip() and optional:
        return {}
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise InvalidRequest("Invalid browser test configuration.") from None


def find_chrome(custom=""):
    candidates = []
    if custom:
        candidates = [custom]
    elif sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    elif sys.platform == "win32":
        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            if os.environ.get(env):
                candidates += [str(Path(os.environ[env]) / tail) for tail in (
                    "Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe",
                )]
    else:
        candidates = [shutil.which(name) for name in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
    for candidate in candidates:
        if candidate and "\x00" not in candidate:
            candidate_path = Path(candidate).expanduser()
            if candidate_path.is_absolute() and candidate_path.is_file() and (sys.platform == "win32" or os.access(candidate_path, os.X_OK)):
                # Snap Chrome cannot access our private /tmp DevToolsActivePort reliably.
                if sys.platform.startswith("linux") and "/snap/" in str(candidate_path.resolve()):
                    continue
                return str(candidate_path)
    return ""


def pinned_distribution(distribution):
    try:
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        url = direct.get("url", "").rstrip("/")
        if url in {f"{REPOSITORY}/archive/{COMMIT}.zip", f"{REPOSITORY}/archive/{COMMIT}.tar.gz"}:
            return True
        return url in {REPOSITORY, REPOSITORY + ".git"} and direct.get("vcs_info", {}).get("commit_id") == COMMIT
    except (ValueError, AttributeError, TypeError):
        return False


def doctor(custom_chrome=""):
    issues, version = [], ""
    if sys.version_info < (3, 12):
        issues.append("Python 3.12 or later is required.")
    try:
        distribution = importlib.metadata.distribution("jev-ultrafast")
        version = distribution.version
        if version != "0.1.0" or not pinned_distribution(distribution):
            issues.append("Install PandaCode's pinned Jev runtime using Setup runtime.")
    except importlib.metadata.PackageNotFoundError:
        issues.append("Jev is not installed in this Python environment.")
    try:
        if importlib.metadata.version("browser-harness") != "0.1.13":
            issues.append("Browser Harness 0.1.13 is required by this integration.")
    except importlib.metadata.PackageNotFoundError:
        issues.append("Browser Harness is not installed in this Python environment.")
    chrome = find_chrome(custom_chrome)
    if not chrome:
        issues.append("Install Chrome or Chromium, or choose its executable. Snap Chromium is unsupported.")
    if sys.platform not in {"darwin", "win32"} and not sys.platform.startswith("linux"):
        issues.append("This operating system is not supported by the browser adapter.")
    return {"type": "doctor", "ready": not issues, "pythonVersion": ".".join(map(str, sys.version_info[:3])),
            "jevVersion": version, "chromePath": chrome, "issues": issues}


class Output:
    def __init__(self, stream, secrets=()):
        self.stream = stream
        self.secrets = {value for value in secrets if isinstance(value, str) and value}
        self.lock = threading.RLock()

    def redact(self, value):
        with self.lock:
            if isinstance(value, str) and value:
                self.secrets.add(value)

    def clean(self, value):
        if isinstance(value, str):
            for secret in sorted(self.secrets, key=len, reverse=True):
                value = value.replace(secret, "[redacted]")
            return "".join(c for c in value if ord(c) >= 32 or c in "\n\t")
        if isinstance(value, dict):
            return {key: self.clean(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.clean(item) for item in value]
        return value

    def emit(self, event):
        with self.lock:
            self.stream.write(json.dumps(self.clean(event), separators=(",", ":"), ensure_ascii=True) + "\n")
            self.stream.flush()


class LivePreview:
    """Read-only frames from the owned browser, only during a short UI lease.

    A separate thread keeps the preview moving during synchronous model calls.
    It never touches the agent's observations, state, or action history. The
    private transport directory and its one replaceable frame are ephemeral.
    """
    def __init__(self, browser, request, output, started):
        self.browser, self.request, self.output, self.started = browser, request, output, started
        self.directory = Path(request["browserDir"]) if request.get("browserDir") else None
        self.stopped = threading.Event()
        self.thread = None
        self.sequence = 0
        self.previous_digest = None
        self.was_watched = False
        self.watch_generation = self.previous_generation = None

    def watched(self):
        if self.directory is None or self.stopped.is_set():
            return False
        try:
            marker = self.directory / "live-watch.json"
            if marker.is_symlink() or marker.stat().st_size > 256:
                return False
            value = json.loads(marker.read_text())
            remaining = value.get("expiresAt", 0) - time.time() * 1000
            generation = value.get("generation", 0)
            if type(generation) is not int or generation < 0:
                return False
            self.watch_generation = generation
            return value.get("runId") == self.request["runId"] and 0 < remaining <= 12000
        except (OSError, ValueError, TypeError, AttributeError):
            return False

    def same_origin(self):
        response = self.browser.call("Runtime.evaluate", expression="location.href", returnByValue=True,
                                     _response_timeout=0.8)
        if response.get("exceptionDetails"):
            return False
        return origin(response.get("result", {}).get("value")) == origin(self.request["url"])

    def sample(self):
        watched = self.watched()
        if not watched:
            self.was_watched = False
            return
        # Always send one fresh image when the user returns to an unchanged page.
        if not self.was_watched or self.watch_generation != self.previous_generation:
            self.previous_digest = None
        self.was_watched = True
        self.previous_generation = self.watch_generation
        temporary = self.directory / "live-frame.tmp"
        try:
            if not self.same_origin():
                return
            mobile = self.request["viewport"] == "mobile"
            width, height, scale = (390, 844, 1) if mobile else (1440, 900, 2 / 3)
            response = self.browser.call("Page.captureScreenshot", format="jpeg", quality=45,
                                         clip={"x": 0, "y": 0, "width": width, "height": height, "scale": scale},
                                         captureBeyondViewport=False, _response_timeout=0.8)
            encoded = response.get("data")
            if not isinstance(encoded, str) or len(encoded) > MAX_LIVE_FRAME * 4 // 3 + 4:
                return
            image = base64.b64decode(encoded, validate=True)
            if len(image) > MAX_LIVE_FRAME or not image.startswith(b"\xff\xd8\xff"):
                return
            digest = hashlib.sha256(image).hexdigest()
            if digest == self.previous_digest or not self.same_origin() or not self.watched():
                return
            # Replace the image atomically. Native verifies the matching digest,
            # so a delayed notice cannot display a different/newer frame.
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
                file.write(image)
            os.replace(temporary, self.directory / "live-frame.jpg")
            if self.stopped.is_set():
                return
            self.sequence += 1
            self.output.emit({"type": "frame", "sequence": self.sequence, "sha256": digest,
                              "width": round(width * scale), "height": round(height * scale),
                              "elapsedMs": max(0, int((time.monotonic() - self.started) * 1000))})
            self.previous_digest = digest
        except Exception:
            # Navigations/slow frames must never affect test actions or results.
            pass
        finally:
            with contextlib.suppress(OSError):
                temporary.unlink()

    def start(self):
        if self.directory is not None:
            self.thread = threading.Thread(target=self.loop, name="pandacode-jev-preview", daemon=True)
            self.thread.start()

    def loop(self):
        while not self.stopped.is_set():
            started = time.monotonic()
            self.sample()
            self.stopped.wait(max(0.01, 0.5 - (time.monotonic() - started)))

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=1)
        if self.directory:
            for name in ("live-watch.json", "live-frame.jpg", "live-frame.tmp"):
                with contextlib.suppress(OSError):
                    (self.directory / name).unlink()


def safe_environment():
    # Do not pass provider credentials, cloud browser settings, or Python hooks
    # inherited from an agent's shell to Chrome or Browser Harness.
    allowed = {
        "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "COMSPEC",
        "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "PROGRAMFILES", "PROGRAMFILES(X86)",
        "LOCALAPPDATA",
    }
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    if sys.platform == "win32":
        # Only the process object we launched, while it is still alive; never a
        # stale PID file or a discovered user's Chrome process.
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        process.terminate()
        process.wait(timeout=2)
    if process.poll() is None:
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            process.kill()
            process.wait(timeout=1)


class Runtime:
    def __init__(self, request, chrome_path):
        self.request, self.chrome_path = request, chrome_path
        self.chrome = self.daemon = self.agent = self.temporary = None
        self.browser_module = self.original_operation = None
        self.model_module = self.original_post = None

    def start(self):
        # Short path keeps macOS AF_UNIX endpoints below sun_path's 104 bytes.
        # Native runs own this short parent and can remove it after a hard kill.
        parent = self.request.get("browserDir") or ("/tmp" if os.name != "nt" else None)
        self.temporary = tempfile.TemporaryDirectory(prefix="bj-", dir=parent)
        root = Path(self.temporary.name)
        if os.name != "nt":
            root.chmod(0o700)
        profile = root / "chrome"
        profile.mkdir(mode=0o700)
        environment = safe_environment()
        self.chrome = subprocess.Popen([
            self.chrome_path, f"--user-data-dir={profile}", "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1", "--headless=new", "--no-first-run",
            "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
            "--disable-sync", "--disable-extensions", "--disable-features=Translate,MediaRouter",
            "--password-store=basic", "--use-mock-keychain", "about:blank",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        active_port = profile / "DevToolsActivePort"
        deadline = time.monotonic() + 15
        websocket = ""
        while time.monotonic() < deadline:
            if self.chrome.poll() is not None:
                raise RuntimeError("chrome_start")
            try:
                lines = active_port.read_text().splitlines()
                port = int(lines[0])
                if not 1 <= port <= 65535 or not re.fullmatch(r"/devtools/browser/[A-Za-z0-9_-]+", lines[1]):
                    raise ValueError()
                websocket = f"ws://127.0.0.1:{port}{lines[1]}"
                break
            except (OSError, ValueError, IndexError):
                time.sleep(0.05)
        if not websocket:
            raise RuntimeError("chrome_start")
        isolated = {
            "BU_CDP_WS": websocket, "BU_CDP_URL": "", "BU_BROWSER_ID": "", "BU_API_KEY": "",
            "BU_NAME": "pandacode-" + self.request["runId"][:40], "BH_NAME": "pandacode",
            "BH_HOME": str(root / "home"), "BH_RUNTIME_DIR": str(root / "ipc"),
            "BH_CONFIG_DIR": str(root / "config"), "BH_TMP_DIR": str(root / "tmp"),
            "BH_AGENT_WORKSPACE": str(root / "workspace"), "BH_RUNTIME_DIR_SHARED": "0",
            "BH_TELEMETRY": "0", "BROWSER_HARNESS_TELEMETRY": "0", "ANONYMIZED_TELEMETRY": "false",
            "BH_RECORD": "0", "BH_DOMAIN_SKILLS": "0",
        }
        # Set names/paths before importing modules with environment-derived globals.
        os.environ.clear()
        os.environ.update(environment | isolated)
        self.daemon = subprocess.Popen([sys.executable, "-I", "-m", "browser_harness.daemon"],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, env=environment | isolated)
        admin = importlib.import_module("browser_harness.admin")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.daemon.poll() is not None:
                raise RuntimeError("harness_start")
            if admin.daemon_alive():
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("harness_start")
        os.environ.update({
            "TYPESAFE_API_KEY": "local" if self.request["decisionBaseUrl"] else self.request["typesafeKey"],
            "TEXT_MODEL_API_KEY": self.request["textKey"],
            "TEXT_MODEL": self.request["textModel"], "TEXT_MODEL_BASE_URL": self.request["textBaseUrl"],
            "TEXT_MODEL_REASONING": "none",
        })
        if self.request["decisionBaseUrl"]:
            # Local decisions: redirect the pinned agent's TypeSafe decision calls to the
            # user's loopback server. Upstream's own tests treat post_json as the seam;
            # everything else (the text helper) keeps its original destination.
            self.model_module = importlib.import_module("jev_ultrafast.model")
            self.original_post = self.model_module.post_json
            base = self.request["decisionBaseUrl"]
            def local_decisions(url, key, body):
                if isinstance(url, str) and urlsplit(url).hostname == "api.typesafe.ai":
                    url = base + "/v1/systemone"
                return self.original_post(url, key, body)
            self.model_module.post_json = local_decisions
        self.browser_module = importlib.import_module("jev_ultrafast.browser")
        # Never let upstream self-heal into a replacement daemon we do not own.
        def owned_daemon_only(*_args, **_kwargs):
            if self.daemon.poll() is not None or not admin.daemon_alive():
                raise RuntimeError("harness_start")
        self.browser_module.ensure_daemon = owned_daemon_only
        agent_module = importlib.import_module("jev_ultrafast.agent")
        self.agent = agent_module.Agent(self.request["url"], self.request["goal"], screenshots=False)
        browser = self.agent.browser
        check_origin(browser, self.request["url"])
        mobile = self.request["viewport"] == "mobile"
        width, height = (390, 844) if mobile else (1440, 900)
        browser.call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=mobile)
        if mobile:
            browser.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=1)
        # The pinned executor uses a fixed x=550 for scrolling. Keep its checked
        # action pipeline, but use coordinates inside the actual mobile viewport.
        self.original_operation = self.browser_module.browser_operation
        def operation(request):
            if request.get("operation") == "act" and request.get("action", {}).get("kind") == "scroll":
                action = request["action"]
                browser.call("Input.dispatchMouseEvent", type="mouseWheel", x=width // 2, y=height // 2,
                             deltaX=0, deltaY=action["delta"])
                return {"executed": action["id"]}
            return self.original_operation(request)
        self.browser_module.browser_operation = operation
        install_origin_guards(browser, self.request["url"])
        self.agent.state["page"] = browser.observe(screenshot=False)
        return self.agent

    def close(self):
        # No calls into potentially hung upstream cleanup; closing the browser
        # process also closes every owned target and its transient profile.
        stop_process(self.daemon)
        stop_process(self.chrome)
        if self.model_module and self.original_post:
            self.model_module.post_json = self.original_post
        if self.browser_module and self.original_operation:
            self.browser_module.browser_operation = self.original_operation
        if self.temporary:
            with contextlib.suppress(OSError):
                self.temporary.cleanup()


def check_origin(browser, start_url):
    try:
        if origin(browser.evaluate("location.href")) != origin(start_url):
            raise OriginBoundary()
    except InvalidRequest:
        raise OriginBoundary() from None


def install_origin_guards(browser, start_url):
    observe, act = browser.observe, browser.act
    def guarded_observe(*args, **kwargs):
        check_origin(browser, start_url)
        page = observe(*args, **kwargs)
        if origin(page.get("url", "")) != origin(start_url):
            raise OriginBoundary()
        return page
    def guarded_act(action, page, text=None):
        check_origin(browser, start_url)
        node = action.get("node")
        if type(node) is int and action.get("kind") == "click":
            destinations = browser.evaluate(
                "(() => { const e=window.__jevFast?.nodes.get(" + str(node) + "); "
                "const a=e?.closest('a[href]'); const f=e?.form; "
                "return [a?.href, (e?.type==='submit' ? (e.formAction || f?.action) : null)].filter(Boolean); })()")
            try:
                outside = not isinstance(destinations, list) or any(origin(url) != origin(start_url) for url in destinations)
            except InvalidRequest:
                outside = True
            if outside:
                raise OriginBoundary()
        return act(action, page, text=text)
    browser.observe, browser.act = guarded_observe, guarded_act


def verification(browser, request):
    # Evaluate explicit assertions against live page content rather than trusting
    # Jev's DONE signal or its previously observed snapshot.
    check_origin(browser, request["url"])
    facts = browser.evaluate("({url:location.href,title:document.title,text:(document.body?.innerText || '').slice(0,200000)})")
    if not isinstance(facts, dict) or any(not isinstance(facts.get(key), str) for key in ("url", "title", "text")):
        raise RuntimeError("verification")
    if origin(facts["url"]) != origin(request["url"]):
        raise OriginBoundary()
    checks = []
    for key, name, actual, exact in (
        ("expectedText", "Visible text contains", facts["text"], False),
        ("expectedTitle", "Page title contains", facts["title"], False),
        ("expectedUrl", "Final URL equals", facts["url"], True),
    ):
        expected = request.get(key)
        if expected:
            passed = actual == expected if exact else expected in actual
            checks.append({"name": name, "passed": passed, "expected": public_url(expected) if key == "expectedUrl" else expected})
    status = ("passed" if all(check["passed"] for check in checks) else "failed") if checks else "not_checked"
    return status, checks, facts


def capture_screenshot(browser, request):
    check_origin(browser, request["url"])
    screenshot = browser.call("Page.captureScreenshot", format="jpeg", quality=72).get("data")
    if not isinstance(screenshot, str) or len(screenshot) > MAX_SCREENSHOT * 4 // 3 + 4:
        return None
    try:
        image = base64.b64decode(screenshot, validate=True)
    except ValueError:
        return None
    if len(image) > MAX_SCREENSHOT or not image.startswith(b"\xff\xd8\xff"):
        return None
    destination = Path(request["outputDir"]) / "final.jpg"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    with os.fdopen(os.open(destination, flags, 0o600), "wb") as output:
        output.write(image)
    return "final.jpg"


def empty_result(status="failed", summary="Browser test could not complete."):
    return {"type": "result", "status": status, "verification": "not_checked", "summary": summary,
            "url": "", "title": "", "steps": 0, "durationMs": 0, "checks": []}


def error_summary(error):
    # Provider bodies, exception reprs, and page content must not become logs.
    value = str(error)
    if value == "chrome_start":
        return "Chrome could not start an isolated test browser. Check the Chrome executable."
    if value == "harness_start":
        return "The private Browser Harness connection could not start. Run Check setup."
    if value.startswith("Model provider returned HTTP "):
        match = re.match(r"Model provider returned HTTP (\d{3});", value)
        if match:
            return f"The model provider returned HTTP {match[1]}. Check credentials, billing, and rate limits."
    if value.startswith("TYPE_TEXT needs TEXT_MODEL_API_KEY"):
        return "This task needs text entry. Add a text model API key in Jev settings."
    if value.startswith("Model connection failed") or value == "Model unavailable":
        return "The model provider could not be reached. Try again after checking the connection."
    return "Browser test stopped before it could finish. Inspect the app and try a narrower goal."


def run(request, output, runtime_factory=Runtime):
    result = empty_result()
    started = time.monotonic()
    runtime = None
    preview = None
    try:
        diagnostic = doctor(request["chromePath"])
        if not diagnostic["ready"]:
            result["summary"] = " ".join(diagnostic["issues"])
            return result
        output.emit({"type": "status", "status": "starting", "summary": "Opening an isolated browser"})
        runtime = runtime_factory(request, diagnostic["chromePath"])
        agent = runtime.start()
        preview = LivePreview(agent.browser, request, output, started)
        preview.start()
        output.emit({"type": "status", "status": "running", "summary": "Testing with Jev"})
        seen = 0
        for _ in range(request["maxSteps"]):
            if time.monotonic() - started >= request["timeoutSeconds"]:
                raise Deadline()
            check_origin(agent.browser, request["url"])
            state = agent.command("tick")
            for entry in state.get("history", [])[seen:]:
                if isinstance(entry.get("text"), str) and entry["text"]:
                    output.redact(entry["text"])
                operation = entry.get("operation")
                target = str(entry.get("target") or "")
                output.emit({"type": "step", "step": seen + 1,
                             "operation": operation if operation in OPERATIONS else "OBSERVE",
                             "target": "Element " + target if re.fullmatch(r"[0-9]{1,4}(?::[0-9]{1,4})?", target) else "",
                             "url": public_url(entry.get("url", "")),
                             "elapsedMs": max(0, int((time.monotonic() - started) * 1000))})
                seen += 1
                result["steps"] = seen
            check_origin(agent.browser, request["url"])
            result["url"] = public_url(state.get("page", {}).get("url", ""))
            if state.get("status") in {"done", "blocked"}:
                result["status"] = state["status"]
                break
        else:
            result["status"] = "limit"
        verified, checks, facts = verification(agent.browser, request)
        result.update(verification=verified, checks=checks, url=public_url(facts["url"]), title=facts["title"][:300])
        summaries = {
            "done": "Jev finished. No independent checks were requested.",
            "blocked": "Jev could not progress with the available page controls.",
            "limit": "The browser test reached its step limit.",
        }
        result["summary"] = summaries.get(result["status"], result["summary"])
        if result["status"] == "done" and verified != "not_checked":
            result["summary"] = "Jev finished and all requested checks passed." if verified == "passed" else "Jev finished, but a requested check failed."
        with contextlib.suppress(Exception):
            screenshot = capture_screenshot(agent.browser, request)
            if screenshot:
                result["screenshot"] = screenshot
    except OriginBoundary:
        result.update(status="blocked", verification="not_checked", checks=[], summary="Stopped: the page or selected link left the test's starting origin.")
    except Deadline:
        result.update(status="limit", summary="The browser test reached its time limit.")
    except (Cancelled, KeyboardInterrupt):
        result.update(status="cancelled", summary="Browser test cancelled.")
    except Exception as error:
        result.update(status="failed", summary=error_summary(error))
    finally:
        # Allow cleanup to run after an interrupted model request. The native
        # host also enforces a hard deadline and kills the owned process tree.
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
        if preview:
            preview.close()
        if runtime:
            runtime.close()
        result["durationMs"] = max(0, int((time.monotonic() - started) * 1000))
    return result


def main():
    output = Output(sys.stdout)
    try:
        mode = sys.argv[1] if len(sys.argv) == 2 else ""
        if mode == "--doctor":
            request = read_request(sys.stdin.buffer, optional=True)
            if not isinstance(request, dict) or set(request) - {"chromePath"}:
                raise InvalidRequest("Invalid diagnostic configuration.")
            output.emit(doctor(text_field(request, "chromePath", 4096)))
            return 0
        if mode != "--run":
            raise InvalidRequest("Choose a browser adapter operation.")
        request = validate_request(read_request(sys.stdin.buffer))
        output.secrets.update(value for value in (request["typesafeKey"], request["textKey"]) if value)
        def cancel(_signum, _frame):
            raise Cancelled()
        signal.signal(signal.SIGTERM, cancel)
        if hasattr(signal, "SIGALRM"):
            def deadline(_signum, _frame):
                raise Deadline()
            signal.signal(signal.SIGALRM, deadline)
            signal.alarm(request["timeoutSeconds"])
        # Suppress all package output; only the original protocol stream may emit.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = run(request, output)
        output.emit(result)
        return 0
    except InvalidRequest as error:
        output.emit(empty_result(summary=str(error)))
    except (Cancelled, KeyboardInterrupt):
        output.emit(empty_result("cancelled", "Browser test cancelled."))
    except BaseException:
        output.emit(empty_result(summary="The browser adapter could not start. Run Check setup in Jev settings."))
    return 1


if __name__ == "__main__":
    sys.exit(main())
