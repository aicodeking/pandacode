// Webview and preview twin of src-tauri/src/extensions/runtime_hook_resolution.rs (runtime phase R5, slice R0506):
// the one order every awaited hook chain asks its packages in (the user's order in `_hooks.json`, then the frozen
// first-enabled default, then by id), the per-event budget ceilings inside the 60 s chain, failure streaks and their
// notice, a simulation of one chain on a controlled clock (the shared fixture
// tests/fixtures/extensions/runtime-hook-resolution/chains.json runs through it and through the native member runner),
// the synthetic preview of the native order store, and the Settings -> Extensions control that draws and edits the
// native order. The control holds no order of its own: every change goes to `extensions_hook_order_change` and the
// control redraws what the host answers.
//
// No DOM or bridge import at module level: the spec imports this file in Node.
import { budgetRange, DEFAULT_BUDGET_MS } from './runtime-hook-registration.ts';
import { CHAIN_MS, type Fold, type Receipt, type Step } from './runtime-hook-context.ts';
import type { DecisionFold, DecisionReceipt } from './runtime-hook-decisions.ts';
import type { Json } from './runtime-hook-payload.ts';

export const HOOKS_FILE = '_hooks.json';
export const MAX_ORDER = 256;
const MAX_LEDGER = 4_096;
export const NOTICE_AFTER = 3;

// ---- the order ---------------------------------------------------------------------------------------------------

/** The effective order of `ids`: the user's order first (a repeated id at its first place), then first enabled, then by id. */
export function resolveHookOrder(user: readonly string[], firstEnabled: readonly string[], ids: readonly string[]): string[] {
  const unique = [...new Set(ids)].sort();
  const key = (id: string): [number, number, number, string] => {
    const at = user.indexOf(id);
    if (at >= 0) return [0, at, 0, ''];
    const first = firstEnabled.indexOf(id);
    return [1, 0, first >= 0 ? first : Number.MAX_SAFE_INTEGER, id];
  };
  return unique.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return (x[index] as number) - (y[index] as number);
    return x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0;
  });
}

const idOk = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id);
const dedupKeepFirst = (list: string[]) => list.filter((id, index) => list.indexOf(id) === index);

/** `_hooks.json`: the user's `order` and the host-kept default ledger `firstEnabled`. */
export interface OrderFile { schema: 1; order: string[]; firstEnabled: string[] }
export const emptyOrderFile = (): OrderFile => ({ schema: 1, order: [], firstEnabled: [] });
/** Strict reader of the file; `null` when it is damaged (the host keeps it on disk and answers the default order). */
export function parseOrderFile(value: unknown): OrderFile | null {
  const root = value as Record<string, unknown> | null;
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.schema !== 1 || !Array.isArray(root.order)) return null;
  if (Object.keys(root).some(key => !['schema', 'order', 'firstEnabled'].includes(key))) return null;
  const first = root.firstEnabled ?? [];
  if (!Array.isArray(first) || root.order.length > MAX_ORDER || first.length > MAX_LEDGER || ![...root.order, ...first].every(idOk)) return null;
  return { schema: 1, order: dedupKeepFirst(root.order as string[]), firstEnabled: dedupKeepFirst(first as string[]) };
}
export const effectiveOrder = (file: OrderFile): string[] => resolveHookOrder(file.order, file.firstEnabled, [...file.order, ...file.firstEnabled]);

