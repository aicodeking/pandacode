// Thread transcripts on disk (expo-file-system): one file per device+session under
// cache/threads/ plus index.json (LRU order, sizes, newest ids). Writes are debounced and run off
// the render path; demo mode never touches the disk. Pure logic: thread-cache.ts.
import { Directory, File, Paths } from 'expo-file-system';
import type { Message } from '../connect/types.ts';
import { decodeThread, encodeThread, evict, parseIndex, touch, type CacheIndex, type CachedThread } from './thread-cache.ts';
import { useConnect } from './index.ts';

const SAVE_MS = 1500;

const dir = () => new Directory(Paths.cache, 'threads');
const indexFile = () => new File(dir(), 'index.json');
const demo = () => useConnect.getState().demo;

let index: CacheIndex = {};
let loaded: Promise<void> | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function loadIndex(): Promise<void> {
  loaded ??= (async () => {
    try {
      const f = indexFile();
      if (f.exists) index = { ...parseIndex(await f.text()), ...index };
    } catch { /* unreadable: start empty */ }
  })();
  return loaded;
}

function writeIndex() {
  try {
    if (!dir().exists) dir().create({ intermediates: true });
    const f = indexFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(index));
  } catch { /* a cache: rebuilt by the next save */ }
}

/** The newest id cached for a thread (prefetch skips threads already current). */
export const cachedLastId = (key: string): number | undefined => index[key]?.lastId;

/** The cached thread, or null; marks it recently used. */
export async function readThread(key: string): Promise<CachedThread | null> {
  if (demo()) return null;
  await loadIndex();
  const entry = index[key];
  if (!entry) return null;
  try {
    const f = new File(dir(), entry.file);
    const thread = f.exists ? decodeThread(await f.text()) : null;
    if (!thread) throw new Error('unreadable');
    index = touch(index, key, { at: Date.now() });
    return thread;
  } catch {
    const { [key]: _, ...rest } = index;
    index = rest;
    return null;
  }
}

/** Saves the thread SAVE_MS after its last change; `get` reads the messages at that moment. */
export function saveThread(key: string, get: () => { messages?: Message[]; hasOlder: boolean }) {
  if (demo()) return;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void write(key, get());
  }, SAVE_MS));
}

async function write(key: string, { messages, hasOlder }: { messages?: Message[]; hasOlder: boolean }) {
  if (demo() || !messages?.length) return;
  await loadIndex();
  try {
    if (!dir().exists) dir().create({ intermediates: true });
    const text = encodeThread(messages, hasOlder);
    index = touch(index, key, { at: Date.now(), bytes: text.length, lastId: messages[messages.length - 1].id });
    const f = new File(dir(), index[key].file);
    if (!f.exists) f.create();
    f.write(text);
    const { index: kept, drop } = evict(index);
    index = kept;
    for (const name of drop) {
      const old = new File(dir(), name);
      if (old.exists) old.delete();
    }
    writeIndex();
  } catch { /* a cache: the next copy writes it again */ }
}

/** Sign-out and account deletion: no transcript stays on the phone. */
export function clearThreads() {
  timers.forEach(clearTimeout);
  timers.clear();
  index = {};
  loaded = null;
  try {
    if (dir().exists) dir().delete();
  } catch { /* nothing to delete */ }
}
