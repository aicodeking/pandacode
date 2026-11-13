/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { lastActiveLabel } from '../src/ui/ds/when.ts';
import { STAGGER_CAP, springParams, staggerDelay } from '../src/ui/ds/motion-math.ts';
import { alpha, contrast, edgeGradient, mix, paletteFor, VIEWER, type Scheme } from '../src/ui/ds/palette.ts';

const AA = 4.5;

test('last active names today and yesterday, then gives the date', () => {
  const now = new Date(2026, 10, 5, 13, 40).getTime();
  assert.match(lastActiveLabel(new Date(2026, 10, 5, 0, 5).getTime(), now), /^Today at /);
  assert.match(lastActiveLabel(new Date(2026, 10, 4, 23, 59).getTime(), now), /^Yesterday at /);
  const older = lastActiveLabel(new Date(2026, 10, 3, 9, 0).getTime(), now);
  assert.ok(!/Today|Yesterday/.test(older) && /2026/.test(older), older);
  // Across a daylight-saving change the calendar day still counts.
  assert.match(lastActiveLabel(new Date(2026, 2, 28, 12).getTime(), new Date(2026, 2, 29, 12).getTime()), /^Yesterday at /);
});

test('the scroll edge is solid to its stop, then eases to nothing without a step', () => {
  const stops = [...edgeGradient('to bottom', '#151515', 1, 0.5).matchAll(/rgba\(21, 21, 21, ([\d.]+)\) ([\d.]+)%/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(stops[0], [1, 50]);
  assert.deepEqual(stops.at(-1), [0, 100]);
  stops.slice(1).forEach(([opacity], i) => assert.ok(opacity < stops[i][0]));
});

test('a switch shows its state, in every scheme and contrast', () => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    for (const increase of [false, true]) {
      const colors = paletteFor(scheme, increase);
      assert.ok(contrast(colors.toggleKnob, colors.toggleOn) >= AA, `${scheme} knob on the ON track`);
      assert.ok(contrast(colors.toggleOn, colors.toggleOff) >= 3, `${scheme} ON against OFF`);
      assert.ok(contrast(colors.toggleOn, colors.cardInner) >= 3, `${scheme} ON track on a card`);
      if (scheme === 'dark') assert.ok(contrast(colors.toggleKnobOff, colors.toggleOff) >= 3, 'dark knob on the OFF track');
    }
  }
});

test('stagger steps up to the cap, then rows just appear', () => {
  assert.equal(staggerDelay(0), 0);
  assert.ok((staggerDelay(STAGGER_CAP - 1) ?? 0) > (staggerDelay(1) ?? 0));
  assert.equal(staggerDelay(STAGGER_CAP), null);
  assert.equal(staggerDelay(500), null);
  assert.equal(staggerDelay(-1), 0);
});

test('a spring from response and ratio is critically damped at ratio 1', () => {
  const { mass, stiffness, damping } = springParams(0.3);
  assert.ok(Math.abs(damping - 2 * Math.sqrt(stiffness * mass)) < 1e-9);
  assert.ok(springParams(0.3, 0.8).damping < damping);
});

test('colour helpers match the measured desktop values', () => {
  assert.equal(mix('#e2e2e2', 0.02, '#151515'), '#191919');
  assert.equal(mix('#e2e2e2', 0.6, '#ffffff'), '#eeeeee');
  assert.equal(alpha('#ff0080', 0.5), 'rgba(255, 0, 128, 0.5)');
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
});

for (const scheme of ['light', 'dark'] as Scheme[]) {
  for (const increase of [false, true]) {
    const name = `${scheme}${increase ? ' with Increase Contrast' : ''}`;
    const colors = paletteFor(scheme, increase);

    test(`${name}: text and status clear AA on every solid surface`, () => {
      const tones = ['success', 'danger', 'info', 'running', 'warning', 'plan', 'edit', 'full', 'team', 'saver', 'remote', 'worktree'] as const;
      const failures = [...tones, 'text', 'muted', 'faint'].flatMap(label => {
        const ink = colors[label as 'text'];
        return [colors.page, colors.card, colors.cardInner].filter(surface => contrast(ink, surface) < AA).map(surface => `${label} ${ink} on ${surface}: ${contrast(ink, surface).toFixed(2)}`);
      });
      assert.deepEqual(failures, []);
      assert.ok(contrast(colors.text, colors.raised) >= AA && contrast(colors.muted, colors.raised) >= AA, 'labels on raised controls');
      assert.ok(contrast(colors.onPrimary, colors.primary) >= AA);
    });

    test(`${name}: legacy names follow the new tokens, and surfaces are solid`, () => {
      assert.equal(colors.secondary, colors.muted);
      assert.equal(colors.tertiary, colors.faint);
      assert.equal(colors.separator, colors.border);
      assert.equal(colors.red, colors.danger);
      assert.equal(colors.green, colors.success);
      assert.equal(colors.background, colors.page);
      assert.ok(colors.card.startsWith('#'));
    });
  }
}

test('Increase Contrast drops shadows and turns hairlines solid', () => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const colors = paletteFor(scheme, true);
    assert.equal(colors.shadowCard, undefined);
    assert.ok(colors.border.startsWith('#'));
  }
});

test('image viewers: white text reads on the black page and on the dimmed chrome over a white image', () => {
  assert.ok(contrast(VIEWER.text, VIEWER.page) >= AA);
  // The chrome is translucent: over the brightest image it is the chrome mixed onto white.
  assert.ok(contrast(VIEWER.text, mix(VIEWER.page, 0.55, '#ffffff')) >= 3);
  assert.match(VIEWER.chrome, /^rgba\(0, 0, 0, 0\.55\)$/);
});
