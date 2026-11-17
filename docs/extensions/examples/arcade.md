# Example: the Arcade (a panel-only package with bundled assets)

Task R1205. One installable package, `sample.arcade` (`examples/extensions/arcade/`), the reference for
[panels without a service](../runtime-panel-only.md): a playable snake on a canvas, with bundled assets, saved state, sound
and keyboard handling, using only public panel APIs. It declares no `runtime`, so no service starts and nothing appears in
the Running list.

## What the package does

| Behaviour | How |
|---|---|
| One game on a canvas | `panel/main.js` draws a 20 by 20 board; `window.__arcade.frames` rises with every animation frame (tests read it). |
| Assets from the folder | One page, one stylesheet, three modules (`main.js`, `game.js`, `audio.js`), one worker (`level-worker.js`), one sprite (`sprite.svg`) and two sounds (`point.wav`, `over.wav`), all relative addresses on the package's own origin ([assets](../runtime-rich-assets.md)). Nothing loads from the network. |
| Keyboard | Arrow keys steer while the panel has focus, with `preventDefault`, so the application does not scroll or move its selection; text fields and input-method composition are ignored; **Space** pauses and resumes; **Escape** calls `pandaView.releaseFocus()` ([focus](../runtime-rich-focus.md)). With focus in the composer the keys never reach the game. |
| Saved state | The round in progress, the best score and the sound preference are written synchronously to the page's own storage (a journal) and to `pandaView.state`; on start the newer one wins. The round survives a view switch, a panel reload and a failure; the best score and the preference survive a restart (the page's storage belongs to the package). |
| Pausing | The game pauses on `onDidChangeVisibility` (hidden or unfocused), `visibilitychange` and window blur, and resumes on Space. |
| Sound | A toggle; the clips are created only after the first key or click. |
| Theme | `data-theme` follows the host's theme message; the host's `--` tokens are applied on top. Buttons transition opacity and background only, and not at all with reduced motion. |
| No service | `pandaView.postMessage` and `pandaView.panda.storage.directory` answer `UnsupportedCapability`; the page does not use them. |
| Failures | A page that throws is shown failed with **Reload panel**; a page that loops is ended by the host's watchdog. Tasks, terminals and the draft are never touched. |

`storage.private` is declared because the plan lists it as the package's one capability; in a panel only the page's own
storage and `pandaView.state` are available, the data directory being service-only ([panel only](../runtime-panel-only.md)).

## How it is built

`panel/game.js` holds the rules as pure functions over plain data (steer, step, revive a saved round, build a level), so a round
can be saved as JSON and replayed. The level is built by the worker, which imports `game.js` by a relative address; if the worker
does not answer in two seconds the page builds the same level itself. `window.__arcadeDo` (`press`, `round`, `resources`, `probe`,
`fail`, `hang`) is what tests drive; the product does not need it.

## Evidence

Preview, installed Windows and both engines are kept apart (`tests/fixtures/extensions/example-arcade/evidence-columns.json`).
All of them are **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation.

- Preview: `tests/extensions-example-arcade.spec.ts` (tests named `arcade preview:`), Chromium port 16641, WebKit 16642. The Node
  tests read the shipped package files, the game rules and the R0305 page host; the browser tests install the same folder in the
  app preview (`?rich-assets`) with the package origin answered by `respondPanel`.
- Installed Windows: the R0306 runner `tests/fixtures/extensions/runtime-windows-panels/qualify.mjs --build`, reused, not copied,
  with the scenarios listed in the evidence-columns file (assets, input, state, focus and visibility, a streaming task, zero
  service, failure containment, cleanup). Adding the package to the runner's `stage.mjs` and `expected.json` is a final-phase edit
  of R0306's files.

## Limits

- Plan behaviour 8 (a scripted task streaming while a round runs) is an installed-only scenario; the preview cannot show a real
  thread.
- In the preview the level is built by the worker only where the engine lets the route serve one (Chromium); otherwise the page builds it.
- The package is one game, not the 21-game library of the plan's model; it exercises every contract the model needs.
