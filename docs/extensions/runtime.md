# Executable runtime qualification (experimental)

## Decision and rejected alternatives

**Executable packages remain disabled on every target.** This qualification slice does not
install an extension host or enable an SDK. The selected *experimental engine* is
`rquickjs =0.14.0` (MIT), using its bundled QuickJS-NG 0.16.2 C engine (MIT), statically compiled by
`cc`. Only the isolated qualification crate depends on it; the application does not link it.
No runtime download, install hook, shell, module loader, native module loading, or ambient
I/O is supplied to JavaScript. Cargo.lock pins the experiment's complete dependency graph.

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

## Target decision table

| Target | Evidence available here | Executable support and specific remaining reason |
|---|---|---|
| Windows x64 | Real debug/optimized engine, child ownership and both preview-engine continuity tests | **Disabled**: OS containment, total-process memory enforcement, packaged native host/UI unqualified |
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
