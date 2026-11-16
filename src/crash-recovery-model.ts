/* Crash recovery, the pure half: validating the native answer of `crash_recovery_take` and
 * writing the notice the app shows on the launch after a crash (src/crash-recovery.ts). */

/** What the native crash guard reports once, on the launch after a crash. */
export interface CrashRecovery {
  /** When the crash happened, ms since the epoch. */
  crashedAt: number;
  /** The guard's cause line ("Panic: …", "Crashed with SIGSEGV"); untrusted, never shown as is. */
  summary: string | null;
  hasReport: boolean;
  /** The guard relaunched the app itself; false on a manual launch after a recorded crash. */
  restarted: boolean;
  /** The guard did not relaunch after repeated crashes; this is the first manual launch. */
  restartsPaused: boolean;
  /** The restart marked tasks this crash cut off as Interrupted; absent from an older guard. */
  agentsInterrupted?: boolean;
}

/** `showSettings`: restarts are off, so the notice offers a way to the switch. */
export interface CrashNotice { text: string; showReport: boolean; showSettings: boolean }

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** The native answer, or null when there is nothing to show or it is malformed. */
export function parseCrashRecovery(value: unknown): CrashRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.crashedAt !== 'number' || !Number.isFinite(raw.crashedAt) || raw.crashedAt < 0) return null;
  if (typeof raw.hasReport !== 'boolean' || typeof raw.restartsPaused !== 'boolean' || typeof raw.restarted !== 'boolean') return null;
  const parsed: CrashRecovery = { crashedAt: raw.crashedAt, summary: typeof raw.summary === 'string' ? raw.summary : null, hasReport: raw.hasReport, restarted: raw.restarted, restartsPaused: raw.restartsPaused };
  // Optional: absent or malformed falls back to the task heuristic rather than hiding the notice.
  return typeof raw.agentsInterrupted === 'boolean' ? { ...parsed, agentsInterrupted: raw.agentsInterrupted } : parsed;
}

/** Windows exception phrases the guard writes (crash_guard/policy.rs `exception_name`). */
const PLAIN_EXCEPTIONS = new Set(['an access violation', 'an illegal instruction', 'a stack overflow', 'a fatal error (abort)', 'heap corruption']);

/** The fatal signals the guard reports as a crash (only its fatal handlers send `signal N`; see
 * crash_guard/policy.rs `classify`), in words, with the name kept for searching. A termination
 * signal or SIGKILL is a deliberate exit or a silent kill, never a crash, so it has no phrase. */
const SIGNAL_PHRASES: Readonly<Record<string, string>> = {
  SIGSEGV: 'a memory error', SIGBUS: 'a memory error', SIGILL: 'an invalid instruction', SIGFPE: 'a math error',
  SIGABRT: 'a fatal error', SIGTRAP: 'a fatal error', SIGSYS: 'a blocked system call',
};

/** A cause a user can read: a plain phrase with the signal name or the exception name for an OS
 * crash, null otherwise (a panic says nothing useful in a toast). The guard's own text (panic
 * messages, paths) stays in the report. */
export function plainCause(summary: string | null): string | null {
  const line = summary?.trim() ?? '';
  const crashed = /^crashed with (.+)$/i.exec(line)?.[1].trim() ?? '';
  if (/^SIG[A-Z0-9]{2,10}$/.test(crashed)) return `${SIGNAL_PHRASES[crashed] ?? 'an unexpected signal'} (${crashed})`;
  return PLAIN_EXCEPTIONS.has(crashed) ? crashed : null;
}

/** When the crash happened as a clock time, so a notice that stays for hours never goes stale:
 * "at 14:32" today, "on 3 Nov at 14:32" another day, with the year when it is not this year (in
 * the user's locale; `locale` for tests). */
export function crashTime(at: number, now: number, locale?: string): string {
  const date = new Date(at), today = new Date(now);
  const time = `at ${date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`;
  if (date.toDateString() === today.toDateString()) return time;
  const year = date.getFullYear() === today.getFullYear() ? undefined : 'numeric';
  return `on ${date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year })} ${time}`;
}

/** From `now` to just past the next local midnight, when "at 14:32" stops meaning today. */
export function untilNextDay(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 1, 0);
  return next.getTime() - now;
}

/** Where stopped agents are: plain, team and local machine threads all show Interrupted in the
 * sidebar and board (a team also offers Resume once opened). */
export const INTERRUPTED_LINE = 'Running agents were stopped; their threads show as Interrupted.';
/** INTERRUPTED_LINE's short form, so the closing lines fit under NOTICE_LIMIT; it still says where
 * the agents are. Always used beside a kept-closed thread, which needs the room. */
