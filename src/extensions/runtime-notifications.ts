// Replaceable, attributed notifications of background services (`ui.notify`, runtime phase R2, slice R0207).
//
// The native rules live in src-tauri/src/extensions/runtime_notifications.rs; this file mirrors them with no I/O for the
// browser preview and the deterministic checks of tests/extensions-runtime-notifications.spec.ts, and it is also what the
// interface runs: `mountRuntimeNotices` keeps the in-app list (`[data-extension-notices]`) equal to the notices the host
// holds, and `planRows` decides which row to add, update in place or remove, so a replaced key updates one row and a
// withdrawn one leaves. Everything here is for predictability and fault isolation, never for trust (ADR-0005).
import { toastTitle, type ToastTone } from '../toast-model';

export const PERMISSION = 'ui.notify';
export const MAX_PER_WINDOW = 6;
export const WINDOW_MS = 60_000;
export const MAX_LIVE = 32;
export const TEXT_CHARS = 1024;
export const TITLE_CHARS = 120;
export const RECORDER_MAX = 256;
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
/** The key of the merged notice (no package key is empty). */
export const MERGED_KEY = '';

export type Tone = (typeof TONES)[number];
export type Os = 'delivered' | 'unavailable';
export type NoticeRow = { owner: string; package: string; key: string; title: string; text: string; tone: Tone; merged: boolean; count: number; os: Os; seq: number };
export type NoticeSnapshot = { revision: number; notices: NoticeRow[] };
export type RecorderEntry = { seq: number; op: 'show' | 'replace' | 'merge' | 'withdraw' | 'dismiss'; owner: string; package: string; key: string; title: string; text: string; tone: Tone; os: Os; reason?: string };
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: '$'; ids: [] } };
/** What the app answers about the world; the spec gives fixed answers. */
export type Checks = { granted: boolean; package: string; nowMs: number };
/** The operating-system notification path. The app has none in this build (every answer is `unavailable`). */
export interface OsChannel { show(owner: string, notice: NoticeRow): Os; withdraw(owner: string, key: string): Os }
export const noOsChannel: OsChannel = { show: () => 'unavailable', withdraw: () => 'unavailable' };

const failure = (code: string): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code, path: '$', ids: [] } });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keyOk = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const length = (text: string) => [...text].length;

interface Layer { notices: Map<string, NoticeRow>; sends: number[]; merged: NoticeRow | null }

/** Every package's live notices and the recorder; a package exists here only while it has a notice. */
export class Notices {
  private layers = new Map<string, Layer>();
  private revision_ = 0;
  private seq = 0;
  private entries: RecorderEntry[] = [];
  private os: OsChannel;
  constructor(os: OsChannel = noOsChannel) { this.os = os; }
  revision() { return this.revision_; }
  count(owner: string) { const layer = this.layers.get(owner); return layer ? layer.notices.size + (layer.merged ? 1 : 0) : 0; }

  private record(op: RecorderEntry['op'], owner: string, notice: NoticeRow, reason?: string) {
    const entry: RecorderEntry = { seq: (this.entries.at(-1)?.seq ?? 0) + 1, op, owner, package: notice.package, key: notice.key, title: notice.title, text: notice.text, tone: notice.tone, os: notice.os, ...(reason ? { reason } : {}) };
    if (this.entries.length >= RECORDER_MAX) this.entries.shift();
    this.entries.push(entry);
  }

