// Drafts and attachments without sending (`tasks.draft`, runtime phase R4, slice R0403).
//
// The native rules live in src-tauri/src/extensions/runtime_tasks_drafts.rs; the first half of this file mirrors them with no
// I/O for the browser preview and the deterministic checks of tests/extensions-runtime-tasks-drafts.spec.ts. The second half is
// what the main window runs: it answers the two rounds of every call (`resolve`, then `apply` once the host checked the grant
// against the resolved project) against the composer, its per-task drafts and its attachment bar, and it draws a package's
// suggestion as ghost text. Nothing here sends a message: a call has no option that does, `suggest` never becomes the draft
// until the user accepts it, and a package that holds `tasks.draft` for a project is never asked again per action (ADR-0005).
import type { Json } from './contracts';
import { envelope, type Refusal, type Reply } from './runtime-tasks-start';

export const PERMISSION = 'tasks.draft';
/** Reading an attachment's bytes is the transcript grant, not the draft one. */
export const READ_PERMISSION = 'tasks.transcript.read';
export const TEXT_BYTES = 200_000;
export const PATH_CHARS = 4096;
export const CHUNK_BYTES = 256 * 1024;
export const MAX_WAITING = 8;
export const OPS = ['get', 'set', 'insert', 'suggest', 'attach', 'detach'] as const;
export type OpName = (typeof OPS)[number];
const MAX_REVISION = 2 ** 53;
const WINDOW_CODES = ['NotFound', 'Busy', 'StaleContext', 'InvalidShape', 'LimitExceeded', 'HostUnavailable', 'UnsupportedCapability', 'Revoked', 'Conflict', 'Timeout'];

export type Target = { windowId: string } | { taskId: string };
export type DraftAttachment = { id: string; kind: string; name: string };
export type Op = { op: 'get' } | { op: 'set'; text: string; revision?: number } | { op: 'insert'; text: string } | { op: 'suggest'; text: string } | { op: 'attach'; path: string } | { op: 'detach'; attachmentId: string };
export type Request = { target: Target; op: Op };
export type { Refusal, Reply };

const refuse = (code: string, path = '$', ids: string[] = []): Refusal => ({ code, path, ids });
const denied = (permission: string): Refusal => refuse('PermissionDenied', permission);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ident = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const isRefusal = (value: unknown): value is Refusal => record(value) && typeof value.code === 'string' && typeof value.path === 'string' && Array.isArray(value.ids);

function textOf(raw: Record<string, unknown>, emptyOk: boolean): string | Refusal {
  const text = raw.text;
  if (typeof text !== 'string' || text.includes('\0') || (!emptyOk && text === '')) return refuse('InvalidShape');
  return utf8(text) > TEXT_BYTES ? refuse('LimitExceeded') : text;
}

/** Reads a draft call: `{op, windowId | taskId, text?, revision?, path?, attachmentId?}`. Nothing is looked up here. */
export function readRequest(raw: unknown): Request | Refusal {
  if (!record(raw)) return refuse('InvalidShape');
  const name = raw.op;
  if (typeof name !== 'string' || !(OPS as readonly string[]).includes(name)) return refuse('InvalidShape');
  const extra: readonly string[] = name === 'set' ? ['text', 'revision'] : name === 'insert' || name === 'suggest' ? ['text'] : name === 'attach' ? ['path'] : name === 'detach' ? ['attachmentId'] : [];
  if (Object.keys(raw).some(key => !['op', 'windowId', 'taskId'].includes(key) && !extra.includes(key))) return refuse('InvalidShape');
  for (const key of ['windowId', 'taskId']) if (raw[key] !== undefined && !ident(raw[key])) return refuse('InvalidShape');
  if ((raw.windowId === undefined) === (raw.taskId === undefined)) return refuse('InvalidShape');
  const target: Target = raw.windowId !== undefined ? { windowId: raw.windowId as string } : { taskId: raw.taskId as string };
  switch (name) {
    case 'get': return { target, op: { op: 'get' } };
    case 'set': {
      let revision: number | undefined;
      if (raw.revision !== undefined && raw.revision !== null) {
        if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0 || raw.revision > MAX_REVISION) return refuse('InvalidShape');
        revision = raw.revision;
      }
      const text = textOf(raw, true);
      return typeof text !== 'string' ? text : { target, op: { op: 'set', text, ...(revision !== undefined ? { revision } : {}) } };
    }
    case 'insert': case 'suggest': {
      const text = textOf(raw, name === 'suggest');
      return typeof text !== 'string' ? text : { target, op: { op: name, text } };
    }
    case 'attach': {
      if (typeof raw.path !== 'string' || raw.path === '' || raw.path.includes('\0')) return refuse('InvalidShape');
      return [...raw.path].length > PATH_CHARS ? refuse('LimitExceeded') : { target, op: { op: 'attach', path: raw.path } };
    }
    default: return ident(raw.attachmentId) ? { target, op: { op: 'detach', attachmentId: raw.attachmentId } } : refuse('InvalidShape');
  }
}
export const mutates = (op: Op): boolean => op.op !== 'get';

