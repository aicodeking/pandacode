/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { launchFeet, markLayout, markRest } from '../src/ui/splash/mark-layout.ts';
import { clockRuns, DIRECT, exitMode, exitMs, FADE, FLY, gateOpen, holdAfter, mayStart, needsBrand, nextStreak, quietEnough, REDUCE } from '../src/ui/splash/plan.ts';
import {
  backdrop, BEAT_END, DIRECT_MS, flight, glide, HANDOFF_MS, idle, introPose, LAND, LAUNCH, launchLetter, letterOpacity, letterRise, letterTimes, letterTone,
  START_SCALE, WORD_SCALE,
} from '../src/ui/splash/timeline.ts';

const EPS = 1e-6;
const K = WORD_SCALE;
// SF Rounded Heavy advances at the intro's size, roughly.
const WIDTHS = [12.4, 11.2, 11.6, 12, 11.2, 13.2, 11.6, 12, 11].map(x => x * K);
const SPANS = WIDTHS.map((width, i) => ({ left: WIDTHS.slice(0, i).reduce((a, b) => a + b, 0), width }));
const WINDOW = { width: 402, height: 874 };
const LAYOUT = markLayout(SPANS);
const REST = markRest(WINDOW, LAYOUT);
const FROM = launchFeet(WINDOW, REST);
const TO = { x: LAYOUT.home, y: FROM.y };

test('the beat and hand-off together fit in 1.35 s', () => {
  const total = BEAT_END + HANDOFF_MS / 1000;
  assert.ok(total <= 1.35 && BEAT_END >= 0.85 && BEAT_END <= 1, `${total.toFixed(2)} s, beat ${BEAT_END.toFixed(2)} s`);
});

test('the first frame is the launch screen: the panda centred in the window at its start scale, still', () => {
  const p = introPose(0, 0, FROM, TO);
  assert.deepEqual([p.x, p.y, p.scale, p.sy, p.blink, p.lift, p.pitch, p.groundLean], [FROM.x, FROM.y, START_SCALE, 1, 0, 0, 0, 0]);
  // Its box centre, in window coordinates.
  assert.ok(Math.abs(REST.x + p.x - WINDOW.width / 2) < EPS);
  assert.ok(Math.abs(REST.y + p.y - 22 * START_SCALE / 2 - WINDOW.height / 2) < EPS);
  for (let i = 0; i < SPANS.length; i++) assert.equal(letterOpacity(0, letterTimes(LAYOUT.centres, FROM.x, TO.x)[i]), 0, 'no letters yet');
});

test('while it waits the panda is alive (from its first drawn frame): a blink, a breath you can see, one ear flick', () => {
  assert.ok(idle(0.35).blink > 0.9, 'blinks at ~0.35 s');
  assert.equal(idle(0.2).blink, 0);
  assert.ok(idle(0.75).breath > 0.99, 'a full breath in by ~0.75 s');
  const deepest = introPose(0, 0.75, FROM, TO).sy;
  assert.ok(deepest >= 1.075, `breath ${(deepest - 1).toFixed(3)}`);
  let flick = 0;
  for (let w = 0; w < 1.2; w += 1 / 60) flick = Math.max(flick, Math.abs(introPose(0, w, FROM, TO).earsR));
  assert.ok(flick > 2 && Math.abs(introPose(0, 0.3, FROM, TO).earsR) < 1e-9, `ear flick ${flick.toFixed(1)}`);
  // The breath eases out as the beat starts, so it never pops.
  assert.ok(Math.abs(introPose(0.2, 1.6, FROM, TO).sy - introPose(0.2, 0, FROM, TO).sy) < EPS);
});

test('the mark fits the window, the panda taking off over the third letter on the baseline', () => {
  assert.ok(REST.x >= 10 && REST.x + LAYOUT.width <= WINDOW.width - 10 + EPS);
  assert.equal(launchLetter(LAYOUT.centres, FROM.x), 2);
  assert.ok(Math.abs(FROM.y - TO.y) < EPS, 'the leap starts and ends on the baseline');
});

