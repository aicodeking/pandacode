# Provider compatibility adapters (v1, implementation preview)

## Package providers (experimental)

The `tests/fixtures/extensions/fake-harness` package is an offline, executable
conformance example. ZIP its `extension.json`, `main.cjs` and `assets/`, install in Settings →
Extensions, explicitly review executable trust, then enable. The **Recorded harness**
catalog appears in the existing model picker and provider settings. Select Recorded
model, medium effort and Standard (native mode `ask`). No credentials/network are used.
This is implemented on the existing Windows x64 trusted-runtime target; installed
WebView2 interaction and other native-platform qualification are not claimed.

Declare `contributes.providers` entries with `apiVersion: 1`, namespaced `id`, `name`
and bounded `models` (`id`, `name`, `efforts`, optional `contextWindow`). Include each
provider ID in `runtime.activationEvents`. Export `providers[id]` from `main.cjs`:

```js
exports.providers = {
  'publisher.extension/local-id': async (run, core) => {
    await core.emit({ kind: 'session', id: run.resumeId || 'native-conversation' });
    await core.emit({ kind: 'text', text: 'Hello' });
  }
};
```

### Catalog and status metadata

An optional `metadata` object on each provider supplies its consumer capabilities:

```json
{
  "modes": ["ask", "plan"],
  "authentication": "Sign in using this extension's own setup; no keys enter the webview.",
  "readiness": { "state": "ready", "reason": "Ready through the trusted adapter." },
  "icon": "publisher.extension/mark",
  "usage": { "context": true, "limitsReason": "Context tokens are reported; account limits are not exposed." }
}
```

Modes are unique core IDs (`ask`, `auto`, `plan`, `full`), never `review`; they describe
the extension's policy, not OS confinement. Native admission rejects unsupported modes
or non-ready states with a reason. `signedOut` and `unavailable` keep the catalog
visible but disabled; refreshing after the registration changes recovers it. The
owned icon must reference that package's `contributes.icons` entry. Icons use the
same sanitized static SVG policy as other extension controls, never arbitrary URLs.

The model picker lists only advertised package model IDs and their efforts. New
tasks use an advertised model and supported mode; existing unsupported selections
remain readable and explain how to change them. Settings → Providers shows the
authentication/readiness/usage instructions, not a built-in executable or secret
form. `list_providers` and `provider_configuration.extensionProviders` return this
public metadata. Context usage events keep using the core task meter; there is no
extension account-quota reader yet, so Usage returns `unsupported` with `limitsReason`
rather than synthetic percentages or a failed built-in credential probe.

Without metadata, v1 packages default to Standard only, extension-managed auth,
ready status, a name-initial mark, no declared context reporting, and an explicit
unsupported account-limits reason. Disable/safe mode retires presentation metadata
and cached model results, not history. Built-in aliases, vendor-specific auth forms,
brand assets, pools and quota readers deliberately retain their native branches;
package providers never inherit those protocols or credentials.

`run` is frozen and captures API/version/digest, provider ID, model, effort, mode,
resumeId, prompt and instructions once. `core.emit` accepts only typed text,
thinking, session, tool, approval, question and usage events. It cannot target another
task, settle an approval or emit `done`. `core.nextInput()` awaits validated core
approval, question or live-steer input. Questions use the existing bounded structured
question grammar. Core generates pending request IDs and validates offered answers;
stale/forged answers never reach the adapter. A successful return with unanswered
requests or without a session is an error. Core emits completion exactly once.

The existing supervisor authenticates framing and bounds 64-KiB frames, 128 RPCs,
16 queued inputs, eight active managed provider runs and a one-hour run. Stop kills/reaps owned work independently of
package cooperation. Disable/revoke/reload cancels owned managed runs and refuses
future admission. Captured active version/source is immutable; package identity and
saved transcript/resume IDs remain readable after disable/uninstall. Images, native
slash skills, goals and Codex-private RPCs are explicitly unsupported by this adapter.
No raw IPC, database or native host-tool execution API is exposed. Tool events are
reported activity, not authority to run a host tool. Trusted package code still has
ordinary OS-account authority independently: this API is not an OS sandbox.

PandaCode's built-in harnesses remain core functionality. They do not require an
extension package, executable-extension trust, a dynamic provider ID, or an
extension host. Existing IDs, saved sessions, connections and native commands
remain valid. This is an **expand** migration, not a new external-provider SDK.

## Design and ownership

`src-tauri/src/extensions/providers.rs` defines the additive, versioned built-in
descriptor and operation/capability vocabulary. Its roster comes from the existing
`providers::PROVIDERS` table, not a second allowlist. Unknown IDs fail closed.
Discovery and model catalog seams invoke the original native probes with the
resolved legacy ID. Saved OpenCode selections, discovery limits, configuration,
credentials, account pools and catalog error/fallback behavior remain native.

