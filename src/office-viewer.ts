// PDF, Word and spreadsheet files in a file tab. Loaded only when one is opened: each format's
// library is its own chunk. Everything renders locally; nothing is fetched.
import './office-viewer.css';
import { escape } from './dom';
import { checkUnzippedSize } from './zip-limit';

export type OfficeKind = 'pdf' | 'docx' | 'sheet' | 'image';
/** Data only, owned by the tab's cached bytes; never retains PDF objects or DOM. */
export type PdfViewState = {
  aspectRatios: number[];
  anchor?: { page: number; fraction: number };
};
export type OfficeState = PdfViewState & {
  actual?: boolean;
  imageScrollLeft?: number;
  imageScrollTop?: number;
  sheet?: number;
  sheetScrollTop?: number;
  sheetScrollLeft?: number;
};
/** Spreadsheets show this many rows per sheet; the rest are counted, not drawn. */
const SHEET_ROWS = 2000;
const SHEET_COLUMNS = 200;
/** A document is untrusted input: these bound what it can make the window allocate. */
const PDF_PAGES = 5000;
const CANVAS_PIXELS = 16_000_000;

export async function renderOffice(host: HTMLElement, kind: OfficeKind, bytes: ArrayBuffer, path = '', signal?: AbortSignal, state?: OfficeState): Promise<() => void> {
  host.innerHTML = '<div class="office-viewer"><div class="inspector-empty" role="status">Opening…</div></div>';
  const viewer = host.firstElementChild as HTMLElement;
  // Web links open in the browser (mountExternalLinks); anything else must not navigate the app.
  // composedPath reaches links inside the Word document's shadow root.
  viewer.addEventListener('click', event => {
    const anchor = event.composedPath().find((target): target is HTMLAnchorElement => target instanceof HTMLAnchorElement && target.hasAttribute('href'));
    const href = anchor?.getAttribute('href') ?? '';
    if (!anchor || /^https?:/i.test(href)) return;
    event.preventDefault();
    const root = anchor.getRootNode() as ParentNode, id = CSS.escape(href.slice(1));
    if (href.startsWith('#') && id) root.querySelector(`[id="${id}"], [name="${id}"]`)?.scrollIntoView();
  });
  if (kind === 'image') return renderImage(viewer, bytes, path, signal, state);
  if (kind !== 'pdf') checkUnzippedSize(bytes);
  if (kind === 'pdf') return renderPdf(viewer, bytes, signal, state);
  if (kind === 'docx') return renderDocx(viewer, bytes);
  return renderSheet(viewer, bytes, state);
}

