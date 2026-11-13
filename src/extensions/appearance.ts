/** Host-owned ephemeral appearance. Conflicts restore defaults rather than last-writer wins. */
import { setExtensionTheme } from '../palette';
import { setAppearanceIcons, type ExtensionTheme } from './appearance-state';
import type { ExtensionSnapshot } from './manager';
export function applyExtensionAppearance(snapshot: ExtensionSnapshot): void {
  const active = snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled);
  const themes = active.flatMap(item => item.manifest.contributes.themes ?? []);
  if (themes.length > 1) snapshot.diagnostics.push('Appearance conflict: enable only one theme package. User palette retained.');
  setExtensionTheme(themes.length === 1 ? themes[0] : undefined);
  const candidates = new Map<string, string[]>();
  for (const item of active) for (const icon of item.manifest.contributes.icons ?? []) if (icon.host && item.icons[icon.id]) candidates.set(icon.host, [...candidates.get(icon.host) ?? [], item.icons[icon.id]]);
  setAppearanceIcons(new Map([...candidates].filter(([, values]) => values.length === 1).map(([name, values]) => [name, values[0]])));
  window.dispatchEvent(new Event('pandacode-icons-change'));
}
export type { ExtensionTheme };
