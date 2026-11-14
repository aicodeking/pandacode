/**
 * Auxiliary-window and native-menu coverage (T57): one entry per actual panda.tray/panda.windows ledger
 * member plus the pinned Running agents window. Data only; the window adapters stay in windows.ts and
 * the native broker (src-tauri/src/extensions/windows.rs). No window is created or granted here.
 */
import { WINDOW_PROTECTED_SURFACES } from './window-surfaces.ts';

export type WindowDisposition = 'adapter' | 'protected' | 'platform';
export type WindowEntry = { member: string; window: string; disposition: WindowDisposition; locations: readonly string[]; fallback: string; reason?: string };
export type WindowProtectedLocation = keyof typeof WINDOW_PROTECTED_SURFACES;

export const WINDOW_REGISTRY: readonly WindowEntry[] = [
  { member: 'panda.tray.popover', window: 'tray', disposition: 'adapter', locations: ['panda.tray.actions', 'panda.tray.protected'], fallback: 'Contributions hide/reorder like other action slots; forms and selects open in the main host; Open, Quit and recovery stay outside contributions.' },
  { member: 'panda.tray.native-open', window: 'tray', disposition: 'protected', locations: ['panda.tray.protected'], reason: 'Reserved OS menu item that always brings the workspace back.', fallback: 'Open PandaCode in the popover header and footer.' },
  { member: 'panda.tray.native-recovery', window: 'tray', disposition: 'protected', locations: ['panda.tray.protected'], reason: 'Safe recovery never belongs to an extension or a layout.', fallback: 'Disable extensions for this launch in the popover and in main Settings → Extensions.' },
  { member: 'panda.tray.native-quit', window: 'tray', disposition: 'protected', locations: ['panda.tray.protected'], reason: 'Reserved OS menu item; quitting stays reachable.', fallback: 'Quit in the popover footer.' },
  { member: 'panda.windows.main', window: 'main', disposition: 'adapter', locations: ['panda.workspace.header.actions'], fallback: 'Main-window families have their own coverage rows; the main window hosts every forwarded auxiliary form and quick pick.' },
  { member: 'panda.windows.launcher', window: 'launcher', disposition: 'adapter', locations: ['panda.launcher.actions', 'panda.launcher.protected'], fallback: 'Contributions hide/reorder; forms and selects open in the main host; the launcher draft, project, model and Close stay host-owned.' },
  { member: 'panda.windows.launcher-native', window: 'launcher', disposition: 'protected', locations: ['panda.launcher.protected'], reason: 'Cursor placement, visibility and navigation are native window policy, not a UI slot.', fallback: 'panda.launcher.actions inside the same window.' },
  { member: 'panda.windows.agents-dock', window: 'agents-dock', disposition: 'adapter', locations: ['panda.agentsDock.actions', 'panda.agentsDock.protected'], fallback: 'Contributions hide/reorder in the expanded widget; forms and selects open in the main host; Collapse, Unpin and the agent rows stay host-owned.' },
  { member: 'panda.windows.agents-dock-native', window: 'agents-dock', disposition: 'protected', locations: ['panda.agentsDock.protected'], reason: 'The pinned window lifetime follows the widget preference and never owns an agent.', fallback: 'Pin in the main Running agents widget (panda.roster.controls) reopens it.' },
  { member: 'panda.windows.tray-native', window: 'tray', disposition: 'protected', locations: ['panda.tray.protected'], reason: 'Popover creation, placement and navigation allowlist are native window policy.', fallback: 'panda.tray.actions inside the popover and panda.tray.menu in the OS menu.' },
  { member: 'panda.windows.rich-view-native', window: 'extension-view', disposition: 'platform', locations: ['panda.inspector.views'], reason: 'Extension-owned rich HTML windows stay disabled on every target until installed native isolation qualification (E16) exists.', fallback: 'The host-rendered declarative view in the main window, with the reason shown.' },
  { member: 'panda.agents.widget', window: 'agents-dock', disposition: 'adapter', locations: ['panda.agentsDock.actions', 'panda.agentsDock.protected', 'panda.roster.controls'], fallback: 'The main-window widget is panda.roster; its pinned window uses panda.agentsDock.actions, and Pin/Unpin and the widget preference stay host-owned.' },
];

/** [local id, label, reason] per auxiliary window; listed inspect-only in that window's catalog. */
export const WINDOW_PROTECTED: Readonly<Record<WindowProtectedLocation, readonly (readonly [string, string, string])[]>> = {
  'panda.tray.protected': [
    ['open', 'Open PandaCode', 'reserved in the popover header, footer and OS menu'],
    ['quit', 'Quit PandaCode', 'reserved in the popover footer and OS menu'],
    ['recovery', 'Disable extensions for this launch', 'protected recovery in the popover and OS menu'],
    ['tasks', 'Running, Needs you and Finished rows', 'core task status and open; never hidden'],
    ['usage', 'Plan usage and Refresh usage', 'host-owned cached usage and its only explicit read'],
    ['native-icons', 'OS menu icons', 'platform: OS menus take raster images and package SVG is never rasterized natively; the popover shows the icons'],
    ['native-inline', 'OS menu selects, fields, status and badges', 'platform: selects and forms open the main host quick pick or dialog; status and badges render in the popover'],
  ],
  'panda.launcher.protected': [
    ['close', 'Close launcher', 'reserved with Escape'],
    ['recovery', 'Disable extensions for this launch', 'protected recovery'],
    ['draft', 'Launcher prompt, project and model', 'host-owned draft and launch; never handed to a contribution'],
    ['placement', 'Launcher placement', 'native cursor placement, visibility and navigation policy'],
  ],
  'panda.agentsDock.protected': [
    ['unpin', 'Unpin widget', 'closes the pinned window; Pin in the main widget reopens it'],
    ['collapse', 'Collapse widget', 'reserved with Escape'],
    ['rows', 'Running agent rows', 'core status and open; never hidden'],
    ['recovery', 'Disable extensions for this launch', 'protected recovery'],
    ['lifetime', 'Pinned window lifetime', 'follows the widget preference; closing never stops an agent or disables a package'],
  ],
};

/** Host alternatives for controls a surface cannot render inline. */
export const WINDOW_FALLBACKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'panda.tray.menu': { select: 'host-quick-pick', form: 'main-dialog', icons: 'panda.tray.actions', status: 'panda.tray.actions', badge: 'panda.tray.actions' },
  'panda.tray.actions': { select: 'host-quick-pick', form: 'main-dialog' },
  'panda.launcher.actions': { select: 'host-quick-pick', form: 'main-dialog' },
  'panda.agentsDock.actions': { select: 'host-quick-pick', form: 'main-dialog' },
};
