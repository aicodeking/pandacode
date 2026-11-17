# Declared ACP harnesses (`contributes.providers[].launch`)

Runtime slice R0801. A trusted package declares a harness by executable and protocol, with no adapter code. Code:
`src-tauri/src/extensions/runtime_provider_launch.rs` (native), `src/extensions/runtime-provider-launch.ts` (the
preview's twin), the fixture `tests/fixtures/extensions/runtime-provider-launch/`, and the reusable Node fake agent
`tests/fixtures/extensions/backends/fake-agent.mjs`.

```json
"providers": [{ "apiVersion": 1, "id": "sample.agent/fake", "name": "Fake agent", "models": [],
  "launch": { "protocol": "acp", "command": ["{node}", "{package}/agent/agent.mjs"], "env": { "FAKE_AGENT_LOG": "{data}/frames.log" } } }]
```

## Contract

- `launch.protocol` is `"acp"`, the only value. The host speaks it as it does to a built-in ACP harness: `initialize`
  (protocol v1), `session/new` or a resume, `session/prompt`, `session/update`, `session/request_permission` and
  `session/cancel`. `command` is an argument list of 1 to 32 strings (at most 1,024 characters), never a shell string.
  `env` is a string map of at most 32 entries.
- Placeholders: `{node}` is the packaged Node runtime, `{data}` the package's data directory (created on first use),
  `{package}` the package's code folder. `{package}` resolves once `runtime.files` is materialized (slice R0105, not yet joined here); until
  then it is an explicit readiness error, so a launch command that names no `{package}` path needs no `runtime`.
- `models` may be empty: the catalog is whatever the manifest lists, and the model picker offers none until the package
  reports some. Any model id is accepted for a run while the list is empty.
- Admission: a launch provider is not an executable activation. The executable set is built from `runCommand`
  commands and providers **without** `launch`; a launch provider needs no `activationEvents` entry, no handler and no
  `runtime`. The package still holds an executable trust decision (`ExecutableTrustRequired` on enable) because the
  command is code the user's computer runs.
- Nothing starts ahead of a send. Discovery, the model picker, drafts and the catalog read only the manifest and
  resolve the command (no process); the process starts in the run (`dynamic_harness::run`), as handler packages do.
- A credential PandaCode holds is never placed in the launched program's environment (ADR-0006). The environment is
  the app's own plus the manifest's fixed `env` text.

## Readiness

The provider's `metadata.readiness` stays the manifest's when it is not `ready`. When it is `ready`, the host replaces
it with what resolves right now, so the model picker and the send path show one explicit error:

| Situation | Error |
|---|---|
| Executable content not trusted (installed, not trusted) | `ExecutableTrustRequired: review this version ...` |
| Protocol missing | `InvalidShape: ... declares no protocol.` |
| Protocol other than `acp` | `UnsupportedCapability: launch protocol ... is not supported` |
| Command not found / not a file | `ExecutableMissing: ...` |
| `{node}` / `{data}` / `{package}` unavailable | `UnsupportedRuntime: ...` |

## Shared package state

All runs of one package share one `State` (a single token manager): tokens issued, handshakes, active and peak runs,
finished runs, whether the package also declares a background service, and the readiness states observed in order
(consecutive duplicates collapsed). Two concurrent conversations of the same package see the same state, never two.

## Events

`session/update` becomes the core conversation events (`text`, `thinking`, `tool`, `usage`); text is split into
chunks of at most 8,000 characters. A permission request becomes a core `approval` event; the user's answer picks the
`allow_once` or `reject_once` option (or the `always` variant, else `cancelled`). `RunInput::Stop` sends
`session/cancel` and ends the process after a 3 s grace. ACP v1 has no steering frame, so `Steer` answers
`UnsupportedCapability`. The host adds no MCP servers to `session/new` here (`mcpServers: []`); host tools for launched
harnesses belong to the model-tool slices.

## Fake agent

`tests/fixtures/extensions/backends/fake-agent.mjs` is a four-line entry over the adopted B5 state machine
(`backends/fake-agent/fake-agent.mjs` and `core/scenario.mjs`); it has no protocol code of its own and runs with
`node` on Windows, macOS and Linux. Stdout is ACP JSON-RPC only, readiness is one JSON line on stderr, and it stops on
stdin EOF. `FAKE_AGENT_LOG` appends every received frame (the handshake record).

## Tests

- Preview column: `tests/extensions-runtime-provider-launch.spec.ts` (both engines): manifest admission, placeholder
  and readiness rules, the shared state, event translation and the fake agent over real stdio.
- Native: `runtime_provider_launch::tests` (rules) and, under the feature `extension-runtime-native-tests` on
  Windows x64, `runtime_provider_launch::tests::installed`: a really installed package with an empty model list
  launches the fake agent, two concurrent conversations share one state, and a missing executable, an unsupported
  protocol and an untrusted package each give their readiness error.
