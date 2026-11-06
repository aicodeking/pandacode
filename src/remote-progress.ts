import { subscribe } from './bridge';
import { escape, icon } from './dom';
import { t } from './i18n.ts';

/* PandaCode Connect start progress (docs/remote-access.md): while `remote_start_task`
 * waits for another computer to find or clone the project, the host reports its stages
 * (`task.progress`, re-emitted here as `remote://start-progress`) and the New task shows
 * them in a strip above the composer, like a cloud task's (src/cloud-agents.ts). A
 * failure stays there with Retry until the next send or Dismiss. */

export type RemoteStartStage = 'connecting' | 'finding' | 'downloading' | 'preparing' | 'starting' | 'error';
/** `remote://start-progress`, validated natively (`remote/start.rs` `progress_payload`). */
export interface RemoteStartProgress { deviceId: string; startId?: string | null; repo?: string | null; stage: Exclude<RemoteStartStage, 'connecting'>; percent?: number | null; detail?: string | null }
export interface RemoteStart {
  sessionId: string; deviceId: string; device: string; repo: string | null; stage: RemoteStartStage; percent: number | null; detail: string | null; retry?: () => void; onStage?: (start: RemoteStart) => void; cancelling?: boolean; startId?: string;
  /** The start's reply was lost (`Waiting for <device>…`): the mirror row exists, its host task may not yet. */
  waiting?: boolean; mirrorId?: string; settle?: (error?: Error) => void;
}

const EVENT = 'remote://start-progress';
const STAGES: readonly RemoteStartStage[] = ['connecting', 'finding', 'downloading', 'preparing', 'starting', 'error'];
const starts = new Map<string, RemoteStart>();
let listening: Promise<unknown> | undefined;
let observer: MutationObserver | undefined;

export function startStageText(start: Pick<RemoteStart, 'stage' | 'repo' | 'percent' | 'detail'>): string {
  const repo = start.repo ?? t('the repository');
  switch (start.stage) {
    case 'connecting': return t('Connecting to computer');
    case 'finding': return start.repo ? t`Finding ${repo}` : t('Finding the project');
    case 'downloading': return t`Downloading ${repo}${start.percent == null ? '' : t` · ${Math.round(start.percent)}%`}`;
    case 'preparing': return t('Preparing checkout');
    case 'starting': return t('Starting agent');
    case 'error': return t`Could not start: ${start.detail || t('the other computer did not answer')}`;
  }
}

export const remoteStart = (sessionId: string): RemoteStart | undefined => starts.get(sessionId);

/** The strip above a New task's composer while it starts on another computer, or ''.
 * A start whose stages show in the transcript's turn (`onStage`) shows here only its failure. */
export function remoteStartStrip(sessionId: string): string {
  const start = starts.get(sessionId); if (!start || (start.onStage && start.stage !== 'error')) return '';
  const failed = start.stage === 'error', determinate = start.stage === 'downloading' && start.percent != null;
  const lead = failed ? icon('alert') : '<span class="support-spinner" aria-hidden="true"></span>';
  const step = failed ? '' : ` aria-description="${t`Step ${STAGES.indexOf(start.stage) + 1} of ${STAGES.length - 1}`}"`;
  const bar = determinate ? `<progress class="remote-start-bar" max="100" value="${Math.round(start.percent!)}" aria-label="${t('Download progress')}"></progress>` : '';
  const actions = failed ? `<button type="button" class="remote-start-retry" data-remote-start="retry">${icon('refresh')}<span>${t('Retry')}</span></button><button type="button" class="remote-start-dismiss" data-remote-start="dismiss" aria-label="${t('Dismiss')}" title="${t('Dismiss')}">${icon('close')}</button>` : '';
  return `<div class="remote-start-strip" data-stage="${start.stage}"><span class="remote-start-status" role="${failed ? 'alert' : 'status'}"${step}>${lead}<span class="remote-start-text"><span class="remote-start-device">${escape(start.device)}</span> · ${escape(startStageText(start))}</span></span>${bar}${actions}</div>`;
}

/** Redraws the strip in place (never the composer), for the task whose prompt is shown. */
export function syncRemoteStartStrip(): void {
  const composer = document.querySelector('#composer-area #composer'), old = document.querySelector<HTMLElement>('#composer-area .remote-start-strip');
  const id = document.querySelector<HTMLTextAreaElement>('#prompt')?.dataset.sessionId;
  const markup = id ? remoteStartStrip(id) : '';
  if (old) { if (old.outerHTML !== markup) { if (markup) old.outerHTML = markup; else old.remove(); } }
  else if (markup && composer) composer.insertAdjacentHTML('beforebegin', markup);
  watch();
}

/** Keeps the strip when the composer area re-renders, only while there is one to show. */
function watch(): void {
  const area = document.querySelector('#composer-area');
  if (!starts.size || !area) { observer?.disconnect(); observer = undefined; return; }
  if (observer) return;
  observer = new MutationObserver(() => {
    const id = document.querySelector<HTMLTextAreaElement>('#prompt')?.dataset.sessionId;
    if (id && starts.has(id) !== Boolean(document.querySelector('#composer-area .remote-start-strip'))) syncRemoteStartStrip();
  });
  observer.observe(area, { childList: true });
}