  /** `panda.ui.notify`: answers `{ key, replaced, merged, os }`. */
  notify(owner: string, checks: Checks, raw: unknown): Reply<{ key: string; replaced: boolean; merged: boolean; os: Os }> {
    if (!checks.granted) return failure('PermissionDenied');
    if (!record(raw) || Object.keys(raw).some(name => !['key', 'text', 'title', 'tone'].includes(name))) return failure('InvalidShape');
    if (!keyOk(raw.key) || typeof raw.text !== 'string' || raw.text.trim() === '') return failure('InvalidShape');
    if (length(raw.text) > TEXT_CHARS) return failure('LimitExceeded');
    let title = '';
    if (raw.title !== undefined && raw.title !== null) {
      if (typeof raw.title !== 'string' || /\p{Cc}/u.test(raw.title)) return failure('InvalidShape');
      if (length(raw.title) > TITLE_CHARS) return failure('LimitExceeded');
      title = raw.title;
    }
    let tone: Tone = 'neutral';
    if (raw.tone !== undefined && raw.tone !== null) { if (!(TONES as readonly unknown[]).includes(raw.tone)) return failure('InvalidShape'); tone = raw.tone as Tone; }
    const key = raw.key;
    this.seq += 1;
    let layer = this.layers.get(owner);
    if (!layer) { layer = { notices: new Map(), sends: [], merged: null }; this.layers.set(owner, layer); }
    while (layer.sends.length && checks.nowMs - layer.sends[0] >= WINDOW_MS) layer.sends.shift();
    // Past six sends in a minute the rest merge into one notice of the package; nothing else is touched.
    if (layer.sends.length >= MAX_PER_WINDOW) {
      const count = (layer.merged?.count ?? 0) + 1;
      const merged: NoticeRow = { owner, package: checks.package, key: MERGED_KEY, title: checks.package, text: `${count} more notices from ${checks.package}`, tone: 'neutral', merged: true, count, os: 'unavailable', seq: this.seq };
      merged.os = this.os.show(owner, merged);
      layer.merged = merged;
      this.revision_ += 1;
      this.record('merge', owner, merged);
      return { ok: true, value: { key, replaced: false, merged: true, os: merged.os } };
    }
    layer.sends.push(checks.nowMs);
    const replaced = layer.notices.has(key);
    const notice: NoticeRow = { owner, package: checks.package, key, title, text: raw.text, tone, merged: false, count: 1, os: 'unavailable', seq: this.seq };
    notice.os = this.os.show(owner, notice);
    layer.notices.set(key, notice);
    let evicted: NoticeRow | undefined;
    if (layer.notices.size > MAX_LIVE) {
      const oldest = [...layer.notices.values()].reduce((a, b) => (a.seq <= b.seq ? a : b));
      layer.notices.delete(oldest.key); evicted = oldest;
    }
    this.revision_ += 1;
    this.record(replaced ? 'replace' : 'show', owner, notice);
    if (evicted) { this.os.withdraw(owner, evicted.key); this.record('withdraw', owner, evicted, 'evicted'); }
    return { ok: true, value: { key, replaced, merged: false, os: notice.os } };
  }

  /** `panda.ui.withdraw`: a key that is gone (or never was) answers `NotFound`, never a second success. */
  withdraw(owner: string, checks: Checks, key: unknown): Reply<null> {
    if (!checks.granted) return failure('PermissionDenied');
    if (!keyOk(key)) return failure('InvalidShape');
    const layer = this.layers.get(owner);
    const notice = layer?.notices.get(key);
    if (!layer || !notice) return failure('NotFound');
    layer.notices.delete(key);
    this.revision_ += 1;
    this.record('withdraw', owner, { ...notice, os: this.os.withdraw(owner, key) });
    return { ok: true, value: null };
  }

  /** The user closes a notice (or the merged one, `MERGED_KEY`) in the list. Answers whether it existed. */
  dismiss(owner: string, key: string): boolean {
    const layer = this.layers.get(owner);
    if (!layer) return false;
    const notice = key === MERGED_KEY ? layer.merged : layer.notices.get(key);
    if (!notice) return false;
    if (key === MERGED_KEY) layer.merged = null; else layer.notices.delete(key);
    this.revision_ += 1;
    this.record('dismiss', owner, { ...notice, os: this.os.withdraw(owner, key) });
    return true;
  }

  /** The service stopped, or the package lost the permission, was disabled or is in safe mode: every notice goes. */
  clear(owner: string, reason: string): boolean {
    const layer = this.layers.get(owner);
    if (!layer) return false;
    this.layers.delete(owner);
    const gone = [...layer.notices.values(), ...(layer.merged ? [layer.merged] : [])].sort((a, b) => a.seq - b.seq);
    for (const notice of gone) this.record('withdraw', owner, { ...notice, os: this.os.withdraw(owner, notice.key) }, reason);
    this.revision_ += 1;
    return true;
  }
  /** Clears every owner `allowed` no longer answers for. */
  sweep(allowed: (owner: string) => boolean, reason: string): boolean {
    let changed = false;
    for (const owner of [...this.layers.keys()]) if (!allowed(owner)) changed = this.clear(owner, reason) || changed;
    return changed;
  }

  snapshot(): NoticeSnapshot {
    const notices = [...this.layers.values()].flatMap(layer => [...layer.notices.values(), ...(layer.merged ? [layer.merged] : [])]).sort((a, b) => a.seq - b.seq);
    return { revision: this.revision_, notices };
  }
  recorder(): RecorderEntry[] { return this.entries.map(entry => ({ ...entry })); }
}

/** A `notice` request of a service: `{ op: 'notify' | 'withdraw', ... }`. Answers the broker envelope. */
export function serve(notices: Notices, owner: string, checks: Checks, params: unknown): Reply {
  const request = record(params) ? params : {};
  if (request.op === 'notify') return notices.notify(owner, checks, request.notice);
  if (request.op === 'withdraw') return notices.withdraw(owner, checks, request.key);
  return failure('InvalidShape');
}

// ---- the in-app list -------------------------------------------------------------------------------------------------

