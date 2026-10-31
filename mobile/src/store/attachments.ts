// Message attachments: the host's `attachments` rows (newer hosts), the context blocks a prompt
// carries, chunk assembly for task.attachment / task.workspaceImage, the on-disk cache index and
// Markdown image extraction. Pure: tests/attachments.test.ts covers it; the file and call work is
// in src/store/attachment-files.ts and src/connect/attachments.ts.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { attachments as chipsOf } from './turns.ts';

export type AttachmentKind = 'image' | 'document' | 'folder';
export type Variant = 'thumb' | 'full';
export interface Attachment { id: string; kind: AttachmentKind; name: string; mime?: string; bytes?: number; width?: number; height?: number }

const KINDS = new Set<string>(['image', 'document', 'folder']);
const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

/** The host's `attachments`, checked row by row; null when the message has none (older hosts). */
export function parseAttachments(raw: unknown): Attachment[] | null {
  if (!Array.isArray(raw)) return null;
  const list: Attachment[] = [];
  for (const a of raw.slice(0, 32)) {
    if (!a || typeof a.id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(a.id) || !KINDS.has(a.kind) || typeof a.name !== 'string') continue;
    list.push({
      id: a.id, kind: a.kind, name: a.name.slice(0, 300) || a.id,
      ...(typeof a.mime === 'string' ? { mime: a.mime.slice(0, 100) } : {}),
      ...(positive(a.bytes) ? { bytes: a.bytes } : {}),
      ...(positive(a.width) && positive(a.height) ? { width: a.width, height: a.height } : {}),
    });
  }
  return list;
}

/** A Document/Folder/File context block the prompt carries, by the name in its header. */
export interface ContextBlock { kind: string; name: string; text: string }

// A block runs to the next context header (CONTEXT_BOUNDARY in transcript.tsx and the desktop's main.ts).
const HEADER = /\n\n(?=(?:File|Document|Folder|GitHub|Browser element) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Response style \(PandaCode token saver)/;

export function contextBlocks(content: string): ContextBlock[] {
  return content.split(HEADER).slice(1).map(block => {
    const [chip] = chipsOf(`\n\n${block}`);
    return { kind: chip?.kind ?? '', name: chip?.name ?? '', text: block };
  }).filter(b => b.kind);
}

/** What a user bubble shows: images (from the host's rows) and chips with their context text. */
export interface BubbleAttachments {
  images: Attachment[];
  chips: { kind: string; name: string; text?: string }[];
}

const CHIP_KIND: Record<AttachmentKind, string> = { image: 'Attached image', document: 'Document context', folder: 'Folder context' };
const baseName = (name: string) => name.split('/').at(-1) || name;

/** Structured rows when the host sends them, else today's chips parsed from the content. */
export function bubbleAttachments(raw: unknown, content: string): BubbleAttachments {
  const blocks = contextBlocks(content);
  const textFor = (name: string, kinds: string[]) => blocks.find(b => kinds.includes(b.kind) && b.name === baseName(name))?.text;
  const rows = parseAttachments(raw);
  if (!rows) {
    return { images: [], chips: blocks.map(b => ({ kind: b.kind, name: b.name, ...(b.kind.startsWith('Attached') ? {} : { text: b.text }) })) };
  }
  const docs = rows.filter(a => a.kind !== 'image').map(a => ({ kind: CHIP_KIND[a.kind], name: baseName(a.name), text: textFor(a.name, a.kind === 'folder' ? ['Folder context'] : ['Document context', 'File context']) }));
  // Blocks the rows don't name stay chips: File context from @-mentions, and images saved before
  // the host kept attachment ids (those can never be fetched).
  const named = new Set(rows.map(a => baseName(a.name)));
  const extra = blocks.filter(b => !named.has(b.name)).map(b => ({ kind: b.kind, name: b.name, ...(b.kind.startsWith('Attached') ? {} : { text: b.text }) }));
  return { images: rows.filter(a => a.kind === 'image'), chips: [...docs, ...extra] };
}

// ---- Chunks ----

/** Largest attachment the phone downloads. */
export const MAX_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|heic|heif|bmp|tiff)$/;

/** Where a download stands: bytes written so far, and the total and type once the host said. */
export interface Progress { offset: number; total?: number; mime?: string }
export interface Chunk { mime: string; total: number; offset: number; data: string; done: boolean }

