/** Synthetic preview of private storage; native file/atomicity tests are authoritative. */
import type { ExtensionSnapshot } from './manager';
import type { Json } from './contracts';
type Data = { dataVersion: number; revision: number; values: Record<string, Json>; changes: { sequence: number; keys: string[] }[] };
type State = { schemaVersion: 1; grantVersion: string | null; namespaces: Record<string, Data> };
export type StorageBinding = { owner: string; version: string; context: Record<string, Json> };
const prefix = 'pandacode.preview.extension-private.v1.';
export function createStoragePreview(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const streams = new Map<string, { owner: string; handle: string; name: string; cursor: number }>();
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  function read(id: string): State {
    const value = storage.getItem(prefix + id);
    if (value === null) return { schemaVersion: 1, grantVersion: null, namespaces: {} };
    const state = JSON.parse(value) as State;
    if (state.schemaVersion !== 1 || !state.namespaces || typeof state.namespaces !== 'object' || bytes(state) > 128 * 1024) throw new Error('MalformedData');
    return state;
  }
  function write(id: string, state: State) {
    if (bytes(state) > 128 * 1024) throw new Error('QuotaExceeded');
    storage.setItem(prefix + id, JSON.stringify(state));
  }
  const dispose = (owner?: string, handle?: string) => { for (const [id, stream] of streams) if ((!owner || owner === stream.owner) && (!handle || handle === stream.handle)) streams.delete(id); };
  return {
    dispose,
    granted(id: string, version: string) { try { return read(id).grantVersion === version; } catch { return false; } },
    grant(snapshot: ExtensionSnapshot, id: string, allow: boolean) {
      const item = snapshot.packages.find(item => item.manifest.id === id);
      if (!item?.manifest.permissions?.includes('storage.private') || snapshot.safeMode) throw new Error('PermissionDenied');
      const state = read(id); state.grantVersion = allow ? item.manifest.version : null; write(id, state);
      if (!allow) dispose(id);
    },
    remove(snapshot: ExtensionSnapshot, id: string, confirmation: string) {
      if (id !== confirmation || !/^[a-z0-9_-]+\.[a-z0-9_.-]+$/.test(id) || snapshot.safeMode || snapshot.packages.some(item => item.manifest.id === id)) throw new Error('PermissionDenied');
      storage.removeItem(prefix + id);
      // The preview M3 page namespace remains the canonical form storage.
      // Its page keys are supplied explicitly by the uninstall adapter, never by packages.
      dispose(id);
    },
    call(snapshot: ExtensionSnapshot, binding: StorageBinding | undefined, handle: string, input: Record<string, unknown>): unknown {
      if (!binding) throw new Error('StaleContext');
      const item = snapshot.packages.find(item => item.enabled && item.manifest.id === binding.owner && item.manifest.version === binding.version);
      if (snapshot.safeMode || !item?.manifest.permissions?.includes('storage.private')) throw new Error('PermissionDenied');
      const state = read(binding.owner);
      if (state.grantVersion !== binding.version) throw new Error('PermissionDenied');
      const shapes: Record<string, string[]> = { get: ['op', 'scope', 'key'], set: ['op', 'scope', 'key', 'value'], remove: ['op', 'scope', 'key'], snapshot: ['op', 'scope'], subscribe: ['op', 'scope'], events: ['op', 'scope', 'subscription', 'cursor'], unsubscribe: ['op', 'scope', 'subscription'], migrate: ['op', 'scope', 'revision', 'fromVersion', 'toVersion', 'rollbackCompatible', 'values'] };
      const shape = shapes[String(input.op)];
      if (!shape || Object.keys(input).some(key => !shape.includes(key)) || shape.some(key => !Object.hasOwn(input, key))) throw new Error('InvalidShape');
      if (!['global', 'project'].includes(String(input.scope))) throw new Error('InvalidShape');
      if (input.scope === 'project' && !binding.context.projectId) throw new Error('NoProject');
      const name = JSON.stringify([input.scope, input.scope === 'project' ? binding.context.projectId : null]);
      const data: Data = structuredClone(state.namespaces[name] ?? { dataVersion: 1, revision: 0, values: {}, changes: [] });
      const snap = () => ({ schemaVersion: 1, dataVersion: data.dataVersion, revision: data.revision, values: structuredClone(data.values) });
      const key = input.key;
      if (['get', 'set', 'remove'].includes(String(input.op)) && (typeof key !== 'string' || !key || new TextEncoder().encode(key).length > 128 || /\p{Cc}/u.test(key))) throw new Error('InvalidShape');
      if (input.op === 'get') return { schemaVersion: 1, revision: data.revision, value: Object.hasOwn(data.values, String(key)) ? data.values[String(key)] : null };
      if (input.op === 'snapshot') return snap();
      if (input.op === 'subscribe') {
        if (streams.size >= 64 || [...streams.values()].filter(stream => stream.handle === handle).length >= 8) throw new Error('LimitExceeded');
        const subscription = crypto.randomUUID(); streams.set(subscription, { owner: binding.owner, handle, name, cursor: data.revision });
        return { schemaVersion: 1, subscription, cursor: data.revision, snapshot: snap(), events: [], resync: false };
      }
      if (input.op === 'events' || input.op === 'unsubscribe') {
        const stream = streams.get(String(input.subscription));
        if (!stream || stream.owner !== binding.owner || stream.handle !== handle || stream.name !== name) throw new Error('StaleContext');
        if (input.op === 'unsubscribe') { streams.delete(String(input.subscription)); return null; }
        let resync = input.cursor !== stream.cursor || Number(input.cursor) > data.revision || data.revision > Number(input.cursor) && (!data.changes[0] || data.changes[0].sequence > Number(input.cursor) + 1);
        let events = resync ? [] : data.changes.filter(change => change.sequence > Number(input.cursor));
        if (bytes(events) > 24 * 1024) { resync = true; events = []; }
        stream.cursor = data.revision; return { schemaVersion: 1, cursor: data.revision, snapshot: resync ? snap() : null, events, resync };
      }
      let keys = [String(key)];
      if (input.op === 'migrate') {
        if (input.revision !== data.revision || input.fromVersion !== data.dataVersion || input.toVersion !== data.dataVersion + 1 || input.rollbackCompatible !== true || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('MigrationRejected');
        keys = [...new Set([...Object.keys(data.values), ...Object.keys(input.values)])];
        data.values = structuredClone(input.values) as Record<string, Json>; data.dataVersion++;
      } else if (input.op === 'set') Object.defineProperty(data.values, String(key), { value: structuredClone(input.value), enumerable: true, writable: true, configurable: true });
      else if (input.op === 'remove') delete data.values[String(key)];
      else throw new Error('InvalidShape');
      if (Object.keys(data.values).length > 128 || keys.length > 128 || bytes(data.values) > 24 * 1024 || Object.entries(data.values).some(([key, value]) => !key || new TextEncoder().encode(key).length > 128 || /\p{Cc}/u.test(key) || bytes(value) > 16 * 1024) || !Object.hasOwn(state.namespaces, name) && (Object.keys(state.namespaces).length >= 33 || input.scope === 'project' && Object.keys(state.namespaces).filter(name => JSON.parse(name)[0] === 'project').length >= 32)) throw new Error('QuotaExceeded');
      data.revision++; data.changes.push({ sequence: data.revision, keys }); data.changes = data.changes.slice(-32);
      state.namespaces[name] = data; write(binding.owner, state);
      return { schemaVersion: 1, revision: data.revision };
    },
  };
}
