// The inbox cache file (src/store/inbox-cache.ts): read once at launch, written SAVE_MS after the
// last change, deleted on sign-out and account deletion. Off the render path; a cache, so errors are dropped.
import { File, Paths } from 'expo-file-system';

const SAVE_MS = 1000;
const file = () => new File(Paths.cache, 'inbox.json');
let timer: ReturnType<typeof setTimeout> | null = null;

export async function readInbox(): Promise<string | null> {
  try {
    const f = file();
    return f.exists ? await f.text() : null;
  } catch { return null; }
}

/** `get` runs when the timer fires; null skips the write (signed out, demo). */
export function saveInboxSoon(get: () => string | null) {
  if (timer) clearTimeout(timer);
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

export function clearInbox() {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch { /* nothing to delete */ }
}
