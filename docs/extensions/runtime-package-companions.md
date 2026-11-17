# Package companions and harness coverage

`contributes.companions` declares native companion modules owned by an installed
extension. Each row has `id`, `title`, built-in `harness` and archive-relative
`file`. IDs belong to the package namespace; at most sixteen rows are accepted.
The file must be inside a declared `runtime.files` code folder. Traversal,
absolute paths, unknown fields, missing files and path case mismatches refuse
installation. Companion-only runtimes may omit activation events; `main.cjs`
remains the runtime entrypoint and is not evaluated during installation.

The package declares `harness.companions`. Installation starts disabled and
requires executable archive trust before enablement. Execution additionally
requires a current native grant for that permission and package version.
Permission declaration alone never grants execution. The permission is global;
the package's selected-project list separately restricts selection. Safe mode,
disable, uninstall, trust loss and grant revocation withdraw authority. No real
CLI configuration is inspected or written.

## Selection and resource ownership

The native selector reads the existing package snapshot and synchronizes the
native grant store. Entries carry package ID, name and version. Manifest entries
remain visible with their installed package; the native harness inventory also
exposes `packageCompanions` for globally applicable, enabled, trusted and granted
entries. Launch selection supplies the actual task project and target harness.
An unknown installed API yields an explicit `UnsupportedCapability` row.

The callable loader revalidates the actual trusted archive through `code_files`
and uses the existing checksum-qualified code cache. Only exact OpenCode V1
v1.19.5 and Kilo V1 source profiles currently admit arbitrary package modules.
They append local file URLs to singular `plugin` in a caller-supplied merged
process document, preserving other settings and order. Kilo uses
`KILO_CONFIG_CONTENT`; OpenCode uses `OPENCODE_CONFIG_CONTENT`. Pure mode,
unknown APIs and incompatible documents refuse injection. V2 directory graphs
and other native formats require separate loaders and qualification.

A lifecycle resource owns the child environment and cancellable grant work.
Closure clears injection; cancelled grant work returns no environment. Existing
runtime stop paths invalidate leases before cleanup on disable or trust loss.
The immutable code cache belongs to the package manager and survives a run;
uninstall removes it using that manager's existing ownership rules. Withdrawing
an environment cannot hot-unload arbitrary code already loaded in a CLI.
Provider teardown, in-flight native cancellation and warm-process exclusion must
be qualified before enabling installed package execution.

## Audit coverage

`companionCoverage` in native and preview harness reports includes every built-in
harness. Host forwarding adapters and arbitrary package loaders have different
capabilities. A callback bridge does not establish a package-module loader.

| Harness | Source adapter or functional limitation |
| --- | --- |
| Claude, GLM, MiMo, Alibaba | `runtime_callback_companions`: initialize callbacks; package loader unqualified. |
| Pi, omp | `runtime_callback_companions`: existing structured extension bridge; arbitrary package entries unqualified. |
| Codex | `runtime_codex_companion`: targeted inventory/hash sequence; package format unqualified. |
| OpenCode | `runtime_opencode_companion`: separate V1 module/V2 directory APIs; package entries limited to V1. |
| Kilo | `runtime_kilo_companion`: independently negotiated V1; package entries limited to V1. |
| Kimi | No demonstrated per-run native hook injection API. |
| Antigravity | Permission bridge only; no demonstrated per-run plugin API. |
| Grok | Hook files require user/project configuration; no per-run loader. |
| DeepSeek | Sandbox escalation bridge only; no verified hook interception API. |
| CommandCode | Configuration-file hooks only; Plan skips them. |
| Cline | SDK `pluginPaths` does not establish per-run ACP loading. |
| GitHub Copilot | Global/project hook directories; ACP loader unverified. |
| Hermes | Plugin enablement edits profile configuration; ACP hook execution unverified. |
| ZCode | Permission bridge; no verified native companion API. |
| Devin | Partial permission bridge; no per-run hook loader. |
| Muse | Sandbox permission bridge; no demonstrated companion API. |
| Cursor | Configuration-file hooks do not establish a per-run ACP loader. |

Native permission, sandbox and goal policies remain authoritative. No companion
coverage row advertises model-request replacement or custom compaction; both
fields are `notReported`. Existing tool/approval coverage retains its meaning.

## Evidence and remaining integration

| Evidence source | Status |
| --- | --- |
| Preview/fake | Written validator, selection, withdrawal, inline-config and actual synthetic-module loader cases; not run. |
| Native fixture | Written real archive install/trust/enable/grant/cache and withdrawal cases; compile-checked only. |
| Recorded | No live package-companion capture; fixtures explicitly identify synthetic provenance. |
| Installed Windows | Not authorized or qualified; no installed CLI or user configuration accessed. |
| Installed macOS/Linux | `UnsupportedRuntime`; no installed companion qualification. |

Production still supplies no verified installed version/API, so negotiation
refuses before materialization. The launch seam records package ownership but
does not enable a real CLI. Passing the real merged inline document, detecting
pure mode, authenticated host transport, coordinated host-plus-package loading,
actual ACP inheritance and provider warm/teardown behavior remain integration
gaps. The gated launch placeholder must be replaced and these checks completed
before claiming installed support. Configuration files alone are never used to
enable a harness globally.

Tests are registered in both Playwright configurations and CI. The Kilo and
package registrations precede configuration export so both are included in the
exported test list and WebKit title filter.

**tests written, not run (deferred to the final test phase)**.