/** The part of `extensions_snapshot` the order reads. */
export type OrderSnapshot = { safeMode?: boolean; packages: { manifest: { id: string; name?: string; contributes?: { hooks?: { event: string }[] } }; enabled: boolean }[] };
/** Installed packages that declare hooks, with their events (the list the settings control orders). */
export function hookPackages(snapshot: OrderSnapshot): [string, string[]][] {
  return snapshot.packages.flatMap(item => {
    const events = (item.manifest.contributes?.hooks ?? []).map(hook => hook.event).filter(event => typeof event === 'string');
    return events.length ? [[item.manifest.id, events] as [string, string[]]] : [];
  });
}
/** Mirrors `OrderFile::sync`: uninstalled ids leave both lists, newly enabled ids are appended by id; safe mode changes nothing. */
export function syncOrder(file: OrderFile, snapshot: OrderSnapshot): boolean {
  if (snapshot.safeMode) return false;
  const before = JSON.stringify(file);
  const installed = new Set(snapshot.packages.map(item => item.manifest.id));
  file.order = file.order.filter(id => installed.has(id));
  file.firstEnabled = file.firstEnabled.filter(id => installed.has(id));
  const enabled = [...new Set(snapshot.packages.filter(item => item.enabled === true).map(item => item.manifest.id).filter(idOk))].sort();
  for (const id of enabled) { if (file.firstEnabled.length >= MAX_LEDGER) break; if (!file.firstEnabled.includes(id)) file.firstEnabled.push(id); }
  return JSON.stringify(file) !== before;
}
export type OrderChange = { op: 'set'; order: string[] } | { op: 'move'; id: string; to: number } | { op: 'reset' };
/** Mirrors `OrderFile::change`; throws `Error(code)` and changes nothing on a refusal. */
export function changeOrder(file: OrderFile, request: OrderChange, snapshot: OrderSnapshot): void {
  if (snapshot.safeMode) throw new Error('Unavailable');
  const installed = new Set(snapshot.packages.map(item => item.manifest.id));
  const keys = request && typeof request === 'object' ? Object.keys(request) : [];
  let next: string[];
  if (request?.op === 'reset') { if (keys.length !== 1) throw new Error('InvalidArguments'); next = []; }
  else if (request?.op === 'set') {
    if (keys.length !== 2 || !Array.isArray(request.order)) throw new Error('InvalidArguments');
    if (request.order.length > MAX_ORDER) throw new Error('LimitExceeded');
    next = [];
    for (const id of request.order) {
      if (!idOk(id)) throw new Error('InvalidArguments');
      if (!installed.has(id)) throw new Error('UnknownReference');
      if (next.includes(id)) throw new Error('DuplicateId');
      next.push(id);
    }
  } else if (request?.op === 'move') {
    if (keys.length !== 3 || typeof request.id !== 'string' || !Number.isInteger(request.to) || request.to < 0) throw new Error('InvalidArguments');
    const listed = hookPackages(snapshot).map(([id]) => id);
    const shown = resolveHookOrder(file.order, file.firstEnabled, listed);
    const from = shown.indexOf(request.id);
    if (from < 0) throw new Error('UnknownReference');
    if (request.to >= shown.length) throw new Error('InvalidArguments');
    const [moved] = shown.splice(from, 1);
    shown.splice(request.to, 0, moved);
    next = dedupKeepFirst([...shown, ...file.order.filter(id => !listed.includes(id))]).slice(0, MAX_ORDER);
  } else throw new Error('InvalidArguments');
  file.order = next;
}

