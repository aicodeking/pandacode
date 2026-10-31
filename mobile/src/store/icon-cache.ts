// Project icons from the host's `projects.icons` (data: URLs), cached per `${deviceId}/${projectId}`.
// Pure: client.ts asks, keeps the store and the file; tests/icon-cache.test.ts covers it.

export interface IconEntry { url: string | null; at: number }
export type IconCache = Record<string, IconEntry>;

export const DAY_MS = 24 * 3600_000;
/** An id the host left out of its reply is asked again after this long. */
export const RETRY_MS = 10 * 60_000;
export const BATCH = 50;
const MAX_ENTRIES = 500;
const MAX_URL = 512 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;

export const iconKey = (deviceId: string, projectId: string) => `${deviceId}/${projectId}`;

/** Only image data: URLs of a sane size; anything else (untrusted host data) is no icon. */
export const validIcon = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= MAX_URL && DATA_URL.test(value) ? value : null;

/** The ids (deduplicated) to ask for now: never fetched or older than a day. */
export function dueIcons(cache: IconCache, deviceId: string, ids: string[], now: number): string[] {
  return [...new Set(ids)].filter(id => typeof id === 'string' && id && !(now - (cache[iconKey(deviceId, id)]?.at ?? -Infinity) < DAY_MS));
}

/** A reply merged in: answered ids for a day, missing ids keep their old icon and retry soon. */
export function mergeIcons(cache: IconCache, deviceId: string, asked: string[], icons: unknown, now: number): IconCache {
  const reply = icons && typeof icons === 'object' ? icons as Record<string, unknown> : {};
  const next = { ...cache };
  for (const id of asked) {
    const key = iconKey(deviceId, id);
    next[key] = Object.hasOwn(reply, id) ? { url: validIcon(reply[id]), at: now } : { url: cache[key]?.url ?? null, at: now - DAY_MS + RETRY_MS };
  }
  return trimIcons(next);
}

/** Keeps the newest entries so the cache file stays small. */
function trimIcons(cache: IconCache): IconCache {
  const entries = Object.entries(cache);
  return entries.length <= MAX_ENTRIES ? cache : Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES));
}

/** The cache file's contents, checked entry by entry. */
export function parseIcons(text: string | null): IconCache {
  let value: unknown;
  try { value = JSON.parse(text ?? '{}'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cache: IconCache = {};
  for (const [key, entry] of Object.entries(value as Record<string, any>)) {
    if (entry && typeof entry.at === 'number' && Number.isFinite(entry.at)) cache[key] = { url: validIcon(entry.url), at: entry.at };
  }
  return trimIcons(cache);
}

export const chunks = <T>(list: T[], size = BATCH): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, n) => list.slice(n * size, n * size + size));