export const INTERRUPTED_SHORT = 'Stopped agents show as Interrupted.';
/** The guard says agents were stopped but no task shows as Interrupted: nothing to point at or open. */
export const AGENTS_STOPPED_LINE = 'Running agents were stopped.';
/** Short, so stopped agents and a kept-closed thread still fit at MIN_TITLE. */
export const PAUSED_LEAD = "PandaCode kept crashing and didn't restart.";
/** PAUSED_LEAD with the last crash's time (`crashTime`), used while the notice has room for it. */
export const pausedLead = (when: string): string => `PandaCode kept crashing, last ${when}, and didn't restart.`;
/** Boot opened no thread by itself (paused restarts, a window that died again) and none is named;
 * left out of a paused notice once restarts are on again (nothing to act on). */
export const NOTHING_OPENED_LINE = 'No thread was opened, in case one caused this.';
/** With a report, the next step: paused past RESUME_WINDOW (instead of pausedLine), or a crash
 * that was not restarted while restarts are on. */
export const REPORT_LINE = 'If it keeps happening, open a GitHub issue with the crash report (check it for private details first).';
/** REPORT_LINE without its parenthesis, the first thing a notice gives up. */
export const REPORT_SHORT = 'If it keeps happening, open a GitHub issue with the crash report.';
/** REPORT_LINE for the paused notice, which already says it kept crashing. */
export const PAUSED_REPORT_LINE = 'If it crashes again, open a GitHub issue with the crash report (check it for private details first).';
export const PAUSED_REPORT_SHORT = 'If it crashes again, open a GitHub issue with the crash report.';
/** Paused past RESUME_WINDOW: restarts are on again. Never gives way, with or without a report,
 * since the lead still says it didn't restart. */
export const RESTARTS_BACK_LINE = 'Automatic restarts are on again.';
/** The guard's crash-loop window: past it, restarts have resumed and pausedLine would be stale. */
export const RESUME_WINDOW = 10 * MINUTE;
/** The first instant the guard no longer counts the crash (its rule is inclusive, `<=` RESUME_WINDOW):
 * the notice says restarts are on again from here (`crashNotice`, and the rewrite in crash-recovery.ts). */
export const resumesAt = (crashedAt: number): number => crashedAt + RESUME_WINDOW + 1;
/** The latest time paused restarts resume, "by 2:42 PM" (`crashTime` without its "at"/"on"):
 * `resumesAt` rounded up to the minute, so a crash plus RESUME_WINDOW exactly on a minute states the
 * next one. The guard's window slides (3 crashes in 10 minutes, or 2 startup crashes), so they can
 * resume earlier, never later. */
export function resumeTime(crashedAt: number, now: number, locale?: string): string {
  return `by ${crashTime(Math.ceil(resumesAt(crashedAt) / MINUTE) * MINUTE, now, locale).replace(/^(at|on) /, '')}`;
}
/** The paused notice's closing line while restarts are paused; `when` from `resumeTime`. Never
 * gives way (nor does RESTARTS_BACK_LINE after it): a paused notice always says when restarts resume. */
export const pausedLine = (when: string): string => `Automatic restarts resume ${when}.`;
/** The lead after a crash that was not restarted while restarts are not known to be off. The
 * guard (crash_guard/guard.rs `conclude`) leaves such a notice when the relaunch failed, when the
 * user opened PandaCode during the pause before it, when the guard was stopped during that pause
 * (logout) or when restarts were off at the time of the crash: "didn't" stays true for all. */
export const notRestartedLead = (when: string): string => `PandaCode crashed ${when} and didn't restart.`;
export const RESTARTS_OFF_LINE = 'Automatic restarts are off in Settings.';
/** The window's content died and was reloaded (no crash notice). */
export const WINDOW_RELOADED_LINE = "PandaCode's window stopped and was reloaded.";
/** It died again before it proved stable, and was reloaded again. */
export const WINDOW_RELOADED_AGAIN_LINE = "PandaCode's window stopped again and was reloaded.";
/** The last run's window died (twice within 90 s, or once shortly before an exit the page could not
 * see) and this is a new launch, not a reload: usually the native dialog's Restart PandaCode, but
 * also a quit and reopen by hand, so it does not claim a restart. */
