# Run-bound callback companions (R0602)

Native `runtime_callback_companions.rs` and its erasable TypeScript fixture twin implement Claude-compatible
`initialize.hooks` / `hook_callback` registration, correlation and event-specific replies. GLM, MiMo and Alibaba
use that same bridge without adding or overwriting their existing inline settings. Pi and omp use a structured
message over the existing extension UI input request/response channel; the reserved title is consumed natively.
It is never shown as a user dialog. The existing boolean confirmation remains the ordinary permission fallback.

The lifetime resource owns registration. Callback IDs are single-use, at most 64 may be pending and at most 4096
are accepted per run. Replies recheck the complete lease after the native hook chain returns. Disable, revoke,
safe mode, service failure and run end invalidate that lease first. Cold Claude launches register callbacks;
an active companion cannot enter the existing warm-agent cache. No companion leaves its launch/key/settings
and Pi approval policy unchanged.

The native resolver reuses R5 grant checks, ordering, budgets and receipts. Before-tool answers distinguish deny,
ask, approval and complete input rewrite. After-tool answers replace output where supported. Prompt context is composed by the existing pre-send chain; prompt callbacks return an empty answer to avoid
delivering the same hook twice. The run wrapper likewise owns turn-end delivery. Compaction maps to cancel/instructions for Claude and
cancel/custom summary for Pi; post-compaction and turn-end are observational. Pi consults before its full-mode
early return, mutates the actual input object and translates result patches into the extension API's fields.
Plan restrictions remain host-enforced. An empty/failed answer leaves ordinary permissions in effect.

API evidence: the existing SDK-derived Claude fixture is in `runtime-hook-fixtures/sdk-derived/`; the
[Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) describes
input mutation and result patches, and its [RPC UI protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)
defines input correlation. The latter source was read on 2026-11-17; it is source feasibility, not installed evidence.

## Qualification and remaining gate

The profiles accept only the explicit fixture revisions `sdk-derived` and `synthetic-bridge-v1`. Production launch
currently has no verified installed version/API, so negotiation returns `UnsupportedCapability` before registration
and normal permissions continue. This task does **not** enable an unverified installed harness. The authorized
Claude/GLM/MiMo capture gate remains pending; omp also lacks separate installed capture. Obtaining actual version
and capability evidence, and promoting it to a host-owned installed profile, remains necessary before live activation.
No user CLI configuration is inspected or changed. There is no new IPC, listener or credential.

Fixtures/specs are synthetic, run the shipped Pi module against an in-process API, and never launch a real harness.
Both Playwright configurations register the spec for the final phase. Tests written, not run during implementation.
