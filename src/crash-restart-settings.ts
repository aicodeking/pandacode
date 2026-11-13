/* Settings → General → Crash recovery: the crash guard's switch, Show latest crash report, Keep unsent drafts, and a note on kept drafts with Clear saved drafts. The switch
 * reads `crash_restart_enabled` (aria-disabled, so Crash settings can still focus it, busy and showing neither state until it answers; on, the native default, when the
 * read fails), writes
 * `set_crash_restart_enabled` (then tells a showing crash notice, `crashRestartChanged`), and puts itself back with the error shown when either call fails.
 * The button asks `crash_report_reveal` to show a report in the file manager: the one of this launch's crash notice, else the newest. */
import { call } from './bridge';
import { crashRestartChanged } from './crash-recovery';
import { DRAFT_MAX_AGE } from './launch-restore';

export const CRASH_RESTART_TITLE = 'Restart automatically after a crash';
export const CRASH_RESTART_DETAIL = "If PandaCode crashes, it restarts itself, pausing after repeated crashes. It won't restart if you force it to quit or the system ends it.";
/** It reveals one file, not the folder: this launch's crash report, else the newest. */
export const SHOW_REPORTS = 'Show latest crash report';
/** Said once for the group: what a report holds, where it stays, and how to report a problem. */
export const CRASH_REPORTS_DETAIL = 'Written when PandaCode crashes and kept on this computer. A report can contain file paths, text from your work or credentials, so check it before attaching it to a GitHub issue.';
/** Unsent text, in existing threads, New task and shared bot channels, is written to local storage on every change
 * (launch-restore.ts) and kept until DRAFT_MAX_AGE; attachments and drafts over its size cap are
 * not kept, which the parenthesis says without a number. A note under the group, under the
 * KEEP_DRAFTS switch it describes, with CLEAR_DRAFTS beside it (DRAFTS_OFF_DETAIL while off). It ends with when the text goes. */
export const DRAFTS_KEPT_DETAIL = `The text of unsent messages (not attachments or very long drafts) is saved locally as plain text, so a crash rarely loses it. A pasted secret is kept too, until the message is sent, cleared, or ${Math.round(DRAFT_MAX_AGE / 86_400_000)} days old.`;
/** The note while Keep unsent drafts is off. */
export const DRAFTS_OFF_DETAIL = 'Unsent messages are not saved; a crash or quit loses them.';
/** Off: nothing is written and every stored draft goes (PersistedDrafts.setKeeping). */
export const KEEP_DRAFTS = 'Keep unsent drafts';
/** Removes every stored draft; text in an open composer stays on screen, unstored until its next change. */
export const CLEAR_DRAFTS = 'Clear saved drafts';
export const NO_REPORTS = 'There are no crash reports on this computer.';
/** The no-reports line clears itself after this long. */
export const STATUS_CLEAR_MS = 5000;
/** The native refusal when no report exists (crash_guard/commands.rs `crash_report_reveal`). */
const NO_REPORT_ERROR = /no crash report/i;

const reason = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

/** A switch row like its neighbours: visible one-line description, tied to the switch for screen readers. */
export function crashRestartSettingsHtml(): string {
  return `<div class="settings-group" id="crash-restart-settings"><div class="setting-row"><div><strong>${CRASH_RESTART_TITLE}</strong><small id="crash-restart-about">${CRASH_RESTART_DETAIL}</small></div><input type="checkbox" role="switch" class="settings-switch" id="crash-restart-enabled" aria-label="${CRASH_RESTART_TITLE}" aria-describedby="crash-restart-about" aria-disabled="true" aria-busy="true"></div><div class="setting-row"><div><strong>Crash reports</strong><small id="crash-reports-about">${CRASH_REPORTS_DETAIL}</small></div><button type="button" class="ds-btn" id="crash-reports-reveal" aria-describedby="crash-reports-about">${SHOW_REPORTS}</button></div><div class="setting-row"><div><strong>${KEEP_DRAFTS}</strong></div><input type="checkbox" role="switch" class="settings-switch" id="crash-drafts-keep" aria-label="${KEEP_DRAFTS}" aria-describedby="crash-drafts-note" checked></div><div class="crash-drafts"><small class="settings-group-note" id="crash-drafts-note">${DRAFTS_KEPT_DETAIL}</small><button type="button" class="ds-btn" id="crash-drafts-clear" aria-describedby="crash-drafts-note">${CLEAR_DRAFTS}</button></div><small class="crash-reports-status" role="status" hidden></small><small class="settings-embed-error" role="alert" hidden></small></div>`;
}

