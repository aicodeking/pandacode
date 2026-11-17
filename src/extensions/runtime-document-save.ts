// Webview and preview twin of src-tauri/src/extensions/runtime_document_save.rs (runtime phase R9, slice R0902):
// the one path every save of a host buffer takes (the user's, an auto-save, a package panel's `document.save()`),
// whoever asked. In order: a read-only file or a disk conflict refuse first (nothing is formatted for a save that will be
// refused); every package mount's `onWillSave` is waited for at most 1 s; the attached `save.before` hooks whose
// `match.extensions` accepts the path and whose package holds `documents.editors` are asked one after another in the
// user's package order (each inside its `budgetMs`, at most 10 s, all inside 60 s) and may return `{ text }` to change
// what is written; the transform lands only on the revision the chain started from; the host writes. A hook can never
// refuse a save: a throw, a timeout, an invalid return or an absent service leaves the text as it was, and an answer
// after its budget is never applied. Panels hear, in revision order, the formatter's rewrite (`reason: 'format'`),
// replacements from disk changes and reverts, and `onDidSave`.
//
// Everything here is for predictability and not losing work (ADR-0005); the user's buffer is never discarded.
//
// The webview twin layers on `DocumentEditors` of R0901 without changing it: `onWillSave` callbacks are registered
// through `DocumentSave.onWillSave` (so the host waits for them before the hooks run, not after), and the host's own
// `editors.save` is the writer.
import { effectiveBudget, FailureStreaks } from './runtime-hook-resolution.ts';
import { chunkContent, DocumentEditors, MAX_TEXT_BYTES, WILL_SAVE_WAIT_MS, type Chunk, type Mount } from './runtime-document-editors.ts';
import type { Json } from './runtime-hook-payload.ts';

export const EVENT = 'save.before';
export const TRIGGERS = ['user', 'auto', 'package'] as const;
export type Trigger = typeof TRIGGERS[number];
export type SaveCode = 'InvalidShape' | 'NotFound' | 'ReadOnly' | 'Conflict' | 'HostUnavailable' | 'PermissionDenied' | 'LimitExceeded' | 'StaleContext';

// ---- one hook return -------------------------------------------------------------------------------------------------

/** What one `save.before` return asks of the host. */
export type Step = { kind: 'empty' } | { kind: 'applied'; text: string } | { kind: 'refused'; code: 'InvalidShape' | 'LimitExceeded' };
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** `{ text?: string }`, exactly, at most 4 MiB; nothing returned is no receipt. */
export function readReturn(value: Json | undefined): Step {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'refused', code: 'InvalidShape' };
  const keys = Object.keys(value);
  if (!keys.length) return { kind: 'empty' };
  if (keys.some(key => key !== 'text')) return { kind: 'refused', code: 'InvalidShape' };
  const text = (value as { text?: Json }).text;
  if (text === undefined || text === null) return { kind: 'empty' };
  if (typeof text !== 'string') return { kind: 'refused', code: 'InvalidShape' };
  if (utf8Length(text) > MAX_TEXT_BYTES) return { kind: 'refused', code: 'LimitExceeded' };
  return { kind: 'applied', text };
}

// ---- what a package mount hears ---------------------------------------------------------------------------------------

export type DocEvent =
  | { type: 'replace'; reason: 'disk' | 'revert' | 'format'; revision: number; chunks: Chunk[] }
  | { type: 'didSave'; revision: number };
/** A replacement is heard before the save of the same revision. */
const rank = (event: DocEvent) => (event.type === 'replace' ? 0 : 1);
/** `replace:<reason>` / `didSave`, for the shared fixtures. */
export const kindOf = (event: DocEvent) => (event.type === 'replace' ? `replace:${event.reason}` : 'didSave');

export interface SaveAudit { action: string; owner: string | null; projectId: string; path: string; revision: number; bytes: number; detail?: string }
export type SaveResult = { ok: true; revision: number; transformed: boolean } | { ok: false; code: SaveCode };

