# Runtime platform qualification (prepared, not enabled)

`src-tauri/src/extensions/runtime_platform_qualification.rs` defines what a platform runner is given and what it must
report. It launches nothing and enables nothing.

## Matrix

| Target | State |
|---|---|
| `windows-x64` | qualified (pinned Node `v26.1.0`) |
| `macos-arm64`, `macos-x64`, `linux-x64`, `linux-arm64` | `UnsupportedRuntime` |

`ENABLED_TARGETS` is the only switch. A target is added there by a separate, reviewed change that cites installed
evidence; a passing record alone never does it. No Windows, browser or preview result applies to another target.

## Runner input (`runtime-platform-qualification-input`, schema 1)

`target`, `runner.id`, pinned `runtime`, `probes` (`bundle`, `launch`), `scenarios` (`executable-host`, `service`,
`rich-panel`, each naming a fixture and fake backends), `r2` (`state: "not-adopted"`, `packages: []`: the R2 contract
is defined, no R2 package is consumed) and `credentials: "none"`. Scenarios use only
`tests/fixtures/extensions/runtime-service-lifetime/` and the fake backends in `tests/fixtures/extensions/backends/`.
No real harness or credential is involved. R1102 adds R2/R3 packages later.

## Runner result (`runtime-platform-qualification-result`, schema 1)

`target`, `host {os, arch}`, `runner`, `runtime {kind, version}`, `evidence`, `bundle.status`, `launch.status`,
`scenarios[{id, outcome, reason?}]` in input order.

Parsing (`evaluate`) yields `Passed`, `Failed(reason)`, `Missing` (no runner record) or `Invalid(reason)`. A record is
`Invalid` when its schema is unknown, it belongs to another target, the host disagrees with the target, the evidence is
not `installed` (preview and browser never count), the runtime is not the pinned version, the scenarios are incomplete,
or a probe or outcome is missing. `may_execute` is `Ok` only when the target is enabled and the record passed;
everything else is `UnsupportedRuntime`.

Fixtures: `tests/fixtures/extensions/runtime-platform-qualification/`. Replay with
`cargo test --lib runtime_platform_qualification`.