async function renderPdf(viewer: HTMLElement, bytes: ArrayBuffer, signal?: AbortSignal, state?: PdfViewState): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
  signal?.throwIfAborted();
  const worker = new pdfjs.PDFWorker();
  // pdf.js hands the buffer to its worker, so it gets a copy and the tab keeps the original.
  // No annotation layer is drawn, so links and scripts in the PDF stay inert.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), enableXfa: false, worker });
  let disposed = false, loaded = false, releasePages = () => {};
  let cancel!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { cancel = reject; });
  const dispose = () => {
    if (disposed) return;
    disposed = true; signal?.removeEventListener('abort', dispose);
    releasePages();
    cancel(new DOMException('The document was closed.', 'AbortError'));
    // LoadingTask.destroy can wait for document setup; terminate our worker even during that wait.
    if (!loaded) worker.destroy();
    void task.destroy().catch(() => {}).finally(() => worker.destroy());
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    const doc = await Promise.race([task.promise, cancelled]);
    loaded = true;
    const first = (await Promise.race([doc.getPage(1), cancelled])).getViewport({ scale: 1 });
    const count = Math.min(doc.numPages, PDF_PAGES);
    viewer.dataset.kind = 'pdf';
    viewer.innerHTML = `<div class="office-bar">${doc.numPages.toLocaleString()} page${doc.numPages === 1 ? '' : 's'}${count < doc.numPages ? `<span>Showing the first ${count.toLocaleString()}.</span>` : ''}</div><div class="pdf-pages"></div>`;
    const pages = viewer.querySelector<HTMLElement>('.pdf-pages')!;
    const body = viewer.closest<HTMLElement>('.file-view-body');
    const bar = viewer.querySelector<HTMLElement>('.office-bar')!;
    const restoreAnchor = state?.anchor && state.anchor.page > 1 ? { ...state.anchor } : undefined;
    let restoringAnchor = Boolean(restoreAnchor), userScrolled = false, anchorSlotSettled = false, pendingAboveOrAt = 0, programmaticScroll = 0;
    const markProgrammaticScroll = () => {
      programmaticScroll++;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        programmaticScroll = Math.max(0, programmaticScroll - 1);
      }));
    };
    const applyAnchor = (anchor: { page: number; fraction: number }) => {
      if (!body) return;
      const slot = pages.children[anchor.page - 1];
      if (!slot) return;
      const rect = slot.getBoundingClientRect();
      if (!rect.height) return;
      const delta = rect.top - body.getBoundingClientRect().top - bar.offsetHeight + rect.height * anchor.fraction;
      if (Math.abs(delta) > 0.5) {
        markProgrammaticScroll();
        body.scrollTop += delta;
      }
      if (state) state.anchor = { ...anchor };
    };
    const stopRestore = () => { userScrolled = true; restoringAnchor = false; programmaticScroll = 0; };
    const finishRestoreTrack = () => {
      pendingAboveOrAt = Math.max(0, pendingAboveOrAt - 1);
      if (anchorSlotSettled && pendingAboveOrAt === 0 && !disposed && !userScrolled) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!disposed && !userScrolled && anchorSlotSettled && pendingAboveOrAt === 0) restoringAnchor = false;
        }));
      }
    };
    const savePosition = () => {
      // Hidden WebKit elements report zero geometry. Keep the last visible reading anchor.
      if (!state || !body?.getClientRects().length || programmaticScroll > 0 || (restoringAnchor && !userScrolled)) return;
      const edge = body.getBoundingClientRect().top + bar.offsetHeight;
      for (const slot of pages.children) {
        const rect = slot.getBoundingClientRect();
        if (rect.bottom <= edge || !rect.height) continue;
        state.anchor = { page: Number((slot as HTMLElement).dataset.page), fraction: (edge - rect.top) / rect.height };
        break;
      }
    };
    const renders = new Map<HTMLElement, { cancel(): void }>();
    const release = (slot: HTMLElement) => {
      renders.get(slot)?.cancel();
      const canvas = slot.querySelector('canvas');
      if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); }
    };
    // Pages draw as they come near the screen, so a long PDF opens as fast as a short one.
    const observer = new IntersectionObserver(entries => {
      if (disposed) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const slot = entry.target as HTMLElement;
        const tracked = Boolean(restoreAnchor && !userScrolled && restoringAnchor && Number(slot.dataset.page) <= restoreAnchor.page);
        if (tracked) pendingAboveOrAt++;
        void drawPage(slot, tracked).catch(error => {
          if (!disposed && error?.name !== 'RenderingCancelledException') slot.classList.add('failed');
        });
      }
    }, { root: viewer.closest('.file-view-body'), rootMargin: '600px 0px' });
    // Keep a wider buffer than the draw margin so small scrolls do not repeatedly rasterize a page.
    const retention = new IntersectionObserver(entries => {
      if (disposed) return;
      for (const entry of entries) {
        if (entry.isIntersecting) continue;
        const slot = entry.target as HTMLElement;
        release(slot);
        retention.unobserve(slot);
        observer.observe(slot);
      }
    }, { root: viewer.closest('.file-view-body'), rootMargin: '1800px 0px' });
    async function drawPage(slot: HTMLElement, trackedForRestore = false): Promise<void> {
      let untracked = trackedForRestore;
      try {
        const pageNumber = Number(slot.dataset.page);
        const page = await doc.getPage(pageNumber);
        if (disposed || !slot.isConnected) { page.cleanup(); return; }
        const width = Math.min(pages.clientWidth - 32, 1100);
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        // A page with an extreme shape would otherwise ask for an enormous canvas.
        const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(CANVAS_PIXELS / (viewport.width * viewport.height)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
        const aspect = viewport.width / viewport.height;
        const prevAspect = Number(slot.style.aspectRatio);
        const activeAnchor = restoreAnchor && !userScrolled
          ? restoreAnchor
          : state?.anchor && state.anchor.page > 1
            ? { ...state.anchor }
            : undefined;
        if (state) state.aspectRatios[pageNumber - 1] = aspect;
        slot.style.aspectRatio = String(aspect);
        slot.replaceChildren(canvas);
        if (activeAnchor && !disposed && body && pageNumber <= activeAnchor.page && (!Number.isFinite(prevAspect) || Math.abs(prevAspect - aspect) > 1e-4 || Boolean(restoreAnchor && !userScrolled))) {
          applyAnchor(activeAnchor);
          if (restoreAnchor && pageNumber === restoreAnchor.page) anchorSlotSettled = true;
        }
        if (untracked) { untracked = false; finishRestoreTrack(); }
        const render = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        renders.set(slot, render);
        retention.observe(slot);
        try { await render.promise; }
        finally { if (renders.get(slot) === render) renders.delete(slot); page.cleanup(); }
      } finally {
        if (untracked) finishRestoreTrack();
      }
    }
    for (let number = 1; number <= count; number++) {
      const slot = document.createElement('div');
      slot.className = 'pdf-page'; slot.dataset.page = String(number);
      slot.setAttribute('aria-label', `Page ${number}`);
      slot.style.aspectRatio = String(state?.aspectRatios[number - 1] ?? first.width / first.height);
      pages.append(slot);
    }
    if (body && state?.anchor) {
      applyAnchor(state.anchor);
    }
    for (const slot of pages.children) observer.observe(slot);
    body?.addEventListener('wheel', stopRestore, { passive: true });
    body?.addEventListener('pointerdown', stopRestore, { passive: true });
    body?.addEventListener('keydown', stopRestore);
    body?.addEventListener('scroll', savePosition);
    releasePages = () => {
      savePosition();
      body?.removeEventListener('wheel', stopRestore);
      body?.removeEventListener('pointerdown', stopRestore);
      body?.removeEventListener('keydown', stopRestore);
      body?.removeEventListener('scroll', savePosition);
      observer.disconnect(); retention.disconnect();
      for (const slot of pages.querySelectorAll<HTMLElement>('.pdf-page')) release(slot);
      viewer.replaceChildren();
    };
    return dispose;
  } catch (error) { dispose(); throw error; }
}