/** Keep unsent drafts: the stored choice and its setter (main.ts, through PersistedDrafts). */
export interface KeepDrafts { get(): boolean; set(on: boolean): void }

/** `clearDrafts`: removes the saved drafts (main.ts, through PersistedDrafts) and confirms with a toast. */
export function mountCrashRestartSettings(host: HTMLElement, clearDrafts?: () => void, keepDrafts?: KeepDrafts): () => void {
  const input = host.querySelector<HTMLInputElement>('#crash-restart-enabled');
  const alert = host.querySelector<HTMLElement>('.settings-embed-error');
  if (!input || !alert) return () => {};
  let disposed = false, saved = true;
  const showError = (text: string) => { alert.textContent = text; alert.hidden = !text; };
  const change = async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await call('set_crash_restart_enabled', { enabled: next });
      // Saved, even if Settings closed meanwhile: a crash notice that says restarts are off (or would now) is written again.
      crashRestartChanged(next);
      if (disposed) return;
      saved = next; showError('');
    } catch (error) {
      if (disposed) return;
      input.checked = saved;
      showError(`Could not change automatic restarts: ${reason(error)}`);
    } finally {
      if (!disposed) { input.disabled = false; input.focus({ preventScroll: true }); }
    }
  };
  input.addEventListener('change', change);
  const stopReveal = mountRevealReports(host, showError, () => disposed);
  const clear = host.querySelector<HTMLButtonElement>('#crash-drafts-clear');
  const clearSaved = () => clearDrafts?.();
  if (clear) clear.hidden = !clearDrafts;
  clear?.addEventListener('click', clearSaved);
  const stopKeep = mountKeepDrafts(host, keepDrafts);
  // Until the stored value is known the switch shows no state, so a user who turned restarts off never sees it flash on.
  const loaded = (value: boolean) => { saved = value; input.checked = value; input.removeAttribute('aria-disabled'); input.removeAttribute('aria-busy'); };
  // Still focusable while it loads (Crash settings lands on it), but a click or Space changes nothing.
  const hold = (event: Event) => { if (input.hasAttribute('aria-busy')) event.preventDefault(); };
  input.addEventListener('click', hold);
  call<boolean>('crash_restart_enabled').then(value => {
    if (!disposed) loaded(value !== false);
  }, error => {
    if (disposed) return;
    loaded(true);
    showError(`Could not read the automatic restart setting: ${reason(error)}`);
  });
  return () => { disposed = true; input.removeEventListener('click', hold); input.removeEventListener('change', change); clear?.removeEventListener('click', clearSaved); stopKeep(); stopReveal(); };
}

/** The Keep unsent drafts switch; the note under it says what happens to unsent text in either state. */
function mountKeepDrafts(host: HTMLElement, keepDrafts?: KeepDrafts): () => void {
  const input = host.querySelector<HTMLInputElement>('#crash-drafts-keep');
  const note = host.querySelector<HTMLElement>('#crash-drafts-note');
  if (!input || !note) return () => {};
  const show = (on: boolean) => { input.checked = on; note.textContent = on ? DRAFTS_KEPT_DETAIL : DRAFTS_OFF_DETAIL; };
  const row = input.closest<HTMLElement>('.setting-row');
  if (row) row.hidden = !keepDrafts;
  if (!keepDrafts) return () => {};
  show(keepDrafts.get());
  const change = () => { keepDrafts.set(input.checked); show(keepDrafts.get()); };
  input.addEventListener('change', change);
  return () => input.removeEventListener('change', change);
}

function mountRevealReports(host: HTMLElement, showError: (text: string) => void, disposed: () => boolean): () => void {
  const button = host.querySelector<HTMLButtonElement>('#crash-reports-reveal');
  const status = host.querySelector<HTMLElement>('.crash-reports-status');
  if (!button || !status) return () => {};
  let clearTimer: number | undefined;
  const showStatus = (text: string) => {
    window.clearTimeout(clearTimer);
    status.textContent = text; status.hidden = !text;
    if (text) clearTimer = window.setTimeout(() => showStatus(''), STATUS_CLEAR_MS);
  };
  const reveal = async () => {
    showStatus(''); showError('');
    try { await call('crash_report_reveal'); }
    catch (error) {
      if (disposed()) return;
      const text = reason(error);
      if (NO_REPORT_ERROR.test(text)) showStatus(NO_REPORTS);
      else { console.warn('Could not show the crash report:', error); showError(`Could not show the crash report: ${text}`); }
    }
  };
  button.addEventListener('click', reveal);
  return () => { window.clearTimeout(clearTimer); button.removeEventListener('click', reveal); };
}