/** The grant for the resolved project. `holds` is "the package holds this permission for any project": without it the answer
 * is the permission itself whatever the target, so a refusal never says whether a task or a window exists. */
export function gate(permission: string, holds: boolean, project: string | undefined, granted: (project: string) => boolean): string | Refusal {
  if (!holds) return denied(permission);
  if (project === undefined) return refuse('NotFound');
  return granted(project) ? project : denied(permission);
}

/** The draft's revision: a hash of its text and attachment ids, so any change by the user or a package moves it. */
export function revisionOf(text: string, attachments: readonly { id: string }[]): number {
  let hash = 0x811c9dc5;
  const feed = (part: string) => { for (let index = 0; index < part.length; index += 1) { hash ^= part.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; } hash ^= 0xff; hash = Math.imul(hash, 0x01000193) >>> 0; };
  feed(text);
  for (const attachment of attachments) feed(attachment.id);
  return hash >>> 0;
}

export type Resolved = { taskId: string; projectId: string; revision: number; text: string; attachments: DraftAttachment[] };
export function readRefusal(answer: unknown): Refusal {
  const code = record(answer) ? answer.code : undefined;
  return refuse(typeof code === 'string' && WINDOW_CODES.includes(code) ? code : 'InvalidShape');
}
/** Reads the answer of `resolve`. */
export function readResolved(answer: unknown): Resolved | Refusal {
  if (!record(answer) || answer.ok !== true) return readRefusal(answer);
  const { taskId, projectId, revision, text, attachments } = answer;
  if (!ident(taskId) || !ident(projectId) || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || typeof text !== 'string' || !Array.isArray(attachments)) return refuse('InvalidShape');
  const rows = attachments.filter((item): item is DraftAttachment => record(item) && ident(item.id) && typeof item.kind === 'string' && typeof item.name === 'string').map(item => ({ id: item.id, kind: item.kind, name: item.name }));
  return { taskId, projectId, revision, text, attachments: rows };
}
export const draftValue = (resolved: Resolved): Json => ({ text: resolved.text, attachments: resolved.attachments, revision: resolved.revision });

/** The `apply` round for an operation, once the window resolved the draft the call reaches. */
export function applyPayload(request: Request, resolved: Resolved): Record<string, Json> {
  const payload: Record<string, Json> = { phase: 'apply', op: request.op.op, taskId: resolved.taskId, revisionAtResolve: resolved.revision };
  if ('windowId' in request.target) payload.windowId = request.target.windowId;
  const op = request.op;
  if (op.op === 'set') { payload.text = op.text; if (op.revision !== undefined) payload.revision = op.revision; }
  else if (op.op === 'insert' || op.op === 'suggest') payload.text = op.text;
  else if (op.op === 'attach') payload.path = op.path;
  else if (op.op === 'detach') payload.attachmentId = op.attachmentId;
  return payload;
}

// ---- Attachment pages ------------------------------------------------------------------------------------------------

