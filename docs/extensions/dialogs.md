# Declarative dialogs and quick picks (experimental)

A `showDialog` command action carries a `dialog` object, not HTML or serialized callbacks.
See the installable [menu laboratory](../../tests/fixtures/extensions/menu-laboratory/extension.json).
It works from `panda.workspace.header.actions`, `panda.sidebar.footer` and the existing
`panda.inspector.actions` strip when the inspector is open. Other inspector/view/secondary-window
adapters are not delivered by this slice.

Required dialog fields: `title`, `fields`, `successMessage`. Optional: `confirmLabel`, `confirmation`,
`cancelMessage`. The host identifies the extension visibly and in the modal's accessible name;
this is not a core permission dialog. At most 24 fields are accepted:

- `text`: `id`, `kind`, `label`, optional `value` (4096 characters), `required`, `minLength`.
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
