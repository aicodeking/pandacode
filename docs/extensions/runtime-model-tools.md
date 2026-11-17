# Model tools served by a package service (runtime slice R0701)

Native owner: `src-tauri/src/extensions/runtime_model_tools.rs`. Preview twin: `src/extensions/runtime-model-tools.ts`.
Fixtures: `tests/fixtures/extensions/runtime-model-tools/` (`extension.json` + `main.cjs`, the package `sample.memory`
named "Memory"; `cases.json`, the shared refusal, argument, envelope and collision cases both folds read; all
`synthetic`). Spec: `tests/extensions-runtime-model-tools.spec.ts` (preview/Node column). Native:
`runtime_model_tools::tests`.

A package with a background service offers tools to the model:

```json
"permissions": ["runtime.service", "tools.model"],
"runtime": { "kind": "node", "entrypoint": "main.cjs", "service": { "start": "onEnable" } },
"contributes": { "modelTools": [{
  "id": "sample.memory/memory", "name": "memory",
  "description": "Add, search, list and forget memories of this project.",
  "inputSchema": { "type": "object", "required": ["mode"], "properties": { "mode": { "enum": ["add", "search", "list", "forget"] } } },
  "timeoutMs": 30000, "approval": "mode"
}] }
```

```js
exports.service = async panda => {
  panda.modelTools.register('sample.memory/memory', async (input, call) => {
    return { content: { added: 1 } };            // always the envelope; { content, isError: true } is an error result
  });
};
```

## Declaration

| Field | Rule |
|---|---|
| `id` | `<manifest id>/…`; `panda.` is `ReservedId`, another prefix `InvalidId`, a repeat `DuplicateId` |
| `name` | what the model sees, `^[a-z][a-z0-9_]{0,47}$` (`InvalidShape`); the prefix `pandacode_` is `ReservedId`; a repeat in the package `DuplicateId` |
| `description` | 1 to 1,024 characters |
| `inputSchema` | JSON Schema with top-level `type: "object"`, at most 16 KiB (`LimitExceeded`) and only keywords the host applies: `type`, `properties`, `required` (names must exist in `properties`), `enum`, `items`, `additionalProperties`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, plus annotations; `$ref` and other keywords are `InvalidShape`; nested at most eight deep |
| `timeoutMs` | 100 to 600,000, default 30,000 |
| `approval` | `mode` (default: asked or not as the task's mode says) or `never` (declared at install: no prompt) |

At most 16 tools per package (`LimitExceeded`); a background service is required (`UnsupportedRuntime`) and so is the
`tools.model` permission in the manifest (`PermissionDenied`). `check` (native) and `checkModelToolDeclarations` (twin)
answer the same first refusal. `contributes.toolServers` is not part of this slice.

## Registration, listing and name collisions

`panda.modelTools.register(id, handler)` asks the host: an id the manifest does not declare answers `UnknownReference`,
a package without the `tools.model` grant `PermissionDenied`, a second handler of one id `DuplicateId`. The answer says
whether the tool is `available`; a package whose `name` an earlier enabled package already holds is not listed and the
answer carries `conflict: { name, heldBy }` (the earlier package wins; order is the manager's). Disposal unregisters; the
end of the service (stop, crash, disable, uninstall, safe mode, revoked `runtime.service`) removes every handler.

The inventory is one list (`ModelTools::listed(project)`): tools of enabled, trusted packages outside safe mode whose
`tools.model` grant reaches the run's project, checked natively on every listing and every call, so a revoked or
narrowed grant, a disable and safe mode remove the advertised tools from the next run and make a late call answer
`NotFound`. The same list feeds `core_tools_list` (a package provider's `core.tools.list()`: the app's tools plus, when
the provider's package holds `tools.model`, the package tools, each with `needsApproval`); R0703 qualifies the provider
`core.tools.call` over the supported paths.

## The call

`with_model_tools` (called in `build_task_host`, inside `with_result_hooks`) adds the listed tools to the run's tool
host, so the per-run tool server shows them beside the `pandacode_*` tools to every harness that receives that host. A
tool whose `approval` is `mode` joins the host's approval catalog, so the harness asks like for any tool: that request is
the `tool.before` the deciding hooks see (R0505), and the outer result hooks deliver `tool.after` (R0504). Then:

1. The tool is looked up again and its grant checked now (`NotFound`: disabled, revoked, unknown).
2. The arguments are validated against `inputSchema` (`InvalidShape`; never reach the service); 256 KiB at most.
3. No handler registered (the service is not running) is `HostUnavailable`, at once.
4. The frame `{ kind: 'modelTool', toolId, input, call }` goes to the service as an awaited host call, with `call` =
   `ModelToolCall` (`callId`, `taskId`, `projectId`, `projectRoot`, `cwd`, `harness`, `model`, `mode`, `run`). No answer
   inside `timeoutMs` is `Timeout`.
5. The answer must be `{ content, isError? }` and nothing else (`InvalidShape`); the compact UTF-8 JSON of `content` is at
   most 64 KiB (`LimitExceeded`). `isError: true` gives the model an error result carrying the content.

Every failure is an error result with a line naming the tool and the package; none hangs the turn. The transcript gets
the line "`<Package>` served `<tool>`." for each served call (the attributed row; the twin's `attributedRow` is the
preview's version).

## Limits and pending

- **Pending decision A5**: offering package tools to ZCode through the per-session MCP bridge in `architect.rs` is not
  decided and not wired; ZCode gets no model tool. Pi and omp go through the bridge as the other tool-host harnesses do.
- `tool.owner` of a package tool's `tool.after` payload is still `panda.core` (`with_result_hooks` sets it); the owner
  is available as `runtime_model_tools::registry().owner_of(name)` for that one-line change.
- Package order for a name collision is the manager's order, not an enable timestamp (none is recorded).
- Native fixtures and the twin read the same `cases.json`; installed-service qualification with `sample.memory` and any
  real harness capture: pending, not claimed. No harness was run. Tests were written, not run.
