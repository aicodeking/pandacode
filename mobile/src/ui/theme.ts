// Colour tokens for the current scheme and Increase Contrast (values in ds/palette.ts). Plain strings
// rather than DynamicColorIOS, so native props, Reanimated and Android all take one path.
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native';
import { create } from 'zustand';
import { paletteFor, type Palette, type Scheme } from './ds/palette.ts';

export type Colors = Palette;

const useIncreaseContrast = create<{ on: boolean }>(() => ({ on: false }));
const setIncreaseContrast = (on: boolean) => useIncreaseContrast.setState({ on });

if (Platform.OS === 'ios') {
  AccessibilityInfo.isDarkerSystemColorsEnabled().then(setIncreaseContrast, () => undefined);
  AccessibilityInfo.addEventListener('darkerSystemColorsChanged', setIncreaseContrast);
} else if (Platform.OS === 'android') {
  AccessibilityInfo.isHighTextContrastEnabled().then(setIncreaseContrast, () => undefined);
  AccessibilityInfo.addEventListener('highTextContrastChanged', setIncreaseContrast);
}

function useScheme(): Scheme {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useColors(): Colors {
  const scheme = useScheme();
  return paletteFor(scheme, useIncreaseContrast(s => s.on));
}

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const TILES = ['#5e5ce6', '#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff6482', '#bf5af2', '#ac8e68', '#64d2ff', '#ff453a'];

/** A project's tile colour, hashed from its name so it stays put across launches. */
export function projectColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TILES[Math.abs(hash) % TILES.length];
}
