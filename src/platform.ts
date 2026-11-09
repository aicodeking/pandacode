/** System webviews expose the host platform without another native round trip. */
export const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
export const isWindows = /Win/i.test(navigator.platform);
/** Workspace capabilities follow the native host; keyboard labels follow the client. */
const browserWorkspace = document.documentElement.dataset.pandacodeWeb === 'true' || new URLSearchParams(location.search).has('web');
export const hostPlatform = document.documentElement.dataset.pandacodeHostPlatform ?? (browserWorkspace ? 'unknown' : isMac ? 'macos' : isWindows ? 'windows' : 'linux');
export const hostIsMac = hostPlatform === 'macos';
/** Only macOS has iOS simulators; Windows and Linux run Android emulators alone. */
export const androidOnly = !hostIsMac;
export const commandKey = isMac ? '⌘' : 'Ctrl';

export function shortcut(key: string, shift = false): string {
  return `${commandKey}${shift ? isMac ? ' ⇧' : ' Shift' : ''} ${key}`;
}
