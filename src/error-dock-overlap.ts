/* Error rows in a turn card (styles.css `.turn-card-errors`) keep their controls at the card's right edge, in line with
 * the card's own controls (Workers ⋯, Run). They move left only by how far the floating action dock actually reaches
 * over the card, which happens in narrow panes: this writes that reach to `--error-dock-overlap` on the transcript.
 * It depends on the pane's geometry only, never on scrolling, so rows never reflow as they scroll past the dock. */

/** The gap kept between a card's controls and the dock's left edge. */
const DOCK_GAP = 10;
/** Fallback column max-width matching `.transcript > *` in styles.css before a card is mounted. */
const DEFAULT_COLUMN_MAX = 830;

/** How far, in px, the dock reaches over cards whose right edge is `cardRight` (0 when it sits clear of them). */
export function dockOverlap(cardRight: number, dock: { left: number; width: number } | null): number {
  if (!dock || dock.width <= 0 || !Number.isFinite(cardRight)) return 0;
  return Math.max(0, Math.ceil(cardRight - (dock.left - DOCK_GAP)));
}

/** The right edge of the transcript's centred column (every direct child shares it), without needing a card in it. */
function columnRight(transcript: HTMLElement): number {
  const style = getComputedStyle(transcript), rect = transcript.getBoundingClientRect();
  const padLeft = parseFloat(style.paddingLeft) || 0, padRight = parseFloat(style.paddingRight) || 0;
  const content = transcript.clientWidth - padLeft - padRight;
  const probe = transcript.querySelector<HTMLElement>(':scope > .turn-card, :scope > #stream-region');
  const limit = probe ? parseFloat(getComputedStyle(probe).maxWidth) : DEFAULT_COLUMN_MAX;
  const column = Number.isFinite(limit) ? Math.min(limit, content) : content;
  return rect.left + (transcript.clientLeft || 0) + padLeft + (content + column) / 2;
}

/** Steady-state horizontal box of a floating dock, ignoring WAAPI entrance transforms and header-row dock modes. */
function floatingDockBox(dock: HTMLElement): { left: number; width: number } | null {
  if (getComputedStyle(dock).position !== 'absolute' || dock.offsetWidth <= 0) return null;
  const parent = dock.offsetParent as HTMLElement | null;
  const left = (parent ? parent.getBoundingClientRect().left + (parent.clientLeft || 0) : 0) + dock.offsetLeft;
  return { left, width: dock.offsetWidth };
}

export function watchErrorDockOverlap(transcript: HTMLElement, dock: HTMLElement | null): void {
  if (!dock) return;
  let frame = 0, last = '';
  const update = () => {
    frame = 0;
    const value = `${dockOverlap(columnRight(transcript), floatingDockBox(dock))}px`;
    if (value !== last) { last = value; transcript.style.setProperty('--error-dock-overlap', value); }
  };
  // The dock repositions in its own frame after a resize, so measure on the frame after.
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(update); }); };
  new ResizeObserver(schedule).observe(transcript);
  new ResizeObserver(schedule).observe(dock);
  const mutations = new MutationObserver(schedule);
  mutations.observe(transcript, { childList: true });
  mutations.observe(dock, { attributes: true, attributeFilter: ['style'] });
  const pane = transcript.closest('.conversation-pane');
  if (pane) mutations.observe(pane, { attributes: true, attributeFilter: ['style'] });
  const workspace = transcript.closest('.workspace');
  if (workspace) mutations.observe(workspace, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', schedule);
  schedule();
}
