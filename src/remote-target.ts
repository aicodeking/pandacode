import { escape, icon } from './dom';
import { t } from './i18n.ts';
import type { RemoteRepoCheck, RemoteTarget } from './remote-types';
import type { Session } from './types';
import { cloudChip, cloudItems, cloudProvider, type CloudTarget } from './cloud-agents';
// Start progress for a New task sent to another computer; importing it here loads its strip actions.
export { cancelledRemoteStart, clearRemoteStart, remoteStart, remoteStartAttached, remoteStartStrip, startStageText, trackRemoteStart } from './remote-progress';

/* The context bar's computer choice (PandaCode Connect). A new task can start on another
 * signed-in computer; a task that runs there shows that computer, locked. */

export const LOCAL = 'local';
/** Opens Settings → Remote access when no other computer can take a task. */
export const CONNECT_SETUP = 'connect-setup';

export function lastSeenText(target: Pick<RemoteTarget, 'lastSeen'>): string {
  const raw = target.lastSeen;
  const time = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(time)) return 'last seen unknown';
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60_000) return 'last seen just now';
  if (elapsed < 3_600_000) return `last seen ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `last seen ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `last seen ${new Date(time).toLocaleDateString()}`;
}
export function offlineText(target: RemoteTarget): string { return `Offline · ${lastSeenText(target)}`; }

/** The control beside Local / Worktree. A New task always offers it, so other computers and cloud providers can be found and set up from here. */
export function computerControl(session: Session, fresh: boolean, targets: RemoteTarget[], chosen: string, clouds: CloudTarget[] = [], chosenName?: string): string {
  if (session.cloud) return cloudChip(session);
  if (session.remoteDevice) {
    const name = escape(session.remoteDevice.name), target = targets.find(item => item.deviceId === session.remoteDevice!.id);
    const offline = target && !target.online;
    const status = offline ? ` · ${escape(offlineText(target))}` : '';
    return `<span class="composer-computer composer-computer-fixed" aria-label="${t`Computer: ${name} (fixed for this task)`}${status}" title="${t`This task runs on ${name}. Start a new task to use another computer.`}${status}">${icon('monitor')}<span>${t`on ${name}`}${offline ? t(' · Offline') : ''}</span></span>`;
  }
  if (!fresh) return '';
  const cloud = clouds.find(item => item.provider === cloudProvider(chosen));
  const target = targets.find(item => item.deviceId === chosen), offline = !cloud && target && !target.online;
  // A chosen computer that left the list (signed out or revoked) keeps its last known name.
  const missing = !cloud && !target && chosen !== LOCAL && !cloudProvider(chosen);
  const name = cloud ? t`Cloud · ${cloud.label}` : target?.name ?? (missing ? chosenName ?? t('That computer') : t('This computer'));
  const status = offline ? ` · ${escape(offlineText(target))}` : missing ? t(' · Not paired') : '';
  return `<button type="button" id="composer-computer" class="composer-computer" data-action="computer-menu" aria-label="${t`Computer: ${escape(name)}`}${status}" aria-haspopup="menu" aria-expanded="false" title="${t('Where this task runs')}">${icon('monitor')}<span>${escape(name)}${offline ? t(' · Offline') : missing ? t(' · Not paired') : ''}</span>${icon('down')}</button>`;
}

export function computerItems(targets: RemoteTarget[], chosen: string, clouds: CloudTarget[] = []) {
  return [
    { id: LOCAL, label: t('This computer'), icon: 'monitor', selected: chosen === LOCAL },
    ...targets.map(target => ({ id: target.deviceId, label: target.name, description: target.online ? target.platform : offlineText(target), icon: 'monitor', selected: target.deviceId === chosen, disabled: !target.online })),
    ...(targets.length ? [] : [{ id: CONNECT_SETUP, label: t('Set up other computers…'), icon: 'settings' }]),
    ...cloudItems(clouds, chosen),
  ];
}

/** Why GitHub is behind this computer, as one sentence, or '' when it isn't. */
export function behindText(check: RemoteRepoCheck): string {
  const reasons = [
    check.ahead > 0 ? t`${check.ahead} unpushed ${check.ahead === 1 ? t('commit') : t('commits')}` : '',
    check.dirty ? t('uncommitted changes') : '',
    check.pushed ? '' : t`branch ${check.branch} not pushed`,
  ].filter(Boolean);
  return reasons.length ? t`GitHub is behind this computer: ${reasons.join(', ')}.` : '';
}

export function behindDialog(name: string, check: RemoteRepoCheck): string {
  return `<form id="remote-behind-form"><p class="dialog-description">${t`${escape(behindText(check))} ${escape(name)} will start from GitHub’s ${escape(check.branch)}.`}</p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">${t('Cancel')}</button><button type="submit" class="primary-button">${t('Continue')}</button></div></form>`;
}