export const WINDOW_STOPPED_BEFORE_LINE = 'Last time PandaCode ran, its window failed.';
/** How the window's content died before this page: reloaded once, reloaded again, or a launch after it. */
export type WindowDeath = 'reloaded' | 'again' | 'before';
const WINDOW_LINES: Readonly<Record<WindowDeath, string>> = { reloaded: WINDOW_RELOADED_LINE, again: WINDOW_RELOADED_AGAIN_LINE, before: WINDOW_STOPPED_BEFORE_LINE };
/** The notice's button for the held-back thread. */
export const OPEN_THREAD = 'Open thread';
/** Longest thread title quoted in the notice. */
export const TITLE_LIMIT = 40;
/** Longest notice: a toast is read at a glance. Lower-priority sentences give way to stay under it.
 * The lowest limit that still holds what never gives way at MIN_TITLE: the longest lead (a crash
 * on another day of another year, en-US), the short agents line and a named thread no other
 * thread opened beside (tests/crash-recovery.test.mjs checks every case). */
export const NOTICE_LIMIT = 183;
/** The paused notice's longer limit: the lowest that holds its lead, the short agents line, the
 * kept-closed thread (`keptClosedLine`) at MIN_TITLE and when restarts resume on another day of
 * another year (en-US), none of which give way (tests/crash-recovery.test.mjs checks it). */
export const PAUSED_NOTICE_LIMIT = 183;
/** A paused notice past RESUME_WINDOW keeps the ordinary limit: with no pausedLine to hold, its
 * lead, the short agents line, `keptClosedLine` at MIN_TITLE and RESTARTS_BACK_LINE fit well under it. */
export const RESUMED_NOTICE_LIMIT = NOTICE_LIMIT;
/** A held-back title is never cut shorter than this, so it stays readable. */
export const MIN_TITLE = 30;
/** The held-back sentence's start when boot opened no thread by itself: it says why the pane is
 * empty and names the suspect in one sentence, so it never has to give way. */
export const NO_THREAD_OPENED = 'No thread was opened, in case';

/** A thread title short enough for the toast: one line, at most `limit` characters. */
export function shortTitle(title: string, limit = TITLE_LIMIT): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/** The accessible name of the Open thread button: the label with the whole title. */
export function openThreadName(title: string): string | undefined {
  const name = shortTitle(title, Infinity);
  return name ? `${OPEN_THREAD} “${name}”` : undefined;
}

/** The notice when the window's content died (no crash notice); `title` when a thread was held
 * back ('' when it has none); `nothingOpened` when boot opened no thread for that reason;
 * `notLast` as in heldBackLine. */
export function reloadNotice(title?: string, death: WindowDeath = 'reloaded', nothingOpened = false, notLast = false): string {
  const lead = WINDOW_LINES[death];
  return title !== undefined ? `${lead} ${heldBackLine(title, false, nothingOpened, notLast)}` : nothingOpened ? `${lead} ${NOTHING_OPENED_LINE}` : lead;
}

/** A held-back thread without a title; the Open thread button still identifies it. */
const UNTITLED = 'an untitled thread';

/** Boot kept this thread closed (launch-restore.ts); named when it has a title. `compact` drops
 * "Your last thread" to leave the name room; `noOther`: boot opened no other thread either;
 * `notLast`: boot reopened a New task instead, so the thread was not the user's last place. */
export function heldBackLine(title?: string, compact = false, noOther = false, notLast = false): string {
  const name = title ? shortTitle(title) : '';
  const which = !name ? UNTITLED : compact ? `“${name}”` : notLast ? `the thread “${name}”` : `your last thread, “${name}”,`;
  if (noOther) return `${NO_THREAD_OPENED} ${which} caused this.`;
  return `${which[0].toUpperCase()}${which.slice(1)} was kept closed in case it caused this.`;
}

/** The paused notice's shortest held-back sentence, so when restarts resume always fits beside it;
 * `noOther`: boot opened no thread at all, which it still says (the pane is empty). */
export function keptClosedLine(title?: string, noOther = false): string {
  const name = title ? shortTitle(title) : '';
  return `${name ? `“${name}”` : 'An untitled thread'} was kept closed${noOther ? '; no thread was opened' : ''}.`;
}

export interface NoticeContext {
  /** Some task may have been cut off by this crash (interruptedByCrash). */
  interrupted: boolean;
  /** Boot kept the last open thread closed; the title, or '' when it has none. */
  heldBack?: string;
  /** The Settings switch is off (asked only when the guard did not restart). */
  restartsOff?: boolean;
  /** Boot opened no thread by itself in case one caused this; said when no thread is named. */
  nothingOpened?: boolean;
  /** No task showed as Interrupted when the notice was first written: the agents line points nowhere. */
  agentsHidden?: boolean;
  /** The held-back thread was not the user's last place (boot reopened a New task instead). */
  notLast?: boolean;
}

