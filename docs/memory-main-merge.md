# Memory branch merge of 0.3.124

The memory snapshot is commit `ed89b18`. It was merged with `fd5942ec` (`origin/main`, 0.3.124) on `pandacode/memory-weight`. Nothing was pushed or released. The untracked `scripts/bench/` directory was excluded and left untouched.

## Conflicts and resolutions

Only `src/main.ts` and `src/thread-tiles.ts` conflicted.

- Tile host wiring: kept upstream's `more` hook and `openFromTile` scroll restoration, plus the memory branch's `drop` hook. Removed tiles release their message pages and request entries; late loads cannot repopulate removed tiles.
- Sent images: retained the byte-budgeted `ImageCache`, escaped selectors and reload-on-open behavior. Preserved upstream's markup epoch invalidation when a new image arrives, without invalidating on ordinary cache hits.
- Tool header images: chose upstream's shared, downscaled `tool_image` cache and bounded retries. The memory branch's private `workspace_image` thumbnail path is superseded by this upstream implementation. Sent attachments retain their own 32 MiB cache budget rather than sharing it with header thumbnails.
- Inspector refresh: kept upstream's stable Git-status object and inspector freshness tracking; removed only the obsolete eager-diff language-prefetch notification.
- Boot tail: kept upstream's crash/restart recovery, draft restoration, window-stability tracking and toast wiring. Provider discovery still runs separately from first rendering. Removed the eager diff-engine startup call.
- Tile interface: kept both `more` and `drop`, along with upstream's row windowing.

The rest merged automatically. Upstream provider additions, service speed tiers, restart/crash handling and thread-switch structure were retained. The memory changes remain: lazy diff engine with idle teardown; sky settle/cadence/scale/fade/context cleanup; bounded image/file/PR caches; PDF raster release; deferred Markdown builders without detached DOM ownership; idle clock and brand reductions; one warm CLI for 90 seconds, with no prewarm at two or more running agents; four concurrent deduplicated version probes; bounded CLI capture; dock event-kind peeking; bot scheduler emit-on-change; and SQL-side user previews.

## Thread-switch cache audit

- `threadPages` in `src/main.ts`: up to 24 cached threads and 4,000,000 content characters, with a 1,000,000-character target per page (the newest message remains usable). Kept upstream's immediate cached-page rendering and background refresh.
- `leftRowsCache` in `src/transcript-view.ts`: upstream retained two detached transcripts by count. Added aggregate limits of 2,000,000 saved-markup characters and 128 rows plus trimmed reader states. Ordinary windows still reattach their DOM; oversized/widened histories reopen through the existing message-page path. A regression test covers reuse and eviction.
- Saved turn markup, handoff lookup, Find text and tile row windows use weak keys (`src/transcript-rows.ts`, `src/transcript-host.ts`, `src/transcript-view.ts`), rather than retaining every visited thread as strong map keys. Temporary preparation maps remove entries when work settles.
- Tile message pages and pending requests are tied to mounted tiles (at most six) and cleared on removal. Late results are ignored.
- Upstream tool images use separate thumbnail/card/full caches capped at 200/48/8 entries and 16/32/64 MiB of data-URL length, with bounded retry bookkeeping. Visible content and a newest oversized image can exceed these cache targets as upstream intended.

## Verification

- `npx tsc --noEmit`: passed after conflict resolution and the detached-row bounds.
- `npm test`: 1,236 passed, zero failed. The first run had two integration assertion failures: the launch-restore source assertion still expected provider discovery in the initial await, and the saved-markup fingerprint needed updating after the reviewed image-cache integration. Both were corrected and the full suite rerun successfully. There are no outstanding Node failures requiring an origin/main comparison.
- `npm ci`: skipped; the root lockfile changed only its release version, with dependency entries unchanged.
- `CARGO_TARGET_DIR=$PWD/src-tauri/target cargo check --manifest-path src-tauri/Cargo.toml --tests`: passed (9m39s).
- `CARGO_TARGET_DIR=$PWD/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib -- providers:: agents_dock:: bots:: storage:: --test-threads=1`: passed; 744 passed, zero failed, 42 ignored, 2,899 filtered out. Build took 5m14s; the selected tests took 43.60s. Ignored live CLI/service fixtures were not run.
- `git diff origin/main --check`: passed for the memory/integration delta. The full staged merge reports existing upstream whitespace in `mobile/src/app/search.tsx`, `src/jj.ts`, `src/tool-trace-pandacode.ts`, `tests/launch-restore.test.mjs` and `tests/tool-trace-gallery.spec.ts`. `git diff ed89b18^ origin/main --check` reproduces the same notices; upstream formatting was left unchanged.
- Browser suites were not run.

## Exact memory/integration files relative to upstream

This list excludes files imported unchanged from upstream. It includes the 30-file memory snapshot and the additional integration, cache-audit and test-contract changes, plus this report.

- `docs/agent-reference.md`
- `docs/memory-main-merge.md`
- `src-tauri/src/agents_dock.rs`
- `src-tauri/src/bots/schedule.rs`
- `src-tauri/src/bots/tests.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/providers.rs`
- `src-tauri/src/providers/claude_stream_tests.rs`
- `src-tauri/src/providers/warm.rs`
- `src-tauri/src/storage.rs`
- `src/agents-dock.ts`
- `src/brand-mark.ts`
- `src/diff-prefetch.ts`
- `src/diff-viewer.ts`
- `src/file-tabs.ts`
- `src/github-pull.ts`
- `src/image-cache.ts`
- `src/main.ts`
- `src/office-viewer.ts`
- `src/progress-pip.css`
- `src/sky-window.ts`
- `src/streaming-markdown.ts`
- `src/thread-tiles.ts`
- `src/transcript-view.ts`
- `tests/changes-view.spec.ts`
- `tests/desktop-pandas.spec.ts`
- `tests/image-cache.test.mjs`
- `tests/launch-restore.test.mjs`
- `tests/memory-caches.test.mjs`
- `tests/office-viewer.spec.ts`
- `tests/scenes.spec.ts`
- `tests/sky.spec.ts`
- `tests/thread-tiles.spec.ts`
- `tests/transcript-markup.test.mjs`
- `tests/ui.spec.ts`

## Tooling

File-tracking begin calls were attempted before edit batches. Most returned “A baseline could not be captured for every path”; the successful merge capture was completed. All source and documentation edits were confined to the assigned memory worktree. No other checkout or installed app was edited.