/** A host's stage: matched by start id (the viewer's task id), else the computer. */
export function onRemoteStartProgress(event: RemoteStartProgress): void {
  if (!event || !STAGES.includes(event.stage)) return;
  const start = (event.startId && [...starts.values()].find(item => item.startId === event.startId)) || [...starts.values()].find(item => item.deviceId === event.deviceId && item.stage !== 'error');
  if (!start || start.deviceId !== event.deviceId) return;
  // A frame that arrives late never moves a start backwards, except into an error.
  if (event.stage !== 'error' && STAGES.indexOf(event.stage) < STAGES.indexOf(start.stage)) return;
  Object.assign(start, { stage: event.stage, repo: event.repo ?? start.repo, percent: event.stage === 'downloading' ? event.percent ?? null : null, detail: event.stage === 'error' || event.stage === 'starting' ? event.detail ?? null : null });
  start.onStage?.(start);
  // A start being cancelled, or one whose reply was lost, ends with this frame.
  if (event.stage === 'error' && (start.cancelling || start.waiting)) start.settle?.(new Error(start.detail || 'the other computer did not answer'));
  syncRemoteStartStrip();
}
const waitingFor = (start: RemoteStart): boolean => start.stage === 'starting' && Boolean(start.detail?.startsWith('Waiting for'));

function listen(): Promise<unknown> {
  // bridge.ts has no typed overload for this event.
  return listening ??= (subscribe as unknown as (name: string, callback: typeof onRemoteStartProgress) => Promise<() => void>)(EVENT, onRemoteStartProgress).catch(() => { listening = undefined; });
}

const message = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : t('the other computer did not answer');

/** Runs `start` (the `remote_start_task` call, given the start id to pass as `startId`)
 * with progress shown for `sessionId`. Resolves or rejects like `start`; a failure stays
 * as the strip's error, whose Retry calls `retry` (default: send the composer again).
 * With `onStage`, each stage goes to it instead of the strip, which then shows only a failure. */
export async function trackRemoteStart<T>(sessionId: string, target: { deviceId: string; name: string }, start: (startId: string) => Promise<T>, retry?: () => void, onStage?: (start: RemoteStart) => void): Promise<T> {
  await listen();
  const entry: RemoteStart = { sessionId, deviceId: target.deviceId, device: target.name, repo: null, stage: 'connecting', percent: null, detail: null, retry, onStage };
  starts.set(sessionId, entry);
  syncRemoteStartStrip();
  // Settled early by a cancellation, by the error frame of a start being cancelled, and,
  // once the reply was lost, by the task attaching or failing.
  let ended: Promise<void> = new Promise((resolve, reject) => { entry.settle = error => error ? reject(error) : resolve(); });
  ended.catch(() => undefined);
  try {
    // A new id per deliberate attempt: the host remembers a failed or cancelled startId.
    const attempt = `${sessionId}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    entry.startId = attempt;
    const call = start(attempt);
    call.catch(() => undefined);
    const result = await Promise.race([call, ended.then(() => call)]);
    if (waitingFor(entry) && starts.get(sessionId) === entry) {
      // The row was kept: Stop still cancels the start until the task attaches or fails.
      entry.waiting = true;
      const mirror = (result as { sessionId?: unknown } | null)?.sessionId;
      if (typeof mirror === 'string') entry.mirrorId = mirror;
      ended = new Promise((resolve, reject) => { entry.settle = error => error ? reject(error) : resolve(); });
      await ended;
    }
    starts.delete(sessionId);
    return result;
  } catch (error) {
    if (starts.get(sessionId) === entry) {
      if (entry.cancelling) starts.delete(sessionId);
      else Object.assign(entry, { stage: 'error', percent: null, waiting: false, detail: entry.stage === 'error' && entry.detail ? entry.detail : message(error) });
    }
    throw error;
  } finally { entry.settle = undefined; syncRemoteStartStrip(); }
}

/** The task of a start whose reply was lost spoke (its first agent event): it attached. */
export function remoteStartAttached(sessionId: string): void {
  const start = starts.get(sessionId) ?? [...starts.values()].find(item => item.mirrorId === sessionId);
  if (start?.waiting) start.settle?.();
}

/** Ends a start the viewer cancelled (`remote_cancel_start` answered `cancelled: true`). */
export function cancelledRemoteStart(sessionId: string): void {
  const start = starts.get(sessionId);
  if (start?.cancelling) start.settle?.(new Error('Start cancelled.'));
}

export function clearRemoteStart(sessionId: string): void {
  const start = starts.get(sessionId);
  if (start && starts.delete(sessionId)) { start.settle?.(new Error('Start cancelled.')); syncRemoteStartStrip(); }
}

document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest?.<HTMLElement>('[data-remote-start]');
  const id = document.querySelector<HTMLTextAreaElement>('#prompt')?.dataset.sessionId;
  if (!button || !id) return;
  event.preventDefault(); event.stopPropagation();
  const start = starts.get(id);
  clearRemoteStart(id);
  if (button.dataset.remoteStart !== 'retry') return;
  if (start?.retry) start.retry();
  else document.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
});
