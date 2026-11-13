// Host calls for the `terminal` feature group (src-tauri/src/remote/methods/terminal.rs): the
// computer's terminals, polled for output (no new event kinds). Every method needs Full (a
// shell's output can carry anything the computer holds), and opening or typing into one also
// needs the computer's "Full access for remote tasks" setting. See docs/remote-access.md.
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import type { FileTarget } from './files.ts';

export const TERMINAL_METHODS = registerMethods(['terminal.list', 'terminal.open', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.close'] as const);

export type TerminalKind = 'shell' | 'script' | 'harness';

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  sessionId?: string;
  kind: TerminalKind;
  running: boolean;
  exitCode?: number;
}

/** Output after an offset: `next` is the offset to ask for next, `dropped` what the host no longer holds. */
export interface TerminalChunk {
  data: string;
  next: number;
  dropped: number;
  exited: boolean;
  exitCode?: number;
}

const target = (t: FileTarget) => (t.sessionId ? { sessionId: t.sessionId } : { projectId: t.projectId });

/** Newest first. */
export const listTerminals = (deviceId: string) =>
  hostCall<{ terminals?: TerminalInfo[] }>(deviceId, 'terminal.list', {}).then(r => r.terminals ?? []);

/** A login shell in the task's checkout (or the project's), sized for the phone. */
export const openTerminal = (deviceId: string, t: FileTarget, cols: number, rows: number) =>
  hostCall<{ terminalId: string }>(deviceId, 'terminal.open', { ...target(t), cols, rows }).then(r => r.terminalId);

/** Polls take turns with other background calls so they never hold up what the user asked for. */
export const readTerminal = (deviceId: string, terminalId: string, after: number) =>
  hostCall<TerminalChunk>(deviceId, 'terminal.read', { terminalId, after }, { background: true });

export const writeTerminal = (deviceId: string, terminalId: string, data: string) =>
  hostCall<Record<string, never>>(deviceId, 'terminal.write', { terminalId, data });

export const resizeTerminal = (deviceId: string, terminalId: string, cols: number, rows: number) =>
  hostCall<Record<string, never>>(deviceId, 'terminal.resize', { terminalId, cols, rows }, { background: true });

export const closeTerminal = (deviceId: string, terminalId: string) =>
  hostCall<Record<string, never>>(deviceId, 'terminal.close', { terminalId });
