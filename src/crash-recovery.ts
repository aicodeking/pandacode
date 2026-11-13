/* After a crash the native guard (src-tauri) may restart PandaCode. This asks it, once per launch,
 * whether this launch follows a crash (boot reads the answer before reopening the last thread) and
 * says so in the app's toast: what happened, when, a plain cause, which thread boot kept closed
 * (or that it opened none), and that restarts are paused after repeated crashes. Without a crash
 * it says when the window's content died, unless the reload brought everything back (then only
 * the console hears of it). Its actions: Open thread for the kept-closed thread first, then Show
 * crash report when one was kept, then Crash settings when restarts are off; only Open thread is
 * ever the accented button. The notice stays until the user closes it or opens the thread
 * (by its button or any other way) when nothing else is left in it; with a report, the restarts-off
 * line, a paused notice's resume line or the agents line, opening the thread only drops the
 * sentence and button about it, quietly, and the notice stays. A kept-closed thread deleted or
 * archived meanwhile loses its sentence and button the next time the notice is written. It steps
 * aside for other toasts and comes back, unannounced and without its entrance, after them. Its
 * text is rewritten in place when the date changes, paused, when restarts resume, when the last
 * Interrupted task is resumed or removed (its agents sentence goes), and when the Settings switch
 * changes (`crashRestartChanged`: on, the restarts-off sentence and Crash settings go). The report stays on this
 * computer; revealing it only opens the file manager. A failing call never affects startup: it is
 * logged and nothing is shown. Once a crash notice is on screen the page calls `crash_recovery_shown`. */
import { call } from './bridge';
import { OPEN_THREAD, resumesAt, WINDOW_RELOADED_LINE, crashNotice, interruptedByCrash, openThreadName, reloadNotice, parseCrashRecovery, untilNextDay, type CrashRecovery, type WindowDeath } from './crash-recovery-model';
import type { Session } from './types';

/** `name`: an accessible name fuller than the label; `keep`: using it leaves the toast showing;
 * `quiet`: a quieter button even when it comes first. */
type Action = { label: string; run: () => void; name?: string; keep?: boolean; quiet?: boolean };
export interface CrashRecoveryHost {
  /** The toast: text, its actions (the first primary, the rest quieter), how long it stays
   * (Infinity: until closed), a close button calling `dismiss`, and `quiet` to bring it back as it
   * was: unannounced (it was announced before) and without its entrance animation. `tone: 'danger'` marks a failure. */
  notify(text: string, actions: readonly Action[], holdMs: number, dismiss?: () => void, quiet?: boolean, tone?: 'danger'): void;
  /** The one toast element `notify` fills: its text first, then its buttons. */
  toast: HTMLElement;
  tasks(): readonly Session[];
  /** The thread boot kept closed because opening it may have caused the crash, while it still
   * exists, is not archived and has not been opened since; asked each time the notice is written. */
  heldBack(): (Pick<Session, 'id' | 'title'> & { notLast?: boolean }) | undefined;
  /** Boot opened no thread by itself, in case one caused this; asked each time the notice is written. */
  nothingOpened(): boolean;
  /** Opens a thread the user chose. */
  openThread(id: string): void;
  /** Opens Settings → General at the Crash recovery group. */
  openCrashSettings(): void;
  /** The window's content died before this page (launch-restore.ts), and how. */
  windowDied(): WindowDeath | undefined;
  /** Hides the toast with the app's usual dismissal cleanup, without calling the notice's `dismiss`
   * again (the notice is showing and has nothing left to say). */
  hide(): void;
}

export const SHOW_REPORT = 'Show crash report';
/** The notice's way to the switch when restarts are off; its accessible name says where it goes. */
export const CRASH_SETTINGS = 'Crash settings';
const CRASH_SETTINGS_NAME = 'Crash settings, in Settings › General › Crash recovery';
export { OPEN_THREAD };
/** The longest wait before the visible notice's date is checked again (a sleeping computer stops timers). */
const DATE_CHECK = 60 * 60_000;

let answer: Promise<CrashRecovery | null> | undefined;
let shown = false;
/** Set while a notice names a kept-closed thread; see heldBackOpened. */
let onHeldBackOpened: (() => void) | undefined;
/** Set while a notice is up; see tasksChanged. */
let onTasksChanged: (() => void) | undefined;
/** Set while a crash notice is up; see crashRestartChanged. */
let onRestartChanged: ((enabled: boolean) => void) | undefined;

/** The Settings switch was saved (crash-restart-settings.ts): a notice that says restarts are off,
 * or would now, is written again, unannounced. */
export function crashRestartChanged(enabled: boolean): void { onRestartChanged?.(enabled); }

/** The kept-closed thread was opened, by the notice's button or any other way (main.ts openThread
 * calls this, after which host.heldBack() no longer returns it): its sentence and button go, and
 * the notice stays for what else it says or ends. */
