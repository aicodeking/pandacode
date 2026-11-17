# A panel without a service (R0305)

A trusted package may ship only panels: no `runtime`, no background service, nothing in the Running list, no process.
Its panels are the same rich panels as a service package's ([runtime-rich-mount.md](runtime-rich-mount.md),
[runtime-rich-assets.md](runtime-rich-assets.md), [runtime-rich-channel.md](runtime-rich-channel.md),
[runtime-rich-focus.md](runtime-rich-focus.md)): it needs executable trust (a panel is code) and `ui.richViews`.
ADR-0001 decides that panels are code with a data channel; ADR-0005 decides that the rules below exist for
predictability and fault isolation, not for security. Contract: G4 in the runtime contracts.

```json
{
  "id": "sample.panel-only",
  "permissions": ["ui.contribute", "ui.richViews", "ui.notify", "ui.dynamic", "storage.private"],
  "contributes": {
    "views": [{ "id": "sample.panel-only/sketch", "title": "Sketch", "text": "Host-rendered sketch.",
      "rich": { "folder": "canvas", "entry": "index.html", "placement": "inspector" } }]
  }
}
```

```js
// canvas/app.js: no service anywhere.
pandaView.onDidInitialize(init => draw(init.state?.strokes ?? []));
pandaView.state.set({ strokes });                                    // kept across hiding, reloads and failures
await pandaView.panda.ui.notify({ key: 'sketch', text: 'Saved' });   // the package SDK, through the host
await pandaView.postMessage({ kind: 'saved' });                      // UnsupportedCapability: no service
await pandaView.panda.storage.directory({ scope: 'global' });        // UnsupportedCapability: service-only
```

## What works

- **Page state.** `pandaView.state`, the instance, visibility, theme, focus and minimum size are the host's, not a
  service's: they work the same with no service (`runtime_rich_channel`, `runtime_rich_focus`).
- **The SDK in a panel.** `pandaView.panda` offers every call the package holds a grant for, except the service-only
  calls. The proxied calls go through the same server as a service's requests, which never needs a running process,
  so the grant is checked natively on every call and every action is labelled with the package's name.
- **Zero processes.** `runtime_service_lifetime::desired` wants no service for a package that declares none, even with
  every grant assumed; `runtime.service` is not declared, so it cannot be granted. Nothing appears in the Running list.

## What answers `UnsupportedCapability`

| Call | Why |
|---|---|
| `pandaView.postMessage` | There is nobody to receive it (`NO_SERVICE`: "this package has no background service to receive panel messages. Use pandaView.panda for host calls.") |
| `storage.directory`, `secrets.*`, `auth.*`, `internal.*`, handler registrations (`events`, `hooks`, `modelTools`, `commands`, `views`, `providers`) | Service-only in every panel ([runtime-rich-channel.md](runtime-rich-channel.md)): secrets never reach a webview, and a handler must outlive a panel. Durable page data goes to the page's own storage (its origin's) or to a service |

`context.query` of resources that belong to an owned command answers `StaleContext`, as in every panel.

## Page work and the lifecycle

What a page made through the host (notices, live items, a dialog or a task start waiting for the user) is the
package's work, the way a service's work is: it outlives the document that made it (a reload, a closed panel, a
failure) and lives while the package may show panels.

A disable, uninstall, update, untrust, safe mode or a revoke of `ui.richViews` (the panel's lifetime authority, as
`runtime.service` is a service's):

1. ends every mount of the package (`runtime_rich_mount::reconcile`), so the page's timers and requests stop with
   its webview, whether the panel is live, hidden, failed or hung;
2. gives the keyboard back: a panel that had it hands it to the main window, which focuses the control that had it
   before the panel (`runtime_panel_only::release_focus`, the same `release` the panel's Escape sends). The same
   happens when the watchdog ends a focused panel that failed;
3. drops the kept state of its closed and failed instances (`runtime_rich_channel::reconcile`);
4. ends the page's work once (`runtime_panel_only::reconcile`): its live items, dialogs, waiting task starts and
   notices go, as at a service's end (notices with the recorder reason `panel-ended`). A package that declares a
   service is left to its service's end.

The host is then as it was without the package: no frame, no webview, no live item or notice of it, the keyboard in
the app; a revoked view shows its host-rendered text and a note, a disabled package's view is gone. A failed panel
whose package was disabled, untrusted or put in safe mode is no longer offered a reload.

## Refusals reconciled by this slice

None of the Q rows names R0305. The service-only list and `postMessage` without a service are R0303's rows, kept with
the same reasons. Retained denials that are not security limits: a missing grant (per call), an untrusted, disabled
or stale package, safe mode.

## Evidence columns

- Preview: `tests/extensions-runtime-panel-only.spec.ts`. Node: the page host (`src/extensions/runtime-panel-only.ts`,
  `PanelOnlyPages`) over the R0303 panel host and the R0208 runner's page panda (`RuntimePreview.pageCall`), never
  started (`starts` stays 0). Browser: the canvas fixture installed in the app preview (`?rich-assets`, package
  origins answered by `respondPanel`), drawn, reloaded, calling supported and service-only APIs, then disabled,
  failed and revoked. Registered in both Playwright configurations (WebKit grep `extensions panel only:`) and in CI
  (ports 16421/16422).
- Native fixtures: `rich_views::runtime_panel_only::tests` (install through the real validator with every declared
  grant and zero spawns from two reconciles, routes and refusals, page work ending once per lifecycle reason, a
  failed panel's kept state, the focused instance), fixture `tests/fixtures/extensions/runtime-panel-only/`.
- Installed qualification: pending. Focus returning to the main window when a focused child webview is destroyed is a
  design assumption until the installed `rich-panel` scenario records it.

## Limits

- In the browser preview the page's notices and live items stay in the page host (the preview runner's twins); they
  are not shown in the preview's status bar or notice list.
- The preview's page host follows the lifecycle of packages whose panel was mounted at least once in the page.
- The legacy inline form has no channel, so its focus is not known to the host; its end releases nothing.