`extensions/builtin_protocol.rs` is intentionally compiled as a child of the core
`providers` module. Its internal `Session` facade owns the original `Protocol`:
start/resume, prompt sending, normalized events, steering, stop, approvals and
questions delegate to that same engine. Internal lifecycle/tool helpers can
continue to use its state through Rust deref coercion. Neither that state nor the
wire engine is an extension RPC/DOM/SQLite API.

This design was chosen instead of copying/parsing each protocol again: a second
parser would create independent policy, completion and resume state, and could
silently widen approvals. Replacing all legacy identities with strings or routing
core harnesses through an executable package was also rejected: both would make
existing workflows depend on later migration milestones.

Core still owns process cleanup, pending approvals/questions, cancellation,
completion, task persistence and credentials. The facade starts no additional
process, downloads nothing, and changes no wire protocol or database schema.

## Capabilities

The existing `provider_configuration` response keeps its `providers` roster and
adds `providerAdapters`. Each entry has `apiVersion: 1`, the same `id`/`name`, and
`operations`, an array of `[operation, capability]` pairs. A capability is either
`{"state":"enabled"}` or `{"state":"disabled","reason":"…"}`.

| Operation | Built-in behavior |
|---|---|
| `discovery`, `configuration`, `models` | Existing native discovery/settings/catalog functions; no prompt installation or account change |
| `start`, `resume`, `send`, `normalize` | Original initialization/session/prompt/event handlers |
| `steer` | Original live **or next-turn** acknowledgement and delivery; enabled never promises live steering |
| `stop`, `approval` | Original stop and offered-choice/decline behavior; no synthetic successful completion or approval |
| `question` | Enabled for Codex and Muse structured input; disabled with a reason for all other built-ins |

“Enabled” means the adapter implements the operation, **not** that every installed
CLI version advertises every negotiated feature. ACP resume/modes/models/images,
authentication, model efforts and other runtime preconditions still fail with the
original actionable errors. An unavailable ACP resume never silently becomes a
successful fresh run. Existing provider-specific recovery (such as ZCode's
reported missing-session fallback) remains unchanged.

Calling the structured-question operation on an unsupported built-in returns
`UnsupportedCapability: …` before looking up or changing pending state. Pi's
confirmation UI is an approval, not an invented structured-question capability.
ZCode's unsupported interactive question still receives its original wire decline.

## E25 conformance and limits

`tests/fixtures/extensions/builtin-provider-parity.json` retains anonymized,
shortened frame shapes from the existing recorded-protocol native tests. Its
explicit 19-provider matrix covers Claude/GLM/MiMo, Codex, Kimi, shared ACP
dispatch (with actual per-provider modes and Copilot settings), Pi/OMP, Muse and
ZCode. Shared ACP fixtures are shared protocol characterization, not a claim
that all installed CLI versions were freshly contacted.

The native differential test runs 228 sessions (19 providers × start/resume ×
approve/decline/leave-pending × no-steer/steer). It compares wire writes, ordered
normalized events, native session/turn IDs, phase, completion/failure, question
answers, pending-request cancellation and steering acknowledgements against the
unwrapped engine. It requires every provider to open a session, send a prompt,
normalize content and request approval; Codex/Muse must exercise structured input.
Only generated correlation UUIDs are canonicalized; the recorded Pi resume UUID
and native session/turn identities are retained and compared directly.

Separate tests cover roster/descriptor identity, disabled-operation errors,
unknown IDs, stop-before-initialization, stale approvals and denied ACP resume.
Discovery dependency-injection tests compare installed/absent native observation
DTOs without probing the developer's accounts or tools. Catalog tests replay the
fixture's shortened raw catalog shapes through the original Claude, Codex, Kimi,
OpenCode, ACP/Grok, Pi/OMP, Muse and ZCode parsers (GLM/MiMo retain their static
native catalogs), then compare direct versus adapter dispatch and unchanged
errors for every built-in. This includes efforts and context windows, not just
model IDs. These are offline recordings/observations, not freshly contacted
installed CLIs. The original parser/recorded-frame suites also run in the complete
native suite. Kimi/ZCode's pure parsers have only parent-module visibility for
this conformance seam; they are not public RPC operations.

Run the focused suite with:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib builtin_adapter
```

No frontend interaction or new native IPC command was added. Native installed
WebView/platform acceptance and opt-in live CLI smoke tests are separate from
this automated compatibility evidence. Dynamic identities, package-owned provider
registration and capability fan-out are subsequent slices, not implemented here.

## Recovery

Safe mode and zero-extension operation use these same built-in adapters and
original routes. Disabling an unrelated extension cannot remove a built-in
registration. Rollback can select the unchanged core `Protocol` construction and
native discovery/catalog entrypoints; there is no data migration to reverse and
no extension-owned run/version to drain in this slice.
