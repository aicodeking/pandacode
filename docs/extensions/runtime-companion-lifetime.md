# Per-run host companions (R0601 lifecycle)

Status: integrated lifecycle foundation. Native launches hold a run guard and publish explicit unsupported
observations until qualified adapters exist. Tests are written and deferred. This does not deliver every-tool
coverage. No real harness has been run or qualified.

Native owner: `src-tauri/src/extensions/runtime_companion_lifetime.rs`. Preview/fixture twin:
`src/extensions/runtime-companion-lifetime.ts`. Shared synthetic fixtures:
`tests/fixtures/extensions/runtime-companion-lifetime/`. Spec: `tests/extensions-runtime-companion-lifetime.spec.ts`.

## Identity and admission

One host registry admits at most one companion for a `(taskId, runId)` pair. Use the native launch's UUID as `runId`,
never the task ID alone, provider conversation/resume ID, or a timestamp. Native identities include a random host
instance UUID and a monotonic generation. The twin receives a unique host instance from its fixture/preview owner.

Ended keys remain tombstones for the host lifetime, including end-before-start. A delayed version probe cannot
reopen an ended run. A new run of the same task gets a new key, directory and identity. A second begin for the same
key returns `Conflict` without preparing more resources. Identical keys in different host instances do not share leases.

Only the host supplies profiles, installed-API observations, admitted hook owners and resource factories. A package
cannot choose another package's identity or construct profiles through IPC. Admission must use the existing native
hook matches and current project/tool grants. This library does not replace those checks or approve a tool call.
The caller must serialize admission, revocation and resource operations; resource methods must not reenter it.

`current(expected, presented)` compares the host's expected task/run with the whole presented identity and active
state. Check before delivery and again after awaiting a decision. A lease is a correlation identity, **not an
authentication credential**. Do not expose this check as a network authentication protocol.

## Version negotiation and reporting

A profile names one harness, explicit versions, the required installed API, protocol version and evidence column.
Protocol 1 is implemented. A missing profile, unrecognized version, unknown installed version, absent API or different
harness returns `UnsupportedCapability` with a reason. No directory/resource factory runs in these cases.
Exact version lists are intentional: a source commit is not an installed release range; OpenCode V1 and V2 need
different adapters. Later qualification can explicitly extend a profile's version list.

Reports retain `ordinaryApprovals: "unchanged"`. Failure to prepare a companion is `HostUnavailable`; it never changes
mode, permissions or the ordinary prompt. The caller continues the existing provider launch without injection.
The registry reports a monotonic `revision`, capability rows, active count, safe mode and cleanup-pending count.
Its projection contains no environment, directory paths, lease IDs or credential values. The harness report includes
this projection as `companionLifecycle`; existing `toolBefore` coverage is unchanged by this work.
States `ready`/`active` describe lifecycle admission, not hook enforcement or installed qualification.

The shared profile is explicitly `synthetic`, for harness `fixture`, version `1.0.0` and API
`fixture.perRunPlugin.v1`. It is not an implementation or qualification of Codex, OpenCode, Kilo, Claude, Pi or Cline.
The source-feasibility findings in `PLAN-harness-capabilities.md` remain source evidence only.

## Delivery and teardown

`DirectoryResources::prepare` creates one unique child of an already-existing absolute app-owned root. It writes
only host-bundled flat artifacts and `run.json` there, publishes the descriptor last, and returns the child-only
`PANDACODE_COMPANION_MANIFEST` environment entry. The caller must pass an app-owned root, not a project/user CLI
directory. Unix directories/files use 0700/0600. There are no credentials in the descriptor.
The fake harness understands this variable. Real adapters must translate their qualified recipe into the CLI's
documented run-only environment/flags/session layer; actual CLIs do not understand this fixture variable.
No global process environment is changed. No user or project config is opened, rewritten, backed up or merged.

`Resources` is the native host adapter's ownership boundary. `close` must withdraw its descriptor/injection,
cancel and drain handlers, close any future endpoint, then remove owned artifacts. Cleanup is idempotent and
retryable. The directory-only implementation has no handlers or sockets. An adapter with handlers must own their
cancellation/drain mechanism as well; the fixture demonstrates stdin EOF followed by awaited child exit.
Factories must roll back partial preparation when they fail. Native directory preparation attempts cleanup and
reports a separate error if cleanup also fails; durable orphan recovery after a host crash remains open.

Run end, disable, grant revoke/narrow, service failure, safe mode and shutdown invalidate leases **before** cleanup.
Cleanup failures retain a retryable resource and `cleanupPending`; they never restore validity. Turning safe mode off
does not reopen old keys. If one contributing owner disappears, the whole shared run lease ends; other packages keep
ordinary approvals and get a newly evaluated companion on the next run. Unrelated owners/runs remain active.
Use `RunGuard` in the run future to cover returns, cancellation and unwind. Explicit shutdown must call `stop` because
process-static registries are not destructed at process exit. Retry cleanup after handlers/children have drained.

An inherited environment cannot be erased from a running child. Revocation means that the descriptor is withdrawn,
the host rejects the old lease, and owned handlers close. An already-loaded real plugin needs its own inert/fallback
behavior after disconnection. Do not keep a companion-bearing process/thread in warm/preload/spare pools across runs.
The current directory remover visits only registered files and its own directory; it never recursively deletes a root.

## Deferred callback channel

This slice opens no loopback listener and mints no callback credential. It forwards no tools and changes no approval
answer. A later transport needs its own per-run credential, binding to the expected task/run/lease, cancellation and
late-answer rejection, event-specific R0505 semantics, and an explicit disconnect/failure fallback. Credentials must
remain in the child process, never extension services, public projections, config, fixtures, output or logs.
Codex pre-tool rewriting and approval events are distinct; a successful OpenCode/Kilo before-hook return is not an
approval. The lifecycle module makes no contrary claims about these APIs.

## Evidence and deferred checks

Written native tests cover exact-version/API negotiation, cross-run/host identities, duplicate admission, early-end
tombstones, all stop causes, independent owners, retryable cleanup, and native directory/config-byte preservation.
The Node/Playwright spec writes two disposable config canaries, starts only the fake Node harness with hidden windows,
checks one load in the intended run, refuses mismatched task/run loads, checks ordinary approvals remain available,
and verifies EOF/handler drain, descriptor withdrawal, stale identity rejection and byte-identical canaries.
It uses no browser page or real CLI. Fixtures are not a second agent protocol; they model only plugin loading/lifetime
and do not introduce an ACP, model, approval or tool-execution backend.

The three fixture `.cjs` files passed `node --check` during the first-stage implementation. The second stage
registers the native module, run guard, disable/update/revoke/service/safe-mode/shutdown teardown, coverage projection,
and this spec in both Playwright configurations and CI (ports 16991/16992). Compile results are recorded in the task's
proposal report and runtime receipt. Native tests and Playwright cases are written, not run (deferred to the final
test phase). R0602-R0606 remain open: real per-CLI adapters and callback transport are not delivered. Installed-service
acceptance and real-harness/platform qualification remain pending.