export interface OrderEntry { id: string; name: string; position: number; enabled: boolean; placed: 'user' | 'default'; events: string[]; failures: { event: string; consecutive: number; code: string | null }[] | null }
export interface OrderProjection { schemaVersion: 1; available: boolean; safeMode: boolean; custom: boolean; packages: OrderEntry[] }
export const UNAVAILABLE_ORDER: OrderProjection = Object.freeze({ schemaVersion: 1, available: false, safeMode: false, custom: false, packages: [] }) as OrderProjection;
/** Mirrors `HookOrder::projection`. */
export function orderProjection(file: OrderFile, snapshot: OrderSnapshot, streaks: FailureStreaks, corrupt = false): OrderProjection {
  const listed = hookPackages(snapshot);
  const ordered = resolveHookOrder(file.order, file.firstEnabled, listed.map(([id]) => id));
  return {
    schemaVersion: 1, available: !corrupt, safeMode: !!snapshot.safeMode, custom: file.order.length > 0,
    packages: ordered.map((id, index) => {
      const item = snapshot.packages.find(entry => entry.manifest.id === id);
      const name = item?.manifest.name;
      const placed: OrderEntry['placed'] = file.order.includes(id) ? 'user' : 'default';
      return { id, name: name && name.trim() ? name : id, position: index + 1, enabled: item?.enabled === true, placed, events: listed.find(([owner]) => owner === id)?.[1] ?? [], failures: streaks.of(id) };
    }),
  };
}
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** Strict reader of the native projection: any shape this build does not know is unavailable. */
export function parseOrderProjection(value: unknown): OrderProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || typeof root.safeMode !== 'boolean' || typeof root.custom !== 'boolean' || !Array.isArray(root.packages)) return UNAVAILABLE_ORDER;
  const packages: OrderEntry[] = [];
  for (const item of root.packages as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.position !== 'number' || typeof item.enabled !== 'boolean' || (item.placed !== 'user' && item.placed !== 'default') || !isStrings(item.events)) return UNAVAILABLE_ORDER;
    const failures = item.failures === null ? null : Array.isArray(item.failures) ? (item.failures as Record<string, unknown>[]).map(entry => ({ event: String(entry?.event ?? ''), consecutive: Number(entry?.consecutive ?? 0), code: typeof entry?.code === 'string' ? entry.code : null })) : undefined;
    if (failures === undefined) return UNAVAILABLE_ORDER;
    packages.push({ id: item.id, name: item.name, position: item.position, enabled: item.enabled, placed: item.placed, events: item.events, failures });
  }
  return { schemaVersion: 1, available: root.available, safeMode: root.safeMode, custom: root.custom, packages };
}

// ---- budgets, streaks, notices -----------------------------------------------------------------------------------

/** What one member may wait: its `budgetMs` inside the event's ceiling, inside what is left of the 60 s chain. */
export function effectiveBudget(event: string, declaredMs: number, elapsedMs: number): number {
  const range = budgetRange(event);
  const own = range ? Math.min(Math.max(declaredMs, range[0]), range[1]) : Math.min(declaredMs, DEFAULT_BUDGET_MS);
  return Math.max(0, Math.min(own, CHAIN_MS - elapsedMs));
}

export interface Streak { consecutive: number; code: string | null; noticed: boolean }
/** Consecutive failures per `(package, event)`; the notice is due once per streak, at the third failure in a row. */
export class FailureStreaks {
  private map = new Map<string, Streak & { owner: string; event: string }>();
  record(owner: string, event: string, failure: string | null): boolean {
    const key = JSON.stringify([owner, event]);
    if (failure === null) { this.map.delete(key); return false; }
    const streak = this.map.get(key) ?? { owner, event, consecutive: 0, code: null, noticed: false };
    streak.consecutive += 1; streak.code = failure; this.map.set(key, streak);
    if (streak.consecutive >= NOTICE_AFTER && !streak.noticed) { streak.noticed = true; return true; }
    return false;
  }
  get(owner: string, event: string): Streak | undefined { const streak = this.map.get(JSON.stringify([owner, event])); return streak && { consecutive: streak.consecutive, code: streak.code, noticed: streak.noticed }; }
  of(owner: string): OrderEntry['failures'] {
    const list = [...this.map.values()].filter(streak => streak.owner === owner).sort((a, b) => a.event < b.event ? -1 : 1).map(streak => ({ event: streak.event, consecutive: streak.consecutive, code: streak.code }));
    return list.length ? list : null;
  }
  forget(owner: string) { for (const [key, streak] of this.map) if (streak.owner === owner) this.map.delete(key); }
}
export function noticeText(name: string, event: string, code: string, policy: string): string {
  const meanwhile = policy === 'deny' ? (event === 'prompt.submit' ? 'messages are not sent while it fails' : 'tool calls are denied while it fails')
    : policy === 'ask' ? 'you are asked to decide while it fails' : 'it is left out while it fails';
  return `${name}'s ${event} hook failed ${NOTICE_AFTER} times in a row (${code}). As it declared, ${meanwhile}. Check it in Settings > Extensions.`;
}
/** The failure a step was for the streak: its error, or an invalid return. */
export function failureOf(answer: Step['answer'], newCodes: readonly (string | undefined)[]): string | null {
  if ('error' in answer) return answer.error;
  return newCodes.find(code => code === 'InvalidShape' || code === 'LimitExceeded') ?? null;
}

