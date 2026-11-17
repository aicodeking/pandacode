# Rich panels mounted in host surfaces (R0301)

A trusted package's rich view (`contributes.views[].rich`, permission `ui.richViews`) mounts in the inspector, where its
host-rendered view mounts, and keeps the separate window. ADR-0001 decides that panels live in the main window; ADR-0005
decides that the boundary around them is fault isolation, not a security limit.

## Who may mount a panel

All of these, checked natively on every open and again after every lifecycle change:

1. The package is enabled and the app is not in safe mode.
2. Its executable content is trusted. A package with a rich view is code (ADR-0001): installing it records an
   executable digest, and enabling it answers `ExecutableTrustRequired` until the user reviews that digest
   (Settings → Extensions → Review executable trust), with or without a `runtime`. Packages with only declarative views
   need no trust.
3. It holds `ui.richViews` in the grants file (`RuntimeGrants::check`).
4. The platform is qualified: `runtime_rich_mount::RICH_TARGETS` (Windows x64 first). Every other target answers
   `UnsupportedRuntime`, and the view keeps its host-rendered `text`.

Without any of them the inspector shows the host-rendered text and a note that says what is missing; no frame, webview
or window is created.

## Placements and techniques

| Placement | Installed app (`native-webview`) | Browser preview (`browser-iframe`) |
|---|---|---|
| `inspector` (default) | A child webview of the main window, `extension-panel-<uuid>`, placed over the panel element (`extensions_rich_mount_open`, `_bounds`, `_close`). The app's content policy keeps `frame-src 'none'`, so an installed panel is never an iframe of the app document. Hidden while a dialog, Settings or an overlapping menu covers it. | A sandboxed `allow-scripts` iframe of the host page holding the same isolated shell. |
| `window` | The existing separate window (`extensions_rich_view_open`), now gated by trust, grant and qualification. | A popup with the same shell (mount fixtures only; other packages keep the legacy characterization of `rich-views.ts`). |
| `floating` | `UnsupportedContribution` until the original's editor window is in the tree. | Same. |

`rich.placement` says where the view opens the first time; `"window"` leaves the inspector with the host-rendered view
and the window button. `rich.minSize` (`width` 160 to 2,000, `height` 160 to 2,000 for these placements; the schema
admits 24 for band views) is the panel's minimum size; a smaller mount scrolls.

The panel webview has no command grant: `windows::command_allowed` refuses every label but the main and auxiliary ones,
and no capability names `extension-panel-*`. The document is the same shell as the separate window (host-composed data
URL, package code in a nested sandboxed frame).

## Lifecycle and fault containment

- **Disable, uninstall, update, untrust, revoke, safe mode.** `rich_views::reconcile` (every lifecycle change) and the
  grant command (`runtime_rich_mount::sweep_app`) end the windows and panels they no longer allow; a panel's end is sent
  to the main window as `extensions-rich-mount-ended { mountId, reason }` with `reason` one of `disabled`, `changed`,
  `untrusted`, `revoked`, `safe-mode`. The inspector then shows the host-rendered view; when the package is gone its
  inspector tab goes and the built-in tabs stay.
- **A panel that throws.** The client reports the first uncaught error once (`fault`); the shell removes the frame,
  writes `panda-view:failed:error` in its title and shows a reload control. In the inspector the host closes the panel
  and shows "failed" with **Reload panel**.
- **A panel that loops or never starts.** The shell pings its frame every second and fails it after three unanswered
  beats. If the shell itself is stuck, the host's watchdog sees no beat (title `panda-view:alive:<n>` natively, a
  message in the preview) for 6 s (10 s before the first beat) and destroys the panel. Hidden panels and minimized
  windows pause the watchdog (their timers may be throttled).
- Tasks, terminals and the draft are never touched by any of this.

## Refusals reconciled by this slice

| Row | Disposition |
|---|---|
| Q020 (`contracts.rs` primitive declaration: a view control with `html`, a `chart` control) | Retained for host-rendered controls: they render into the app's own document, so package markup there would share the app's document and bridge (fault isolation, interface stability). The permissioned HTML path is `view.rich` with `ui.richViews` (this slice); R0205 owns the field/`onInput` part. |
| Q057 (`extensions-views.test.mjs` view control of kind `html`) | Retained, same reason. New positive test: a rich view with `ui.richViews`, `placement` and `minSize` validates; without the grant it is `PermissionDenied`. |
| Q059 (`PRIMITIVES.excluded` has `markup`) | Retained for primitives (same reason); `markup` is reachable as a rich view. R0205 and R1301 own the other parts of the row. |
| Q061 (replacement components `presentation: 'html'`, `render`) | Retained: a replacement component is host-rendered data in the app document; HTML is a rich view in its own frame or webview. R1002 owns the replacement operations. |
| Q119 (`extensions-rich-views.spec.ts` separate window only; zero extensions and safe mode) | Changed: an installed rich package now waits for executable trust before enable (the spec reviews trust first), and the panel also mounts in the inspector (`extensions-runtime-rich-mount.spec.ts`). Retained: zero extensions and safe mode create no presentation (safe mode runs nothing of any package); "presentation data only" belongs to R0303. |

Retained denials that are not security limits: a missing or revoked grant, untrusted content, a stale version or a
foreign owner answer `PermissionDenied`/`ExecutableTrustRequired` (the grant and the trust belong to the installed
version); the eight-window and eight-panel limits (memory of the webviews); forged request fields (`InvalidShape`).

## Evidence columns

- Preview: `tests/extensions-runtime-rich-mount.spec.ts` (browser iframe; loop containment in Chromium only, because
  WebKit has no out-of-process frames).
- Native fixtures: `rich_views::runtime_rich_mount::tests`, `rich_views::tests`,
  `packages::tests::installed_rich_mount_fixture_needs_trust_and_grant_while_a_declarative_package_needs_neither`.
- Installed qualification: pending. Windows x64 is on in code, like the runtime target; the recorded installed run of
  the `rich-panel` scenario (`runtime_platform_qualification`) is the evidence that confirms it.

## Limits

- The preview mounts only the canonical fixtures it can import (`sample.rich-mount/board`, `sample.rich-view/report`).
- A mounted inspector panel does not follow theme changes yet, and a hidden inspector tab does not keep its panel alive
  (the instance, state and channel contract is R0303; folders, origins and remote pages are R0302).
- The user's later placement choice is not persisted yet; `rich.placement` decides each time.
