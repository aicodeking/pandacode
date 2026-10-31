// The desktop's daily wallpaper behind the whole app (docs/wallpapers.md): one full-screen scene
// under the stack, sidebar and tab bar, faded over the system background by the visibility
// preference (the scrim follows light/dark), blurred by the blur preference. Screens read
// `useBackdrop()` to go transparent while it shows. Reduce Transparency hides it, as on the desktop.
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, StyleSheet, useColorScheme, View, type ViewProps } from 'react-native';
import { create } from 'zustand';
import { get, set } from '../connect/secrets.ts';
import { useColors, type Colors } from './theme.ts';
import { nextWallpaperChange, patchWallpaperPreferences, PHONE_PREFERENCES_VERSION, phoneWallpaperPreferences, wallpaperAt, type WallpaperPreferences } from './wallpaper.ts';

// Static requires: Metro bundles only what it can see.
export const SCENES: Record<string, number> = {
  'mon-morning': require('../../assets/wallpapers/mon-morning.webp'),
  'mon-afternoon': require('../../assets/wallpapers/mon-afternoon.webp'),
  'mon-night': require('../../assets/wallpapers/mon-night.webp'),
  'tue-morning': require('../../assets/wallpapers/tue-morning.webp'),
  'tue-afternoon': require('../../assets/wallpapers/tue-afternoon.webp'),
  'tue-night': require('../../assets/wallpapers/tue-night.webp'),
  'wed-morning': require('../../assets/wallpapers/wed-morning.webp'),
  'wed-afternoon': require('../../assets/wallpapers/wed-afternoon.webp'),
  'wed-night': require('../../assets/wallpapers/wed-night.webp'),
  'thu-morning': require('../../assets/wallpapers/thu-morning.webp'),
  'thu-afternoon': require('../../assets/wallpapers/thu-afternoon.webp'),
  'thu-night': require('../../assets/wallpapers/thu-night.webp'),
  'fri-morning': require('../../assets/wallpapers/fri-morning.webp'),
  'fri-afternoon': require('../../assets/wallpapers/fri-afternoon.webp'),
  'fri-night': require('../../assets/wallpapers/fri-night.webp'),
  'sat-morning': require('../../assets/wallpapers/sat-morning.webp'),
  'sat-afternoon': require('../../assets/wallpapers/sat-afternoon.webp'),
  'sat-night': require('../../assets/wallpapers/sat-night.webp'),
  'sun-morning': require('../../assets/wallpapers/sun-morning.webp'),
  'sun-afternoon': require('../../assets/wallpapers/sun-afternoon.webp'),
  'sun-night': require('../../assets/wallpapers/sun-night.webp'),
};
// The desktop's 512 px previews, for the Settings strip.
export const THUMBNAILS: Record<string, number> = {
  'mon-morning': require('../../assets/wallpapers/thumbnails/mon-morning.webp'),
  'mon-afternoon': require('../../assets/wallpapers/thumbnails/mon-afternoon.webp'),
  'mon-night': require('../../assets/wallpapers/thumbnails/mon-night.webp'),
  'tue-morning': require('../../assets/wallpapers/thumbnails/tue-morning.webp'),
  'tue-afternoon': require('../../assets/wallpapers/thumbnails/tue-afternoon.webp'),
  'tue-night': require('../../assets/wallpapers/thumbnails/tue-night.webp'),
  'wed-morning': require('../../assets/wallpapers/thumbnails/wed-morning.webp'),
  'wed-afternoon': require('../../assets/wallpapers/thumbnails/wed-afternoon.webp'),
  'wed-night': require('../../assets/wallpapers/thumbnails/wed-night.webp'),
  'thu-morning': require('../../assets/wallpapers/thumbnails/thu-morning.webp'),
  'thu-afternoon': require('../../assets/wallpapers/thumbnails/thu-afternoon.webp'),
  'thu-night': require('../../assets/wallpapers/thumbnails/thu-night.webp'),
  'fri-morning': require('../../assets/wallpapers/thumbnails/fri-morning.webp'),
  'fri-afternoon': require('../../assets/wallpapers/thumbnails/fri-afternoon.webp'),
  'fri-night': require('../../assets/wallpapers/thumbnails/fri-night.webp'),
  'sat-morning': require('../../assets/wallpapers/thumbnails/sat-morning.webp'),
  'sat-afternoon': require('../../assets/wallpapers/thumbnails/sat-afternoon.webp'),
  'sat-night': require('../../assets/wallpapers/thumbnails/sat-night.webp'),
  'sun-morning': require('../../assets/wallpapers/thumbnails/sun-morning.webp'),
  'sun-afternoon': require('../../assets/wallpapers/thumbnails/sun-afternoon.webp'),
  'sun-night': require('../../assets/wallpapers/thumbnails/sun-night.webp'),
};

