/** Desktop notifications when a task needs approval or input, or ends. The pure rules live in
 * notifications-model.ts; the banner and sound are drawn natively (notifications_show in
 * src-tauri/src/notifications.rs). A banner only shows while PandaCode is unfocused; while
 * focused, approval and question events may still play the chosen sound. */
import { call } from './bridge';
import { batchNotice, createCoalescer, gate, notice, readSettings, saveSetting, soundOf, type NotificationEventKind, type Notice, type NotificationSettings } from './notifications-model';

export { DEFAULT_SETTINGS, SOUNDS, SOUND_NONE, readSettings, saveSetting } from './notifications-model';
export type { NotificationEventKind, NotificationSettings } from './notifications-model';

/** Approval and question requests inside the window leave as one notification. */
const requests = createCoalescer({
  now: Date.now,
  schedule: (run, ms) => window.setTimeout(run, ms),
  cancel: handle => window.clearTimeout(handle as number),
  flush: batch => {
    const on = readSettings(localStorage);
    show(batchNotice(batch, on.hideDetails), on);
  },
});

/** Called from onAgent for every event a notification may follow. Task titles are already
 * trimmed of the thread suffix by the callers. */
export function notifyEvent(kind: NotificationEventKind, sessionId: string, title: string): void {
  const on = readSettings(localStorage);
  const action = gate(kind, on, document.hasFocus());
  if (!action) return;
  if (action === 'sound') {
    // Focused: the banner stays suppressed; only the chosen sound plays.
    const text = notice(kind, title, on.hideDetails);
    void call('notifications_show', { title: text.title, body: text.body, sessionId, sound: soundOf(on), suppressBanner: true }).catch(() => undefined);
    return;
  }
  // Finished and failed tasks never coalesce; requests wait out the window together.
  if (kind === 'approval' || kind === 'input') requests.add(kind, sessionId, title);
  else show(notice(kind, title, on.hideDetails), on);
}

function show(text: Notice, on: NotificationSettings): void {
  void call('notifications_show', { title: text.title, body: text.body, sessionId: text.sessionId, sound: soundOf(on), suppressBanner: false }).catch(() => undefined);
}
