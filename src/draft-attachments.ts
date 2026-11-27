/* Plain copies of a composer's prompt attachments, kept inside its stored draft record beside the
 * text. A copy carries only the references and chip thumbnails the composer shows, never a file's
 * bytes, and is rebuilt field by field on the way back out because local storage is user-writable:
 * anything malformed, oversized or of an unknown shape is dropped rather than trusted. */

import type { PromptAttachment, PromptDocument, PromptFolder, PromptImage } from './attachments.ts';

/** The composer's own caps: 4 images + 5 documents + 3 folders per message. */
export const MAX_STORED_ATTACHMENTS = 12;
/** UTF-16 bytes one stored attachment may add (JSON text × 2), so one chip cannot fill the budget. */
export const MAX_STORED_ATTACHMENT_BYTES = 200_000;

/** A persisted attachment: the same plain JSON shape as a live one, kept in a draft record. */
export type StoredAttachment = PromptAttachment;

const IMAGE_SOURCES: readonly PromptImage['source'][] = ['file', 'paste', 'drop', 'sketch'];
const isText = (value: unknown): value is string => typeof value === 'string';
const isFilled = (value: unknown): value is string => isText(value) && value.length > 0;
const isImageDataUrl = (value: unknown): value is string => isFilled(value) && value.startsWith('data:image/');
const isMeasure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isSource = (value: unknown): value is PromptImage['source'] => isText(value) && (IMAGE_SOURCES as readonly string[]).includes(value);

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function imageFields(value: Record<string, unknown>): PromptImage | undefined {
  const { id, name, thumbnail, width, height, source, path, sketchId, missing } = value;
  if (!isFilled(id) || !isFilled(name) || !isImageDataUrl(thumbnail) || !isMeasure(width) || !isMeasure(height) || !isSource(source)) return undefined;
  if (path !== undefined && !isText(path)) return undefined;
  if (sketchId !== undefined && !isText(sketchId)) return undefined;
  // A missing-file marker is launch-time state: validated when present, but not stored.
  if (missing !== undefined && typeof missing !== 'boolean') return undefined;
  const copy: PromptImage = { kind: 'image', id, name, width, height, thumbnail, source };
  if (path !== undefined) copy.path = path;
  if (sketchId !== undefined) copy.sketchId = sketchId;
  return copy;
}

function documentFields(value: Record<string, unknown>): PromptDocument | undefined {
  const { id, path, name, size, text, truncated, method, missing } = value;
  if (!isText(id) || !isText(path) || !isFilled(name) || !isText(method)) return undefined;
  if (!isMeasure(size) || !isText(text) || typeof truncated !== 'boolean') return undefined;
  if (missing !== undefined && typeof missing !== 'boolean') return undefined;
  return { kind: 'document', id, path, name, size, text, truncated, method };
}

function folderFields(value: Record<string, unknown>): PromptFolder | undefined {
  const { id, path, name, files, folders, listing, truncated, missing } = value;
  if (!isFilled(id) || !isFilled(path) || !isFilled(name)) return undefined;
  if (!isMeasure(files) || !isMeasure(folders) || !isText(listing) || typeof truncated !== 'boolean') return undefined;
  if (missing !== undefined && typeof missing !== 'boolean') return undefined;
  return { kind: 'folder', id, path, name, files, folders, listing, truncated };
}

/** A validated explicit copy of one attachment, or undefined when its kind, shape or fields are wrong. */
function sanitize(value: unknown): PromptAttachment | undefined {
  try {
    const item = fields(value);
    if (!item) return undefined;
    if (item.kind === 'image') return imageFields(item);
    if (item.kind === 'document') return documentFields(item);
    if (item.kind === 'folder') return folderFields(item);
    return undefined;
  } catch { return undefined; }
}

/** UTF-16 bytes one attachment adds as JSON, or undefined when it cannot be serialized. */
function itemBytes(item: PromptAttachment): number | undefined {
  try { return JSON.stringify(item).length * 2; } catch { return undefined; }
}

/** Validated copies of the first MAX_STORED_ATTACHMENTS that fit the per-item byte cap. */
function copiesOf(values: readonly unknown[]): PromptAttachment[] {
  const copies: PromptAttachment[] = [];
  for (const value of values) {
    if (copies.length >= MAX_STORED_ATTACHMENTS) break;
    const copy = sanitize(value);
    if (!copy) continue;
    const size = itemBytes(copy);
    if (size === undefined || size > MAX_STORED_ATTACHMENT_BYTES) continue;
    copies.push(copy);
  }
  return copies;
}

/** The attachments a draft may store: validated plain copies, in order, or undefined when none survive. */
export function toStored(items: readonly PromptAttachment[]): PromptAttachment[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const copies = copiesOf(items);
  return copies.length ? copies : undefined;
}

/** The attachments read back from a draft record; anything not an array of valid items is dropped. */
export function fromStored(value: unknown): PromptAttachment[] {
  return Array.isArray(value) ? copiesOf(value) : [];
}

/** UTF-16 bytes a list of attachments adds to a draft record; 0 when there is none. */
export function attachmentsBytes(items: readonly PromptAttachment[] | undefined): number {
  if (!Array.isArray(items) || !items.length) return 0;
  try { return JSON.stringify(items).length * 2; } catch { return 0; }
}
