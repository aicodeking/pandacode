import { t } from './i18n.ts';
import './moodboards.css';
import { call, nativeDesktop, subscribe } from './bridge';
import { escape, icon, isImeKey } from './dom';

export interface Moodboard { id: string; projectId: string; name: string; imageCount: number; updatedAt: number }
export interface MoodboardImage { id: string; name: string; caption: string; width: number; height: number; createdAt: number }
export interface MoodboardDetail extends Moodboard { images: MoodboardImage[] }
export interface MoodboardOptions { projectId: string; initialBoardId?: string; onAttach?(board: Moodboard): void }

const MAX_FILE = 12 * 1024 * 1024;
const supported = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Keep pending saves ordered across closing/reopening the library.
const captionWrites = new Map<string, Promise<void>>();
function readData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE || !supported.has(file.type)) { reject(new Error(t('Choose PNG, JPEG or WebP images up to 12 MB each.'))); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Project-scoped library. Only visible image thumbnails are requested; closing
 * the view releases image data and listeners without affecting active agents. */
export function mountMoodboards(host: HTMLElement, options: MoodboardOptions): () => void {
  host.classList.add('moodboards');
  host.innerHTML = `<div class="moodboard-workspace"><aside class="moodboard-library"><div class="moodboard-library-heading"><span>${t('Boards')}</span><button type="button" class="icon-button" data-mood-action="new" aria-label="${t('New moodboard')}" title="${t('New moodboard')}">${icon('plus')}</button></div><form class="moodboard-create" hidden><input name="name" aria-label="${t('Moodboard name')}" placeholder="${t('Name your board')}" maxlength="120" required><button class="icon-button" title="${t('Create moodboard')}" aria-label="${t('Create moodboard')}">${icon('check')}</button></form><nav class="moodboard-list" aria-label="${t('Moodboards')}"></nav></aside><section class="moodboard-content" aria-label="${t('Visual references')}"><header class="moodboard-toolbar" hidden><input class="moodboard-title" aria-label="${t('Board name')}" maxlength="120"><button type="button" class="secondary-button" data-mood-action="add">${icon('plus')} ${t('Add images')}</button><button type="button" class="icon-button" data-mood-action="delete" title="${t('Delete moodboard')}" aria-label="${t('Delete moodboard')}">${icon('archive')}</button></header><div class="moodboard-delete-confirm" hidden><span>${t('Delete this board and its images?')}</span><button type="button" class="secondary-button" data-mood-action="cancel-delete">${t('Keep board')}</button><button type="button" class="secondary-button" data-mood-action="confirm-delete">${t('Delete')}</button></div><div class="moodboard-canvas" tabindex="0" aria-label="${t('Moodboard images. Paste or drop images here.')}"><div class="moodboard-empty">${icon('camera')}<h3>${t('Your visual starting point.')}</h3><p>${t('Collect screenshots, layouts and ideas for your agents to reference.')}</p><button type="button" class="secondary-button" data-mood-action="new">${t('Create a moodboard')}</button></div></div><footer class="moodboard-footer" hidden><span>${t('Drop images or paste a screenshot')}</span><button type="button" class="primary-button" data-mood-action="attach" ${options.onAttach ? '' : 'hidden'}>${icon('attach')} ${t('Attach to task')}</button></footer></section></div><p class="moodboard-status" role="status" aria-live="polite"></p><input class="moodboard-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>`;
  const find = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const list = find<HTMLElement>('.moodboard-list'), canvas = find<HTMLElement>('.moodboard-canvas');
  const toolbar = find<HTMLElement>('.moodboard-toolbar'), footer = find<HTMLElement>('.moodboard-footer');
  const title = find<HTMLInputElement>('.moodboard-title'), createForm = find<HTMLFormElement>('.moodboard-create');
  const nameInput = createForm.querySelector<HTMLInputElement>('input')!, status = find<HTMLElement>('.moodboard-status');
  const fileInput = find<HTMLInputElement>('.moodboard-file-input'), confirmDelete = find<HTMLElement>('.moodboard-delete-confirm');
  let disposed = false, boards: Moodboard[] = [], selected: MoodboardDetail | undefined;
  let loading = 0, busy = false, nativeUnlisten: (() => void) | undefined, changesUnlisten: (() => void) | undefined;
  let thumbnailQueue: HTMLImageElement[] = [], activeThumbnails = 0;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      const image = entry.target as HTMLImageElement; observer.unobserve(image); thumbnailQueue.push(image);
    }
    loadThumbnails();
  }, { root: canvas, rootMargin: '150px' });

  function report(message: unknown, error = false): void {
    if (disposed) return;
    status.textContent = message instanceof Error ? message.message : String(message ?? '');
    status.dataset.error = String(error);
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    busy = true; host.setAttribute('aria-busy', 'true');
    host.querySelectorAll<HTMLButtonElement>('[data-mood-action="add"],[data-mood-action="confirm-delete"],.moodboard-create button').forEach(button => { button.disabled = true; });
    try { await action(); } catch (error) { report(error, true); }
    finally {
      busy = false;
      if (!disposed) {
        host.removeAttribute('aria-busy');
        host.querySelectorAll<HTMLButtonElement>('[data-mood-action="add"],[data-mood-action="confirm-delete"],.moodboard-create button').forEach(button => { button.disabled = false; });
      }
    }
  }
  function renderList(): void {
    list.innerHTML = boards.map(board => `<button type="button" class="moodboard-list-item" data-mood-board="${escape(board.id)}" aria-pressed="${board.id === selected?.id}">${icon('board')}<span class="moodboard-list-name">${escape(board.name)}</span> <small>${board.imageCount} ${board.imageCount === 1 ? t('image') : t('images')}</small></button>`).join('');
  }
  function updateBoard(board: Moodboard): void {
    boards = [board, ...boards.filter(item => item.id !== board.id)]; renderList();
  }
  function renderImages(): void {
    observer.disconnect(); thumbnailQueue = [];
    canvas.querySelectorAll('img').forEach(image => image.removeAttribute('src'));
    if (!selected) return;
    const board = selected;
    toolbar.hidden = false; footer.hidden = false; confirmDelete.hidden = true; title.value = board.name;
    canvas.innerHTML = board.images.length ? `<div class="moodboard-image-grid">${board.images.map(image => `<article class="moodboard-image-card" data-mood-image="${escape(image.id)}"><button type="button" class="moodboard-image-preview" data-mood-expand="${escape(image.id)}" aria-label="${t`View ${escape(image.name)}`}"><img data-image-id="${escape(image.id)}" data-board-id="${escape(board.id)}" alt="${escape(image.name)}" decoding="async"></button><div class="moodboard-image-meta"><span title="${escape(image.name)}">${escape(image.name)}</span><button type="button" class="icon-button" data-mood-remove="${escape(image.id)}" aria-label="${t`Remove ${escape(image.name)}`}" title="${t('Remove image')}">${icon('close')}</button></div><textarea rows="2" maxlength="2000" data-mood-caption="${escape(image.id)}" aria-label="${t`Caption for ${escape(image.name)}`}" placeholder="${t('What should the agent notice?')}">${escape(image.caption)}</textarea></article>`).join('')}</div>` : `<div class="moodboard-empty">${icon('camera')}<h3>${t('Give your agent a little inspiration.')}</h3><p>${t('Drop images here, paste a screenshot, or choose files.')}</p><button type="button" class="secondary-button" data-mood-action="add">${icon('plus')} ${t('Add images')}</button><small>${t('PNG, JPEG, WebP · up to 12 MB each')}</small></div>`;
    canvas.querySelectorAll<HTMLImageElement>('img').forEach(image => observer.observe(image));
    renderList();
  }
  function loadThumbnails(): void {
    if (disposed) return;
    while (activeThumbnails < 2 && thumbnailQueue.length) {
      const image = thumbnailQueue.shift()!;
      if (!image.isConnected || !host.contains(image)) continue;
      activeThumbnails++;
      void call<{dataUrl: string}>('moodboard_image', { projectId: options.projectId, boardId: image.dataset.boardId, imageId: image.dataset.imageId, thumbnail: true })
        .then(result => { if (!disposed && host.contains(image)) image.src = result.dataUrl; })
        .catch(() => { if (!disposed && host.contains(image)) image.alt = t('Preview unavailable'); })
        .finally(() => { activeThumbnails--; loadThumbnails(); });
    }
  }
  async function select(id: string): Promise<void> {
    if (disposed) return;
    const request = ++loading;
    report(t('Loading moodboard…'));
    await Promise.all([...captionWrites.values()]);
    if (disposed || request !== loading) return;
    const detail = await call<MoodboardDetail>('read_moodboard', { projectId: options.projectId, boardId: id });
    if (disposed || request !== loading) return;
    selected = detail; renderImages(); report('');
  }
  async function reload(id?: string): Promise<void> {
    const items = await call<Moodboard[]>('list_moodboards', { projectId: options.projectId });
    if (disposed) return;
    boards = items; renderList();
    const next = items.find(board => board.id === id) ?? items[0];
    if (next) await select(next.id);
    else {
      selected = undefined; toolbar.hidden = true; footer.hidden = true; confirmDelete.hidden = true;
      observer.disconnect(); thumbnailQueue = [];
      canvas.innerHTML = `<div class="moodboard-empty">${icon('camera')}<h3>${t('Your visual starting point.')}</h3><p>${t('Collect screenshots, layouts and ideas for your agents to reference.')}</p><button type="button" class="secondary-button" data-mood-action="new">${t('Create a moodboard')}</button></div>`;
    }
  }
  async function addFiles(files: File[]): Promise<void> {
    if (!selected) { report(t('Create a moodboard first.')); return; }
    if (!files.length) return;
    if (files.length > 8) { report(t('Add up to eight images at a time.'), true); return; }
    const boardId = selected.id;
    await perform(async () => {
      try { for (let i = 0; i < files.length; i++) {
        report(t`Adding image ${i + 1} of ${files.length}…`);
        const dataUrl = await readData(files[i]);
        const detail = await call<MoodboardDetail>('add_moodboard_image', { projectId: options.projectId, boardId, name: files[i].name || `Screenshot ${new Date().toLocaleTimeString()}`, dataUrl });
        if (disposed) return;
        updateBoard(detail);
        if (selected?.id === boardId) selected = detail;
      }
      } finally { if (!disposed && selected?.id === boardId) renderImages(); }
      report(files.length === 1 ? t`${files.length} image added.` : t`${files.length} images added.`);
    });
  }
  async function addPaths(paths: string[]): Promise<void> {
    if (!selected || !paths.length) return;
    const boardId = selected.id;
    await perform(async () => {
      report(t('Adding images…'));
      const detail = await call<MoodboardDetail>('import_moodboard_images', { projectId: options.projectId, boardId, paths });
      if (disposed) return;
      updateBoard(detail);
      if (selected?.id === boardId) { selected = detail; renderImages(); }
      report(paths.length === 1 ? t`${paths.length} image added.` : t`${paths.length} images added.`);
    });
  }
  function showCreate(): void { createForm.hidden = false; nameInput.focus(); }
  async function chooseImages(): Promise<void> {
    if (preview) { fileInput.click(); return; }
    const result = await (await import('@tauri-apps/plugin-dialog')).open({ title: t('Add images to moodboard'), multiple: true, filters: [{ name: t('Images'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
