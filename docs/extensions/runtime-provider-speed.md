# Speed tiers and warm spares of declared harnesses (R0807)

A package harness that declares `contributes.providers[].launch` (R0801) takes part in the picker's speed row and, only
when the user opts in, in "start ahead". Native owner: `src-tauri/src/extensions/runtime_provider_speed.rs` (declared as
`providers::speed_adapter`). Webview side and preview stand-in: `src/extensions/runtime-provider-speed.ts`.

## Speed tiers

* A model publishes `speedTiers` (`id`, `name`, optional `description`; S0606, also publishable at run time through
  `panda.providers.update`). The existing model picker draws and persists the choice.
* `task_controls::set_task_preference` stores the tier in the task's saved settings (`serviceTier`) for a package provider
  after `validated_tier`: it must be listed by that model of that provider's catalog, otherwise `Choose a valid speed.`.
  `null` is the standard speed. It applies from the next send.
* A send resolves the selection once (`selection`). The saved tier is kept only while the selected model still lists it, so a
  model switch drops a stale tier (recorded as `tierDropped`).
* The declared ACP launch receives the pick in `session/new` as `_meta.pandacode`:
  `{ "extension": "<package id>", "model": "...", "effort": "..."|null, "speedTier": "..."|null }`. `_meta` is ACP's extension
  point; a harness that ignores it loses nothing. No credential, path or key is in it.
* Attributed events (`launch`, `tierSelected`, `tierDropped`, `spare*`, `optIn`, `optOut`) are kept in a bounded recorder
  (128) and shown by `extensions_provider_speed`: the package id, the provider, the task id, never a secret.

## Warm spares (default off)

The default is demand only: a package process starts when a task sends. A package may start ahead only when ALL hold,
checked again at every start and adoption:

1. its provider declares `launch.warmSpare: true`;
2. the user opted the package in (Settings > Extensions > "Start harnesses ahead", IPC `extensions_provider_speed_optin`,
   main window only). The opt-in is file backed (`extension-provider-speed-v1/opt-in.json` next to the grants, independent of
   SQLite) and bound to the executable digest: an update or a new trust review revokes it;
3. the package is enabled, trusted, not in safe mode and its provider is ready (`dynamic_harness::warm_context`);
4. the user's "Start agents ahead" setting is on.

A spare is one process after `initialize` (the same shape as upstream's ACP spares). A send adopts it when its key matches
(provider, executable digest, command, environment, folder) and the process is alive and under 10 minutes old; the
`initialize` reply is replayed, so the handshake is counted once, at adoption. Model, effort and tier are not in the key: a
switch keeps the spare. One spare per task, at most 2 in total. Counters live in the package's one
`runtime_provider_launch::State` (`spawns`, `warm_started`, `warm_adopted`, `warm_discarded`, `warm_failed`): no second state.

Ended by: opt-out, disable, uninstall, trust loss, rollback, safe mode (`dynamic_harness::stop`), "Start agents ahead" off
(`providers::discard_all_warm_agents`), the task switching to another harness (`warm_launch::plan_rewarm`), a changed folder
or command, expiry, a send that finds the process dead (it starts cold; the next prewarm restarts it). A deleted task's spare
expires after 10 minutes. A start that finishes after a send, a switch or a disable is discarded.

## Locks touched (for the final audit of upstream issue #382)

* New: one `std::sync::Mutex` (`runtime_provider_speed::STORE`), held only for map operations, never across an await, a spawn,
  a file write, a wait or another lock. Processes are removed under it and ended or dropped after release. The opt-in file is
  written after the lock is released; a failed write restores the previous value.
* `runtime_provider_launch` state mutex: short counter updates, never nested with `STORE`.
* NOT touched: `providers/warm.rs` (`SPARES`, `TARGETS`, `LAUNCHES`, reservations), `warm_state.rs`, `warm_switch.rs`,
  `handshake_warm.rs` (`STATE`). Package harnesses are excluded from those (`handshake_warm::provider`, `warm::supported`).
* Hooks in the area: `warm_launch.rs` (`eligible`, `plan_rewarm`, `rewarm`) calls `participates`/`present` (own lock only) and
  `prewarm` instead of `providers::prewarm_reserved` for an opted-in package; `providers.rs` `has_warm_agent` reads
  `participates`/`present`; `discard_all_warm_agents` calls `speed_adapter::discard_all` after the upstream discards.

## Refusals kept (Q062, Q129)

Skill install and sync stay refused for a package harness (`UnsupportedCapability`: a launch harness owns no skill folder; a
capability gap, not a security rule). Retained denials with non-security reasons: opting in a package that does not declare
`warmSpare` (`UnsupportedCapability`, nothing to start), an untrusted package (`ExecutableTrustRequired`: its executable is not
reviewed), safe mode (nothing loads), a stale tier (`Choose a valid speed.`: the catalog changed), plan/fast switches on a
package harness (`UnsupportedCapability`: it publishes tiers, not a plan mode), a busy package lock (`HostUnavailable`).

## Tests

Spec `tests/extensions-runtime-provider-speed.spec.ts` (preview twin, canonical fake agent over stdio; ports 16221/16222).
Native: `runtime_provider_speed::tests` (pure) and `installed::tiers_reach_the_launch_and_an_opted_in_package_prewarms_...`
(feature `extension-runtime-native-tests`, Windows x64): demand-only default, opt-in, spawn counters, model/tier switch,
dead-spare failure and restart, opt-out, disable, cleanup. Fixture: `tests/fixtures/extensions/runtime-provider-speed/`.
