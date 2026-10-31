// System colors: iOS semantic colors (follow light/dark by themselves), Material 3 baseline on Android.
import { Platform, PlatformColor, useColorScheme, type ColorValue } from 'react-native';

export interface Colors {
  background: ColorValue; grouped: ColorValue; card: ColorValue; fill: ColorValue;
  text: ColorValue; secondary: ColorValue; tertiary: ColorValue; separator: ColorValue;
  tint: ColorValue; onTint: ColorValue; tintFill: ColorValue; bubble: ColorValue; green: ColorValue; orange: ColorValue; red: ColorValue;
}

const ios: Colors = {
  background: PlatformColor('systemBackground'), grouped: PlatformColor('systemGroupedBackground'),
  card: PlatformColor('secondarySystemGroupedBackground'), fill: PlatformColor('tertiarySystemFill'),
  text: PlatformColor('label'), secondary: PlatformColor('secondaryLabel'), tertiary: PlatformColor('tertiaryLabel'),
  separator: PlatformColor('separator'), tint: PlatformColor('systemBlue'), onTint: '#ffffff', tintFill: 'rgba(10, 132, 255, 0.22)', bubble: PlatformColor('systemGray5'),
  green: PlatformColor('systemGreen'), orange: PlatformColor('systemOrange'), red: PlatformColor('systemRed'),
};

const light: Colors = {
  background: '#fdf8fd', grouped: '#f3edf7', card: '#ffffff', fill: '#e7e0ec', text: '#1d1b20', secondary: '#49454f',
  tertiary: '#79747e', separator: '#cac4d0', tint: '#6750a4', onTint: '#ffffff', tintFill: 'rgba(103, 80, 164, 0.16)', bubble: '#ece6f0', green: '#386a20', orange: '#8b5000', red: '#b3261e',
};
const dark: Colors = {
  background: '#141218', grouped: '#141218', card: '#211f26', fill: '#36343b', text: '#e6e0e9', secondary: '#cac4d0',
  tertiary: '#938f99', separator: '#49454f', tint: '#d0bcff', onTint: '#381e72', tintFill: 'rgba(208, 188, 255, 0.18)', bubble: '#2b2930', green: '#9ccc65', orange: '#ffb870', red: '#f2b8b5',
};

export function useColors(): Colors {
  const scheme = useColorScheme();
  return Platform.OS === 'ios' ? ios : scheme === 'dark' ? dark : light;
}

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const TILES = ['#5e5ce6', '#0a84ff', '#30b0c7', '#34c759', '#ff9f0a', '#ff6482', '#bf5af2', '#ac8e68', '#64d2ff', '#ff453a'];

/** A project's tile colour, hashed from its name so it stays put across launches. */
export function projectColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TILES[Math.abs(hash) % TILES.length];
}
