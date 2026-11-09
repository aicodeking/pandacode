// The brand's clock. `clock` is the show's time; `time`, which the views read, only follows it while
// something moves. When nothing moves, the frame callback stops and a JS timer wakes it at the next
// moment that does (panda-motion.ts knows them all), so the display can idle through the rests. The
// full show plays on first sight, when the app comes back after a minute or more in the background,
// and after half an hour; a quick app switch or a return to the tab only gets the greet (a glance and
// a blink). That state lives at module scope, so remounting the brand doesn't replay the show.
// After the cold-launch intro (src/ui/splash), which plays the first show and its glance itself, it starts past the greet.
// Reduce Motion holds the opening rest.
// `hold` keeps it awake for a while (the tap trick): on device, the brand's view updates only reach
// the screen while the frame callback runs, so an animation of its own would play unseen at rest.
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFrameCallback, useSharedValue, type FrameCallback, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { GREET_AT, GREET_END, nextWake, SHOW_END, tick } from './panda-motion.ts';

const MAX_FRAME_S = 0.05;
/** After this long since the last full show, even a tab return plays it again. */
const SHOW_AGAIN_MS = 30 * 60 * 1000;
/** Away in the background at least this long, and the foreground return plays the full show. */
const AWAY_MS = 60 * 1000;

// Once per app: whether the next start is a full show, and when the last one began.
const replay = { due: true, last: 0, backgroundAt: 0, quiet: false };
AppState.addEventListener('change', state => {
  if (state === 'background') replay.backgroundAt = Date.now();
  else if (state === 'active' && replay.backgroundAt && Date.now() - replay.backgroundAt >= AWAY_MS) replay.due = true;
});

/**
 * The launch intro played the panda's first show, its glance and its blink: the header brand starts
 * past the greet then (a second glance on arrival read as a repeat), and greets as usual afterwards.
 */
export function consumeShow() {
  replay.due = false;
  replay.last = Date.now();
  replay.quiet = true;
}

export interface ShowClock {
  time: SharedValue<number>;
  /** The show's real time, on the UI thread: it runs on while the clock sleeps. */
  now: () => number;
  /** On the UI thread: stay awake (and keep the views refreshing) for `seconds`. */
  hold: (seconds: number) => void;
  /** On the UI thread: whether the clock is asleep (a hold wakes it within a frame or two, via JS). */
  asleep: () => boolean;
}

export function useShowClock(running: boolean, reduced: boolean): ShowClock {
  const clock = useSharedValue(0);
  const time = useSharedValue(0);
  const sleeping = useSharedValue(false);
  const sleptAt = useSharedValue(0);
  const holdUntil = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);


  // The ticker and its sleep refer to each other: the sleep reaches the ticker through a ref.
  const tickerRef = useRef<FrameCallback | undefined>(undefined);
  const sleep = useCallback((at: number) => {
    tickerRef.current?.setActive(false);
    clearTimeout(timer.current);
    const wake = nextWake(at);
    timer.current = setTimeout(() => {
      clock.set(wake);
      time.set(wake);
      sleeping.set(false);
      if (runningRef.current) tickerRef.current?.setActive(true);
    }, Math.max(0, (wake - at) * 1000));
  }, [clock, time, sleeping]);
  // Woken early (a hold): from the show's real time, which ran on while asleep.
  const wakeNow = useCallback((at: number) => {
    clearTimeout(timer.current);
    clock.set(at);
    time.set(at);
    sleeping.set(false);
    if (runningRef.current) tickerRef.current?.setActive(true);
  }, [clock, time, sleeping]);

  const ticker = useFrameCallback(frame => {
    const dt = Math.min((frame.timeSincePreviousFrame ?? 0) / 1000, MAX_FRAME_S);
    const [next, shown, still] = tick(clock.get(), time.get(), dt);
    const held = next < holdUntil.get();
    clock.set(next);
    // While held the views follow the clock every frame; nothing moves in a still span, so it shows the same.
    const view = held ? next : shown;
    if (view !== time.get()) time.set(view);
    if (still && !held && !sleeping.get()) {
      sleeping.set(true);
      sleptAt.set(Date.now());
      scheduleOnRN(sleep, next);
    }
  }, false);
  useEffect(() => { tickerRef.current = ticker; }, [ticker]);

  useEffect(() => {
    clearTimeout(timer.current);
    sleeping.set(false);
    if (reduced) {
      // The opening rest, held.
      clock.set(0);
      time.set(0);
    } else if (running) {
      const due = replay.due || Date.now() - replay.last >= SHOW_AGAIN_MS;
      // An unfinished show in this mount carries on; a fresh mount (or a finished show) only greets.
      const greet = replay.quiet ? GREET_END : GREET_AT;
      const start = due ? 0 : started.current && clock.get() < SHOW_END ? clock.get() : greet;
      started.current = true;
      replay.quiet = false;
      if (due) {
        replay.due = false;
        replay.last = Date.now();
      }
      clock.set(start);
      time.set(start);
    }
    ticker.setActive(running);
    return () => clearTimeout(timer.current);
  }, [running, reduced, ticker, clock, time, sleeping]);

  const now = () => {
    'worklet';
    return sleeping.get() ? clock.get() + (Date.now() - sleptAt.get()) / 1000 : clock.get();
  };
  const hold = (seconds: number) => {
    'worklet';
    const at = now();
    holdUntil.set(at + seconds);
    if (sleeping.get()) scheduleOnRN(wakeNow, at);
  };
  const asleep = () => {
    'worklet';
    return sleeping.get();
  };
  return { time, now, hold, asleep };
}
