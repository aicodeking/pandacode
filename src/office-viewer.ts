// PDF, Word and spreadsheet files in a file tab. Loaded only when one is opened: each format's
// library is its own chunk. Everything renders locally; nothing is fetched.
import './office-viewer.css';
import { escape } from './dom';
import { checkUnzippedSize } from './zip-limit';

export type OfficeKind = 'pdf' | 'docx' | 'sheet' | 'image';
/** Spreadsheets show this many rows per sheet; the rest are counted, not drawn. */
const SHEET_ROWS = 2000;
const SHEET_COLUMNS = 200;
/** A document is untrusted input: these bound what it can make the window allocate. */
const PDF_PAGES = 5000;
const CANVAS_PIXELS = 16_000_000;

export async function renderOffice(host: HTMLElement, kind: OfficeKind, bytes: ArrayBuffer, path = ''): Promise<() => void> {
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
  if (kind === 'image') return renderImage(viewer, bytes, path);
  if (kind !== 'pdf') checkUnzippedSize(bytes);
  if (kind === 'pdf') return renderPdf(viewer, bytes);
  if (kind === 'docx') return renderDocx(viewer, bytes);
  return renderSheet(viewer, bytes);
}

async function renderPdf(viewer: HTMLElement, bytes: ArrayBuffer): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
  // pdf.js hands the buffer to its worker, so it gets a copy and the tab keeps the original.
  // No annotation layer is drawn, so links and scripts in the PDF stay inert.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), enableXfa: false });
  const doc = await task.promise;
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const count = Math.min(doc.numPages, PDF_PAGES);
  viewer.dataset.kind = 'pdf';
  viewer.innerHTML = `<div class="office-bar">${doc.numPages.toLocaleString()} page${doc.numPages === 1 ? '' : 's'}${count < doc.numPages ? `<span>Showing the first ${count.toLocaleString()}.</span>` : ''}</div><div class="pdf-pages"></div>`;
  const pages = viewer.querySelector<HTMLElement>('.pdf-pages')!;
  // Pages draw as they come near the screen, so a long PDF opens as fast as a short one.
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      void drawPage(entry.target as HTMLElement).catch(() => entry.target.classList.add('failed'));
    }
  }, { root: viewer.closest('.file-view-body'), rootMargin: '600px 0px' });
  async function drawPage(slot: HTMLElement): Promise<void> {
    const page = await doc.getPage(Number(slot.dataset.page));
    const width = Math.min(pages.clientWidth - 32, 1100);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    // A page with an extreme shape would otherwise ask for an enormous canvas.
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(CANVAS_PIXELS / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
    slot.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    slot.replaceChildren(canvas);
    await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
  }
  for (let number = 1; number <= count; number++) {
    const slot = document.createElement('div');
    slot.className = 'pdf-page'; slot.dataset.page = String(number);
    slot.setAttribute('aria-label', `Page ${number}`);
    slot.style.aspectRatio = `${first.width} / ${first.height}`;
    pages.append(slot); observer.observe(slot);
  }
  return () => { observer.disconnect(); void task.destroy(); };
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
  return () => {};
}

async function renderSheet(viewer: HTMLElement, bytes: ArrayBuffer): Promise<() => void> {
  const { read, utils } = await import('xlsx');
  const book = read(new Uint8Array(bytes), { type: 'array', dense: true, cellDates: true, sheetRows: SHEET_ROWS + 1 });
  viewer.dataset.kind = 'sheet';
  const show = (index: number) => {
    const name = book.SheetNames[index], sheet = book.Sheets[name];
    const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : { s: { c: 0, r: 0 }, e: { c: 0, r: 0 } };
    const columns = Math.min(range.e.c - range.s.c + 1, SHEET_COLUMNS);
    const shown = rows.slice(0, SHEET_ROWS);
    const head = `<tr><th></th>${Array.from({ length: columns }, (_, c) => `<th>${utils.encode_col(range.s.c + c)}</th>`).join('')}</tr>`;
    const body = shown.map((row, r) => `<tr><th>${range.s.r + r + 1}</th>${Array.from({ length: columns }, (_, c) => `<td>${escape(row[c] ?? '')}</td>`).join('')}</tr>`).join('');
    const tabs = book.SheetNames.map((sheetName, i) => `<button type="button" data-sheet="${i}" aria-pressed="${i === index}">${escape(sheetName)}</button>`).join('');
    // sheetRows trims !ref while parsing; !fullref keeps the real size.
    const full = utils.decode_range(String(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1'));
    const more = full.e.r - full.s.r + 1 > SHEET_ROWS || full.e.c - full.s.c + 1 > SHEET_COLUMNS ? `<span>Showing the first ${SHEET_ROWS.toLocaleString()} rows and ${SHEET_COLUMNS} columns.</span>` : '';
    viewer.innerHTML = `<div class="office-bar sheet-tabs" role="group" aria-label="Sheets">${tabs}${more}</div><div class="sheet-scroll"><table class="sheet-grid" aria-label="${escape(name)}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  };
  viewer.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-sheet]');
    if (button) show(Number(button.dataset.sheet));
  });
  show(0);
  return () => {};
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };

/** An image fitted to the tab; clicking it switches between fitted and actual size. */
async function renderImage(viewer: HTMLElement, bytes: ArrayBuffer, path: string): Promise<() => void> {
  const type = IMAGE_TYPES[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
  // A data: URL because the app's CSP allows no blob: images; an SVG shown through <img> runs no scripts.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type }));
  });
  const image = new Image();
  image.alt = path.split('/').pop() ?? path;
  image.src = url;
  await image.decode().catch(() => { throw new Error('The image could not be decoded.'); });
  viewer.dataset.kind = 'image';
  viewer.innerHTML = `<div class="office-bar sheet-tabs">${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} px<button type="button" data-zoom aria-pressed="false">Actual size</button></div><div class="image-stage"></div>`;
  const zoom = viewer.querySelector<HTMLElement>('[data-zoom]')!;
  const toggle = () => zoom.setAttribute('aria-pressed', String(viewer.toggleAttribute('data-actual')));
  image.title = 'Click to toggle actual size';
  image.addEventListener('click', toggle); zoom.addEventListener('click', toggle);
  viewer.querySelector('.image-stage')!.append(image);
  return () => {};
}
