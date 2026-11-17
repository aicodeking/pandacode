// Webview and preview twin of src-tauri/src/extensions/runtime_document_editors.rs (runtime phase R9, slice R0901):
// `contributes.editors` (the rules contracts.ts applies after the schema, in the same order as the native `check`),
// the choice of the editor for a file type (default, option, remembered "Open with", two defaults ask the user), the
// buffer the HOST owns for every open document (text up to 4 MiB, bytes up to 16 MiB, moved in chunks of at most
// 192 KiB), and the mounts of a file in the floating editor window or the inspector, all over that one buffer.
// Everything here is for predictability, fault isolation and not losing work (ADR-0005): a granted package is never
// asked per action; a failed or revoked panel leaves the buffer intact and the built-in editor takes over.
import type { Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const PERMISSION = 'documents.editors';
export const BUILTIN = 'builtin';
export const MAX_EDITORS = 16;
export const MAX_EXTENSIONS = 16;
export const MAX_TITLE = 80;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_BYTES_BYTES = 16 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;
export const WILL_SAVE_WAIT_MS = 1_000;
export const PRIORITIES = ['default', 'option'] as const;
export const ENCODINGS = ['text', 'bytes'] as const;
const AT = 'contributes/editors' as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- Declarations ----------------------------------------------------------------------------------------------------

export interface EditorDecl { id: string; title: string; extensions: string[]; priority: 'default' | 'option'; encoding: 'text' | 'bytes'; folder: string; entry: string }
export interface Refusal { code: string; at: typeof AT | 'permissions'; ids: string[] }
const refuse = (code: string, at: Refusal['at'], id: string) => ({ ok: false as const, refusal: { code, at, ids: [id] } });

/** `^[.][a-z0-9]{1,16}$`. */
export const validExtension = (extension: string) => /^[.][a-z0-9]{1,16}$/.test(extension);
/** The file type of `path`: its last extension, lower case, or `''`. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The rules after the schema; answers the declarations, or the first refusal. */
export function checkEditorDeclarations(manifest: Json): { ok: true; editors: EditorDecl[] } | { ok: false; refusal: Refusal } {
  const root = object(manifest) ? manifest : {};
  const contributes = object(root.contributes) ? root.contributes : {};
  const list = Array.isArray(contributes.editors) ? contributes.editors : [];
  if (!list.length) return { ok: true, editors: [] };
  const pkg = typeof root.id === 'string' ? root.id : '';
  if (list.length > MAX_EDITORS) return refuse('LimitExceeded', AT, pkg);
  const runtime = object(root.runtime) ? root.runtime : {};
  const files = Array.isArray(runtime.files) ? runtime.files.filter((file): file is string => typeof file === 'string') : [];
  const permissions = new Set(Array.isArray(root.permissions) ? root.permissions.filter((item): item is string => typeof item === 'string') : []);
  const ids = new Set<string>(); const editors: EditorDecl[] = [];
  for (const raw of list) {
    const editor = object(raw) ? raw : {};
    const id = typeof editor.id === 'string' ? editor.id : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', AT, id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', AT, id);
    if (ids.has(id)) return refuse('DuplicateId', AT, id);
    ids.add(id);
    const title = editor.title;
    if (typeof title !== 'string' || !title.trim() || [...title].length > MAX_TITLE) return refuse('InvalidShape', AT, id);
    const extensions = editor.extensions;
    if (!Array.isArray(extensions) || !extensions.length) return refuse('InvalidShape', AT, id);
    if (extensions.length > MAX_EXTENSIONS) return refuse('LimitExceeded', AT, id);
    if (extensions.some(extension => typeof extension !== 'string' || !validExtension(extension)) || new Set(extensions).size !== extensions.length) return refuse('InvalidShape', AT, id);
    let priority: EditorDecl['priority'] = 'option';
    if (editor.priority !== undefined) {
      if (typeof editor.priority !== 'string' || !(PRIORITIES as readonly string[]).includes(editor.priority)) return refuse('InvalidShape', AT, id);
      priority = editor.priority as EditorDecl['priority'];
    }
    let encoding: EditorDecl['encoding'] = 'text';
    if (editor.encoding !== undefined) {
      if (typeof editor.encoding !== 'string' || !(ENCODINGS as readonly string[]).includes(editor.encoding)) return refuse('InvalidShape', AT, id);
      encoding = editor.encoding as EditorDecl['encoding'];
    }
    const rich = editor.rich;
    if (!object(rich) || typeof rich.folder !== 'string' || typeof rich.entry !== 'string') return refuse('InvalidShape', AT, id);
    if (!files.includes(rich.folder)) return refuse('UnknownReference', AT, id);
    editors.push({ id, title, extensions: extensions as string[], priority, encoding, folder: rich.folder, entry: rich.entry });
  }
  if (!permissions.has(PERMISSION)) return refuse('PermissionDenied', 'permissions', pkg);
  return { ok: true, editors };
}

