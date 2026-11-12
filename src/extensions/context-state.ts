/** Immutable invocation client; transport is host-owned, never supplied by package JSON. */
import type { Json } from './contracts.ts';
export type ContextReply<T = unknown> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: string; ids: string[] } };
export type SummaryPage = { schemaVersion: 1; state: 'Ready' | 'NoProject'; revision: string; items: ({ id: string; name: string } | { id: string; projectId: string; status: string })[]; nextCursor: number | null };
export type ContextTransport = (request: Record<string, unknown>) => Promise<ContextReply>;
export const contextFailure = (code: string): ContextReply<never> => ({ ok: false, error: { schemaVersion: 1, code, path: '$', ids: [] } });
export function createContextClient(id: string, version: string, context: Record<string, Json>, transport: ContextTransport) {
  const captured = structuredClone(context);
  let disposed = false, sequence = 0, handle: string | undefined;
  const send = async (request: Record<string, unknown>): Promise<ContextReply> => {
    try { return await transport(request); } catch { return contextFailure('HostUnavailable'); }
  };
  const ready = send({ op: 'capture', id, version, context: captured }).then(result => {
    if (result.ok) handle = (result.value as { handle: string }).handle;
    if (disposed && handle) void send({ op: 'release', handle });
    return result;
  });
  async function request(value: Record<string, unknown>): Promise<ContextReply> {
    const current = ++sequence;
    const capture = await ready;
    if (disposed || current !== sequence) return contextFailure('Cancelled');
    if (!capture.ok) return capture;
    const result = await send({ ...value, handle });
    return disposed || current !== sequence ? contextFailure('Cancelled') : result;
  }
  return {
    context: () => structuredClone(captured),
    consent(capability: 'projects.summary' | 'tasks.summary', allow: boolean) { return request({ op: 'consent', capability, allow }); },
    query(resource: 'projects' | 'tasks', options: { limit?: number; cursor?: number; revision?: string } = {}) { return request({ op: 'query', resource, limit: 10, ...options }) as Promise<ContextReply<SummaryPage>>; },
    dispose() { if (disposed) return; disposed = true; sequence++; if (handle) void send({ op: 'release', handle }); },
  };
}
