/** Desktop notifications when a task needs approval or input, or ends. The pure rules live in
 * notifications-model.ts; the banner and sound are drawn natively (notifications_show in
 * src-tauri/src/notifications.rs). A banner only shows while PandaCode is unfocused; while
 * focused, approval and question events may still play the chosen sound. */
import { call } from './bridge';
import { batchNotice, createCoalescer, flushGate, gate, notice, readSettings, saveSetting, soundOf, type NotificationEventKind, type Notice, type NotificationSettings, type PendingRequest } from './notifications-model';

export { DEFAULT_SETTINGS, SOUNDS, SOUND_NONE, readSettings, saveSetting } from './notifications-model';
export type { NotificationEventKind, NotificationSettings } from './notifications-model';

/** A failed notification must not nag: the reason goes to the console, not the screen. */
const warn = (error: unknown) => console.warn('notifications_show failed:', error instanceof Error ? error.message : String(error));

/** Approval and question requests inside the window leave as one notification. */
const requests = createCoalescer({
  now: Date.now,
  schedule: (run, ms) => window.setTimeout(run, ms),
  cancel: handle => window.clearTimeout(handle as number),
  flush: flushRequests,
});

/** Called from onAgent for every event a notification may follow. Task titles are already
 * trimmed of the thread suffix by the callers. */
export function notifyEvent(kind: NotificationEventKind, sessionId: string, title: string, requestId?: string): void {
  const on = readSettings(localStorage);
  const action = gate(kind, on, document.hasFocus());
  if (!action) return;
  if (action === 'sound') {
    // Focused: the banner stays suppressed; only the chosen sound plays.
    const text = notice(kind, title, on.hideDetails);
    void call('notifications_show', { title: text.title, body: text.body, sessionId, sound: soundOf(on), suppressBanner: true, soundWhenFocused: on.soundWhenFocused }).catch(warn);
    return;
  }
  // Finished and failed tasks never coalesce; requests wait out the window together, and a
  // cancellation during it takes its request back out.
  if (kind === 'approval' || kind === 'input') requests.add(kind, sessionId, title, requestId);
  else show({ ...notice(kind, title, on.hideDetails), sessionId }, on);
}

/** A cancelled request must not be counted by the batch that is still waiting. */
export function cancelRequest(kind: 'approval' | 'input', sessionId: string, requestId?: string): void {
  requests.cancel(kind, sessionId, requestId);
}

/** Every request of a session leaves the batch: its run ended, or the session is gone. */
export function cancelSession(sessionId: string): void {
  requests.clear(sessionId);
}

/** The window has ended. The gate is re-checked here, because the app may have been focused
 * (or the notifications turned off) since the requests arrived. */
function flushRequests(batch: PendingRequest[]): void {
  const on = readSettings(localStorage), focused = document.hasFocus();
  const gated = flushGate(batch, on, focused);
  if (!gated) return;
  const text = batchNotice(gated.batch, on.hideDetails);
  if (gated.action === 'sound') {
    // Downgraded while it waited: the banner stays hidden, only the chosen sound plays.
    void call('notifications_show', { title: text.title, body: text.body, sessionId: text.sessionId, sound: soundOf(on), suppressBanner: true, soundWhenFocused: on.soundWhenFocused }).catch(warn);
    return;
  }
  show(text, on);
}

function show(text: Notice, on: NotificationSettings): void {
  void call('notifications_show', { title: text.title, body: text.body, sessionId: text.sessionId, sound: soundOf(on), suppressBanner: false, soundWhenFocused: on.soundWhenFocused }).catch(warn);
}
