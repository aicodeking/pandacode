# Tool servers declared by a package (runtime slice R0702)

Native owner: `src-tauri/src/extensions/runtime_tool_servers.rs`. Preview twin: `src/extensions/runtime-tool-servers.ts`.
Fixtures: `tests/fixtures/extensions/runtime-tool-servers/` (`extension.json` + `main.cjs`, the package `sample.docs` named
"Docs"; `server/index.mjs`, a real stdio MCP server; `server/silent.mjs`, one that never answers; `cases.json`, the
refusal, placeholder and address cases both folds read; all `synthetic`). Spec: `tests/extensions-runtime-tool-servers.spec.ts`
(preview/Node column). Native: `runtime_tool_servers::tests`.

A package declares a server the host starts and attaches to the runs of the projects it was granted:

```json
"permissions": ["runtime.service", "tools.model"],
"runtime": { "kind": "node", "entrypoint": "main.cjs", "files": ["server"], "service": { "start": "onEnable" } },
"contributes": { "toolServers": [
  { "id": "sample.docs/local", "title": "Docs", "transport": "stdio", "command": ["{node}", "{package}/server/index.mjs"] },
  { "id": "sample.docs/hosted", "title": "Docs (hosted)", "transport": "http", "url": "http://127.0.0.1:8765/mcp" }
] }
```

No background service is needed to serve a tool server (the package may have none); `server/` must be listed in
`runtime.files` for a `{package}` path to exist.

## Declaration

| Field | Rule |
|---|---|
| `id` | `<manifest id>/…`; `panda.` is `ReservedId`, another prefix `InvalidId`, a repeat `DuplicateId` |
| `title` | 1 to 80 characters; names the server in the transcript and the tool row |
| `transport` | `stdio` or `http` (`InvalidShape`) |
| `command` | `stdio` only: 1 to 16 non-empty strings of at most 1,024 bytes; the only placeholders are `{node}` (the pinned runtime) and `{package}` (the code folder), anything else in braces is `InvalidShape` |
| `url` | `http` only: `http(s)://host[:port]/…`, at most 2,048 characters, no user information, no whitespace |
| `authentication`, `credential` | `http` only (R0703 attaches them): `none` (default), `bearer` or `header`, with `credential` `{ source: "secret"\|"entered", key }` or `{ source: "held", id }`. A `stdio` server with either field is `InvalidShape`: a held value never reaches a package process's arguments or environment (ADR-0006) |

At most four servers per package (`LimitExceeded`) and the `tools.model` permission in the manifest (`PermissionDenied`).
`check` (native) and `checkToolServerDeclarations` (twin) answer the same first refusal.

## Who is offered a server

`ToolServers::listed(project)` is the only inventory: tools of enabled, trusted packages outside safe mode whose
`tools.model` grant reaches the run's project, checked natively on every listing. A run of a project without the grant
gets no slot; a revoked or narrowed grant, a disable and safe mode remove the slots (see Lifecycle).

## Lifecycle and bounded state

`attach_run(run, project, cwd)` (called from `with_tool_servers`, beside `with_model_tools` in `build_task_host`) replaces
the run's slots with one per listed server (at most 32). The state of a slot is one of:

- `attached`: a `stdio` server answered the host's handshake (`initialize`, `tools/list`; 10 s, 256 KiB of answer, at
  most 64 tool names, process always ended before the probe returns, no more than one probe process alive per call,
  stderr discarded, `NODE_OPTIONS` and `PANDACODE_*` removed from its environment); an `http` server is attached as
  declared and the platform never contacts it.
- `failed`: the command could not be resolved or launched, answered an error or timed out. The slot keeps a short code
  and a line of at most 200 characters; one transcript line names the package; the server is not handed to the harness
  and the turn is never blocked.
- `stopped`: `stop` ended it for this run; `start` and `restart` launch it again, at most 5 times per slot
  (`LimitExceeded`) and only while the package is still listed (`PermissionDenied`).
- `credentialPending`: an `http` server with a declared credential. Held-header attachment is R0703's, after R0805; this
  slice never attaches it and never hands the server to a harness.

`reconcile()` drops exactly the slots whose package is no longer listed for the run's project (a revoked or narrowed
grant, a disable, safe mode, an uninstall); every other slot, of the same package in another project and of other
packages, is untouched, and no unrelated process is stopped. `detach_run` ends one run's slots.

## Attachment, approval, hooks and attribution

`mcp_entries(run, shape)` is what a harness is given for one run (`claude`: an `mcpServers` map entry, `codex`: a
`[mcp_servers]` entry, `acp`: an `mcpServers` array entry). The entry name is `pkg_<owner>__<server>`, so the tool row
`mcp__pkg_<owner>__<server>__<tool>` names the package (`attribution` maps it back to the package and the server title).
The harness calls the server itself: every call passes the harness's own approval request, which is the `tool.before` the
deciding hooks see (R0505), and the hooks see the call as that harness reports it (the host cannot know the tools before
the run). A stdio entry carries the resolved command and an empty `env`; no value PandaCode holds is ever in it.

## Limits and pending

- **Provider seam**: `with_tool_servers` registers the run's slots and the entries are ready, but the per-run providers
  (`mcp_host.rs`, `warm.rs`, `codex_preload.rs`, `acp.rs`) do not read `mcp_entries` yet: reading them is a provider-owned
  change (new `ToolHost` field and every launch shape). Until it lands, the slots, bounded states and transcript lines
  are real and the attachment itself is pending. Not claimed.
- **Pending decision A5**: ZCode's per-session bridge stays unwired; ZCode gets no tool server.
- The probe discovers the tools and proves the connection; the harness launches its own process from the entry. No process
  is kept by the host between probes, so the only live process count is `live_probes()` (0 outside a probe).
- R0703 owns held credentials (HTTP header only) and the installed-service qualification; no real harness was run and no
  dependency was downloaded. Tests were written, not run.
