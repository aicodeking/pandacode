/* Settings → Notifications: when PandaCode may show a system notification (only while another app
 * is in front, unless the focused chime is on), which events count, the macOS sound, and how much
 * of the task a notice may name. Choices are plain localStorage (notifications-model.ts); the
 * banner itself is drawn natively (notifications_show in src-tauri/src/notifications.rs). */
import { readSettings, saveSetting, SOUNDS, SOUND_NONE } from './notifications-model';

export const MASTER_TITLE = 'Notify when PandaCode is not focused';
export const MASTER_DETAIL = 'Shows a system notification when a task needs approval or your answer, or finishes or fails, while another app is in front.';
export const FOCUSED_SOUND_TITLE = 'Play sound when PandaCode is focused';
export const FOCUSED_SOUND_DETAIL = 'Applies to approvals and questions only; the banner stays hidden while you are working in PandaCode.';
export const HIDE_DETAILS_TITLE = 'Hide task details';
export const HIDE_DETAILS_DETAIL = 'Notifications say only that PandaCode needs you, never the task’s name.';

const row = (title: string, control: string, detail = '') =>
  `<div class="setting-row"><div><strong>${title}</strong>${detail ? `<small>${detail}</small>` : ''}</div>${control}</div>`;
const switchRow = (id: string, title: string, detail: string, checked: boolean) =>
  row(title, `<input type="checkbox" role="switch" class="settings-switch" id="${id}" aria-label="${title}" ${checked ? 'checked' : ''}>`, detail);

/** The rows and the sound picker, drawn before the stored choices arrive and corrected on mount. */
export function notificationsSettingsHtml(): string {
  const sounds = [SOUND_NONE, ...SOUNDS].map(sound => `<option value="${sound}">${sound === SOUND_NONE ? 'None' : sound}</option>`).join('');
  return `<div class="settings-group" id="notifications-settings">
    ${switchRow('notifications-enabled', MASTER_TITLE, MASTER_DETAIL, true)}
    ${switchRow('notifications-approval', 'Approval requested', '', true)}
    ${switchRow('notifications-input', 'Input requested', '', true)}
    ${switchRow('notifications-finished', 'Task finished', '', false)}
    ${switchRow('notifications-failed', 'Task failed', '', false)}
    ${switchRow('notifications-sound-focused', FOCUSED_SOUND_TITLE, FOCUSED_SOUND_DETAIL, false)}
    ${row('Sound', `<select id="notifications-sound" class="settings-select" aria-label="Sound">${sounds}</select>`, 'The macOS system sound played with a notification.')}
    ${switchRow('notifications-hide-details', HIDE_DETAILS_TITLE, HIDE_DETAILS_DETAIL, false)}
  </div>`;
}

/** Wires the rows to the stored settings; a flip saves at once and survives the reload of this page. */
export function mountNotificationsSettings(host: HTMLElement): () => void {
  const saved = readSettings(localStorage);
  const switches: { id: string; key: 'enabled' | 'approval' | 'input' | 'finished' | 'failed' | 'soundWhenFocused' | 'hideDetails' }[] = [
    { id: 'notifications-enabled', key: 'enabled' },
    { id: 'notifications-approval', key: 'approval' },
    { id: 'notifications-input', key: 'input' },
    { id: 'notifications-finished', key: 'finished' },
    { id: 'notifications-failed', key: 'failed' },
    { id: 'notifications-sound-focused', key: 'soundWhenFocused' },
    { id: 'notifications-hide-details', key: 'hideDetails' },
  ];
  for (const { id, key } of switches) {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    if (input) input.checked = saved[key];
  }
  const sound = host.querySelector<HTMLSelectElement>('#notifications-sound');
  if (sound) sound.value = saved.sound;
  const change = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      const match = switches.find(item => item.id === target.id);
      if (match) saveSetting(localStorage, match.key, target.checked);
    }
    if (target instanceof HTMLSelectElement && target.id === 'notifications-sound') saveSetting(localStorage, 'sound', target.value);
  };
  host.addEventListener('change', change);
  return () => host.removeEventListener('change', change);
}