// ---- Which editor opens a file ---------------------------------------------------------------------------------------

export interface Entry { owner: string; version: string; packageName: string; editors: EditorDecl[] }
export interface Candidate { owner: string; version: string; packageName: string; editor: EditorDecl }
export interface Selection { editor: string; reason: 'remembered' | 'default' | 'conflict' | 'builtin'; options: string[]; ask?: string[] }

/** The editors of enabled, granted packages that handle `extension`, in a stable order (owner, then id). */
export function candidatesFor(entries: Entry[], extension: string, holds: (entry: Entry) => boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of entries) {
    if (!holds(entry)) continue;
    for (const editor of entry.editors) if (editor.extensions.includes(extension)) out.push({ owner: entry.owner, version: entry.version, packageName: entry.packageName, editor });
  }
  return out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.editor.id < b.editor.id ? -1 : a.editor.id > b.editor.id ? 1 : 0));
}

/**
 * The editor a file opens in. The user's remembered choice per file type wins (the built-in editor included); a
 * remembered editor that is gone or no longer granted is ignored. Otherwise one `default` editor opens the file, two
 * make the host ask once (`reason: 'conflict'`, meanwhile the built-in editor), and `option` editors are only offered.
 */
export function selectEditor(candidates: Candidate[], remembered?: string | null): Selection {
  const options = candidates.map(candidate => candidate.editor.id);
  if (remembered === BUILTIN) return { editor: BUILTIN, reason: 'remembered', options };
  if (remembered && options.includes(remembered)) return { editor: remembered, reason: 'remembered', options };
  const defaults = candidates.filter(candidate => candidate.editor.priority === 'default').map(candidate => candidate.editor.id);
  if (defaults.length === 1) return { editor: defaults[0], reason: 'default', options };
  if (defaults.length > 1) return { editor: BUILTIN, reason: 'conflict', options, ask: defaults };
  return { editor: BUILTIN, reason: 'builtin', options };
}

// ---- The wire form: chunks -------------------------------------------------------------------------------------------

export interface Chunk { schemaVersion: 1; transfer: string; revision: number; encoding: 'utf8' | 'base64'; offset: number; totalBytes: number; data: string; final: boolean }
export type Content = { text: string } | { bytes: Uint8Array };

const toBase64 = (bytes: Uint8Array) => { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };
const fromBase64 = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));
const utf8Length = (text: string) => encoder.encode(text).length;

