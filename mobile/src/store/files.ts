// Pure helpers for the computer hub, the file browser and the tools screens: paged downloads,
// paths, a cheap syntax colouring, the file editor's rules and the hub's rows. No React Native or network here, so
// tests/files.test.ts and tests/hub.test.ts run them in node.

/** One page of a chunked base64 download (files.image, progress.thumb, progress.media). */
export interface DataPage { mime: string; total: number; offset: number; data: string; done: boolean }

/** Largest image the phone assembles: the host's own limit is 8 MiB of bytes. */
export const MAX_DATA_CHARS = Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4;
const MIME = /^image\/[a-z0-9.+-]{1,40}$/;

function checkPage(page: DataPage, offset: number, mime: string | null): void {
  if (!page || typeof page.data !== 'string' || typeof page.mime !== 'string' || !MIME.test(page.mime)) throw new Error('Invalid image reply.');
  if (mime && page.mime !== mime) throw new Error('The image changed while loading.');
  if (page.offset !== offset || !Number.isSafeInteger(page.total) || page.total > MAX_DATA_CHARS) throw new Error('Invalid image reply.');
  if (!page.data.length && !page.done) throw new Error('The image download made no progress.');
}

/** Fetches every page from offset 0 and returns a `data:` URL. */
export async function assembleData(fetchPage: (offset: number) => Promise<DataPage>): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  let mime: string | null = null;
  for (;;) {
    const page = await fetchPage(offset);
    checkPage(page, offset, mime);
    mime = page.mime;
    parts.push(page.data);
    offset += page.data.length;
    if (offset > page.total) throw new Error('Invalid image length.');
    if (page.done) {
      if (offset !== page.total) throw new Error('Invalid image length.');
      return `data:${mime};base64,${parts.join('')}`;
    }
  }
}

/** What files.read answers: a page of text, or why there is none. */
export type FilePage =
  | { kind: 'text'; path: string; text: string; offset: number; total: number; done: boolean; /** The whole file's version; older hosts send none. */ hash?: string }
  | { kind: 'image'; path: string }
  | { kind: 'binary' | 'tooLarge'; path: string; message: string };

export interface LoadedText { text: string; bytes: number; total: number; done: boolean; hash?: string }

/** Appends a text page to what is loaded; the page must start where the text ends (bytes) and be the same version. */
export function appendPage(loaded: { text: string; bytes: number; hash?: string } | null, page: Extract<FilePage, { kind: 'text' }>): LoadedText {
  const before = loaded ?? { text: '', bytes: 0, hash: page.hash };
  if (page.offset !== before.bytes || page.hash !== before.hash) throw new Error('The file changed while loading. Pull to reload.');
  return { text: before.text + page.text, bytes: before.bytes + utf8Length(page.text), total: page.total, done: page.done, ...(page.hash ? { hash: page.hash } : {}) };
}

// ---- editing (files.write) ----

/** Largest file the phone edits, in UTF-8 bytes: the host's own files.write limit. */
export const EDIT_LIMIT = 64 * 1024;
/** How the host's files.write error for a stale base starts (WRITE_CONFLICT in files.rs). */
export const WRITE_CONFLICT = 'Changed on the computer';

/** Whether loaded text can be edited: all of it is in, it has a version and fits the limit. */
export const canEdit = (loaded: LoadedText | null): loaded is LoadedText & { hash: string } =>
  !!loaded && loaded.done && typeof loaded.hash === 'string' && loaded.hash.length > 0 && loaded.total <= EDIT_LIMIT;

/** Why a draft can't be saved, or null when it can. */
export function draftProblem(draft: string): string | null {
  if (draft.includes('\0')) return 'Only text can be saved.';
  if (utf8Length(draft) > EDIT_LIMIT) return `The file can be at most ${bytesLabel(EDIT_LIMIT)} to save from the phone.`;
  return null;
}

export const isWriteConflict = (error: unknown) => error instanceof Error && error.message.startsWith(WRITE_CONFLICT);

/** The editor's state: viewing, or a draft over the version it started from. */
export type EditState =
  | { mode: 'view' }
  | { mode: 'edit'; base: string; original: string; draft: string; saving: boolean; conflict: boolean };

export const startEdit = (loaded: LoadedText & { hash: string }): EditState =>
  ({ mode: 'edit', base: loaded.hash, original: loaded.text, draft: loaded.text, saving: false, conflict: false });

