/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { ASCENDER, BASELINE, CAP, HALF_WIDTH, X_HEIGHT, OPTICAL_INSET, PANDA_SIZE, PERCH_OFFSET_D, REST_GAP, SINK, TRICK_JUMP } from '../src/ui/brand/geometry.ts';
import {
  APEX, arc, C_TOP, canTrick, climb, D_STEM, earSpring, GREET_AT, GROUND, HOPS, keyframes, landOf, launchOf, letter, LIT, moving, nextWake, PERCH_LETTER,
  passTimes, perchGlow, pose, restBlink, SETTLE, SHOW_END, tick, travel, TRICK_LAND, TRICK_S, trick,
} from '../src/ui/brand/panda-motion.ts';

const EPS = 1e-3;
const FRAME = 1 / 60;
const AFTER = SHOW_END + 60;

// Rough advance widths of SF Rounded Heavy 20 pt, enough to place the letters and the perches.
const WORD = 'PandaCode';
const WIDTHS = [12.4, 11.2, 11.6, 12, 11.2, 13.2, 11.6, 12, 11];
const lefts = WIDTHS.map((_, i) => WIDTHS.slice(0, i).reduce((a, b) => a + b, 0));
const centre = (i: number) => lefts[i] + WIDTHS[i] / 2;
const HOME = lefts[8] + WIDTHS[8] + REST_GAP + HALF_WIDTH;
const PX = [HOME, centre(7) + PERCH_OFFSET_D, centre(5)];
const PH = [0, ASCENDER - SINK, CAP - SINK];
const at = (t: number) => pose(t, PX, PH);
/** Screen x of a word coordinate: the bar's 20 pt inset plus the brand's optical inset. */
const screenX = (x: number) => 20 + OPTICAL_INSET + x;

test('keyframes ease between points and hold the ends', () => {
  const pts = [[0, 0], [1, 10]] as const;
  assert.equal(keyframes(pts, -1), 0);
  assert.equal(keyframes(pts, 0.5), 5);
  assert.equal(keyframes(pts, 2), 10);
});

test('the show: a rest beside the e first, a short trip over the word and home, under 10 s', () => {
  const start = at(0);
  assert.deepEqual([start.x, start.feet, start.lift, start.perch], [HOME, 0, 0, GROUND]);
  assert.ok(HOPS[0].crouch >= 1, 'a moment of rest first');
  assert.ok(SHOW_END <= 10, `the show lasts ${SHOW_END.toFixed(1)} s`);
  assert.deepEqual(HOPS.map(h => [h.from, h.to]), [[GROUND, D_STEM], [D_STEM, C_TOP], [C_TOP, D_STEM], [D_STEM, GROUND]]);
  for (const hop of HOPS) assert.ok(hop.air >= 0.3 && hop.air <= 0.45, 'short hops');
  assert.ok(HOPS[1].air < HOPS[0].air && HOPS[3].air > HOPS[0].air, 'a varied rhythm: a quick hop to the C, a bigger homecoming');
  const home = at(AFTER);
  assert.deepEqual([home.x, home.feet, home.perch], [HOME, 0, GROUND], 'home again');
  assert.equal(at(GREET_AT + 0.6).x, HOME, 'the greet does not move it');
});

test('the resting panda leaves the whole word readable and the 16 pt edge clean', () => {
  assert.ok(HOME - HALF_WIDTH >= lefts[8] + WIDTHS[8] + REST_GAP - EPS, 'clear of the e');
  assert.equal(screenX(0), 16, 'the word starts on the buttons\' 16 pt edge');
  for (let t = 0; t < SHOW_END; t += 0.01) assert.ok(at(t).x - HALF_WIDTH - 4 > 0, 'the trip stays over the word');
});

test('every hop is high for its length: at least 0.3 of its distance above the higher perch', () => {
  for (const hop of HOPS) {
    let top = 0;
    for (let t = launchOf(hop); t < landOf(hop); t += 0.002) top = Math.max(top, at(t).feet);
    const rise = top - Math.max(PH[hop.from], PH[hop.to]);
    const distance = Math.abs(PX[hop.to] - PX[hop.from]);
    assert.ok(rise / distance >= 0.3, `${hop.from}→${hop.to}: ${rise.toFixed(1)} over ${distance.toFixed(1)}`);
  }
  assert.equal(arc(APEX, APEX), 1);
  assert.ok(climb(0.01, APEX) > 0.95 && climb(0.99, APEX) < -0.95);
  assert.ok(1 - travel(0.9) < 0.08, 'the last tenth of the hop covers under 8% of its distance: it slows into the contact');
});

