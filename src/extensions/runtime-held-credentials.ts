/**
 * Held credentials used without being read, and account switching (`credentials.use`, runtime slice R0805): the
 * webview's reader of the package activity list and a synthetic preview of the native owner
 * (`src-tauri/src/extensions/runtime_held_credentials.rs`, IPC `extensions_credential_activity`).
 *
 * ADR-0006: the value of a credential PandaCode holds is never handed to a package or to the webview. There is no
 * `credentials.read`. The host attaches a granted credential to a request a package asked for, switches the active
 * account of a harness, and writes every use to the package's activity list: the credential item, the destination
 * address and the package, never the value. This file has no browser or Tauri import beyond the bridge, so a test can
 * drive it from Node. The browser preview has no host store: its credentials are labelled stand-ins a test seeds.
 */
import { call } from '../bridge';

export const HELD_PERMISSION = 'credentials.use';
export const DEFAULT_ACCOUNT = 'default';
export const MAX_ENTRIES = 100;
export type ActivityKind = 'credential.use' | 'account.switch';
export type ActivityEntry = { at: number; kind: ActivityKind; item: string; address?: string; package: string; version: string };
export type ActivityList = { schemaVersion: 1; package: string; items: ActivityEntry[] };
export type GrantCheck = 'ok' | string;
export type AccountRow = { harness: string; id: string; active: boolean; label?: string };

/** A held credential id: `provider:<harness>`, `connection:<id>`, `bot:<id>`, `deploy:<name>`, `cloud:<name>`, `speech`, `github`. */
export function validItem(item: unknown): item is string {
  if (typeof item !== 'string') return false;
  const split = item.indexOf(':');
  if (split < 0) return item === 'speech' || item === 'github';
  const kind = item.slice(0, split), id = item.slice(split + 1);
  return ['provider', 'connection', 'bot', 'deploy', 'cloud'].includes(kind) && /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

/** The address a use is recorded with: scheme, host, port and path. The query may carry identifiers, so it is not kept. */
export function addressOf(raw: string | URL): string { const url = new URL(raw); return url.origin + url.pathname; }

/** The item whose grant lets a package switch to `account` of `harness`. */
export const accountItem = (harness: string, account: string) => account === DEFAULT_ACCOUNT ? `provider:${harness}` : `connection:${account}`;

const ENTRY_KEYS = ['at', 'kind', 'item', 'address', 'package', 'version'];
/** Strict reader: an entry with a field this build does not know (a value, for one) makes the whole list unavailable. */
export function parseActivity(value: unknown): ActivityList | null {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.package !== 'string' || !Array.isArray(root.items) || Object.keys(root).some(key => !['schemaVersion', 'package', 'items'].includes(key))) return null;
  for (const entry of root.items as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !ENTRY_KEYS.includes(key))) return null;
    if (!Number.isInteger(entry.at) || (entry.kind !== 'credential.use' && entry.kind !== 'account.switch') || !validItem(entry.item) || typeof entry.package !== 'string' || typeof entry.version !== 'string') return null;
    if (entry.address !== undefined && typeof entry.address !== 'string') return null;
  }
  return root as unknown as ActivityList;
}
/** The package's activity list, newest first (main window). `null` when the host does not answer or answers a shape this build does not know. */
export async function loadActivity(id: string): Promise<ActivityList | null> {
  try { return parseActivity(await call<unknown>('extensions_credential_activity', { id })); } catch { return null; }
}

type Held = Record<string, string>;
type Options = {
  /** Harnesses and their saved connections, as the `accounts` resource lists them (`default` is implicit). */
  harnesses?: Record<string, string[]>;
  now?: () => number;
};
class Refusal extends Error { constructor(readonly code: string) { super(code); } }
const refuse = (code: string): never => { throw new Refusal(code); };

/**
 * Synthetic stand-in for the native owner: the same rules (item grants, the activity list written before a use and
 * never holding a value, a refused use writes nothing, switching needs the account's item and changes only which
 * account is active). `held` values are stand-ins a test seeds; they are used only through `adaptersHeld`.
 */
export function createHeldCredentialsPreview(options: Options = {}) {
  const harnesses = options.harnesses ?? { claude: ['work', 'personal'], codex: [] };
  const now = options.now ?? (() => Date.now());
  const values: Held = {};
  const ledger = new Map<string, ActivityEntry[]>();
  const active = new Map<string, string>();
  const record = (entry: ActivityEntry) => {
    const list = ledger.get(entry.package) ?? [];
    list.push(entry);
    ledger.set(entry.package, list.slice(-MAX_ENTRIES));
  };
  const accounts = (harness?: string): AccountRow[] => {
    const rows: AccountRow[] = [];
    for (const [id, saved] of Object.entries(harnesses)) {
      if (harness !== undefined && harness !== id) continue;
      const current = active.get(id);
      rows.push({ harness: id, id: DEFAULT_ACCOUNT, active: current === undefined });
      for (const account of saved) rows.push({ harness: id, id: account, active: current === account, label: account });
    }
    return rows;
  };
  return {
    /** Test hook: a labelled stand-in for a credential PandaCode holds. The preview has no host secret store. */
    seed(item: string, value: string | null) { if (!validItem(item)) throw new Error('InvalidShape'); if (value === null) delete values[item]; else values[item] = value; },
    /** The shape `createConnectionAdaptersPreview` takes as `held`: the host's own use, never a package call. */
    adaptersHeld(granted: (id: string, version: string, item: string) => boolean) {
      return {
        has: (item: string) => validItem(item) && Object.hasOwn(values, item),
        use(id: string, version: string, item: string, address: string): string | null {
          if (!validItem(item) || !Object.hasOwn(values, item)) return null;
          record({ at: now(), kind: 'credential.use', item, address, package: id, version });
          return values[item];
        },
        granted,
      };
    },
    /** `panda.harnesses.switchAccount`: `check(item)` is the grants preview's answer for the account's item. Throws the native codes; resolves to `null`. */
    switchAccount(holds: boolean, check: (item: string) => GrantCheck, id: string, version: string, caller: 'service' | 'panel', params: unknown): null {
      if (caller !== 'service') refuse('UnsupportedCapability');
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'harness' && key !== 'account')) refuse('InvalidArguments');
      const { harness, account } = params as Record<string, unknown>;
      if (typeof harness !== 'string' || !harness || harness.length > 64 || typeof account !== 'string' || !account || account.length > 128) refuse('InvalidArguments');
      if (!holds) refuse('PermissionDenied');
      if (!Object.hasOwn(harnesses, harness as string) || account !== DEFAULT_ACCOUNT && !harnesses[harness as string].includes(account as string)) refuse('NotFound');
      const item = accountItem(harness as string, account as string);
      if (check(item) !== 'ok') refuse('PermissionDenied');
      record({ at: now(), kind: 'account.switch', item, package: id, version });
      if (account === DEFAULT_ACCOUNT) active.delete(harness as string); else active.set(harness as string, account as string);
      return null;
    },
    /** The accounts rows with their `active` flag, and the revision the `accounts` resource gives them (it changes with a switch). */
    accounts,
    revision(harness?: string): string { return accounts(harness).map(row => `${row.harness}/${row.id}:${row.active ? 1 : 0}`).join('|'); },
    active: (harness: string) => active.get(harness) ?? null,
    activity(id: string): ActivityList { return { schemaVersion: 1, package: id, items: [...(ledger.get(id) ?? [])].reverse() }; },
    removePackage(id: string) { ledger.delete(id); },
  };
}