export function heldBackOpened(): void { onHeldBackOpened?.(); }

/** The task list or a task's status changed (main.ts calls this whenever the sidebar renders), or a
 * thread opened after boot opened none: the showing notice is rewritten in place, unannounced, when
 * its wording changes, e.g. its agents sentence goes once no Interrupted task is left, or its
 * nothing-opened wording goes. */
export function tasksChanged(): void { onTasksChanged?.(); }

/** Some task still shows as Interrupted. */
const anyInterrupted = (tasks: readonly Session[]) => tasks.some(task => !task.archived && task.status === 'interrupted');

/** This launch's crash recovery, asked of the native guard once per page; null on a normal launch or
 * error. The guard answers the same until `crash_recovery_shown`, so a page that dies before the
 * notice shows does not lose it. */
export function takeCrashRecovery(): Promise<CrashRecovery | null> {
  return answer ??= call<unknown>('crash_recovery_take').then(parseCrashRecovery, error => {
    console.warn('Could not check for a crash restart:', error);
    return null;
  });
}

/** Whether the Settings switch is off; undefined when it cannot be read. */
async function restartsOff(recovery: CrashRecovery): Promise<boolean | undefined> {
  if (recovery.restarted || recovery.restartsPaused) return undefined;
  return call<boolean>('crash_restart_enabled').then(enabled => enabled === false, () => undefined);
}

export async function showCrashRecovery(host: CrashRecoveryHost, now = Date.now): Promise<void> {
  const recovery = await takeCrashRecovery();
  if (shown) return;
  const death = host.windowDied();
  if (!recovery && !host.heldBack() && !death) return;
  shown = true;
  // A first reload that brought the user's thread back needs nothing from them: no toast.
  if (!recovery && !host.heldBack() && !host.nothingOpened() && death === 'reloaded') { console.info(WINDOW_RELOADED_LINE); return; }
  // Without a crash notice, the window's content died (launch-restore.ts).
  const interruptedAtFirst = recovery && interruptedByCrash(recovery, host.tasks());
  // Changes with the Settings switch (crashRestartChanged), so read at each write.
  let off = recovery ? await restartsOff(recovery) : undefined;
  // The agents sentence holds while an Interrupted task is left; when the list showed none to begin
  // with (the guard's answer alone), there is nothing to watch or open: it stays, in its plain form.
  const watching = anyInterrupted(host.tasks());
  const interrupted = () => Boolean(interruptedAtFirst) && (!watching || anyInterrupted(host.tasks()));
  const write = () => {
    const held = host.heldBack(), nothingOpened = host.nothingOpened();
    return recovery ? crashNotice(recovery, now(), { restartsOff: off, interrupted: interrupted(), agentsHidden: !watching, heldBack: held?.title, notLast: held?.notLast, nothingOpened }) : { text: reloadNotice(held?.title, death, nothingOpened, held?.notLast), showReport: false, showSettings: false };
  };
  const report = write().showReport;
  /** Without the kept-closed thread, the notice still has something to say: the report's button,
   * the restarts-off line and Crash settings, when restarts resume (paused), or the agents line. */
  const remains = () => report || Boolean(recovery && (recovery.restartsPaused || off || interrupted()));
  const actions = (): readonly Action[] => {
    const thread = host.heldBack(), settings = write().showSettings;
    return [
      ...thread ? [{ label: OPEN_THREAD, name: openThreadName(thread.title), keep: remains(), run: () => openHeld(thread.id) }] : [],
      // Quiet without Open thread too: only Open thread ever takes the accent fill.
      ...report ? [{ label: SHOW_REPORT, keep: true, quiet: !thread, run: () => revealReport(host) }] : [],
      // Settings covers the notice while it is open; it is there again, unannounced, after.
      ...settings ? [{ label: CRASH_SETTINGS, name: CRASH_SETTINGS_NAME, keep: true, quiet: true, run: () => host.openCrashSettings() }] : [],
    ];
  };
  /** Its button: a thread gone since the notice was written only rewrites the notice. */
  const openHeld = (id: string) => {
    if (host.heldBack()?.id !== id) { lasting.refresh?.(); return; }
    // The button hides the toast itself when nothing else would be left in it.
    if (!remains()) lasting.end?.();
    host.openThread(id);
  };
  const lasting: Lasting = {
    toast: host.toast,
    text: () => write().text,
    actions: () => actions().map(action => action.label).join('\n'),
    show: (text, quiet) => host.notify(text, actions(), Infinity, () => lasting.end?.(), quiet),
    hide: () => host.hide(),
    // Only a crash notice carries a time.
    now: recovery ? now : undefined,
    // Paused: 'Automatic restarts resume by …' gives way to 'Automatic restarts are on again.' (and the report line) once the guard's window has passed.
    changesAt: recovery?.restartsPaused ? resumesAt(recovery.crashedAt) : undefined,
  };
  onHeldBackOpened = () => { if (remains()) lasting.refresh?.(); else lasting.close?.(); };
  keepUntilClosed(lasting);
  onTasksChanged = () => lasting.rewrite?.();
  // Its buttons change with the sentence, so it is written whole (still unannounced); off screen it is written afresh on its return.
  if (recovery && off !== undefined) onRestartChanged = enabled => { off = !enabled; lasting.refresh?.(); };
  // On screen now: the guard stops repeating it (until this, a page that died first gets it again).
  if (recovery) acknowledge();
}

