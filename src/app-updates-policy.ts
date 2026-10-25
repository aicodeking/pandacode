/* The updater's decisions, kept free of app imports so they can be tested on their own:
 * how often to check, when a downloaded update may restart PandaCode, and how Settings
 * describes each state. */
import { t } from './i18n.ts';

export type UpdateState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; checkedAt: number }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string };

/** Automatic installs when idle; Notify checks and asks first; Off checks only on request. */
export type UpdateMode = 'automatic' | 'notify' | 'off';

export const CHECK_EVERY = 6 * 60 * 60 * 1000;
/** A downloaded update installs after this long without input, when no agent is working. */
export const IDLE_BEFORE_RESTART = 2 * 60 * 1000;

/** The saved preference; the old boolean saved 'on'/'off', and unset meant automatic. */
export function parseUpdateMode(saved: string | null): UpdateMode {
  return saved === 'off' || saved === 'notify' ? saved : 'automatic';
}

/** Whether a found update downloads by itself. A copy that can't install in place (a
 * Linux run outside an AppImage) only ever reports it. */
export function downloadsOnItsOwn(mode: UpdateMode, installable: boolean): boolean {
  return mode === 'automatic' && installable;
}

/** Whether a downloaded update may install now: nothing running, and the user stepped away. */
export function readyToRestart(busy: boolean, lastInput: number, now = Date.now()): boolean {
  return !busy && now - lastInput >= IDLE_BEFORE_RESTART;
}

/** Whether a downloaded update restarts PandaCode now: on its own only in Automatic, or once
 * the user clicked Install and restart; never while an agent is working. */
export function restartNow(mode: UpdateMode, approved: boolean, busy: boolean, lastInput: number, now = Date.now()): boolean {
  if (busy) return false;
  return approved || (mode === 'automatic' && readyToRestart(busy, lastInput, now));
}

/** The status-bar prompt for a state: Install and restart for a found update (unless
 * dismissed with Later), Restart to update once downloaded. Null hides it. */
export function updatePrompt(state: UpdateState, installable: boolean, dismissed: string | null): { label: string; title: string; later: boolean } | null {
  switch (state.kind) {
    case 'available':
      if (state.version === dismissed) return null;
      return installable
        ? { label: t('Install and restart'), title: t`PandaCode ${state.version} is available. Installs when your agents are done.`, later: true }
        : { label: t`${state.version} available`, title: t`PandaCode ${state.version} is available. Open GitHub Releases to update this copy.`, later: true };
    case 'ready': return { label: t('Restart to update'), title: t`PandaCode ${state.version} is ready. Restart now, or it restarts on its own when your agents are done.`, later: false };
    case 'installing': return { label: t('Restart to update'), title: t`Installing ${state.version}…`, later: false };
    default: return null;
  }
}

/** One line for Settings → About. */
export function describeUpdate(state: UpdateState, mode: UpdateMode, now = Date.now(), installable = true): string {
  switch (state.kind) {
    case 'off': return t('Updates are installed by the desktop app.');
    case 'checking': return t('Checking GitHub Releases…');
    case 'current': { const minutes = Math.round((now - state.checkedAt) / 60_000); return t`Up to date · checked ${minutes < 1 ? t('just now') : minutes < 60 ? t`${minutes}m ago` : t`${Math.round(minutes / 60)}h ago`}`; }
    case 'available': return installable ? t`PandaCode ${state.version} is available.` : t`PandaCode ${state.version} is available. Updates for this copy are installed by its package or a new AppImage.`;
    case 'downloading': return t`Downloading ${state.version}${state.percent === null ? '…' : t` · ${state.percent}%`}`;
    case 'ready': return t`${state.version} is ready. ${mode === 'automatic' ? t('PandaCode restarts when your agents are done and you step away.') : t('Restart to finish.')}`;
    case 'installing': return t`Installing ${state.version}…`;
    case 'error': return t`Couldn’t check for updates: ${state.message}`;
    default: return mode === 'off' ? t('Automatic updates are off.') : t('Checks GitHub Releases automatically.');
  }
}
