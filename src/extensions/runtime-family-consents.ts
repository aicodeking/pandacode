/**
 * Native consent of the BTW and family controls, and the per-package confirmation of irreversible deletions; this
 * module is the webview's client of `extensions_family_consents` and the synthetic preview of the native store.
 *
 * The authority is native (`src-tauri/src/extensions/runtime_family_consents.rs`). A package that holds the covering
 * permission acts without a host choice; an API-1 package that does not declare it keeps the previous choice, which is
 * stored natively and survives a restart. A request that asserts a consent, a confirmation or a permission is refused
 * with `PermissionDenied`; a choice or a confirmation is only accepted with a single-use ticket the native gate minted.
 * Pairing a machine and granting remote access are the user's alone: they answer `PermissionDenied` here too.
 */
import { call } from '../bridge';
import { createRuntimeGrantsPreview, type GrantsProjection, type SyncSnapshot } from './runtime-grants';

/** The BTW controls and the six control families, with the permissions that cover each (all of them are needed). */
export const FAMILIES = [
  { family: 'btwContent', covering: ['btw.content'] },
  { family: 'btwControl', covering: ['btw.taskControl'] },
  { family: 'machineControl', covering: ['tasks.control'] },
  { family: 'cloudControl', covering: ['workspace.manage'] },
  { family: 'moodboardControl', covering: ['workspace.manage'] },
  { family: 'branchControl', covering: ['workspace.manage'] },
  { family: 'pullControl', covering: ['workspace.manage'] },
  { family: 'taskControl', covering: ['tasks.start', 'tasks.control'] },
] as const;
export type Family = (typeof FAMILIES)[number]['family'];
/** Irreversible actions and the family that guards each (`null`: `workspace.manage` itself). */
export const IRREVERSIBLE: readonly (readonly [string, Family | null])[] = [
  ['projects.remove', null], ['tasks.remove', null], ['bots.remove', null], ['channels.remove', null], ['recipes.remove', null], ['wakeups.remove', null],
  ['cloud.machines.remove', 'cloudControl'], ['worktrees.remove', 'branchControl'], ['branches.remove', 'branchControl'], ['moodboards.remove', 'moodboardControl'], ['pulls.merge', 'pullControl'],
];
const USER_ONLY = new Set(['pairing', 'pair', 'remoteAccess', 'remote']);
/** Keys that assert a decision only the native side may make. */
const FORGED = new Set(['consent', 'consents', 'granted', 'allowed', 'approved', 'confirmed', 'userChoice', 'trusted', 'permission', 'permissions']);

export type FamilyGate = { decision: 'granted' } | { decision: 'prompt'; ticket: string };
export type DeleteGate = { decision: 'proceed' } | { decision: 'confirm'; ticket: string; what: string };
export type FamilyProjection = { schemaVersion: 1; available: boolean; revision: number; packages: { id: string; confirmDeletions: boolean; consents: { family: string; projects: string[] | null }[] }[] };
export const UNAVAILABLE_FAMILY_CONSENTS: FamilyProjection = Object.freeze({ schemaVersion: 1, available: false, revision: 0, packages: [] }) as FamilyProjection;

export type FamilyRequest =
  | { op: 'projection' }
  | { op: 'gate'; id: string; family: string; project?: string }
  | { op: 'choice'; ticket: string; allow: boolean }
  | { op: 'delete'; id: string; action: string; project?: string; what?: string }
  | { op: 'answer'; ticket: string; accepted: boolean }
  | { op: 'preference'; id: string; confirmDeletions: boolean };

const send = <T>(request: FamilyRequest) => call<T>('extensions_family_consents', { request });
/** Whether the control may act: `granted`, or `prompt` with the ticket the user's choice must present. */
export const familyGate = (id: string, family: Family, project?: string) => send<FamilyGate>({ op: 'gate', id, family, ...(project ? { project } : {}) });
export const familyChoice = (ticket: string, allow: boolean) => send<FamilyProjection>({ op: 'choice', ticket, allow });
/** Asks to run an irreversible action; `confirm` carries the ticket the host confirmation answers. */
export const familyDelete = (id: string, action: string, what: string, project?: string) => send<DeleteGate>({ op: 'delete', id, action, what, ...(project ? { project } : {}) });
/** The host confirmation's answer; a refusal rejects with `Cancelled`. */
export const familyAnswer = (ticket: string, accepted: boolean) => send<{ decision: 'proceed' }>({ op: 'answer', ticket, accepted });
export const setConfirmDeletions = (id: string, confirmDeletions: boolean) => send<FamilyProjection>({ op: 'preference', id, confirmDeletions });

