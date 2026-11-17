# Runtime platform evidence: macOS and Linux (R1102)

Status of every target in this file: **pending human input - runner unavailable; target stays `UnsupportedRuntime`.**

R1102 asks for the installed-app acceptance of the extension runtime on macOS and Linux. The run was prepared on a
Windows machine with no macOS or Linux runner, and the user decided that no tests and no installed-app runs happen
before the final test phase. Nothing here is an observation. Fake-success records, result-parser tests and the Windows
or browser results do not count for another target (see [runtime-platform-qualification.md](runtime-platform-qualification.md)).

`ENABLED_TARGETS` in `src-tauri/src/extensions/runtime_platform_qualification.rs` is the only switch. A target is added
by a separate, reviewed change that cites an installed record; this file never enables anything.

## Matrix

| Target | Status | Enabled |
|---|---|---|
| `macos-arm64` | pending human input (runner unavailable) | no, `UnsupportedRuntime` |
| `macos-x64` | pending human input (runner unavailable) | no, `UnsupportedRuntime` |
| `linux-x64` | pending human input (runner unavailable) | no, `UnsupportedRuntime` |
| `linux-arm64` | pending human input (runner unavailable) | no, `UnsupportedRuntime` |
| `windows-x64` | qualified separately by R0306/R1212 (own evidence) | yes |

Each target is gated alone: a pass on one never enables another.

## What each target must prove (installed build, fake backends only)

1. **Executable host.** The pinned Node (`v26.1.0`) bundled in the installed build starts from the app bundle or
   package, reports its version, and the host runs a package service (`bundle` and `launch` probes).
2. **Startup, stop and backoff.** `runtime-service-lifetime` fixtures: start on enable, clean stop on disable, crash
   restart with the declared backoff, stdin-EOF teardown with an awaited child exit, no orphan process after quit.
3. **Duplex events.** Host-to-package and package-to-host messages both ways over the service channel, ordering and
   limits as in the R0208 fixtures.
4. **Rich-panel containment** (the `rich-panel` scenario): origin isolation (the panel gets no app bridge or app
   document), per-package storage separation between two packages, the data channel (streaming, action response),
   state across placements, focus handling (focus trace, `#panda-min`, parked document), and fault containment (a
   crashing panel or service beside a running B5 fake-agent task leaves the app and task alive; disable, revoke and
   safe mode leave no frame or channel behind).
5. **No real harness, no credentials.** Only `tests/fixtures/extensions/backends/` (B1 loopback, B5 stdio ACP).

## Runbook per target

Run on a dedicated account or fresh VM of the target, never a developer profile. Required environment:
`PANDACODE_QUALIFICATION_PROFILE=dedicated`; for the build, the Node license variable used by the Windows runner
(`PANDACODE_EXTENSION_NODE_LICENSE`).

Pattern (from R0306, `tests/fixtures/extensions/runtime-windows-panels/qualify.mjs`): fingerprint the tree, build the
release for the target, refuse a tree that changed during the build, write the installer identity (candidate commit,
fingerprint, SHA-256), install into a test-owned folder, start B1, launch the installed app with a debugging port,
drive `scenarios.mjs`, compare with `expected.json` through `evaluate.mjs`, and write `observation.json`,
`result.json` and the target's platform record. The R0306 runner is Windows-specific (NSIS install, WebView2 CDP);
a macOS/Linux runner needs the same stages with the platform's own pieces, written when a runner exists:

| Target | Build (`scripts/release/build.mjs`) | Install | Webview and automation port | Versions to record |
|---|---|---|---|---|
| `macos-arm64` | `macos-aarch64` | mount the `.dmg` or unpack the `.app` into a test folder | WKWebView; Web Inspector/automation, or the app's own test hook if one exists | macOS build (`sw_vers`), `uname -m`, WebKit/WKWebView version, bundled Node |
| `macos-x64` | `macos-x86_64` | same, on an Intel runner (not Rosetta) | same | same |
| `linux-x64` | `linux-x86_64` | `.deb`/`.AppImage` into a test folder | WebKitGTK; WebKitWebDriver or `WEBKIT_INSPECTOR_SERVER` | distro and release, kernel, `uname -m`, WebKitGTK version, bundled Node |
| `linux-arm64` | `linux-aarch64` | same, on a native arm64 runner | same | same |

