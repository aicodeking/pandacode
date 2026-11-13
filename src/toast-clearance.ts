/* A toast that stays until closed (one with a close button, the crash notice) must never cover
 * panel content the user works in: the composer, the inspector (file tree, Git list, commit form)
 * or the action dock. It sits in the conversation pane instead: its right edge 16px inside the
 * pane (or 8px left of an inspector drawn over the pane, or of the dock when it would reach it), its
 * bottom 8px above the composer, or 16px above the pane's bottom when there is no composer. It
 * may cover the transcript, which then gets as much room at its end (`--toast-room` on the
 * transcript, an end spacer in turn-card.css), so its last message can scroll clear of the
 * toast; a transcript at its bottom stays there. The place is set through `--toast-right`,
 * `--toast-lift` and `--toast-max` (read by `.toast.toast-dismissible` in design-system.css), at
 * once, never animated (layout never animates). In the board and GitHub views (no composer) it
 * sits 16px inside the pane's bottom right, and the view's scroller gets the room instead, so its
 * last cards or rows can scroll clear. Settings covers the whole workspace and has controls down
 * its right side at any width, so there the notice steps aside (`visibility: hidden` in
 * design-system.css) and is back, unchanged, when Settings closes. Beside an inspector drawn over
 * the pane with less than MIN_WIDTH left of it, the notice never covers the drawer: it steps aside
 * the same way (`data-crowded`) and is back, unannounced, once there is room or the drawer closes.
 * Ordinary toasts keep their corner because they leave by themselves. */
/** MIN_WIDTH: the narrowest the notice is drawn, starting GAP inside the pane. */
const GAP = 8, INSET = 16, MIN_WIDTH = 180;
const CROWDED = 'data-crowded';
/** The text each toast last showed on screen: stepping aside after that, it comes back unannounced. */
const shownText = new WeakMap<HTMLElement, string>();
const PROPS = ['--toast-right', '--toast-lift', '--toast-max'] as const;
const ROOM = '--toast-room';
/** The board's and the GitHub view's scrollers, which get the room when the notice sits over them. */
const VIEW_SCROLLERS = '#project-board .board-columns, #github-hub .gh-body';
const WATCHED_VIEWS = ['#settings-page', '#project-board', '#github-hub'];

type Rect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
const visible = (element: Element | null): Rect | undefined => {
  const rect = element?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
};

/** Gives the transcript `room` px at its end (0: none), at once; one at its bottom stays there. */
export function makeRoom(transcript: HTMLElement | null, room: number): void {
  const value = room > 0 ? `${Math.round(room)}px` : '';
  if (!transcript || transcript.style.getPropertyValue(ROOM) === value) return;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 2;
  if (value) transcript.style.setProperty(ROOM, value); else transcript.style.removeProperty(ROOM);
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

/** Places the toast now: in the conversation pane, above the composer, clear of the inspector and dock. */
export function placeToast(toast: HTMLElement, composer: HTMLElement): void {
  for (const prop of PROPS) toast.style.removeProperty(prop);
  toast.removeAttribute(CROWDED);
  const transcript = composer.parentElement?.querySelector<HTMLElement>(':scope > .transcript') ?? null;
  const scrollers = [transcript, ...document.querySelectorAll<HTMLElement>(VIEW_SCROLLERS)];
  const clear = () => { for (const scroller of scrollers) makeRoom(scroller, 0); };
  // Settings open: hidden by CSS, nothing to place.
  if (toast.hidden || !toast.classList.contains('toast-dismissible') || document.querySelector('#settings-page:not([hidden])')) { clear(); return; }
  const pane = visible(composer.closest('.main-pane') ?? document.querySelector('.main-pane'));
  if (!pane) { clear(); return; }
  const inspector = visible(document.querySelector('#inspector'));
  let right = pane.right - INSET;
  // An inspector drawn over the pane (a narrow window) is avoided too; with too little room left of it, the notice steps aside.
  const drawer = Boolean(inspector && inspector.left > pane.left && inspector.left < right + INSET);
  if (inspector && drawer) right = inspector.left - GAP;
  if (drawer && right - pane.left - GAP < MIN_WIDTH) {
    // Already read out with this text: back later without another announcement.
    if (shownText.get(toast) === toast.textContent) toast.setAttribute('aria-live', 'off');
    toast.setAttribute(CROWDED, '');
    clear();
    return;
  }
  shownText.set(toast, toast.textContent ?? '');
  const area = visible(composer);
  const bottom = area ? area.top - GAP : pane.bottom - INSET;
  const set = (edge: number) => {
    toast.style.setProperty('--toast-right', `${Math.round(window.innerWidth - edge)}px`);
    toast.style.setProperty('--toast-max', `${Math.round(Math.max(MIN_WIDTH, edge - pane.left - GAP))}px`);
  };
  toast.style.setProperty('--toast-lift', `${Math.round(window.innerHeight - bottom)}px`);
  set(right);
  // The dock floats at the pane's top right: a tall notice moves left of it rather than over it.
  const dock = visible(document.querySelector('#action-dock'));
  if (dock && dock.left < right && bottom - toast.offsetHeight < dock.bottom + GAP) set(Math.max(dock.left - GAP, pane.left + GAP + MIN_WIDTH));
  // What it covers of the scroller under it (the transcript, else the board's or GitHub's): from
  // its top edge to the scroller's bottom.
  const under = area ? transcript : scrollers.find(scroller => scroller !== transcript && visible(scroller)) ?? null;
  const shown = visible(under);
  for (const scroller of scrollers) makeRoom(scroller, scroller === under && shown ? shown.bottom - (bottom - toast.offsetHeight) : 0);
}

/** Keeps the toast clear as it, the composer or the panes change size or place, or the window resizes. */
export function keepToastClear(toast: HTMLElement, composer: HTMLElement): void {
  const place = () => placeToast(toast, composer);
  const resized = new ResizeObserver(place);
  // The views: opening Settings, the board or GitHub changes their size from nothing.
  const watched = [toast, composer, composer.parentElement, composer.closest('.main-pane'), document.querySelector('#inspector'), document.querySelector('#action-dock'), ...WATCHED_VIEWS.map(selector => document.querySelector(selector))];
  for (const element of watched) if (element) resized.observe(element);
  new MutationObserver(place).observe(toast, { attributes: true, attributeFilter: ['hidden', 'class'] });
  // The board and GitHub views draw their scrollers after they show (GitHub's module loads late).
  const drawn = new MutationObserver(place);
  for (const selector of WATCHED_VIEWS.slice(1)) { const view = document.querySelector(selector); if (view) drawn.observe(view, { childList: true, subtree: true }); }
  window.addEventListener('resize', place);
}