const isProjects = (value: unknown): value is string[] | null => value === null || (Array.isArray(value) && value.every(item => typeof item === 'string'));
/** Strict reader: any shape this build does not know is reported as unavailable, never partially trusted. */
export function parseFamilyConsents(value: unknown): FamilyProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || typeof root.revision !== 'number' || !Array.isArray(root.packages)) return UNAVAILABLE_FAMILY_CONSENTS;
  for (const item of root.packages as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || typeof item.confirmDeletions !== 'boolean' || !Array.isArray(item.consents)
      || (item.consents as Record<string, unknown>[]).some(consent => typeof consent?.family !== 'string' || !FAMILIES.some(row => row.family === consent.family) || !isProjects(consent.projects))) return UNAVAILABLE_FAMILY_CONSENTS;
  }
  return root as unknown as FamilyProjection;
}
export async function loadFamilyConsents(): Promise<FamilyProjection> {
  try { return parseFamilyConsents(await send<unknown>({ op: 'projection' })); } catch { return UNAVAILABLE_FAMILY_CONSENTS; }
}

type Entry = { consents: Record<string, string[] | null>; confirmDeletions: boolean };
type Stored = { schemaVersion: 1; revision: number; packages: Record<string, Entry> };
type Ticket = { kind: 'choice' | 'delete'; id: string; family: Family | null; project: string | undefined; action: string };
type Package = GrantsProjection['packages'][number];
const DENIED = 'PermissionDenied';
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const widened = (current: string[] | null | undefined, project: string | undefined): string[] | null => current === null || project === undefined ? null : [...new Set([...(current ?? []), project])].sort();

/**
 * Synthetic stand-in for the native store, labelled as such: the same gate, ticket, forged-request, deletion and
 * per-package preference rules over the preview grants store, persisted in the preview's localStorage so a reload is
 * the preview's restart (tickets live in memory, as in native). The native Rust tests own the authority; both run
 * `tests/fixtures/extensions/runtime-family-consents/scenario.json`.
 */
