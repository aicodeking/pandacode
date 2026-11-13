# Executable runtime (experimental trusted-host continuation)

Authoring and selected-folder reload: [Trusted extension development and typed SDK](development.md).

## Current trusted-host decision — Windows x64 only

T24's **experimental Windows x64 local trusted-host slice is verified**: native trust,
broker, faults, cancellation, OS/library access and preview continuity passed in that slice.
The M5 review's final 192-case cohort now passes in each browser after a measured startup
scene-ordering repair. A historical native recovery failure remains unexplained and
installed-target acceptance is still missing. The user accepted the implementation scope
and residual historical recovery risk; installed/native-platform qualification is deferred
outside the implementation run until explicitly requested. Neither is marked passed. This is
**not installed Tauri/WebView2, signing, release or cross-platform acceptance**.

The user-approved executable model is **explicitly trusted code under the normal OS
account**, not a per-extension OS sandbox. Installation, discovery, enable and context
consent do not evaluate package code. Executable trust is separate, with an unavoidable
full-authority warning: user-accessible file read/write, account-available credentials,
network and starting programs. There is no automatic elevation. API grants constrain
supported PandaCode operations, **not independent OS calls**. Revocation stops future
managed activation and signals owned execution; it cannot undo effects or contain
deliberately hostile trusted native code.

Selected runtime: **Node.js v26.1.0 Windows x64**, in its own native child, not linked into
the UI or core process. No new Rust/npm dependency was added. Node's built-in modules,
bundled native SQLite and structured `child_process.execFile` support actual OS/library
integration. Node-API addons are supported by Node itself, but arbitrary addon ABI,
bundled native binaries and arbitrary platform/library compatibility are **not qualified
by this slice**: authors currently supply a single bundled `main.cjs` plus declared static
icons. No install scripts, npm install, automatic module fetch or activation-time runtime
download. Existing package archive/entry/expansion/path/SVG limits remain in force.

The executable descriptor is:

```json
"runtime": {
  "kind": "node", "entrypoint": "main.cjs",
  "activationEvents": ["sample.project-summary/summary"]
}
```

Each event must name an owned command whose action is `{ "kind": "runCommand" }`.
Startup activation is unsupported. Legacy top-level `entrypoint`, `activationEvents`
and `scripts` are deliberately still rejected, never silently converted to trusted code.
Trust binds the complete validated archive SHA-256 (including manifest/version), not a
publisher name or path. Every activation rereads/validates the archive; a changed digest
disables executable eligibility even if an old record said enabled. Review submission
carries the expected digest, preventing a stale review from trusting changed contents.
Trust alone neither enables nor starts the package. Safe mode returns before package I/O.

### Native/public API channel and lifecycle

The app-owned bootstrap runs first; package source is supplied over stdin only after
trust, declared command capture and owned Windows job assignment. The runtime is an
explicit app-resource path, never PATH, a project path or an extension-supplied command.
The environment is cleared except OS bootstrap/temp variables; this is secret hygiene,
not an OS restriction. The normal account can still independently access its resources.

One activation, one process, one unpredictable native-generated channel token and captured
M4 handle. No socket RPC listener or generic Tauri bridge is offered to extension code.
Frames are LE-u32 length + JSON. Incoming frames <=64 KiB, outgoing bootstrap <=300,000
bytes, other replies <=64 KiB, 128 strictly sequential requests per activation, 16 SDK
pending calls, one pending dialog, <=8 active hosts with only one active invocation per
owner. Unknown envelope fields, sequence/token/version errors and unsupported operations
fail closed. No caller/window/project/handle fields from a package select API authority.
The supported `context` requests map only to M4 query/subscribe/events/unsubscribe with
native-injected captured handle and current grant rechecks. Packages cannot consent or
recapture. M4 retains its 50-item page, 5 owned-subscription and revision/gap rules.