export type AttachmentChunk = { schemaVersion: 1; mime: string; name: string; bytes: number; data: string; nextCursor: number | null };
export function checkCursor(total: number, cursor: number): Refusal | null { return cursor > total || (cursor === total && total > 0) ? refuse('LimitExceeded') : null; }
const base64 = (bytes: Uint8Array): string => { let text = ''; for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(text); };
/** One page from `cursor` on: at most 256 KiB decoded, a byte cursor, `nextCursor` null at the end. */
export function memoryPage(name: string, mime: string, bytes: Uint8Array, cursor: number): AttachmentChunk | Refusal {
  const refusal = checkCursor(bytes.length, cursor);
  if (refusal) return refusal;
  const part = bytes.subarray(cursor, cursor + CHUNK_BYTES);
  const end = cursor + part.length;
  return { schemaVersion: 1, mime, name, bytes: bytes.length, data: base64(part), nextCursor: end < bytes.length ? end : null };
}

// ---- The preview model -----------------------------------------------------------------------------------------------

type Ghost = { owner: string; text: string };
type Draft = { projectId: string; text: string; attachments: (DraftAttachment & { bytes?: Uint8Array; mime?: string })[]; undo: string[]; ghost: Ghost | null };
/** What the world answers for a call: whether the package holds the permission at all, and for which project. */
export type Checks = { holds: boolean; granted: (projectId: string) => boolean };

/** The deterministic twin of the native `serve` and the window's `apply`: same order of checks, same refusals, same edits.
 * `sent` stays empty by construction: no call here sends, and the spec asserts it. */
export class DraftModel {
  /** Window id to the task its composer shows. */
  readonly windows = new Map<string, string | null>();
  readonly drafts = new Map<string, Draft>();
  /** Files the user can attach by path. */
  readonly files = new Map<string, { name: string; kind: string; mime: string; bytes: Uint8Array }>();
  /** Attachments of sent messages: task id, then attachment id. */
  readonly stored = new Map<string, Map<string, { name: string; mime: string; bytes: Uint8Array }>>();
  /** Windows whose composer has an input method composition in progress. */
  readonly composing = new Set<string>();
  readonly sent: string[] = [];
  readonly log: string[] = [];
  private serial = 0;

  addTask(taskId: string, projectId: string, text = ''): void { this.drafts.set(taskId, { projectId, text, attachments: [], undo: [], ghost: null }); }
  show(windowId: string, taskId: string | null): void {
    const before = this.windows.get(windowId);
    this.windows.set(windowId, taskId);
    // Switching what a window shows leaves no ghost text behind on the task it left.
    if (before && before !== taskId) { const draft = this.drafts.get(before); if (draft) draft.ghost = null; }
  }
  /** The user types: the ghost text goes and the revision moves. */
  userType(taskId: string, text: string): void { const draft = this.drafts.get(taskId); if (draft) { draft.undo.push(draft.text); draft.text = text; draft.ghost = null; } }
  undo(taskId: string): boolean { const draft = this.drafts.get(taskId); const text = draft?.undo.pop(); if (!draft || text === undefined) return false; draft.text = text; return true; }
  /** What a window draws as ghost text: only the suggestion on the task it shows. */
  ghost(windowId: string): Ghost | null { const task = this.windows.get(windowId); return task ? this.drafts.get(task)?.ghost ?? null : null; }
  /** The user accepts the suggestion: it becomes draft text (one undo step), and nothing is sent. */
  accept(windowId: string): boolean {
    const task = this.windows.get(windowId), draft = task ? this.drafts.get(task) : undefined;
    if (!draft?.ghost || this.composing.has(windowId)) return false;
    draft.undo.push(draft.text); draft.text += draft.ghost.text; draft.ghost = null; return true;
  }
  /** The package's service ended: its ghost text leaves every screen. */
  end(owner: string): number { let cleared = 0; for (const draft of this.drafts.values()) if (draft.ghost?.owner === owner) { draft.ghost = null; cleared += 1; } return cleared; }
  /** A grant changed: ghost text whose package no longer holds the permission for the project goes. */
  sweep(holds: (owner: string, projectId: string) => boolean): number { let cleared = 0; for (const draft of this.drafts.values()) if (draft.ghost && !holds(draft.ghost.owner, draft.projectId)) { draft.ghost = null; cleared += 1; } return cleared; }

