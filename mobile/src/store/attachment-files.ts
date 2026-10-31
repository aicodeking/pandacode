// Attachment bytes on disk (expo-file-system): cache/attachments/<hash>.<ext> plus index.json (LRU
// order and sizes, capped at ATTACHMENT_BYTES). A download writes <hash>.part as chunks arrive, so
// a failed one resumes where it stopped; finishing renames it. Pure logic: attachments.ts.
import { Directory, File, Paths } from 'expo-file-system';
import { evict } from './thread-cache.ts';
import { ATTACHMENT_BYTES, blobName, parseBlobIndex, type BlobIndex } from './attachments.ts';

const dir = () => new Directory(Paths.cache, 'attachments');
const indexFile = () => new File(dir(), 'index.json');

let index: BlobIndex = {};
let loaded: Promise<void> | null = null;

/** Reads the index once per launch. */
export function loadBlobs(): Promise<void> {
  loaded ??= (async () => {
    try {
      const f = indexFile();
      if (f.exists) index = { ...parseBlobIndex(await f.text()), ...index };
    } catch { /* unreadable: start empty */ }
  })();
  return loaded;
}

function ensureDir() {
  if (!dir().exists) dir().create({ intermediates: true });
}

function writeIndex() {
  try {
    ensureDir();
    const f = indexFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(index));
  } catch { /* a cache: rebuilt by the next download */ }
}

/** The cached file's URI, marked recently used; undefined if it isn't (or no longer is) on disk. */
export function cachedBlob(key: string): string | undefined {
  const entry = index[key];
  if (!entry) return undefined;
  const f = new File(dir(), entry.file);
  if (f.exists) {
    index = { ...index, [key]: { ...entry, at: Date.now() } };
    return f.uri;
  }
  const { [key]: _, ...rest } = index;
  index = rest;
  return undefined;
}

/** The partial download for `key`: bytes already written (where to resume) and an append. */
export function partial(key: string) {
  ensureDir();
  const f = new File(dir(), blobName(key));
  return {
    get size() { return f.exists ? f.size ?? 0 : 0; },
    append(base64: string) {
      if (!f.exists) f.create();
      f.write(base64, { encoding: 'base64', append: true });
    },
    reset() { if (f.exists) f.delete(); },
  };
}

/** Moves a finished download into the cache and evicts the least recently used past the cap → its URI. */
export function finishBlob(key: string, mime: string, bytes: number): string {
  const part = new File(dir(), blobName(key));
  const name = blobName(key, mime);
  const target = new File(dir(), name);
  if (target.exists) target.delete();
  part.move(target);
  const { index: kept, drop } = evict({ ...index, [key]: { file: name, at: Date.now(), bytes } }, ATTACHMENT_BYTES);
  index = kept;
  for (const file of drop) {
    try {
      const old = new File(dir(), file);
      if (old.exists) old.delete();
    } catch { /* gone already */ }
  }
  writeIndex();
  return target.uri;
}

/** Sign-out and account deletion: no attachment stays on the phone. */
export function clearBlobs() {
  index = {};
  loaded = null;
  try {
    if (dir().exists) dir().delete();
  } catch { /* nothing to delete */ }
}