test('anticipation, pitch, tuck, arms and a weighted landing', () => {
  const first = HOPS[0];
  assert.ok(at(first.crouch + 0.05).sy > 1.03, 'a quick stretch up before the crouch');
  const crouched = at(launchOf(first) - 0.001);
  assert.ok(Math.abs(crouched.sy - 0.84) < 0.01 && crouched.earsL < -1.4, 'crouched, ears perked');
  // The first hop goes left: leading with the head is a counter-clockwise (negative) rotation.
  assert.ok(at(launchOf(first) + 0.06).pitch < -7, 'the head leads the travel rising');
  assert.ok(at(landOf(first) - 0.12).pitch > 6, 'rocks back to land feet first');
  assert.ok(Math.abs(at(landOf(first) - 0.001).pitch) < 0.2, 'level at contact');
  const apex = at(launchOf(first) + first.air * 0.45);
  assert.ok(apex.tuck > 2.9 && apex.arms > 0.99, 'tucked, arms up at the apex');
  assert.equal(at(first.crouch - 0.1).arms, 0, 'arms down at rest');
  assert.ok(at(landOf(first) + 0.06).brace > 0.9, 'arms brace on contact');
  const last = HOPS[HOPS.length - 1];
  assert.ok(Math.abs(at(landOf(last) + 0.07).sy - 0.87) < 0.005, 'a light landing squash at home');
  let up = 0;
  for (let v = 0.12; v < 0.3; v += 0.002) up = Math.max(up, at(landOf(last) + v).sy);
  assert.ok(up > 1.05 && up < 1.09, `rebound ${up}`);
  assert.equal(at(landOf(last) + SETTLE).sy, 1, 'settled');
  assert.equal(at(landOf(last)).groundLean, 0, 'no lean at contact: the feet do not slide');
  assert.ok(Math.abs(at(landOf(last) + 0.11).bob - 2) < 0.05, 'dips 2 pt on landing');
});

test('ears: ~3 pt of lag, one ~25% overshoot', () => {
  let peak = 0;
  let back = 0;
  for (let s = 0; s < 0.5; s += 0.002) {
    peak = Math.max(peak, earSpring(s));
    back = Math.min(back, earSpring(s));
  }
  assert.ok(peak > 2.8 && peak < 3.5, `peak ${peak}`);
  assert.ok(-back / peak > 0.2 && -back / peak < 0.3, `overshoot ${back / peak}`);
});

test('nothing pops: per-frame changes stay small through the trip and the trick', () => {
  const check = (sample: (t: number) => number, from: number, to: number, what: string, limit: number) => {
    for (let t = from; t < to; t += FRAME / 4) {
      const step = Math.abs(sample(t + FRAME) - sample(t));
      assert.ok(step < limit, `${what} jumps ${step.toFixed(3)} at ${t.toFixed(3)}`);
    }
  };
  const span = [HOPS[0].crouch - 0.1, SHOW_END] as const;
  check(t => at(t).sy, ...span, 'sy', 0.1);
  check(t => at(t).feet, ...span, 'feet', 3.5);
  check(t => at(t).x, ...span, 'x', 3.5);
  check(t => at(t).pitch, ...span, 'pitch', 3.5);
  check(t => at(t).groundLean, ...span, 'lean', 1);
  check(t => at(t).earsL, ...span, 'ears', 1.75);
  check(t => at(t).arms, ...span, 'arms', 0.3);
  check(t => at(t).bob, ...span, 'bob', 0.8);
  check(t => at(t).breath, SHOW_END - 0.1, SHOW_END + 8, 'breath', 0.05);
  check(s => trick(s).sy, -0.05, TRICK_S + 0.05, 'trick sy', 0.1);
  check(s => trick(s).earsL, -0.05, TRICK_S + 0.05, 'trick ears', 1.75);
});