  private resolve(request: Request): Resolved | Refusal {
    const taskId = 'windowId' in request.target ? this.windows.get(request.target.windowId) ?? undefined : request.target.taskId;
    const draft = taskId ? this.drafts.get(taskId) : undefined;
    if (!taskId || !draft) return refuse('NotFound');
    const attachments = draft.attachments.map(item => ({ id: item.id, kind: item.kind, name: item.name }));
    return { taskId, projectId: draft.projectId, revision: revisionOf(draft.text, attachments), text: draft.text, attachments };
  }

  /** `panda.tasks.draft.*`. `between` runs after the resolve round and before the edit (the spec revokes there). */
  call(owner: string, checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    if (!checks.holds) return envelope(denied(PERMISSION));
    const request = readRequest(raw);
    if (isRefusal(request)) return envelope(request);
    let known: string | undefined;
    if ('taskId' in request.target) {
      const gated = gate(PERMISSION, checks.holds, this.drafts.get(request.target.taskId)?.projectId, checks.granted);
      if (isRefusal(gated)) return envelope(gated);
      known = gated;
    }
    const resolved = this.resolve(request);
    if (isRefusal(resolved)) return envelope(resolved);
    const project = gate(PERMISSION, checks.holds, resolved.projectId, checks.granted);
    if (isRefusal(project)) return envelope(project);
    if (known !== undefined && known !== project) return envelope(refuse('StaleContext'));
    if (!mutates(request.op)) return { ok: true, value: draftValue(resolved) };
    between();
    if (!checks.granted(project)) return envelope(denied(PERMISSION));
    const applied = this.apply(owner, request, resolved);
    return isRefusal(applied) ? envelope(applied) : { ok: true, value: applied };
  }

  private apply(owner: string, request: Request, resolved: Resolved): Json | Refusal {
    const draft = this.drafts.get(resolved.taskId);
    if (!draft) return refuse('NotFound');
    if ('windowId' in request.target && this.windows.get(request.target.windowId) !== resolved.taskId) return refuse('StaleContext');
    // An input method composition in progress is never interrupted: the package retries.
    const shownIn = [...this.windows].filter(([, task]) => task === resolved.taskId).map(([id]) => id);
    if (shownIn.some(id => this.composing.has(id)) && request.op.op !== 'detach') return refuse('Busy');
    const op = request.op;
    switch (op.op) {
      case 'set':
        if (op.revision !== undefined && op.revision !== revisionOf(draft.text, draft.attachments)) return refuse('StaleContext');
        draft.undo.push(draft.text); draft.text = op.text; draft.ghost = null; this.log.push(`set:${resolved.taskId}`); return null;
      case 'insert': {
        const sep = draft.text && !/\s$/.test(draft.text) ? (op.text.includes('\n') ? '\n' : ' ') : '';
        draft.undo.push(draft.text); draft.text += sep + op.text; draft.ghost = null; this.log.push(`insert:${resolved.taskId}`); return null;
      }
      case 'suggest': draft.ghost = op.text === '' ? null : { owner, text: op.text }; this.log.push(`suggest:${resolved.taskId}`); return null;
      case 'attach': {
        const file = this.files.get(op.path);
        if (!file) return refuse('NotFound');
        if (draft.attachments.some(item => item.name === file.name)) return refuse('Conflict');
        if (draft.attachments.filter(item => item.kind === file.kind).length >= (file.kind === 'image' ? 4 : 5)) return refuse('LimitExceeded');
        const id = `att-${++this.serial}`;
        draft.attachments.push({ id, kind: file.kind, name: file.name, bytes: file.bytes, mime: file.mime });
        this.log.push(`attach:${resolved.taskId}`);
        return { id };
      }
      case 'detach': {
        const index = draft.attachments.findIndex(item => item.id === op.attachmentId);
        if (index < 0) return refuse('NotFound');
        draft.attachments.splice(index, 1); this.log.push(`detach:${resolved.taskId}`); return null;
      }
      default: return null;
    }
  }