// ---- one chain on a controlled clock -----------------------------------------------------------------------------

export interface ChainAnswer { value?: Json; error?: string; rewrite?: { from: string; to: string }; afterMs?: number; never?: boolean; removes?: string[] }
export interface ChainMember { owner: string; name: string; hookId: string; onFailure?: string; budgetMs?: number; grants: string[]; down?: boolean; answer: ChainAnswer }
export interface ChainRun { asked: string[]; removed: string[]; failures: Record<string, string>; late: string[]; notices: string[]; elapsedMs: number }
type AnyFold = Fold | DecisionFold;
const receiptsOf = (fold: AnyFold): (Receipt | DecisionReceipt)[] => 'settled' in fold ? fold.settled() : fold.receipts;

/**
 * The twin of the native chain loops on a controlled clock: members in the resolved order; a member removed (by a
 * removal another member's ask caused, or its own) is skipped without its policy; each member waits inside
 * `effectiveBudget`; a member the 60 s did not reach fails with `Timeout` without being asked; a down (crashed or parked)
 * service fails with `HostUnavailable`; an answer after the budget is a `Timeout` and, if it carried a value, is
 * disposed with a `Timeout` receipt (`late`).
 */
export function simulateChain(event: string, ordered: readonly ChainMember[], fold: AnyFold, base: Record<string, Json>, streaks = new FailureStreaks()): ChainRun {
  const run: ChainRun = { asked: [], removed: [], failures: {}, late: [], notices: [], elapsedMs: 0 };
  const gone = new Set<string>();
  for (const member of ordered) {
    if (fold.stopped()) break;
    if (gone.has(member.owner)) { run.removed.push(member.owner); continue; }
    const budget = effectiveBudget(event, member.budgetMs ?? DEFAULT_BUDGET_MS, run.elapsedMs);
    let answer: Step['answer'];
    let reached = true;
    if (budget === 0) { answer = { error: 'Timeout' }; reached = false; }
    else if (member.down) answer = { error: 'HostUnavailable' };
    else {
      run.asked.push(member.owner);
      for (const removed of member.answer.removes ?? []) gone.add(removed);
      if (gone.has(member.owner)) { run.removed.push(member.owner); continue; }
      const payload = (fold.payload as (base: Record<string, Json>) => Record<string, Json>).call(fold, base);
      const command = typeof (payload.input as Record<string, Json> | undefined)?.command === 'string' ? (payload.input as Record<string, string>).command : '';
      const scripted: Step['answer'] = member.answer.error !== undefined ? { error: member.answer.error }
        : member.answer.rewrite ? { value: command.startsWith(member.answer.rewrite.from) ? { decision: 'rewrite', input: { command: `${member.answer.rewrite.to}${command.slice(member.answer.rewrite.from.length)}` } } : null }
        : { value: member.answer.value ?? null };
      const after = member.answer.afterMs ?? 0;
      if (member.answer.never) { run.elapsedMs += budget; answer = { error: 'Timeout' }; }
      else if (after > budget) {
        run.elapsedMs += budget; answer = { error: 'Timeout' };
        if ('value' in scripted && scripted.value !== null) run.late.push(member.owner);
      } else { run.elapsedMs += after; answer = scripted; }
    }
    const step: Step = { owner: member.owner, name: member.name, onFailure: member.onFailure ?? 'continue', grants: member.grants, answer };
    const before = receiptsOf(fold).length;
    (fold.step as (step: Step) => void).call(fold, step);
    const failure = failureOf(answer, receiptsOf(fold).slice(before).map(receipt => receipt.code));
    if (failure !== null) run.failures[member.owner] = failure;
    if (reached && streaks.record(member.owner, event, failure)) run.notices.push(member.owner);
  }
  return run;
}