/** The panda's outline (ear tops and outer sides, head sides) in word coordinates, through the views as drawn. */
function outline(x: number, feetY: number, sy: number, turn: number, lean: number, earsL: number, earsR: number, out: number): number[][] {
  const S = PANDA_SIZE;
  const C = S / 2;
  const sx = 1 / Math.sqrt(sy);
  const rotate = ([px, py]: number[], cy: number, degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    return [C + (px - C) * Math.cos(a) - (py - cy) * Math.sin(a), cy + (px - C) * Math.sin(a) + (py - cy) * Math.cos(a)];
  };
  const points = [[4.9 - out, 0.4 + earsL], [1.4 - out, 3.9 + earsL], [S - 4.9 + out, 0.4 + earsR], [S - 1.4 + out, 3.9 + earsR], [0.5, 9.75], [S - 0.5, 9.75]];
  return points.map(([px, py]) => {
    const squashed = [C + (px - C) * sx, S - (S - py) * sy];
    const [qx, qy] = rotate(rotate(squashed, C, turn), S, lean);
    return [x - C + qx, feetY - S + qy];
  });
}

const BAR_TOP = 62;
/** Measured on iPhone 17 Pro: the status bar clock ends 39.0 pt from the top, at x 57.7-89.7 pt; the island's bottom ~48 pt from x 139 pt. */
const CLOCK = { bottom: 39, left: 57.7, right: 89.7 };
const ISLAND = { bottom: 48, left: 139 };

test('the trip and the trick keep 6 pt under the clock and clear of the island; apexes beside the clock', () => {
  const check = (x: number, feet: number, sy: number, turn: number, lean: number, l: number, r: number, out: number, what: string) => {
    for (const [px, py] of outline(x, BAR_TOP + BASELINE - feet, sy, turn, lean, l, r, out)) {
      const sx = screenX(px);
      if (sx >= CLOCK.left - 1 && sx <= CLOCK.right + 1) assert.ok(py >= CLOCK.bottom + 6, `${what}: ${(py - CLOCK.bottom).toFixed(2)} pt under the clock`);
      if (sx >= ISLAND.left) assert.ok(py >= ISLAND.bottom + 6, `${what}: ${(py - ISLAND.bottom).toFixed(2)} pt under the island`);
      assert.ok(py >= 40, `${what}: stays out of the status bar`);
    }
  };
  for (let t = HOPS[0].crouch; t < SHOW_END; t += 0.004) {
    const p = at(t);
    check(p.x, p.feet, p.sy, p.pitch + p.tilt, p.groundLean, p.earsL, p.earsR, p.earsOut, `trip at ${t.toFixed(3)}`);
  }
  for (const hop of HOPS) {
    const apex = at(launchOf(hop) + hop.air * hop.apex);
    const x = screenX(apex.x);
    assert.ok(x < CLOCK.left - 4 || x > CLOCK.right + 4, `apex at ${x.toFixed(1)} pt, beside the clock`);
  }
  for (let s = 0; s < TRICK_S; s += 0.004) {
    const k = trick(s);
    check(HOME, k.lift * TRICK_JUMP, k.sy, k.spin, 0, k.earsL, k.earsR, k.earsOut, `trick at ${s.toFixed(3)}`);
  }
});

test('landings centre on the d\'s stem and keep their feet clear of the e', () => {
  // The d's stem is at the glyph's right side, ~1 pt in from its advance, ~3.5 pt wide.
  const stem = lefts[7] + WIDTHS[7] - 1 - 1.75;
  assert.ok(Math.abs(PX[D_STEM] - stem) < 0.6, 'centred on the stem');
  assert.ok(PH[D_STEM] >= X_HEIGHT + 2, 'its feet stand well above the e beside it');
});

const PASSES = passTimes(WORD.split('').map((_, i) => centre(i)), PX);

test('letters fill fast, hold a beat, drain fast, and only a few are lit at once', () => {
  const o = PASSES[6];
  assert.ok(o.length >= 1, 'the o is passed over');
  const s = (dt: number) => letter(o[0] + dt, o);
  assert.equal(s(-0.01).glow, 0);
  assert.ok(s(0.07).dip > 0, 'presses down first');
  assert.ok(s(0.25).dip < 0, 'then rebounds');
  assert.equal(s(0.1).glow, 1, 'holds the colour');
  assert.equal(s(LIT + 0.001).glow, 0, 'back to ink');
  assert.ok(PASSES[PERCH_LETTER[D_STEM]].length >= 2, 'the d is pressed when landed on');
  let lit = 0;
  for (let t = 0; t < SHOW_END; t += 0.01) lit = Math.max(lit, PASSES.filter(p => letter(t, p).glow > 0.5).length);
  assert.ok(lit <= 4, `${lit} letters lit at once`);
});

