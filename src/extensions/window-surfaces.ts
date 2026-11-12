/** Actual application webview labels. The launcher is the overlay, not a fourth window. */
export const WINDOW_ACTION_SURFACES = {
  'panda.tray.actions': 'tray',
  'panda.tray.menu': 'tray',
  'panda.launcher.actions': 'launcher',
  'panda.agentsDock.actions': 'agents-dock',
} as const;
export type WindowActionLocation = keyof typeof WINDOW_ACTION_SURFACES;
export type AuxiliaryWindow = typeof WINDOW_ACTION_SURFACES[WindowActionLocation];
export function surfaceWindow(location: string): string {
  return Object.hasOwn(WINDOW_ACTION_SURFACES, location) ? WINDOW_ACTION_SURFACES[location as WindowActionLocation] : 'main';
}