test('the letters rise left to right: up for the push-off behind it, as the panda passes ahead, the e nearly up at the landing', () => {
  const starts = letterTimes(LAYOUT.centres, FROM.x, TO.x);
  for (const s of starts) assert.ok(s > 0 && s < LAND);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], 'left to right, never against the leap');
  assert.ok(letterRise(LAUNCH, starts[2]) >= 0.9, 'the n is up when the panda pushes off it');
  const e = letterRise(LAND, starts[starts.length - 1]);
  assert.ok(e >= 0.8 && e < 1, `the e is ${(e * 100).toFixed(0)}% up at the landing`);
  // Each letter ahead rises as the panda is over it (within a frame or two).
  for (let i = 3; i < starts.length; i++) {
    const x = introPose(starts[i] + 0.03, 0, FROM, TO).x;
    assert.ok(Math.abs(x - LAYOUT.centres[i]) < 24, `letter ${i}: panda at ${x.toFixed(0)}, letter at ${LAYOUT.centres[i].toFixed(0)}`);
  }
});

test('the colour follows the panda: several letters carry it at once, the e keeps it from the landing', () => {
  const starts = letterTimes(LAYOUT.centres, FROM.x, TO.x);
  const at = (t: number) => starts.filter((s, i) => i < starts.length - 1 && letterTone(t, s, false) > 0.5).length;
  let most = 0;
  for (let t = LAUNCH; t < LAND; t += 0.01) most = Math.max(most, at(t));
  assert.ok(most >= 3, `${most} letters coloured at once`);
  const e = starts[starts.length - 1];
  assert.equal(letterTone(BEAT_END, e, true), 1);
  for (let i = 0; i < starts.length - 1; i++) assert.equal(letterTone(BEAT_END, starts[i], false), 0, 'the others are back to ink');
  // The e is still settling as the mark leaves (its last ~0.1 s, a point or so, rides the flight).
  for (const s of starts) assert.equal(letterRise(BEAT_END + 0.12, s), 1, 'settled early in the hand-off');
});

test('the panda leaps once, its feet above the letters, landing at its home at the word scale', () => {
  let top = Infinity;
  for (let t = LAUNCH; t < LAND; t += 0.005) top = Math.min(top, introPose(t, 0, FROM, TO).y);
  assert.ok(top < FROM.y - 40, 'a real arc');
  const end = introPose(BEAT_END, 0, FROM, TO);
  assert.deepEqual([end.x, end.y, end.scale], [TO.x, TO.y, WORD_SCALE]);
  assert.ok(Math.abs(end.look) < EPS, 'facing out');
  assert.equal(introPose(LAND, 0, FROM, TO).scale, WORD_SCALE, 'at its final size when it lands');
  const after = introPose(LAND + 0.3, 0, FROM, TO);
  assert.ok(Math.abs(after.sy - 1) < 0.01 && Math.abs(after.groundLean) < EPS, 'the settle done early in the hand-off');
  // A small look, so the cheeks stay in the face.
  for (let t = 0; t < BEAT_END; t += 0.01) assert.ok(Math.abs(introPose(t, 0, FROM, TO).look) <= 0.4);
});

test('the pose is continuous: no jump between 60 fps frames', () => {
  let prev = introPose(0, 0, FROM, TO);
  for (let t = 1 / 60; t < BEAT_END + 0.5; t += 1 / 60) {
    const p = introPose(t, 0, FROM, TO);
    assert.ok(Math.abs(p.x - prev.x) < 24 && Math.abs(p.y - prev.y) < 24, `position at ${t.toFixed(3)}`);
    assert.ok(Math.abs(p.sy - prev.sy) < 0.1, `squash at ${t.toFixed(3)}`);
    prev = p;
  }
});

test('the flight ends exactly on the header brand, at its size, and is near that size before the end', () => {
  const target = { x: 12, y: 58 };
  assert.deepEqual(flight(0, REST, target), { x: REST.x, y: REST.y, scale: 1 });
  const end = flight(1, REST, target);
  assert.deepEqual([end.x, end.y], [target.x, target.y]);
  assert.ok(Math.abs(end.scale - 1 / K) < EPS);
  for (let h = 0; h <= 1; h += 0.05) {
    const f = flight(h, REST, target);
    const e = (REST.x - f.x) / (REST.x - target.x);
    assert.ok(Math.abs(f.scale - K ** -e) < 1e-6, 'the shrink rides the travel');
  }
  let last = -1;
  for (let h = 0; h <= 1; h += 0.01) {
    const e = glide(h);
    assert.ok(e >= last - EPS && e <= 1 + EPS, 'monotonic');
    last = e;
  }
});