/** The optional sentences, each '' when it does not apply; `last` is pausedLine, or PAUSED_REPORT_LINE
 * (PAUSED_REPORT_SHORT once trimmed) past RESUME_WINDOW with a report; `back` is RESTARTS_BACK_LINE past
 * RESUME_WINDOW (never trimmed); `hint` is REPORT_LINE (REPORT_SHORT once trimmed) after a crash that was not restarted; `noOther` writes the
 * held-back sentence as NO_THREAD_OPENED (never trimmed); `timed` is the paused lead with the crash
 * time, which replaces the lead while it fits; `named`: a held-back thread with a title; `tail`:
 * `keptClosedLine` says no thread was opened (with `noOther`). `cause`
 * only after a crash that was not restarted (after a restart the report holds it). */
interface Parts { timed: string; cause: string; off: string; agents: string; back: string; last: string; hint: string; noOther: boolean; compact: boolean; kept: boolean; tail: boolean; paused: boolean }

/** What gives way, in order, each only while the notice does not fit with the held-back title cut
 * to `limit`: paused past RESUME_WINDOW, the paused report line (PAUSED_REPORT_LINE, its
 * parenthesis first) before anything else; then the agents line shortens (beside a held-back thread
 * it is short from the start), the report hint's parenthesis, the paused lead's time, the report
 * hint (the Show crash report button still offers the report), the cause, "Your last thread"
 * (wording only) and, paused, the held-back sentence's longer forms (`keptClosedLine`). The title
 * then gives all the way to MIN_TITLE before the restarts-off line or, paused, `keptClosedLine`'s
 * "no thread was opened" goes, last. The lead, the name, that no thread was opened (unless paused, where the lead
 * already says it did not restart), pausedLine and RESTARTS_BACK_LINE never give way. */
const SHORT_FORMS: ReadonlyMap<string, string> = new Map([[REPORT_LINE, REPORT_SHORT], [PAUSED_REPORT_LINE, PAUSED_REPORT_SHORT]]);
const shorten = (line: string): string => SHORT_FORMS.get(line) ?? line;
/** The whole report line of a shortened one, or undefined. */
const lengthen = (line: string): string | undefined => [...SHORT_FORMS].find(([, short]) => short === line)?.[0];
const TRIMS: readonly { limit: number; trim: (parts: Parts) => Parts }[] = [
  // Paused past RESUME_WINDOW (`back` set): the report line gives way before anything else.
  { limit: TITLE_LIMIT, trim: parts => parts.back ? { ...parts, last: shorten(parts.last) } : parts },
  { limit: TITLE_LIMIT, trim: parts => parts.back ? { ...parts, last: '' } : parts },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, agents: parts.agents && parts.agents !== AGENTS_STOPPED_LINE ? INTERRUPTED_SHORT : parts.agents }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, hint: shorten(parts.hint), last: shorten(parts.last) }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, timed: '' }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, hint: '' }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, cause: '' }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, compact: true }) },
  { limit: TITLE_LIMIT, trim: parts => ({ ...parts, kept: parts.paused }) },
  { limit: MIN_TITLE, trim: parts => ({ ...parts, off: '' }) },
  { limit: MIN_TITLE, trim: parts => ({ ...parts, tail: false }) },
];

function compose(lead: string, parts: Parts, heldBack: string | undefined, none: string, notLast: boolean): string {
  const held = heldBack === undefined ? none : parts.kept ? keptClosedLine(heldBack, parts.noOther && parts.tail) : heldBackLine(heldBack, parts.compact, parts.noOther, notLast);
  return [parts.timed || lead, parts.cause, parts.off, parts.agents, held, parts.back, parts.last, parts.hint].filter(Boolean).join(' ');
}

/** The notice for one recovery: what happened, then only the lines that apply, in at most
 * NOTICE_LIMIT characters (PAUSED_NOTICE_LIMIT paused, RESUMED_NOTICE_LIMIT paused past RESUME_WINDOW). A held-back thread is always named (see TRIMS). */