/** Wrapper look for docx-preview's pages; it lives in the shadow root with the document's own styles. */
const DOCX_FRAME = ':host{display:block;contain:layout paint;overflow:clip}.docx-wrapper{background:transparent;padding:24px 16px}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgb(0 0 0/.35);margin-bottom:16px}';

async function renderDocx(viewer: HTMLElement, bytes: ArrayBuffer): Promise<() => void> {
  const { renderAsync } = await import('docx-preview');
  viewer.dataset.kind = 'docx';
  viewer.innerHTML = '<div class="docx-host"></div>';
  // The document's CSS comes from the file itself, so it renders in a shadow root where its selectors
  // cannot reach the app, and paint containment keeps position:fixed content inside the panel.
  const shadow = viewer.querySelector<HTMLElement>('.docx-host')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${DOCX_FRAME}</style><div class="styles"></div><div class="body"></div>`;
  // altChunks are raw HTML parts that docx-preview would put in an iframe: never rendered.
  // Images become data: URLs because the app's CSP allows no blob: images.
  await renderAsync(bytes, shadow.querySelector<HTMLElement>('.body')!, shadow.querySelector<HTMLElement>('.styles')!, {
    inWrapper: true, useBase64URL: true, ignoreLastRenderedPageBreak: true, experimental: false, renderAltChunks: false,
  });
  return () => {
    shadow.replaceChildren();
    viewer.replaceChildren();
  };
}

async function renderSheet(viewer: HTMLElement, bytes: ArrayBuffer, state?: OfficeState): Promise<() => void> {
  const { read, utils } = await import('xlsx');
  const book = read(new Uint8Array(bytes), { type: 'array', dense: true, cellDates: true, sheetRows: SHEET_ROWS + 1 });
  viewer.dataset.kind = 'sheet';
  let lastTop = state?.sheetScrollTop ?? 0, lastLeft = state?.sheetScrollLeft ?? 0;
  const saveScroll = () => {
    const scroller = viewer.querySelector<HTMLElement>('.sheet-scroll');
    if (scroller?.getClientRects().length) {
      lastTop = scroller.scrollTop;
      lastLeft = scroller.scrollLeft;
      if (state) { state.sheetScrollTop = lastTop; state.sheetScrollLeft = lastLeft; }
    }
  };
  const show = (index: number, restoreScroll = false) => {
    const safeIndex = index >= 0 && index < book.SheetNames.length ? index : 0;
    if (state) state.sheet = safeIndex;
    if (!restoreScroll) {
      lastTop = 0; lastLeft = 0;
      if (state) { state.sheetScrollTop = 0; state.sheetScrollLeft = 0; }
    }
    const name = book.SheetNames[safeIndex], sheet = book.Sheets[name];
    const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : { s: { c: 0, r: 0 }, e: { c: 0, r: 0 } };
    const columns = Math.min(range.e.c - range.s.c + 1, SHEET_COLUMNS);
    const shown = rows.slice(0, SHEET_ROWS);
    const head = `<tr><th></th>${Array.from({ length: columns }, (_, c) => `<th>${utils.encode_col(range.s.c + c)}</th>`).join('')}</tr>`;
    const body = shown.map((row, r) => `<tr><th>${range.s.r + r + 1}</th>${Array.from({ length: columns }, (_, c) => `<td>${escape(row[c] ?? '')}</td>`).join('')}</tr>`).join('');
    const tabs = book.SheetNames.map((sheetName, i) => `<button type="button" data-sheet="${i}" aria-pressed="${i === safeIndex}">${escape(sheetName)}</button>`).join('');
    // sheetRows trims !ref while parsing; !fullref keeps the real size.
    const full = utils.decode_range(String(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1'));
    const more = full.e.r - full.s.r + 1 > SHEET_ROWS || full.e.c - full.s.c + 1 > SHEET_COLUMNS ? `<span>Showing the first ${SHEET_ROWS.toLocaleString()} rows and ${SHEET_COLUMNS} columns.</span>` : '';
    viewer.innerHTML = `<div class="office-bar sheet-tabs" role="group" aria-label="Sheets">${tabs}${more}</div><div class="sheet-scroll"><table class="sheet-grid" aria-label="${escape(name)}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    const scroller = viewer.querySelector<HTMLElement>('.sheet-scroll')!;
    scroller.addEventListener('scroll', saveScroll, { passive: true });
    if (restoreScroll && (lastTop || lastLeft)) {
      scroller.scrollTop = lastTop;
      scroller.scrollLeft = lastLeft;
    }
  };
  viewer.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-sheet]');
    if (button) show(Number(button.dataset.sheet));
  });
  show(state?.sheet ?? 0, true);
  return () => {
    saveScroll();
    if (state) { state.sheetScrollTop = lastTop; state.sheetScrollLeft = lastLeft; }
    viewer.replaceChildren();
  };
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };

