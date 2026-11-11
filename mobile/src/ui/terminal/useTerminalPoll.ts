// Polls one terminal's output (terminal.read) into a screen (store/terminal.ts): every 250 ms
// while output arrives or the user types, every second when quiet, never while the screen is
// hidden or the app in the background, and not at all once the terminal has ended and been read.
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { readTerminal } from '../../connect/api/terminal.ts';
import { emptyScreen, feed, nextPollDelay, resizeScreen, type Screen } from '../../store/terminal.ts';

/** How soon after a keystroke the output is read. */
const ECHO_MS = 60;
const CLOSED = 'Terminal is closed.';
const SKIPPED = '\r\n\x1b[2m[earlier output was dropped]\x1b[0m\r\n';

export interface TerminalPoll {
  screen: Screen;
  /** The terminal ended (with `exitCode` when known) or was closed. */
  ended: boolean;
  exitCode?: number;
  /** The last read failed; polling backs off and keeps trying. */
  error: string;
  /** Marks the terminal active and reads soon, after the user typed. */
  nudge: () => void;
  /** Wraps what arrives next at the new size. */
  resize: (cols: number, rows: number) => void;
}

function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

export function useTerminalPoll(device: string, terminalId: string, cols: number, rows: number): TerminalPoll {
  const focused = useIsFocused();
  const visible = useAppActive() && focused && !!terminalId;
  const [screen, setScreen] = useState(() => emptyScreen(cols, rows));
  const [ended, setEnded] = useState(false);
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [error, setError] = useState('');
  const offset = useRef(0);
  const screenRef = useRef(screen);
  const lastActivity = useRef(0);
  const kick = useRef<() => void>(() => undefined);
  const size = useRef({ cols, rows });
  useEffect(() => { size.current = { cols, rows }; }, [cols, rows]);

  // A new terminal starts from its first byte the host still holds.
  useEffect(() => {
    offset.current = 0;
    const fresh = emptyScreen(size.current.cols, size.current.rows);
    screenRef.current = fresh;
    setScreen(fresh);
    setEnded(false);
    setExitCode(undefined);
    setError('');
  }, [device, terminalId]);

  useEffect(() => {
    if (!visible || ended) return;
    // Opening (or returning to) a terminal counts as activity: read briskly at first.
    lastActivity.current = Date.now();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      timer = undefined;
      let lastRead = 0;
      let done = false;
      try {
        const chunk = await readTerminal(device, terminalId, offset.current);
        if (!live) return;
        let next = screenRef.current;
        if (chunk.dropped > 0 && offset.current > 0) next = feed(next, SKIPPED);
        if (chunk.data) next = feed(next, chunk.data);
        offset.current = chunk.next;
        lastRead = chunk.data.length;
        if (lastRead) lastActivity.current = Date.now();
        if (next !== screenRef.current) {
          screenRef.current = next;
          setScreen(next);
        }
        failures = 0;
        setError('');
        if (chunk.exited) {
          done = true;
          setExitCode(chunk.exitCode);
          setEnded(true);
        }
      } catch (e) {
        if (!live) return;
        const message = (e as Error).message;
        if (message === CLOSED) {
          done = true;
          setEnded(true);
        } else {
          failures += 1;
          setError(message);
        }
      }
      if (!live) return;
      const delay = nextPollDelay({ visible: true, exited: done, now: Date.now(), lastActivity: lastActivity.current, failures, lastRead });
      if (delay !== null) timer = setTimeout(() => void tick(), delay);
    };
    kick.current = () => {
      // While a read is in flight the next one is scheduled when it lands.
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), ECHO_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      kick.current = () => undefined;
    };
  }, [device, terminalId, visible, ended]);

  const nudge = useCallback(() => {
    lastActivity.current = Date.now();
    kick.current();
  }, []);
  const resize = useCallback((c: number, r: number) => {
    const next = resizeScreen(screenRef.current, c, r);
    screenRef.current = next;
    setScreen(next);
  }, []);
  return { screen, ended, exitCode, error, nudge, resize };
}