const KEY = 'wallpaper.preferences';
const SAVE_DELAY_MS = 400;
const FADE_MS = 600;
/** Cards over the scene: the system card colour, see-through. */
const TRANSLUCENT = { light: 'rgba(255, 255, 255, 0.72)', dark: 'rgba(28, 28, 30, 0.72)' } as const;

interface WallpaperState { preferences: WallpaperPreferences; reduceTransparency: boolean }
export const useWallpaper = create<WallpaperState>(() => ({ preferences: phoneWallpaperPreferences(null), reduceTransparency: false }));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Applies a change at once and saves it after a pause, so dragging a slider writes once. */
export function setWallpaper(patch: Partial<WallpaperPreferences>) {
  useWallpaper.setState(s => ({ preferences: patchWallpaperPreferences(s.preferences, patch) }));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    set(KEY, JSON.stringify({ ...useWallpaper.getState().preferences, version: PHONE_PREFERENCES_VERSION })).catch(() => undefined);
  }, SAVE_DELAY_MS);
}

async function load() {
  const [raw, reduce] = await Promise.all([get(KEY), AccessibilityInfo.isReduceTransparencyEnabled().catch(() => false)]);
  let stored: unknown = null;
  try { stored = JSON.parse(raw ?? 'null'); } catch { /* unreadable: defaults */ }
  useWallpaper.setState({ preferences: phoneWallpaperPreferences(stored), reduceTransparency: reduce });
}

/** Whether a scene is on screen now. */
export const useWallpaperShown = () => useWallpaper(s => s.preferences.enabled && s.preferences.visibility > 0 && !s.reduceTransparency);

/** Surfaces for a screen: transparent backgrounds and translucent cards while the wallpaper shows. */
export function useBackdrop(): Colors & { shown: boolean } {
  const colors = useColors();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const shown = useWallpaperShown();
  return shown ? { ...colors, shown, background: 'transparent', grouped: 'transparent', card: TRANSLUCENT[scheme] } : { ...colors, shown };
}

/** The scene for now, re-picked at each band change and whenever the app comes back. */
function useSceneId(preferences: WallpaperPreferences): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = preferences.pinned ? undefined : setTimeout(() => setNow(new Date()), Math.max(1, nextWallpaperChange(now).getTime() - now.getTime()));
    const sub = AppState.addEventListener('change', state => { if (state === 'active') setNow(new Date()); });
    return () => { clearTimeout(timer); sub.remove(); };
  }, [now, preferences.pinned]);
  return wallpaperAt(now, preferences);
}

/** Mount once, behind everything, in the root layout. */
export function WallpaperLayer() {
  const preferences = useWallpaper(s => s.preferences);
  const shown = useWallpaperShown();
  const id = useSceneId(preferences);
  useEffect(() => {
    void load();
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', reduce => useWallpaper.setState({ reduceTransparency: reduce }));
    return () => sub.remove();
  }, []);
  if (!shown) return null;
  return (
    <Image source={SCENES[id]} contentFit="cover" blurRadius={preferences.blur} transition={{ duration: FADE_MS, effect: 'cross-dissolve' }}
      style={[StyleSheet.absoluteFill, { opacity: preferences.visibility / 100 }]} accessible={false} pointerEvents="none" />
  );
}

/** A system blur material (follows light/dark) on iOS; a translucent card colour on Android. */
export function Material({ material, style, ...rest }: ViewProps & { material: 'systemThinMaterial' | 'systemChromeMaterial' }) {
  const backdrop = useBackdrop();
  if (Platform.OS === 'ios') return <BlurView tint={material} style={[styles.clip, style]} {...rest} />;
  return <View style={[{ backgroundColor: backdrop.card }, style]} {...rest} />;
}

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
