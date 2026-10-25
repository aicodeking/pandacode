// PDF, Word and spreadsheet files in a file tab. Loaded only when one is opened: each format's
// library is its own chunk. Everything renders locally; nothing is fetched.
import './office-viewer.css';
import { escape } from './dom';
import { checkUnzippedSize } from './zip-limit';
import { t } from './i18n.ts';

export type OfficeKind = 'pdf' | 'docx' | 'sheet' | 'image';
/** Spreadsheets show this many rows per sheet; the rest are counted, not drawn. */
const SHEET_ROWS = 2000;
const SHEET_COLUMNS = 200;
/** A document is untrusted input: these bound what it can make the window allocate. */
const PDF_PAGES = 5000;
const CANVAS_PIXELS = 16_000_000;

  try {
    await image.decode().catch(() => { throw new Error(t('The image could not be decoded.')); });
    signal?.throwIfAborted();
  } catch (error) {
    image.src = '';
    image.removeAttribute('src');
    throw error;
  }
  const actual = Boolean(state?.actual);
  viewer.dataset.kind = 'image';
  viewer.toggleAttribute('data-actual', actual);
  viewer.innerHTML = `<div class="office-bar sheet-tabs">${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} px<button type="button" data-zoom aria-pressed="${actual}">${t('Actual size')}</button></div><div class="image-stage"></div>`;
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
  image.title = t('Click to toggle actual size');
