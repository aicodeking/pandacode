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
export interface WallpaperController {
  readonly preferences: Readonly<WallpaperPreferences>;
  readonly enabled: boolean;
  readonly currentId: string | undefined;
  readonly accessibilityOverride: boolean;
  update(patch: Partial<WallpaperPreferences>, persist?: boolean): void;
  setEnabled(value: boolean): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const preferenceKey = 'pandacode.wallpaperPreferences';
const legacyKey = 'pandacode.wallpapers';
/** Version 3 turns wallpapers off once for everyone, so the live scenes are seen; the chosen scene, set and sliders stay, ready for the switch. */
export const WALLPAPER_PREFERENCES_VERSION = 3;

export function normalizeWallpaperPreferences(value: unknown): WallpaperPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : false,
    visibility: typeof input.visibility === 'number' && Number.isFinite(input.visibility)
      ? Math.max(0, Math.min(100, Math.round(input.visibility))) : 20,
    blur: typeof input.blur === 'number' && Number.isFinite(input.blur)
      ? Math.max(0, Math.min(24, Math.round(input.blur))) : 0,
    set: wallpaperSets.some(day => day.id === input.set) ? input.set as WallpaperDay : 'automatic',
    pinned: typeof input.pinned === 'string' && /^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|night)$/.test(input.pinned)
      ? input.pinned : null,
  };
}

/** A save from an older version keeps its choices and starts off; only turning the switch on saves it as on. */
export function migrateWallpaperPreferences(value: unknown): WallpaperPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (input?.version === WALLPAPER_PREFERENCES_VERSION) return normalizeWallpaperPreferences(input);
  return { ...normalizeWallpaperPreferences(input), enabled: false };
}