// ---- the preview's stand-in of the native store --------------------------------------------------------------------

/**
 * Synthetic stand-in for `HookOrder` (labelled as such): the same rules, persisted in the preview's localStorage so a
 * reload is the preview's restart. The native tests own the authority; `order.json` drives both.
 */
export function createHookOrderPreview(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, key = 'pandacode.preview.extensions.hooks.v1') {
  const streaks = new FailureStreaks();
  const load = (): { file: OrderFile; corrupt: boolean } => {
    const raw = storage.getItem(key);
    if (raw === null) return { file: emptyOrderFile(), corrupt: false };
    try { const file = parseOrderFile(JSON.parse(raw)); if (file) return { file, corrupt: false }; } catch { /* damaged below */ }
    return { file: emptyOrderFile(), corrupt: true };
  };
  const api = {
    streaks,
    sync(snapshot: OrderSnapshot) { const { file, corrupt } = load(); if (syncOrder(file, snapshot) && !corrupt) storage.setItem(key, JSON.stringify(file)); },
    change(request: OrderChange, snapshot: OrderSnapshot) { const { file } = load(); syncOrder(file, snapshot); changeOrder(file, request, snapshot); storage.setItem(key, JSON.stringify(file)); },
    projection(snapshot: OrderSnapshot): OrderProjection { const { file, corrupt } = load(); if (corrupt) syncOrder(file, snapshot); return orderProjection(file, snapshot, streaks, corrupt); },
    /** The preview's `extensions_hook_order` and `extensions_hook_order_change` commands. */
    call(command: string, args: Record<string, unknown>, snapshot: OrderSnapshot): OrderProjection {
      api.sync(snapshot);
      if (command === 'extensions_hook_order_change') api.change(args.request as OrderChange, snapshot);
      return api.projection(snapshot);
    },
  };
  return api;
}

// ---- Settings -> Extensions: the hook order control ------------------------------------------------------------------

export async function loadHookOrder(): Promise<OrderProjection> {
  try { const { call } = await import('../bridge'); return parseOrderProjection(await call<unknown>('extensions_hook_order')); } catch { return UNAVAILABLE_ORDER; }
}
/** The user's change; rejects with the native error code, and nothing changes then. */
export async function changeHookOrder(request: OrderChange): Promise<OrderProjection> {
  const { call } = await import('../bridge');
  return parseOrderProjection(await call<unknown>('extensions_hook_order_change', { request }));
}
export interface HookOrderSource { load(): Promise<OrderProjection>; change(request: OrderChange): Promise<OrderProjection> }
const nativeSource: HookOrderSource = { load: loadHookOrder, change: changeHookOrder };
const html = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const ERRORS: Record<string, string> = {
  UnknownReference: 'That package is no longer installed.', DuplicateId: 'A package can appear only once in the order.',
  Unavailable: 'The order cannot change in safe mode.', StorageUnavailable: 'The order could not be saved.',
};

