import { reducedMotion, springEasing, type Spring } from './motion';

/* The floating action dock (`#action-dock`): the workspace header's actions as one vertical glass
 * pill at the conversation's right edge, centred between the header and the composer (a row in the
 * header on narrow windows, the board and the GitHub view). Like the tool trace it is an exception
 * to "PandaCode is instant": every motion is the Web Animations API or @keyframes (never
 * transitions) and is skipped under reduced motion, when the CSS end state simply applies. Other
 * modules keep owning the buttons: they toggle `hidden`, `active` and `title`, and the observer
 * here animates whatever changed. */

/** One spring for items, bubbles and placement: quick, with a hint of overshoot (about 267 ms).
 * The hover pill travels further, so it gets a slightly softer one (about 367 ms). */
export const DOCK_SPRING: Spring = { damping: 0.85, response: 0.2 };
export const PILL_SPRING: Spring = { damping: 0.85, response: 0.28 };
const STAGGER = 16, TIP_DELAY = 350, TIP_WARM = 300, GAP = 12;
type Curve = { easing: string; duration: number };
const curves = new Map<Spring, Curve>();
const curve = (spring = DOCK_SPRING): Curve => {
  let found = curves.get(spring);
  if (!found) { found = springEasing(spring) ?? { easing: 'cubic-bezier(.2,.9,.3,1.05)', duration: spring === DOCK_SPRING ? 260 : 360 }; curves.set(spring, found); }
  return found;
};
const still = (): boolean => document.hidden || reducedMotion();
/** Startup renders (the first layout, restored panels) settle without motion; anything after the
 * first press or key is animated. */
let interacted = false;
for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => { interacted = true; }, { capture: true, once: true });
const running = new WeakMap<Element, Map<string, Animation>>();
function track(element: Element, animation: Animation, pseudo = ''): Animation {
  const map = running.get(element) ?? new Map<string, Animation>();
  map.get(pseudo)?.cancel();
  map.set(pseudo, animation); running.set(element, map);
  return animation;
}
const cancel = (element: Element, pseudo = '') => running.get(element)?.get(pseudo)?.cancel();

/** Animates `element` from what is on screen now to the state `change()` leaves in CSS. Reads
 * before the change, so an interrupted motion continues from where it was. */
function morph(element: Element, props: string[], change: () => void, spring = DOCK_SPRING): void {
  const style = getComputedStyle(element);
  const before = Object.fromEntries(props.map(prop => [prop, style.getPropertyValue(prop)]));
  cancel(element);
  change();
  if (still() || typeof element.animate !== 'function') return;
  const { easing, duration } = curve(spring);
  track(element, element.animate([{ ...before, offset: 0 }], { duration, easing }));
}

const buttons = (dock: HTMLElement) => [...dock.querySelectorAll<HTMLButtonElement>('button')];
/** Items you can reach: shown (not hidden or display:none by a stylesheet) and not leaving. */
export const dockItems = (dock: HTMLElement): HTMLButtonElement[] =>
  buttons(dock).filter(item => !item.hidden && !item.hasAttribute('data-leaving') && item.getClientRects().length > 0);
const vertical = (dock: HTMLElement) => getComputedStyle(dock).flexDirection.startsWith('column');
const floating = (dock: HTMLElement) => getComputedStyle(dock).position === 'absolute';
const labelOf = (item: HTMLElement) => item.dataset.dockTip || item.getAttribute('aria-label') || item.textContent?.trim() || '';

/** One Tab stop: the last focused item, else the first. */
function rove(dock: HTMLElement, focus?: HTMLElement): void {
  const items = dockItems(dock);
  const current = focus && items.includes(focus as HTMLButtonElement) ? focus : items.find(item => item.tabIndex === 0) ?? items[0];
  for (const item of buttons(dock)) item.tabIndex = item === current ? 0 : -1;
  dock.setAttribute('aria-orientation', vertical(dock) ? 'vertical' : 'horizontal');
}

