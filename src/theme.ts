import { migratePreferences } from './preferences';

try { migratePreferences(localStorage); } catch { /* Retry next launch if storage is unavailable. */ }

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151515' : '#ffffff');
}

export function setTheme(theme: Theme): void {
  // The whole palette changes at once: close the transition gate (design-system.css) so hundreds of
  // elements don't each fade, and reopen it two frames later, as holdStartupGate does.
  const root = document.documentElement, gated = root.hasAttribute('data-ready');
  if (gated) root.removeAttribute('data-ready');
  applyTheme(theme);
  try { localStorage.setItem('pandacode.theme', theme); } catch { /* The toggle still works when storage is unavailable. */ }
  window.dispatchEvent(new Event('pandacode-theme-change'));
  if (gated) requestAnimationFrame(() => requestAnimationFrame(() => root.setAttribute('data-ready', '')));
}

// Apply the saved palette before constructing the workspace.
let saved: Theme = 'dark';
try { if (localStorage.getItem('pandacode.theme') === 'light') saved = 'light'; } catch { /* Use the default palette. */ }
applyTheme(saved);
