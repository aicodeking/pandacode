// The intro's decisions as pure functions (tested in tests/splash.test.ts): whether the beat plays at
// all, and how it leaves. Numbers, not strings: the UI thread reads the mode every frame.
import { DIRECT_MS, FADE_MS, HANDOFF_MS } from './timeline.ts';

/** The mark flies into the header brand. */
export const FLY = 0;
/** No header brand to fly to (signed out, the iPhone Duo's sidebar layout, not found): it grows a touch and fades. */
export const FADE = 1;
/** Reduce Motion: a cross-fade. */
export const REDUCE = 2;
/** No beat (a tap before it started): the still panda fades straight to the app. */
export const DIRECT = 3;

/**
 * Once the screen under the intro is up, wait at most this long for both threads to go quiet before
 * moving (the panda idles, alive, meanwhile).
 */
export const PLAY_CAP_MS = 2000;
/**
 * The safety net, from mount: past it the beat stops waiting for the header brand (it plays, and fades
 * instead of flying if the brand is still not measured). It never drops the beat: however slow the app
 * is to get ready (a Debug build takes seconds), the panda idles until then and the beat follows.
 */
export const SAFETY_MS = 8000;

/** Whether the beat (or, without one, the exit) may start: the app is ready and, to fly, the header brand is up or the safety net has passed. */
export function gateOpen(exit: number | null, brandUp: boolean, overdue: boolean): boolean {
  return exit !== null && (exit !== FLY || brandUp || overdue);
}

export interface ExitInput {
  reduced: boolean;
  beat: boolean;
  signedIn: boolean;
  /** The layout has no header brand (the iPhone Duo's sidebar is the inbox). */
  split: boolean;
}

/** How the intro leaves, before knowing whether the header brand was found. */
export function exitMode({ reduced, beat, signedIn, split }: ExitInput): number {
  if (reduced) return REDUCE;
  if (!beat) return DIRECT;
  return signedIn && !split ? FLY : FADE;
}

/** Whether to wait for the header brand at all. */
export const needsBrand = (mode: number) => mode === FLY;

export function exitMs(mode: number): number {
  'worklet';
  return mode === REDUCE ? FADE_MS : mode === DIRECT ? DIRECT_MS : HANDOFF_MS;
}

/**
 * The JS thread counts as busy (a React commit may be holding Reanimated's UI updates back) once its
 * heartbeat is this many ms old; the beat and the hand-off wait for it, but never longer than
 * JS_WAIT_MAX_MS at a stretch, so a stuck JS thread can't hold the intro up.
 */
const JS_STALE_MS = 120;
const JS_WAIT_MAX_MS = 2000;
export function clockRuns(sinceJsMs: number): boolean {
  'worklet';
  return sinceJsMs < JS_STALE_MS || sinceJsMs > JS_WAIT_MAX_MS;
}

/**
 * A JS stall is the app mounting a tree (the Inbox); right after it the simulator's display stops
 * updating for a while (~1.3 s after a Debug build's 2 s mount; a ~140 ms Release stall lost ~0.2 s of
 * the crouch) while both threads stay on time, so nothing else shows it, and a beat started then was
 * never seen. So the beat's first frame waits HOLD_PER_STALL times the last stall over STALL_MS (at most
 * HOLD_MAX_MS) past its end; once started it never waits on this.
 */
const STALL_MS = 100;
const HOLD_PER_STALL = 2.5;
const HOLD_MAX_MS = 1800;
/** How long the beat's start waits after a JS stall of `stallMs` (0: not a stall). */
export function holdAfter(stallMs: number): number {
  'worklet';
  return stallMs > STALL_MS ? Math.min(stallMs * HOLD_PER_STALL, HOLD_MAX_MS) : 0;
}
/** Whether the beat may start `msSinceStall` after the last stall, which asked for `holdMs`. */
export function mayStart(msSinceStall: number, holdMs: number): boolean {
  'worklet';
  return msSinceStall >= holdMs;
}

/** Frames in a row a thread must deliver on time before the beat (useSettled.ts). */
const QUIET_FRAMES = 6;
const ON_TIME_MS = 24;

/** The streak of on-time frames after a frame `gap` ms after the last (null: the first). */
export function nextStreak(streak: number, gap: number | null): number {
  'worklet';
  return gap !== null && gap < ON_TIME_MS ? streak + 1 : 0;
}
export function quietEnough(streak: number): boolean {
  'worklet';
  return streak >= QUIET_FRAMES;
}