/** The shared hover pill: slides to the item under the pointer or focus, fades out on leave. */
function indicator(dock: HTMLElement) {
  const pill = document.createElement('span');
  pill.className = 'action-dock-indicator'; pill.setAttribute('aria-hidden', 'true');
  dock.prepend(pill);
  let target: HTMLElement | undefined;
  const to = (item?: HTMLElement, force = false) => {
    if (item === target && !force) return;
    target = item;
    if (!item) { morph(pill, ['opacity', 'scale'], () => pill.removeAttribute('data-on'), PILL_SPRING); return; }
    const place = () => {
      pill.style.translate = `${item.offsetLeft}px ${item.offsetTop}px`; pill.style.height = `${item.offsetHeight}px`;
      pill.setAttribute('data-on', ''); pill.toggleAttribute('data-muted', item.classList.contains('active'));
    };
    // From nothing it appears in place; while shown (even dissolved over an active item, or still
    // fading out) it glides along.
    if (!pill.hasAttribute('data-on') && Number(getComputedStyle(pill).opacity) < 0.05) { cancel(pill); place(); pill.removeAttribute('data-on'); }
    morph(pill, ['translate', 'height', 'opacity', 'scale'], place, PILL_SPRING);
  };
  return { to, get target() { return target; } };
}

/** The dock's label bubble: left of a vertical dock, below a row. It lives beside the dock in
 * the header so its glass blurs the thread, and it widens or narrows with each label. */
