# Package tools across the provider paths (runtime slice R0703)

Native owner: `src-tauri/src/extensions/runtime_model_tool_parity.rs`. Preview twin: `src/extensions/runtime-model-tool-parity.ts`.
Fixtures: `tests/fixtures/extensions/runtime-model-tool-parity/` (`extension.json` + `main.cjs`, the package `sample.parity`
named "Parity" with three model tools and four tool servers; `scenarios.json`, the run paths, capability rows, tool-server rows
and the sentinel held values both folds read; all `synthetic`). Spec: `tests/extensions-runtime-model-tool-parity.spec.ts`
(preview/Node column). Native: `runtime_model_tool_parity::tests`. Builds on `runtime-model-tools.md` (R0701),
`runtime-tool-servers.md` (R0702) and `runtime-held-credentials.md` (R0805). ADR-0005 and ADR-0006 govern.

## What a harness gets

`row(harness, isPackage)` and `matrix(harnesses)` say, per harness and per run path, how package tools reach the model:

| Family (harnesses) | Model tools | Tool servers (entry shape) |
|---|---|---|
| `claude` (claude, glm, mimo, alibaba) | per-run MCP host, `--mcp-config` | `claude` (`mcpServers` map entry) |
| `codex` | per-run MCP host, `mcp_servers` config | `codex` (`[mcp_servers]` entry) |
| `acp` (kimi, opencode, antigravity, grok, deepseek, commandcode, cline, kilo, github-copilot, devin, hermes, cursor) | per-run MCP host, `session/new` | `acp` (`mcpServers` array entry) |
| `pi` (pi, omp) | Pi extension bridge | `UnsupportedCapability` |
| `muse` | host tools | `UnsupportedCapability` |
| `zcode` | `UnsupportedCapability` (decision A5) | `UnsupportedCapability` (decision A5) |
| package provider | `core.tools` | `UnsupportedCapability` (it reaches tools through `core.tools`) |
| unknown id | `UnsupportedCapability` | `UnsupportedCapability` |

A cell is `{ support, qualification, bridge, code, reason }`; an unsupported one carries `UnsupportedCapability` and the
reason, never a bare no. Qualifications are the ones of `harnesses.list`: `recorded` only where the repository holds frames
(`claude`, `glm`, `mimo`, `alibaba`, `codex`, `kimi`, `pi`, and package providers for model tools), `sourceFeasible`
otherwise, `installedQualified` only through a separately authorized capture (none exists). A tool-server cell is never
`recorded` (no real harness frame carries such an entry) and says `attachment: "entriesReady"`.

Run paths: `task` (user, package, tool), `worker` (team, council), `bot`, `schedule`, `remote` (paired device, cloud) run on
this computer. The `remote` + `mirror` path runs on another computer, which this desktop only mirrors: both capabilities are
`UnsupportedCapability` there.

## Provider `core.tools.list` and `core.tools.call`

`CoreBridge` is what a package provider's `core.tools` reaches: the run's own tool host (`build_task_host`), so a call has the
same approval and the same `tool.after` hook as the model's call.

- `list()` is the host's tool list with `owner` and `needsApproval` (the host's approval set), and it leaves out a package tool
  that is no longer offered (a revoked or narrowed grant, a disable, safe mode, an uninstall). A call to such a tool answers
  `refused / NotFound` with `executed: no` before anything runs, so inventory and execution agree.
- A tool that needs approval is decided by the `Approver` the provider seam attaches, as the harness's own request is: `plan`
  refuses, `full` allows, the other modes ask (`modeVerdict`). A deny wins; with no approver nothing runs (`unavailable`).
  The trace records `tool.before` (asked or not, the verdict) and the handler delivers `tool.after`; no input or result is
  recorded.
- The host never retries a call.

## Honest outcomes

`Outcome` carries `status` (`completed`, `failed`, `refused`, `unavailable`, `interrupted`, `truncated`), `executed`
(`yes`, `no`, `unknown`), `delivered`, a code and a bounded line. `succeeded` is true only for `completed` + `yes` + delivered.

