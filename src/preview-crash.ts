/* Browser preview of the native crash guard (`crash_*` commands); there is no native side here.
 * By default this launch is not a crash restart. Specs steer it:
 *   window.__crashRecovery = {...}       → this exact `crash_recovery_take` answer (set before load),
 *                                          repeated on every call and load until `crash_recovery_shown`
 *                                          (kept in sessionStorage, so it outlives a reload)
 *   window.__crashFailCommands[command]  → that command fails the given number of times
 *   window.__crashCalls                  → every crash command and its arguments
 *   window.__crashRestartEnabled         → the stored switch (default true)
 *   window.__crashNoReport               → crash_report_reveal refuses as the native side does with no report
 *   window.__crashGates[command]         → a promise the answer waits for (crash_restart_enabled and
 *                                          crash_recovery_take read their value first)
 * It also answers `sessions_missing` (launch-restore.ts `dropDeletedDrafts`): the ids the preview has no session for. */
type Recovery = { crashedAt: number; summary: string | null; hasReport: boolean; restarted: boolean; restartsPaused: boolean; agentsInterrupted?: boolean };
type CrashWindow = Window & {
  __crashRecovery?: Recovery | null;
  __crashFailCommands?: Record<string, number>;
  __crashCalls?: Array<{ command: string; args: Record<string, unknown> }>;
  __crashRestartEnabled?: boolean;
  __crashNoReport?: boolean;
  __crashGates?: Record<string, Promise<unknown>>;
};

/** sessionStorage key: the page has shown the crash notice (`crash_recovery_shown`). */
const SHOWN = 'pandacode.preview.crashShown';

export async function previewCrash<T>(command: string, args: Record<string, unknown>, sessionIds: readonly string[] = []): Promise<T> {
  const w = window as CrashWindow;
  (w.__crashCalls ??= []).push({ command, args });
  const failures = w.__crashFailCommands?.[command] ?? 0;
  if (failures > 0) {
    w.__crashFailCommands![command] = failures - 1;
    throw new Error(`${command} failed in the preview`);
  }
  switch (command) {
    case 'crash_recovery_take': {
      const recovery = sessionStorage.getItem(SHOWN) ? null : w.__crashRecovery ?? null;
      await w.__crashGates?.[command];
      return recovery as T;
    }
    case 'crash_recovery_shown': sessionStorage.setItem(SHOWN, '1'); return undefined as T;
    case 'crash_restart_enabled': {
      const enabled = w.__crashRestartEnabled ?? true;
      await w.__crashGates?.[command];
      return enabled as T;
    }
    case 'set_crash_restart_enabled': w.__crashRestartEnabled = args.enabled === true; return undefined as T;
    case 'crash_report_reveal':
      if (w.__crashNoReport) throw new Error('There is no crash report on this computer.');
      return undefined as T;
    case 'sessions_missing': {
      // As the native command checks: at most 2000 ids, each a string of at most 128 characters.
      const ids = args.ids;
      if (!Array.isArray(ids) || ids.length > 2000 || ids.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('Invalid session ids.');
      return ids.filter(id => !sessionIds.includes(id)) as T;
    }
    default: throw new Error(`Unknown preview command: ${command}`);
  }
}
