// Settings → Appearance: System, Light or Dark for this app only. `Appearance.setColorScheme`
// overrides the window's interface style, so native parts (headers, tabs, sheets, glass, blur,
// keyboard, status bar) and PlatformColors follow, as does `useColorScheme()`.
import { Appearance } from 'react-native';
import { create } from 'zustand';
import { get, set } from '../connect/secrets.ts';

export type AppearanceChoice = 'system' | 'light' | 'dark';
export const APPEARANCES: { id: AppearanceChoice; label: string }[] = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

const KEY = 'appearance';
export const useAppearance = create<{ choice: AppearanceChoice }>(() => ({ choice: 'system' }));

const apply = (choice: AppearanceChoice) => Appearance.setColorScheme(choice === 'system' ? 'unspecified' : choice);

export function setAppearance(choice: AppearanceChoice) {
  useAppearance.setState({ choice });
  apply(choice);
  set(KEY, choice).catch(() => undefined);
}

/** Call once at start; an unknown or missing value means System. */
export async function loadAppearance() {
  const stored = await get(KEY);
  if (stored !== 'light' && stored !== 'dark') return;
  useAppearance.setState({ choice: stored });
  apply(stored);
}