export const isDirty = (edit: EditState) => edit.mode === 'edit' && edit.draft !== edit.original;

/** After a successful save the file on disk is the draft, at the host's new version. */
export const savedText = (draft: string, hash: string): LoadedText & { hash: string } =>
  ({ text: draft, bytes: utf8Length(draft), total: utf8Length(draft), done: true, hash });

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// ---- paths ----

export const fileName = (path: string) => path.split('/').filter(Boolean).pop() ?? '';
export const parentOf = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/');

/** The folders above and including `path`, for a breadcrumb: [{name, path}], the root first. */
export function crumbs(path: string, rootName: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return [{ name: rootName, path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

/** The header title for a folder: its name, or the project's at the root. */
export const folderTitle = (path: string, rootName: string) => fileName(path) || rootName;

export interface FileIcon { ios: string; android: string }

const ICONS: readonly [RegExp, FileIcon][] = [
  [/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i, { ios: 'photo', android: 'image' }],
  [/\.(md|mdx|txt|rst)$/i, { ios: 'doc.text', android: 'description' }],
  [/\.(json|ya?ml|toml|lock|ini|env)$/i, { ios: 'gearshape', android: 'settings' }],
  [/\.(pdf|docx?|xlsx?)$/i, { ios: 'doc.richtext', android: 'article' }],
  [/\.(sh|bash|zsh|ps1)$/i, { ios: 'terminal', android: 'terminal' }],
  [/\.[a-z0-9]+$/i, { ios: 'chevron.left.forwardslash.chevron.right', android: 'code' }],
];

export function fileIcon(name: string, dir: boolean): FileIcon {
  if (dir) return { ios: 'folder', android: 'folder' };
  return ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? { ios: 'doc', android: 'draft' };
}

export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);

// ---- a cheap syntax colouring ----

export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number';
export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set(('abstract as async await break case catch class const continue def default defer do elif else enum export extends false fn for from func function go '
  + 'if impl import in interface let loop match mod mut new nil none null package pub return self static struct super switch this throw true try type typeof undefined use var void where while with yield').split(' '));

/** Line comment prefix by extension, else none (the line still gets strings, numbers and keywords). */
export function commentPrefix(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  if (['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl'].includes(ext)) return '#';
  if (['sql', 'lua', 'hs'].includes(ext)) return '--';
  if (['md', 'txt', 'json', 'lock', 'csv', ''].includes(ext)) return null;
  return '//';
}

const TOKEN = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)/g;

/** One line split into coloured runs; long lines stay one plain run (cheap on a phone). */
export function tokenize(line: string, comment: string | null): Token[] {
  if (line.length > 400) return [{ kind: 'plain', text: line }];
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) tokens[tokens.length - 1] = { kind, text: last.text + text };
    else tokens.push({ kind, text });
  };
  let at = 0;
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    const before = line.slice(at, start);
    const commentAt = comment ? before.indexOf(comment) : -1;
    if (commentAt >= 0) {
      push('plain', before.slice(0, commentAt));
      push('comment', line.slice(at + commentAt));
      return tokens;
    }
    push('plain', before);
    const [text, string, number, word] = match;
    push(string ? 'string' : number ? 'number' : word && KEYWORDS.has(word) ? 'keyword' : 'plain', text);
    at = start + text.length;
  }
  const rest = line.slice(at);
  const commentAt = comment ? rest.indexOf(comment) : -1;
  if (commentAt >= 0) {
    push('plain', rest.slice(0, commentAt));
    push('comment', rest.slice(commentAt));
  } else push('plain', rest);
  return tokens;
}

/** Lines of loaded text; a trailing newline makes no empty last line. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

// ---- search ----

export interface GrepMatch { line: number; text: string; ranges: [number, number][] }
export interface GrepFile { path: string; matches: GrepMatch[] }

/** A match line split around its highlight ranges (UTF-16 offsets, as the host sends them). */
export function highlight(text: string, ranges: readonly (readonly [number, number])[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(at, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    if (from > at) out.push({ text: text.slice(at, from), hit: false });
    if (to > from) out.push({ text: text.slice(from, to), hit: true });
    at = to;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export const matchCount = (files: readonly GrepFile[]) => files.reduce((n, f) => n + f.matches.length, 0);

// ---- byte sizes ----

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