/** An image fitted to the tab; clicking it switches between fitted and actual size. */
async function renderImage(viewer: HTMLElement, bytes: ArrayBuffer, path: string, signal?: AbortSignal, state?: OfficeState): Promise<() => void> {
  const type = IMAGE_TYPES[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
  // A data: URL because the app's CSP allows no blob: images; an SVG shown through <img> runs no scripts.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type }));
  });
  signal?.throwIfAborted();
  const image = new Image();
  image.alt = path.split('/').pop() ?? path;
  image.src = url;
  try {
    await image.decode().catch(() => { throw new Error('The image could not be decoded.'); });
    signal?.throwIfAborted();
  } catch (error) {
    image.src = '';
    image.removeAttribute('src');
    throw error;
  }
  const actual = Boolean(state?.actual);
  viewer.dataset.kind = 'image';
  viewer.toggleAttribute('data-actual', actual);
  viewer.innerHTML = `<div class="office-bar sheet-tabs">${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} px<button type="button" data-zoom aria-pressed="${actual}">Actual size</button></div><div class="image-stage"></div>`;
  const stage = viewer.querySelector<HTMLElement>('.image-stage')!;
  const saveScroll = () => {
    if (state && stage.getClientRects().length > 0 && viewer.hasAttribute('data-actual')) {
      state.imageScrollLeft = stage.scrollLeft;
      state.imageScrollTop = stage.scrollTop;
    }
  };
  const zoom = viewer.querySelector<HTMLElement>('[data-zoom]')!;
  const toggle = () => {
    const next = viewer.toggleAttribute('data-actual');
    zoom.setAttribute('aria-pressed', String(next));
    if (state) {
      state.actual = next;
      if (!next) { state.imageScrollLeft = 0; state.imageScrollTop = 0; }
    }
  };
  image.title = 'Click to toggle actual size';
  image.addEventListener('click', toggle); zoom.addEventListener('click', toggle);
  stage.append(image);
  if (actual && (state?.imageScrollLeft || state?.imageScrollTop)) {
    stage.scrollLeft = state.imageScrollLeft ?? 0;
    stage.scrollTop = state.imageScrollTop ?? 0;
  }
  stage.addEventListener('scroll', saveScroll, { passive: true });
  return () => {
    saveScroll();
    stage.removeEventListener('scroll', saveScroll);
    image.removeEventListener('click', toggle);
    zoom.removeEventListener('click', toggle);
    image.src = '';
    image.removeAttribute('src');
    viewer.replaceChildren();
  };
}
