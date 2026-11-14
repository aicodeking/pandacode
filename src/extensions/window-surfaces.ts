/** Actual application webview labels. The launcher is the overlay, not a fourth window. */
export const WINDOW_ACTION_SURFACES = {
  'panda.tray.actions': 'tray',
  'panda.tray.menu': 'tray',
  'panda.launcher.actions': 'launcher',
  'panda.agentsDock.actions': 'agents-dock',
} as const;
/** Inspect-only core controls of each auxiliary window; packages can never target these. */
export const WINDOW_PROTECTED_SURFACES = {
  'panda.tray.protected': 'tray',
  'panda.launcher.protected': 'launcher',
  'panda.agentsDock.protected': 'agents-dock',
} as const;
export type WindowActionLocation = keyof typeof WINDOW_ACTION_SURFACES;
export type AuxiliaryWindow = typeof WINDOW_ACTION_SURFACES[WindowActionLocation];
export function surfaceWindow(location: string): string {
  if (Object.hasOwn(WINDOW_ACTION_SURFACES, location)) return WINDOW_ACTION_SURFACES[location as WindowActionLocation];
  return Object.hasOwn(WINDOW_PROTECTED_SURFACES, location) ? WINDOW_PROTECTED_SURFACES[location as keyof typeof WINDOW_PROTECTED_SURFACES] : 'main';
}