export function crashNotice(recovery: CrashRecovery, now: number, context: NoticeContext): CrashNotice {
  const paused = recovery.restartsPaused;
  // Only when it did not restart: after a restart the report holds the cause.
  const cause = paused || recovery.restarted ? null : plainCause(recovery.summary);
  const when = crashTime(recovery.crashedAt, now);
  const off = !paused && !recovery.restarted && context.restartsOff ? RESTARTS_OFF_LINE : '';
  // Not restarted: the restarts-off line says why, or the lead says it didn't restart.
  const lead = paused ? PAUSED_LEAD : recovery.restarted ? `PandaCode crashed ${when} and restarted.` : off ? `PandaCode crashed ${when}.` : notRestartedLead(when);
  const title = context.heldBack === undefined ? undefined : shortTitle(context.heldBack);
  const resumed = paused && now >= resumesAt(recovery.crashedAt);
  // Once restarts are on again an unnamed "nothing was opened" leaves nothing to act on: it goes.
  const none = context.nothingOpened && !resumed ? NOTHING_OPENED_LINE : '';
  const notLast = Boolean(context.notLast);
  const max = resumed ? RESUMED_NOTICE_LIMIT : paused ? PAUSED_NOTICE_LIMIT : NOTICE_LIMIT;
  const fits = (parts: Parts, limit: number) => compose(lead, parts, title && shortTitle(title, limit), none, notLast).length <= max;
  // Beside a kept-closed thread the short form, which leaves the name room.
  const agents = !context.interrupted ? '' : context.agentsHidden ? AGENTS_STOPPED_LINE : context.heldBack !== undefined ? INTERRUPTED_SHORT : INTERRUPTED_LINE;
  let parts: Parts = {
    timed: paused ? pausedLead(when) : '',
    cause: cause ? `Cause: ${cause}.` : '',
    off,
    agents,
    back: resumed ? RESTARTS_BACK_LINE : '',
    last: !paused ? '' : !resumed ? pausedLine(resumeTime(recovery.crashedAt, now)) : recovery.hasReport ? PAUSED_REPORT_LINE : '',
    hint: !paused && !recovery.restarted && !off && recovery.hasReport ? REPORT_LINE : '',
    noOther: Boolean(context.nothingOpened),
    compact: false,
    kept: false,
    tail: true,
    paused,
  };
  for (const { limit, trim } of TRIMS) if (!fits(parts, limit)) parts = trim(parts);
  // Shortened in vain (the last line went anyway): the whole agents line comes back if it fits.
  const whole = { ...parts, agents };
  if (parts.agents !== whole.agents && fits(whole, TITLE_LIMIT)) parts = whole;
  // Likewise the held-back sentence's longer forms, when what they made room for went anyway.
  if (parts.kept && fits({ ...parts, kept: false }, TITLE_LIMIT)) parts = { ...parts, kept: false };
  if (parts.compact && !parts.kept && fits({ ...parts, compact: false }, TITLE_LIMIT)) parts = { ...parts, compact: false };
  let limit = TITLE_LIMIT;
  while (limit > MIN_TITLE && !fits(parts, limit)) limit--;
  // The report lines' parenthesis, then the hint, come back when the settled notice still fits with them.
  const lastWhole = lengthen(parts.last), hintWhole = lengthen(parts.hint);
  if (lastWhole && fits({ ...parts, last: lastWhole }, limit)) parts = { ...parts, last: lastWhole };
  if (hintWhole && fits({ ...parts, hint: hintWhole }, limit)) parts = { ...parts, hint: hintWhole };
  // The paused lead's time went first; it comes back when the settled notice still fits with it.
  if (paused && !parts.timed && fits({ ...parts, timed: pausedLead(when) }, limit)) parts = { ...parts, timed: pausedLead(when) };
  return { text: compose(lead, parts, title && shortTitle(title, limit), none, notLast), showReport: recovery.hasReport, showSettings: Boolean(off) };
}

/** How far back a task's last activity may be for it to count as possibly cut short by this crash. */
export const INTERRUPTED_WINDOW = DAY;
type TaskLike = { status: string; archived: boolean; updatedAt: number; lastPromptAt?: number | null };

/** Whether any task the restart marked Interrupted was active in the day before the crash. Tasks
 * carry no interruption time, so no count is claimed: only that such agents show as Interrupted.
 * Timestamps may be seconds or milliseconds. */
export function anyInterruptedByCrash(tasks: readonly TaskLike[], crashedAt: number): boolean {
  const ms = (at: number) => at < 1e12 ? at * 1000 : at;
  return tasks.some(task => !task.archived && task.status === 'interrupted'
    && Math.max(ms(task.updatedAt), ms(task.lastPromptAt ?? 0)) >= crashedAt - INTERRUPTED_WINDOW);
}

/** Whether to say agents were interrupted: the guard's answer when it gives one (it keeps the flag
 * with the notice and merges it when a notice is replaced or put back, so its no is reliable, and a
 * task left Interrupted by an earlier quit must not make this crash claim it stopped agents); the
 * task heuristic only for an older guard that says nothing. */
export function interruptedByCrash(recovery: CrashRecovery, tasks: readonly TaskLike[]): boolean {
  return recovery.agentsInterrupted ?? anyInterruptedByCrash(tasks, recovery.crashedAt);
}