/** Decoded size of base64 text, or -1 when it isn't base64. */
export function base64Bytes(data: string): number {
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return -1;
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** Checks one reply against the download so far → the progress after writing its data. Throws on
 * anything that doesn't continue it (wrong offset, a changed total or type, too large, bad data). */
export function acceptChunk(at: Progress, reply: unknown): Progress & { data: string; done: boolean } {
  const c = reply as Partial<Chunk> | null;
  if (!c || typeof c.data !== 'string' || typeof c.mime !== 'string' || typeof c.total !== 'number' || typeof c.offset !== 'number') throw new Error('The computer sent an unreadable attachment.');
  if (!IMAGE_MIME.test(c.mime)) throw new Error('That attachment is not an image.');
  if (!Number.isSafeInteger(c.total) || c.total <= 0 || c.total > MAX_BYTES) throw new Error('That attachment is too large to show here.');
  if (c.offset !== at.offset) throw new Error('The attachment arrived out of order.');
  if ((at.total !== undefined && at.total !== c.total) || (at.mime !== undefined && at.mime !== c.mime)) throw new Error('The attachment changed while it downloaded.');
  const size = base64Bytes(c.data);
  if (size < 0) throw new Error('The computer sent an unreadable attachment.');
  const offset = at.offset + size;
  if (offset > c.total || (!size && !c.done)) throw new Error('The attachment arrived out of order.');
  const done = offset === c.total;
  if (c.done === true && !done) throw new Error('The attachment arrived incomplete.');
  return { offset, total: c.total, mime: c.mime, data: c.data, done };
}

// ---- Cache index ----

/** One cached file per device+session+attachment+variant. Workspace images use `ws:<path>` as the id. */
export const attachmentKey = (deviceId: string, sessionId: string, id: string, variant: Variant) => `${deviceId}/${sessionId}/${id}/${variant}`;
export const workspaceId = (path: string) => `ws:${path}`;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tiff' };
/** A file name that holds no ids; the extension lets the share sheet offer Save Image. */
export const blobName = (key: string, mime?: string) => `${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 32)}.${mime ? EXT[mime] ?? 'bin' : 'part'}`;

/** Every cached attachment together; the least recently used go first. */
export const ATTACHMENT_BYTES = 64 * 1024 * 1024;

export interface BlobEntry { file: string; at: number; bytes: number }
export type BlobIndex = Record<string, BlobEntry>;

export function parseBlobIndex(text: string | null): BlobIndex {
  let value: unknown;
  try { value = JSON.parse(text ?? '{}'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const index: BlobIndex = {};
  for (const [key, e] of Object.entries(value as Record<string, any>)) {
    if (e && typeof e.file === 'string' && /^[0-9a-f]{32}\.[a-z]{3,4}$/.test(e.file) && [e.at, e.bytes].every(Number.isFinite)) index[key] = { file: e.file, at: e.at, bytes: e.bytes };
  }
  return index;
}

// ---- Markdown images ----

export type ReplyPart = { kind: 'text'; text: string } | { kind: 'image'; alt: string; path: string };

const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const REMOTE = /^[a-z][a-z0-9+.-]*:/i;
const decoded = (path: string) => { try { return decodeURIComponent(path); } catch { return path; } };

/**
 * Splits a reply at its Markdown images (outside code). Workspace-relative paths become image
 * parts; anything with a scheme (http, data, file…) becomes a link, so the native renderer never
 * fetches it. Any image syntax left (reference style) is turned into a link too.
 */
export function replyParts(text: string): ReplyPart[] {
  if (!text.includes('![')) return [{ kind: 'text', text }];
  const parts: ReplyPart[] = [];
  let buffer = '';
  const flush = () => { if (buffer.trim()) parts.push({ kind: 'text', text: buffer }); buffer = ''; };
  // Fenced blocks stay as they are; inline code spans too.
  for (const [i, chunk] of text.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[^\n]*$|(?![\s\S])))/m).entries()) {
    if (i % 2) { buffer += chunk; continue; }
    for (const [j, piece] of chunk.split(/(`+[^`\n]*`+)/).entries()) {
      if (j % 2) { buffer += piece; continue; }
      let last = 0;
      for (const m of piece.matchAll(IMAGE)) {
        buffer += piece.slice(last, m.index);
        last = m.index! + m[0].length;
        const [, alt, path] = m;
        if (REMOTE.test(path) || path.startsWith('//')) buffer += `[${alt || path}](${path})`;
        else { flush(); parts.push({ kind: 'image', alt, path: decoded(path).replace(/^\.\//, '') }); }
      }
      buffer += piece.slice(last).replace(/!\[/g, '[');
    }
  }
  flush();
  return parts;
}
