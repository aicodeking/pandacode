# Provider speed tiers v1 (experimental)

## Decision

Upstream 0.3.128 lets a model list `speedTiers` (Codex service tiers, Claude Code fast mode) and the model picker draws
them as a Speed row beside Effort. Before this change an extension harness could not declare them
(`dynamic_harness.rs` returned an empty list and neither the schema nor the SDK had a field) and the user could not
arrange them. One adapter now owns the behavior, so no other task keeps a second tier model:

- **Contract.** A package provider's model takes `speedTiers: [{ id, name, description? }]` (at most 8; `id` is a
  lowercase word like an effort ID; duplicates are `DuplicateId`). It is in `schema-v1.json`, the SDK
  (`ProviderDescriptor`), `contracts.ts` / `contracts.rs` and `dynamic_harness.rs` (which fills `ModelInfo.speed_tiers`)
  and in `harnesses.ts` (the preview mirror). A model without `speedTiers` shows no Speed row, as upstream does.
- **Choice list.** `src/extensions/upstream-speed-core.ts` builds the list: Standard first (the empty choice), the
  model's tiers, and a saved tier the catalog no longer lists, still shown as chosen. `src/model-picker.ts` draws it and
  keeps the upstream save: `onSpeedSelect`, the pending state, the ordered effort saves and the focus handling.
- **Arrangement.** The user may hide or reorder the optional tiers of a model through the layout store, location
  `panda.composer.model.speed` (listed in `actionLocations`). A tier's layout ID is `speed-<fingerprint>` of the
  provider, model and tier, because layout IDs are lowercase words; the catalog row (`declaredSpeedItems`) carries the
  readable label. Standard and the saved tier never hide. Restore (reset the layout) brings the upstream list back.
- **Captured revision.** The picker records the provider, the model and a revision of the arranged list when it draws
  the Speed row. A click on an older list (the layout, the model or safe mode changed meanwhile) is refused with "The
  speed options changed. Choose a speed again." and the row is drawn again; nothing is saved.
- **Zero extension.** With no package, nothing hidden or in safe mode the list is exactly upstream's. A disabled or
  uninstalled package removes its harness, so its tiers and layout rows leave with it; the stored layout entries go
  dormant, as every layout entry of a missing package does.

## What the package may and may not do

A package declares tiers as data. It cannot change which tier is saved, hide a tier for the user, read the task's
speed setting or run a command from the picker: saving stays the picker's host action and a package harness receives the
tier only through its normal run configuration. Safe mode and a faulting package fall back to the upstream list.

## Named handoffs (not delivered here)

- R0806 (provider state): a package reporting live availability of a tier (for example a tier that is exhausted).
- R0807 (speed and warm-spare opt-in): a package choosing the default tier or opting into a warm spare. Handoff rows go
  to S07C and are consumed by R1212. This adapter's acceptance does not claim those contracts delivered.

## Evidence

Tests are written and not run (the final test phase runs them).

| Claim | Evidence |
| --- | --- |
| List, arrangement, stale revision, safe mode, contract (pure) | `tests/upstream-speed-extensions.test.mjs` |
| Installed fixture, picker, hide/restore, disable/enable, keyboard, stale click (Chromium and WebKit preview) | `tests/upstream-speed-extensions.spec.ts` with `tests/fixtures/extensions/upstream-speed/manifest.json` |
| Native contract validation of `speedTiers` | `src-tauri/src/extensions/contracts.rs` (`DuplicateId`) and `dynamic_harness.rs` (`catalog`) |
| Installed WebView acceptance | Not claimed: the browser preview never substitutes for it. |