  /** `panda.tasks.attachments.read`: `tasks.transcript.read` for the task's project, a byte cursor, 256 KiB a page. */
  read(checks: Checks, raw: unknown, between: () => void = () => undefined): Reply<Json> {
    if (!checks.holds) return envelope(denied(READ_PERMISSION));
    if (!record(raw) || Object.keys(raw).some(key => !['taskId', 'attachmentId', 'cursor'].includes(key)) || !ident(raw.taskId) || !ident(raw.attachmentId)) return envelope(refuse('InvalidShape'));
    if (raw.cursor !== undefined && raw.cursor !== null && (typeof raw.cursor !== 'number' || !Number.isInteger(raw.cursor) || raw.cursor < 0 || raw.cursor > MAX_REVISION)) return envelope(refuse('InvalidShape'));
    const cursor = typeof raw.cursor === 'number' ? raw.cursor : 0;
    const draft = this.drafts.get(raw.taskId);
    const project = gate(READ_PERMISSION, checks.holds, draft?.projectId, checks.granted);
    if (isRefusal(project)) return envelope(project);
    const source = this.stored.get(raw.taskId)?.get(raw.attachmentId) ?? draft?.attachments.find(item => item.id === raw.attachmentId && item.bytes);
    const found = source && 'bytes' in source && source.bytes ? { name: source.name, mime: source.mime ?? 'application/octet-stream', bytes: source.bytes } : undefined;
    if (!found) return envelope(refuse('NotFound'));
    const page = memoryPage(found.name, found.mime, found.bytes, cursor);
    between();
    if (!checks.granted(project)) return envelope(denied(READ_PERMISSION));
    return isRefusal(page) ? envelope(page) : { ok: true, value: page as unknown as Json };
  }
}

// ---- The window's answers ----------------------------------------------------------------------------------------------

export type Answer = { ok: true; [key: string]: Json } | { ok: false; code: string };
/** What the main window supplies; the spec gives a fake and the app gives the composer. */
export type WindowHost = {
  windowId(): string;
  /** The task whose draft the composer shows, or null. */
  shown(): string | null;
  project(taskId: string): string | undefined;
  draft(taskId: string): { text: string; attachments: DraftAttachment[] } | undefined;
  /** An input method composition is in progress in that task's composer. */
  composing(taskId: string): boolean;
  /** Replace the text of the draft: one step of the user's undo history where the composer is shown. */
  replace(taskId: string, text: string): void;
  /** Insert text at the caret (or the end), one undo step. */
  insert(taskId: string, text: string): void;
  /** Draw (or with an empty text clear) a package's ghost text on the task's composer. */
  ghost(taskId: string, owner: string, text: string): void;
  attach(taskId: string, path: string): Promise<DraftAttachment>;
  detach(taskId: string, attachmentId: string): boolean;
  attachment(taskId: string, attachmentId: string): { name: string; mime: string; path?: string; text?: string } | undefined;
};
export type Round = { id: string; owner: string; phase: 'resolve' | 'apply' | 'attachment'; op?: OpName; windowId?: string; taskId?: string; text?: string; path?: string; attachmentId?: string; revision?: number; revisionAtResolve?: number };
const no = (code: string): Answer => ({ ok: false, code });

/** Codes for the text of a failed attach. Nothing of the text reaches the package. */
export function attachCode(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  if (text.includes('already attached')) return 'Conflict';
  if (/attach up to/.test(text)) return 'LimitExceeded';
  if (/does not accept images|reopen this settled|start a task/.test(text)) return 'UnsupportedCapability';
  if (/not found|no such|does not exist|cannot find|unavailable/.test(text)) return 'NotFound';
  return 'HostUnavailable';
}

/** Answers one round the host sent. `resolve` changes nothing; `apply` re-reads the draft and the window and refuses with
 * `StaleContext` when the revision or the task the window shows moved on, and with `Busy` while an input method composes. */