/** Tells the guard the crash notice has been shown; a failure is logged and ignored. */
function acknowledge(): void {
  call('crash_recovery_shown').catch(error => console.warn('Could not mark the crash notice as shown:', error));
}

interface Lasting {
  toast: HTMLElement;
  /** The notice as it reads now. */
  text(): string;
  /** Its buttons as they are now, as one string to tell a change. */
  actions(): string;
  show(text: string, quiet: boolean): void;
  hide(): void;
  /** Set when the text holds a clock time, which reads differently once the date changes. */
  now?: () => number;
  /** A moment (ms since the epoch, by `now`) when the text changes for another reason. */
  changesAt?: number;
  /** Ends the notice for good; set by keepUntilClosed. */
  end?: () => void;
  /** Writes the notice again, text and actions, unannounced; set by keepUntilClosed. */
  refresh?: () => void;
  /** Rewrites the showing notice in place when its text or buttons changed; set by keepUntilClosed. */
  rewrite?: () => void;
  /** Ends the notice and hides it when it is the one showing; set by keepUntilClosed. */
  close?: () => void;
}

/** Shows the notice and, whenever another toast has taken its place and gone, shows it again
 * as it was (not announced a second time, no entrance). The toast is one slot, so this is the
 * queue. While the notice is the one showing, its text is rewritten in place when the date changes
 * (its "at 14:32" would read as today) and at `changesAt` (paused restarts have resumed), again
 * unannounced. Coming back after another toast, it is written afresh anyway. */
function keepUntilClosed(notice: Lasting): void {
  const { toast } = notice;
  let ours = false, done = false, timer: ReturnType<typeof setTimeout> | undefined, buttons = '';
  const observer = new MutationObserver(records => {
    // Its children changed: another toast (or the failed reveal's error) took the slot.
    if (records.some(record => record.type === 'childList')) ours = false;
    if (done || !toast.hidden) return;
    present(true);
  });
  const present = (quiet: boolean) => {
    buttons = notice.actions();
    notice.show(notice.text(), quiet);
    // Its own changes are not another toast's.
    observer.takeRecords();
    ours = true;
  };
  /** Rewrites the showing notice in place when its text has changed, or whole (still unannounced)
   * when its buttons have (the kept-closed thread is gone). */
  const rewrite = () => {
    // The text is the first node of the toast's live region (`.toast-text`).
    const text = notice.text(), label = toast.querySelector<HTMLElement>(':scope > .toast-text'), node = label?.firstChild;
    if (done || !ours || toast.hidden || !label || node?.nodeType !== Node.TEXT_NODE) return;
    if (notice.actions() !== buttons) { present(true); return; }
    if (node.nodeValue === text) return;
    // Already announced: the new wording is not read out.
    for (const live of [toast, label]) live.setAttribute('aria-live', 'off');
    node.nodeValue = text;
  };
  const checkDate = () => {
    if (done || !notice.now) return;
    rewrite();
    timer = setTimeout(checkDate, Math.min(untilNextDay(notice.now()), DATE_CHECK));
  };
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  // Not showing (another toast has the slot): it is written afresh when it comes back.
  notice.refresh = () => { if (!done && ours && !toast.hidden) present(true); };
  notice.rewrite = rewrite;
  notice.end = () => { done = true; clearTimeout(timer); clearTimeout(changeTimer); observer.disconnect(); onHeldBackOpened = undefined; onTasksChanged = undefined; onRestartChanged = undefined; };
  notice.close = () => {
    const showing = !done && ours && !toast.hidden;
    notice.end?.();
    if (showing) notice.hide();
  };
  observer.observe(toast, { attributes: true, attributeFilter: ['hidden'], childList: true });
  present(false);
  if (notice.now) {
    timer = setTimeout(checkDate, Math.min(untilNextDay(notice.now()), DATE_CHECK));
    const wait = notice.changesAt === undefined ? -1 : notice.changesAt - notice.now();
    if (wait > 0) changeTimer = setTimeout(rewrite, wait);
  }
}

/** Opens the file manager at the report. The notice stays; on failure the error takes the toast
 * for a moment and the notice comes back after it (keepUntilClosed). */
function revealReport(host: CrashRecoveryHost): void {
  call('crash_report_reveal').catch(error => {
    console.warn('Could not show the crash report:', error);
    host.notify(`Could not show the crash report: ${errorMessage(error)}`, [], 6000, undefined, false, 'danger');
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}
