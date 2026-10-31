// Each thread's recent messages on disk, so a thread draws at once on open (threads.ts does the
// file work, client.ts decides when). Pure: tests/thread-cache.test.ts covers it.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Message } from '../connect/types.ts';

/** Messages kept per thread, newest last. */
export const CACHE_MESSAGES = 200;
/** One thread's file at most; its oldest messages go first. */
export const THREAD_BYTES = 512 * 1024;
/** Every thread file together; the least recently opened or saved go first. */
export const CACHE_BYTES = 8 * 1024 * 1024;

/** One file's contents. `hasOlder`: the host has messages before the first one kept. */
export interface CachedThread { messages: Message[]; hasOlder: boolean }
/** The index entry per taskKey: file name, last use (ms), size and newest id. */
export interface CacheEntry { file: string; at: number; bytes: number; lastId: number }
export type CacheIndex = Record<string, CacheEntry>;

/** A file name that holds no ids (they may contain any printable character). */
export const fileName = (key: string) => `${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 32)}.json`;

/** The file text for a thread: its newest CACHE_MESSAGES messages within THREAD_BYTES. */
export function encodeThread(messages: readonly Message[], hasOlder: boolean): string {
  let kept = messages.slice(-CACHE_MESSAGES);
  let text = JSON.stringify({ messages: kept, hasOlder: hasOlder || kept.length < messages.length });
  while (text.length > THREAD_BYTES && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    text = JSON.stringify({ messages: kept, hasOlder: true });
  }
  return text;
}

const validMessage = (m: any): m is Message =>
  m && Number.isSafeInteger(m.id) && m.id > 0 && typeof m.role === 'string' && typeof m.content === 'string' && typeof m.createdAt === 'number'
  && (m.turnDurationMs === null || typeof m.turnDurationMs === 'number');

/** A file's contents, or null if it is not a sane thread (ids must rise). */
export function decodeThread(text: string | null): CachedThread | null {
  let value: any;
  try { value = JSON.parse(text ?? ''); } catch { return null; }
  if (!value || !Array.isArray(value.messages) || !value.messages.length || !value.messages.every(validMessage)) return null;
  if (value.messages.some((m: Message, i: number) => i && m.id <= value.messages[i - 1].id)) return null;
  return { messages: value.messages, hasOlder: value.hasOlder === true };
}

/** The index after using (reading or writing) `key`. */
export const touch = (index: CacheIndex, key: string, entry: Partial<CacheEntry> & { at: number }): CacheIndex =>
  ({ ...index, [key]: { bytes: 0, lastId: 0, ...(index[key] as CacheEntry | undefined), ...entry, file: fileName(key) } });

/** Drops the least recently used threads until the rest fit `max`; returns the kept index and the dropped files. */
export function evict<E extends { file: string; at: number; bytes: number }>(index: Record<string, E>, max = CACHE_BYTES): { index: Record<string, E>; drop: string[] } {
  const entries = Object.entries(index).sort((a, b) => b[1].at - a[1].at);
  let total = 0;
  const kept: Record<string, E> = {};
  const drop: string[] = [];
  for (const [key, entry] of entries) {
    total += entry.bytes;
    if (total <= max) kept[key] = entry;
    else drop.push(entry.file);
  }
  return { index: kept, drop };
}

/** The index file's contents, checked entry by entry. */
export function parseIndex(text: string | null): CacheIndex {
  let value: unknown;
  try { value = JSON.parse(text ?? '{}'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const index: CacheIndex = {};
  for (const [key, e] of Object.entries(value as Record<string, any>)) {
    if (e && e.file === fileName(key) && [e.at, e.bytes, e.lastId].every(Number.isFinite)) index[key] = { file: e.file, at: e.at, bytes: e.bytes, lastId: e.lastId };
  }
  return index;
}
