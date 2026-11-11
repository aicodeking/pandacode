// Resume tokens: the event cursors (store/replay.ts) saved per host, so after a relaunch a
// subscribe sends where this phone left off (`afterSeq` with the host's epoch) and the host
// replays only what was missed, when it was not restarted meanwhile. Read once at launch, written
// SAVE_MS after the last change, deleted on sign-out. A cache: errors are dropped.
import { File, Paths } from 'expo-file-system';

const SAVE_MS = 5000;
const file = () => new File(Paths.cache, 'connect-cursors.json');
let timer: ReturnType<typeof setTimeout> | null = null;

export async function readCursors(): Promise<string | null> {
  try {
    const f = file();
    return f.exists ? await f.text() : null;
  } catch { return null; }
}

/** `get` runs when the timer fires; null skips the write (signed out, demo). */
export function saveCursorsSoon(get: () => string | null) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const text = get();
    if (text === null) return;
    try {
      const f = file();
      if (!f.exists) f.create();
      f.write(text);
    } catch { /* rewritten on the next change */ }
  }, SAVE_MS);
}

export function clearCursors() {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch { /* nothing to delete */ }
}
