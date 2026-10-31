# PandaCode vs T3 Code: streaming chat render benchmark

This benchmark measures what each app's chat UI costs while one long agent reply streams in. Both apps get the same reply, at the same provider speed, in the same Chrome. Each app receives the reply the way its own native or server side delivers it to the UI.

Results: [results/summary.md](results/summary.md). Raw per-run numbers: `results/<date>.json`.

## What is measured

Each run uses a new Chrome process and a new page. The run opens a thread that already has history, waits until it is ready, then replays the workload and records:

| Metric | How |
| --- | --- |
| Main-thread task time | CDP `Performance.getMetrics`, change in `TaskDuration` from just before the first delivery to 1 s after the final paint. `ScriptDuration`, `LayoutDuration` and `RecalcStyleDuration` are reported as parts of it, and the remainder (HTML parsing, paint, GC and so on) as "other". |
| Wall time | `performance.now()` from the first scheduled delivery until the frame after the final text is painted. The workload sets most of this (32 s), so it mainly shows whether an app fell behind. |
| Last delivery to final paint | Time from the last delivery until the frame after the one whose DOM first holds the reply's last line (`End of reply W1.`). The check runs once per `requestAnimationFrame`, so the paint has happened by the time the next callback runs. |
| Worst delivery lateness | How late the in-page scheduler sent its most delayed event. A busy main thread delays the timers. |
| JS heap before / after | `HeapProfiler.collectGarbage`, then `Runtime.getHeapUsage().usedSize`, before the first delivery and 1 s after the final paint. |
| Rendered structure | After the final paint, the bench counts `pre`, `table`, `li`, `h2`, `blockquote` and `a` elements in the reply. Both apps produced the same counts in every run (21, 21, 155, 21, 21, 107), so both rendered the same Markdown. |
| DOM mutation records | A `MutationObserver` on `document.body` (childList, characterData, attributes, subtree) counts records over the same span. |
| Idle baseline | The same page in the same state for the same 32 s with nothing delivered. This separates fixed background work (timers, animations) from the cost of streaming. |

## Workload

**W1** (`workload.mjs`): one 50,000-byte ASCII Markdown reply made by a seeded generator (mulberry32, seed `0x7a3c1e`). It holds headings, paragraphs with bold text, inline code and links, bullet and numbered lists, `ts` code fences, tables and block quotes. It is cut into 2,000 deltas of 25 B, and one delta arrives every 16 ms (32 s in total). `node check.mjs` checks the size, that every fence is closed, and the delivery schedules, and prints the text's SHA-256 prefix (`f2c1e6664b09d24f`).

The provider deltas are identical for both apps. What reaches each UI is what that app's own pipeline makes of them (`schedule.mjs`, checked by `check.mjs`):

- **PandaCode** (`src-tauri/src/providers.rs` `Coalescer`, `src-tauri/src/lib.rs` `emit_coalesced`). The first delta opens a buffer and starts a 33 ms timer. Later deltas are appended to the buffer. The buffer is flushed when it holds 8 KiB or is 33 ms old, and the timer flushes the buffer it started. Run end flushes what is left. For W1 this gives 667 `agent-event` text events, each carrying only the new text (about 75 B every 48 ms). They are injected with the preview build's `window.__previewEmit('agent-event', …)`, which calls the same `listen` callbacks that Tauri events reach in the app.
- **T3 Code** has two stages, and both send whole entities. First, `apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts` runs with `CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50` (`CodexAdapterV2.ts:209`): the first delta schedules a flush 50 ms later, and the flush emits the item's whole text so far. Second, `apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts` (the `COALESCE_WINDOW` of 50 ms, applied by `coalesceThreadLiveStream` in `apps/server/src/ws.ts`): the first streaming `turn-item.updated` opens a 50 ms window, and only the newest update per item is sent when it closes. At turn end, `complete()` emits the final text. That event cannot be coalesced, so the pending update and the final text go out together. For W1 this gives 500 `turn-item.updated` events, each with the whole text so far (about one every 64 ms). They are offered to the app's live thread subscription.

**W2 was dropped.** W2 was planned as 600 updates across 30 tool calls with about 20 KB of output each. The two apps do not render tool output the same way, so the comparison would not be fair. T3 Code shows a `command_execution` item as a work-log row with its command. The output appears only in an item inspector that fetches it on demand (`apps/web/src/components/chat/V2ItemInspector.tsx`). PandaCode renders tool output inline in result cards in the live trace.

## How each app runs

Both apps run as production builds served by `vite preview`, and the two servers run at the same time.

**PandaCode**: `vite build --outDir bench/t3-compare/.dist-pandacode` builds the normal web bundle (production mode, minified). Without Tauri, `src/bridge.ts` routes IPC to `src/preview.ts`, so the app runs on its sample data. The run opens the sample task `session-1`, and the reply streams through the real path: `agent-event` listener, `onAgent`, the streaming renderer and the Enriched Markdown engine (md4c WebAssembly).

**T3 Code**: `setup-t3.sh` copies `t3/` into `$T3CODE_DIR/apps/web/zbench/` and runs `NODE_ENV=production vp build --mode production --config zbench/vite.bench.config.ts`. That config is T3 Code's own `apps/web/vite.config.ts` (React with the React Compiler, Tailwind, the router plugin) plus three changes:

