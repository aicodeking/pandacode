import './attachments.css';
import { call, chooseAttachmentFolder, chooseAttachments, nativeDesktop, preview, webMode } from './bridge';
import { escape, icon } from './dom';
import { isMac } from './platform';
import { t } from './i18n.ts';

/** Inputs the user adds to one message: images travel as native image blocks,
 * documents and folders as bounded text context. Kept per task until sent.
 * On any of the three, `missing` marks a restored draft attachment whose file is
 * gone: its chip says so and it is left out of what is sent. */
export type PromptImage = { kind: 'image'; id: string; name: string; width: number; height: number; thumbnail: string; source: 'file' | 'paste' | 'drop' | 'sketch'; path?: string; sketchId?: string; missing?: boolean };
export type PromptDocument = { kind: 'document'; id: string; path: string; name: string; size: number; text: string; truncated: boolean; method: string; missing?: boolean };
export type PromptFolder = { kind: 'folder'; id: string; path: string; name: string; files: number; folders: number; listing: string; truncated: boolean; missing?: boolean };
export type PromptAttachment = PromptImage | PromptDocument | PromptFolder;

type MenuItem = { id: string; label: string; description?: string; icon?: string };
export type AttachmentsHost = {
  taskId(): string;
  /** A reason attaching is impossible right now, or null. */
  blocked(taskId: string): string | null;
  /** Browser screenshots already waiting on the task; they share the image cap. */
  otherImages(taskId: string): number;
  /** A reason this task's harness cannot take images, or null when it can. */
  imagesUnsupported?(taskId: string): string | null;
  notify(message: string): void;
  report(error: unknown): void;
  /** Puts text at the composer's caret; false when there is no prompt to type into. */
  insertText(text: string): boolean;
  rerender(taskId: string): void;
  /** The task's attachment list changed; persist it with the draft. */
  changed?(taskId: string): void;
  menu(anchor: HTMLElement, items: MenuItem[], onSelect: (id: string) => Promise<void>): Promise<void>;
  projectFiles(): void;
  sketch(taskId: string, existing?: PromptImage): void;
};

/** Every harness path accepts at most four images per turn. */
export const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 5;
const MAX_FOLDERS = 3;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
const MAX_INLINE_TEXT = 32768;

