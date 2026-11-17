# Example: the Machine monitor (a background service, scoped rules, a rich panel and attributed notices)

Task R1206. One installable package, `sample.monitor` (`examples/extensions/monitor/`), the reference example of the monitoring
pattern: a trusted background service that reads a metrics daemon, keeps a 30-minute history per machine, works out a level
for each, and shows it as a status item, a host-rendered table and a rich panel, with attributed notices by rule. It follows
the [Work board](live-board.md) example (same transport and logic split) and reuses its contracts; it adds visibility-driven
polling, notice replacement and throttling, and charts.

## What the package does

| Part | What it shows |
|---|---|
| Status item `sample.monitor/status` | `2 machines ok` (tone `success`); `<name> strained` (`warning`) or `<name> critical` (`danger`) for the worst online machine; `· N offline` appended when machines stopped answering; `No machines online · N offline`. Clicking it runs `sample.monitor/show`, which opens the panel. The tooltip lists up to eight machines with their level and readings. |
| View `sample.monitor/fleet` | A table (Machine, Level, CPU, Memory, Seen), at most 100 rows, as the host-rendered fallback of the rich panel. |
| Rich panel | One card per machine (name, level, CPU and memory, a canvas sparkline), and a detail pane with CPU and memory line charts of the last 30 minutes with the average and the peak. Selection lives in `pandaView.state`. A **Reload data** button asks the service for a fresh snapshot. |
| Polling | The service asks the daemon for samples every `fast` seconds (5) while any panel instance is visible and every `slow` seconds (60) otherwise. It learns visibility from the host (`panda.views.on('visible' / 'hidden' / 'opened' / 'closed')`), never from heartbeats. |
| Levels | `critical` at or over the CPU or memory critical threshold, `strained` at or over the strained one, else `ok`; a machine that stopped answering is `offline`. Six thresholds are settings (CPU and memory strained and critical, the memory that makes a silent machine worth a notice, the hourly cap); out-of-range values fall back to the defaults. A saved change takes effect at once, without a restart. |
| Notices | Critical: at once. Strained: after two consecutive strained readings. A reminder while critical at the configured interval (10 minutes). Never more than the hourly cap per machine (4). A machine that stops answering with memory at or over the elevated threshold raises one notice. One key per machine and kind, so a repeat **replaces** its row; the notice is withdrawn when the machine is ok again. The host names the package on every row and merges sends past six a minute ([notifications](../runtime-notifications.md)). The `alerts` switch mutes the notices; the status item keeps following. **Send a test alert** raises one notice whatever the switch says. |
| Offline | A machine taken offline keeps its last readings with "last seen <time>". When the daemon itself is unreachable the last readings stay, the status item reads `Daemon offline` (`warning`, tooltip "Last readings kept…"), the table and the panel say `stale since <time>`, and one notice is raised and withdrawn when the daemon answers. Before any reading exists the view says nothing is known, never an empty fleet. On recovery the service re-reads the machines and the history and sends the panel a snapshot. |

## How it is built

- `package/lib/monitor.mjs`: all of the logic, as one browser-safe ES module (no imports, no Node). It talks to the daemon
  through a small `link` (`request`, `subscribe`, `pace`, optional `onDown`, `onUp`, `reconnect`, `retarget`).
- `package/main.cjs`: the installed transport, a newline-delimited JSON client over TCP with a 1.5 s request timeout and backoff
  (250, 500, 1000 ms). `pace` re-subscribes the `metrics` topic with a new `intervalMs`, and the interval is kept for every
  reconnection. `PANDA_FIXTURE_B1` is the address a test hands in.
- `package/panel/`: `index.html`, `app.js`, `chart.js` (pure plotting and statistics over `[t, cpu, mem]` points) and
  `style.css`, loaded by relative address ([panel assets](../runtime-rich-assets.md)).
- The panel is a picture of the service's readings and never reads the daemon. Messages: `fleet.begin` (machines, thresholds,
  stale marking), one `fleet.history` per machine, then at most one `fleet.samples` a second. A hidden panel gets nothing;
  showing it again sends a snapshot ([channel](../runtime-rich-channel.md), [visibility](../runtime-rich-focus.md)). Each
  message stays far under the 256 KiB bound (a history is at most 400 points).
- Permissions: `ui.contribute`, `runtime.service`, `events.workspace`, `ui.dynamic`, `ui.notify`, `ui.richViews`. No timer or
  listener remains after a stop: the service clears its push timer and disposes its handlers, the transport clears its
  reconnect timer and closes the socket, and the host removes the instances and notices ([service lifetime](../runtime-service-lifetime.md)).

## Evidence

All of it is **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation. The three
columns are kept apart in `tests/fixtures/extensions/example-monitor/evidence-columns.json`.

- Preview, both engines: `tests/extensions-example-monitor.spec.ts` (grep `monitor preview:`; Chromium port 16651, WebKit
  16652). The shipped `lib/monitor.mjs` runs in the preview runner against B1's browser-importable core with scripted samples
  (`tests/fixtures/extensions/example-monitor/scripts.json`) and the R0303 panel host: the climb to strained and critical and
  back, the notice rules, replacement, reminder and cap, the host's merge past six sends a minute, mute and test alert,
  threshold changes, a machine going offline, the daemon going away and returning, the polling interval following visibility,
  the one-push-a-second rate, nothing sent to a hidden panel, and every stop reason leaving no instance, notice, listener or
  request. The chart module is checked against the samples it is given (average and peak), and the panel's own files run in a
  page with a stand-in `pandaView`, with one screenshot per engine.
- Native: scenarios for the real B1 over TCP (the interval change in the request log, the native notice recorder next to the
  visible list, a refused daemon, cleanup), prepared in the evidence-columns file; the fixture `main.cjs` wraps the shipped
  files for a crash test.
- Installed Windows: the R0306 runner, reused (panel state kept across hide and reload, the operating-system notification,
  a running task not disturbed). Pending until it is run.

## Limits of this cut

- The history lives in the service's memory (a restart starts again, as in the model); private storage is a later cut.
- The model's per-core load, busiest workspaces and process list need data the host does not expose to a package (no contract
  gives it), and the daemon's metrics are CPU and memory per machine, so the detail view shows those two charts.
- `panda.ui.notify` takes `key`, `text`, `title` and `tone` only: there is no `os` flag and no action argument. Whether a
  notice also reaches the operating system is the host's channel, reported as `os` in the answer (`unavailable` in this
  build). Muting is the package's `alerts` switch; a host-level mute of a package is the user's own control.
- Nothing is read from the machine the monitor runs on: operating-system metrics would be the service's own business as trusted
  code, and the example uses the daemon so that tests are deterministic.
