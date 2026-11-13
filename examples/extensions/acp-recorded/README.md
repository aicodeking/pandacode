# Recorded ACP adapter (experimental API 1)

ZIP **only** `package/extension.json` and `package/main.cjs` at the archive root.
Install in Settings → Extensions → Install local package, review executable trust,
enable, and select **Recorded ACP → Recorded ACP frames → Standard**. Send a prompt;
the replay emits `Hello` and asks permission for the recorded `pwd` operation.
Accept or reject it. No command is executed in either case. Resume uses native ID
`saved`; another saved ID fails rather than silently opening a new conversation.

The package is standalone: no SDK installation, private core import, credentials,
process spawn, network, automatic install script or external dependency. Trusted
code nevertheless runs with the user's OS-account authority; API scope is not an
OS sandbox. Disable/safe mode stops future managed runs without removing history.

## Provenance and capability boundary

Checked official ACP v1 [session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), and
[permission](https://agentclientprotocol.com/protocol/v1/tool-calls) documents on
2026-11-13 against PandaCode's `providers/acp.rs` and recorded engine tests.
`main.cjs` embeds only the already-characterized shortened ACP frame shapes from
`tests/fixtures/extensions/builtin-provider-parity.json` (initialization, session,
text, permission, end-turn). The contract test compares these values exactly.
Those historical shortened recordings omit JSON-RPC envelopes and permission
display names; they are characterization evidence, not full wire captures or a
claim that every current agent implements the same modes/authentication.

The adapter builds ACP v1 initialize/new/resume/prompt requests and once-only
permission responses. `session/resume` is capability-gated; history replay via
`session/load` is deliberately not implemented. `adapt`'s injectable transport is
a local test seam; the installed export always uses the offline recording.
This is not a universal ACP client and cannot be configured to launch a CLI.

Unsupported: authentication (the recording does not contact its advertised auth
method), model/effort/mode switching beyond the one declared configuration,
thinking/tool/usage updates, questions, live steering, team tools, images,
filesystem/terminal reverse RPCs, native slash/skills, goals, client extensions,
session/load history replay, and remote placement. Unsupported incoming operations
fail with a reason rather than fake success; no unsupported capability is advertised.
Stop is core supervisor cancellation/reaping, **not** a claimed graceful ACP
`session/cancel` exchange. Core's generic conversation API can deliver steering;
this limited replay rejects it if received while awaiting permission.

## Offline versus live verification

`node --test tests/extensions-provider-contract.test.mjs` verifies this package
without a CLI, account, network or running app. Native tests install its real ZIP
contents, check trust and registration, and run it through the supervised host.
Live smoke remains a separate explicit opt-in using the existing ignored native
installed-CLI tests (for example `cargo test --locked --manifest-path
src-tauri/Cargo.toml --lib installed_devin -- --ignored`). Such tests can use
accounts/network and create conversations; inspect their requirements first.
They are never called by this package or offline conformance and were not run
for this example. Installed WebView/platform qualification remains separate.
