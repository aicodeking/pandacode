# Reviewing and managing grants

Settings → Extensions lists, per installed package, every permission it declares and what you granted
([runtime grants](runtime-grants.md) holds the store and the gate). The page only draws the native projection
(`extensions_runtime_grants`) and sends your changes (`extensions_runtime_grant`); it has no authority of its own, and
a request it cannot justify (a name the package does not declare, another package's name, a name outside the fifty)
is refused natively with `PermissionDenied` or `UnsupportedCapability`.

## What you see and can do

- **Effective grant.** Each declared name reads `Not granted` or `Granted · <scope>`: `All projects` or `Projects: …`,
  `Tool kinds: …` (`harness.hooks.decide`), `Credential items: …` (`credentials.use`; never a value). A package that
  is disabled, archived, in safe mode or whose executable is untrusted shows that it is suspended: grants are kept
  but carry no authority.
- **Grant / Save grant.** Grants the name, or replaces its scope (you may widen). No project checked means every
  project; empty tool kinds or items mean all.
- **Narrow.** Reduces an existing grant to a subset; widening is refused (`InvalidArguments`) and nothing changes.
- **Revoke / Revoke all.** Removes one name or all of them.
- **No per-action prompt.** A held grant is never confirmed again per action (ADR-0005); the page asks nothing when
  you grant, narrow or revoke.
- **Permissionless packages** show `Declares no permissions` and keep the existing enable, scope, trust, update and
  uninstall controls unchanged.

## Updates

An update is applied through the package's review ([executable trust and update review](README.md)). A version that
adds a permission name keeps the grants of the names it still declares and leaves the new name **not granted**: the
page lists it under "Needs your review", and a direct native call for it answers `PermissionDenied` until you grant it.
A call that names the old version also answers `PermissionDenied`. A changed executable digest is untrusted until you
trust it again, so no grant carries weight before that decision.

## Effect on running work

Narrowing, revoking, untrusting or archiving takes effect in the native store first: new calls are refused before any
package code starts, privileged work the new state no longer allows is cancelled (`Work::is_cancelled`), and the page
redraws from the answered projection. What the page displays and what a direct native call answers are the same data
(`tests` in `src-tauri/src/extensions/runtime_grants_manager.rs` compare them before and after every change).

## Proof

- Native: `cargo test --lib extensions::runtime_grants_manager` (install, grant a project, a tool kind and a credential
  item, restart, update adding a permission, narrow, revoke, forged requests).
- Browser: `tests/extensions-runtime-grants-manager.spec.ts` over the fixtures in
  `tests/fixtures/extensions/runtime-grants-manager/` (the preview store is a labelled synthetic stand-in).

## Refusal-test reconciliation (Q016, Q082, Q108)

R0101B delivers the grant UI and the `projects.checks.run` grant surface; it does not make the Settings surface
accept any new control. Each row below is therefore retained as it is, with the reason the refusal exists. None of
them is a security restriction on a trusted package.

| Row | Retained refusal | Reason it stays (not security) |
| --- | --- | --- |
| Q016 `contracts.rs` settings contract | `turn-checks`, `provider-credentials`, `remote-pairing`, `github-sign-in`, `safe-mode`, `app-update`, `project-remove` are not public `settingsAction` control ids | Contract shape: these are host-owned flows (consent dialogs, pairing, recovery) that stay user-only by ADR decision, and the public enum lists only the core controls. Granting `projects.checks.run` is done on this page, not through a settings action. |
| Q082 `extensions-settings.test.mjs` | Entry controls answer `PermissionDenied` without a fresh user choice; protected controls are not in the schema enum | Predictability: an action must come from a captured, fresh host choice (stale, replayed or forged requests never retarget). This is request freshness, not withholding a capability. |
| Q108 settings coverage specs | `turn-checks` answers `InvalidArguments`; pinned sections have no Hide | Stability and irreversibility: protected privacy and recovery sections must stay reachable; the shape error is the contract's. |

The page's own denials (foreign package, undeclared name, widening a narrow grant, unknown name) are the standing
unauthorized/stale/foreign-owner refusals and are retained: they keep one package from receiving another's grant and
keep the vocabulary closed, which is predictability, not restriction of a trusted package.