/** Draws one projection. Native buttons: keyboard and screen readers work unchanged. */
export function hookOrderHtml(projection: OrderProjection, pending: boolean, error: string): string {
  const off = pending ? 'disabled' : '';
  const rows = projection.packages.map((item, index) => {
    const id = html(item.id), name = html(item.name);
    const failing = item.failures?.map(failure => `${html(failure.event)}: failed ${failure.consecutive} time${failure.consecutive === 1 ? '' : 's'} in a row${failure.code ? ` (${html(failure.code)})` : ''}`).join('; ');
    return `<li class="setting-row" data-hook-order-row="${id}"><div><strong>${item.position}. ${name}</strong><small>${id} · ${item.events.map(html).join(', ')} · ${item.placed === 'user' ? 'Placed by you' : 'Default: order first enabled'}${item.enabled ? '' : ' · Disabled'}</small>${failing ? `<small role="status" data-hook-order-failing>${failing}</small>` : ''}</div>
      <button type="button" class="secondary-button" data-hook-order-move="up" aria-label="Move ${name} up" ${off} ${index === 0 ? 'disabled' : ''}>Move up</button>
      <button type="button" class="secondary-button" data-hook-order-move="down" aria-label="Move ${name} down" ${off} ${index === projection.packages.length - 1 ? 'disabled' : ''}>Move down</button></li>`;
  }).join('');
  return `<h3>Hook order</h3><p>Packages that hook into tasks are asked one after another in this order, for every hook. Each sees what the earlier ones changed; a deny wins whatever the order, and an ask wins over an approve. By default the order is the one in which you first enabled them.</p>
    ${!projection.available ? '<p role="status" data-hook-order-damaged>The saved hook order could not be read; the default order applies until you change it.</p>' : ''}
    ${projection.safeMode ? '<p role="status">Safe mode: no package runs, so no hook is asked.</p>' : ''}
    ${projection.packages.length ? `<ol data-hook-order-list aria-label="Hook order">${rows}</ol>` : '<p data-hook-order-empty>No installed package declares hooks.</p>'}
    ${projection.custom ? `<button type="button" class="secondary-button" data-hook-order-reset ${off}>Reset to the default order</button>` : ''}
    ${error ? `<p role="alert">${html(error)}</p>` : ''}`;
}

/** Mounts the hook order control into `host`; returns its disposer. `source` defaults to the native store. */
export function mountHookOrder(host: HTMLElement, source: HookOrderSource = nativeSource, onChanged?: (listener: () => void) => () => void): () => void {
  let disposed = false, pending = false, error = '', projection: OrderProjection = UNAVAILABLE_ORDER;
  const draw = () => { if (!disposed) host.innerHTML = hookOrderHtml(projection, pending, error); };
  const refresh = async () => { try { projection = await source.load(); } finally { draw(); } };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-hook-order-move], [data-hook-order-reset]') : null;
    if (!button || pending || !host.contains(button)) return;
    const row = button.closest<HTMLElement>('[data-hook-order-row]'), id = row?.dataset.hookOrderRow;
    const index = projection.packages.findIndex(item => item.id === id);
    const request: OrderChange | null = button.hasAttribute('data-hook-order-reset') ? { op: 'reset' }
      : id && index >= 0 ? { op: 'move', id, to: button.dataset.hookOrderMove === 'up' ? index - 1 : index + 1 } : null;
    if (!request || (request.op === 'move' && (request.to < 0 || request.to >= projection.packages.length))) return;
    const direction = button.dataset.hookOrderMove;
    pending = true; error = ''; draw();
    try { projection = await source.change(request); }
    catch (failure) { const code = failure instanceof Error ? failure.message : String(failure); error = ERRORS[code] ?? code; try { projection = await source.load(); } catch { /* keep the last projection */ } }
    finally {
      pending = false; draw();
      if (!disposed) {
        // Focus follows the moved package, so repeated Move up/down presses keep working from the keyboard.
        const again = id ? [...host.querySelectorAll<HTMLElement>('[data-hook-order-row]')].find(node => node.dataset.hookOrderRow === id) : null;
        const target = again?.querySelector<HTMLButtonElement>(`[data-hook-order-move="${direction}"]:not([disabled])`) ?? again?.querySelector<HTMLButtonElement>('[data-hook-order-move]:not([disabled])');
        (target ?? host.querySelector<HTMLElement>('[role="alert"]') ?? host.querySelector<HTMLElement>('[data-hook-order-move]:not([disabled])'))?.focus({ preventScroll: true });
      }
    }
  };
  host.addEventListener('click', click);
  const unsubscribe = onChanged?.(() => { if (!pending) void refresh(); });
  draw(); void refresh();
  return () => { disposed = true; unsubscribe?.(); host.removeEventListener('click', click); host.replaceChildren(); };
}
