"""Offline adapter checks: no Jev imports, browser launches, or paid API calls."""

import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

RUNNER_PATH = Path(__file__).resolve().parents[1] / "src-tauri/scripts/jev_runner.py"
SPEC = importlib.util.spec_from_file_location("pandacode_jev_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def request(directory, **changes):
    return {
        "runId": "test-123", "url": "http://localhost:3000/", "goal": "Open the menu",
        "maxSteps": 4, "timeoutSeconds": 30, "viewport": "desktop", "expectedText": "",
        "expectedTitle": "", "expectedUrl": "", "chromePath": "", "typesafeKey": "typesafe-secret-key",
        "textKey": "text-secret-key", "textModel": "small-model", "textBaseUrl": "https://api.example.com/v1",
        "outputDir": str(directory), "decisionBaseUrl": "", **changes,
    }


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_valid_request_and_bounds(self):
        result = runner.validate_request(request(self.directory))
        self.assertEqual(result["viewport"], "desktop")
        for field, values in {
            "maxSteps": [0, 61, True, "4"], "timeoutSeconds": [29, 601, False],
            "viewport": ["tablet", None], "runId": ["../escape", "", "has space"],
            "goal": ["", "x" * 8193], "typesafeKey": ["", "x\x00y"],
        }.items():
            for value in values:
                with self.subTest(field=field, value=str(value)[:40]), self.assertRaises(runner.InvalidRequest):
                    runner.validate_request(request(self.directory, **{field: value}))

    def test_rejects_unknown_fields_and_wrong_shapes(self):
        for value in (None, [], 1, {**request(self.directory), "shell": "run arbitrary code"}):
            with self.assertRaises(runner.InvalidRequest):
                runner.validate_request(value)

    def test_credentials_cannot_use_http_provider(self):
        for url in ("http://api.example.com", "https://user:secret@example.com", "https://api.example.com?key=secret"):
            with self.assertRaises(runner.InvalidRequest):
                runner.validate_request(request(self.directory, textBaseUrl=url))

    def test_local_decision_endpoint_must_be_loopback(self):
        result = runner.validate_request(request(self.directory, typesafeKey="", decisionBaseUrl="http://127.0.0.1:8000/"))
        self.assertEqual(result["decisionBaseUrl"], "http://127.0.0.1:8000")
        result = runner.validate_request(request(self.directory, typesafeKey="", decisionBaseUrl="http://localhost:8123"))
        self.assertEqual(result["decisionBaseUrl"], "http://localhost:8123")
        result = runner.validate_request(request(self.directory, typesafeKey="", decisionBaseUrl="http://[::1]:8000"))
        self.assertEqual(result["decisionBaseUrl"], "http://[::1]:8000")
        result = runner.validate_request(request(self.directory, typesafeKey="", decisionBaseUrl="http://127.9.0.1:8000"))
        self.assertEqual(result["decisionBaseUrl"], "http://127.9.0.1:8000")
        for url in ("https://api.example.com", "http://0.0.0.0:8000", "10.0.0.1:8000", "http://127.0.0.1:8000/?x=1", "http://127.0.0.1.evil.com:8000", "http://user@127.0.0.1:8000"):
            with self.subTest(url=url), self.assertRaises(runner.InvalidRequest):
                runner.validate_request(request(self.directory, typesafeKey="", decisionBaseUrl=url))
        with self.assertRaises(runner.InvalidRequest):
            runner.validate_request(request(self.directory, typesafeKey=""))

    def test_url_restrictions_and_canonical_origins(self):
        for url in ("file:///tmp/a", "javascript:alert(1)", "https://x:99999/", "https://user:password@example.com", "https://a\\@b", "https://a\n.example.com"):
            with self.subTest(url=url), self.assertRaises(runner.InvalidRequest):
                runner.http_url(url)
        self.assertEqual(runner.origin("https://EXAMPLE.com:443/a"), runner.origin("https://example.com/b"))
        self.assertEqual(runner.origin("http://[::1]:3000"), ("http", "::1", 3000))
        with self.assertRaises(runner.InvalidRequest):
            runner.validate_request(request(self.directory, expectedUrl="https://other.example.com"))

    def test_public_url_strips_query_and_fragment(self):
        self.assertEqual(runner.public_url("https://example.com/done?token=secret#access_token=x"), "https://example.com/done")
        self.assertEqual(runner.public_url("file:///etc/passwd"), "")

    def test_output_folder_must_exist_and_not_be_a_symlink(self):
        for directory in ("relative", str(self.directory / "missing")):
            with self.assertRaises(runner.InvalidRequest):
                runner.validate_request(request(directory))
        link = self.directory / "link"
        link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(runner.InvalidRequest):
            runner.validate_request(request(link))

    def test_stdin_is_bounded_and_bad_json_does_not_echo_input(self):
        self.assertEqual(runner.read_request(io.BytesIO(b""), optional=True), {})
        for raw in (b"sensitive-invalid-json", b"{" * (runner.MAX_REQUEST + 1), b"\xff"):
            with self.assertRaises(runner.InvalidRequest) as caught:
                runner.read_request(io.BytesIO(raw))
            self.assertNotIn("sensitive", str(caught.exception))


class DiagnosticTests(unittest.TestCase):
    def test_pins_accept_archive_or_vcs_but_not_latest_or_other_repo(self):
        for direct, expected in (
            ({"url": f"{runner.REPOSITORY}/archive/{runner.COMMIT}.zip"}, True),
            ({"url": f"{runner.REPOSITORY}/archive/{runner.COMMIT}.tar.gz"}, True),
            ({"url": runner.REPOSITORY + ".git", "vcs_info": {"commit_id": runner.COMMIT}}, True),
            ({"url": runner.REPOSITORY + ".git", "vcs_info": {"commit_id": "latest"}}, False),
            ({"url": "https://evil.invalid/repo", "vcs_info": {"commit_id": runner.COMMIT}}, False),
            ({"url": runner.REPOSITORY + "/archive/main.zip"}, False),
        ):
            distribution = MagicMock()
            distribution.read_text.return_value = json.dumps(direct)
            with self.subTest(direct=direct):
                self.assertEqual(runner.pinned_distribution(distribution), expected)

    def test_doctor_uses_only_metadata_no_package_import_or_network(self):
        distribution = MagicMock()
        distribution.version = "0.1.0"
        distribution.read_text.return_value = json.dumps({"url": f"{runner.REPOSITORY}/archive/{runner.COMMIT}.zip"})
        with patch.object(runner.importlib.metadata, "distribution", return_value=distribution), \
             patch.object(runner.importlib.metadata, "version", return_value="0.1.13"), \
             patch.object(runner.importlib, "import_module", side_effect=AssertionError("must not import")), \
             patch.object(runner, "find_chrome", return_value="/fake/chrome"), \
             patch.object(runner.sys, "version_info", (3, 12, 4)):
            self.assertTrue(runner.doctor()["ready"])

    def test_doctor_reports_missing_requirements(self):
        with patch.object(runner.importlib.metadata, "distribution", side_effect=runner.importlib.metadata.PackageNotFoundError), \
             patch.object(runner.importlib.metadata, "version", side_effect=runner.importlib.metadata.PackageNotFoundError), \
             patch.object(runner, "find_chrome", return_value=""), patch.object(runner.sys, "version_info", (3, 11, 4)):
            result = runner.doctor()
        self.assertFalse(result["ready"])
        self.assertEqual(len(result["issues"]), 4)

    def test_custom_missing_chrome_does_not_fallback_to_personal_browser(self):
        with patch.object(runner.shutil, "which", side_effect=AssertionError("no fallback")):
            self.assertEqual(runner.find_chrome("/not/a/chrome"), "")

    def test_child_environment_drops_keys_and_browser_connections(self):
        with patch.dict(os.environ, {"PATH": "/bin", "TYPESAFE_API_KEY": "secret", "OPENAI_API_KEY": "secret",
                                     "BU_CDP_WS": "ws://personal-browser", "PYTHONPATH": "/untrusted"}, clear=True):
            self.assertEqual(runner.safe_environment(), {"PATH": "/bin"})


class FakeBrowser:
    def __init__(self, url="http://localhost:3000/", title="Menu app", text="Menu opened"):
        self.url, self.title, self.text = url, title, text
        self.destinations = []
        self.acted = []

    def evaluate(self, expression):
        if expression == "location.href":
            return self.url
        if expression.startswith("({url:"):
            return {"url": self.url, "title": self.title, "text": self.text}
        if "closest('a[href]')" in expression:
            return self.destinations
        raise AssertionError(expression)

    def observe(self, **_kwargs):
        return {"url": self.url}

    def act(self, action, page, text=None):
        self.acted.append((action, page, text))

    def call(self, method, **_kwargs):
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(b"\xff\xd8\xfffake-jpeg").decode()}
        raise AssertionError(method)


class LivePreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.configuration = request(self.directory, browserDir=str(self.directory))
        self.browser = MagicMock()
        self.image = b"\xff\xd8\xfflive-fixture"
        self.calls = []
        def call(method, **kwargs):
            self.calls.append((method, kwargs))
            if method == "Runtime.evaluate":
                return {"result": {"value": self.configuration["url"]}}
            return {"data": base64.b64encode(self.image).decode()}
        self.browser.call.side_effect = call
        self.stream = io.StringIO()
        self.preview = runner.LivePreview(self.browser, self.configuration, runner.Output(self.stream), time.monotonic())
        self.addCleanup(self.preview.close)

    def lease(self, **changes):
        (self.directory / "live-watch.json").write_text(json.dumps({
            "runId": self.configuration["runId"], "expiresAt": int(time.time() * 1000) + 10000, **changes,
        }))

    def test_captures_only_with_fresh_matching_lease(self):
        self.preview.sample()
        self.browser.call.assert_not_called()
        for changes in ({"runId": "another-run"}, {"expiresAt": 0}, {"expiresAt": time.time() * 1000 + 60000}):
            self.lease(**changes)
            self.preview.sample()
            self.browser.call.assert_not_called()
        self.lease()
        self.preview.sample()
        event = json.loads(self.stream.getvalue())
        self.assertEqual(event["type"], "frame")
        self.assertEqual((event["width"], event["height"]), (960, 600))
        self.assertEqual(event["sha256"], runner.hashlib.sha256(self.image).hexdigest())
        self.assertEqual((self.directory / "live-frame.jpg").read_bytes(), self.image)
        self.assertNotIn("data", event)
        self.assertFalse((self.directory / "final.jpg").exists())
        self.assertTrue(all(kwargs["_response_timeout"] == 0.8 for _, kwargs in self.calls))

    def test_unchanged_images_deduplicate_but_resume_sends_one_fresh_frame(self):
        self.lease()
        self.preview.sample()
        self.preview.sample()
        self.assertEqual(len(self.stream.getvalue().splitlines()), 1)
        self.lease(expiresAt=0)
        self.preview.sample()
        self.lease()
        self.preview.sample()
        self.assertEqual(len(self.stream.getvalue().splitlines()), 2)
        self.image += b"changed"
        self.preview.sample()
        self.assertEqual([json.loads(line)["sequence"] for line in self.stream.getvalue().splitlines()], [1, 2, 3])
        # Closing/reopening before the sampler observes an unwatched interval
        # still needs an initial frame for the newly mounted viewer.
        self.lease(generation=2)
        self.preview.sample()
        self.assertEqual(len(self.stream.getvalue().splitlines()), 4)

    def test_mobile_dimensions_and_stop_cleanup(self):
        self.configuration["viewport"] = "mobile"
        self.lease()
        self.preview.sample()
        self.assertEqual(json.loads(self.stream.getvalue())["width"], 390)
        self.preview.close()
        self.assertFalse(self.preview.watched())
        for name in ("live-watch.json", "live-frame.jpg", "live-frame.tmp"):
            self.assertFalse((self.directory / name).exists())

    def test_failed_large_or_invalid_frames_do_not_emit_or_throw(self):
        self.lease()
        for response in ({"data": "invalid base64"}, {"data": "a" * (runner.MAX_LIVE_FRAME * 2)},
                         {"data": base64.b64encode(b"not jpeg").decode()}):
            self.browser.call.side_effect = lambda method, **_: {"result": {"value": self.configuration["url"]}} if method == "Runtime.evaluate" else response
            self.preview.sample()
        self.browser.call.side_effect = RuntimeError("secret provider exception")
        self.preview.sample()
        self.assertEqual(self.stream.getvalue(), "")
        self.assertFalse((self.directory / "live-frame.jpg").exists())

    def test_off_origin_or_expired_during_capture_is_not_published(self):
        self.lease()
        self.browser.call.side_effect = lambda *_args, **_kwargs: {"result": {"value": "https://other.example.com/"}}
        self.preview.sample()
        self.assertEqual(self.stream.getvalue(), "")
        def expire(method, **_kwargs):
            if method == "Runtime.evaluate":
                return {"result": {"value": self.configuration["url"]}}
            self.lease(expiresAt=0)
            return {"data": base64.b64encode(self.image).decode()}
        self.browser.call.side_effect = expire
        self.preview.sample()
        self.assertEqual(self.stream.getvalue(), "")

    def test_watch_input_is_bounded_and_no_preview_thread_without_transport(self):
        marker = self.directory / "live-watch.json"
        marker.write_text("x" * 257)
        self.assertFalse(self.preview.watched())
        marker.write_text("null")
        self.assertFalse(self.preview.watched())
        preview = runner.LivePreview(self.browser, request(self.directory), runner.Output(self.stream), time.monotonic())
        preview.start()
        self.assertIsNone(preview.thread)
        self.assertFalse(preview.watched())


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.diagnostic = patch.object(runner, "doctor", return_value={"ready": True, "chromePath": "/fake/chrome"})
        self.diagnostic.start()
        self.addCleanup(self.diagnostic.stop)

    def execute(self, states, browser=None, **changes):
        self.browser = browser or FakeBrowser()
        agent = MagicMock(browser=self.browser)
        agent.command.side_effect = states
        runtime = MagicMock()
        runtime.start.return_value = agent
        stream = io.StringIO()
        config = request(self.directory, **changes)
        output = runner.Output(stream, (config["typesafeKey"], config["textKey"]))
        result = runner.run(config, output, runtime_factory=lambda *_args: runtime)
        output.emit(result)
        self.assertEqual(runtime.close.call_count, 1)
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        return result, events, stream.getvalue(), agent

    @staticmethod
    def state(status="done", **overrides):
        return {"status": status, "history": [], "page": {"url": "http://localhost:3000/"}, **overrides}

    def test_done_is_not_independent_success(self):
        result, events, _, _ = self.execute([self.state()])
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["verification"], "not_checked")
        self.assertEqual([event["status"] for event in events[:2]], ["starting", "running"])
        self.assertTrue((self.directory / "final.jpg").is_file())

    def test_independent_assertions_pass_and_url_is_exact(self):
        result, _, _, _ = self.execute([self.state()], expectedText="Menu opened", expectedTitle="Menu", expectedUrl="http://localhost:3000/")
        self.assertEqual(result["verification"], "passed")
        self.assertEqual(len(result["checks"]), 3)

    def test_wrong_expected_text_fails_even_when_model_done(self):
        result, _, _, _ = self.execute([self.state()], expectedText="Missing success")
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["verification"], "failed")
        self.assertFalse(result["checks"][0]["passed"])

    def test_limits_even_if_agent_keeps_returning_ready_without_actions(self):
        result, _, _, agent = self.execute([self.state("ready")] * 2, maxSteps=2)
        self.assertEqual(result["status"], "limit")
        self.assertEqual(agent.command.call_count, 2)

    def test_cross_origin_blocks_before_any_model_call(self):
        result, _, _, agent = self.execute([], browser=FakeBrowser("https://other.example.com"))
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["verification"], "not_checked")
        agent.command.assert_not_called()

    def test_cancel_and_timeout_cleanup(self):
        for exception, status in ((runner.Cancelled(), "cancelled"), (runner.Deadline(), "limit")):
            with self.subTest(status=status), patch.object(runner, "LivePreview") as live:
                result, _, _, _ = self.execute([exception])
                self.assertEqual(result["status"], status)
                live.return_value.start.assert_called_once()
                live.return_value.close.assert_called_once()

    def test_error_never_echoes_provider_response_or_secret(self):
        result, _, raw, _ = self.execute([RuntimeError("typesafe-secret-key remote untrusted body")])
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("typesafe-secret-key", raw)
        self.assertNotIn("untrusted", raw)
        self.assertIn("HTTP 401", runner.error_summary(RuntimeError("Model provider returned HTTP 401; no action executed.")))

    def test_step_events_do_not_include_raw_labels_typed_text_or_query_tokens(self):
        history = [{"operation": "TYPE_TEXT", "target": "2", "text": "private input", "action": "A secret label",
                    "url": "http://localhost:3000/?token=very-secret", "raw_answers": {"provider": "secret"}}]
        result, events, raw, _ = self.execute([self.state(history=history)], browser=FakeBrowser(title="private input typesafe-secret-key"))
        step = next(event for event in events if event["type"] == "step")
        self.assertEqual(step["target"], "Element 2")
        self.assertEqual(result["steps"], 1)
        for private in ("private input", "typesafe-secret-key", "secret label", "very-secret", "raw_answers"):
            self.assertNotIn(private, raw)

    def test_history_is_not_reemitted(self):
        history = [{"operation": "CLICK", "target": "1", "url": "http://localhost:3000/"}]
        _, events, _, _ = self.execute([self.state("ready", history=history), self.state(history=history)])
        self.assertEqual(len([event for event in events if event["type"] == "step"]), 1)

    def test_start_failure_still_cleans_processes(self):
        runtime = MagicMock()
        runtime.start.side_effect = RuntimeError("chrome_start")
        result = runner.run(request(self.directory), runner.Output(io.StringIO()), runtime_factory=lambda *_args: runtime)
        self.assertEqual(result["status"], "failed")
        self.assertIn("Chrome", result["summary"])
        runtime.close.assert_called_once()


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_guard_blocks_external_links_before_click(self):
        browser = FakeBrowser()
        browser.destinations = ["https://other.example.com"]
        runner.install_origin_guards(browser, browser.url)
        with self.assertRaises(runner.OriginBoundary):
            browser.act({"kind": "click", "node": 1}, {"url": browser.url})
        self.assertEqual(browser.acted, [])

    def test_guard_allows_same_origin_and_blocks_after_redirect(self):
        browser = FakeBrowser()
        browser.destinations = [browser.url + "menu"]
        runner.install_origin_guards(browser, browser.url)
        browser.act({"kind": "click", "node": 1}, {"url": browser.url})
        self.assertEqual(len(browser.acted), 1)
        browser.url = "https://other.example.com"
        with self.assertRaises(runner.OriginBoundary):
            browser.observe()

    def test_guard_blocks_non_http_link_without_acting(self):
        browser = FakeBrowser()
        browser.destinations = ["file:///etc/passwd"]
        runner.install_origin_guards(browser, browser.url)
        with self.assertRaises(runner.OriginBoundary):
            browser.act({"kind": "click", "node": 1}, {"url": browser.url})
        self.assertEqual(browser.acted, [])

    def test_screenshot_does_not_overwrite_or_follow_symlink(self):
        outside = self.directory / "original"
        outside.write_text("untouched")
        (self.directory / "final.jpg").symlink_to(outside)
        with self.assertRaises(FileExistsError):
            runner.capture_screenshot(FakeBrowser(), request(self.directory))
        self.assertEqual(outside.read_text(), "untouched")

    def test_screenshot_rejects_non_jpeg(self):
        browser = FakeBrowser()
        browser.call = lambda *_args, **_kwargs: {"data": base64.b64encode(b"not an image").decode()}
        self.assertIsNone(runner.capture_screenshot(browser, request(self.directory)))

    def test_close_terminates_only_owned_process_objects(self):
        runtime = runner.Runtime(request(self.directory), "/fake/chrome")
        daemon, chrome = MagicMock(), MagicMock()
        daemon.poll.return_value = chrome.poll.return_value = None
        runtime.daemon, runtime.chrome = daemon, chrome
        with patch.object(runner, "stop_process") as stop:
            runtime.close()
        self.assertEqual(stop.call_args_list, [unittest.mock.call(daemon), unittest.mock.call(chrome)])

    def test_stopped_process_is_not_signalled_using_recycled_pid(self):
        process = MagicMock()
        process.poll.return_value = 0
        runner.stop_process(process)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_protocol_failure_output_is_json_and_stderr_empty(self):
        outcome = subprocess.run([sys.executable, "-I", "-u", str(RUNNER_PATH), "--run"],
                                 input=b"invalid private-request", capture_output=True, timeout=5)
        event = json.loads(outcome.stdout)
        self.assertEqual(event["status"], "failed")
        self.assertEqual(outcome.stderr, b"")
        self.assertNotIn(b"private-request", outcome.stdout)