/** One attached `save.before` hook that reaches the file (match and grant checked now), in the user's package order. */
export interface SaveMember {
  owner: string; name: string; hookId: string; budgetMs: number;
  /** The service answers the frame (`{ projectId, path, text, trigger }`); a throw is the hook's failure. */
  ask(payload: { projectId: string; path: string; text: string; trigger: Trigger }): Promise<Json | undefined>;
}
export interface SaveEnv {
  /** The attached hooks of this file, in order. */
  members(projectId: string, path: string): SaveMember[];
  /** Still attached and granted now (a hook removed while it was asked is skipped, not failed). */
  admitted(owner: string, projectId: string): boolean;
  /** `documents.editors` held now for the project. */
  holds(owner: string, projectId: string): boolean;
  /** One one-way frame to the package's service (receipts). */
  deliver(owner: string, frame: Json): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  streaks?: FailureStreaks;
}

const task = (projectId: string) => `document:${projectId}`;
const receipt = (hookId: string, projectId: string, applied: boolean, code?: string): Json => ({
  schemaVersion: 1, receipt: { schemaVersion: 1, hookId, event: EVENT, taskId: task(projectId), applied, ...(code ? { code } : {}) },
});

interface Member { member: SaveMember; step: Step; failure: string | null }
const MAX_EVENTS = 256;

