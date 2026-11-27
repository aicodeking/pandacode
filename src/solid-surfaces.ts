const preferenceKey = 'pandacode.solidSurfaces';
const attribute = 'data-solid-surfaces';
export const SOLID_SURFACES_CHANGE = 'pandacode:solid-surfaces';

export function restoreSolidSurfaces(): void {
  try {
    document.documentElement.toggleAttribute(attribute, localStorage.getItem(preferenceKey) === '1');
  } catch { /* The default appearance stays. */ }
}

export function solidSurfacesEnabled(): boolean {
  return document.documentElement.hasAttribute(attribute);
}

export function setSolidSurfacesEnabled(enabled: boolean): void {
  document.documentElement.toggleAttribute(attribute, enabled);
  try {
    if (enabled) localStorage.setItem(preferenceKey, '1');
    else localStorage.removeItem(preferenceKey);
  } catch { /* Keep the choice for this launch. */ }
  window.dispatchEvent(new Event(SOLID_SURFACES_CHANGE));
}