The bundled CommonJS entry exports `activate(panda, context)`. `panda.context` offers
`query`, `subscribe`, `events`, `unsubscribe`; `panda.ui.showDialog` accepts the current
M3 dialog definition. It queues a validated host dialog, not HTML/DOM or a callback. The
dialog is committed after successful completion plus native revalidation, then rendered
by the existing host renderer. Its acknowledgement is a queue acknowledgement, not form
input; interactive executable callbacks/SDK development tools belong to later slices.
Captured `commandId` is added to the invocation DTO; navigation cannot retarget it.

Five-second supervision deadline; V8 old-space request 64 MiB; Windows job committed
memory request 384 MiB and kill-on-close. These are **resilience controls, not containment**
or a 384 MiB RSS promise. Job assignment precedes package delivery (the app bootstrap has
already started); no LPAC, ACL/profile provisioning, privilege elevation or weakened
sandbox fallback exists. Helpers normally inherit the job. On success/failure/cancel the
owned job is terminated and direct child reaped; M4 handle/subscriptions are released.
Cancellation before admission is remembered in a bounded 128-ID tombstone buffer. Local
UI cancellation also invalidates its lifetime, suppressing any late dialog. A failure
quarantines that owner/digest; explicit disable/enable retries. Cancellation does not
quarantine unrelated or subsequent independent activations. Core runs are never stopped.

### Private settings and storage (experimental API v1)

Declare `storage.private`, then explicitly allow private storage in Settings → Extensions.
Consent is persisted for that extension version and is independent of executable trust.
Revoking it immediately denies every further supported storage operation and disposes
owned subscriptions. It does **not** deny trusted native code independent access to
user-readable backing files. Do not store host credentials through this API.

The SDK exposes `panda.storage.get/set/remove/snapshot/subscribe/events/unsubscribe/migrate`.
Every operation supplies `scope: 'global' | 'project'`. Project scope always means the
invocation's captured project, never the currently selected project. Owner, project path,
another extension ID and a storage handle are not request fields. A local key can be
identical in different extensions/projects without sharing supported API state. Internal
declarative adapters use the same native operation and captured command identity; M3
settings forms retain their existing validated page namespace and persistence path.

```ts
await panda.storage.set({ scope: 'project', key: 'last-view', value: 'summary' });
const saved = await panda.storage.get({ scope: 'project', key: 'last-view' });
// Missing keys return null. Snapshots/events are copied, versioned JSON, never SQLite/DOM.
const stream = await panda.storage.subscribe({ scope: 'project' });
const changes = await panda.storage.events({
  scope: 'project', subscription: stream.subscription!, cursor: stream.cursor,
});
// A gap or stale cursor sets resync and includes a fresh snapshot. Use the returned cursor.
```

Limits: UTF-8 encoded JSON value ≤16 KiB; namespace values ≤24 KiB/128 keys; key ≤128
bytes; one global and ≤32 project namespaces per extension; **128 KiB total shared with
M3 settings, metadata and the journal**, not 128 KiB per project. A bounded 32-change
journal persists scoped revisions; event output exceeding 24 KiB requests snapshot
resync. At most 64 live storage subscriptions, eight per captured binding, bounded by
the five-minute invocation lifetime. Process activation still has its existing five-second,
128-request/channel budgets. Stream tokens do not survive restart: resubscribe for a fresh
snapshot. Disable, uninstall, safe mode, context release and activation completion end
owned streams without deleting committed data or stopping core agents.

Private state extends the existing `extension-settings-v1/<extension-id>.json` M3 record
with reserved versioned metadata, not a parallel database. Project names are hashed in
namespace keys; neither extension nor project values become file paths. Existing page data
stays readable when adding storage, and storage writes preserve page values. Native writes
stage with exclusive creation, flush, close and atomically rename. A stale `.stage` left
by interruption is **not** promoted or silently overwritten; reads return the committed
record and writes report `StorageUnavailable` pending explicit recovery. Malformed/future
schema data fails closed and is retained, never silently reset. Quotas and failed writes
leave committed bytes unchanged. Core task-history SQLite has no role in this store.