/** A text document as JSON chunks of at most 192 KiB of UTF-8, each cut at a code point boundary. */
export function chunkText(text: string, transfer: string, revision: number, max = CHUNK_BYTES): Chunk[] {
  const totalBytes = utf8Length(text);
  const chunks: Chunk[] = []; let offset = 0; let current = ''; let size = 0;
  const flush = (final: boolean) => { chunks.push({ schemaVersion: 1, transfer, revision, encoding: 'utf8', offset, totalBytes, data: current, final }); offset += size; current = ''; size = 0; };
  for (const point of text) {
    const length = utf8Length(point);
    if (size + length > max) flush(false);
    current += point; size += length;
  }
  flush(true);
  return chunks;
}
/** A byte document as base64 chunks of at most 192 KiB of document bytes. */
export function chunkBytes(bytes: Uint8Array, transfer: string, revision: number, max = CHUNK_BYTES): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + max, bytes.length);
    chunks.push({ schemaVersion: 1, transfer, revision, encoding: 'base64', offset, totalBytes: bytes.length, data: toBase64(bytes.subarray(offset, end)), final: end >= bytes.length });
    offset = end;
  } while (offset < bytes.length);
  return chunks;
}
export const chunkContent = (content: Content, transfer: string, revision: number, max = CHUNK_BYTES) => ('text' in content ? chunkText(content.text, transfer, revision, max) : chunkBytes(content.bytes, transfer, revision, max));

export type AssemblerCode = 'InvalidShape' | 'LimitExceeded' | 'StaleContext';
export type Assembled = { ok: true; done: false } | { ok: true; done: true; content: Content } | { ok: false; code: AssemblerCode };

/** One side's transfer in progress: chunks in order, acted on only at `final: true` with every byte present. */
export class Assembler {
  private transfer: string | null = null;
  private expected = 0;
  private parts: Uint8Array[] = [];
  private received = 0;
  private readonly encoding: 'text' | 'bytes';
  private readonly hostRevision: () => number;
  constructor(encoding: 'text' | 'bytes', hostRevision: () => number) { this.encoding = encoding; this.hostRevision = hostRevision; }
  get open() { return this.transfer !== null; }
  /** The panel closed mid-transfer, or the host gave up: the partial assembly is gone. */
  discard() { this.transfer = null; this.parts = []; this.received = 0; this.expected = 0; }
  accept(chunk: Chunk): Assembled {
    const limit = this.encoding === 'text' ? MAX_TEXT_BYTES : MAX_BYTES_BYTES;
    if (chunk.schemaVersion !== 1 || typeof chunk.transfer !== 'string' || !chunk.transfer) return { ok: false, code: 'InvalidShape' };
    if (chunk.encoding !== (this.encoding === 'text' ? 'utf8' : 'base64')) return { ok: false, code: 'InvalidShape' };
    if (!Number.isInteger(chunk.offset) || !Number.isInteger(chunk.totalBytes) || chunk.offset < 0 || chunk.totalBytes < 0 || typeof chunk.data !== 'string' || typeof chunk.final !== 'boolean') return { ok: false, code: 'InvalidShape' };
    if (chunk.revision < this.hostRevision()) { this.discard(); return { ok: false, code: 'StaleContext' }; }
    if (this.transfer !== null && this.transfer !== chunk.transfer) { this.discard(); return { ok: false, code: 'StaleContext' }; }
    if (chunk.totalBytes > limit) { this.discard(); return { ok: false, code: 'LimitExceeded' }; }
    let data: Uint8Array;
    try { data = this.encoding === 'text' ? encoder.encode(chunk.data) : fromBase64(chunk.data); } catch { this.discard(); return { ok: false, code: 'InvalidShape' }; }
    if (data.length > CHUNK_BYTES) { this.discard(); return { ok: false, code: 'LimitExceeded' }; }
    if (this.transfer === null) {
      if (chunk.offset !== 0) return { ok: false, code: 'InvalidShape' };
      this.transfer = chunk.transfer; this.expected = chunk.totalBytes;
    } else if (chunk.offset !== this.received || chunk.totalBytes !== this.expected) { this.discard(); return { ok: false, code: 'InvalidShape' }; }
    this.parts.push(data); this.received += data.length;
    if (this.received > this.expected) { this.discard(); return { ok: false, code: 'InvalidShape' }; }
    if (!chunk.final) return { ok: true, done: false };
    if (this.received !== this.expected) { this.discard(); return { ok: false, code: 'InvalidShape' }; }
    const all = new Uint8Array(this.received); let at = 0;
    for (const part of this.parts) { all.set(part, at); at += part.length; }
    this.discard();
    return { ok: true, done: true, content: this.encoding === 'text' ? { text: decoder.decode(all) } : { bytes: all } };
  }
}

