# Panel focus, keys, hidden panels and size (R0304)

A trusted package's rich panel (`ui.richViews`, see [runtime-rich-mount.md](runtime-rich-mount.md) and
[runtime-rich-channel.md](runtime-rich-channel.md)) shares the keyboard with the app, survives tab and task switches,
and keeps its declared minimum size. ADR-0001 decides that panels live in the main window; ADR-0005 decides that the
bounds below exist for memory and predictability, not for security.

## Keyboard

```js
pandaView.releaseFocus();          // give the keyboard back to the control that had it before the panel
addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save(); }   // the panel keeps it
});
```

- While a panel has focus, every key goes to its page. The client script forwards to the host only what the page left
  alone: a key-down the page did not `preventDefault()` that is **Escape** or carries the platform's **command
  modifier** (Cmd on macOS, Ctrl elsewhere) and is not itself a modifier. So a panel keeps Ctrl+S or Ctrl+Enter by
  handling them, and arrow keys and typing never reach the app.
- Keys of an input-method composition are never forwarded (the app's `isImeKey` rule: `isComposing`, or WebKit's
  committing Enter with key code 229), so an IME entry in a panel is never submitted or cancelled by the host.
- A forwarded **Escape**, and `pandaView.releaseFocus()`, return focus to the app control that had it before the
  panel (or to the panel's own tab stop when that control is gone).
- A forwarded **chord** is pressed in the app: a key-down on the app document's body, so the app's global shortcuts
  run (Ctrl/Cmd+B toggles the sidebar) and no focused control acts on it.
- **Entering.** An installed panel is one stop in the app's tab order (its slot); reaching it with Tab moves the
  keyboard into the panel's webview. Clicking the panel gives it focus. In the browser preview the frame is the tab
  stop and Tab also leaves it.
- The same rules hold in the inspector and in the separate window, because the client script implements them; in a
  window, Escape and `releaseFocus` focus the main window again.

### Transport

| Shell | Keys and `releaseFocus` reach the host as |
|---|---|
| Served folder or remote page with the client, installed | `POST /~panda/channel` with kind `key` (`key`, `code`, `ctrlKey`, `metaKey`, `shiftKey`, `altKey`) or `release`, closed shapes bound to the mount's session (`runtime_rich_focus::parse`), at most 40 in any two seconds per mount |
| Legacy inline form, installed (its document pins `connect-src 'none'`) | Its title: `panda-view:key:<n>:<flags>:<code>:<key>` (Ctrl 1, Cmd 2, Shift 4, Alt 8) or `panda-view:release:<n>`, read by the same title callback as the heartbeat; `<n>` only grows |
| Browser preview | A message from the shell frame to the host page (`runtime-rich-focus.ts` `fromFrame`) |

The native side gives the keyboard to the main window (`set_focus` on its window and webview) and emits
`extensions-rich-focus` `{ mountId, kind: "release" }` or `{ mountId, kind: "key", ... }` to the main window only.
Nothing a panel sends becomes a native command: panel webviews still hold no command grant.

## Visibility and kept-alive panels

- A panel's visibility follows the host: its slot's box, a dialog, Settings or an overlapping menu covering it, and
  the main window being hidden or minimized (`document.hidden`). The instance and its service hear each change once
  (`onDidChangeVisibility`, `views.on('visible' | 'hidden')`).
- **Installed.** When an inspector panel's view leaves the screen (another inspector tab, another task, the inspector
  closed), the panel is **parked**: its webview is hidden with its document, focus and page storage kept, and its
  watchdog paused. Showing the view again shows the same document.
- At most **four** parked panels live in the whole app (`RETAINED_LIMIT`). Parking a fifth closes the least recently
  shown one after 250 ms (time for the page to deliver its last `pandaView.state`), keeping its instance's state;
  showing it again creates a new document initialized with `restored: true` and that state. A second mount of the
  same view replaces its older park. Visible panels are not counted; the limits of eight live panels and eight rich
  windows stay. A closed panel's webview is destroyed, so its renderer process ends with it.
- **Browser preview.** A frame removed from the page cannot keep its document, so every hidden preview panel is
  closed at once and comes back restored from its state (the path an evicted installed panel takes).

## Size

- `rich.minSize` (`width` and `height` 160 to 2,000; default 160 by 240) is the panel's minimum. A smaller mount
  scrolls; the page is never scaled.
- **Installed.** The webview covers only the visible part of its slot (it cannot be clipped like an element), and the
  shell gets the minimum from its address (`#panda-min=<w>x<h>`, a fragment never sent anywhere): its frame keeps that
  size and the shell scrolls. A separate window's minimum size is at least `minSize`.
- **Browser preview.** The frame keeps the minimum and the inspector slot scrolls.
- Nothing animates layout: no transition of width, height, position or grid on the slot, the surface or the frame.

## Refusals reconciled by this slice

None of the Q rows names R0304. Retained denials that are not security limits: a key that is not forwardable, an
extra field or another session (`InvalidShape`); more than 40 forwards in two seconds per mount (`LimitExceeded`);
`extensions_rich_focus` from any webview but the main window (`PermissionDenied`) or for a mount that is gone
(`StaleContext`).

## Evidence columns

- Preview: `tests/extensions-runtime-rich-focus.spec.ts` (the shared table
  `tests/fixtures/extensions/runtime-rich-focus/forwarding.json`, the real client in a VM, and the mounted
  `sample.rich-mount` frame: Tab in, Escape and `releaseFocus` out, a host chord, IME keys, minimum size, five
  switches without a leftover frame). Registered in both Playwright configurations (WebKit grep
  `extensions rich focus:`) and in CI.
- Native fixtures: `rich_views::runtime_rich_focus::tests` (the same table and the title signals, five parked panels
  keep four, minimum size, forged requests, no command grant).
- Installed qualification: pending. The parked webview keeping its document and focus, the shell's minimum size
  through the address fragment, `set_focus` across the main and child webviews, and the inline title signals are
  design assumptions until the installed `rich-panel` scenario records them.

## Limits

- The legacy inline form's title signals can be coalesced by the platform when two arrive within one title event;
  a lost key is not repeated. A served panel uses the channel, which is ordered.
- In the installed app, Tab inside a panel cycles within its page; Escape or `releaseFocus` leaves it (a webview has
  no way to hand sequential focus back to its parent window).
- The floating placement is not in the tree yet; its rules will be the same because the client implements them.
