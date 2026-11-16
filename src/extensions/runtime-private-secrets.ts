/**
 * Private secrets of trusted packages (`secrets.private`, runtime slice R0802): the webview's read projection of the
 * native owner (`src-tauri/src/extensions/runtime_private_secrets.rs`, IPC `extensions_private_secrets`) and the
 * synthetic preview of its rules.
 *
 * The webview never reads a value: the projection is package ids, key names and counts. The service-only calls
 * (`secrets.get/set/delete/list`) are answered by the native host, which scopes every key to the calling package. The
 * browser preview runs no package code, so its calls come from a test hook and its store is a labelled stand-in kept
 * in `localStorage` (a preview has no host secret store).
 */
import { call } from '../bridge';

export const SECRETS_PERMISSION = 'secrets.private';
export const MAX_SECRET_KEYS = 64;
export const MAX_SECRET_VALUE_BYTES = 16 * 1024;
export type SecretsMethod = 'secrets.get' | 'secrets.set' | 'secrets.delete' | 'secrets.list';
export type SecretsCaller = 'service' | 'panel';
export type PrivateSecretsPackage = { id: string; count: number; keys: string[] };
export type PrivateSecretsProjection = {
  schemaVersion: 1; available: boolean; kind: 'package-owned'; limits: { keys: number; valueBytes: number }; packages: PrivateSecretsPackage[];
};
export const UNAVAILABLE_SECRETS: PrivateSecretsProjection = Object.freeze({ schemaVersion: 1, available: false, kind: 'package-owned', limits: { keys: MAX_SECRET_KEYS, valueBytes: MAX_SECRET_VALUE_BYTES }, packages: [] }) as PrivateSecretsProjection;

/** Strict reader: a shape this build does not know is unavailable, never partially trusted. A value is refused anywhere. */
export function parsePrivateSecrets(value: unknown): PrivateSecretsProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || root.kind !== 'package-owned' || !Array.isArray(root.packages)) return UNAVAILABLE_SECRETS;
  for (const item of root.packages as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || !Number.isInteger(item.count) || !Array.isArray(item.keys) || item.keys.some(key => typeof key !== 'string') || Object.keys(item).some(name => !['id', 'count', 'keys'].includes(name))) return UNAVAILABLE_SECRETS;
  }
  return root as PrivateSecretsProjection;
}
export async function loadPrivateSecrets(): Promise<PrivateSecretsProjection> {
  try { return parsePrivateSecrets(await call<unknown>('extensions_private_secrets')); } catch { return UNAVAILABLE_SECRETS; }
}

const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const METHODS: SecretsMethod[] = ['secrets.get', 'secrets.set', 'secrets.delete', 'secrets.list'];
const byteLength = (text: string) => new TextEncoder().encode(text).length;
type Stored = Record<string, Record<string, string>>;
export type GrantCheck = 'ok' | string;

/**
 * Synthetic stand-in for the native owner. It follows the same rules (service only, grant checked per call, keys per
 * package, 64 keys, 16 KiB, no extra request fields) over a `localStorage` record. `check` is the grants preview's
 * answer for the caller (`ok` or a refusal); the caller identity is an argument, never part of the request.
 */
export function createPrivateSecretsPreview(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage, key = 'pandacode.preview.extensions.private-secrets.v1') {
  const load = (): Stored => { try { const stored = JSON.parse(storage.getItem(key) ?? ''); if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored; } catch { /* a missing or damaged preview record starts empty */ } return {}; };
  const save = (stored: Stored) => { if (Object.keys(stored).length) storage.setItem(key, JSON.stringify(stored)); else storage.removeItem(key); };
  const fields = (params: unknown, allowed: string[]): Record<string, unknown> => {
    if (params === undefined || params === null) return {};
    if (typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(name => !allowed.includes(name))) throw new Error('InvalidArguments');
    return params as Record<string, unknown>;
  };
  const keyOf = (map: Record<string, unknown>) => { if (typeof map.key !== 'string' || !KEY.test(map.key)) throw new Error('InvalidArguments'); return map.key; };
  return {
    /** The one entry of the preview dispatcher; throws the native error codes. */
    handle(check: GrantCheck, id: string, caller: SecretsCaller, method: string, params?: unknown): unknown {
      if (!METHODS.includes(method as SecretsMethod) || caller !== 'service') throw new Error('UnsupportedCapability');
      if (check !== 'ok') throw new Error('PermissionDenied');
      const stored = load(), owned = stored[id] ?? {};
      if (method === 'secrets.list') { fields(params, []); return { keys: Object.keys(owned).sort() }; }
      if (method === 'secrets.get') { const name = keyOf(fields(params, ['key'])); return { value: Object.hasOwn(owned, name) ? owned[name] : null }; }
      if (method === 'secrets.delete') {
        const name = keyOf(fields(params, ['key']));
        delete owned[name];
        if (Object.keys(owned).length) stored[id] = owned; else delete stored[id];
        save(stored); return null;
      }
      const map = fields(params, ['key', 'value']), name = keyOf(map);
      if (typeof map.value !== 'string' || !map.value) throw new Error('InvalidArguments');
      if (byteLength(map.value) > MAX_SECRET_VALUE_BYTES) throw new Error('LimitExceeded');
      if (!Object.hasOwn(owned, name) && Object.keys(owned).length >= MAX_SECRET_KEYS) throw new Error('LimitExceeded');
      stored[id] = { ...owned, [name]: map.value };
      save(stored); return null;
    },
    /** Uninstall removes the owner's secrets. */
    removePackage(id: string) { const stored = load(); delete stored[id]; save(stored); },
    projection(): PrivateSecretsProjection {
      const stored = load();
      return { schemaVersion: 1, available: true, kind: 'package-owned', limits: { keys: MAX_SECRET_KEYS, valueBytes: MAX_SECRET_VALUE_BYTES },
        packages: Object.keys(stored).sort().map(id => ({ id, count: Object.keys(stored[id]).length, keys: Object.keys(stored[id]).sort() })) };
    },
  };
}
