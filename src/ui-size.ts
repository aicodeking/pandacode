import './ui-size.css';
import { preview } from './bridge';
import { commandKey } from './platform';
import { t } from './i18n.ts';

/* Interface size. In the app it zooms the whole webview, like Safari's ⌘+, so icons, spacing and
 * layout grow with the text. The browser preview has no native zoom and scales only the root font. */

const preferenceKey = 'pandacode.uiScale';
const minimum = .8, maximum = 1.6, step = .1;
let scale = 1;
try {
  const saved = Number(localStorage.getItem(preferenceKey));
  if (Number.isFinite(saved) && saved >= minimum && saved <= maximum) scale = Math.round(saved * 10) / 10;
} catch { /* Sizing remains available without storage. */ }
apply();

function apply(): void {
  document.documentElement.style.setProperty('--ui-scale', String(preview ? scale : 1));
  // The title-bar row keeps its on-screen height so it stays level with the native window buttons.
  document.documentElement.style.setProperty('--page-zoom', String(pageZoom()));
  if (preview) return;
  void import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(scale))
    .catch(cause => console.error('Setting the interface size failed', cause));
}

export function uiScale(): number { return scale; }
/** CSS pixels → window points: native views placed over the page multiply by this. */
export function pageZoom(): number { return preview ? 1 : scale; }
/** How much the root font is scaled on top of the page zoom (only in the browser preview). */
export function textScale(): number { return preview ? scale : 1; }

export function setUiScale(value: number): void {
  if (!Number.isFinite(value)) return;
  const next = Math.min(maximum, Math.max(minimum, Math.round(value * 10) / 10));
  if (next === scale) return;
  scale = next;
  apply();
  try { localStorage.setItem(preferenceKey, String(scale)); } catch { /* Keep the size for this session. */ }
  document.querySelectorAll<HTMLOutputElement>('[data-ui-size-value]').forEach(output => { output.value = `${Math.round(scale * 100)}%`; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="ui-size-decrease"]').forEach(button => { button.disabled = scale === minimum; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="ui-size-increase"]').forEach(button => { button.disabled = scale === maximum; });
  window.dispatchEvent(new Event('pandacode-ui-scale-change'));
  // Existing floating menus and browser bounds respond without remounting their DOM.
  window.dispatchEvent(new Event('resize'));
}

export function changeUiScale(direction: -1 | 1): void { setUiScale(scale + direction * step); }

export function uiSizeControls(): string {
  const modifier = commandKey;
  return `<div class="setting-row text-size-setting"><div><strong>${t('Interface size')}</strong><small>${t`${modifier} + / − to resize · ${modifier} 0 to reset`}</small></div><div class="text-size-controls" role="group" aria-label="${t('Interface size')}"><button type="button" data-action="ui-size-decrease" aria-label="${t('Decrease interface size')}" title="${t`Decrease interface size (${modifier} −)`}" ${scale === minimum ? 'disabled' : ''}>A−</button><output data-ui-size-value aria-label="${t('Current interface size')}" aria-live="polite">${Math.round(scale * 100)}%</output><button type="button" data-action="ui-size-increase" aria-label="${t('Increase interface size')}" title="${t`Increase interface size (${modifier} +)`}" ${scale === maximum ? 'disabled' : ''}>A+</button><button type="button" class="text-size-reset" data-action="ui-size-reset" aria-label="${t('Reset interface size')}" title="${t`Reset interface size (${modifier} 0)`}">${t('Reset')}</button></div></div>`;
}

export function initializeUiSizing(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.defaultPrevented) return;
    const direction = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : 0;
    if (!direction && event.key !== '0') return;
    event.preventDefault();
    // Capture before terminal/menu handlers so the shortcut never becomes agent input.
    event.stopPropagation();
    if (direction) changeUiScale(direction);
    else setUiScale(1);
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
