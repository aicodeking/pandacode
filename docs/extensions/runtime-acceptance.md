# Runtime acceptance map (R1302)

This page closes the loop from each decided permission to its native check, its fixture or spec and its author page, and
records what the final gates still have to prove. It is a map, not a test result: **everything below is "implemented +
compile-checked; tests written, not run"** (user decision 2026-11-16: no test ran while the code was written). The check that
this map stays true is `tests/extensions-runtime-completeness.test.mjs` (written, not run).

Candidate: `ab301f5` plus the uncommitted R1302 edits; the final candidate is the commit the final gate window names, and
every gate report must name the same one.

## Permission map

The fifty decided permission names (`MANIFEST_CAPABILITIES` in `src/extensions/contracts.ts`, the README table and
`tests/fixtures/extensions/examples-v1.json` agree) each map to the author page, the native owner that rechecks the grant on
every call, and the spec that exercises it. A grant is file-backed, revocable and narrowable; none is withheld for security
(ADR-0005), and no credential value is ever handed to a package (ADR-0006, there is no `credentials.read`).

| Permission | Author page | Native check | Spec |
|---|---|---|---|
| `btw.content` | `docs/extensions/runtime-family-consents.md` | `src-tauri/src/extensions/runtime_family_consents.rs` | `tests/extensions-runtime-family-consents.spec.ts` |
| `btw.taskControl` | `docs/extensions/runtime-family-consents.md` | `src-tauri/src/extensions/runtime_family_consents.rs` | `tests/extensions-runtime-family-consents.spec.ts` |
| `services.call` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/services.rs` | `tests/extensions-services.spec.ts` |
| `connections.request` | `docs/extensions/runtime-connection-adapters.md` | `src-tauri/src/extensions/runtime_connection_adapters.rs` | `tests/extensions-runtime-connection-adapters.spec.ts` |
| `tools.execute` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/jobs.rs` | `tests/extensions-jobs.spec.ts` |
| `ui.contribute` | `docs/extensions/README.md` | `src-tauri/src/extensions/contracts.rs` | `tests/extensions-install.spec.ts` |
| `ui.customize` | `docs/extensions/runtime-grants.md` | `src-tauri/src/extensions/runtime_grants.rs` | `tests/extensions-runtime-grants.spec.ts` |
| `ui.richViews` | `docs/extensions/runtime-rich-mount.md` | `src-tauri/src/extensions/runtime_rich_mount.rs` | `tests/extensions-runtime-rich-mount.spec.ts` |
| `storage.private` | `docs/extensions/runtime-code-folders.md` | `src-tauri/src/extensions/runtime_code_folders.rs` | `tests/extensions-runtime-code-folders.spec.ts` |
| `projects.summary` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/context.rs` | `tests/extensions-context.spec.ts` |
| `tasks.summary` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/context.rs` | `tests/extensions-context.spec.ts` |
| `harnesses.inventory` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/context.rs` | `tests/extensions-context.spec.ts` |
| `connections.summary` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/context.rs` | `tests/extensions-context.spec.ts` |
| `jobs.summary` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/context.rs` | `tests/extensions-context.spec.ts` |
| `projects.files.metadata` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/project_reads.rs` | `tests/extensions-project-reads.spec.ts` |
| `projects.files.read` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/project_reads.rs` | `tests/extensions-project-reads.spec.ts` |
| `projects.git.read` | `docs/extensions/runtime-native-consents.md` | `src-tauri/src/extensions/project_reads.rs` | `tests/extensions-project-reads.spec.ts` |
| `tasks.transcript.read` | `docs/extensions/runtime-content-resources.md` | `src-tauri/src/extensions/runtime_content_resources.rs` | `tests/extensions-runtime-content-resources.spec.ts` |
| `tasks.tools.read` | `docs/extensions/runtime-content-resources.md` | `src-tauri/src/extensions/runtime_content_resources.rs` | `tests/extensions-runtime-content-resources.spec.ts` |
| `runtime.service` | `docs/extensions/runtime-service-lifetime.md` | `src-tauri/src/extensions/runtime_service_lifetime.rs` | `tests/extensions-runtime-service-lifetime.spec.ts` |
| `events.workspace` | `docs/extensions/runtime-workspace-events.md` | `src-tauri/src/extensions/runtime_workspace_events.rs` | `tests/extensions-runtime-workspace-events.spec.ts` |
| `ui.dynamic` | `docs/extensions/runtime-dynamic-items.md` | `src-tauri/src/extensions/runtime_dynamic_items.rs` | `tests/extensions-runtime-dynamic-items.spec.ts` |
| `ui.notify` | `docs/extensions/runtime-notifications.md` | `src-tauri/src/extensions/runtime_notifications.rs` | `tests/extensions-runtime-notifications.spec.ts` |
| `ui.presentation` | `docs/extensions/runtime-transcript-presentation.md` | `src-tauri/src/extensions/runtime_composer_band.rs` | `tests/extensions-runtime-composer-band.spec.ts` |
| `tasks.start` | `docs/extensions/runtime-tasks-start.md` | `src-tauri/src/extensions/runtime_tasks_start.rs` | `tests/extensions-runtime-tasks-start.spec.ts` |
| `tasks.message` | `docs/extensions/runtime-tasks-messages.md` | `src-tauri/src/extensions/runtime_tasks_messages.rs` | `tests/extensions-runtime-tasks-messages.spec.ts` |
| `tasks.draft` | `docs/extensions/runtime-tasks-drafts.md` | `src-tauri/src/extensions/runtime_tasks_drafts.rs` | `tests/extensions-runtime-tasks-drafts.spec.ts` |
| `tasks.control` | `docs/extensions/runtime-tasks-control.md` | `src-tauri/src/extensions/runtime_tasks_control.rs` | `tests/extensions-runtime-tasks-control.spec.ts` |
| `tasks.usage.read` | `docs/extensions/runtime-usage-resources.md` | `src-tauri/src/extensions/runtime_usage_resources.rs` | `tests/extensions-runtime-usage-resources.spec.ts` |
| `harnesses.limits.read` | `docs/extensions/runtime-usage-resources.md` | `src-tauri/src/extensions/runtime_usage_resources.rs` | `tests/extensions-runtime-usage-resources.spec.ts` |
| `harnesses.accounts.read` | `docs/extensions/runtime-usage-resources.md` | `src-tauri/src/extensions/runtime_usage_resources.rs` | `tests/extensions-runtime-usage-resources.spec.ts` |
| `harness.hooks.observe` | `docs/extensions/runtime-hook-registration.md` | `src-tauri/src/extensions/runtime_hook_registration.rs` | `tests/extensions-runtime-hook-registration.spec.ts` |
| `harness.hooks.decide` | `docs/extensions/runtime-hook-decisions.md` | `src-tauri/src/extensions/runtime_hook_decisions.rs` | `tests/extensions-runtime-hook-decisions.spec.ts` |
| `harness.hooks.context` | `docs/extensions/runtime-hook-context.md` | `src-tauri/src/extensions/runtime_hook_context.rs` | `tests/extensions-runtime-hook-context.spec.ts` |
| `harness.companions` | `docs/extensions/README.md` | `src-tauri/src/extensions/runtime_grants.rs` | none: R0601-R0606 skipped by user decision 2026-11-17 |
| `harness.console` | `docs/extensions/runtime-harness-console.md` | `src-tauri/src/extensions/runtime_harness_console.rs` | `tests/extensions-runtime-harness-console.spec.ts` |
| `tools.model` | `docs/extensions/runtime-model-tools.md` | `src-tauri/src/extensions/runtime_model_tools.rs` | `tests/extensions-runtime-model-tools.spec.ts` |
| `models.call` | `docs/extensions/runtime-model-call.md` | `src-tauri/src/extensions/runtime_model_call.rs` | `tests/extensions-runtime-model-call.spec.ts` |
| `secrets.private` | `docs/extensions/runtime-private-secrets.md` | `src-tauri/src/extensions/runtime_private_secrets.rs` | `tests/extensions-runtime-private-secrets.spec.ts` |
| `credentials.use` | `docs/extensions/runtime-held-credentials.md` | `src-tauri/src/extensions/runtime_connection_adapters.rs` | `tests/extensions-runtime-held-credentials.spec.ts` |
| `auth.signIn` | `docs/extensions/runtime-sign-in.md` | `src-tauri/src/extensions/runtime_sign_in.rs` | `tests/extensions-runtime-sign-in.spec.ts` |
| `documents.editors` | `docs/extensions/runtime-document-editors.md` | `src-tauri/src/extensions/runtime_document_editors.rs` | `tests/extensions-runtime-document-editors.spec.ts` |
| `workspace.manage` | `docs/extensions/runtime-workspace-automation.md` | `src-tauri/src/extensions/runtime_workspace_automation.rs` | `tests/extensions-runtime-workspace-automation.spec.ts` |
| `workspace.settings` | `docs/extensions/runtime-workspace-settings.md` | `src-tauri/src/extensions/runtime_workspace_settings.rs` | `tests/extensions-runtime-workspace-settings.spec.ts` |
| `terminals.read` | `docs/extensions/runtime-terminals.md` | `src-tauri/src/extensions/runtime_terminals.rs` | `tests/extensions-runtime-terminals.spec.ts` |
| `terminals.write` | `docs/extensions/runtime-terminals.md` | `src-tauri/src/extensions/runtime_terminals.rs` | `tests/extensions-runtime-terminals.spec.ts` |
| `guests.control` | `docs/extensions/runtime-guests.md` | `src-tauri/src/extensions/runtime_guests.rs` | `tests/extensions-runtime-guests.spec.ts` |
| `projects.checks.run` | `docs/extensions/runtime-workspace-projects.md` | `src-tauri/src/extensions/runtime_workspace_projects.rs` | `tests/extensions-runtime-workspace-projects.spec.ts` |
| `metrics.read` | `docs/extensions/runtime-usage-resources.md` | `src-tauri/src/extensions/runtime_usage_resources.rs` | `tests/extensions-runtime-usage-resources.spec.ts` |
| `internal.unstable` | `docs/extensions/runtime-internal-unstable.md` | `src-tauri/src/extensions/runtime_internal_unstable.rs` | `tests/extensions-runtime-internal-unstable.spec.ts` |

## Reconciliation counts

- The survey of refusals and limits lists 417 classified rows in section 1 (114 `PERM`, 99 `STAYS`, 204 `UNCLEAR` at the time
  of the survey); the plan counts 419 source-id occurrences (duplicates kept) and 130 rows in section 3 (`Q001` to `Q130`).
  The difference of two between 417 rows and 419 occurrences is recorded here as a survey/source count drift, not dropped.
- The `UNCLEAR` rows were historical: ADR-0005 resolves each one to a permissioned operation (the map above) or to a
  protection kept for fault isolation, predictability, stability, the operating system, recovery or irreversibility.
  **Per-row closure of the 419 occurrences and the 130 rows was not walked in this pass**: each family has its owner task and
  receipt section, and the row-by-row walk (source, contract, native grant, fixture, receipt) is final-phase work, listed in
  the issues file of the work folder. Until it is done, full closure is not claimed.

## Refusal-test reconciliation owned by R1302 (Q066, Q067, Q128)

These three rows assert that the protected controls of the core families stay refused with `PermissionDenied`. This slice
delivered no permissioned operation for any protected control, so no assertion was changed and none was weakened. Every
retained refusal has a reason that is not security:

| Row | Test | Retained refusal | Reason (not security) |
|---|---|---|---|
| Q066 | `tests/extensions-gap-closure.test.mjs`, nine family specs | Protected control ids of each family answer `PermissionDenied`, and every ledger `protectedControls` id appears in the core source | Predictability and recovery: the user can always find Send, Stop, approvals and the safe-mode and trust controls; a package may reorder or hide the ordinary controls around them |
| Q067 | `tests/extensions-gap-closure.test.mjs` | Each adapter block keeps non-empty `protected` and `protectedControls` | Stability: the ledger proves the host kept the controls whose loss would leave the user without a way back |
| Q128 | `tests/extensions-gap-closure.spec.ts` | A contributed action never calls `stop_session`, `delete_session`, `remove_project`, `bot_delete`, `schedule_delete` and the other listed host commands with a forged target, and a package slash command never reaches the harness | Irreversibility and fault isolation: a contributed action runs with its own captured target; the permissioned way to the same power is the namespaced call (`tasks.control`, `workspace.manage`, `tasks.message`), checked natively and confirmed by default for deletions |

Unauthorized, stale and foreign-owner denials are retained throughout (the grants, the context handle and the owner checks).

## Not closed, stated plainly

- Companion line R0601-R0606: skipped by user decision 2026-11-17; rows that need a companion read "pending - separate user
  design" ([parity](runtime-parity.md)).
- Pending person decisions: A5 (package tools to ZCode), live Claude hook capture, macOS and Linux runners (those targets stay
  `UnsupportedRuntime`), the tracked `tests/fixtures/extensions/backends/evidence/` files.
- Preview, native fixtures and installed or live qualification are separate columns in the receipt; installed and live is
  pending everywhere. A fake or preview test never stands in for a missing real-harness, runner or remote-placement result.
- The final broad gates (zero-extension, all-disabled and safe-mode suites, native and both engines, one run per unchanged
  candidate) have not run.