/** One row of the list: the package name always leads, so a notice is never anonymous. */
export type RowView = { id: string; owner: string; key: string; label: string; heading: string; text: string; hover: string; tone: ToastTone; merged: boolean };
export const rowId = (row: Pick<NoticeRow, 'owner' | 'key'>) => `${row.owner}\u0000${row.key}`;
export function rowView(row: NoticeRow): RowView {
  return { id: rowId(row), owner: row.owner, key: row.key, label: row.package, heading: row.title && row.title !== row.package ? row.title : '', text: row.text, hover: toastTitle(row.text), tone: row.tone === 'danger' ? 'danger' : undefined, merged: row.merged };
}

export type RowPlan = { add: RowView[]; update: RowView[]; remove: string[] };
/** What changes between the rows showing (`shown`: id to the text and heading drawn) and a snapshot: a replaced key is an
 * update of its own row, a new key an add, a withdrawn or dismissed one a removal, and an unchanged row is left alone. */
export function planRows(shown: ReadonlyMap<string, string>, snapshot: NoticeSnapshot): RowPlan {
  const views = snapshot.notices.map(rowView);
  const ids = new Set(views.map(view => view.id));
  return {
    add: views.filter(view => !shown.has(view.id)),
    update: views.filter(view => shown.has(view.id) && shown.get(view.id) !== rowSignature(view)),
    remove: [...shown.keys()].filter(id => !ids.has(id)),
  };
}
export function rowSignature(view: RowView): string { return JSON.stringify([view.label, view.heading, view.text, view.tone ?? null, view.merged]); }

/** Draws a plan into the list: rows keep their node, so a replaced key changes text in place and focus stays. */
export function applyPlan(list: HTMLElement, plan: RowPlan, shown: Map<string, string>, dismiss: (owner: string, key: string) => void): void {
  const doc = list.ownerDocument;
  const fill = (row: HTMLElement, view: RowView) => {
    row.dataset.noticeTone = view.tone ?? 'neutral';
    row.title = view.hover;
    row.querySelector('.runtime-notice-package')!.textContent = view.label;
    row.querySelector('.runtime-notice-heading')!.textContent = view.heading;
    (row.querySelector('.runtime-notice-heading') as HTMLElement).hidden = !view.heading;
    row.querySelector('.runtime-notice-text')!.textContent = view.text;
    row.querySelector('button')!.setAttribute('aria-label', `Dismiss notice from ${view.label}`);
    shown.set(view.id, rowSignature(view));
  };
  const find = (id: string) => [...list.children].find(child => (child as HTMLElement).dataset.noticeId === id) as HTMLElement | undefined;
  for (const id of plan.remove) { find(id)?.remove(); shown.delete(id); }
  for (const view of plan.update) { const row = find(view.id); if (row) fill(row, view); }
  for (const view of plan.add) {
    const row = doc.createElement('li');
    row.className = 'runtime-notice';
    row.dataset.noticeId = view.id; row.dataset.noticeOwner = view.owner; row.dataset.noticeKey = view.key;
    if (view.merged) row.dataset.noticeMerged = 'true';
    row.innerHTML = '<div class="runtime-notice-body"><span class="runtime-notice-package"></span><strong class="runtime-notice-heading"></strong><span class="runtime-notice-text"></span></div><button type="button" class="runtime-notice-dismiss" data-notice-dismiss>Dismiss</button>';
    row.querySelector('button')!.addEventListener('click', () => dismiss(view.owner, view.key));
    fill(row, view);
    list.append(row);
  }
  list.closest<HTMLElement>('[data-extension-notices]')!.hidden = list.children.length === 0;
}

let mounted = false;
/** Keeps `[data-extension-notices]` equal to the host's notices: read now and whenever the native side says it moved. A
 * preview window has no service, so its list stays empty. */
export async function mountRuntimeNotices(): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, preview, subscribe } = await import('../bridge');
  if (preview) return;
  await import('./runtime-notifications.css');
  const region = document.createElement('section');
  region.className = 'runtime-notices'; region.hidden = true; region.dataset.extensionNotices = '';
  region.setAttribute('aria-label', 'Notifications from extensions');
  const list = document.createElement('ul');
  list.setAttribute('role', 'status'); list.setAttribute('aria-live', 'polite');
  region.append(list); document.body.append(region);
  const shown = new Map<string, string>();
  const dismiss = (owner: string, key: string) => { void call<boolean>('extensions_runtime_notice_dismiss', { owner, key }).catch(() => undefined); };
  let reading = false, again = false;
  const read = async (): Promise<void> => {
    if (reading) { again = true; return; }
    reading = true;
    try { do { again = false; applyPlan(list, planRows(shown, await call<NoticeSnapshot>('extensions_runtime_notices')), shown, dismiss); } while (again); } catch { /* the list keeps what it shows */ } finally { reading = false; }
  };
  try { await subscribe('extensions-runtime-notices', () => { void read(); }); } catch { /* read once below */ }
  await read();
}
