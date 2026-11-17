// Webview and preview twin of src-tauri/src/extensions/runtime_new_file_templates.rs (runtime phase R9, slice R0903):
// `contributes.newFiles` (the rules contracts.ts applies after the schema, in the same order as the native `check`),
// the creation of a templated file through the host (checks first, then a create-new write, then the host buffer and
// the chosen editor of R0901), and the editor choice of `panda.ui.reveal({ projectId, path, editor })` for a file.
// The user's choice at creation wins over the item's declared editor, which wins over the normal selection; an editor
// that is gone, disabled, not granted or that does not handle the file type is an explicit `NotFound`/`editor`, never
// a guess. Every refusal happens before the first write, an existing file is never overwritten, and a granted package
// is never asked per action (ADR-0005): the refusals protect existing files and unsaved work.
import { BUILTIN, DocumentEditors, extensionOf, MAX_BYTES_BYTES, MAX_TEXT_BYTES, MAX_TITLE, PERMISSION, validExtension, type Content, type Mount, type Placement } from './runtime-document-editors.ts';
import type { Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The grant `panda.ui.reveal` needs from its caller (R0206). */
export const DYNAMIC = 'ui.dynamic';
export const MAX_NEW_FILES = 16;
export const MAX_TEMPLATE_PATH = 256;
export const MAX_PATH = 512;
const MAX_AUDIT = 4_096;
const AT = 'contributes/newFiles' as const;

// ---- Declarations ----------------------------------------------------------------------------------------------------

export interface NewFileDecl { id: string; title: string; extension: string; template: string; editor?: string }
export interface Refusal { code: string; at: typeof AT | 'permissions'; ids: string[] }
const refuse = (code: string, at: Refusal['at'], id: string) => ({ ok: false as const, refusal: { code, at, ids: [id] } });

const reserved = (segment: string) => {
  const stem = segment.split('.')[0].toUpperCase();
  return ['CON', 'PRN', 'AUX', 'NUL'].includes(stem) || /^(COM|LPT)[1-9]$/.test(stem);
};
/**
 * A relative path with `/` separators that cannot leave its root on any platform: no `..`, no empty or `.` segment, no
 * drive letter, backslash, NUL, reserved Windows name or segment ending in a space or a dot.
 */
export function validRelative(path: string, max: number): boolean {
  if (!path || new TextEncoder().encode(path).length > max || /[\\\0]/.test(path) || path.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.endsWith(' ') && !segment.endsWith('.')
    && !/[<>:"|?*]/.test(segment) && !/[\u0000-\u001f\u007f-\u009f]/.test(segment) && !reserved(segment));
}

/** The rules after the schema; answers the declarations, or the first refusal. */
export function checkNewFileDeclarations(manifest: Json): { ok: true; items: NewFileDecl[] } | { ok: false; refusal: Refusal } {
  const root = object(manifest) ? manifest : {};
  const contributes = object(root.contributes) ? root.contributes : {};
  const list = Array.isArray(contributes.newFiles) ? contributes.newFiles : [];
  if (!list.length) return { ok: true, items: [] };
  const pkg = typeof root.id === 'string' ? root.id : '';
  if (list.length > MAX_NEW_FILES) return refuse('LimitExceeded', AT, pkg);
  const runtime = object(root.runtime) ? root.runtime : {};
  const files = Array.isArray(runtime.files) ? runtime.files.filter((file): file is string => typeof file === 'string') : [];
  const permissions = new Set(Array.isArray(root.permissions) ? root.permissions.filter((item): item is string => typeof item === 'string') : []);
  const editors = new Map<string, string[]>();
  for (const raw of Array.isArray(contributes.editors) ? contributes.editors : []) {
    if (object(raw) && typeof raw.id === 'string') editors.set(raw.id, Array.isArray(raw.extensions) ? raw.extensions.filter((item): item is string => typeof item === 'string') : []);
  }
  const ids = new Set<string>(); const items: NewFileDecl[] = [];
  for (const raw of list) {
    const item = object(raw) ? raw : {};
    const id = typeof item.id === 'string' ? item.id : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', AT, id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', AT, id);
    if (ids.has(id)) return refuse('DuplicateId', AT, id);
    ids.add(id);
    const title = item.title;
    if (typeof title !== 'string' || !title.trim() || [...title].length > MAX_TITLE) return refuse('InvalidShape', AT, id);
    const extension = item.extension;
    if (typeof extension !== 'string' || !validExtension(extension)) return refuse('InvalidShape', AT, id);
    const template = item.template;
    if (typeof template !== 'string' || !validRelative(template, MAX_TEMPLATE_PATH)) return refuse('InvalidShape', AT, id);
    if (!template.includes('/') || !files.includes(template.split('/')[0])) return refuse('UnknownReference', AT, id);
    let editor: string | undefined;
    if (item.editor !== undefined) {
      if (typeof item.editor !== 'string') return refuse('InvalidShape', AT, id);
      if (!editors.get(item.editor)?.includes(extension)) return refuse('UnknownReference', AT, id);
      editor = item.editor;
    }
    items.push({ id, title, extension, template, ...(editor ? { editor } : {}) });
  }
  if (!permissions.has(PERMISSION)) return refuse('PermissionDenied', 'permissions', pkg);
  return { ok: true, items };
}

/**
 * The path a new file gets: `raw` (trimmed) must be a safe relative path; the declared extension is appended when the
 * name has none and kept when it matches (any case); a different extension is refused.
 */
export function targetPath(raw: string, extension: string): { ok: true; path: string } | { ok: false; code: 'InvalidShape' } {
  const path = raw.trim();
  if (!validRelative(path, MAX_PATH)) return { ok: false, code: 'InvalidShape' };
  const found = extensionOf(path);
  if (!found) { const joined = `${path}${extension}`; return validRelative(joined, MAX_PATH) ? { ok: true, path: joined } : { ok: false, code: 'InvalidShape' }; }
  return found === extension ? { ok: true, path } : { ok: false, code: 'InvalidShape' };
}

// ---- The host's seams ------------------------------------------------------------------------------------------------

export interface Entry { owner: string; version: string; packageName: string; items: NewFileDecl[] }
/** The project's files, owned by the host. */
export interface Project {
  /** The project is still open and known (a closed or removed one is stale). */
  known(projectId: string): boolean;
  /** Creates `path` only if it does not exist; `Conflict` when it does, `StaleContext` when the project went away. */
  createNew(projectId: string, path: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; code: 'Conflict' | 'StaleContext' | 'HostUnavailable' }>;
  read(projectId: string, path: string): Promise<{ ok: true; bytes: Uint8Array; readOnly: boolean } | { ok: false; code: 'NotFound' | 'StaleContext' | 'HostUnavailable' }>;
}
export interface Env {
  source: () => Entry[];
  holds: (owner: string, version: string, permission: string, project: string | null) => boolean;
  /** Does the package hold `ui.dynamic` now? */
  dynamic: (owner: string) => boolean;
  /** The bytes of a file of the package archive, or `undefined` when it is not there. */
  template: (owner: string, version: string, path: string) => Uint8Array | undefined;
  files: Project;
}

export type What = 'item' | 'project' | 'grant' | 'path' | 'editor' | 'template' | 'file' | 'request';
export type Code = 'PermissionDenied' | 'NotFound' | 'StaleContext' | 'InvalidShape' | 'LimitExceeded' | 'Conflict' | 'HostUnavailable';
export type Failure = { ok: false; code: Code; what: What };
const fail = (code: Code, what: What): Failure => ({ ok: false, code, what });

export interface Audit { action: 'new-file' | 'reveal'; owner: string | null; projectId: string; path: string; editor: string; bytes: number }
export interface Created { ok: true; projectId: string; path: string; item: string; owner: string | null; editor: string; reason: 'declared' | 'override' | 'selected'; bytes: number; mount: Mount }
export interface Opened { ok: true; projectId: string; path: string; owner: string | null; editor: string; reason: 'chosen' | 'selected'; mount: Mount }

const encoder = new TextEncoder();
/**
 * `text` is `true` for a text editor, `false` for a bytes editor and `undefined` for the built-in one, which shows UTF-8
 * as text and anything else as bytes. `code` is `InvalidShape` (text that is not UTF-8) or `LimitExceeded`.
 */
function contentFor(bytes: Uint8Array, text: boolean | undefined): { ok: true; content: Content } | { ok: false; code: 'InvalidShape' | 'LimitExceeded' } {
  let content: Content;
  if (text === false) content = { bytes };
  else {
    try { content = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { if (text === true) return { ok: false, code: 'InvalidShape' }; content = { bytes }; }
  }
  const size = 'text' in content ? encoder.encode(content.text).length : content.bytes.length;
  return size > ('text' in content ? MAX_TEXT_BYTES : MAX_BYTES_BYTES) ? { ok: false, code: 'LimitExceeded' } : { ok: true, content };
}
const sizeOf = (content: Content) => ('text' in content ? encoder.encode(content.text).length : content.bytes.length);

export class NewFiles {
  readonly audit: Audit[] = [];
  constructor(private readonly env: Env) {}
  private record(entry: Audit) { if (this.audit.length >= MAX_AUDIT) this.audit.splice(0, MAX_AUDIT / 2); this.audit.push(entry); }

  /** Which editor opens a file and how the choice was made. */
  private resolve(editors: DocumentEditors, projectId: string, path: string, wanted: { id: string; reason: 'declared' | 'override' | 'chosen' } | undefined):
    { ok: true; editor: string; reason: string; text: boolean | undefined } | Failure {
    if (wanted?.id === BUILTIN) return { ok: true, editor: BUILTIN, reason: wanted.reason, text: undefined };
    if (wanted) {
      const candidate = editors.candidates(projectId, path).find(item => item.editor.id === wanted.id);
      return candidate ? { ok: true, editor: candidate.editor.id, reason: wanted.reason, text: candidate.editor.encoding === 'text' } : fail('NotFound', 'editor');
    }
    const selection = editors.select(projectId, path);
    const candidate = editors.candidates(projectId, path).find(item => item.editor.id === selection.editor);
    return { ok: true, editor: selection.editor, reason: 'selected', text: candidate ? candidate.editor.encoding === 'text' : undefined };
  }

  /**
   * The items of the new-file menu for a project: packages that are enabled and hold `documents.editors` there, ordered
   * by package and id, each labelled with its package's name.
   */
  menu(projectId: string) {
    const rows: Array<{ id: string; owner: string; package: string; title: string; extension: string; editor: string | null }> = [];
    for (const entry of this.env.source()) {
      if (!this.env.holds(entry.owner, entry.version, PERMISSION, projectId)) continue;
      for (const item of entry.items) rows.push({ id: item.id, owner: entry.owner, package: entry.packageName, title: item.title, extension: item.extension, editor: item.editor ?? null });
    }
    return rows.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Creates the file of a menu item and opens it. `choice` is the user's editor for this file (an editor id or `builtin`);
   * it wins over the item's declared editor. Nothing is written unless every check passed.
   */
  async create(editors: DocumentEditors, projectId: string, itemId: string, name: string, choice?: string | null, placement: Placement = 'window'): Promise<Created | Failure> {
    const entries = this.env.source();
    const entry = entries.find(candidate => candidate.items.some(item => item.id === itemId));
    const decl = entry?.items.find(item => item.id === itemId);
    if (!entry || !decl) return fail('NotFound', 'item');
    if (!this.env.files.known(projectId)) return fail('StaleContext', 'project');
    if (!this.env.holds(entry.owner, entry.version, PERMISSION, projectId)) return fail('PermissionDenied', 'grant');
    const target = targetPath(name, decl.extension);
    if (!target.ok) return fail(target.code, 'path');
    const wanted = choice ? { id: choice, reason: 'override' as const } : decl.editor ? { id: decl.editor, reason: 'declared' as const } : undefined;
    const resolved = this.resolve(editors, projectId, target.path, wanted);
    if (!resolved.ok) return resolved;
    const bytes = this.env.template(entry.owner, entry.version, decl.template);
    if (!bytes) return fail('NotFound', 'template');
    const made = contentFor(bytes, resolved.text);
    if (!made.ok) return fail(made.code, 'template');
    const written = await this.env.files.createNew(projectId, target.path, 'text' in made.content ? encoder.encode(made.content.text) : made.content.bytes);
    if (!written.ok) return fail(written.code === 'Conflict' ? 'Conflict' : written.code === 'StaleContext' ? 'StaleContext' : 'HostUnavailable', written.code === 'StaleContext' ? 'project' : 'file');
    editors.open(projectId, target.path, made.content, { readOnly: false });
    const mounted = editors.mount(projectId, target.path, resolved.editor, placement);
    if (!mounted.ok) return fail(mounted.code as Code, 'editor');
    const bytesWritten = sizeOf(made.content);
    this.record({ action: 'new-file', owner: entry.owner, projectId, path: target.path, editor: mounted.mount.editor, bytes: bytesWritten });
    return { ok: true, projectId, path: target.path, item: itemId, owner: mounted.mount.owner, editor: mounted.mount.editor, reason: resolved.reason as Created['reason'], bytes: bytesWritten, mount: mounted.mount };
  }

  /**
   * `panda.ui.reveal({ projectId, path, editor })` for a file. `caller` is the package that asked (`null` for the host's
   * own navigation); its `ui.dynamic` grant is rechecked now. The file is read by the host and shares the buffer of any
   * window already showing it.
   */
  async reveal(editors: DocumentEditors, caller: string | null, projectId: string, path: string, editor?: string | null, placement: Placement = 'window'): Promise<Opened | Failure> {
    if (caller !== null && !this.env.dynamic(caller)) return fail('PermissionDenied', 'grant');
    if (!validRelative(path, MAX_PATH)) return fail('InvalidShape', 'path');
    if (!this.env.files.known(projectId)) return fail('StaleContext', 'project');
    const resolved = this.resolve(editors, projectId, path, editor ? { id: editor, reason: 'chosen' } : undefined);
    if (!resolved.ok) return resolved;
    let buffer = editors.buffer(projectId, path);
    if (!buffer) {
      const read = await this.env.files.read(projectId, path);
      if (!read.ok) return fail(read.code === 'NotFound' ? 'NotFound' : read.code === 'StaleContext' ? 'StaleContext' : 'HostUnavailable', read.code === 'StaleContext' ? 'project' : 'file');
      const made = contentFor(read.bytes, resolved.text);
      if (!made.ok) return fail(made.code, 'file');
      buffer = editors.open(projectId, path, made.content, { readOnly: read.readOnly });
    }
    // An editor that cannot show this content (a text editor over bytes, or the other way round) is named, not guessed.
    if (resolved.text !== undefined && (resolved.text ? 'text' : 'bytes') !== buffer.encoding) return fail('InvalidShape', 'editor');
    const mounted = editors.mount(projectId, path, resolved.editor, placement);
    if (!mounted.ok) return fail(mounted.code as Code, 'editor');
    const snapshot = buffer.snapshot().content;
    this.record({ action: 'reveal', owner: caller, projectId, path, editor: mounted.mount.editor, bytes: sizeOf(snapshot) });
    return { ok: true, projectId, path, owner: mounted.mount.owner, editor: mounted.mount.editor, reason: resolved.reason as Opened['reason'], mount: mounted.mount };
  }

  /**
   * The one entry the host's IPC and the rich channel delegate to: `{ op: 'menu', projectId }`,
   * `{ op: 'create', projectId, item, name, editor? }` and `{ op: 'reveal', projectId, path, editor? }`, answered as
   * `{ ok: true, ... }` or `{ ok: false, code, what }`. Grants are rechecked on every call.
   */
  async handle(editors: DocumentEditors, request: Json, caller: string | null = null): Promise<Obj> {
    const body = object(request) ? request : {};
    const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined);
    const placement: Placement = body.placement === 'inspector' ? 'inspector' : 'window';
    const projectId = text('projectId');
    if (projectId === undefined) return fail('InvalidShape', 'request');
    const strip = (result: Created | Opened | Failure): Obj => {
      if (!result.ok) return result;
      const { mount, ...rest } = result;
      return { ...rest, mount: mount.id, placement: mount.placement, failure: mount.failure ?? null } as Obj;
    };
    switch (body.op) {
      case 'menu': return { ok: true, items: this.menu(projectId) };
      case 'create': {
        const item = text('item'); const name = text('name');
        return item === undefined || name === undefined ? fail('InvalidShape', 'request') : strip(await this.create(editors, projectId, item, name, text('editor'), placement));
      }
      case 'reveal': {
        const path = text('path');
        return path === undefined ? fail('InvalidShape', 'request') : strip(await this.reveal(editors, caller, projectId, path, text('editor'), placement));
      }
      default: return fail('InvalidShape', 'request');
    }
  }
}
