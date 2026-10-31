// What each app's own native/server side hands its UI for the same provider deltas.
// Input: delta arrival times (ms) and sizes (bytes). Output: [{ at, end }] — deliver
// text [previous end, end) (PandaCode) or the whole text [0, end) (T3 Code) at time `at`.

/**
 * PandaCode: src-tauri/src/providers.rs `Coalescer` + src-tauri/src/lib.rs `emit_coalesced`.
 * The first plain delta opens a buffer and arms a 33 ms timer; later deltas append; a push
 * flushes once the buffer holds >= 8 KiB or is >= 33 ms old; the timer flushes the buffer it
 * armed. Run end flushes whatever is left (`flush_coalesced`).
 */
export function pandacodeSchedule(times, sizes, windowMs = 33, maxBytes = 8 * 1024) {
  const out = [];
  let end = 0, open = null; // open = { since, bytes }
  const flush = at => { if (open) { out.push({ at, end }); open = null; } };
  times.forEach((t, i) => {
    if (open && open.since + windowMs <= t) flush(open.since + windowMs); // timer fired first
    end += sizes[i];
    if (open) open.bytes += sizes[i]; else open = { since: t, bytes: sizes[i] };
    if (open.bytes >= maxBytes || t - open.since >= windowMs) flush(t);
  });
  flush(times.at(-1));
  return out;
}

/**
 * T3 Code (github.com/pingdotgg/t3code @ fe219c4), two stages, both whole-entity:
 * 1. apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts with
 *    CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50 (CodexAdapterV2.ts:209): the first append
 *    schedules a flush 50 ms later that emits the item's whole text so far.
 * 2. apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts (used by ws.ts thread
 *    subscription): the first pending `turn-item.updated` (running, streaming) opens a 50 ms
 *    window; at its end only the latest update for that item is sent.
 * At turn end the adapter's `complete()` emits the final text, which is not coalescible, so
 * the pending update and the final text go out at once (the bench sends both still streaming).
 */
export function t3Schedule(times, sizes, providerMs = 50, windowMs = 50) {
  const out = [];
  let end = 0, providerAt = null, windowAt = null, pending = null;
  const advance = t => { // run timers due at or before t, in time order
    for (;;) {
      const next = Math.min(providerAt ?? Infinity, windowAt ?? Infinity);
      if (next > t) return;
      if (providerAt === next) { providerAt = null; if (pending === null) windowAt = next + windowMs; pending = end; }
      else { out.push({ at: next, end: pending }); pending = null; windowAt = null; }
    }
  };
  // `end` only grows inside the loop, so the provider flush reads the text as of its own time.
  times.forEach((t, i) => {
    advance(t);
    end += sizes[i];
    if (providerAt === null) providerAt = t + providerMs;
  });
  const last = times.at(-1);
  advance(last);
  if (pending !== null) out.push({ at: last, end: pending });
  out.push({ at: last, end });
  return out;
}
