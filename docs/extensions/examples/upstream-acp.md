# Example: a CLI provider as an author package (`sample.upstream-acp`)

Task S07A. The package at `examples/extensions/upstream-acp/package/extension.json` declares one ACP harness with
`contributes.providers[].launch` (R0801, [runtime-provider-launch.md](../runtime-provider-launch.md)) and two models,
one with efforts and `speedTiers` (S0606). It contains no code and no second protocol state machine: the launched
program is the Node fake agent `tests/fixtures/extensions/backends/fake-agent.mjs`, a thin entry over the adopted B5
state machine. The spec `tests/upstream-acp-example.spec.ts` substitutes `__FAKE_AGENT__` with its real path.

## What is expressed with today's contract

| Need | How | Evidence in the spec |
|---|---|---|
| Install and trust | One manifest, executable trust at install, no runtime, no activation event | package validates; a `runtime` plus activation of the launch provider is refused |
| Composer and trace | `session/update` becomes the core `text`, `thinking`, `tool`, `usage` events; permission requests become `approval` | a scripted turn with a tool and a permission answered both ways |
| Queue | The core queue serializes sends; the agent refuses concurrent prompts on one session | a second prompt sent while one runs fails explicitly, then runs after the first ends |
| History | Events are the core's; the package persists nothing | the ordered event list of two turns on one session |
| Model selection | `models` with `efforts`, `contextWindow` and `speedTiers`; the picker shows the Speed row | the manifest declares them and validates; forwarding is G1 |
| Resume | The host asks `session/resume` or `session/load` only when the agent advertises it; otherwise the explicit error "cannot resume saved tasks" | the fake agent advertises neither, the spec checks the capability answer the rule reads |
| Cancel | `RunInput::Stop` sends `session/cancel`; the turn ends `stopReason: "cancelled"` | a sleeping turn cancelled |
| Error fallback | A JSON-RPC error ends the turn; a missing executable is an `ExecutableMissing` readiness error | a scripted failure; `resolveLaunch` with a missing program |

## Gaps (for S07C, consumed by R1212)

Each gap has a minimal reproducer, the owner and the runtime phase that closes it, or a local existing-contract
fix. None is closed by this task (no Rust was touched). ADR-0005 and ADR-0006 apply: none is a security refusal.

| Gap | Need the author cannot express | Minimal reproducer | Owner / phase |
|---|---|---|---|
| G1 | Model, effort, speed tier and mode chosen in the picker reach the agent | Pick `deep` with effort `high` and tier `fast`; read `FAKE_AGENT_LOG`: `session/new` carries none of them, no `session/set_model` or config frame is sent (`RunConfig.model`, `reasoning_effort`, `mode` are unused by `runtime_provider_launch::drive`) | Local existing-contract fix in `runtime_provider_launch.rs` (send `session/set_model` / config options the agent advertises); tier availability and defaults R0806, R0807 |
| G2 | Resume saved tasks and replay history | Resume with a saved id: `initialize` returns `sessionCapabilities: {}` and no `loadSession`, so the run ends with "This ACP harness cannot resume saved tasks" | The agent must advertise it (fake agent: B5 owner R0104A, short edit); host-side history replay after `session/load` has no owner yet: R0404 (task control) |
| G3 | Live steering of a running turn | Send a steer while a turn runs: `UnsupportedCapability: this declared ACP harness cannot take live steering` | ACP v1 has no frame; queue-and-send-after is the core's fallback; R0404 if a package-level steer is wanted |
| G4 | Ship the launched script inside the package | `command: ["{node}", "{package}/agent.mjs"]` fails with `UnsupportedRuntime: ... runtime.files`; a package with `runtime` is `executable` and then needs a handler or service | R0105 code folders joined to launch (`{package}` resolution); local fix in `launch::facts` |
| G5 | Give the launched harness the host's tools and package tool servers | `session/new` always carries `mcpServers: []` | Model-tool slices R10xx (tools.model) |
| G6 | Report limits, accounts and per-turn usage of the CLI | Only `usage_update {used,size}` is read; no limits or account row appears for the provider | R0204 read side exists for built-ins; package-reported limits R0806 |
| G7 | Sign in the CLI and pass it credentials | The `env` map is fixed text; no host-run sign-in, no held credential attached (ADR-0006: never the value in the environment) | R0803 (sign-in), R0805 (held credentials used without being read) |
| G8 | ACP questions and compaction | The shared interpreter answers `question` and `compact` steps with `UnsupportedCapability`; no mapping from an agent's question frame to the core question event | Local existing-contract fix in the ACP event translation (`updateEvents` twin and `runtime_provider_launch.rs`) |

## Run it

Install the package through Settings, Extensions (review executable trust), replace `__FAKE_AGENT__` with a real ACP
program, enable, choose the provider and model in the composer. The preview column is the spec (written, not run
here); native installed evidence is `runtime_provider_launch::tests::installed` of R0801. A real CLI smoke needs the
user's explicit authorization and was not run.
