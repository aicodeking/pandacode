/** Immutable invocation client; transport is host-owned, never supplied by package JSON. */
import type { Json } from './contracts.ts';
export type ContextReply<T = unknown> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: string; ids: string[] } };
export type ContextResource = 'projects' | 'tasks' | 'harnesses' | 'connections' | 'jobs';
export type ContextCapability = 'projects.summary' | 'tasks.summary' | 'harnesses.inventory' | 'connections.summary' | 'jobs.summary';
export type SummaryItem = { id: string; name?: string; projectId?: string; status?: string; installed?: 'Installed' | 'Absent' | 'Unknown'; version?: string | null; capabilities?: string[]; authentication?: string };
export type SummaryPage = { schemaVersion: 1; state: 'Ready' | 'NoProject'; revision: string; items: SummaryItem[]; nextCursor: number | null };
export type ContextStream = { schemaVersion: 1; subscription?: string; cursor: string; snapshot: SummaryPage | null; events: { sequence: number; revision: string; id: string; kind: 'progress' | 'terminal'; status: string }[]; resync: boolean };
export type ContextTransport = (request: Record<string, unknown>) => Promise<ContextReply>;
export type ProjectReadCapability = 'projects.files.metadata' | 'projects.files.read' | 'projects.git.read';
export type ProjectReadResource = 'metadata' | 'file' | 'git';
export type ProjectReadPage = { schemaVersion: 1; state: 'Ready'; revision: string; items: ({ path: string; bytes: number; kind: 'file' } | { kind: 'head'; branch: string | null; commit: string | null })[]; content: string | null; nextCursor: number | null };
export const contextFailure = (code: string): ContextReply<never> => ({ ok: false, error: { schemaVersion: 1, code, path: '$', ids: [] } });
export function createContextClient(id: string, version: string, context: Record<string, Json>, transport: ContextTransport) {
  const captured = structuredClone(context);
  const streams = new Set<() => void>();
  const cleanups = new Set<Promise<void>>();
  let disposed = false, sequence = 0, handle: string | undefined;
  let inFlightRead: Promise<ContextReply<ProjectReadPage>> | undefined;
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
    await Promise.all(cleanups);
    if (disposed || current !== sequence) return contextFailure('Cancelled');
    if (!capture.ok) return capture;
    const result = await send({ ...value, handle });
    return disposed || current !== sequence ? contextFailure('Cancelled') : result;
  }
  async function cancelRead() {
    sequence++;
    if (handle) await send({ op: 'cancelRead', handle });
    await inFlightRead;
  }
  return {
    context: () => structuredClone(captured),
    consent(capability: ContextCapability, allow: boolean) { if (!allow) for (const stop of streams) stop(); return request({ op: 'consent', capability, allow }); },
    query(resource: ContextResource, options: { limit?: number; cursor?: number; revision?: string } = {}) { return request({ op: 'query', resource, limit: 10, ...options }) as Promise<ContextReply<SummaryPage>>; },
    async readConsent(capability: ProjectReadCapability, path: string, allow: boolean) {
      for (const stop of streams) stop();
      await cancelRead();
      return request({ op: 'readConsent', capability, path, allow });
    },
    read(resource: ProjectReadResource, path: string, options: { cursor?: number; revision?: string } = {}) {
      for (const stop of streams) stop();
      const result = request({ op: 'read', resource, path, ...options }) as Promise<ContextReply<ProjectReadPage>>;
      inFlightRead = result; void result.finally(() => { if (inFlightRead === result) inFlightRead = undefined; });
      return result;
    },
    cancelRead,
    /** Bounded pull subscription; no unfiltered native event listener is ever exposed. */
    watch(resource: ContextResource, changed: (result: ContextReply<ContextStream>) => void, scheduler: { schedule: (callback: () => void) => unknown; cancel: (token: unknown) => void } = { schedule: callback => setTimeout(callback, 750), cancel: token => clearTimeout(token as ReturnType<typeof setTimeout>) }) {
      const requestId = crypto.randomUUID();
      let stopped = false, subscription: string | undefined, cursor: string | undefined, timer: unknown;
      let inFlight: Promise<ContextReply<ContextStream>> | undefined;
      const stop = () => {
        if (stopped) return; stopped = true; streams.delete(stop); scheduler.cancel(timer);
        // The native endpoint admits one worker. Do not race unsubscribe/revoke/release against a poll.
        const cleanup = (async () => {
          const late = await inFlight;
          if (late?.ok && late.value.subscription) subscription = late.value.subscription;
          if (handle && subscription) await send({ op: 'unsubscribe', handle, subscription });
        })();
        cleanups.add(cleanup); void cleanup.finally(() => cleanups.delete(cleanup));
      };
      streams.add(stop);
      async function poll() {
        const capture = await ready;
        await Promise.all(cleanups);
        if (stopped || disposed) return;
        inFlight = capture.ok ? send(subscription ? { op: 'events', handle, subscription, cursor } : { op: 'subscribe', handle, resource, limit: 10, requestId }) as Promise<ContextReply<ContextStream>> : Promise.resolve(capture as ContextReply<ContextStream>);
        const result = await inFlight;
        if (result.ok && result.value.subscription) subscription = result.value.subscription;
        if (stopped || disposed) return;
        changed(result);
        if (stopped || disposed) return;
        if (!result.ok) {
          if (['Timeout', 'HostUnavailable'].includes(result.error.code)) { cursor = ''; timer = scheduler.schedule(() => { void poll(); }); }
          else stop();
          return;
        }
        cursor = result.value.cursor;
        timer = scheduler.schedule(() => { void poll(); });
      }
      void poll(); return stop;
    },
    dispose() {
      if (disposed) return; disposed = true; sequence++; for (const stop of streams) stop();
      if (handle) {
        if (inFlightRead) void send({ op: 'cancelRead', handle });
        if (cleanups.size || inFlightRead) void Promise.all([...cleanups, inFlightRead]).then(() => send({ op: 'release', handle })); else void send({ op: 'release', handle });
      }
    },
  };
}