// ---- The host buffer -------------------------------------------------------------------------------------------------

const same = (a: Content, b: Content) => {
  if ('text' in a && 'text' in b) return a.text === b.text;
  if ('bytes' in a && 'bytes' in b) return a.bytes.length === b.bytes.length && a.bytes.every((byte, index) => byte === b.bytes[index]);
  return false;
};
const sizeOf = (content: Content) => ('text' in content ? utf8Length(content.text) : content.bytes.length);
const copy = (content: Content): Content => ('text' in content ? { text: content.text } : { bytes: content.bytes.slice() });

export type ReplaceReason = 'disk' | 'revert';
export type DiskOutcome = 'unchanged' | 'replaced' | 'conflict';
export type EditCode = 'ReadOnly' | 'InvalidShape' | 'LimitExceeded';

/** The text or bytes of one open file. The host owns it; panels and the built-in editor are views of it. */
export class HostBuffer {
  revision = 0;
  /** Edited since the last save or load. */
  dirty = false;
  /** The newer disk content that arrived while the buffer was dirty; nothing is lost until the user picks. */
  conflict: Content | null = null;
  private content: Content;
  private disk: Content;
  readonly projectId: string;
  readonly path: string;
  readonly encoding: 'text' | 'bytes';
  readOnly: boolean;
  constructor(projectId: string, path: string, encoding: 'text' | 'bytes', readOnly: boolean, disk: Content) {
    this.projectId = projectId;
    this.path = path;
    this.encoding = encoding;
    this.readOnly = readOnly;
    this.disk = copy(disk); this.content = copy(disk);
  }
  get limit() { return this.encoding === 'text' ? MAX_TEXT_BYTES : MAX_BYTES_BYTES; }
  snapshot(): { content: Content; revision: number } { return { content: copy(this.content), revision: this.revision }; }
  diskSnapshot(): Content { return copy(this.disk); }
  /** A whole replacement from a panel or the built-in editor; marks the document changed. */
  edit(next: Content): { ok: true; revision: number } | { ok: false; code: EditCode } {
    if (this.readOnly) return { ok: false, code: 'ReadOnly' };
    if (('text' in next) !== (this.encoding === 'text')) return { ok: false, code: 'InvalidShape' };
    if (sizeOf(next) > this.limit) return { ok: false, code: 'LimitExceeded' };
    if (same(next, this.content)) return { ok: true, revision: this.revision };
    this.content = copy(next); this.dirty = true; this.revision += 1;
    return { ok: true, revision: this.revision };
  }
  /** The file changed on disk: replaces an unchanged buffer, keeps (and flags) a changed one. */
  diskChanged(next: Content): DiskOutcome {
    if (same(next, this.disk)) return 'unchanged';
    if (this.dirty) { this.conflict = copy(next); return 'conflict'; }
    this.disk = copy(next); this.content = copy(next); this.revision += 1; this.conflict = null;
    return 'replaced';
  }
  /** Drops the unsaved edits and shows the disk content again. */
  revert(): number { this.content = copy(this.conflict ?? this.disk); if (this.conflict) this.disk = copy(this.conflict); this.conflict = null; this.dirty = false; this.revision += 1; return this.revision; }
  /** Conflict choice "keep mine": the buffer stays, the newer disk content becomes the baseline. */
  keepMine() { if (this.conflict) { this.disk = copy(this.conflict); this.conflict = null; } }
  /** Conflict choice "take disk": same as a revert. */
  takeDisk(): number { return this.revert(); }
  /** The host wrote the buffer to disk. */
  saved() { this.disk = copy(this.content); this.dirty = false; this.conflict = null; }
}

// ---- The registry: sessions and mounts -------------------------------------------------------------------------------