function tooltip(dock: HTMLElement) {
  const host = dock.parentElement!;
  const tip = document.createElement('div');
  tip.className = 'action-dock-tip'; tip.setAttribute('role', 'tooltip'); tip.id = 'action-dock-tip'; tip.hidden = true;
  host.append(tip);
  let anchor: HTMLElement | undefined, leave: Animation | undefined, timer = 0, hiddenAt = 0;
  const warm = () => (!tip.hidden && !leave) || performance.now() - hiddenAt < TIP_WARM;
  const show = (item: HTMLElement) => {
    clearTimeout(timer);
    const text = labelOf(item);
    if (!text || item.hasAttribute('data-dock-notip')) return;
    const wasShown = !tip.hidden && !leave;
    const before = wasShown ? { box: tip.getBoundingClientRect(), side: tip.dataset.side } : undefined;
    leave?.cancel(); leave = undefined;
    anchor = item; tip.textContent = text; tip.hidden = false; tip.style.width = '';
    const row = !vertical(dock), box = item.getBoundingClientRect(), frame = host.getBoundingClientRect();
    tip.dataset.side = row ? 'below' : 'left';
    if (row) {
      const half = tip.offsetWidth / 2, centre = Math.min(Math.max(box.left + box.width / 2, half + 8), innerWidth - half - 8);
      Object.assign(tip.style, { left: `${Math.round(centre - frame.left)}px`, right: '', top: `${Math.round(box.bottom - frame.top + 8)}px` });
    } else {
      const edge = dock.getBoundingClientRect().left;
      Object.assign(tip.style, { right: `${Math.round(frame.right - edge + 10)}px`, left: '', top: `${Math.round(box.top - frame.top + box.height / 2)}px` });
    }
    if (still() || typeof tip.animate !== 'function') return;
    const { easing, duration } = curve();
    if (before && before.side === tip.dataset.side) {
      // Slide from the last item and change width as the label changes, from the anchored edge.
      const after = tip.getBoundingClientRect();
      const dx = row ? (before.box.left + before.box.width / 2) - (after.left + after.width / 2) : before.box.right - after.right;
      const dy = (before.box.top + before.box.height / 2) - (after.top + after.height / 2);
      tip.animate([{ translate: `${dx}px ${dy}px`, width: `${before.box.width}px`, offset: 0 }, { translate: '0 0', width: `${after.width}px` }], { duration, easing });
    } else {
      tip.animate([{ opacity: 0, scale: 0.9, translate: row ? '0 -4px' : '6px 0', offset: 0 }], { duration, easing });
    }
  };
  /** Pointer hover waits a moment unless a bubble is already up (or just left), iOS style. */
  const hover = (item: HTMLElement) => {
    clearTimeout(timer);
    if (warm() || still()) show(item); else timer = window.setTimeout(() => show(item), TIP_DELAY);
  };
  const hide = () => {
    clearTimeout(timer);
    anchor = undefined;
    if (tip.hidden || leave) return;
    hiddenAt = performance.now();
    if (still() || typeof tip.animate !== 'function') { tip.hidden = true; return; }
    leave = tip.animate([{ opacity: 0, scale: 0.96 }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
    leave.onfinish = () => { tip.hidden = true; leave?.cancel(); leave = undefined; hiddenAt = performance.now(); };
  };
  return { show, hover, hide, get anchor() { return anchor; } };
}

function hover(item: HTMLElement, on: boolean): void {
  if (item.hasAttribute('data-hover') === on) return;
  const icon = item.querySelector('.icon');
  if (icon) morph(icon, ['scale'], () => item.toggleAttribute('data-hover', on)); else item.toggleAttribute('data-hover', on);
}
function press(item: HTMLElement, on: boolean): void {
  if (item.hasAttribute('data-press') === on) return;
  const icon = item.querySelector('.icon');
  const target = item.matches('[aria-haspopup]') && icon ? icon : item;
  morph(target, ['scale'], () => item.toggleAttribute('data-press', on));
}

/** The slot an item collapses from or grows into: its height in a column, its width in a row. */
const slot = (dock: HTMLElement): Keyframe => vertical(dock) ? { height: '0px', marginBlock: '-2px' } : { width: '0px', marginInline: '-1px' };
/** A group's separator folds with it: its length across the dock's axis and its margins. */
const rule = (dock: HTMLElement): Keyframe => vertical(dock) ? { opacity: 0, height: '0px', marginBlock: '0px' } : { opacity: 0, width: '0px', marginInline: '0px' };
/** True when `item` is the only shown item of a group that has a separator (not the first group). */
const lone = (item: HTMLElement): HTMLElement | undefined => {
  const group = item.parentElement;
  if (!group?.matches('.action-dock-group+.action-dock-group')) return undefined;
  const others = [...group.querySelectorAll<HTMLButtonElement>(':scope>button')].filter(other => other !== item && !other.hidden);
  return others.length ? undefined : group;
};
const LEAVE = 'cubic-bezier(.4,0,.6,1)';
function appear(dock: HTMLElement, item: HTMLButtonElement): void {
  cancel(item);
  item.removeAttribute('data-leaving'); item.removeAttribute('aria-hidden'); item.inert = false;
  if (still() || typeof item.animate !== 'function') return;
  const { easing, duration } = curve();
  track(item, item.animate([{ opacity: 0, scale: 0.5, ...slot(dock), offset: 0 }], { duration, easing }));
  const group = lone(item);
  if (group) track(group, group.animate([{ ...rule(dock), offset: 0 }], { duration, easing, pseudoElement: '::before' }), '::before');
}
function disappear(dock: HTMLElement, item: HTMLButtonElement): void {
  if (still() || typeof item.animate !== 'function') return;
  item.setAttribute('data-leaving', ''); item.setAttribute('aria-hidden', 'true'); item.inert = true;
  const duration = curve().duration * 0.7, group = lone(item);
  const animation = track(item, item.animate([{ opacity: 0, scale: 0.5, ...slot(dock) }], { duration, easing: LEAVE, fill: 'forwards' }));
  // The group stays laid out (it still holds a leaving item) while its separator folds away.
  const separator = group && track(group, group.animate([rule(dock)], { duration, easing: LEAVE, fill: 'forwards', pseudoElement: '::before' }), '::before');
  animation.onfinish = () => { item.removeAttribute('data-leaving'); item.removeAttribute('aria-hidden'); item.inert = false; animation.cancel(); separator?.cancel(); };
}

/** The staggered entrance, once per app session (a remount or reload in the same window skips it). */
const ENTERED = 'pandacode.actionDock.entered';
export function enterDock(dock: HTMLElement): void {
  try { if (sessionStorage.getItem(ENTERED)) return; sessionStorage.setItem(ENTERED, '1'); } catch { /* storage off: play it */ }
  if (still() || typeof dock.animate !== 'function') return;
  const row = !vertical(dock);
  const { easing, duration } = curve();
  if (!row) dock.animate([{ opacity: 0, scale: 0.94, translate: '10px 0', offset: 0 }], { duration, easing });
  dockItems(dock).forEach((item, index) => {
    item.animate([{ opacity: 0, scale: 0.7, translate: row ? '0 -4px' : '6px 0', offset: 0 }], { duration, easing, delay: 40 + index * STAGGER, fill: 'backwards' });
  });
}

/** Centres a floating dock in the free space between the header (and any file tabs) and the
 * composer, clamped `GAP` from both; a short pane pins it under the header. */
function placement(dock: HTMLElement, ready: () => void) {
  const header = dock.parentElement!;
  let frame = 0, placed = false, follow = false;
  const place = () => {
    frame = 0;
    const following = follow; follow = false;
    if (!floating(dock)) { dock.style.top = ''; placed = false; ready(); return; }
    const pane = document.querySelector<HTMLElement>('.conversation-pane');
    const composer = document.querySelector<HTMLElement>('#composer-area');
    const top = header.getBoundingClientRect(), height = dock.offsetHeight;
    const start = top.bottom + GAP;
    const composerTop = composer && composer.getClientRects().length ? composer.getBoundingClientRect().top : pane?.getBoundingClientRect().bottom ?? innerHeight;
    // The entrance waits for the composer, so the dock arrives where it stays.
    if (composer?.offsetHeight) ready();
    const end = composerTop - GAP;
    const y = Math.round(Math.max(start, Math.min((start + end - height) / 2, end - height)));
    const next = `${y - top.top}px`, previous = dock.style.top;
    if (next === previous) return;
    const shift = placed && previous ? parseFloat(previous) - (y - top.top) : 0;
    dock.style.top = next; placed = true;
    // A move (the composer grew, the terminal opened) springs from where the dock was.
    if (following) cancel(dock, 'move');
    if (shift && !following && interacted && !still() && typeof dock.animate === 'function') { const { easing, duration } = curve(); track(dock, dock.animate([{ translate: `0 ${shift}px`, offset: 0 }], { duration, easing }), 'move'); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  // While the dock itself grows or shrinks (an item springing in or out) the centring follows it
  // frame by frame, so it needs no spring of its own.
  const observer = new ResizeObserver(entries => { if (entries.some(entry => entry.target === dock)) follow = true; schedule(); });
  const watch = () => {
    observer.disconnect();
    for (const selector of ['.conversation-pane', '#composer-area', '.main-pane']) { const node = document.querySelector(selector); if (node) observer.observe(node); }
    observer.observe(dock);
  };
  watch();
  addEventListener('resize', schedule);
  return schedule;
}

export function mountActionDock(dock: HTMLElement): void {
  let entered = false;
  const tip = tooltip(dock), pill = indicator(dock), place = placement(dock, () => { if (!entered) { entered = true; enterDock(dock); } });
  const takeTitle = (item: HTMLElement) => { if (item.title) { item.dataset.dockTip = item.title; item.removeAttribute('title'); } };
  for (const item of buttons(dock)) takeTitle(item);
  new MutationObserver(records => {
    let structure = false;
    for (const record of records) {
      if (record.type === 'childList') { structure = true; for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches('button')) takeTitle(node); continue; }
      const item = record.target as HTMLElement;
      if (!(item instanceof HTMLButtonElement)) continue;
      if (record.attributeName === 'title') { takeTitle(item); continue; }
      if (record.attributeName === 'hidden') {
        const was = record.oldValue !== null;
        if (was && !item.hidden) appear(dock, item);
        else if (!was && item.hidden) { disappear(dock, item); if (tip.anchor === item) tip.hide(); if (pill.target === item) pill.to(); }
        structure = true;
      } else if (record.attributeName === 'class') {
        const was = ` ${record.oldValue ?? ''} `.includes(' active '), now = item.classList.contains('active');
        // The accent fill grows in with the spring and fades out from full.
        if (was !== now && pill.target === item) pill.to(item, true);
        if (was === now || !interacted || still() || typeof item.animate !== 'function') continue;
        if (now) track(item, item.animate([{ opacity: 0, scale: 0.6, offset: 0 }], { ...curve(), pseudoElement: '::before' }), '::before');
        else track(item, item.animate([{ opacity: 1, scale: 1, offset: 0 }], { duration: 150, easing: 'ease-out', pseudoElement: '::before' }), '::before');
      }
    }
    if (structure) { rove(dock); place(); }
  }).observe(dock, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'title'], attributeOldValue: true });

  let keyboard = false;
  document.addEventListener('keydown', () => { keyboard = true; }, true);
  document.addEventListener('pointerdown', () => { keyboard = false; }, true);
  const itemOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>('#action-dock button') : null;
  const focused = () => { const active = document.activeElement; return active instanceof HTMLButtonElement && dock.contains(active) && keyboard ? active : undefined; };
  dock.addEventListener('pointerover', event => {
    const item = itemOf(event.target); if (!item || item.hasAttribute('data-leaving')) return;
    for (const other of buttons(dock)) if (other !== item) { hover(other, false); press(other, false); }
    hover(item, true); pill.to(item); tip.hover(item);
  });
  dock.addEventListener('pointerleave', () => {
    for (const item of buttons(dock)) { hover(item, false); press(item, false); }
    const still = focused();
    pill.to(still); if (still) tip.show(still); else tip.hide();
  });
  dock.addEventListener('pointerdown', event => { const item = itemOf(event.target); if (item && event.button === 0) press(item, true); tip.hide(); });
  for (const type of ['pointerup', 'pointercancel']) dock.addEventListener(type, event => { const item = itemOf(event.target); if (item) press(item, false); });
  dock.addEventListener('focusin', event => { const item = itemOf(event.target); if (!item) return; rove(dock, item); if (keyboard) { pill.to(item); tip.show(item); } });
  dock.addEventListener('focusout', event => { if (!dock.contains(event.relatedTarget as Node | null)) { tip.hide(); if (!dock.matches(':hover')) pill.to(); } });
  dock.addEventListener('keydown', event => {
    if (event.key === 'Escape' && tip.anchor) { event.stopPropagation(); event.preventDefault(); tip.hide(); return; }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const items = dockItems(dock), at = items.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const steps: Record<string, number> = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const next = items[(steps[event.key] + items.length) % items.length];
    rove(dock, next); next.focus();
  });
  rove(dock);
  requestAnimationFrame(() => { rove(dock); place(); });
}

/** What the Agents item reads from the team and subagent views (the architect view loads lazily). */
export type AgentSource = { present: boolean; running: number; isOpen: boolean; open(focus: boolean): void; close(focus?: boolean): void };
const AGENTS_OPEN = 150, AGENTS_CLOSE = 300;

/** The Agents item: shown while the task has a team or subagents, badged with how many run.
 * Hovering opens `flyout` (both views' panels) left of the dock; it stays while the pointer is
 * on the item or the panel and closes `AGENTS_CLOSE` ms after it leaves both, which also carries
 * it across the gap. A click (Enter/Space) pins or unpins it; Escape closes it. */
export function mountAgents(item: HTMLButtonElement, flyout: HTMLElement, sources: () => AgentSource[]): void {
  const badge = item.querySelector<HTMLElement>('.dock-badge')!;
  let pinned = false, openTimer = 0, closeTimer = 0, shown = -1, focusedInside = false;
  // A panel's close button takes focus with it, so remember whether focus was in the flyout.
  document.addEventListener('focusin', event => { focusedInside = flyout.contains(event.target as Node); });
  const isOpen = () => !flyout.hidden;
  const place = () => {
    if (!isOpen()) return;
    const header = flyout.parentElement!.getBoundingClientRect(), box = item.getBoundingClientRect(), dock = item.closest('.action-dock')!;
    if (vertical(dock as HTMLElement)) {
      const right = header.right - dock.getBoundingClientRect().left + 10;
      const top = Math.max(8, Math.min(box.top, innerHeight - 12 - Math.min(flyout.scrollHeight, 420)));
      Object.assign(flyout.style, { right: `${Math.round(right)}px`, top: `${Math.round(top - header.top)}px`, maxHeight: `${Math.round(innerHeight - top - 12)}px` });
    } else {
      Object.assign(flyout.style, { right: `${Math.round(Math.max(8, header.right - box.right))}px`, top: `${Math.round(box.bottom - header.top + 8)}px`, maxHeight: `${Math.round(innerHeight - box.bottom - 20)}px` });
    }
  };
  const focusFirst = () => flyout.querySelector<HTMLElement>('.architect-close, [data-subagent-id], .subagents-close')?.focus();
  const show = (focus: boolean) => {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    for (const source of sources()) if (source.present && !source.isOpen) source.open(false);
    if (!flyout.querySelector('.architect-panel, .subagents-panel')) return;
    flyout.hidden = false; item.setAttribute('aria-expanded', 'true'); place();
    if (focus) focusFirst();
  };
  const hide = () => {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    const inside = flyout.contains(document.activeElement) || (document.activeElement === document.body && focusedInside);
    pinned = false;
    for (const source of sources()) if (source.isOpen) source.close(false);
    flyout.hidden = true; item.setAttribute('aria-expanded', 'false');
    if (inside && !item.hidden) item.focus({ preventScroll: true });
  };
  const badgeTo = (count: number) => {
    if (count === shown) return;
    const was = shown > 0; shown = count;
    if (count) badge.textContent = String(count);
    if (was === count > 0) return;
    cancel(badge);
    if (count) badge.hidden = false;
    if (still() || !interacted || typeof badge.animate !== 'function') { badge.hidden = !count; return; }
    const { easing, duration } = curve();
    const animation = track(badge, badge.animate(count ? [{ opacity: 0, scale: 0.3, offset: 0 }] : [{ opacity: 0, scale: 0.3 }], count ? { duration, easing } : { duration: duration * 0.7, easing: LEAVE, fill: 'forwards' }));
    if (!count) animation.onfinish = () => { badge.hidden = true; animation.cancel(); };
  };
  const refresh = () => {
    const present = sources().filter(source => source.present);
    const running = present.reduce((sum, source) => sum + source.running, 0);
    item.hidden = !present.length;
    item.setAttribute('aria-label', running ? `Agents: ${running} running` : 'Agents');
    badgeTo(running);
    if (!present.length && isOpen()) hide(); else place();
  };
  addEventListener('pandacode:agents', refresh);
  addEventListener('resize', place);
  // Panels opened elsewhere (a transcript link, the command palette) show the flyout; closing the
  // last panel from inside it hides the flyout.
  new MutationObserver(() => {
    const panel = flyout.querySelector('.architect-panel, .subagents-panel');
    if (panel && !isOpen()) { pinned = true; flyout.hidden = false; item.setAttribute('aria-expanded', 'true'); place(); }
    else if (!panel && isOpen()) hide();
    else place();
  }).observe(flyout, { subtree: true, childList: true });
  const enter = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearTimeout(closeTimer);
    if (!isOpen() && event.currentTarget === item) { clearTimeout(openTimer); openTimer = window.setTimeout(() => show(false), AGENTS_OPEN); }
  };
  const leave = () => { clearTimeout(openTimer); if (isOpen() && !pinned) { clearTimeout(closeTimer); closeTimer = window.setTimeout(hide, AGENTS_CLOSE); } };
  for (const target of [item, flyout]) { target.addEventListener('pointerenter', enter); target.addEventListener('pointerleave', leave); }
  item.addEventListener('click', () => {
    if (isOpen() && pinned) { hide(); return; }
    pinned = true; if (isOpen()) focusFirst(); else show(true);
  });
  // Before the panels' own Escape handlers, and only when no dialog or other menu is above it.
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen() || event.defaultPrevented) return;
    if ([...document.querySelectorAll('dialog[open], .floating-menu:not([aria-hidden="true"])')].some(other => !flyout.contains(other))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const focused = pinned || flyout.contains(document.activeElement) || document.activeElement === item;
    hide(); if (focused) item.focus({ preventScroll: true });
  }, true);
  refresh();
}
