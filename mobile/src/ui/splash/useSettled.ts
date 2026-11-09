// When the intro may move. While React commits (launch work: the store filling, the app mounting),
// Reanimated holds back its UI-thread updates, and while the UI thread mounts the native views nothing
// draws at all, so motion played then is unseen. The beat waits for its gate, then for both threads
// to deliver a run of frames on time, at most `capMs` after the gate opened.
import { useEffect, useState } from 'react';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { nextStreak, quietEnough } from './plan.ts';

export function useSettled(gate: boolean, capMs: number): boolean {
  const [settled, setSettled] = useState(false);
  const [jsQuiet, setJsQuiet] = useState(false);
  const [uiQuiet, setUiQuiet] = useState(false);
  const uiStreak = useSharedValue(0);
  const watching = gate && !settled;

  // The UI thread: frame gaps as it draws.
  const ui = useFrameCallback(frame => {
    const streak = nextStreak(uiStreak.get(), frame.timeSincePreviousFrame);
    uiStreak.set(streak);
    if (quietEnough(streak)) scheduleOnRN(setUiQuiet, true);
  }, false);
  useEffect(() => {
    uiStreak.set(0);
    ui.setActive(watching && !uiQuiet);
    return () => ui.setActive(false);
  }, [ui, uiStreak, watching, uiQuiet]);

  // The JS thread: how promptly it answers frames.
  useEffect(() => {
    if (!watching || jsQuiet) return undefined;
    let frame = 0;
    let last: number | null = null;
    let streak = 0;
    const step = (at: number) => {
      streak = nextStreak(streak, last === null ? null : at - last);
      last = at;
      if (quietEnough(streak)) setJsQuiet(true);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [watching, jsQuiet]);

  useEffect(() => {
    if (!watching) return undefined;
    const timer = setTimeout(() => setSettled(true), capMs);
    return () => clearTimeout(timer);
  }, [watching, capMs]);

  return gate && (settled || (jsQuiet && uiQuiet));
}