1. `zbench/bench.html` is the entry. `bench-main.tsx` mounts `AppRoot` with `getRouter(createMemoryHistory(...))` inside `StrictMode`, like `src/main.tsx` does.
2. The connection driver (`packages/client-runtime/src/connection/driver.ts`) is replaced by `apps/web/test/fakeEnvironment.ts`. This is the in-process session that T3 Code's own app render scenarios use (`test/appScenarios.renders.tsx` swaps it with `vi.mock`). It answers the shell, thread and server-config subscriptions from fixtures. Everything above the session is the app's own code: the RPC client, stores, router, timeline (LegendList) and Markdown.
3. `trackRpcRequestSent` is made a no-op, as in those scenarios. Without that change, the fake session's unanswered RPCs would raise a "slow request" notice partway through a run.

The thread has 20 earlier turns. Before the first delta, the bench sends `run.created` and the user prompt, as the server does.

**Proof of production React.** The T3 bundle contains React's production error text (`Minified React error`, in `assets/dist-*.js` and `assets/utils-*.js`) and none of the development-build strings (`react-dom-client.development`, the `wrong act()` warning). At run time, every run checks a mounted fiber for `_debugOwner`, a field that only development builds set. It is absent in every run (`reactDevBuild: false` in the raw JSON).

## Environment of the published run

| | |
| --- | --- |
| Machine | Mac16,5 (`sysctl hw.model`), Apple M4 Max, 48 GB RAM |
| OS | macOS 27.0.1 |
| Browser | Google Chrome 155.0.8059.85 (installed system Chrome through Playwright `channel: 'chrome'`), headless, 1440×940 viewport, device scale factor 2 |
| PandaCode | commit `040eb62849128414617746d78cffd5eba77ce593`, no uncommitted changes under `src/` |
| T3 Code | https://github.com/pingdotgg/t3code, commit `fe219c4de18f5ee37c28cbd3914a5569b1579156` (2026-10-29) |
| Runs | 9 cold runs per app for W1 and 9 for the idle baseline. The order alternates each round (PandaCode first, then T3 Code first). An earlier set of 5 runs had one PandaCode outlier (5,069 ms against about 3.4 s for the rest; spread 56%), so the set was rerun with 9. In the earlier set the medians were PandaCode 3,477 ms and T3 Code 8,479 ms of task time (ratio 0.41); the published set is 2,947 ms and 8,332 ms (ratio 0.35). PandaCode's numbers move more between sets than T3 Code's. |

The raw JSON records the machine, Chrome version, both commits and the per-run numbers.

## Reproduce

```sh
# 1. T3 Code at the measured commit
git clone https://github.com/pingdotgg/t3code "$T3CODE_DIR"
git -C "$T3CODE_DIR" checkout fe219c4de18f5ee37c28cbd3914a5569b1579156
(cd "$T3CODE_DIR" && pnpm install)

# 2. From the PandaCode repo root
npm ci
node bench/t3-compare/check.mjs                         # workload + schedule self-check
./node_modules/.bin/vite build --outDir bench/t3-compare/.dist-pandacode --emptyOutDir
T3CODE_DIR="$T3CODE_DIR" sh bench/t3-compare/setup-t3.sh   # T3 production build -> apps/web/dist-bench

# 3. Measure (starts both preview servers on 127.0.0.1:4173 / 4174; override with PC_PORT / T3_PORT)
T3CODE_DIR="$T3CODE_DIR" RUNS=5 node bench/t3-compare/run.mjs
```

`run.mjs` writes `results/<date>.json` and `results/summary.md`. It needs Google Chrome installed.

## Known limitations

- **Transport decoding is skipped for both apps.** PandaCode's events do not pass through Tauri IPC serialization, and T3 Code's do not pass through WebSocket framing, JSON parsing or Effect Schema decoding. T3 Code sends the whole text in each update, so it would pay more here than PandaCode, which sends only new text. The numbers therefore understate T3 Code's real cost.
- **Turn completion is excluded for both apps.** The bench ends with the full text still in the streaming state. T3 Code's final completed item is sent with `streaming: true`, and PandaCode's `done` event is not sent. PandaCode's preview cannot replay the saved-message reload that `done` triggers, so excluding the step for both keeps them comparable.
- **Only one T3 adapter path is modeled.** The T3 schedule follows the Codex adapter path, which is also the provider in the fake environment. The Claude adapter's assistant text path was not modeled. Every path still passes through the 50 ms live-event window, so the client never receives updates more often than once per window.
- **The apps run different UIs and different history.** The PandaCode preview's sample task has its own short history, and the T3 thread has 20 synthetic turns. Each app renders its whole UI (sidebar, header, composer), so the numbers compare the apps as built, not the Markdown renderers alone.
- **The browser is not the desktop shell.** Both apps run in headless desktop Chrome, not in their shells (WKWebView for PandaCode, Electron for T3 Code). PandaCode's real target is WebKit, and its numbers there may differ.
- **The idle baseline differs between the apps.** For T3 Code it starts after `run.created`, so the thread shows a running turn. PandaCode has no running turn until text arrives.
- **CDP metrics cover only the page's main thread.** `TaskDuration` does not include the GPU or raster threads. Heap figures count only the page's JS heap, not DOM or native memory.
- **The provider speed is fixed.** Deltas arrive every 16 ms (about 1.5 KB/s). This is faster than most models stream, which makes it a stress case.
- **Idle app memory is not compared.** A fair comparison would need both desktop apps launched fresh and measured the same number of seconds after launch with no agents running. PandaCode was running during this measurement, and the bench must not quit or restart it. A second instance would not be a fresh launch under the same conditions. T3 Code (Nightly) is installed on the machine, but measuring only one app would not be a comparison.