test('the perch accent: the pink e at rest, the d and the C while the panda is on them', () => {
  assert.equal(perchGlow(0, GROUND), 1, 'the e is lit at first sight');
  assert.equal(perchGlow(AFTER, GROUND), 1, 'and at rest after the show');
  assert.equal(perchGlow(GREET_AT + 0.5, GROUND), 1, 'and through the greet');
  assert.equal(perchGlow(landOf(HOPS[1]) + 0.8, C_TOP), 1, 'the C while the panda looks around on it');
  assert.equal(perchGlow(landOf(HOPS[1]) + 0.8, GROUND), 0);
  for (const hop of HOPS) {
    const passes = PASSES[PERCH_LETTER[hop.from]];
    const fill = (x: number) => Math.max(perchGlow(x, hop.from), letter(x, passes).glow);
    // Once the take-off letter starts to empty after the launch, it empties without filling again.
    let falling = false;
    for (let t = launchOf(hop); t < launchOf(hop) + 0.6; t += 0.01) {
      const step = fill(t + 0.01) - fill(t);
      if (step < -0.01) falling = true;
      if (falling) assert.ok(step < 0.02, `the take-off letter refills at ${t.toFixed(2)}`);
    }
  }
});

test('outside the moving windows nothing changes, so the clock may skip them', () => {
  let stillFrom: number | undefined;
  for (let t = 0; t <= SHOW_END + 30; t += 0.01) {
    if (moving(t)) { stillFrom = undefined; continue; }
    stillFrom ??= t;
    const a = at(stillFrom);
    const b = at(t);
    for (const key of ['x', 'feet', 'lift', 'sy', 'groundLean', 'pitch', 'look', 'tilt', 'earsL', 'earsR', 'earsOut', 'blink', 'tuck', 'bob', 'nod', 'breath', 'arms', 'brace'] as const) {
      assert.ok(Math.abs(a[key] - b[key]) < 0.01, `${key} drifts at ${t.toFixed(2)}`);
    }
    for (const perch of [GROUND, D_STEM, C_TOP]) assert.ok(Math.abs(perchGlow(stillFrom, perch) - perchGlow(t, perch)) < EPS, `perch ${perch} at ${t.toFixed(2)}`);
    for (const p of PASSES) assert.ok(Math.abs(letter(stillFrom, p).glow - letter(t, p).glow) < EPS && Math.abs(letter(stillFrom, p).dip - letter(t, p).dip) < 0.01);
  }
});

test('the clock sleeps when nothing moves and wakes exactly when something next does', () => {
  for (const start of [0, GREET_AT]) {
    let clock = start;
    let shown = start;
    let sleeps = 0;
    while (clock < start + 40) {
      let still: boolean;
      [clock, shown, still] = tick(clock, shown, FRAME);
      if (!still) continue;
      sleeps++;
      const wake = nextWake(clock);
      assert.ok(wake > clock && moving(wake), 'wakes inside the next moving window');
      for (let t = clock; t < wake - 0.002; t += 0.02) assert.ok(!moving(t), `nothing moves while asleep (${t.toFixed(2)})`);
      clock = wake;
      shown = wake;
    }
    assert.ok(sleeps > 5, `sleeps ${sleeps} times`);
  }
  for (let k = 1; k < 30; k++) {
    const gap = restBlink(k) - restBlink(k - 1);
    assert.ok(gap >= 4 && gap <= 6, 'resting blinks every 4-6 s');
  }
});

test('a tap trick only happens at rest, never into or through the trip', () => {
  assert.ok(canTrick(AFTER) && canTrick(GREET_AT) && !canTrick(HOPS[0].crouch));
  for (let t = 0; t < SHOW_END + 5; t += 0.01) {
    if (!canTrick(t)) continue;
    for (let s = 0; s <= TRICK_S; s += 0.02) {
      const p = at(t + s);
      assert.ok(p.lift === 0 && p.x === HOME, `trick at ${t.toFixed(2)} overlaps the trip`);
    }
  }
});

test('the tap trick is a tucked back somersault that starts and ends at home', () => {
  for (const s of [0, TRICK_S]) {
    const k = trick(s);
    assert.deepEqual([k.lift, k.spin, k.sy, k.tuck], [0, 0, 1, 0]);
  }
  const top = trick(0.15 + 0.5 * 0.45);
  assert.ok(top.lift > 0.99 && top.tuck > 2.9 && top.arms > 0.99, 'tucked, arms up at the top');
  assert.equal(trick(TRICK_LAND - 0.01).spin, -360);
  assert.ok(Math.abs(trick(0.15 + 0.5 * 0.1).spin) < EPS, 'the turn starts after the take-off');
});