export type Placement = 'window' | 'inspector';
export type FailureReason = 'panel-failed' | 'grant-revoked' | 'editor-removed' | 'user';
export interface Mount { id: string; projectId: string; path: string; editor: string; owner: string | null; placement: Placement; failure?: FailureReason }
export interface Audit { action: string; owner: string | null; projectId: string; path: string; revision: number; bytes: number; detail?: string }
export type Code = 'PermissionDenied' | 'NotFound' | 'StaleContext' | 'InvalidShape' | 'LimitExceeded' | 'ReadOnly' | 'Conflict' | 'HostUnavailable';
export interface Replace { reason: ReplaceReason; revision: number; chunks: Chunk[] }
export interface Wiring {
  source: () => Entry[];
  holds: (owner: string, version: string, permission: string, project: string | null) => boolean;
  /** The host writes the file; the panel never does. */
  write: (projectId: string, path: string, content: Content) => Promise<boolean>;
}

const key = (projectId: string, path: string) => `${projectId}\u0000${path}`;

interface Session { buffer: HostBuffer; mounts: Map<string, Mount>; willSave: Map<string, Array<() => void | Promise<void>>> }

export class DocumentEditors {
  private readonly sessions = new Map<string, Session>();
  private readonly assemblers = new Map<string, Assembler>();
  private readonly remembered = new Map<string, string>();
  private counter = 0;
  readonly audit: Audit[] = [];
  /** Replacement events a mount's panel receives (the page callback `onDidReplace`), per mount id. */
  readonly replaced = new Map<string, Replace[]>();
  private readonly wiring: Wiring;
  constructor(wiring: Wiring) { this.wiring = wiring; }

  private record(action: string, owner: string | null, buffer: HostBuffer, bytes: number, detail?: string) {
    this.audit.push({ action, owner, projectId: buffer.projectId, path: buffer.path, revision: buffer.revision, bytes, ...(detail ? { detail } : {}) });
  }
  private entry(owner: string) { return this.wiring.source().find(candidate => candidate.owner === owner); }
  private granted(owner: string, project: string): boolean { const entry = this.entry(owner); return !!entry && this.wiring.holds(owner, entry.version, PERMISSION, project); }
  private find(mountId: string): { session: Session; mount: Mount } | undefined {
    for (const session of this.sessions.values()) { const mount = session.mounts.get(mountId); if (mount) return { session, mount }; }
    return undefined;
  }

  /** The editors that may open `path` now (grant checked now). */
  candidates(projectId: string, path: string): Candidate[] {
    return candidatesFor(this.wiring.source(), extensionOf(path), entry => this.wiring.holds(entry.owner, entry.version, PERMISSION, projectId));
  }
  /** `Open with`: the editor a file opens in, with the remembered choice applied. */
  select(projectId: string, path: string): Selection { return selectEditor(this.candidates(projectId, path), this.remembered.get(extensionOf(path))); }
  /** The user's choice per file type (one editor id, or `builtin`). A choice no candidate backs is refused. */
  remember(projectId: string, path: string, editor: string): { ok: true } | { ok: false; code: Code } {
    if (editor !== BUILTIN && !this.candidates(projectId, path).some(candidate => candidate.editor.id === editor)) return { ok: false, code: 'NotFound' };
    this.remembered.set(extensionOf(path), editor);
    return { ok: true };
  }
  rememberedFor(path: string) { return this.remembered.get(extensionOf(path)); }

  /** Opens (or finds) the host buffer of a file. A second open of the same file shares the buffer. */
  open(projectId: string, path: string, disk: Content, options: { readOnly?: boolean } = {}): HostBuffer {
    const existing = this.sessions.get(key(projectId, path));
    if (existing) return existing.buffer;
    const buffer = new HostBuffer(projectId, path, 'text' in disk ? 'text' : 'bytes', options.readOnly === true, disk);
    this.sessions.set(key(projectId, path), { buffer, mounts: new Map(), willSave: new Map() });
    return buffer;
  }
  buffer(projectId: string, path: string) { return this.sessions.get(key(projectId, path))?.buffer; }

