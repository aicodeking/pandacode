/* Opening Settings at one control (e.g. from a usage card's "Open Settings"). */

/** Once Settings has rendered `#id`, opens the card holding it, scrolls it into view and focuses it; gives up after about two seconds. */
export function revealSetting(id: string, tries = 40): void {
  const target = document.getElementById(id);
  if (!target) {
    if (tries > 0) setTimeout(() => revealSetting(id, tries - 1), 50);
    return;
  }
  const card = target.closest('details');
  if (card) card.open = true;
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}