export function createFamilyConsentsPreview(grants = createRuntimeGrantsPreview(), storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, key = 'pandacode.preview.extensions.family-consents.v1') {
  const tickets = new Map<string, Ticket>();
  const load = (): Stored => { try { const stored = JSON.parse(storage.getItem(key) ?? ''); if (stored?.schemaVersion === 1) return stored; } catch { /* a missing or damaged preview file starts empty */ } return { schemaVersion: 1, revision: 0, packages: {} }; };
  const mutate = <T>(change: (file: Stored) => T): T => {
    const file = load(), before = JSON.stringify(file.packages), value = change(file);
    for (const [id, entry] of Object.entries(file.packages)) if (Object.keys(entry.consents).length === 0 && entry.confirmDeletions) delete file.packages[id];
    if (JSON.stringify(file.packages) !== before) { file.revision += 1; storage.setItem(key, JSON.stringify(file)); }
    return value;
  };
  const entryOf = (file: Stored, id: string) => file.packages[id] ?? (file.packages[id] = { consents: {}, confirmDeletions: true });
  const info = (id: string): Package => grants.projection().packages.find(item => item.id === id) ?? (() => { throw new Error(DENIED); })();
  const familyRow = (name: string) => {
    if (USER_ONLY.has(name)) throw new Error(DENIED);
    return FAMILIES.find(row => row.family === name) ?? (() => { throw new Error('UnsupportedCapability'); })();
  };
  const scopeOf = (item: Package, permission: string) => item.grants.find(grant => grant.permission === permission)?.scope.projects;
  const declaresAll = (item: Package, covering: readonly string[]) => covering.every(name => item.declared.includes(name));
  const gate = (id: string, name: string, project?: string): 'granted' | 'prompt' => {
    const row = familyRow(name), item = info(id);
    if (row.covering.every(permission => grants.check(id, item.version, permission, { project }) === 'ok')) return 'granted';
    if (!item.authorized || declaresAll(item, row.covering)) return 'prompt';
    const stored = load().packages[id]?.consents[row.family];
    return stored === null || (stored !== undefined && project !== undefined && stored.includes(project)) ? 'granted' : 'prompt';
  };
  const mint = (ticket: Ticket) => { const token = crypto.randomUUID(); tickets.set(token, ticket); if (tickets.size > 64) tickets.delete(tickets.keys().next().value as string); return token; };
  const take = (token: unknown, kind: Ticket['kind']): Ticket => {
    const ticket = typeof token === 'string' ? tickets.get(token) : undefined;
    if (typeof token === 'string') tickets.delete(token);
    if (!ticket || ticket.kind !== kind) throw new Error(DENIED);
    return ticket;
  };
  const authorizeDeletion = (id: string, action: string, project?: string) => {
    const row = IRREVERSIBLE.find(([name]) => name === action);
    if (!row) throw new Error('UnsupportedCapability');
    const item = info(id);
    if (row[1]) { if (gate(id, row[1], project) !== 'granted') throw new Error(DENIED); }
    else if (grants.check(id, item.version, 'workspace.manage', { project }) !== 'ok') throw new Error(DENIED);
  };
  const choose = (token: unknown, allow: boolean) => {
    const ticket = take(token, 'choice'), row = familyRow(ticket.family as string), item = info(ticket.id);
    if (!item.authorized) throw new Error(DENIED);
    if (declaresAll(item, row.covering)) {
      for (const permission of row.covering) {
        const current = scopeOf(item, permission), held = item.grants.some(grant => grant.permission === permission);
        if (allow) { const projects = held ? widened(current ?? null, ticket.project) : ticket.project === undefined ? null : [ticket.project]; grants.change({ op: 'grant', id: ticket.id, permission, scope: projects === null ? {} : { projects } }); }
        else if (held) {
          if (current && ticket.project !== undefined && !current.includes(ticket.project)) continue;
          if (current && ticket.project !== undefined && current.length > 1) grants.change({ op: 'narrow', id: ticket.id, permission, scope: { projects: current.filter(entry => entry !== ticket.project) } });
          else grants.change({ op: 'revoke', id: ticket.id, permission });
        }
      }
      return;
    }
    mutate(file => {
      const entry = entryOf(file, ticket.id), current = entry.consents[row.family];
      if (allow) entry.consents[row.family] = current === undefined ? (ticket.project === undefined ? null : [ticket.project]) : widened(current, ticket.project);
      else if (current !== undefined) {
        if (current && ticket.project !== undefined && !current.includes(ticket.project)) return;
        if (current && ticket.project !== undefined && current.length > 1) entry.consents[row.family] = current.filter(entry => entry !== ticket.project);
        else delete entry.consents[row.family];
      }
    });
  };
  const projection = (): FamilyProjection => {
    const file = load();
    return { schemaVersion: 1, available: true, revision: file.revision, packages: Object.keys(file.packages).sort().map(id => ({ id, confirmDeletions: file.packages[id].confirmDeletions, consents: Object.keys(file.packages[id].consents).sort().map(family => ({ family, projects: file.packages[id].consents[family] })) })) };
  };
  const api = {
    /** Mirrors `FamilyConsents::handle`. */
    handle(request: Record<string, unknown>): unknown {
      const op = request.op, allowed: Record<string, string[]> = {
        projection: ['op'], gate: ['op', 'id', 'family', 'project'], choice: ['op', 'ticket', 'allow'], delete: ['op', 'id', 'action', 'project', 'what'], answer: ['op', 'ticket', 'accepted'], preference: ['op', 'id', 'confirmDeletions'],
      };
      if (typeof op !== 'string' || !allowed[op]) throw new Error('InvalidArguments');
      for (const name of Object.keys(request)) if (!allowed[op].includes(name)) throw new Error(FORGED.has(name) || FAMILIES.some(row => row.family === name) ? DENIED : 'InvalidArguments');
      const present = new Set(grants.projection().packages.map(item => item.id));
      mutate(file => { for (const id of Object.keys(file.packages)) if (!present.has(id)) delete file.packages[id]; });
      const text = (name: string, max: number, optional = false): string | undefined => {
        const value = request[name];
        if (value === undefined || value === null) { if (optional) return undefined; throw new Error('InvalidArguments'); }
        if (!bounded(value, max)) throw new Error('InvalidArguments');
        return value;
      };
      const flag = (name: string) => typeof request[name] === 'boolean' ? request[name] as boolean : (() => { throw new Error('InvalidArguments'); })();
      if (op === 'projection') return projection();
      if (op === 'gate') {
        const id = text('id', 128)!, family = text('family', 64)!, project = text('project', 256, true);
        const decision = gate(id, family, project);
        return decision === 'granted' ? { decision } : { decision, ticket: mint({ kind: 'choice', id, family: familyRow(family).family, project, action: '' }) };
      }
      if (op === 'choice') { choose(text('ticket', 64), flag('allow')); return projection(); }
      if (op === 'delete') {
        const id = text('id', 128)!, action = text('action', 64)!, project = text('project', 256, true), what = typeof request.what === 'string' && request.what.length <= 1024 ? request.what : request.what === undefined || request.what === null ? '' : (() => { throw new Error('InvalidArguments'); })();
        authorizeDeletion(id, action, project);
        if (load().packages[id]?.confirmDeletions === false) return { decision: 'proceed' };
        return { decision: 'confirm', ticket: mint({ kind: 'delete', id, family: null, project, action }), what: what.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) };
      }
      if (op === 'answer') {
        const ticket = take(text('ticket', 64), 'delete');
        if (!flag('accepted')) throw new Error('Cancelled');
        authorizeDeletion(ticket.id, ticket.action, ticket.project);
        return { decision: 'proceed' };
      }
      const id = text('id', 128)!, confirmDeletions = flag('confirmDeletions');
      info(id);
      mutate(file => { entryOf(file, id).confirmDeletions = confirmDeletions; });
      return projection();
    },
    projection,
    /** The preview's `extensions_family_consents` command. */
    call(args: Record<string, unknown>, snapshot: SyncSnapshot) { grants.sync(snapshot); return api.handle(args.request as Record<string, unknown>); },
  };
  return api;
}