  /** Mounts the selected editor in a window or the inspector. A refused grant gives the built-in editor over the same buffer. */
  mount(projectId: string, path: string, editor: string, placement: Placement = 'window'): { ok: true; mount: Mount } | { ok: false; code: Code } {
    const session = this.sessions.get(key(projectId, path));
    if (!session) return { ok: false, code: 'NotFound' };
    const id = `mount-${++this.counter}`;
    let owner: string | null = null; let chosen = BUILTIN; let failure: FailureReason | undefined;
    if (editor !== BUILTIN) {
      const candidate = this.candidates(projectId, path).find(item => item.editor.id === editor && item.editor.encoding === session.buffer.encoding);
      if (candidate) { owner = candidate.owner; chosen = editor; } else { const pkg = editor.split('/')[0]; failure = this.entry(pkg) && !this.granted(pkg, projectId) ? 'grant-revoked' : 'editor-removed'; }
    }
    const mount: Mount = { id, projectId, path, editor: chosen, owner, placement, ...(failure ? { failure } : {}) };
    session.mounts.set(id, mount);
    if (owner) this.assemblers.set(id, new Assembler(session.buffer.encoding, () => session.buffer.revision));
    this.record('mount', owner, session.buffer, 0, chosen);
    return { ok: true, mount };
  }
  /** Closes a mount (a closed window): any transfer in progress is discarded, the buffer stays. */
  unmount(mountId: string, keepSession = false) {
    const found = this.find(mountId);
    if (!found) return;
    this.assemblers.get(mountId)?.discard(); this.assemblers.delete(mountId);
    found.session.mounts.delete(mountId); found.session.willSave.delete(mountId);
    // The last view of a clean file lets go of the buffer; a changed one stays until it is saved or reverted.
    if (!keepSession && !found.session.mounts.size && !found.session.buffer.dirty) this.sessions.delete(key(found.mount.projectId, found.mount.path));
  }
  /** One click between the built-in editor and a package editor: the same buffer, the choice remembered. */
  switchTo(mountId: string, editor: string): { ok: true; mount: Mount } | { ok: false; code: Code } {
    const found = this.find(mountId);
    if (!found) return { ok: false, code: 'NotFound' };
    const { mount } = found;
    const remembered = this.remember(mount.projectId, mount.path, editor);
    if (!remembered.ok) return remembered;
    const placement = mount.placement;
    this.unmount(mountId, true);
    return this.mount(mount.projectId, mount.path, editor, placement);
  }

  /** What a panel receives from `pandaView.document.read()`: the whole buffer as chunks. The grant is checked now. */
  read(mountId: string): { ok: true; revision: number; encoding: 'text' | 'bytes'; readOnly: boolean; chunks: Chunk[] } | { ok: false; code: Code } {
    const found = this.panel(mountId);
    if (!found.ok) return found;
    const { session, mount } = found;
    const { content, revision } = session.buffer.snapshot();
    const chunks = chunkContent(content, `read-${mountId}-${revision}`, revision);
    this.record('read', mount.owner, session.buffer, sizeOf(content));
    return { ok: true, revision, encoding: session.buffer.encoding, readOnly: session.buffer.readOnly, chunks };
  }
  /** One chunk of `pandaView.document.edit(...)`. Applies the whole replacement at the final chunk. */
  edit(mountId: string, chunk: Chunk): { ok: true; done: boolean; revision?: number } | { ok: false; code: Code } {
    const found = this.panel(mountId);
    if (!found.ok) return found;
    const { session, mount } = found;
    if (session.buffer.readOnly) { this.assemblers.get(mountId)?.discard(); return { ok: false, code: 'ReadOnly' }; }
    const assembled = this.assemblers.get(mountId)!.accept(chunk);
    if (!assembled.ok) return { ok: false, code: assembled.code };
    if (!assembled.done) return { ok: true, done: false };
    const result = session.buffer.edit(assembled.content);
    if (!result.ok) return { ok: false, code: result.code };
    this.record('edit', mount.owner, session.buffer, sizeOf(assembled.content));
    return { ok: true, done: true, revision: result.revision };
  }
  /** A whole edit from the built-in editor (no wire): the same buffer, so every other view follows. */
  editBuiltin(projectId: string, path: string, content: Content) {
    const session = this.sessions.get(key(projectId, path));
    if (!session) return { ok: false as const, code: 'NotFound' as Code };
    const result = session.buffer.edit(content);
    if (result.ok) this.record('edit', null, session.buffer, sizeOf(content), 'builtin');
    return result;
  }
  /** The panel closed mid-transfer: the partial assembly is gone and the buffer is unchanged. */
  abortTransfer(mountId: string) { this.assemblers.get(mountId)?.discard(); }

