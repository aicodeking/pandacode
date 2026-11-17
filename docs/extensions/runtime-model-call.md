# One bounded model answer: `panda.models.call` (runtime slice R0704)

Native owner: `src-tauri/src/extensions/runtime_model_call.rs`. Preview twin: `src/extensions/runtime-model-call.ts`.
Fixtures: `tests/fixtures/extensions/runtime-model-call/` (`extension.json` + `main.cjs`, the package `sample.ask`
named "Ask"; `cases.json`, the option cases both folds read; all `synthetic`). Spec:
`tests/extensions-runtime-model-call.spec.ts` (preview/Node column, hidden runs answered by the scripted fake agent B5).
Native: `runtime_model_call::tests`.

A package service asks the model one question and gets one answer:

```json
"permissions": ["runtime.service", "models.call"]
```

```js
exports.service = async panda => {
  const { text, harness, model, usage } = await panda.models.call({ prompt: 'Summarize: ...', system: 'Be brief.' });
};
```

```ts
panda.models.call(options: { prompt: string; system?: string; harness?: string; model?: string; effort?: string;
  projectId?: string; taskId?: string; timeoutMs?: number; signal?: AbortSignal }):
  Promise<{ readonly text: string; readonly harness: string; readonly model: string; readonly usage?: { readonly input?: number; readonly output?: number } }>;
```

## What a call is

- One prompt, one answer: no tools, no session kept, **no task**. It runs through a signed-in harness on the provider
  run path, so it uses the sign-in the user already has and spends the user's quota. It is a hidden run: nothing
  appears in the sidebar, and `taskId` only chooses defaults and the usage label; nothing is added to that task.
- `harness` and `model` default to those of `taskId`, otherwise to the user's defaults for `projectId` or for new tasks.
- Permission `models.call` (global), rechecked natively when the call arrives. No confirmation per call (ADR-0005);
  the harness's credential is never seen by the package (ADR-0006).

## Options

| Field | Rule | Refusal |
|---|---|---|
| `prompt` | non-empty string, at most 256 KiB | `InvalidShape`, `LimitExceeded` |
| `system` | string, at most 64 KiB | `InvalidShape`, `LimitExceeded` |
| `harness`, `model`, `effort`, `projectId`, `taskId` | non-empty string of at most 128 characters | `InvalidShape` |
| `timeoutMs` | integer 1,000 to 600,000, default 60,000 | `InvalidShape` |
| anything else | not an option | `InvalidShape` |

`signal` stays in the service: aborting it asks the host to cancel the call (`modelsCall` `cancel`).

## Admission and ending

| Situation | Result |
|---|---|
| Fewer than two calls of the package run | The call runs |
| Two run, fewer than eight wait | The call waits, in arrival order; a freed slot starts the first waiting call |
| Two run and eight wait | `LimitExceeded` at once |
| `timeoutMs` passes (the wait and the run together) | `Timeout`; the hidden run is dropped, which ends its process |
| The service aborts the call | `Cancelled` (a waiting call leaves its place, a running one frees its slot) |
| `models.call` revoked, package disabled, safe mode on, or the service stopped | The package's calls end with `PermissionDenied` |
| The harness signs out | Calls that use it (or default to a harness that may be it) end with `HostUnavailable`; a signed-out harness at the start answers `HostUnavailable` |
| The harness has no hidden-run path | `UnsupportedCapability`, explicit, never a hang |
| An answer above 256 KiB | `LimitExceeded` |

## No hooks, no recursion, no task

The run is handed `RunRequest { owner, package_name, options }` and nothing else: no tool host (so no model tool of any
package and none of the app's tools can be called), no hook registry (`prompt.submit`, the R0503-R0506 chain, and every
other event never fire for it, so a handler that calls a model cannot call itself), no session and no task id. This is a
shape the type enforces, not a flag a caller could forget; the spec asserts the keys.

## Usage

Each served call adds one record `{ kind: 'models.call', owner, package, harness, model, input, output, taskId }` to a
bounded log (500). The usage view labels the spend with the package name; it never stores the prompt or the answer.

## Scripted harness (B5)

B5 answers a prompt that starts with `#reply ` with the rest of the line; `#script [{"sleep":N}]` keeps a turn open for the
cancellation case. The spec starts B5 over stdio ACP, one session with no tool server per call, and ends it by stdin EOF.

## Status

| Column | State |
|---|---|
| Preview / Node (spec) | Written, not run (deferred to the final test phase) |
| Native (`runtime_model_call::tests`) | Written, not run |
| Installed app with a signed-in harness | Pending, not claimed |

The native hidden-run path of the provider run path is attached with `runtime_model_call::registry().set_run(...)`; until
it is, a call answers `UnsupportedCapability`.
