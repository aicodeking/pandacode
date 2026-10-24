// The desktop's daily wallpaper schedule (src/wallpapers.ts), kept identical so the phone and the
// computer show the same scene at the same time. Pure: the images and the store are in Wallpaper.tsx.

export const wallpaperSets = [
  { id: 'mon', label: 'Monday' }, { id: 'tue', label: 'Tuesday' },
  { id: 'wed', label: 'Wednesday' }, { id: 'thu', label: 'Thursday' },
  { id: 'fri', label: 'Friday' }, { id: 'sat', label: 'Saturday' },
  { id: 'sun', label: 'Sunday' },
] as const;
export const wallpaperPeriods = [
  { id: 'morning', label: 'Morning' }, { id: 'afternoon', label: 'Afternoon' }, { id: 'night', label: 'Night' },
] as const;
type WallpaperDay = typeof wallpaperSets[number]['id'];
export interface WallpaperPreferences {
  enabled: boolean;
  visibility: number;
  blur: number;
  set: 'automatic' | WallpaperDay;
  pinned: string | null;
}
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Every scene id, `mon-morning` … `sun-night`. */
export const sceneIds = wallpaperSets.flatMap(day => wallpaperPeriods.map(period => `${day.id}-${period.id}`));

export function normalizeWallpaperPreferences(value: unknown): WallpaperPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    visibility: typeof input.visibility === 'number' && Number.isFinite(input.visibility)
      ? Math.max(0, Math.min(100, Math.round(input.visibility))) : 20,
    blur: typeof input.blur === 'number' && Number.isFinite(input.blur)
      ? Math.max(0, Math.min(24, Math.round(input.blur))) : 0,
    set: wallpaperSets.some(day => day.id === input.set) ? input.set as WallpaperDay : 'automatic',
    pinned: typeof input.pinned === 'string' && /^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|night)$/.test(input.pinned)
      ? input.pinned : null,
  };
}

/** Calendar days and time bands use the system's local timezone. */
export function wallpaperAt(date = new Date(), preferences?: Partial<WallpaperPreferences>): string {
  const choice = normalizeWallpaperPreferences(preferences);
  if (choice.pinned) return choice.pinned;
  const hour = date.getHours();
  const period = hour >= 6 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'night';
  return `${choice.set === 'automatic' ? days[date.getDay()] : choice.set}-${period}`;
}

export function nextWallpaperChange(date = new Date()): Date {
  const next = new Date(date);
  const hour = date.getHours();
  next.setHours(hour < 6 ? 6 : hour < 12 ? 12 : hour < 18 ? 18 : 24, 0, 0, 0);
  return next;
}

/** The desktop's `update()`: moving visibility alone turns the wallpaper on above zero and off at it. */
export function patchWallpaperPreferences(previous: WallpaperPreferences, patch: Partial<WallpaperPreferences>): WallpaperPreferences {
  const next = normalizeWallpaperPreferences({ ...previous, ...patch });
  return patch.visibility !== undefined && patch.enabled === undefined ? { ...next, enabled: next.visibility > 0 } : next;
}

// ---- Phone only (not on the desktop) ----

/** The phone's starting visibility and blur: a small screen wants a fainter, softer scene. */
export const PHONE_DEFAULTS = { visibility: 26, blur: 2 } as const;
/** Saved preferences carry this version; earlier ones were saved whole with the desktop's defaults. */
export const PHONE_PREFERENCES_VERSION = 2;

/** Stored phone preferences over the phone defaults. A save from before version 2 still holding
 * the desktop's untouched 20 % / 0 px counts as never set, so it moves to the new defaults. */
export function phoneWallpaperPreferences(stored: unknown): WallpaperPreferences {
  const input: Record<string, unknown> = stored && typeof stored === 'object' ? { ...stored as Record<string, unknown> } : {};
  const untouched = input.version !== PHONE_PREFERENCES_VERSION && input.visibility === 20 && input.blur === 0;
  const { visibility, blur, ...rest } = input;
  return normalizeWallpaperPreferences({ ...PHONE_DEFAULTS, ...(untouched ? rest : input) });
}
