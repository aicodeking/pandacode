# Optional Jev add-on

Jev is optional and disabled by default. PandaCode installs its Python runtime
separately, launches a fresh Chrome profile for each test, and keeps reports on
the device. Python, Chromium, and model SDKs are not bundled into the desktop app.

## Decision assistance

PandaCode works without Jev or a TypeSafe key. Agents, teams, normal browser
access, task completion, and saved diffs do not depend on this add-on. Browser
testing and decision assistance have independent switches, both off by default.

To use decision assistance, save your TypeSafe key in **Settings → Agents →
Set up Jev**, enable **Decision assistance**, and save. No Python installation,
Chrome, text helper key, or browser testing switch is needed for these checks.

| Option | Where it fits | What it returns |
| --- | --- | --- |
| Work review | Task actions → Jev assistance, or Review with Jev in a saved diff / worker | Advisory checks on requested behavior, verification evidence, and unresolved work |
| Project rules | Jev assistance → Project rules | File-level assessment of saved changes against up to eight rules you write |
| Find context | Jev assistance → Find context | Relevant original excerpts from a bounded recent task window |
| Choose worker | Workers → Suggest worker, or Jev assistance → Choose worker | A suggestion among configured worker profiles, or no recommendation |

Use **Preview evidence** to inspect the local source excerpts before **Run**.
If the evidence changes between preview and running, prepare it again. Saving
project rules and opening reports never call a model. Reports persist locally;
**Use report in prompt** appends a draft for you to send. Source diff links open
the immutable saved snapshot, including from older reports.

These are probability-based judgments, not tests or proof of correctness. An
uncertain answer stays uncertain. Worker selection does not automatically change
models, dispatch work, or claim a cost saving. Context matching preserves the
original excerpts and all conversation history. Project-rule reviews cover saved
patches only; binary, omitted, stale, and truncated evidence can limit the result.

The following tools are added to supported harnesses and teams only while decision
assistance is enabled. Start another agent turn after changing integration settings.

| Tool | Purpose |
| --- | --- |
| `pandacode_jev_review` | Review bounded saved task evidence |
| `pandacode_jev_check_rules` | Check saved diffs against saved or temporary rules |
| `pandacode_jev_find_context` | Find relevant original task excerpts |
| `pandacode_jev_choose_worker` | Suggest one configured worker for an assignment |
| `pandacode_jev_assessments` | Read local report summaries without a model call |

Paid evaluation follows the harness's existing tool-approval rules. Plan mode
cannot spend through these tools. Other task IDs are limited to the current
project; worker selection stays on the calling task. Recommendations never
authorize actions or bypass file scopes, task permissions, or concurrency limits.

The native adapter sends only bounded task evidence and criteria to TypeSafe's
fixed HTTPS endpoint. It pins `jev-1.13.0`, batches up to 16 questions in one
request, allows two concurrent evaluations, has a 12-second deadline, and never
automatically retries. Reports retain at most 20 per task and 200 overall. No
background evaluation or required startup network call is introduced.

**OpenRouter (optional).** In **Set up Jev** you can send decisions to OpenRouter
instead of TypeSafe, which stays the default. The adapter builds the same bounded
state and typed questions, posts them to
`https://openrouter.ai/api/v1/chat/completions` as a JSON-mode chat completion at
temperature 0, and holds the model's answers to the same validation rules as
TypeSafe's. The OpenRouter key is kept in the app secret store (never in the
webview or `settings.json`). The model menu lists `jev-1.13.0` for TypeSafe; for
OpenRouter it fetches the public `https://openrouter.ai/api/v1/models` catalog
(no key sent) only when you open the menu or press Refresh, keeping models whose
`supported_parameters` include `response_format` or `structured_outputs`.
Nothing contacts OpenRouter until you pick it.