Migration reads a snapshot, computes new values **inside the qualified trusted host**,
and calls `migrate` with its `revision`, `fromVersion`, next `toVersion`, values and explicit
`rollbackCompatible: true`. Native code accepts only bounded JSON output and a matching
revision/version; it never evaluates a migration callback. Failed transforms, stale versions,
false compatibility declarations, oversized output and failed promotion do not commit.
Irreversible migration is unsupported; the author must keep output compatible with rollback.
This declaration is not a proof of arbitrary trusted extension semantics.

Ordinary Uninstall keeps private settings/storage. The separate **Uninstall and remove
private data** action opens a keyboard/Escape-accessible host confirmation with own-data
removal off by default. Only explicit opt-in removes that owner's committed/interrupted
private record after uninstall; other extensions, projects, drafts and history are untouched.
No package-controlled path or wildcard removal is accepted. The supported API has no data
removal or consent method. Reinstall normally restores retained data, not executable trust.

### Packaging, licenses, alternatives and reproducibility

Node's primary license is MIT, with separate bundled dependency terms (including V8,
OpenSSL, ICU and SQLite). Carry the **complete** pinned upstream LICENSE, not merely
the MIT header. Exact verified inputs:

- [Node v26.1.0 LICENSE](https://raw.githubusercontent.com/nodejs/node/v26.1.0/LICENSE):
  SHA-256 `d94dd7496d4de9cd130f1eb6e661e43422483663fd48cf3a450d244b9cda6fdc`.
- `win-x64/node.exe`, 98,778,600 bytes: SHA-256
  `35ebb74da6acb56fdf570de64f1ae510d6d18ca09da494a3e1ac87edd32d263b`, matching
  [the official versioned checksum list](https://nodejs.org/dist/v26.1.0/SHASUMS256.txt).

Local staging copies the already available exact executable plus a supplied local LICENSE,
verifies both pinned hashes, and produces a manifest plus explicit Tauri resource-map
override under `_work/00-tmp/extensibility-trusted-runtime/`. It never downloads a runtime
or modifies a global install. Runtime startup verifies the same hashes. Debug checkout
builds can use that fixed stage. Default `npm run package` / `package:fast` and
`npm run release:build` now stage the pinned local runtime for Windows x64 under
`src-tauri/target/extension-runtime` and pass its resource map to Tauri. Missing or
mismatched inputs fail before Tauri; no runtime is downloaded by these commands.
The release workflow prepares the exact Node version and complete notice at **build
time only**; its remote execution has not been verified by this local review.
Other targets remain declarative-only and receive no runtime resource map.
The map includes **only** node.exe, LICENSE and manifest.json, excluding probes, tests
and local configuration paths. The existing app notices remain in the merged Tauri config.
Raw `tauri build` bypasses the project packaging wrapper: use the project commands or
explicitly pass the verified resource override. Resource staging is not an installed-app
demonstration and does not change the experimental support or executable-trust decision.
No release, signing, installed-app update or external publication was performed.

```powershell
# Build-only resource preparation; no app launch or installation.
$env:PANDACODE_EXTENSION_NODE_LICENSE='<local-Node-v26.1.0-complete-LICENSE>'
# Optional when the build's Node differs: exact local v26.1.0 Windows x64 node.exe.
$env:PANDACODE_EXTENSION_NODE='<local-node.exe>'
node scripts/extensions-runtime.mjs --trusted-bundle
# npm run package, package:fast or release:build use the same staging automatically.
# The native feature gate verifies both the default packaging stage and the separate
# historical checkout stage used by broker/SDK fixtures:
node scripts/extensions-runtime.mjs --trusted-stage <local-Node-v26.1.0-LICENSE>
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --features extension-runtime-native-tests --lib extensions:: -- --nocapture
# Native test cases use the actual app archive/trust/M4 adapters, not the old engine experiment.
$env:PANDACODE_EXTENSION_CASE='native-os' # also loop, timeout, exception, allocation, cancel
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --features extension-runtime-native-tests --lib -- --exact extensions::packages::tests::trusted_native_driver --nocapture
Remove-Item Env:PANDACODE_EXTENSION_CASE
# Verified free port, actual local Chrome; headless, isolated profiles.
$env:PW_PORT='15561'; $env:PW_PROD='1'; $env:PW_WORKERS='1'
$env:PANDACODE_TEST_CHROME='<local chrome.exe>'
npx playwright test tests/extensions-trust.spec.ts tests/extensions-runtime.spec.ts
npx playwright test -c playwright.webkit.config.ts tests/extensions-trust.spec.ts tests/extensions-runtime.spec.ts
```

Native tests read/write a synthetic canary, contact only ephemeral loopback and run an
owned helper via structured executable/args, then use actual native SQLite. No real user
secret or external service is involved. Browser tests join the **real application native
test process** to headless preview typing/ordered synthetic streaming and M3 rendering.
That is native runtime + preview UI evidence, **not installed Tauri/WebView2 evidence**.
The CI workflow explicitly stages/runs the Windows trusted cohort; old restricted-engine
jobs remain clearly named independent experiments. Remote CI was not triggered locally.

`extension-runtime-native-tests` compiles only these integration fixtures, so ordinary
unit CI does not require a staged runtime. The explicit trusted Windows CI job enables
it and fails if packaging/launch is missing; this is not a product activation feature,
ignored test, mock fallback or trust override. Build this feature before the browser
cohort; `PANDACODE_EXTENSION_TEST_BINARY` can bind the exact emitted test executable.

Alternatives considered before implementation: Node reuses an existing maintained runtime
and mature native APIs/Node-API; [Bun FFI](https://bun.sh/docs/runtime/ffi) calls itself
experimental and recommends Node-API; [Deno Node compatibility](https://docs.deno.com/runtime/fundamentals/node/)
adds compatibility/permission/module-resolution policies not needed here. Embedding V8
would add binding/maintenance cost. QuickJS lacks the intended ordinary native/library
integration; LPAC implements the superseded threat model. None is called an OS sandbox.

| Target | Current status |
|---|---|
| Windows x64 | **Experimental**, explicit exact local runtime packaging; actual native fixture/broker/library evidence; installed WebView2/signing/release acceptance remains outstanding |
| Windows arm64 | **Unsupported**: no qualified trusted runtime packaging/launch/library evidence |
| macOS arm64/x64 | **Unsupported**: no qualified trusted runtime packaging/launch/WKWebView evidence |
| Linux x64/arm64 | **Unsupported**: no qualified trusted runtime packaging/launch/WebKitGTK evidence |
| Mobile / remote host | **Unsupported for executable activation in this slice**, no implied placement/compatibility |

## Historical restricted experiments — preserved, not trusted-host acceptance

All statements/results below describe the earlier confined-runtime decision and its
then-current disabled policy. That policy is superseded **only** by the experimental
trusted Windows path above; these experiments were not repaired, rerun or relabeled.

## Decision and rejected alternatives

**Executable packages remain disabled on every target.** This qualification slice does not
install an extension host or enable an SDK. The selected *experimental engine* is
`rquickjs =0.14.0` (MIT), using its bundled QuickJS-NG 0.16.2 C engine (MIT), statically compiled by
`cc`. The isolated qualification and experimental native-foundation crates depend on it;
the application does not link it.
No runtime download, install hook, shell, module loader, native module loading, or ambient
I/O is supplied to JavaScript. Each standalone Cargo.lock pins its experiment's dependency graph.

Design recorded before implementation:

- Compare an embedded restricted interpreter, web execution, and a trusted companion. Use
  QuickJS's allocator limit and interrupt callback in test-owned supervised child processes.
  Measure interpreter heap separately from process memory; never call a heap cap an RSS cap.
- Reject ordinary Node and workers: scheduling/crash separation is not permission isolation.
- Reject a web worker/iframe as the native qualification result: native WebView2, WKWebView,
  WebKitGTK origin/bridge/CSP isolation has not been demonstrated. It is a separate HTML gate.
- Reject a trusted native companion for untrusted packages: separate explicit user trust would
  grant OS authority, contrary to the default no-ambient-access contract.
- Boa is a plausible Rust alternative, but this experiment specifically needs a measured
  allocator limit plus interruption. Do not add a second engine or leave discarded prototypes.
- Select rquickjs rather than writing an engine/bindings: it exposes both controls and bundles
  source/bindings. Disable default features; enable only `std`. In particular `loader`,
  `dyn-load`, `rust-alloc`, `parallel`, and `futures` are absent. `rust-alloc` would bypass the
  engine's normal memory-limit implementation. Upstream requires Rust >=1.87.

The interpreter capability boundary denies ordinary JS OS access by not providing imports.
**A C-engine memory-corruption escape is not contained by that boundary.** An OS sandbox,
total-process memory cap, signed/release sidecar packaging, native UI evidence and all-target
qualification are still required before execution can be enabled. No test result toggles support.

Sources reviewed: [rquickjs API/features](https://docs.rs/rquickjs/0.14.0/rquickjs/),
[runtime controls](https://docs.rs/rquickjs/0.14.0/rquickjs/struct.Runtime.html),
[pinned build manifest](https://github.com/DelSkayn/rquickjs/blob/v0.14.0/sys/Cargo.toml),
[Boa](https://boajs.dev/about). License notices and measured results follow below when verified.

## Reproduce without enabling execution

From the checkout root (Rust with a platform C compiler; Node dependencies already installed):

```sh
cargo test --locked --manifest-path src-tauri/src/extensions/qualification/Cargo.toml -- --nocapture
cargo test --release --locked --manifest-path src-tauri/src/extensions/qualification/Cargo.toml -- --nocapture
cargo clippy --locked --manifest-path src-tauri/src/extensions/qualification/Cargo.toml --all-targets -- -D warnings
# The debug binary is built by cargo test. Use a verified free port and actual Chrome binary.
PW_PORT=15554 PW_PROD=1 PANDACODE_TEST_CHROME=/path/to/chrome npx playwright test -c tests/fixtures/extensions/runtime/playwright.config.ts
```

On PowerShell set environment variables with `$env:NAME='value'` before the command. If WebKit
was installed in a checkout-local cache, set `PLAYWRIGHT_BROWSERS_PATH` to that existing cache.
The dedicated Playwright configuration discovers both cases in both engines; `--list` lists four
tests. It intentionally does not enter ordinary preview cohorts that have no native experiment
built. `.github/workflows/extensions-runtime.yml` builds and runs this required native+preview
cohort explicitly, independently of the existing frontend-only extension CI. Missing native
binary or browser is a failure, not a skip or a substitute mock.

The standalone Cargo workspace has its own lockfile so an experimental C interpreter cannot
accidentally become an application dependency. Its CLI accepts only fixed reviewed fixture names,
never package paths/source, and is not a production sidecar. Child startup clears the environment;
the Rust test supplies one non-secret sentinel solely to test environment denial. Test-owned
children are killed/reaped on failure; no PID enumeration/termination API is offered to JS.
The 10 s parent watchdog is a **test safety bound**, not an enforced runtime resource policy.

## Observed Windows x64 results (2026-11-12)

Rust 1.99.1 / MSVC, rquickjs/core/sys 0.14.0, bundled QuickJS-NG header version 0.16.2.
These are single-cohort observations, not median/p95 performance qualification or a new SDK budget.

| Experiment | Actual result | Guarantee / limitation |
|---|---|---|
| Infinite loop | Interrupt returns `Timeout` at 5,000 ms | Interpreter deadline, not an OS CPU quota; parent can separately kill/reap the child |
| Allocation pressure | `out of memory` in 1–3 ms; retained engine malloc 133,325,600 bytes against 134,217,728-byte limit | Engine allocator accounting, **not** 128 MiB RSS/commit; fixture retains 1 MiB buffers to approach the cap |
| Cancellation | Final observed 25 ms optimized / 43 ms debug elapsed; parent asserts cancellation <1,000 ms | Loop readiness is acknowledged from inside the interpreter callback; cancellation is checked there |
| Forced child termination | Owned child exits/reaps <1,000 ms; next independent engine passes | Process ownership/recovery, **not** restricted OS permissions |
| Exception | Expected fixture exception returns `EngineError` | No core-process exception or shared interpreter |
| Filesystem/network/environment/process/FFI | All explicit operations throw `ReferenceError`; `std`, `os`, `node:fs`, `file:` imports reject after driving promise jobs | No ambient JS bindings/loader. Not a firewall, filesystem ACL, or native engine-escape test |
| Oversized RPC | 1,048,577-byte length header rejected before body allocation; no body needs to be sent | Qualification-only length-prefixed channel; 1,048,576-byte bound, not the later SDK/broker implementation |
| Forged RPC caller | Added `extensionId: panda.core` and undeclared filesystem operation denied; ping succeeds only as fixed `qualification.fixture` principal | Prototype channel identity cannot be overridden by payload; later host must bind its real supervised channel to the existing native broker |
| Core continuity | Chromium + WebKit each pass loop→allocation→exception and forced termination while typing and applying exact ordered recorded text events | Real native experiment plus real preview UI, synthetic provider transport; no claim about native Tauri/WebView integration or persisted resume IDs |
| Static optimized build | Windows x64 executable builds and optimized child tests run | Packaging feasibility only, not signed/installed Tauri sidecar qualification |

Initial denial checks incorrectly classified `SharedArrayBuffer` as ambient OS authority; the engine
correctly exposes that ECMAScript intrinsic. Corrected the experiment's classification, not the OS
access requirement: no worker/native handle import exists, every listed OS-access attempt still
must throw, and actual module-load rejection is now checked. Do not infer an OS sandbox from this.

## Independent Windows native foundation (blocked, 2026-11-12)

`src-tauri/src/extensions/native-runtime/` is an independently buildable, **unaccepted**
foundation. It is not linked into the application or eligible for executable activation.
It retains the selected engine and uses the existing `windows =0.62.2` bindings rather than
adding an isolation framework. The original T23 measurements above remain historical evidence
for that different qualification binary, not evidence for this supervisor.

The proposed launch path derives an AppContainer SID without provisioning a profile, requests
capability-free LPAC (opting out of ALL APPLICATION PACKAGES), restricts child creation, allows
only two inherited pipe handles, and atomically assigns a suspended child to a non-breakaway
Job Object before resume. Job limits request one active process, kill-on-close and 128 MiB
**whole-job committed memory**. This is neither an RSS nor a physical-memory cap; the engine
heap budget is separately 96 MiB. A single request is at most 2,048 bytes; a response frame at
most 1 MiB. The blocking supervisor polls cancellation/deadlines (at most five seconds), then
terminates and checks job/process teardown. These are implemented requests, not measured
enforcement guarantees.

The companion evaluates supplied source with no package loader/broker/native imports; it is
not a renamed fixture dispatcher. A separate test-only native probe uses the exact same launch
API for filesystem canaries, loopback, environment, process creation, native allocation and
failure cases. None of those probes has executed successfully inside the sandbox here.

Both native attempts failed before child creation with `0x80070002`. The corrective attempt
canonicalized the executable and used its explicitly granted staging directory as the working
directory; it isolated the failure to `CreateProcessW (LPAC, explicit handles, atomic job)`.
The staged binary and directory exist and have the derived SID's read/execute grant. The
underlying missing Windows resource is **undetermined**; the error does not prove a profile
is necessary. The goal's repeated-failure stop rule therefore blocks more native retries
until a new diagnostic step is authorized. No weaker launch, profile creation, external ACL
change, installed-app launch or security-policy change was used to obtain a pass.

Local commands (PowerShell, checkout root):

```powershell
node scripts/extensions-runtime.mjs --stage-only
# Requires resolving the recorded blocker before retrying this real native cohort:
node scripts/extensions-runtime.mjs
$env:CARGO_TARGET_DIR=Join-Path $PWD '_work/00-tmp/extensibility-runtime-target'
cargo test --offline --locked --manifest-path src-tauri/src/extensions/native-runtime/Cargo.toml --features native-probes --lib -- --nocapture
cargo clippy --offline --locked --manifest-path src-tauri/src/extensions/native-runtime/Cargo.toml --features native-probes --all-targets -- -D warnings
```

The local-only staging runner builds debug binaries offline/locked, copies to the test-owned
`_work/00-tmp/extensibility-runtime-package/`, grants read/execute only there, and writes hashed
contents, explicit `activationEnabled: false` and complete resolved-graph source notices.
The native probe is test-only and must never be included in a future release bundle. No
production Tauri packaging/signing/installed-native acceptance is claimed. No runtime download
or automatic application network request was added.

Outstanding review/acceptance includes native startup root cause, parent-process authority and
breakaway probes, injected limit-application failure, verified error-path reaping, per-host SID
separation (the prototype currently shares one derived SID), read-only installed companion
provisioning, actual native-fault typing/streaming continuity, and installed Tauri/WebView2
evidence. The old preview cohort has not been relabeled or rerun as proof of these new failures.
All executable targets remain disabled. The canonical independent handoff records the exact
commands/results and authorization needed; the original task run remains paused.

Mechanisms and alternatives reviewed: Microsoft's
[AppContainer implementation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
[startup attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information),
[LaunchAppContainer](https://github.com/microsoft/SandboxSecurityTools/tree/main/LaunchAppContainer),
[rappct](https://github.com/cpjet64/rappct),
[sandboxrs-windows](https://github.com/TarunKurella/sandboxrs-windows), and
[isobox's derive-only plan](https://github.com/can1357/isobox/blob/main/appcontainer.go).
The crate wrappers do not remove the need to prove LPAC authority/resource behavior locally;
derive-only launch avoids assuming permission to create per-user profile storage. Direct
existing bindings keep policy explicit and permit fail-closed errors without fallback.

## Target decision table

| Target | Evidence available here | Executable support and specific remaining reason |
|---|---|---|
| Windows x64 | T23 engine/preview evidence; new native foundation builds/stages but LPAC launch fails before execution | **Disabled**: native authority/resource enforcement and packaged native host/UI unqualified |
| Windows arm64 | Shipped crate contains `aarch64-pc-windows-msvc` bindings; CI row supplied, not run here | **Disabled**: no executed target isolation/resource/packaging evidence |
| macOS arm64 / x64 | Shipped bindings; native CI rows supplied, not run here | **Disabled**: no executed target isolation/resource/packaging/WKWebView evidence |
| Linux x64 / arm64 | Shipped bindings; native CI rows supplied, not run here | **Disabled**: no executed target isolation/resource/packaging/WebKitGTK evidence |
| Other targets | No qualification | **Disabled**: no supported runtime evidence |

All targets keep declarative packages. Native installation returns `UnsupportedRuntime` plus the
platform-specific reason; validation still rejects entrypoints, activation scripts and install hooks.
Neither a CI success nor changing an environment variable enables execution. Do not promote any
target until OS containment/resource policy and packaged/native integration have evidence, including
denial after a native-engine escape rather than only absent ordinary JS bindings. Release/signing
and distribution remain separately authorized work. Web custom-view qualification is independent.

## Experiment dependency notices

Reviewed the pinned crate source/build script: it statically compiles engine sources, not
`quickjs-libc`'s OS modules. Native desktop builds do not download a runtime. The upstream build
script has a WASI SDK download path; **WASI is not selected or qualified here**. Before distributing
a future runtime, carry these notices and audit its complete transitive license/packaging contents.
No runtime binary is distributed with the app in this delivery.

MIT License — rquickjs:
Copyright (c) 2020 Mees Delzenne; Copyright (c) 2025 Rquickjs Contributors.

MIT License — bundled QuickJS-NG:
Copyright (c) 2017–2026 Fabrice Bellard; Copyright (c) 2017–2024 Charlie Gordon;
Copyright (c) 2023–2026 Ben Noordhuis; Copyright (c) 2023–2026 Saúl Ibarra Corretgé.

The following MIT terms apply to each of the above components:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
