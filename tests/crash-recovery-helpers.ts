import { expect, type Page } from '@playwright/test';

// Crash recovery: the notice on the launch after a crash, the Settings switch, and what a launch
// brings back (safely). The preview stands in for the native guard (src/preview-crash.ts).
export type Recovery = { crashedAt: number; summary: string | null; hasReport: boolean; restarted: boolean; restartsPaused: boolean; agentsInterrupted?: boolean };
export type CrashWindow = Window & { __crashCalls?: Array<{ command: string; args: Record<string, unknown> }>; __crashRestartEnabled?: boolean; __previewEmit?: (name: string, event: unknown) => void };

export const crashed = (page: Page, recovery: Omit<Recovery, 'crashedAt'> & { agoMs?: number }) => page.addInitScript(({ agoMs = 4000, ...rest }) => {
  (window as Window & { __crashRecovery?: Recovery }).__crashRecovery = { crashedAt: Date.now() - agoMs, ...rest };
}, recovery);
export const failing = (page: Page, commands: Record<string, number>) => page.addInitScript(value => {
  (window as Window & { __crashFailCommands?: Record<string, number> }).__crashFailCommands = value;
}, commands);
/** Local storage as the previous launch left it (first load only, so a reload keeps what the app wrote). */
export const leftOver = (page: Page, items: Record<string, string>) => page.addInitScript(values => {
  if (sessionStorage.getItem('left-over')) return;
  sessionStorage.setItem('left-over', '1');
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
}, items);
/** The notice's crash time, as the app writes it (a clock time, so it never goes stale). */
export const when = (page: Page) => page.evaluate(async () => {
  const url = '/src/crash-recovery-model.ts';
  const model = await import(/* @vite-ignore */ url);
  return model.crashTime((window as Window & { __crashRecovery?: Recovery }).__crashRecovery!.crashedAt, Date.now());
});
export const calls = (page: Page, command: string) => page.evaluate(name => ((window as CrashWindow).__crashCalls ?? []).filter(call => call.command === name), command);
export const stored = (page: Page, key: string) => page.evaluate(name => localStorage.getItem(name), key);
// The first load of a cold dev server can take longer than the default wait.
export const ready = (page: Page) => expect(page.locator('.task-item.selected')).toHaveCount(1, { timeout: 15_000 });
export const selected = (page: Page) => page.locator('.task-item.selected');
export const openGeneral = async (page: Page) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'General', exact: true }).click();
};
export const SWITCH = 'Restart automatically after a crash';
export const DETAIL = "If PandaCode crashes, it restarts itself, pausing after repeated crashes. It won't restart if you force it to quit or the system ends it.";
/** The Settings button: it reveals one report (this launch's, else the newest). */
export const SHOW_LATEST = 'Show latest crash report';
export const REPORTS_DETAIL = 'Written when PandaCode crashes and kept on this computer. A report can contain file paths, text from your work or credentials, so check it before attaching it to a GitHub issue.';
export const INTERRUPTED = 'Running agents were stopped; their threads show as Interrupted.';
export const INTERRUPTED_SHORT = 'Stopped agents show as Interrupted.';
/** The agents sentence when no task shows as Interrupted: nothing to open. */
export const AGENTS_STOPPED = 'Running agents were stopped.';
/** Said by every paused notice once restarts have resumed, report or not. */
export const RESTARTS_BACK = 'Automatic restarts are on again.';
/** Starts these preview tasks Interrupted (src/preview.ts). */
export const interruptedTasks = (page: Page, ids: string[]) => page.addInitScript(value => { (window as Window & { __previewInterrupted?: string[] }).__previewInterrupted = value; }, ids);
export const RELOADED = "PandaCode's window stopped and was reloaded.";
export const DRAFTS = 'The text of unsent messages (not attachments or very long drafts) is saved locally as plain text, so a crash rarely loses it. A pasted secret is kept too, until the message is sent, cleared, or 30 days old.';
export const CLEAR_DRAFTS = 'Clear saved drafts';
export const KEEP_DRAFTS = 'Keep unsent drafts';
export const DRAFTS_OFF = 'Unsent messages are not saved; a crash or quit loses them.';
export const PAUSED = "PandaCode kept crashing and didn't restart.";
/** The paused lead with the last crash's time, which the notice uses while it has room. */
export const pausedLead = (time: string) => `PandaCode kept crashing, last ${time}, and didn't restart.`;
/** The lead after a crash that was not restarted while restarts are on. */
export const notRestarted = (time: string) => `PandaCode crashed ${time} and didn't restart.`;
export const NOTHING = 'No thread was opened, in case one caused this.';
export const RELOADED_AGAIN = "PandaCode's window stopped again and was reloaded.";
export const STOPPED_BEFORE = 'Last time PandaCode ran, its window failed.';
/** The paused closing line: by when restarts resume, as the app writes it (`resumeTime`, "by <time>": the crash plus ten minutes). */
export const resume = (page: Page) => page.evaluate(async () => {
  const url = '/src/crash-recovery-model.ts';
  const model = await import(/* @vite-ignore */ url);
  return `Automatic restarts resume ${model.resumeTime((window as Window & { __crashRecovery?: Recovery }).__crashRecovery!.crashedAt, Date.now())}.`;
});
/** The page reloads as after its window's content died: no pagehide ran, so local storage is as
 * the page left it (the reload's pagehide is undone: the alive mark, a window-died note, a
 * restoring mark). `items` are set and `gone` removed as that dead page would have left them. */
export const deadWindow = async (page: Page, items: Record<string, string> = {}, gone: string[] = []) => {
  await page.addInitScript(({ items, gone }) => {
    const left = sessionStorage.getItem('dead-window');
    if (!left) return;
    sessionStorage.removeItem('dead-window');
    for (const [key, value] of Object.entries(JSON.parse(left) as Record<string, string>)) localStorage.setItem(key, value);
    localStorage.setItem('pandacode.pageAlive', '1');
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
    for (const key of gone) localStorage.removeItem(key);
  }, { items, gone });
  await page.evaluate(() => sessionStorage.setItem('dead-window', JSON.stringify({ ...localStorage })));
  await page.reload();
};
/** The paused notice's report line (it already kept crashing). */
export const PAUSED_REPORT_STEP = 'If it crashes again, open a GitHub issue with the crash report (check it for private details first).';
/** The paused report line's start, which survives losing its parenthesis. */
export const PAUSED_REPORT_STEP_START = 'If it crashes again, open a GitHub issue with the crash report';
/** The notice's way to Settings when restarts are off: its label and accessible name. */
export const CRASH_SETTINGS = 'Crash settings';
export const CRASH_SETTINGS_NAME = 'Crash settings, in Settings › General › Crash recovery';
/** A paused launch opens no thread: wait for the notice instead of a selected thread. */
export const noticeReady = (page: Page) => expect(page.locator('#toast')).toBeVisible({ timeout: 15_000 });
export const held = (title: string) => `Your last thread, “${title}”, was kept closed in case it caused this.`;
/** The held-back sentence when boot opened no thread by itself. */
export const heldNoOther = (title: string) => `No thread was opened, in case your last thread, “${title}”, caused this.`;
/** The held-back sentence when boot reopened a New task instead, so the thread was not the last one. */
export const heldNotLast = (title: string) => `The thread “${title}” was kept closed in case it caused this.`;
/** The held-back thread's button: "Open thread" on screen, with the title in its accessible name. */
export const OPEN_NAVIGATION = 'Open thread “Refine the navigation”';
