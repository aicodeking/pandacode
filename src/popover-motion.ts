/* Menus and popovers settle in from their trigger in a few pixels and leave at once, so
 * closing state stays synchronous. Kept as one module so every menu shares the same
 * open/close bookkeeping. */
import { materializeIn } from './motion';

/** Call after insertion and positioning. The menu is immediately interactive. */
export function showPopover(panel: HTMLElement, anchor: HTMLElement): void {
  panel.classList.add('floating-menu');
  panel.inert = false;
  panel.removeAttribute('aria-hidden');
  panel.style.pointerEvents = '';
  panel.style.opacity = '1';
  panel.style.transform = 'none';

  const trigger = anchor.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const above = panel.dataset.placement
    ? panel.dataset.placement === 'above'
    : bounds.top + panel.offsetHeight / 2 < trigger.top + trigger.height / 2;
  panel.dataset.placement = above ? 'above' : 'below';
  panel.dataset.popoverState = 'open';
  // Interactive from the first frame; the motion is only presentation.
  materializeIn(panel, { scale: 0.985, y: above ? 4 : -4, spring: { response: 0.2 }, origin: above ? '50% 100%' : '50% 0%' });
}

/** Removes the menu at once. */
export function hidePopover(panel: HTMLElement): void {
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  panel.style.pointerEvents = 'none';
  panel.dataset.popoverState = 'closing';
  panel.remove();
}
