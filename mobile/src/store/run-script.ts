// Run & servers (app/servers.tsx): reading runScript.get and deciding which terminal runs the script.

/** runScript.get: the script, the terminal running it, and whether the host said anything about that. */
export interface ScriptState<S = unknown> {
  script: S | null;
  running: string | null;
  /** The reply carried a `running` key (null = nothing runs); older hosts send none. */
  reportsRunning: boolean;
}

/** Reads `running` defensively: older hosts send none, and the reply type may not name it yet. */
export function scriptState<S>(reply: unknown): ScriptState<S> {
  const r = (reply && typeof reply === 'object' ? reply : {}) as { script?: S | null; running?: { terminalId?: unknown } | null };
  const id = r.running?.terminalId;
  return { script: r.script ?? null, running: typeof id === 'string' && id ? id : null, reportsRunning: 'running' in r };
}

/**
 * The running script's terminal: a host that reports `running` is the only word (it survives leaving
 * the screen, and null means the script ended there); an older host's silence falls back to the
 * terminal this screen's last Start opened.
 */
export function runningTerminal(state: Pick<ScriptState, 'running' | 'reportsRunning'> | undefined, opened: string | null): string | null {
  return state?.reportsRunning ? state.running : opened;
}
