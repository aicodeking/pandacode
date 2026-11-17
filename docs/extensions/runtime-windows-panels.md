# Rich panels on installed Windows (R0306)

The installed qualification of the R3 rich panels (R0301–R0305) and of the native panel inside the composer band
(R1001) on Windows x64. It is the evidence that `runtime_rich_mount::RICH_TARGETS` (Windows x64) stands on, and its
verdict is the `rich-panel` scenario of the windows-x64 record of
[runtime-platform-qualification.md](runtime-platform-qualification.md).

**State: prepared, not run.** The harness, fixtures, expected observations and registrations below exist; no installed
run has been made (deferred to the final test phase). Nothing here claims an observation. macOS and Linux stay
`UnsupportedRuntime`; nothing in this record is evidence for them.

## One command

On a **dedicated Windows x64 account or a Windows Sandbox** (never a developer profile: the installer writes per-user
registry entries and the app uses the profile's `ai.pandacode.desktop` data folders):

```powershell
$env:PANDACODE_QUALIFICATION_PROFILE = 'dedicated'
$env:PANDACODE_EXTENSION_NODE_LICENSE = '<the complete Node v26.1.0 LICENSE>'   # needed by --build only
node tests/fixtures/extensions/runtime-windows-panels/qualify.mjs --build
```

Run it from the repository with `npm ci` done and the pinned Node v26.1.0 (the release build stages that executable).
`--installer <PandaCode_<version>_x64-setup.exe>` reuses a build that `--build` made from the same tree; `--out <folder>`
changes the output folder (default `test-results/runtime-windows-panels/`); `--keep-install` leaves the installed app;
`--port <n>` fixes the debugging port (default: a free loopback port). The exit code is 0 only for `passed`.

Then, in the same final phase, the installed column of the spec reads the record:

```powershell
$env:PANDACODE_WINDOWS_PANELS_RECORD = 'test-results/runtime-windows-panels/observation.json'
npx playwright test tests/extensions-runtime-windows-panels.spec.ts -g "recorded installed observation"
```

## What the runner does

1. **Refuses** anything but Windows x64 with `PANDACODE_QUALIFICATION_PROFILE=dedicated`, PandaCode data folders it did
   not create (marker `.pandacode-windows-panels-qualification`) and a running `pandacode.exe` (the single-instance
   handoff would take the launch).
2. **Build identity.** The source fingerprint is SHA-256 over `HEAD` and the path and bytes of every changed or untracked
   file (read-only `git rev-parse` and `git status`). `--build` takes it before and after
   `node scripts/release/build.mjs windows-x86_64` (the release build: NSIS, per user, unsigned) and refuses a tree that
   changed meanwhile; it writes `<installer>.identity.json` (candidate commit, fingerprint, installer SHA-256). At run time
   `identity.buildMatchesSource` is true only when that file, the installer bytes and the current tree all agree.
3. **Installs** that installer silently into `<out>/run/install` (`/S /D=<folder>`), records the executable's SHA-256,
   and uninstalls at the end (`uninstall.exe /S`).
4. **Backends.** Starts B1 (`backends/fake-daemon`, port 0, `seed.json`: issues T-1..T-3, machine `m1`). The app itself
   launches B5 (`backends/fake-agent.mjs`) through the declared ACP harness of `sample.windows-panels-agent`, with
   `FAKE_AGENT_LOG` in the run folder. No real harness, account or network is used.
5. **Stages** five packages as stored ZIPs (`stage.mjs`, placeholders replaced with this run's JSON-escaped values):
   `sample.windows-panels` (service + folder panel + remote page view), `sample.windows-panels-twin` (panel only),
   `sample.windows-panels-agent` (fake agent), and, reused unchanged, R0301's inline `sample.rich-mount` and R1001's
   `sample.band-rich`.
6. **Launches** the installed executable with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` = wry's own defaults plus
   `--remote-debugging-port=<port>`, connects Playwright over CDP, and runs `scenarios.mjs`. Setup uses the main window's
   own commands (`extensions_install`, `extensions_runtime` trust, `extensions_enable`, `extensions_runtime_grant`,
   `add_project`) and reloads the window; everything after that is the app's UI and the panels' own pages.
7. **Writes** `observation.json` (`runtime-windows-panels-observation`, evidence `installed`), `result.json`
   (`evaluate.mjs` against `expected.json`) and `platform-rich-panel.json` (the `{ id: "rich-panel", outcome }` entry).

## Scenarios and expected observations

The exact values are in `tests/fixtures/extensions/runtime-windows-panels/expected.json`; each row names its ticket
criterion.

| Scenario | What happens | Expected (abridged) |
|---|---|---|
| `setup` | install, trust, enable, grant the five packages; add a project | no setup error |
| `stream` (C3) | the board opens in the inspector; its panel asks the service for 40 frames; the service forwards B1 `metrics.sample` of `m1` as `frame` posts; the panel draws column `seq % 64` in `rgb((seq*5)%256, (seq*11)%256, 200)` | technique `native-webview`; shell URL carries `#panda-min=320x240`; 40 drawn, 0 gaps, `stream-done` 40; pixel (39, 8) = `[195,173,200,255]`; service delivered ≥ 40, refused 0 |
| `action` (C3) | the panel's `claim` goes to the service, which claims B1's first ready issue | `T-1`, `in_progress`, answered to the asking instance, ≤ 2 s |
| `storage` (C3) | the board stores a note in `localStorage` and IndexedDB; the same view opens in the separate window | the window reads both values (one origin per package across placements) |
| `remote` (C3) | the chart view frames `https://charts.windows-panels.test/chart.html` | its text, its own origin, framed by the shell |
| `twin` (C3) | the twin (panel only) opens, which parks the board; the board is shown again | the twin sees no board note; its own note does not change the board's; distinct origins; its `postMessage` is refused (no service); the board keeps its document (`boot` id) and was told it was hidden |
| `inline` (C3) | R0301's inline panel stays open 15 s | still mounted (title heartbeats arrive; the watchdog ends a panel after 6 s of silence) |
| `focus` (C3) | trace below | |
| `restart` (C3) | the app's own restart (`process:allow-restart`) after 10 s | the board's note is still there |
| `fault` (C4) | the panel starts a task on the fake agent (12 one-second ticks); after `turn.started` the panel throws | panel ended `error`, its webview gone; the turn finishes, no `turn.failed`, no `task.stopped`, no `session/cancel`, one prompt; composer enabled; **Reload panel** restores the instance and its state `{note: "remembered"}` |
| `band` (C3) | R1001's rich band segment for the task in view | `native-webview`, its webview exists, 24 ≤ height ≤ 96, alive 10 s |
| `lifecycle` (C4) | revoke `ui.richViews`; grant again; disable the package; enable; open board, twin and the window; safe mode | revoke: `revoked`, no webview of the package, channel closed (no instance, nothing delivered or refused); disable: ended, no webview, service stopped; safe mode: no panel webview, no panel window, service stopped, composer enabled |

Focus trace (`project` on `step`, `main` = the main webview's `document.hasFocus()`, `panel` = the package page's):

| Step | Action | main | panel |
|---|---|---|---|
| `slot-enter` | focus the composer, then the panel slot (its single tab stop) | false | true |
| `panel-button` | the page focuses its own button | false | true |
| `escape` | Escape in the panel | true | false |
| `re-enter` | composer, then the slot | false | true |
| `release-focus` | `pandaView.releaseFocus()` | true | false |
| `chord-enter` | composer, slot, page button | false | true |
| `chord` | Ctrl+F12 in the panel (a chord the page leaves alone) | false | true |

The main window must receive exactly one forwarded key-down, `Control+F12` (Escape is not re-dispatched).

## What this qualifies from the earlier slices

| Pending installed item | Where it is observed |
|---|---|
| WebView2 passes `POST /~panda/channel` bodies to the `pandapanel` scheme (R0303) | every panel → service message: `stream`, `claim`, `start-task` |
| `ExecuteScript` reaches the shell (R0303) | every service → panel post: `frame`, `claimed`, `task`, `heartbeat` |
| per-package origins, folders, modules, IndexedDB, remote pages (R0302) | `storage`, `twin`, `remote` |
| parked webviews keep document and focus; the size fragment passes the navigation guard; focus moves between main and panel webviews; inline title signals are not lost (R0304) | `twin` (`boot` id), `stream` (`#panda-min`), `focus`, `inline` |
| a panel-only package and the keyboard of an ending panel (R0305) | `twin`, `lifecycle` |
| the native panel inside the composer band (R1001) | `band` |

## Instrumentation and remaining limits

- The debugging port is the only launch difference from a normal start; it is recorded in `instrumentation`.
- The remote page is answered by a request route on the debugging connection (no network), like the preview spec.
- Keys are injected through CDP into the panel's renderer, not the OS input queue; IME is not covered.
- If WebView2 hides the panel webviews from the debugging connection (`devtools(false)`), every panel observation is
  missing and the run fails: that is a harness limit to fix in the final phase, not a product verdict.
- Setup uses the main window's commands rather than the file dialog and the trust dialog (they need a person).
- Floating placement waits for the original editor window (R0901); the board package itself is R1202's.
- A passing record does not change `ENABLED_TARGETS` or `RICH_TARGETS`; enabling another target is a separate reviewed
  change with that target's own installed evidence.

## Refusals reconciled by this slice

R0306 owns Q025, Q038, Q051, Q052, Q116 and Q117. The permissioned path these refusals sat in front of is now the
trusted rich panel (`ui.richViews`, trust, a qualified target); what stays refused is not a security limit.

| Row | Disposition |
|---|---|
| Q025 (`rich_views.rs` `unqualified_targets_and_forged_window_options_fail_closed`) | Changed: the gate is per platform and Windows x64 is on (positive assertion added). Retained: macOS and Linux answer `UnsupportedRuntime` (predictability: no installed evidence there); forged `url`, `capabilities`, `width`, `projectId` fail as `InvalidShape` (interface stability: the host takes the address and size from the manifest; `rich.minSize` is the permissioned size); no command for an `extension-view-*` label (fault isolation and interface stability: panels talk over the channel). R1102 owns the platform-record part. |
| Q038 (`windows.rs` `actual_dispatch_policy_never_inherits_main_or_other_window_grants`) | Retained: the tray, launcher and agents-dock webviews are host windows with their own capability, never a package's; panel webviews (`extension-panel-*`, `extension-view-*`) get no command at all, their path is the `pandapanel` channel. Reasons: interface stability and fault isolation. A positive assertion for the panel labels was added. |
| Q051 (`extensions-windows.test.mjs` rich-view member text) | Changed: the ledger text and the window registry reason now say rich windows open for trusted packages holding `ui.richViews` on qualified targets (Windows x64) and answer `UnsupportedRuntime` elsewhere. R1102 owns the per-target record. |
| Q052 (`extensions-windows.test.mjs` protected window controls are inspect-only; protected locations refuse hide/reorder) | Retained: Quit, Show PandaCode, recovery and the pinned widget's lifetime are the user's way back when packages fail (fault isolation and recovery, not security). Comments added at the assertions. |
| Q116 (`extensions-window-coverage.spec.ts`, `extensions-windows.spec.ts`: protected items "Operations: inspect", `panda.tray.protected/quit` `PermissionDenied`) | Retained, same reason; the forged cross-window requests stay refused for predictability (a contribution belongs to the surface it was declared for). Comments added. |
| Q117 (`extensions-rich-views.spec.ts` unqualified targets show the host fallback) | Retained for unqualified targets (the preview models one): predictability, no evidence on that platform. The qualified path is this record and the inspector mount specs. Comment added. |
