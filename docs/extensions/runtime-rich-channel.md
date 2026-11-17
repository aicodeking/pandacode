# Panel instances and the panel-service channel (R0303)

A trusted package's served panel (a `rich.folder`, or a remote page that includes the client script; see
[runtime-rich-assets.md](runtime-rich-assets.md)) is an **instance** that talks to the package's background service.
It keeps a small state, follows the app's appearance and visibility, and reaches the package SDK through the host.
Everything is under `ui.richViews` (with `runtime.service` for the service side). ADR-0001 decides that panels are code
with a data channel. ADR-0005 decides that the bounds below exist for responsiveness and stability, not for security.

## The panel's side

```js
pandaView.onDidInitialize(init => {
  // init: { dto, theme, instanceId, viewId, placement, restored, state }
  render(init.state);
});
pandaView.onMessage(message => apply(message));                     // from the service
pandaView.onDidChangeVisibility(({ visible, focused }) => pause(!visible));
await pandaView.postMessage({ kind: 'claim', issueId: 'T-1' });      // to the service; resolves null
pandaView.state.set({ selected: 'T-1' });                           // synchronous; throws LimitExceeded > 256 KiB
await pandaView.panda.tasks.start({ projectId, prompt });           // the package SDK, through the host
```

- `viewId`, `instanceId` and `baseUrl` are properties. `instanceId` is empty until initialization.
- `onDidChangeVisibility` is called once after initialization and at every change, because a hidden frame may never
  fire the page's own visibility event. `visible` comes from the host (the inspector's bounds, a minimized window).
  `focused` is the shell's focus, frame included.
- `state` holds at most 256 KiB of JSON. It survives hiding, a reload and a failure of the panel for one run of the
  app. It does not survive a restart: durable data goes to `storage.private` or to the page's own storage.
- `postMessage` answers `UnsupportedCapability` in a package without a service, `HostUnavailable` while the service
  is not running, and `LimitExceeded` past the bounds.
- `pandaView.panda` offers every call the package holds a grant for, except the **service-only** calls: `secrets.*`,
  `auth.*`, `storage.directory`, `internal.*` and every handler registration (`events`, `hooks`, `modelTools`,
  `commands`, `views`, `providers`). Those answer `UnsupportedCapability` in the panel and again in the host. Secrets
  never reach a webview (ADR-0006), and a handler must outlive a panel. Context reads that belong to an owned command
  (`context.query` of other resources) answer `StaleContext`, because a panel is not a command invocation.
- Errors carry `code` (what a program tests) and a `message` that says what to do.

## The service's side

```js
panda.views.on('opened', instance => panda.views.post(VIEW, snapshot(), { instance: instance.instanceId }));
panda.views.onMessage(VIEW, async (message, from) => {
  await claim(message.issueId);
  await panda.views.post(VIEW, { kind: 'claimed', issueId: message.issueId }, { instance: from.instanceId });
});
board.onChange(() => panda.views.post(VIEW, snapshot()));            // { delivered: n }
const live = await panda.views.instances(VIEW);
```

- `post` without `instance` goes to every live instance of the view, in order, and answers how many received it. A
  message posted while no instance is alive is not queued (`delivered: 0`): the service keeps the truth, and a panel
  gets a snapshot when it opens. A targeted post reaches only that instance. A closed or unknown instance, or another
  package's instance, receives nothing.
- `on('opened' | 'visible' | 'hidden' | 'closed')`. An instance is `opened` once per live period. A failure or a
  reload of an inspector panel is `closed` and then `opened` again with the same `instanceId` and `restored: true`.
- A `viewId` that is not a rich view of the package answers `NotFound`. Without `ui.richViews` (or untrusted,
  disabled, in safe mode) the answer is `PermissionDenied` or `ExecutableTrustRequired`.

## Instances

| Placement | Instance | Window |
|---|---|---|
| Inspector (`extension-panel-<uuid>`) | The slot `main:<viewId>`: a reload, a failure or a reopen in this run reattaches the same instance and its state | `main` |
| Separate window (`extension-view-<uuid>`) | The window: a reload of the window keeps it; closing ends it | its label |

At most 64 closed inspector instances keep their state (least recently shown go first). A disable, uninstall, update,
untrust, revoke or safe mode removes them (`runtime_rich_channel::reconcile` after every lifecycle change). Keeping
hidden panels alive, with at most four hidden webviews, is R0304.

## Bounds (each answers `LimitExceeded` with what to do)

| Bound | Value | Why (ADR-0005) |
|---|---|---|
| A panel message, either direction | 256 KiB of JSON. Send larger data in chunks | Responsiveness of the main window |
| Messages per package | 20 per second in each direction, averaged over 2 s (40 in any two seconds) | Responsiveness of the main window |
| `pandaView.state` | 256 KiB per instance | Held in the host's memory |
| Requests waiting in a panel | 64 | Bounded memory of the page |
| Messages kept for a reloading document | 64; dropped when the instance closes | Bounded memory |
| Panel messages waiting in the service | the service channel's 64 pending calls | The duplex channel's bound (R0201) |

Closing an instance, or a disable or revoke, drops its pending messages and the replies still in flight. An instance
closed mid-response gets nothing, and a later targeted post answers `delivered: 0`.