function id(): string { return crypto.randomUUID(); }
function baseName(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
/** A path the agent can open itself, quoted when it holds spaces. */
export function quotePath(path: string): string { return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path; }
/** A translated "already attached" error, flagged so `alreadyAttached` never matches on message text. */
const duplicate = (name: string): Error => Object.assign(new Error(t`${name} is already attached.`), { duplicate: true });
const alreadyAttached = (error: unknown) => Boolean((error as { duplicate?: boolean })?.duplicate);
function formatSize(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function documentLabel(document: PromptDocument): string {
  const ext = document.name.split('.').pop()?.toUpperCase();
  const type = ext && ext !== document.name.toUpperCase() && ext.length <= 8 ? ext : t('Text');
  return `${type} · ${formatSize(document.size)}${document.truncated ? t(' · first 32 KB') : ''}`;
}

export function mountPromptAttachments(host: AttachmentsHost) {
  const items = new Map<string, PromptAttachment[]>();
  const list = (taskId: string): PromptAttachment[] => items.get(taskId) ?? [];
  const set = (taskId: string, next: PromptAttachment[], persist = true): void => { if (next.length) items.set(taskId, next); else items.delete(taskId); if (persist) host.changed?.(taskId); };

  function add(taskId: string, attachment: PromptAttachment): void {
    const reason = host.blocked(taskId); if (reason) throw new Error(reason);
    const current = list(taskId);
    if (attachment.kind === 'image') {
      const unsupported = host.imagesUnsupported?.(taskId);
      if (unsupported) throw new Error(unsupported);
      if (attachment.path && current.some(a => a.kind === 'image' && a.path === attachment.path)) throw duplicate(attachment.name);
      if (current.filter(a => a.kind === 'image').length + host.otherImages(taskId) >= MAX_IMAGES) throw new Error(t`Attach up to ${MAX_IMAGES} images per message, including browser screenshots.`);
    } else if (attachment.kind === 'document') {
      if (current.some(a => a.kind === 'document' && a.path === attachment.path)) throw duplicate(attachment.name);
      if (current.filter(a => a.kind === 'document').length >= MAX_DOCUMENTS) throw new Error(t`Attach up to ${MAX_DOCUMENTS} documents per message.`);
    } else {
      if (current.some(a => a.kind === 'folder' && a.path === attachment.path)) throw duplicate(attachment.name);
      if (current.filter(a => a.kind === 'folder').length >= MAX_FOLDERS) throw new Error(t`Attach up to ${MAX_FOLDERS} folders per message.`);
    }
    set(taskId, [...current, attachment]);
    host.rerender(taskId);
  }

  function target(): string {
    const taskId = host.taskId();
    const reason = taskId ? host.blocked(taskId) : t('Start a task before attaching anything.');
    if (reason) throw new Error(reason);
    return taskId;
  }

  async function addImage(taskId: string, source: { path?: string; dataUrl?: string; name?: string; origin: PromptImage['source']; sketchId?: string; replace?: string }): Promise<PromptImage> {
    // Refuse what cannot be sent before the native import writes a copy.
    const unsupported = host.imagesUnsupported?.(taskId);
    if (unsupported) throw new Error(unsupported);
    if (source.path && list(taskId).some(a => a.kind === 'image' && a.path === source.path)) throw duplicate(baseName(source.path));
    const imported = await call<{ id: string; name: string; width: number; height: number; thumbnail: string }>('import_prompt_image', { path: source.path, dataUrl: source.dataUrl, name: source.name });
    const reason = host.blocked(taskId); if (reason) throw new Error(reason);
    const image: PromptImage = { kind: 'image', ...imported, source: source.origin, path: source.path, sketchId: source.sketchId };
    if (source.replace) {
      const current = list(taskId), index = current.findIndex(a => a.id === source.replace);
      if (index >= 0) { set(taskId, current.map((a, i) => i === index ? image : a)); host.rerender(taskId); return image; }
    }
    add(taskId, image);
    return image;
  }

  /** The native clipboard image, for webviews (WebKitGTK) that never expose OS
   * clipboard images as pasted files; unreadable or empty clipboards stay silent. */
  async function attachClipboardImage(taskId: string): Promise<void> {
    // A browser tab must never read the host computer's clipboard (the preview's mock still may).
    if (webMode) return;
    let base64: string | null;
    try {
      base64 = await call<string | null>('read_clipboard_image');
    } catch { return; /* No clipboard access here; the paste stays a no-op. */ }
    if (!base64) return;
    await addImage(taskId, { dataUrl: `data:image/png;base64,${base64}`, name: 'Pasted image.png', origin: 'paste' });
  }

  async function addDocument(taskId: string, path: string): Promise<void> {
    const document = await call<Omit<PromptDocument, 'kind' | 'id'>>('read_document', { path });
    add(taskId, { kind: 'document', id: id(), ...document });
  }

  async function addFolder(taskId: string, path: string): Promise<void> {
    const folder = await call<Omit<PromptFolder, 'kind' | 'id'>>('describe_folder', { path });
    add(taskId, { kind: 'folder', id: id(), ...folder });
  }

  /** Dropped items that cannot be attached go into the prompt as text, one per line, so the
   * agent can still open them. Returns false when there was no prompt to take them. */
  function insertInstead(lines: string[], what: string): boolean {
    if (!lines.length || !host.insertText(lines.join('\n'))) return false;
    const label = what === 'path' ? t('path') : t('name');
    host.notify(lines.length === 1 ? t`Inserted ${label} for ${what === 'path' ? baseName(lines[0].replace(/^"|"$/g, '')) : lines[0].split(' (')[0]}` : t`Inserted ${label}s for ${lines.length} files`);
    return true;
  }

  /** Paths from a picker or a drop. Folders are tried first when the kind is unknown. */
  async function attachPaths(paths: string[], hint: 'files' | 'folder' | 'unknown' = 'unknown', dropped = false): Promise<void> {
    const taskId = target();
    let attached = 0;
    const failed: { path: string; error: unknown }[] = [];
    for (const path of paths) {
      try {
        if (hint === 'folder') await addFolder(taskId, path);
        else if (IMAGE_EXTENSIONS.test(path)) await addImage(taskId, { path, origin: 'file' });
        else if (hint === 'files') await addDocument(taskId, path);
        else {
          try { await addFolder(taskId, path); }
          catch (error) { if (String(error instanceof Error ? error.message : error).includes('not a folder')) await addDocument(taskId, path); else throw error; }
        }
        attached++;
      } catch (error) { if (dropped && !alreadyAttached(error)) failed.push({ path, error }); else host.report(error); }
    }
    if (attached) host.notify(attached === 1 ? t`Attached ${baseName(paths[0])}` : t`Attached ${attached} items`);
    if (!insertInstead(failed.map(item => quotePath(item.path)), 'path')) failed.forEach(item => host.report(item.error));
  }

  /** Browser drops and pastes deliver File objects rather than paths. */
  async function attachFiles(files: File[], origin: 'paste' | 'drop'): Promise<void> {
    const taskId = target();
    let attached = 0;
    const failed: { file: File; error: unknown }[] = [];
    for (const file of files) {
      try {
        if (file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)) {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(t('Could not read the image.'))); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
          await addImage(taskId, { dataUrl, name: file.name || (origin === 'paste' ? 'Pasted image.png' : 'Image.png'), origin });
        } else {
          // Browser File objects carry no path, so only text can be read here.
          const text = (await file.text()).slice(0, MAX_INLINE_TEXT + 1);
          if (!text.trim() || text.includes('\0')) throw new Error(t`${file.name} is not a text document. Attach it with the picker instead.`);
          add(taskId, { kind: 'document', id: id(), path: file.name, name: file.name, size: file.size, text: text.slice(0, MAX_INLINE_TEXT), truncated: text.length > MAX_INLINE_TEXT, method: 'text' });
        }
        attached++;
      } catch (error) { if (origin === 'drop' && file.name && !alreadyAttached(error)) failed.push({ file, error }); else host.report(error); }
    }
    // A browser File carries no path, so the name goes in with a note instead.
    if (!insertInstead(failed.map(item => `${item.file.name} (dropped file; PandaCode could not read it or find its path)`), 'name')) failed.forEach(item => host.report(item.error));
    // A paste shows up in the composer right away; no toast needed.
    if (attached && origin !== 'paste') host.notify(attached === 1 ? t`Attached ${files[0].name}` : t`Attached ${attached} items`);
  }

  /** A DOM file drop: the real paths when the drag pasteboard still holds these files
   * (names prove it), otherwise the File objects, which have no path (Photos, Mail, a
   * failed read). */
  async function attachDropped(files: File[]): Promise<void> {
    // A browser tab's drop has no native paths (and the host would refuse the call): attach the files' bytes.
    const paths = webMode ? [] : await call<string[]>('dragged_file_paths').catch(() => [] as string[]);
    const names = new Set(paths.map(path => baseName(path).normalize()));
    if (paths.length && files.every(file => names.has(file.name.normalize()))) await attachPaths(paths, 'unknown', true);
    else if (files.length) await attachFiles(files, 'drop');
  }

  async function openMenu(anchor: HTMLElement): Promise<void> {
    const taskId = host.taskId();
    const reason = taskId ? host.blocked(taskId) : t('Start a task before attaching anything.');
    if (reason) { host.notify(reason); return; }
    // A harness without image input gets documents and folders only.
    const imageless = Boolean(host.imagesUnsupported?.(taskId));
    await host.menu(anchor, [
      { id: 'files', label: t('Attach files…'), description: imageless ? t('PDFs, documents') : t('Images, PDFs, documents'), icon: 'attach' },
      { id: 'folder', label: t('Attach a folder…'), description: t('Path and structure'), icon: 'folder' },
      { id: 'project', label: t('Project files'), description: t('From the Files tab'), icon: 'file' },
      ...imageless ? [] : [{ id: 'sketch', label: t('Sketch a mockup…'), description: t('Draw and attach'), icon: 'sketch' }],
    ], async choice => {
      if (choice === 'project') { host.projectFiles(); return; }
      if (choice === 'sketch') { host.sketch(taskId); return; }
      if (choice === 'folder') { const path = await chooseAttachmentFolder(); if (path) await attachPaths([path], 'folder'); return; }
      const paths = await chooseAttachments();
      if (paths.length) await attachPaths(paths, 'files');
    });
  }

  function chips(taskId: string): string {
    return list(taskId).map(item => {
      const remove = `<button type="button" data-action="detach-prompt" data-id="${escape(item.id)}" aria-label="${t`Remove ${escape(item.name)}`}">${icon('close')}</button>`;
      if (item.kind === 'image') {
        const edit = item.source === 'sketch' ? `<button type="button" class="prompt-chip-edit" data-action="edit-sketch" data-id="${escape(item.id)}" aria-label="${t`Edit sketch ${escape(item.name)}`}">${icon('edit')}</button>` : '';
        return `<span class="prompt-chip prompt-chip-image" data-attachment-id="${escape(item.id)}" data-source="${item.source}"><img src="${escape(item.thumbnail)}" alt="" width="36" height="36"><span class="prompt-chip-text"><span class="prompt-chip-name">${escape(item.name)}</span><small>${item.source === 'sketch' ? t('Mockup · ') : ''}${item.width} × ${item.height}</small></span>${edit}${remove}</span>`;
      }
      if (item.kind === 'document') return `<span class="prompt-chip prompt-chip-document" data-attachment-id="${escape(item.id)}" title="${escape(item.path)}">${icon('file')}<span class="prompt-chip-text"><span class="prompt-chip-name">${escape(item.name)}</span><small>${escape(documentLabel(item))}</small></span>${remove}</span>`;
      return `<span class="prompt-chip prompt-chip-folder" data-attachment-id="${escape(item.id)}" title="${escape(item.path)}">${icon('folder')}<span class="prompt-chip-text"><span class="prompt-chip-name">${escape(item.name)}/</span><small>${item.files} ${item.files === 1 ? t('file') : t('files')} · ${item.folders} ${item.folders === 1 ? t('folder') : t('folders')}${item.truncated ? t(' · partial') : ''}</small></span>${remove}</span>`;