export class DocumentSave {
  readonly audit: SaveAudit[] = [];
  readonly streaks: FailureStreaks;
  private readonly events = new Map<string, DocEvent[]>();
  private readonly willSaves = new Map<string, Array<() => void | Promise<void>>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly editors: DocumentEditors, private readonly env: SaveEnv) {
    this.streaks = env.streaks ?? new FailureStreaks();
    this.now = env.now ?? Date.now;
    this.sleep = env.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  private record(action: string, owner: string | null, at: [string, string, number], bytes: number, detail?: string) {
    if (this.audit.length >= 4_096) this.audit.splice(0, 2_048);
    this.audit.push({ action, owner, projectId: at[0], path: at[1], revision: at[2], bytes, ...(detail ? { detail } : {}) });
  }
  private push(mountId: string, event: DocEvent) {
    const list = this.events.get(mountId) ?? [];
    if (list.length >= MAX_EVENTS) list.shift();
    list.push(event); this.events.set(mountId, list);
  }
  private packageMounts(projectId: string, path: string): Mount[] {
    return this.editors.mounts(projectId, path).filter(mount => !mount.failure && mount.owner !== null && this.env.holds(mount.owner, projectId));
  }

  /** `pandaView.document.onWillSave(callback)`: the host waits up to 1 s for each callback before the hooks run. */
  onWillSave(mountId: string, callback: () => void | Promise<void>) {
    const list = this.willSaves.get(mountId) ?? [];
    list.push(callback); this.willSaves.set(mountId, list);
  }

  /** The events a package mount has not heard yet, in order: R0901's replacements and this module's, sorted by revision. */
  drain(mountId: string): DocEvent[] {
    const fromEditors: DocEvent[] = (this.editors.replaced.get(mountId) ?? []).map(replace => ({ type: 'replace', reason: replace.reason, revision: replace.revision, chunks: replace.chunks }));
    this.editors.replaced.delete(mountId);
    const all = [...fromEditors, ...(this.events.get(mountId) ?? [])];
    this.events.delete(mountId);
    return all.map((event, index) => ({ event, index })).sort((a, b) => (a.event.revision - b.event.revision) || (rank(a.event) - rank(b.event)) || (a.index - b.index)).map(item => item.event);
  }

  /** A package was disabled, uninstalled or lost its grant: its mounts fall back to the built-in editor over the same
   *  buffer, its callbacks and streaks go, and the unsaved changes stay the host's. The caller removes the hook. */
  packageGone(owner: string): Mount[] {
    this.streaks.forget(owner);
    return this.editors.grantsChanged();
  }

  /** `pandaView.document.save()` of a panel: the mount and its grant are checked now. */
  async saveFromPanel(mountId: string, projectId: string, path: string): Promise<SaveResult> {
    const mount = this.editors.mounts(projectId, path).find(item => item.id === mountId && !item.failure && item.owner !== null);
    if (!mount || mount.owner === null) return { ok: false, code: 'NotFound' };
    if (!this.env.holds(mount.owner, projectId)) { this.editors.grantsChanged(); return { ok: false, code: 'PermissionDenied' }; }
    return this.save(projectId, path, 'package');
  }

  /** The one save. See the file's header for the order of its steps. */
  async save(projectId: string, path: string, trigger: Trigger = 'user'): Promise<SaveResult> {
    if (!(TRIGGERS as readonly string[]).includes(trigger)) return { ok: false, code: 'InvalidShape' };
    const buffer = this.editors.buffer(projectId, path);
    if (!buffer) return { ok: false, code: 'NotFound' };
    if (buffer.readOnly) return { ok: false, code: 'ReadOnly' };
    if (buffer.conflict) return { ok: false, code: 'Conflict' };

    // onWillSave: a failing or slow panel never blocks the save.
    for (const mount of this.packageMounts(projectId, path)) {
      for (const callback of this.willSaves.get(mount.id) ?? []) {
        const run = Promise.resolve().then(callback).then(() => 'ok' as const, () => 'failed' as const);
        const outcome = await Promise.race([run, this.sleep(WILL_SAVE_WAIT_MS).then(() => 'timeout' as const)]);
        this.record('will-save', mount.owner, [projectId, path, buffer.revision], 0, outcome);
      }
    }

    // save.before: only a text buffer has text to give.
    const { content, revision: startedAt } = buffer.snapshot();
    const members: Member[] = [];
    const original = 'text' in content ? content.text : null;
    let current = original ?? '';
    if (original !== null) current = await this.chain(projectId, path, trigger, current, members);

    // One revision: the transform lands only on the buffer it was made for.
    let landed: number | null = null;
    if (members.some(item => item.step.kind === 'applied') && buffer.revision === startedAt && !buffer.conflict) {
      const edited = buffer.edit({ text: current });
      if (edited.ok) landed = edited.revision;
    }
    const transformed = landed !== null && original !== current;
    if (transformed && landed !== null) {
      for (const mount of this.packageMounts(projectId, path)) this.push(mount.id, { type: 'replace', reason: 'format', revision: landed, chunks: chunkContent({ text: current }, `format-${mount.id}-${landed}`, landed) });
    }
    for (const { member, step } of members) {
      let applied: boolean; let code: string | undefined;
      if (step.kind === 'applied') { applied = landed !== null; code = applied ? undefined : 'Timeout'; }
      else if (step.kind === 'refused') { applied = false; code = step.code; }
      else continue;
      this.record(EVENT, member.owner, [projectId, path, landed ?? startedAt], utf8Length(current), code ?? 'applied');
      this.env.deliver(member.owner, receipt(member.hookId, projectId, applied, code));
    }

    // The host writes. A failed write keeps the buffer dirty; nothing the user typed is lost.
    const saved = await this.editors.save(projectId, path, trigger as 'user' | 'package');
    if (!saved.ok) return saved;
    for (const mount of this.packageMounts(projectId, path)) this.push(mount.id, { type: 'didSave', revision: saved.revision });
    return { ok: true, revision: saved.revision, transformed };
  }

  /** Asks the attached hooks in order; each sees what the earlier ones left. Answers the final text. */
  private async chain(projectId: string, path: string, trigger: Trigger, start: string, members: Member[]): Promise<string> {
    let current = start;
    const began = this.now();
    for (const member of this.env.members(projectId, path)) {
      if (!this.env.admitted(member.owner, projectId)) continue;
      const wait = effectiveBudget(EVENT, member.budgetMs, this.now() - began);
      let answer: { value?: Json; error?: string };
      let reached = true;
      if (wait <= 0) { answer = { error: 'Timeout' }; reached = false; }
      else {
        const pending = member.ask({ projectId, path, text: current, trigger }).then(value => ({ value }), (error: unknown) => ({ error: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'Internal' }));
        const winner = await Promise.race([pending, this.sleep(wait).then(() => 'timeout' as const)]);
        if (winner === 'timeout') {
          answer = { error: 'Timeout' };
          // A late answer is never applied: the package is told so.
          void pending.then(late => { if ('value' in late && late.value !== null && late.value !== undefined) this.env.deliver(member.owner, receipt(member.hookId, projectId, false, 'Timeout')); });
        } else answer = winner;
      }
      if (answer.error && !this.env.admitted(member.owner, projectId)) continue;
      const step: Step = answer.error === undefined ? readReturn(answer.value) : { kind: 'empty' };
      const failure = answer.error ?? (step.kind === 'refused' ? step.code : null);
      if (reached) {
        if (this.streaks.record(member.owner, EVENT, failure)) this.record('notice', member.owner, [projectId, path, 0], 0, failure ?? 'Timeout');
      }
      if (step.kind === 'applied') current = step.text;
      members.push({ member, step, failure });
      if (failure) this.record('save.before-skipped', member.owner, [projectId, path, 0], 0, failure);
    }
    return current;
  }
}
