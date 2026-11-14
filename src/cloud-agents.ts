import { escape, icon } from './dom.ts';
import { toned } from './approval-modes.ts';
import type { ProviderId, Session } from './types';

/* Cloud agents (docs/cloud-agents.md): the "Run on" menu's Cloud section, the fixed chip and
 * status strip of a task that runs on a cloud machine, and its machine actions. */

export type CloudTarget = { provider: string; label: string; ready: boolean };
export type CloudStage = NonNullable<Session['cloud']>['stage'];

const PREFIX = 'cloud:';
export const SETUP_CHOICE = 'cloud-setup';
export const CLOUD_HARNESSES: readonly ProviderId[] = ['claude', 'glm', 'mimo', 'codex', 'opencode'];
const BUSY = new Set<CloudStage>(['creating', 'installing', 'credentials', 'uploading', 'running', 'reconnecting', 'syncing']);
const CLOUD_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18Z"/></svg>';

export const cloudChoice = (provider: string): string => PREFIX + provider;
/** The provider of a "Run on" choice, or undefined for this computer and Connect devices. */
export const cloudProvider = (choice: string): string | undefined => choice.startsWith(PREFIX) ? choice.slice(PREFIX.length) : undefined;
export const cloudIcon = (): string => CLOUD_ICON;

/** The menu's Cloud section: connected providers only, then setup (alone when none is connected).
 * ponytail: the "Cloud · " label prefix stands in for a section heading; choice-menu.ts has none. */
export function cloudItems(targets: CloudTarget[], chosen: string) {
  return [
    ...targets.filter(target => target.ready).map(target => ({ id: cloudChoice(target.provider), label: `Cloud · ${target.label}`, leading: toned(CLOUD_ICON, 'remote'), selected: chosen === cloudChoice(target.provider) })),
    { id: SETUP_CHOICE, label: 'Set up cloud providers…', icon: 'settings' },
  ];
}

/** Why a harness can't run in the cloud, or '' when it can. */
export function harnessRefusal(harness: ProviderId, name: string): string {
  return CLOUD_HARNESSES.includes(harness) ? '' : `${name} can’t run on a cloud machine yet. Choose Claude Code, GLM, MiMo, Codex or OpenCode.`;
}

function installing(harness: ProviderId): string {
  return harness === 'codex' ? 'Codex' : harness === 'opencode' ? 'OpenCode' : 'Claude Code';
}
export function stageText(stage: CloudStage, detail: string | null | undefined, harness: ProviderId): string {
  switch (stage) {
    case 'creating': return 'Creating machine';
    case 'installing': return `Installing ${installing(harness)}`;
    case 'credentials': return 'Copying logins';
    case 'uploading': return 'Uploading checkout';
    case 'ready': return 'Ready';
    case 'running': return 'Running';
    case 'reconnecting': return 'Reconnecting…';
    case 'syncing': return 'Syncing changes';
    case 'stopped': return 'Stopped';
    case 'error': return `Error: ${detail || 'the machine could not be prepared'}`;
  }
}
export const busyStage = (stage: CloudStage): boolean => BUSY.has(stage);

/** The context bar's computer control for a cloud task: fixed, like a Connect mirror's. */
export function cloudChip(session: Session): string {
  const cloud = session.cloud!, label = escape(cloud.label), stage = escape(stageText(cloud.stage, cloud.detail, session.provider));
  return `<span class="composer-computer composer-computer-fixed" data-remote="cloud" role="img" tabindex="0" aria-label="Computer: ${label} cloud machine (fixed for this task) · ${stage}" data-tip="This task runs on a ${label} cloud machine. ${stage}.">${CLOUD_ICON}<span class="sr-only">on ${label}</span></span>`;
}

/** The status strip above a cloud task's composer. `pending` shows a machine action in flight; `decorate`
 * lets the extension presentation order and hide the two original controls inside the same markup. */
export function cloudStrip(session: Session, options: { pending?: boolean; attributes?: string; decorate?: (items: readonly (readonly [string, string])[]) => string } = {}): string {
  const cloud = session.cloud; if (!cloud) return '';
  const text = stageText(cloud.stage, cloud.detail, session.provider);
  const lead = busyStage(cloud.stage) || options.pending ? '<span class="support-spinner" aria-hidden="true"></span>' : CLOUD_ICON;
  const status = `<span class="cloud-strip-status" role="status">${lead}<span class="cloud-strip-text">${escape(cloud.label)} · ${escape(text)}</span></span>`;
  const menu = `<button type="button" id="cloud-menu" class="cloud-strip-menu" data-action="cloud-menu" aria-haspopup="dialog" aria-expanded="false" aria-label="Cloud machine actions" title="Cloud machine actions">${icon('more')}</button>`;
  return `<div class="cloud-strip" data-stage="${cloud.stage}"${options.attributes ?? ''}>${options.decorate ? options.decorate([['status', status], ['machine-menu', menu]]) : status + menu}</div>`;
}

/** The machine menu rows; while one action is pending for this task every row waits for it. */
export function cloudActionItems(session: Session, pending = false) {
  const stage = session.cloud?.stage;
  return [
    { id: 'sync', label: 'Sync changes', icon: 'refresh', disabled: pending || stage === 'syncing' },
    ...(stage === 'error' ? [{ id: 'retry', label: 'Retry', icon: 'refresh', disabled: pending }] : []),
    { id: 'open', label: 'Open machine', icon: 'monitor', disabled: pending },
    { id: 'stop', label: 'Stop machine', icon: 'stop', disabled: pending || stage === 'stopped' },
    { id: 'delete', label: 'Delete machine…', icon: 'trash', danger: true, disabled: pending },
  ];
}

export function deleteMachineDialog(session: Session): string {
  return `<form id="cloud-delete-form"><p class="dialog-description">Delete this task’s ${escape(session.cloud?.label ?? 'cloud')} machine? Its files there are lost; the task stays and creates a new machine with your next message.</p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="secondary-button delete-task-confirm">Delete machine</button></div></form>`;
}