export async function answerRound(host: WindowHost, round: Round): Promise<Answer> {
  if (round.phase === 'attachment') {
    const found = round.taskId && round.attachmentId ? host.attachment(round.taskId, round.attachmentId) : undefined;
    return found ? { ok: true, name: found.name, mime: found.mime, ...(found.path ? { path: found.path } : {}), ...(found.text !== undefined ? { text: found.text } : {}) } : no('NotFound');
  }
  const taskId = round.windowId !== undefined ? (round.windowId === host.windowId() ? host.shown() : null) : round.taskId ?? null;
  const draft = taskId ? host.draft(taskId) : undefined;
  const project = taskId ? host.project(taskId) : undefined;
  if (!taskId || !draft || !project) return no('NotFound');
  if (round.phase === 'resolve') return { ok: true, taskId, projectId: project, revision: revisionOf(draft.text, draft.attachments), text: draft.text, attachments: draft.attachments };
  // apply: the window must still show the task the call resolved, and the call must be about that task.
  if (round.windowId !== undefined && (host.shown() !== round.taskId || taskId !== round.taskId)) return no('StaleContext');
  if (round.taskId !== undefined && taskId !== round.taskId) return no('StaleContext');
  if (round.op === 'detach') {
    if (!round.attachmentId || !host.detach(taskId, round.attachmentId)) return no('NotFound');
    return { ok: true };
  }
  if (host.composing(taskId)) return no('Busy');
  if (round.op === 'set' && round.revision !== undefined && round.revision !== revisionOf(draft.text, draft.attachments)) return no('StaleContext');
  switch (round.op) {
    case 'set': host.replace(taskId, round.text ?? ''); return { ok: true };
    case 'insert': host.insert(taskId, round.text ?? ''); return { ok: true };
    case 'suggest': host.ghost(taskId, round.owner, round.text ?? ''); return { ok: true };
    case 'attach': {
      if (!round.path) return no('InvalidShape');
      try { const added = await host.attach(taskId, round.path); return { ok: true, id: added.id }; } catch (error) { return no(attachCode(error)); }
    }
    default: return no('InvalidShape');
  }
}

// ---- The composer (DOM) ------------------------------------------------------------------------------------------------

/** What the app supplies to the composer half. */
export type ComposerDeps = {
  windowId: string;
  shown: () => string | null;
  project: (taskId: string) => string | undefined;
  /** The stored draft of a task that is not on screen (`state.drafts`). */
  stored: (taskId: string) => string | undefined;
  store: (taskId: string, text: string) => void;
  attachments: (taskId: string) => DraftAttachment[];
  attach: (taskId: string, path: string) => Promise<DraftAttachment>;
  detach: (taskId: string, attachmentId: string) => boolean;
  attachment: (taskId: string, attachmentId: string) => { name: string; mime: string; path?: string; text?: string } | undefined;
};

type ShownGhost = { taskId: string; owner: string; project: string; text: string; node: HTMLElement };
let mounted = false;
let composing = false;

const promptOf = (taskId: string): HTMLTextAreaElement | null => {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  return prompt && prompt.dataset.sessionId === taskId && !prompt.disabled ? prompt : null;
};

/** Writes into the live prompt as the user's own typing would: one step of the browser's undo history. The focus the user had
 * is given back. */
function typeInto(prompt: HTMLTextAreaElement, text: string, replaceAll: boolean): void {
  const active = document.activeElement as HTMLElement | null;
  const before = prompt.value;
  prompt.focus({ preventScroll: true });
  if (replaceAll) prompt.select(); else if (active !== prompt) prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  let done = false;
  try { done = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text); } catch { done = false; }
  const wanted = replaceAll ? text : null;
  if ((wanted !== null && prompt.value !== wanted) || (wanted === null && !done && prompt.value === before && text !== '')) {
    if (wanted !== null) prompt.value = wanted; else prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (active && active !== prompt && active.isConnected) active.focus({ preventScroll: true });
}