Contract sources: [TypeSafe API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[Noul](https://docs.typesafe.ai/primitives/noul),
[model limits](https://docs.typesafe.ai/models), and
[documented model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
Confidence describes the concentration of a probability distribution; it is not
a guarantee that an answer is correct. Source text is treated as untrusted data.

## Set up browser testing

1. Open **Settings → Agents → Jev · Optional add-on → Set up Jev**.
2. Add a TypeSafe API key and a text model API key. The default text helper uses
   OpenRouter with `inception/mercury-2.5`; Advanced allows an HTTPS
   OpenAI-compatible base URL and model name.
3. Save settings, then choose **Install Jev runtime**. Install `uv` or Python
   3.12+ first if neither is found. The installer uses `uv` when available and
   otherwise creates a venv with Python. It installs only in PandaCode's private
   app data, not the system Python environment.
4. Install Chrome (Chromium/Edge are also detected where available), choose
   **Check setup**, and enable Jev. You can specify Python and Chrome executable
   paths under Advanced. The Python override selects the interpreter used to
   create the managed environment; existing environments are reused.

Check setup verifies the interpreter, pinned Jev and Browser Harness packages,
and browser executable. It does not spend model tokens or validate API billing.
Invalid credentials or provider errors are reported when a test runs.

API keys are stored in a private local settings file, not Keychain or the
conversation database. They are not encrypted against another process running
as the same OS user. Settings return only whether each key is saved. Keys reach
the runner through private stdin, never process arguments or agent tool output.
Leave a key field blank to retain it; use Remove to clear it.

## Use it in the app

The browser panel has a compact **Test with Jev** popover, using its current URL. **Task actions →
Browser tests with Jev** works from both conversation and board detail views.
Expand **Local servers** for quick URL selection. Choose a smoke test, user
journey, or mobile preset, then describe the behavior to exercise. Information
buttons reveal explanations on demand; **Run test** stays visible while options
scroll. The translucent popover respects reduced-transparency preferences.

Starting from the popover switches the sidebar to Jev's live browser view. It
shows the actual isolated Chrome test, including page changes, a current action,
and an expandable action history. Agent-started tests also appear while that
task's browser panel is open. **Stop test** cancels the run; **Return to browser**
lets it continue while restoring the ordinary browser. **Watch Jev** reopens the
test. Saved reports can also be opened with **Watch in browser**.

Live viewing does not control the test or reuse the ordinary browser's cookies.
Frames stay local and transient, refresh at most twice per second, and pause
while the live view is hidden. A short expiring watch lease stops capture after
an unexpected reload or disconnected viewer. Only the final screenshot is kept
with the report; this is a live preview, not a saved video recording.

Optional final checks independently inspect visible text, page title, or an exact
URL. A model reporting `DONE` is labeled **Agent finished**, not a verified pass.
Reports separately show **Checks passed**, **Checks failed**, or **Not checked**.
These checks establish only the supplied assertions; they are not a complete
accessibility, security, or application test suite.

Actions stream into the report without replacing your form or focus. Stop keeps
a partial report. A small Jev indicator appears in the task while testing. Recent
reports include their viewport, duration, actions, assertions, and a final JPEG
when available. **Use report in prompt** adds the selected report to an idle
task's draft; it does not automatically send a message.

## Agent and team tools

When enabled, the following tools are available to Claude Code, Codex, Kimi Code,
OpenCode, GLM through Claude Code, and compatible Antigravity ACP connections.
ACP harnesses must support HTTP MCP. Start the next agent turn after enabling.
Codex receives Jev via a temporary MCP override on both new and resumed threads,
preserving its original history and other configured MCP servers.

| Tool | Purpose |
| --- | --- |
| `pandacode_jev_test` | Start a test for the calling task; returns a run ID immediately |
| `pandacode_jev_wait` | Wait up to 30 seconds for a report to settle |
| `pandacode_jev_read` | Read a bounded report and the last 12 actions |
| `pandacode_jev_list` | List up to 10 recent reports |
| `pandacode_jev_screenshot` | View the saved final screenshot as a real image |
| `pandacode_jev_cancel` | Cancel the calling task's test |

Report tools accept an optional task ID within the current project. Architects
can review a worker's browser report and screenshot without copying the entire
worker conversation. Test creation stays scoped to the calling task. For example:

> Implement the settings page, start its local preview, and use Jev to exercise
> saving a setting on desktop and mobile. Assert that “Settings saved” is visible.
> Wait for the reports, inspect failures and the screenshot, then report the run
> IDs and what was actually verified to the architect.

The agent must wait/read before ending its turn. An agent-created test stops if
its task ends or is stopped; manually launched tests run independently of an
agent turn. At most two browser tests run concurrently, and one per task.
Defaults are 20 steps and 180 seconds; limits are 1–60 steps and 30–600 seconds.
Callers receive a clear capacity error instead of spawning unlimited browsers.

Native browser callbacks use the task's approval mode across transports. Plan
mode cannot start or cancel tests. Full access follows the user's explicit
permission; other modes request approval before browser actions/model spending.
Listing reports, waiting, and viewing existing screenshots do not run a model.

## Privacy and limits

Enabling Jev authorizes an additional integration, not background monitoring.
Only a requested test launches a browser and model work. The test goal and
visible page representation go directly to TypeSafe; text entry can call the
configured helper provider. Provider usage is billed separately. Their privacy
policies apply. No report or page content goes to PandaCode's servers.

Every test owns a new Chrome profile and a private Browser Harness daemon;
personal tabs, cookies, and browser profiles are not reused. Browser Harness
telemetry/recording is disabled. Only compact local reports and a final screenshot
are retained (20 reports per task). Raw model requests, typed values, and complete
page snapshots are not saved as traces. Screenshots can still contain visible
page information. Stop and normal exit clean up the owned browser processes.

Tests accept HTTP(S) URLs, including remote websites. Actions are constrained to
the starting origin; redirects or cross-origin links can stop the test. **This
is not a network sandbox**: web pages can make their own requests and modify the
server they target. Use test accounts and development data for actions that
change application state.

Upstream does not provide complete support for iframes, shadow DOM, canvas,
uploads, popup tabs, nested scrolling, or arbitrary keyboard widgets. A blocked
test is reported honestly. Runtime/browser startup and the offline action path
are tested on macOS; Windows/Linux runtime paths are implemented but need native
interactive validation. No paid end-to-end inference was performed during this
implementation; API behavior was checked with local HTTP fixtures.

## Implementation and verification

The external runtime is pinned to Jev commit
`1231850a0bf1a0c0341fe408ef1668dbbfdfac46` (0.1.0, MIT) and
`browser-harness==0.1.13`. The runner checks installed package metadata before
using the upstream API. Sources: [Jev repository](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46),
[agent implementation](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py),
[Codex MCP configuration](https://developers.openai.com/codex/mcp/).

Offline runner tests: `python3 -m unittest discover -s tests -p jev_runner_test.py`.
The optional `tests/jev_browser_smoke.py` uses an installed Jev environment to
launch a disposable local fixture, exercise real browser actions, verify viewport
and assertions, capture a screenshot, and check cleanup. It never calls a model
API. See that file's docstring for the opt-in command.

Decision assistance was verified with 555 native tests (six existing opt-in tests
ignored), Clippy with warnings denied, 420 UI regressions, 42 JavaScript unit
tests, and a focused 19-test Jev UI recheck after final wording changes. These
checks cover request batching, timeout/cancellation, strict response parsing,
project scoping, immutable evidence, original context excerpts, retention,
legacy settings, and disabled/no-key behavior. They do not establish the model's
accuracy on real tasks or make a claim about token savings.
