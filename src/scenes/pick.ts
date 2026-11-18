/** The per-thread pick, pure so tests/scenes.test.mjs can run it under Node: FNV-1a (32-bit) of the thread id, mod the
 * scene count. Stable across reloads and machines; adding a scene reshuffles threads, which is fine. */
export function sceneIndex(threadId: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < threadId.length; i++) { hash ^= threadId.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  // A final avalanche: FNV's low bits barely move for ids that differ only in a trailing digit.
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x2c1b3c6d); hash ^= hash >>> 12;
  return (hash >>> 0) % Math.max(1, count);
}
