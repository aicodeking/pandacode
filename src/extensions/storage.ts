/** Internal declarative adapter. Opaque captured identity, never package-selected owner/path. */
import { call } from '../bridge';
import { onExtensionChanged } from './manager';
import type { Json } from './contracts';
import type { PrivateStorage } from './sdk';
type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string } };
export async function captureExtensionStorage(id: string, version: string, context: Record<string, Json>): Promise<{ storage: PrivateStorage; dispose(): void }> {
  const captured = structuredClone(context);
  const reply = await call<Reply<{ handle: string }>>('extensions_context', { request: { op: 'capture', id, version, context: captured } });
  if (!reply.ok) throw new Error(reply.error.code);
  const handle = reply.value.handle;
  let ended = false;
  const dispose = () => { if (ended) return; ended = true; unsubscribe(); void call('extensions_context', { request: { op: 'release', handle } }).catch(() => {}); };
  const unsubscribe = onExtensionChanged(id.split('/')[0], dispose);
  const invoke = async (op: string, options: unknown) => {
    if (ended) throw new Error('StaleContext');
    const result = await call<Reply<unknown>>('extensions_runtime', { request: { op: 'storage', handle, request: { ...(options as object), op } } });
    if (ended) throw new Error('StaleContext');
    if (!result.ok) throw new Error(result.error.code);
    return structuredClone(result.value);
  };
  const storage = Object.freeze(Object.fromEntries(['get', 'set', 'remove', 'snapshot', 'subscribe', 'events', 'unsubscribe', 'migrate'].map(op => [op, (options: unknown) => invoke(op, options)]))) as unknown as PrivateStorage;
  return { storage, dispose };
}
