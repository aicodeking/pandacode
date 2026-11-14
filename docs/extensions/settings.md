# Core Settings presentation v1 (experimental)

## Decision

Before v1, packages could only add pages of their own (`contributes.settings`, see
[settings-actions.md](settings-actions.md)). The core sections, their rows and their
buttons in `src/settings.ts` had no public registry, order, visibility, action or
recipe contract. v1 adds the `panda.settings` family:

- an explicitly selected `panda.settings` closed `actions-first` recipe with
  `host-sections`, `host-controls`, `original-actions`. It moves each page header's
  action group ahead of the heading; it does not remount a page, an embed or a form;
- `panda.settings.sections` (left-column sections) and `panda.settings.controls`
  (eligible original rows), with order and reversible visibility;
- `panda.settings.actions` (an accessory in every core page header) and
  `panda.settings.context` (the section list's context menu);
- `panda.settings.protected`, inspect-only, listing each protected control with its
  reason;
- `settings[].section`, which places a package page as an owner-labelled group in an
  eligible core page instead of a section of its own.

Rejected alternatives: replacing the Settings engine or page renderers (would move
preference, credential and recovery ownership out of the host); a generic "write a
preference key" action (a package could change any setting, including security
defaults); a blanket "Settings is protected" exception (hides eligible controls behind
a few genuinely protected ones); letting packages hide sections themselves (only the
user hides, from the Surface explorer; packages propose order through `layouts`).

## Registry

`SETTINGS_REGISTRY` (`src/extensions/settings-core.ts`) has one entry per existing core
page, generated from `src/settings-sections.ts`, and the ledger's `settingsCoverage`
row must match it exactly (`tests/extensions-settings.test.mjs`).

| Section | Pages | Hide section | Eligible controls | Protected controls | Shared fields |
| --- | --- | --- | --- | --- | --- |
| Recommended | recommended | yes | — | — | no: live host checklist |
| General | general | yes | compact-mode, expand-tool-activity | project-remove | yes |
| Appearance | appearance | yes | toggle-theme, daily-wallpapers | — | yes |
| Voice | voice | no: speech provider keys | — | voice-key | no: key entry |
| Agents | agents, providers, teams, routing | no: credentials, privacy, checks consent | default-provider, default-model, agent-updates, refresh-agents | turn-checks, harness-privacy, provider-credentials, routing-opt-in | teams only |
| Schedules | schedules | yes | — | — | yes |
| Tools | tools, skills, rules | yes | agent-integrations, jev-settings | — | yes |
| Connections | cloud, remote, github | no: cloud credentials, pairing, sign-in | — | cloud-credentials, remote-pairing, github-sign-in | no |
| Extensions | extensions | no: trust and safe-mode recovery | — | extension-trust, safe-mode | no |
| About | about | no: updates, privacy, recovery | support | app-update | no |

Every section can be reordered and every page has the page-header action accessory
and the section context menu. A pinned section is never hidden, even by a forged
stored overlay; protected controls are not layout items at all, so they stay where
the host draws them. Embedded editors (provider keys, voice, cloud, remote, GitHub,
skills, rules, teams, routing, schedules) keep their own host forms; only the rows
listed above are eligible controls.

## Contract and policy

`settingsPresentation` and `settingsAction` are bounded JSON v1 contracts shared by
the schema, SDK (`SettingsComponent`, `SettingsPresentation`, `SettingsAction`),
native validator and catalog. The presentation captures window, mount, project (an
opaque handle, empty when none), page, section and a revision, plus visibility,
focus, busy (an open host dialog or a pending host choice), offline, safe mode, the
sections with their pinned/hidden state, and the shown page's eligible controls
(at most 64, opaque handles). No preference value, path, key, secret, selector or IPC
crosses it. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current mount,
project, page and revision, a control currently listed, enabled and not hidden on the
same page, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`,
`StaleContext`, `AlreadyApplied`, `Busy`, `Offline`. Switching pages, opening a dialog
or answering a host choice changes the captured state, so an older request is refused
instead of retargeted. An action activates the original node, so the original
handler and the existing preference persistence run. `compact-mode`,
`expand-tool-activity`, `toggle-theme`, `daily-wallpapers` and `support` first open a
fresh host choice ("Extension requested a Settings action"); the dialog openers
(`default-provider`, `default-model`, `agent-updates`, `agent-integrations`,
`jev-settings`) open the original host dialog where the user decides; only `support`
needs the network. The schema has no id for any protected control, so none can be
forged, invoked or replayed.

## Shared fields

A package settings page with `"section": "general"` (one of `general`, `appearance`,
`teams`, `schedules`, `tools`, `skills`, `rules`) renders as a group after that page's
core rows, headed by its title and labelled with its owner. Its values use the same
field grammar, explicit Save, IME guard and native `extensions_settings_get/set`
validation as an extension page, in the package's own namespace; they never reach a
core preference key. The page id stays its deep link and search entry
(`Settings › General › <title>`), landing on the core page. Credential, recovery and
checklist pages refuse placement in both validators.

## Presentation and recovery

Order and visibility are applied in place: rows and tabs keep their nodes, listeners,
focus and unsaved edits. The section being read stays listed until another is chosen;
hidden sections stay reachable through search, deep links and the keyboard shortcut,
and arrow keys skip them. Conflict never auto-selects a provider; future contract
versions are disabled. Fault, disable and safe mode restore the built-in order and
headers without changing the shown page, closing a dialog, discarding an unsaved
core edit or moving focus. With no package contributing there, the section list has
no context menu, as before.

Browser fixtures use the preview's in-memory storage and are not installed-native
qualification; no real settings file, credential, pairing or update is touched by the
tests.