Exact target names must be checked against `scripts/release/build.mjs` when the runner exists.

Commands on each runner, in order:

1. `npm ci` (or use the build output of the candidate commit).
2. `node tests/fixtures/extensions/<platform-runner>/qualify.mjs --build` (the runner derived from R0306's, one
   per OS family; its stage, scenario and evaluate modules are reused, not copied).
3. `PANDACODE_WINDOWS_PANELS_RECORD`-style replay of the recorded observation in the spec, as R0306 does, naming the
   target's record.
4. Replay the platform record with `cargo test --lib runtime_platform_qualification` against a record placed in
   `tests/fixtures/extensions/runtime-platform-qualification/`.
5. Also required by the same run (earlier slices): the R1201-R1203 Work board acceptance seven scenarios listed in
   `tests/fixtures/extensions/example-live-board/evidence-columns.json`, `evidence-columns-c.json` (needs the R0306
   `stage.mjs` PACKAGES edit noted in the R1202 receipt section), and the `sample.hook-alpha`/`sample.hook-beta`,
   `sample.memory` and model-tool installed qualifications left pending in the R0506, R0701 and R0704 sections.

A target may be enabled only when: the record is `installed` evidence, host OS/arch match the target, the pinned
Node version matches, all three scenarios (`executable-host`, `service`, `rich-panel`) passed, and the OS, runtime and
engine versions above are written into the receipt. Then a reviewed change adds the target to `ENABLED_TARGETS` and
removes its refusals below. A failing or missing target stays `UnsupportedRuntime`.

## Retained refusals (Q025, Q051, Q063, Q117) and why

These tests currently pin the unqualified state. R0306 already changed the Windows-positive assertions of Q025 and
Q051. R1102 changes none, because no further target is qualified. Reasons are non-security: no capability is
withheld from a trusted package for safety (ADR-0005); these are platform-support facts.

| Row | Test | Retained assertion | Reason (non-security) | Changes when |
|---|---|---|---|---|
| Q025 | `rich_views.rs` `unqualified_targets_and_forged_window_options_fail_closed` | non-Windows targets not qualified; forged `url`/`capabilities`/size/`projectId` options and `extension-view-*` commands refused | Stability and predictability: the rich-panel path is unproven on the platform's webview; window identity and geometry stay host-decided | `ENABLED_TARGETS` gains a target (then only that target's assertion flips; forged-option refusals stay) |
| Q051 | `extensions-windows.test.mjs` auxiliary labels | rich-view surface text describes the per-target gate | Documentation accuracy: states which targets are enabled | A target is enabled (text updated) |
| Q063 | `extensions-runtime-package.test.mjs` unsupported targets keep declarative builds | only Windows x64 gets a bundled runtime | Packaging stability: no Node runtime is bundled or license-checked for targets with no installed evidence | A target's installed record passes and its runtime bundle is added |
| Q117 | `extensions-rich-views.spec.ts` unqualified targets show a host fallback | "Rich HTML views are disabled" and no popup | Usability: an unqualified platform shows a clear fallback instead of a broken panel | Same as Q025, per target |

Unauthorized, stale and foreign-owner denials in these tests are untouched.

## Pending human inputs (for the receipt and the final audit)

- A macOS arm64 runner, a macOS x64 runner, a Linux x64 runner and a Linux arm64 runner (native hardware or VMs),
  each with a dedicated account, the Node license variable, and the ability to build the candidate commit.
- A decision whether the installed-app drive uses a webview automation port or a small test hook in the app.
- Until these exist: **pending human input; every non-Windows target stays `UnsupportedRuntime`.**
