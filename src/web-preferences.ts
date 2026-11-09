/** Only appearance settings cross the native/browser boundary. Never export localStorage. */
export const appearanceKeys = ['pandacode.theme', 'pandacode.palette', 'pandacode.uiScale',
  'pandacode.wallpaperPreferences', 'pandacode.wallpapers', 'pandacode.compact'] as const;
export type AppearancePreferences = Record<string, string | null>;
const color = (value: unknown): value is string => typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
export function sanitizeAppearance(input: unknown): AppearancePreferences {
  const result: AppearancePreferences = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const source = input as Record<string, unknown>;
  for (const key of appearanceKeys) {
    const raw = source[key];
    if (raw === null) { result[key] = null; continue; }
    if (typeof raw !== 'string' || raw.length > 65536) continue;
    if (key === 'pandacode.theme' && ['light', 'dark'].includes(raw)) result[key] = raw;
    if (['pandacode.wallpapers', 'pandacode.compact'].includes(key) && ['true', 'false'].includes(raw)) result[key] = raw;
    if (key === 'pandacode.uiScale' && Number(raw) >= .8 && Number(raw) <= 1.6) result[key] = String(Number(raw));
    try {
      if (key === 'pandacode.palette') {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') continue;
        const accent = value.accent;
        if (!accent || !['wallpaper', 'classic', 'custom'].includes(accent.mode)) continue;
        if (accent.mode === 'custom' && !color(accent.color)) continue;
        let vsix = null;
        if (value.vsix && typeof value.vsix === 'object') {
          const theme = value.vsix;
          if (['id', 'name', 'extension', 'kind'].some(key => typeof theme[key] !== 'string' || theme[key].length > 256)) continue;
          if (!theme.colors || typeof theme.colors !== 'object') continue;
          const colors = Object.fromEntries(Object.entries(theme.colors).filter(([key, value]) => /^[\w.-]{1,128}$/.test(key) && color(value)).slice(0, 512));
          vsix = { id: theme.id, name: theme.name, extension: theme.extension, kind: theme.kind, colors };
        }
        result[key] = JSON.stringify({ accent: { mode: accent.mode, ...(color(accent.color) ? { color: accent.color } : {}) }, vsix });
      }
      if (key === 'pandacode.wallpaperPreferences') {
        const value = JSON.parse(raw);
        if (!value || value.version !== 3 || typeof value.enabled !== 'boolean' ||
          !Number.isFinite(value.visibility) || !Number.isFinite(value.blur) || !['automatic', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(value.set)) continue;
        const pinned = typeof value.pinned === 'string' && /^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|night)$/.test(value.pinned) ? value.pinned : null;
        result[key] = JSON.stringify({ version: 3, enabled: value.enabled,
          visibility: Math.max(0, Math.min(100, value.visibility)), blur: Math.max(0, Math.min(24, value.blur)),
          set: value.set, pinned });
      }
    } catch { /* Invalid saved JSON is not propagated. */ }
  }
  return result;
}
export function appearanceSnapshot(): AppearancePreferences {
  return sanitizeAppearance(Object.fromEntries(appearanceKeys.map(key => [key, localStorage.getItem(key)])));
}
export function storeAppearance(input: unknown): AppearancePreferences {
  const preferences = sanitizeAppearance(input);
  for (const [key, value] of Object.entries(preferences)) {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  }
  return preferences;
}

export function validatedHostClockOffset(): number | undefined {
  const raw = document.documentElement.dataset.pandacodeHostUtcOffsetMinutes;
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw); return Number.isInteger(value) && value >= -840 && value <= 840 ? value : undefined;
}
export function applyHostClockMetadata(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const offset = (value as Record<string, unknown>).utcOffsetMinutes;
  if (typeof offset === 'number' && Number.isInteger(offset) && offset >= -840 && offset <= 840) document.documentElement.dataset.pandacodeHostUtcOffsetMinutes = String(offset);
}

export function validatedWallpaperAccentSeed(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return value.toLowerCase();
}
export function applyWallpaperAccentSeed(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const seed = validatedWallpaperAccentSeed((value as Record<string, unknown>).wallpaperAccentSeed);
  if (seed) document.documentElement.dataset.pandacodeWallpaperAccentSeed = seed; else delete document.documentElement.dataset.pandacodeWallpaperAccentSeed;
}