/** Mounts the window half: answers every round the host sends, draws ghost text, and clears it when it would go stale. */
export async function mountRuntimeDrafts(deps: ComposerDeps): Promise<void> {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const { call, subscribe, preview } = await import('../bridge');
  const { isImeKey } = await import('../dom');
  let ghost: ShownGhost | null = null;
  const clear = () => { ghost?.node.remove(); ghost = null; };
  const host: WindowHost = {
    windowId: () => deps.windowId,
    shown: deps.shown,
    project: deps.project,
    draft: taskId => {
      const text = promptOf(taskId)?.value ?? deps.stored(taskId);
      const project = deps.project(taskId);
      return text === undefined && project === undefined ? undefined : { text: text ?? '', attachments: deps.attachments(taskId) };
    },
    composing: taskId => composing && promptOf(taskId) !== null,
    replace: (taskId, text) => { const prompt = promptOf(taskId); if (prompt) typeInto(prompt, text, true); else deps.store(taskId, text); },
    insert: (taskId, text) => {
      const prompt = promptOf(taskId);
      if (prompt) {
        const at = document.activeElement === prompt ? prompt.selectionStart : prompt.value.length;
        const before = prompt.value.slice(0, at);
        typeInto(prompt, (before && !/\s$/.test(before) ? (text.includes('\n') ? '\n' : ' ') : '') + text, false);
      } else { const current = deps.stored(taskId) ?? ''; deps.store(taskId, current + (current && !/\s$/.test(current) ? (text.includes('\n') ? '\n' : ' ') : '') + text); }
    },
    ghost: (taskId, owner, text) => {
      clear();
      const prompt = promptOf(taskId), project = deps.project(taskId);
      if (!prompt || !project || text === '') return;
      const node = document.createElement('div');
      node.className = 'runtime-draft-ghost'; node.dataset.draftOwner = owner; node.setAttribute('aria-hidden', 'true');
      node.title = 'Suggestion from an extension. Tab accepts it; typing dismisses it.';
      node.style.cssText = 'padding:2px 10px;opacity:.6;font-style:italic;white-space:pre-wrap;max-height:4.5em;overflow:hidden;pointer-events:none';
      node.textContent = text;
      prompt.before(node);
      ghost = { taskId, owner, project, text, node };
    },
    attach: deps.attach, detach: deps.detach, attachment: deps.attachment,
  };
  const answer = async (round: Round) => {
    let reply: Answer;
    try { reply = await answerRound(host, round); } catch { reply = no('HostUnavailable'); }
    try { await call('extensions_runtime_draft_answer', { id: round.id, answer: reply }); } catch { /* the call timed out or ended: nothing waits */ }
    return reply;
  };
  // Input method compositions are never interrupted: a call that would edit during one answers `Busy`.
  document.addEventListener('compositionstart', event => { if ((event.target as HTMLElement | null)?.id === 'prompt') composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);
  // The user's typing dismisses a suggestion; the Tab key accepts it as draft text (never sends).
  document.addEventListener('input', event => { if (ghost && (event.target as HTMLElement | null)?.id === 'prompt') clear(); }, true);
  document.addEventListener('keydown', event => {
    if (!ghost || event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || isImeKey(event)) return;
    const prompt = event.target as HTMLTextAreaElement | null;
    if (prompt?.id !== 'prompt' || prompt.dataset.sessionId !== ghost.taskId || prompt.selectionStart !== prompt.value.length) return;
    event.preventDefault();
    const text = ghost.text; clear();
    typeInto(prompt, text, false);
  }, true);
  // Switching the task the composer shows, or redrawing it for another task, leaves no ghost text behind.
  const guard = () => { if (ghost && (!ghost.node.isConnected || promptOf(ghost.taskId) === null || deps.shown() !== ghost.taskId)) clear(); };
  const area = document.querySelector('#composer-area');
  if (area) new MutationObserver(guard).observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-session-id'] });
  const sweep = async () => {
    if (!ghost) return;
    let allowedNow = false;
    try { allowedNow = (await call<boolean[]>('extensions_runtime_draft_allowed', { ghosts: [{ owner: ghost.owner, project: ghost.project }] }))[0] === true; } catch { allowedNow = false; }
    if (!allowedNow) clear();
  };
  if (preview) (window as unknown as Record<string, unknown>).__runtimeDraft = { round: answer, ghost: () => (ghost ? { taskId: ghost.taskId, owner: ghost.owner, text: ghost.text } : null), clear };
  try { await subscribe('extensions-runtime-draft', event => { void answer(event as Round); }); } catch { /* no events */ }
  try { await subscribe('extensions-runtime-draft-end', event => { if (ghost && ghost.owner === (event as { owner?: string }).owner) clear(); }); } catch { /* no events */ }
  try { await subscribe('extensions-runtime-draft-sweep', () => { void sweep(); }); } catch { /* no events */ }
}

/** Test seam: forget the mounted flag so a spec can mount the window half again. */
export function resetRuntimeDrafts(): void { mounted = false; composing = false; }