test('the glide starts gently, is home within 0.5 pt of a 420 pt trip by 85%, no creep; vertical ahead of horizontal', () => {
  assert.ok(glide(0.03) < 0.03, 'starts gently');
  assert.ok((1 - glide(0.85)) * 420 < 0.5, `${((1 - glide(0.85)) * 420).toFixed(2)} pt left at 85%`);
  assert.equal(glide(0.9), 1);
  const target = { x: 12, y: 58 };
  const mid = flight(0.1, REST, target);
  assert.ok((REST.y - mid.y) / (REST.y - target.y) > (REST.x - mid.x) / (REST.x - target.x) + 0.08, 'the path curves');
});

test('the hand-off follows the landing closely, the blink running into it', () => {
  assert.ok(BEAT_END - LAND >= 0.18 && BEAT_END - LAND <= 0.22);
  const end = introPose(BEAT_END, 0, FROM, TO);
  assert.ok(Math.abs(end.look) < EPS, 'looking out');
  assert.ok(end.blink > 0.9, 'mid-blink as it leaves');
});

test('the backdrop clears early, the bar there while the mark flies to it', () => {
  assert.equal(backdrop(0.15), 1);
  assert.ok(backdrop(0.35) > 0.3 && backdrop(0.35) < 0.8);
  assert.equal(backdrop(0.6), 0);
});

test('plan: the clocks wait on a busy JS thread, never for long; the beat waits out a long stall', () => {
  assert.ok(clockRuns(0) && clockRuns(100));
  assert.ok(!clockRuns(200), 'a React commit may be holding updates back');
  assert.ok(clockRuns(2500), 'a stuck JS thread never holds the intro up');
  assert.equal(holdAfter(50), 0, 'a dropped frame is not a mount');
  assert.equal(holdAfter(140), 350, 'a Release mount: a short hold');
  assert.equal(holdAfter(2500), 1800, 'capped');
  assert.ok(!mayStart(1000, holdAfter(2000)), 'the display is still drawing the new views');
  assert.ok(mayStart(1800, holdAfter(2000)) && mayStart(0, 0), 'no stall: start at once');
});

test('plan: only a tap before the beat drops it, however slow the start; Reduce Motion cross-fades', () => {
  assert.ok(!gateOpen(null, true, true), 'never before the app is ready, even past the safety net');
  assert.ok(!gateOpen(FLY, false, false), 'a flight waits for the header brand');
  assert.ok(gateOpen(FLY, true, false));
  assert.ok(gateOpen(FLY, false, true), 'past the safety net it plays without the brand');
  assert.ok(gateOpen(FADE, false, false) && gateOpen(REDUCE, false, false));
  assert.equal(exitMode({ reduced: true, beat: false, signedIn: true, split: false }), REDUCE);
  assert.equal(exitMode({ reduced: false, beat: false, signedIn: true, split: false }), DIRECT);
  assert.equal(exitMode({ reduced: false, beat: true, signedIn: true, split: false }), FLY);
  assert.equal(exitMode({ reduced: false, beat: true, signedIn: false, split: false }), FADE, 'signed out');
  assert.equal(exitMode({ reduced: false, beat: true, signedIn: true, split: true }), FADE, 'no header brand: decided up front');
  assert.ok(needsBrand(FLY) && !needsBrand(FADE) && !needsBrand(DIRECT) && !needsBrand(REDUCE));
  assert.equal(exitMs(DIRECT), DIRECT_MS);
  assert.equal(exitMs(FLY), HANDOFF_MS);
});

test('quiet: a streak of on-time frames, reset by a late one', () => {
  let streak = nextStreak(0, null);
  for (let i = 0; i < 6; i++) streak = nextStreak(streak, 16);
  assert.ok(quietEnough(streak));
  assert.equal(nextStreak(streak, 120), 0);
  assert.ok(!quietEnough(5));
});
