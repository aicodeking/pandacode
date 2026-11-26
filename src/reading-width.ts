import { trackSegment } from './motion';

/* Reading width: how wide the thread and the composer run. Comfortable is the documented measure
 * (--reading-width/--composer-width in tokens.css: 830px and 950px); Wide follows a large window for
 * code- and table-heavy threads (1040px and 1160px). It is a rendering preference, so it lives in
 * localStorage and applies as html[data-reading-width="wide"], which switches the two tokens. */

type ReadingWidth = 'comfortable' | 'wide';

const preferenceKey = 'pandacode.readingWidth';
const ORDER: ReadingWidth[] = ['comfortable', 'wide'];
const LABELS: Record<ReadingWidth, string> = { comfortable: 'Comfortable', wide: 'Wide' };

let width: ReadingWidth = 'comfortable';
try {
  const saved = localStorage.getItem(preferenceKey);
  if (saved === 'comfortable' || saved === 'wide') width = saved;
} catch { /* The default measure stays. */ }
apply();

export function readingWidth(): ReadingWidth { return width; }

function apply(): void {
  if (width === 'wide') document.documentElement.dataset.readingWidth = 'wide';
  else delete document.documentElement.dataset.readingWidth;
}

export function setReadingWidth(next: ReadingWidth): void {
  if (next === width) return;
  width = next;
  apply();
  try { localStorage.setItem(preferenceKey, next); } catch { /* Keep it for this session. */ }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reading-width]')) {
    button.setAttribute('aria-pressed', String(button.dataset.readingWidth === next));
  }
  // Menus, the action dock and the native browser's bounds are measured: they follow the new column.
  window.dispatchEvent(new Event('resize'));
}

/** The Appearance row's control: a two-option segmented track; options keep the regular body weight (see AGENTS.md). */
export function readingWidthControl(): string {
  return `<div class="ds-seg" role="group" aria-label="Reading width">${ORDER.map(id => `<button type="button" data-reading-width="${id}" aria-pressed="${id === width}">${LABELS[id]}</button>`).join('')}</div>`;
}

/** Wire the row's track after Settings renders it, so the thumb sits on the chosen option and follows clicks. */
export function mountReadingWidthControl(host: HTMLElement): () => void {
  const track = host.querySelector<HTMLElement>('.ds-seg[aria-label="Reading width"]');
  if (!track) return () => undefined;
  trackSegment(track, track.querySelector<HTMLElement>('[aria-pressed="true"]'));
  const click = (event: MouseEvent): void => {
    const option = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-reading-width]');
    if (!option || !track.contains(option)) return;
    setReadingWidth(option.dataset.readingWidth as ReadingWidth);
    trackSegment(track, option);
  };
  track.addEventListener('click', click);
  return () => track.removeEventListener('click', click);
}
