# Declarative dialogs and quick picks (experimental)

A `showDialog` command action carries a `dialog` object, not HTML or serialized callbacks.
See the installable [menu laboratory](../../tests/fixtures/extensions/menu-laboratory/extension.json).
It works from `panda.workspace.header.actions`, `panda.sidebar.footer` and the existing
`panda.inspector.actions` strip when the inspector is open. The installable
[view laboratory](../../tests/fixtures/extensions/view-laboratory/extension.json) also demonstrates:

- `panda.inspector.files.toolbar` / `panda.inspector.files.context`
- `panda.inspector.changes.toolbar` / `panda.inspector.changes.context`
- `panda.inspector.search.toolbar` / `panda.inspector.search.context`
- `panda.sidebar.project.context` / `panda.sidebar.task.context`

View toolbar controls appear in the inspector strip only for that selected built-in view. File,
changed-file and search-result context actions capture `selection: { kind: "file", ids: [path] }`
plus project/task IDs. Task rows capture their own task/project, including when not selected.
Project actions are reached by right-click or Shift+F10 on a project in the sidebar filter;
ordinary selection still filters/opens that project. Their context contains that project, not the
currently selected task. Closing the filter chooser hands focus ownership to its surviving trigger;
removing the logical project cancels the action. Other source rows cancel when detached/replaced.
Navigation never retargets pending dialogs/options/validation. Disable/unload aborts them and
suppresses late messages, with focus on a surviving host control. From a dialog extension band
([core-dialogs.md](core-dialogs.md), [owned-dialogs.md](owned-dialogs.md)) the form stacks in its own top-layer dialog above the host dialog;
from anywhere else it uses the shared dialog only when no other dialog is open.

Each location exposes owner/type/location-filtered catalog metadata and supports global/project
hide/show/order overlays and explicitly selected `ui.customize` layout proposals. Context menu core
IDs are `<location>/<legacy-id>` (for example `panda.sidebar.task.context/pin`); view strip core IDs
end in `/refresh` and `/hide`. Hidden actions do not revoke the underlying host command. Disabling
the package removes its contributions, retaining built-in nodes/handlers and dormant preferences.
Context menus reserve space for core actions within their shared 128-item bound; an oversized
contributed tree is omitted as a whole with a visible diagnostic, never by dropping legacy actions.
Inspector persistence remains the existing closed built-in view type; dynamic views, other content
adapters and secondary-window adapters are not delivered here.

Required dialog fields: `title`, `fields`, `successMessage`. Optional: `confirmLabel`, `confirmation`,
`cancelMessage`. The host identifies the extension visibly and in the modal's accessible name;
this is not a core permission dialog. At most 24 fields are accepted:

- `text`: `id`, `kind`, `label`, optional `value` (4096 characters), `required`, `minLength`.
- `textarea`: the same value contract as `text`, plus optional `rows` (2–12, default 4). Enter inserts
  a line break and never submits; the IME/229 guard still applies. Also accepted on Settings pages.
- `switch`: `id`, `kind`, `label`, optional boolean `value`.
- `select`: `id`, `kind`, `label`, `options`, optional `required`, `multiple`, `async`, `placeholder`.
  Options have separate `value` and `label`, optional `disabled`; at most 100 per reply. Search
  is bounded to 200 characters. A multi-select stays open until Done/Escape. Choices modify local
  form state only; cancelling the form performs no command/job/API side effect.

IDs must be unique lower-case local field names. Duplicate option values, malformed variants,
oversized data, callbacks and executable fields are rejected by the shared native/frontend schema.
The action can show a fixed bounded success/cancel message; it cannot start arbitrary work.

The dialog service owns its captured invocation context, modal/focus lifetime, validation and
confirmation states. Validation never reconstructs fields or clears inputs. Enter obeys the host's
IME/229 guard. Escape closes the top quick pick first, then cancels the form; Cancel also aborts
pending validation. Owner disposal cancels every request and ignores late replies without showing
a cancel/success message. A surviving trigger (or usable host control) regains focus. Another
owner's existing modal is never replaced; host replacement cancels the extension without closing
the new modal.

`async: true` uses the host's asynchronous, query-filtered declared catalog today. Loading, empty,
error/retry and last-query-wins semantics also apply to the host-internal callback transport, whose
inputs/results are copied, schema-bounded data with AbortSignals. No function or DOM handle can be
supplied in a package. Executable extension runtimes, external network loaders, public callback
registration and native/secondary-window UI qualification remain unavailable; preview test holds
are synthetic and do not establish native IPC/IME support.