function readPreferences(): WallpaperPreferences {
  try {
    const stored = localStorage.getItem(preferenceKey);
    if (stored) {
      try { return migrateWallpaperPreferences(JSON.parse(stored)); } catch { /* Fall back to the default. */ }
    }
    // The pre-preferences on/off flag was on unless turned off, so either way it is an untouched default: off.
    return normalizeWallpaperPreferences(null);
  } catch { return normalizeWallpaperPreferences(null); }
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

/** One shared scene for the thread and board, drawn inside `sceneHost` (the main pane: the thread is the window);
 * `host` carries `data-wallpaper` and the appearance variables. A new scene replaces the old one at once. */
export function mountWallpapers(host: HTMLElement, sceneHost: HTMLElement = host): WallpaperController {
  const layer = document.createElement('div');
  layer.className = 'workspace-wallpaper';
  layer.setAttribute('aria-hidden', 'true');
  sceneHost.prepend(layer);
  const contrast = matchMedia('(prefers-contrast: more)');
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  let preferences = Object.freeze(readPreferences());
  const listeners = new Set<() => void>();
  let disposed = false, generation = 0, timer = 0, pendingId = '';
  let current: HTMLImageElement | undefined, pending: HTMLImageElement | undefined;
  // The launch scene decodes after the startup gate (palette.ts) has opened, so its colours would fade in.
  let startup = true;
  /** Close the startup gate around the first scene and reopen it two frames later, as palette.ts does. */
  function holdStartupGate(): void {
    const root = document.documentElement;
    if (!startup || !root.hasAttribute('data-ready') || typeof requestAnimationFrame !== 'function') return;
    root.removeAttribute('data-ready');
    requestAnimationFrame(() => requestAnimationFrame(() => root.setAttribute('data-ready', '')));
  }

  function emit(): void { listeners.forEach(listener => listener()); }
  function applyAppearance(): void {
    const visibility = preferences.enabled ? preferences.visibility / 100 : 0;
    host.style.setProperty('--wallpaper-visibility', String(visibility));
    host.style.setProperty('--wallpaper-scrim-edge', String(1 - visibility));
    host.style.setProperty('--wallpaper-scrim-center', String((1 - visibility) * (1 + .35 * visibility)));
    host.style.setProperty('--wallpaper-blur', `${preferences.blur}px`);
    host.style.setProperty('--wallpaper-filter', preferences.blur ? `blur(${preferences.blur}px)` : 'none');
    // Three blur radii keep transparent filter edges beyond the clipped workspace.
    host.style.setProperty('--wallpaper-bleed', `${preferences.blur * 3}px`);
  }
  function persist(): void {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ ...preferences, version: WALLPAPER_PREFERENCES_VERSION }));
      localStorage.setItem(legacyKey, String(preferences.enabled && preferences.visibility > 0));
    } catch { /* Still works for this launch if storage is unavailable. */ }
  }

  function remove(image: HTMLImageElement): void { image.remove(); image.removeAttribute('src'); }
  function clear(): void {
    ++generation;
    pendingId = '';
    if (pending) { remove(pending); pending = undefined; }
    layer.querySelectorAll('img').forEach(remove);
    current = undefined;
    startup = false;
    delete host.dataset.wallpaper;
  }
  async function load(id: string): Promise<void> {
    const requested = ++generation;
    layer.querySelectorAll('img').forEach(child => { if (child !== current) remove(child); });
    pendingId = id;
    if (pending) remove(pending);
    const image = new Image();
    pending = image;
    image.alt = '';
    image.decoding = 'async';
    image.fetchPriority = 'low';
    image.src = `/wallpapers/${id}.webp`;
    try {
      await image.decode();
      if (disposed || requested !== generation || document.hidden) { remove(image); return; }
      const previous = current;
      if (!previous) holdStartupGate();
      startup = false;
      layer.append(image);
      current = image;
      host.dataset.wallpaper = id;
      emit();
      if (previous) remove(previous);
    } catch {
      // Keep the last decoded scene (or the normal solid surface) if a file fails.
      remove(image);
    } finally {
      if (requested === generation) { pendingId = ''; pending = undefined; }
    }
  }
  function refresh(): void {
    window.clearTimeout(timer);
    if (disposed) return;
    if (!preferences.enabled || !preferences.visibility || contrast.matches || transparency.matches) { clear(); emit(); return; }
    if (document.hidden) { emit(); return; }
    const now = new Date(), id = wallpaperAt(now, preferences);
    // Returning to the visible scene must invalidate any different scene still decoding.
    if (host.dataset.wallpaper === id && pendingId && pendingId !== id) {
      ++generation;
      pendingId = '';
      if (pending) { remove(pending); pending = undefined; }
    }
    if (host.dataset.wallpaper !== id && pendingId !== id) void load(id);
    // No frame loop or interval; midnight also changes the weekday's night scene.
    if (!preferences.pinned) timer = window.setTimeout(refresh, Math.max(1, nextWallpaperChange(now).getTime() - now.getTime()));
    emit();
  }
  function update(patch: Partial<WallpaperPreferences>, save = true): void {
    if (disposed) return;
    const previous = preferences;
    const next = normalizeWallpaperPreferences({ ...previous, ...patch });
    preferences = Object.freeze(next);
    applyAppearance();
    if (save) persist();
    if (next.set !== previous.set || next.pinned !== previous.pinned || next.enabled !== previous.enabled || (next.visibility === 0) !== (previous.visibility === 0)) refresh();
    else emit();
  }
  function setEnabled(value: boolean): void {
    update({ enabled: value, visibility: preferences.visibility || 20 });
  }
  function synchronize(event: StorageEvent): void {
    if (event.key !== preferenceKey && event.key !== null) return;
    preferences = Object.freeze(readPreferences());
    applyAppearance();
    refresh();
  }
  function dispose(): void {
    persist();
    disposed = true;
    window.clearTimeout(timer);
    clear(); layer.remove();
    contrast.removeEventListener('change', refresh);
    transparency.removeEventListener('change', refresh);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('storage', synchronize);
    listeners.clear();
  }
  contrast.addEventListener('change', refresh);
  transparency.addEventListener('change', refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', dispose, { once: true });
  window.addEventListener('storage', synchronize);
  applyAppearance();
  refresh();
  return {
    get preferences() { return preferences; },
    get enabled() { return preferences.enabled && preferences.visibility > 0; },
    get currentId() { return host.dataset.wallpaper; },
    get accessibilityOverride() { return contrast.matches || transparency.matches; },
    update, setEnabled,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose,
  };
}
