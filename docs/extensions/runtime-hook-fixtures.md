# Hook fixtures and recorded-frame provenance

Runtime slice R0501 (phase R5, harness hooks; ADR-0004: hooks can approve, deny and make additional calls). It gives
the hook slices a real protocol path on Windows and keeps every recorded input honest about where it came from.
Code: `src-tauri/src/extensions/runtime_hook_fixtures.rs` (ledger validation, the Claude gate and the native Windows
transport test), `tests/extensions-runtime-hook-fixtures.spec.ts` (the Node column), the fixtures in
`tests/fixtures/extensions/runtime-hook-fixtures/`, and the canonical fake agent
`tests/fixtures/extensions/backends/fake-agent.mjs` (B5).

## The fake agent on PandaCode's ACP transport

The Node fake agent is launched through the declared ACP transport the app uses for package harnesses
(`runtime_provider_launch::drive`, slice R0801): the host spawns `node fake-agent.mjs` with an argument list and a
hidden window, speaks ACP v1 over its stdio (stdout ACP-only, readiness on stderr), and closes stdin to stop it. The
existing ACP fixtures in `providers/acp.rs` are Unix shell scripts; this is the path that runs on Windows.

The scenarios are the synthetic fixture `synthetic/scenarios.json`, run by the native test
`runtime_hook_fixtures::tests::windows_transport` (feature `extension-runtime-native-tests`, Windows only):

| Scenario | Script | Host | Proven |
|---|---|---|---|
| `approval-allow` | tool with `ask: true` | approves | the tool completes; the agent echoes the input it ran |
| `approval-deny` | tool with `ask: true` | denies | the tool fails; standard ACP carries no reason, so the agent says so |
| `structured-question` | question, `transport: "acp-permission"` | nothing | the question is never shown or answered as a tool approval: the transport declines it as cancelled |
| `cancel-pending-tool` | tool with `ask: true` | Stop while it waits | `session/cancel` is sent, the turn ends cancelled, no `selected` answer reaches the agent |
| `late-answer` | approved tool, then a pause | a second approval | the transport writes exactly one answer; a late answer for a request that is no longer pending never reaches the agent |

The fake agent's received-frame log (`FAKE_AGENT_LOG`) is the oracle for what the transport wrote. The test bypasses
core's own stale-request check on purpose, so the transport's own refusal is what is proven.

ACP v1 has no question frame. Harnesses ask in practice with a `session/request_permission` whose options are the
answers (`q<N>_opt_<M>` ids or more than one `allow_once`). The fake agent sends that shape only when a question step
opts in with `"transport":"acp-permission"`; otherwise a question still fails with `UnsupportedCapability`. The
declared transport now declines such a request as cancelled (`runtime_provider_launch::structured_question`), the
same rule the built-in ACP harnesses follow in `providers.rs`. Answering it as a normalized question is slice R0502.

The Node column (`tests/extensions-runtime-hook-fixtures.spec.ts`) drives the same scenarios over plain stdio and
also proves the agent side of a late answer: a response to a request that is no longer pending (cancelled, or already
answered) is recorded as `{transport:"stdio",late:<id>}` in `/control/log` and is neither answered nor applied.

## Provenance of recorded inputs

`tests/fixtures/extensions/runtime-hook-fixtures/provenance.json` lists every recorded input with one of three kinds:

- **`harness-capture`**: frames a real, installed harness wrote. Only these can qualify a harness. A capture made in
  this folder lives under `live/`, has `capture.form: "live"` and names the user's authorization and the capture time;
  a transcription of an older recording has `capture.form: "transcribed"`, points at its existing location and names
  its origin. Today the only one is the transcription of Claude Code's `hook_started`/`hook_response` system frames
  for a settings-file `UserPromptSubmit` hook in `providers/claude_stream_tests.rs`; it covers neither
  `initialize.hooks` nor `hook_callback`.
- **`sdk-derived`**: frames written by hand from a harness SDK. `sdk-derived/claude-hook-callback.jsonl` holds Claude
  Code's `initialize` registration (`hooks`: event to `{matcher, hookCallbackIds, timeout}`), one `hook_callback`
  control request and the `control_response` with a `PreToolUse` decision, taken from the Python Agent SDK's
  transport source (`query.py`).
- **`synthetic`**: frames of the Node fake agent. `synthetic/fake-agent-acp.jsonl` holds the approval and
  structured-question requests it writes; the Node spec checks a fresh run against them. `synthetic/scenarios.json`
  holds the scripted scenarios.

Every fixture file starts with a `_fixture` header (`provenance`, `liveCapture`, `harness`, `source`). Validation
(`runtime_hook_fixtures::validate`, mirrored by the spec) refuses relabelling: the header must name the ledger's kind,
`liveCapture` is true only for an authorized live capture, only such a capture may sit under `live/`, an SDK-derived
or synthetic input cannot carry capture details, a transcription must point at its existing recording, and a file
under `live/` that the ledger does not list is an error.

## Claude hook-callback capture gate

The gate `claude-hook-callback-capture` names the one live recording the hook plan still needs: Claude Code's
`initialize` control request with a non-null `hooks` registration, and one `hook_callback` control request for a
registered callback id answered by a `control_response`. It also blocks the Claude-compatible bridges GLM and MiMo.

- **Status: pending.** Recording it means running the installed Claude Code harness, which needs the user's separate,
  explicit authorization. It has not been given, so no live capture exists and the gate stays pending. That blocks
  Claude-specific hook qualification (and GLM, MiMo), not the implementation against SDK-derived and synthetic
  frames. Platform qualification (R13) reports it as pending, in its own column.
- **Computed, never trusted.** `validate` computes the gate from the evidence. It is qualified only by a
  `harness-capture` input with `form: "live"`, harness `claude-code`, a non-empty authorization, and frames that hold
  the registration, a callback whose id was registered and the answer to it. SDK-derived frames have exactly that
  shape and still never qualify. A ledger whose gate says `qualified` without such evidence fails validation (a
  fabricated success), and a ledger that keeps `pending` once the evidence exists fails too, so the record is updated
  with the capture's authorization. The product reads the shipped status through
  `runtime_hook_fixtures::claude_gate_status()`.

### Capture procedure (prepared, not executed)

Run only after the user authorizes this specific live run, and record that authorization (who, when, where).

1. Inspect the installed harness version (`claude --version`) and note it; do not change the user's Claude settings.
2. In a throwaway project directory, start one PandaCode Claude run with a build whose `initialize` request fills
   `hooks` with one `PreToolUse` matcher for `Bash` and one callback id (the R0503 registration), with the
   `--include-hook-events` stream PandaCode already requests where the CLI lists it.
3. Prompt a harmless `Bash` call (for example `echo hook-fixture`) so the CLI sends one `hook_callback`; answer it
   with an `allow` decision so nothing else changes.
4. Record the stdio frames of that run (both directions) from the `initialize` request to the first `control_response`
   after the callback, stop the run, and redact anything that is not protocol shape (session ids may stay; no
   account, path or credential).
5. Save the frames as `live/claude-hook-callback.jsonl` with the header
   `{"_fixture":{"provenance":"harness-capture","liveCapture":true,"harness":"claude-code","capturedAt":...,"harnessVersion":...,"authorization":...}}`,
   add the ledger input with `capture.form: "live"` and the same authorization, and set the gate to `qualified` with
   that authorization. `validate` then confirms the evidence; if it does not, the gate stays pending.

Bounded: one run, one prompt, one callback, a throwaway directory, no settings file written, no retries.