| What happened | Outcome |
|---|---|
| unknown, disabled, revoked, denied, bad input, no service running | `refused` / `unavailable`, `executed: no` |
| timeout, service stopped mid-call, service failed | `interrupted`, `executed: unknown` |
| result past 64 KiB, answer in a shape the host cannot use | `truncated` / `failed`, `executed: yes`, `delivered: false` |
| the tool answered an error result | `failed`, `executed: yes`, delivered |
| a tool server's row reported by the harness | `completed` only with its output and not cut; a `completed` row without output, a reconnect, a cancel or no answer is `interrupted`, `unknown` |

The classifier of a registry error reads the first words of R0701's messages (`The result …`, `… answered …`, `… stopped before
…`, `… failed in …`); a change of those messages must change the classifier and its tests.

## The held credential of an HTTP tool server (ADR-0006)

`attach(ports, run, project, shape)` returns the entries a harness is given for one run. It starts from `mcp_entries` and adds
each `credentialPending` HTTP server whose credential is `{ source: "held", id }` (R0702's declaration):

1. the package must hold `credentials.use` for that item (the user's grant, rechecked each attach): else `credentialDenied`;
2. PandaCode must hold the credential: else `credentialMissing`;
3. `HeldUse::use_credential` records the use (package, version, item, address without its query) before the value leaves the
   store, and the host writes the header: `Authorization: Bearer <value>` for `bearer`, the declared header for `header`
   (`credential.header`, letters, digits and hyphens, default `X-API-Key`). A value that cannot be a header (control
   characters, over 8 KiB) is `credentialInvalid` and nothing is sent.

Shapes: `claude` `{ type: "http", url, headers: { name: value } }`, `codex` `{ url, enabled, http_headers: { name: value } }`,
`acp` `{ type: "http", name, url, headers: [{ name, value }] }`. A `stdio` server is package code and never receives a held
value: its entry is the resolved command, an empty environment and no header, the declaration refuses a credential on it, and
`header_plan` answers none for any non-HTTP declaration. Other credential sources (`secret`, `entered`) stay
`credentialPending` with `UnsupportedCapability` and are not handed over.

The value lives only in `Attachment::entries()`, which is for the harness launch. `states()`, `public_entries()`, the `Debug`
form, the trace, the activity list and `Outcome::json()` never carry it (a held value in a tree becomes `[held]`). The states
name the item and the header, never the value. Package, service and panel results never see an entry.

## Disable, safe mode and a resumed session

`offered_names` is the package tool names a run is offered now (model tool names, `mcp__<server>__<tool>` per attached server,
`mcp__<server>__*` when a server announced none, and every attached credential server). `prune_resumed(previous, known,
current)` removes from a resumed session the package names (known ones and anything `mcp__pkg_…`) that are not offered now,
and `bridge_view` is `{ zeroExtension: true, modelTools: [], toolServers: [] }` when nothing is. A disabled package, a revoked
grant and safe mode therefore leave no stale tool name.

## Limits and pending

- **Provider seam.** The per-run providers (`mcp_host.rs`, `warm.rs`, `codex_preload.rs`, `acp.rs`) still do not read
  `mcp_entries` (R0702's limit). `attach` / `attach_for_run` is the single function they call, with the harness's shape from
  `shape_of`; until a provider-owned change reads it, the tool-server attachment is `entriesReady` and no harness is launched
  with the entries. Not claimed.
- **Provider approval.** The app attaches no `Approver` yet: a provider `core.tools.call` of a tool that needs approval is
  `unavailable` until the provider seam supplies the harness's own request. Tools declared `approval: "never"` and the app's own
  non-approval tools run.
- **Pending decision A5**: ZCode gets no model tool and no tool server.
- Installed qualification with a real harness is pending: no harness was run, no real credential was used, nothing was
  downloaded. Native and preview scenarios use fakes and synthetic sentinel values. Tests were written, not run.

## Refusal dispositions (ADR-0005; Q034)

Changed: a held HTTP tool server is now attached (it was `credentialPending` without an owner); provider `core.tools.call` has a
defined path over the run's approval and hook path. Retained, with a non-security reason: another package's grant, a revoked or
disabled package and a stale name (ownership and coherence of inventory and execution); a held credential on a stdio server
and any export of a held value (ADR-0006); a header that is not a valid header (predictability); an approval-needing tool with
no approver (nothing is approved without a decision); a mirrored run (it executes elsewhere); ZCode (decision A5).