## Transport

- **Installed.** The shell on the package origin sends `POST /~panda/channel` (the `pandapanel` scheme). The host knows
  the requesting webview, so no field of the body names an instance, a window or an owner. Request shapes are closed:
  `hello`, `bye`, `post`, `state`, `focus`, `call`, each bound to the mount's session. `invoke`, or a `command` field,
  is never one. Messages and replies come back as `Webview::eval` of one fixed statement that dispatches a
  `panda-view-host` event carrying JSON, and the shell checks the session. Panel webviews still have no command grant
  (R0301), and nothing a panel sends becomes a native command. The service side is a host call `panel` over the
  service's duplex channel (`ServiceLifetime::call_panel`). `views` requests are served natively per call, and a panel's
  proxied calls go through the same server as the service's requests (`app_dispatch`), so grants are checked per call.
- **Browser preview.** The shell is a frame of the page, so the same requests and pushes travel by `postMessage`
  (`PreviewPanelHost` in `src/extensions/runtime-rich-channel.ts`). The source window is the identity.
- **Theme.** The main window emits its appearance as the event `extensions-rich-channel-theme`: a scheme and at most
  16 known tokens. It does so once, when the first panel or window opens, and again at every palette change. Only the
  main window may emit events: `core:default` is its capability alone, panels hold no command grant, and the auxiliary
  windows only listen. The host checks the theme against the finite schema (`runtime_rich_channel::set_theme`), and
  every initialized instance follows it. The listener is installed once, from `reconcile_app`, so this slice adds no
  IPC command.
- **Remote pages.** The shell opens a remote page with `#panda-session=<session>` in its address. A fragment never
  reaches the remote server. A page that includes the client script (the SDK's `sdk/panda-view.js`, the same file as
  `/~panda/client.js`) reads the session there and gets `pandaView` with the channel. Without the script, the page is
  shown and has no channel.
- **The legacy inline form** (`html`/`css`/`script`) keeps its presentation-only init. Its host-composed document pins
  `connect-src 'none'` by hash (Q026 retained), so it has no return path: `postMessage` and `pandaView.panda` answer
  `UnsupportedCapability`. Declare `rich.folder` for the channel.

## Refusals reconciled by this slice

| Row | Disposition |
|---|---|
| Q049 (`extensions-rich-views.test.mjs:10`: kind `invoke` and a `command` field refused; 32 KB cap) | Retained for the handshake. `invoke`/`command` stay refused for every message: a panel never obtains a native command (fault isolation, interface stability). The handshake keeps its fixed 32 KB envelope (predictability). Changed: after the handshake a served panel exchanges `post`, `state`, `call`, `message`, `reply`, `visibility` and `theme` of up to 256 KiB (new positive test in the same file). |
| Q050 (`:15`, `:21`: init is the presentation DTO and a finite theme; `dto.credentials` refused; one handshake) | Retained: the DTO stays the presentation DTO. `dto.credentials` stays refused because of ADR-0006: a held credential never reaches a webview or a panel. The theme stays finite, and the host accepts one handshake per document. Changed: the init carries the instance and state beside the DTO, and messages flow after it. |
| Q119 (`extensions-rich-views.spec.ts:23`, `:91`: presentation data only; zero extensions and safe mode) | Retained for the legacy inline view (presentation DTO and theme only, reason as above) and for zero extensions and safe mode (safe mode runs nothing of any package). Changed for served panels: instance, state, service messages and the proxied SDK (`extensions-runtime-rich-channel.spec.ts`). |

Retained denials that are not security limits: a missing or revoked grant, untrusted content, a stale version and a
foreign owner (the grant and the trust belong to the installed version of one package); a closed instance
(`StaleContext`); forged request fields (`InvalidShape`); the bounds above.

## Evidence columns

- Preview: `tests/extensions-runtime-rich-channel.spec.ts`. It runs the twin with the R0208 runner, the fixture
  service and B1's fake daemon in Node, the real client in a VM, and the real shell and client framed from a package
  origin answered by `respondPanel` in the browser. It is registered in both Playwright configurations (WebKit grep
  `extensions rich channel:`) and has two CI steps (ports 16301/16302).
- Native fixtures: `runtime_service_lifetime::runtime_rich_channel::tests` (identity, shared and targeted delivery,
  visibility, state across reload and failure, bounds, close mid-response, service-only calls, request shapes, theme,
  dormant bound), fixture `tests/fixtures/extensions/runtime-rich-channel/`.
- Installed qualification: pending. That WebView2 passes POST bodies to the custom scheme handler, and that
  `ExecuteScript` reaches the shell under its own policy, is a design assumption until the installed `rich-panel`
  scenario records it.

## Limits

- No installed run of a service with two panels yet: the native test covers the channel's rules, not a Node process.
- In the preview, a panel's proxied calls need the preview service to be running (they run on its `panda`).
- `pandaView.releaseFocus`, keyboard forwarding and kept-alive hidden panels are R0304.
- The legacy inline form does not follow theme changes in the installed app (it has no instance).
- `sdk/panda-view.js` for remote pages is the same file as `/~panda/client.js`. Shipping it inside the SDK package is
  part of the SDK's packaging, not of this slice.
