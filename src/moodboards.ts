import './moodboards.css';
import { call, preview } from './bridge';
import { escape, icon } from './dom';

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
    if (file.size > MAX_FILE || !supported.has(file.type)) { reject(new Error('Choose PNG, JPEG or WebP images up to 12 MB each.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Project-scoped library. Only visible image thumbnails are requested; closing
 * the view releases image data and listeners without affecting active agents. */
export function mountMoodboards(host: HTMLElement, options: MoodboardOptions): () => void {
  host.classList.add('moodboards');
  host.innerHTML = `<div class="moodboard-workspace"><aside class="moodboard-library"><div class="moodboard-library-heading"><span>Boards</span><button type="button" class="icon-button" data-mood-action="new" aria-label="New moodboard" title="New moodboard">${icon('plus')}</button></div><form class="moodboard-create" hidden><input name="name" aria-label="Moodboard name" placeholder="Name your board" maxlength="120" required><button class="icon-button" title="Create moodboard" aria-label="Create moodboard">${icon('check')}</button></form><nav class="moodboard-list" aria-label="Moodboards"></nav></aside><section class="moodboard-content" aria-label="Visual references"><header class="moodboard-toolbar" hidden><input class="moodboard-title" aria-label="Board name" maxlength="120"><button type="button" class="secondary-button" data-mood-action="add">${icon('plus')} Add images</button><button type="button" class="icon-button" data-mood-action="delete" title="Delete moodboard" aria-label="Delete moodboard">${icon('archive')}</button></header><div class="moodboard-delete-confirm" hidden><span>Delete this board and its images?</span><button type="button" class="secondary-button" data-mood-action="cancel-delete">Keep board</button><button type="button" class="secondary-button" data-mood-action="confirm-delete">Delete</button></div><div class="moodboard-canvas" tabindex="0" aria-label="Moodboard images. Paste or drop images here."><div class="moodboard-empty">${icon('camera')}<h3>Your visual starting point.</h3><p>Collect screenshots, layouts and ideas for your agents to reference.</p><button type="button" class="secondary-button" data-mood-action="new">Create a moodboard</button></div></div><footer class="moodboard-footer" hidden><span>Drop images or paste a screenshot</span><button type="button" class="primary-button" data-mood-action="attach" ${options.onAttach ? '' : 'hidden'}>${icon('attach')} Attach to task</button></footer></section></div><p class="moodboard-status" role="status" aria-live="polite"></p><input class="moodboard-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>`;
  const find = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const list = find<HTMLElement>('.moodboard-list'), canvas = find<HTMLElement>('.moodboard-canvas');
  const toolbar = find<HTMLElement>('.moodboard-toolbar'), footer = find<HTMLElement>('.moodboard-footer');
  const title = find<HTMLInputElement>('.moodboard-title'), createForm = find<HTMLFormElement>('.moodboard-create');
  const nameInput = createForm.querySelector<HTMLInputElement>('input')!, status = find<HTMLElement>('.moodboard-status');
  const fileInput = find<HTMLInputElement>('.moodboard-file-input'), confirmDelete = find<HTMLElement>('.moodboard-delete-confirm');
  let disposed = false, boards: Moodboard[] = [], selected: MoodboardDetail | undefined;
  let loading = 0, busy = false;
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
    list.innerHTML = boards.map(board => `<button type="button" class="moodboard-list-item" data-mood-board="${escape(board.id)}" aria-pressed="${board.id === selected?.id}">${icon('board')}<span class="moodboard-list-name">${escape(board.name)}</span> <small>${board.imageCount} ${board.imageCount === 1 ? 'image' : 'images'}</small></button>`).join('');
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
    canvas.innerHTML = board.images.length ? `<div class="moodboard-image-grid">${board.images.map(image => `<article class="moodboard-image-card" data-mood-image="${escape(image.id)}"><button type="button" class="moodboard-image-preview" data-mood-expand="${escape(image.id)}" aria-label="View ${escape(image.name)}"><img data-image-id="${escape(image.id)}" data-board-id="${escape(board.id)}" alt="${escape(image.name)}" decoding="async"></button><div class="moodboard-image-meta"><span title="${escape(image.name)}">${escape(image.name)}</span><button type="button" class="icon-button" data-mood-remove="${escape(image.id)}" aria-label="Remove ${escape(image.name)}" title="Remove image">${icon('close')}</button></div><textarea rows="2" maxlength="2000" data-mood-caption="${escape(image.id)}" aria-label="Caption for ${escape(image.name)}" placeholder="What should the agent notice?">${escape(image.caption)}</textarea></article>`).join('')}</div>` : `<div class="moodboard-empty">${icon('camera')}<h3>Give your agent a little inspiration.</h3><p>Drop images here, paste a screenshot, or choose files.</p><button type="button" class="secondary-button" data-mood-action="add">${icon('plus')} Add images</button><small>PNG, JPEG, WebP · up to 12 MB each</small></div>`;
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
        .catch(() => { if (!disposed && host.contains(image)) image.alt = 'Preview unavailable'; })
        .finally(() => { activeThumbnails--; loadThumbnails(); });
    }
  }
  async function select(id: string): Promise<void> {
    if (disposed) return;
    const request = ++loading;
    report('Loading moodboard…');
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
      canvas.innerHTML = `<div class="moodboard-empty">${icon('camera')}<h3>Your visual starting point.</h3><p>Collect screenshots, layouts and ideas for your agents to reference.</p><button type="button" class="secondary-button" data-mood-action="new">Create a moodboard</button></div>`;
    }
  }
  async function addFiles(files: File[]): Promise<void> {
    if (!selected) { report('Create a moodboard first.'); return; }
    if (!files.length) return;
    if (files.length > 8) { report('Add up to eight images at a time.', true); return; }
    const boardId = selected.id;
    await perform(async () => {
      try { for (let i = 0; i < files.length; i++) {
        report(`Adding image ${i + 1} of ${files.length}…`);
        const dataUrl = await readData(files[i]);
        const detail = await call<MoodboardDetail>('add_moodboard_image', { projectId: options.projectId, boardId, name: files[i].name || `Screenshot ${new Date().toLocaleTimeString()}`, dataUrl });
        if (disposed) return;
        updateBoard(detail);
        if (selected?.id === boardId) selected = detail;
      }
      } finally { if (!disposed && selected?.id === boardId) renderImages(); }
      report(`${files.length} ${files.length === 1 ? 'image added' : 'images added'}.`);
    });
  }
  async function addPaths(paths: string[]): Promise<void> {
    if (!selected || !paths.length) return;
    const boardId = selected.id;
    await perform(async () => {
      report('Adding images…');
      const detail = await call<MoodboardDetail>('import_moodboard_images', { projectId: options.projectId, boardId, paths });
      if (disposed) return;
      updateBoard(detail);
      if (selected?.id === boardId) { selected = detail; renderImages(); }
      report(`${paths.length} ${paths.length === 1 ? 'image added' : 'images added'}.`);
    });
  }
  function showCreate(): void { createForm.hidden = false; nameInput.focus(); }
  async function chooseImages(): Promise<void> {
    if (preview) { fileInput.click(); return; }
    const result = await (await import('@tauri-apps/plugin-dialog')).open({ title: 'Add images to moodboard', multiple: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (!disposed && result) await addPaths(Array.isArray(result) ? result : [result]);
  }
  async function expand(imageId: string): Promise<void> {
    if (!selected) return;
    const boardId = selected.id, image = selected.images.find(item => item.id === imageId); if (!image) return;
    host.querySelector('.moodboard-lightbox')?.remove();
    const box = document.createElement('div'); box.className = 'moodboard-lightbox'; box.tabIndex = -1;
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Image preview'); box.setAttribute('aria-modal', 'true');
    find<HTMLElement>('.moodboard-workspace').inert = true;
    box.innerHTML = `<button type="button" class="icon-button" data-mood-action="close-preview" aria-label="Close image preview">${icon('close')}</button><img alt="${escape(image.name)}"><p>${escape(image.caption || image.name)}</p>`;
    host.append(box); box.querySelector<HTMLButtonElement>('button')!.focus();
    try {
      const result = await call<{dataUrl: string}>('moodboard_image', { projectId: options.projectId, boardId, imageId, thumbnail: false });
      if (!disposed && host.contains(box)) box.querySelector('img')!.src = result.dataUrl;
    } catch (error) { closePreview(); report(error, true); }
  }
  function closePreview(): void { host.querySelector('.moodboard-lightbox')?.remove(); find<HTMLElement>('.moodboard-workspace').inert = false; canvas.focus(); }
  function click(event: MouseEvent): void {
    const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button || !host.contains(button)) return;
    if (button.dataset.moodBoard) { if (!busy) void select(button.dataset.moodBoard).catch(error => report(error, true)); return; }
    if (button.dataset.moodExpand) { void expand(button.dataset.moodExpand); return; }
    if (button.dataset.moodRemove && selected) {
      const boardId = selected.id, imageId = button.dataset.moodRemove;
      void perform(async () => { await call('remove_moodboard_image', { projectId: options.projectId, boardId, imageId }); if (!disposed) await reload(boardId); }); return;
    }
    switch (button.dataset.moodAction) {
      case 'new': showCreate(); break;
      case 'add': void chooseImages().catch(error => report(error, true)); break;
      case 'delete': confirmDelete.hidden = false; break;
      case 'cancel-delete': confirmDelete.hidden = true; break;
      case 'confirm-delete': if (selected) { const boardId = selected.id; void perform(async () => { await call('delete_moodboard', { projectId: options.projectId, boardId }); if (!disposed) await reload(); }); } break;
      case 'attach': if (selected) options.onAttach?.({ id: selected.id, name: selected.name, projectId: selected.projectId, imageCount: selected.imageCount, updatedAt: selected.updatedAt }); break;
      case 'close-preview': closePreview(); break;
    }
  }
  function createBoard(event: SubmitEvent): void {
    event.preventDefault(); event.stopPropagation(); const name = nameInput.value.trim(); if (!name) return;
    void perform(async () => {
      const board = await call<Moodboard>('create_moodboard', { projectId: options.projectId, name });
      if (disposed) return;
      nameInput.value = ''; createForm.hidden = true; await reload(board.id); title.focus();
    });
  }
  async function saveTitle(): Promise<void> {
    if (!selected || title.value.trim() === selected.name) return;
    const boardId = selected.id, name = title.value.trim();
    if (!name) { title.value = selected.name; return; }
    try {
      const board = await call<Moodboard>('rename_moodboard', { projectId: options.projectId, boardId, name });
      if (!disposed && selected?.id === boardId) { Object.assign(selected, board); updateBoard(board); report('Board renamed.'); }
    } catch (error) { report(error, true); if (selected?.id === boardId) title.value = selected.name; }
  }
  function saveCaption(boardId: string, imageId: string, caption: string): void {
    // Keep writes ordered even when a user quickly edits, switches boards, then
    // returns. The queued writes finish after dismissal without holding the UI.
    const previous = captionWrites.get(imageId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await call('update_moodboard_image', { projectId: options.projectId, boardId, imageId, caption });
      if (disposed) return;
      const image = selected?.id === boardId ? selected.images.find(image => image.id === imageId) : undefined;
      if (image) image.caption = caption;
      report('Caption saved.');
    }).catch(error => report(error, true)).finally(() => { if (captionWrites.get(imageId) === next) captionWrites.delete(imageId); });
    captionWrites.set(imageId, next);
  }
  function change(event: Event): void {
    const target = event.target;
    if (target === fileInput) { const files = Array.from(fileInput.files ?? []); fileInput.value = ''; void addFiles(files); }
    if (target === title) void saveTitle();
    if (target instanceof HTMLTextAreaElement && target.dataset.moodCaption && selected) saveCaption(selected.id, target.dataset.moodCaption, target.value);
  }
  function paste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => supported.has(file.type));
    if (files.length) { event.preventDefault(); event.stopPropagation(); void addFiles(files); }
  }
  function drag(event: DragEvent): void {
    if (!selected || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); canvas.classList.add('is-dragging');
  }
  function leave(event: DragEvent): void { if (!(event.relatedTarget instanceof Node) || !canvas.contains(event.relatedTarget)) canvas.classList.remove('is-dragging'); }
  function drop(event: DragEvent): void { event.preventDefault(); event.stopPropagation(); canvas.classList.remove('is-dragging'); void addFiles(Array.from(event.dataTransfer?.files ?? [])); }
  function key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && host.querySelector('.moodboard-lightbox')) { event.preventDefault(); event.stopPropagation(); closePreview(); }
    else if (event.key === 'Escape' && !createForm.hidden) { event.preventDefault(); event.stopPropagation(); createForm.hidden = true; }
    else if (event.key === 'Enter' && event.target === title) { event.preventDefault(); void saveTitle(); title.blur(); }
  }
  host.addEventListener('click', click); host.addEventListener('change', change); host.addEventListener('paste', paste); host.addEventListener('keydown', key);
  createForm.addEventListener('submit', createBoard); canvas.addEventListener('dragover', drag); canvas.addEventListener('dragleave', leave); canvas.addEventListener('drop', drop);
  void reload(options.initialBoardId).catch(error => report(error, true));
  return () => {
    if (selected) {
      for (const field of host.querySelectorAll<HTMLTextAreaElement>('[data-mood-caption]')) {
        const image = selected.images.find(image => image.id === field.dataset.moodCaption);
        if (image && image.caption !== field.value) saveCaption(selected.id, image.id, field.value);
      }
      if (title.value.trim() && title.value.trim() !== selected.name) void saveTitle();
    }
    disposed = true; loading++; observer.disconnect(); thumbnailQueue = [];
    host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('paste', paste); host.removeEventListener('keydown', key);
    createForm.removeEventListener('submit', createBoard); canvas.removeEventListener('dragover', drag); canvas.removeEventListener('dragleave', leave); canvas.removeEventListener('drop', drop);
    host.querySelectorAll('img').forEach(image => image.removeAttribute('src'));
    host.replaceChildren();
  };
}