  /** `onWillSave(callback)`: the host waits up to 1 s for each callback before it saves. */
  onWillSave(mountId: string, callback: () => void | Promise<void>) {
    const found = this.find(mountId);
    if (!found) return;
    const list = found.session.willSave.get(mountId) ?? [];
    list.push(callback); found.session.willSave.set(mountId, list);
  }
  /** The user's save, or `document.save()`: the host delivers pending edits, then writes the buffer itself. */
  async save(projectId: string, path: string, trigger: 'user' | 'package' = 'user'): Promise<{ ok: true; revision: number } | { ok: false; code: Code }> {
    const session = this.sessions.get(key(projectId, path));
    if (!session) return { ok: false, code: 'NotFound' };
    const buffer = session.buffer;
    if (buffer.readOnly) return { ok: false, code: 'ReadOnly' };
    for (const callbacks of session.willSave.values()) for (const callback of callbacks) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<void>(resolve => { timer = setTimeout(resolve, WILL_SAVE_WAIT_MS); });
      try { await Promise.race([Promise.resolve().then(callback), wait]); } catch { /* a failing panel never blocks the save */ } finally { if (timer) clearTimeout(timer); }
    }
    if (buffer.conflict) return { ok: false, code: 'Conflict' };
    const { content, revision } = buffer.snapshot();
    if (!await this.wiring.write(projectId, path, content)) return { ok: false, code: 'HostUnavailable' };
    // Edits that arrived while the write was in flight stay dirty.
    if (buffer.revision === revision) buffer.saved();
    this.record('save', null, buffer, sizeOf(content), trigger);
    return { ok: true, revision };
  }
  /** `pandaView.document.save()` of a panel: the grant is checked now. */
  async saveFromPanel(mountId: string) {
    const found = this.panel(mountId);
    if (!found.ok) return found;
    return this.save(found.mount.projectId, found.mount.path, 'package');
  }

  /** The file changed on disk. An unchanged buffer is replaced and each package mount hears `onDidReplace`. */
  diskChanged(projectId: string, path: string, next: Content): DiskOutcome {
    const session = this.sessions.get(key(projectId, path));
    if (!session) return 'unchanged';
    const outcome = session.buffer.diskChanged(next);
    if (outcome === 'replaced') this.broadcast(session, 'disk');
    if (outcome === 'conflict') this.record('conflict', null, session.buffer, sizeOf(next));
    return outcome;
  }
  /** Revert: the unsaved edits are dropped on purpose; the mounts hear the replacement with `reason: 'revert'`. */
  revert(projectId: string, path: string): { ok: true; revision: number } | { ok: false; code: Code } {
    const session = this.sessions.get(key(projectId, path));
    if (!session) return { ok: false, code: 'NotFound' };
    session.buffer.revert();
    this.broadcast(session, 'revert');
    return { ok: true, revision: session.buffer.revision };
  }
  /** Conflict choices: `keep` leaves the buffer as it is (the next save overwrites the disk), `disk` takes the disk content. */
  resolveConflict(projectId: string, path: string, choice: 'keep' | 'disk'): { ok: true } | { ok: false; code: Code } {
    const session = this.sessions.get(key(projectId, path));
    if (!session || !session.buffer.conflict) return { ok: false, code: 'NotFound' };
    if (choice === 'keep') session.buffer.keepMine();
    else { session.buffer.takeDisk(); this.broadcast(session, 'disk'); }
    return { ok: true };
  }
  private broadcast(session: Session, reason: ReplaceReason) {
    const { content, revision } = session.buffer.snapshot();
    for (const mount of session.mounts.values()) {
      if (!mount.owner || mount.failure) continue;
      this.assemblers.get(mount.id)?.discard();
      const list = this.replaced.get(mount.id) ?? [];
      list.push({ reason, revision, chunks: chunkContent(content, `replace-${mount.id}-${revision}`, revision) });
      this.replaced.set(mount.id, list);
    }
    this.record('replace', null, session.buffer, sizeOf(content), reason);
  }

  /** The panel failed (crashed, hung, closed badly): the buffer is untouched and a built-in mount takes its place. */
  panelFailed(mountId: string, reason: FailureReason = 'panel-failed'): { ok: true; mount: Mount } | { ok: false; code: Code } {
    return this.fallBack(mountId, reason);
  }
  /** A grant was revoked or narrowed: every mount of `owner` that no longer holds it falls back to the built-in editor. */
  grantsChanged(): Mount[] {
    const fallbacks: Mount[] = [];
    for (const session of this.sessions.values()) for (const mount of [...session.mounts.values()]) {
      if (!mount.owner || mount.failure) continue;
      if (!this.granted(mount.owner, mount.projectId)) { const result = this.fallBack(mount.id, 'grant-revoked'); if (result.ok) fallbacks.push(result.mount); }
    }
    return fallbacks;
  }
  private fallBack(mountId: string, reason: FailureReason): { ok: true; mount: Mount } | { ok: false; code: Code } {
    const found = this.find(mountId);
    if (!found) return { ok: false, code: 'NotFound' };
    const { session, mount } = found;
    this.assemblers.get(mountId)?.discard(); this.assemblers.delete(mountId);
    session.willSave.delete(mountId); session.mounts.delete(mountId);
    const id = `mount-${++this.counter}`;
    const builtin: Mount = { id, projectId: mount.projectId, path: mount.path, editor: BUILTIN, owner: null, placement: mount.placement, failure: reason };
    session.mounts.set(id, builtin);
    this.record('fallback', mount.owner, session.buffer, 0, reason);
    return { ok: true, mount: builtin };
  }
  private panel(mountId: string): { ok: true; session: Session; mount: Mount } | { ok: false; code: Code } {
    const found = this.find(mountId);
    if (!found || !found.mount.owner || found.mount.failure) return { ok: false, code: 'NotFound' };
    if (!this.granted(found.mount.owner, found.mount.projectId)) { this.fallBack(mountId, 'grant-revoked'); return { ok: false, code: 'PermissionDenied' }; }
    return { ok: true, ...found };
  }
  /**
   * The one entry the rich channel delegates `pandaView.document` to: `{ op: 'read' }`, `{ op: 'edit', chunk }` and
   * `{ op: 'save' }` of the panel behind `mountId`, answered as `{ ok: true, ... }` or `{ ok: false, code }`.
   */
  async handle(mountId: string, request: { op?: string; chunk?: Chunk }): Promise<Obj> {
    switch (request.op) {
      case 'read': { const result = this.read(mountId); return result.ok ? { ...result } as unknown as Obj : { ok: false, code: result.code }; }
      case 'edit': { if (!request.chunk) return { ok: false, code: 'InvalidShape' }; const result = this.edit(mountId, request.chunk); return result.ok ? { ...result } as unknown as Obj : { ok: false, code: result.code }; }
      case 'save': { const result = await this.saveFromPanel(mountId); return result.ok ? { ok: true, revision: result.revision } : { ok: false, code: result.code }; }
      default: return { ok: false, code: 'InvalidShape' };
    }
  }
  /** The mounts of one file (window and inspector views of the same host buffer). */
  mounts(projectId: string, path: string): Mount[] { return [...(this.sessions.get(key(projectId, path))?.mounts.values() ?? [])]; }
}