class RuntimeTests(unittest.TestCase):
    def test_isolated_bootstrap_has_private_profile_explicit_cdp_and_no_child_keys(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"OPENAI_API_KEY": "unrelated-secret"}):
            configuration = request(directory, viewport="mobile")
            calls, processes = [], []

            def popen(command, **kwargs):
                calls.append((command, kwargs))
                process = MagicMock()
                process.poll.return_value = None
                processes.append(process)
                if command[0] == "/fake/chrome":
                    profile = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--user-data-dir=")))
                    (profile / "DevToolsActivePort").write_text("39111\n/devtools/browser/abc-123\n")
                return process

            browser = FakeBrowser()
            cdp_calls = []
            browser.call = lambda method, **params: cdp_calls.append((method, params))
            agent = MagicMock(browser=browser, state={"page": {"url": configuration["url"]}})
            admin = MagicMock()
            admin.daemon_alive.return_value = True
            browser_module = MagicMock()
            original_operation = browser_module.browser_operation
            agent_module = MagicMock()
            agent_module.Agent.return_value = agent
            modules = {"browser_harness.admin": admin, "jev_ultrafast.browser": browser_module, "jev_ultrafast.agent": agent_module}
            imported = []

            def import_module(name):
                # Every import sees the isolated endpoint and names immediately.
                self.assertEqual(os.environ["BU_CDP_WS"], "ws://127.0.0.1:39111/devtools/browser/abc-123")
                self.assertTrue(os.environ["BH_RUNTIME_DIR"].startswith("/tmp/bj-") if os.name != "nt" else True)
                self.assertEqual(os.environ["BH_RECORD"], "0")
                self.assertEqual(os.environ["BH_TELEMETRY"], "0")
                imported.append(name)
                return modules[name]

            runtime = runner.Runtime(configuration, "/fake/chrome")
            with patch.object(runner.subprocess, "Popen", side_effect=popen), \
                 patch.object(runner.importlib, "import_module", side_effect=import_module), \
                 patch.object(runner, "stop_process") as stop:
                self.assertIs(runtime.start(), agent)
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[1][0], [sys.executable, "-I", "-m", "browser_harness.daemon"])
                for _, kwargs in calls:
                    self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
                    self.assertNotIn("TYPESAFE_API_KEY", kwargs["env"])
                    self.assertNotIn("TEXT_MODEL_API_KEY", kwargs["env"])
                    self.assertNotIn("start_new_session", kwargs)
                self.assertIn("--headless=new", calls[0][0])
                self.assertNotIn("--no-sandbox", calls[0][0])
                self.assertEqual(os.environ["TYPESAFE_API_KEY"], configuration["typesafeKey"])
                self.assertIn(("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True}), cdp_calls)
                browser_module.browser_operation({"operation": "act", "action": {"kind": "scroll", "id": "scroll_down", "delta": 560}})
                self.assertIn(("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": 195, "y": 422, "deltaX": 0, "deltaY": 560}), cdp_calls)
                original_operation.assert_not_called()
                # A failed owned daemon cannot cause upstream to spawn another.
                processes[1].poll.return_value = 1
                with self.assertRaises(RuntimeError):
                    browser_module.ensure_daemon()
                runtime.close()
                self.assertEqual(stop.call_args_list, [unittest.mock.call(processes[1]), unittest.mock.call(processes[0])])
                self.assertIs(browser_module.browser_operation, original_operation)
            self.assertFalse(Path(runtime.temporary.name).exists())

    def test_local_decisions_redirect_typesafe_and_restore_on_close(self):
        with tempfile.TemporaryDirectory() as directory:
            configuration = request(directory, typesafeKey="", decisionBaseUrl="http://127.0.0.1:8000")
            calls, processes = [], []

            def popen(command, **kwargs):
                calls.append((command, kwargs))
                process = MagicMock()
                process.poll.return_value = None
                processes.append(process)
                if command[0] == "/fake/chrome":
                    profile = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--user-data-dir=")))
                    (profile / "DevToolsActivePort").write_text("39111\n/devtools/browser/abc-123\n")
                return process

            browser = FakeBrowser()
            browser.call = lambda method, **params: None
            agent = MagicMock(browser=browser, state={"page": {"url": configuration["url"]}})
            admin = MagicMock()
            admin.daemon_alive.return_value = True
            browser_module = MagicMock()
            agent_module = MagicMock()
            agent_module.Agent.return_value = agent
            model_module = MagicMock()
            original_post = MagicMock(return_value={"answers": {}})
            model_module.post_json = original_post
            modules = {"browser_harness.admin": admin, "jev_ultrafast.browser": browser_module,
                       "jev_ultrafast.agent": agent_module, "jev_ultrafast.model": model_module}

            def import_module(name):
                return modules[name]

            runtime = runner.Runtime(configuration, "/fake/chrome")
            with patch.object(runner.subprocess, "Popen", side_effect=popen), \
                 patch.object(runner.importlib, "import_module", side_effect=import_module), \
                 patch.object(runner, "stop_process"):
                self.assertIs(runtime.start(), agent)
                self.assertEqual(os.environ["TYPESAFE_API_KEY"], "local")
                self.assertIsNot(model_module.post_json, original_post)
                # Only the pinned decision endpoint is redirected; other destinations pass through.
                redirected = model_module.post_json("https://api.typesafe.ai/v1/systemone", "local", {"state": {}})
                self.assertEqual(redirected, {"answers": {}})
                original_post.assert_called_once_with("http://127.0.0.1:8000/v1/systemone", "local", {"state": {}})
                model_module.post_json("https://api.example.com/v1/chat/completions", "text-key", {})
                original_post.assert_called_with("https://api.example.com/v1/chat/completions", "text-key", {})
                runtime.close()
                self.assertIs(model_module.post_json, original_post)


if __name__ == "__main__":
    unittest.main()
