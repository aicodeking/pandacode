/** System webviews expose the host platform without another native round trip. */
export const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
export const isWindows = /Win/i.test(navigator.platform);
/** Only macOS has iOS simulators; Windows and Linux run Android emulators alone. */
export const androidOnly = !isMac;
export const commandKey = isMac ? '⌘' : 'Ctrl';

export function shortcut(key: string, shift = false): string {
  return `${commandKey}${shift ? isMac ? ' ⇧' : ' Shift' : ''} ${key}`;
}
