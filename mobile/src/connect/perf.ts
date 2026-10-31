// Dev-only timings for opening a thread: tap (press-in) → first meaningful paint → fully current,
// and for launch: JS start → inbox paint, socket open, first presence, first tasks.list.
// Logged as `[thread-perf]` / `[startup]` lines and appended to `thread-perf.log` in the cache directory (the
// simulator's log doesn't carry console output); nothing runs in release builds.
import { File, Paths } from 'expo-file-system';

/** When this module loaded (the JS bundle started). */
const started = Date.now();
const startup = new Set<string>();

/** One launch milestone, logged once per launch (dev builds). */
export function markStartup(stage: 'ready' | 'paint' | 'socket' | 'presence' | 'list') {
  if (!__DEV__ || startup.has(stage)) return;
  startup.add(stage);
  log(`startup ${stage} ${Date.now() - started}ms`, 'startup');
}

const opens = new Map<string, { at: number; painted: boolean }>();

function log(line: string, tag = 'thread-perf') {
  console.log(`[${tag}] ${line}`);
  try {
    const f = new File(Paths.cache, 'thread-perf.log');
    if (!f.exists) f.create();
    f.write(`${f.textSync()}${new Date().toISOString()} ${line}\n`);
  } catch { /* dev aid only */ }
}

/** The user started opening this thread (press-in, else the screen mounting). */
export function markOpen(key: string) {
  if (!__DEV__) return;
  const open = opens.get(key);
  if (!open || Date.now() - open.at > 2000) opens.set(key, { at: Date.now(), painted: false });
}

/** The transcript drew real rows (cached or fetched). */
export function markPaint(key: string, rows: number) {
  const open = __DEV__ ? opens.get(key) : undefined;
  if (!open || open.painted) return;
  open.painted = true;
  log(`${key} paint ${Date.now() - open.at}ms rows=${rows}`);
}

/** The newest messages are copied: the thread is current. */
export function markCurrent(key: string, how: string) {
  const open = __DEV__ ? opens.get(key) : undefined;
  if (!open) return;
  opens.delete(key);
  log(`${key} current ${Date.now() - open.at}ms via=${how}`);
}
