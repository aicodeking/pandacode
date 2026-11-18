import test from 'node:test';
import assert from 'node:assert/strict';
import { skyColorsAt, sunPosition, moonPosition, parseSkyTime, luminance, lightFloor, LIGHT_FLOOR, LIGHT_NIGHT_FLOOR, DARK_CEILING, SUNRISE, SUNSET } from '../src/sky-math.ts';

const hm = (h, m = 0) => h * 60 + m;

test('the sun rises at dawn, peaks at solar noon and sets at dusk', () => {
  assert.ok(Math.abs(sunPosition(SUNRISE).elevation) < 1e-9);
  assert.ok(Math.abs(sunPosition(SUNSET).elevation) < 1e-9);
  const noon = (SUNRISE + SUNSET) / 2;
  assert.ok(Math.abs(sunPosition(noon).elevation - 1) < 1e-9);
  assert.ok(Math.abs(sunPosition(noon).x - .5) < 1e-9);
  assert.ok(sunPosition(hm(9)).y < sunPosition(noon).y && sunPosition(hm(15)).y < sunPosition(noon).y);
  assert.ok(sunPosition(hm(9)).x < sunPosition(hm(15)).x, 'east to west');
  assert.equal(sunPosition(hm(2)).visible, false);
  assert.equal(sunPosition(hm(12)).visible, true);
});

test('the sun and moon ride the open middle of the pane: above the composer, below the first message card', () => {
  for (let m = SUNRISE; m <= SUNSET; m += 5) assert.ok(sunPosition(m).y >= .3 - 1e-9, `sun above the composer at ${m}`);
  for (let m = hm(8); m <= hm(16, 30); m += 5) assert.ok(sunPosition(m).y > .38, `sun in the open middle at ${m}`);
  for (let m = 0; m < 24 * 60; m += 5) {
    assert.ok(sunPosition(m).y <= .44 + 1e-9, `sun below the first card at ${m}`);
    assert.ok(moonPosition(m).y <= .44 + 1e-9, `moon below the first card at ${m}`);
  }
});

test('the light floor keeps dark ink readable on bare sky by day and night', () => {
  assert.equal(lightFloor(0), LIGHT_FLOOR);
  assert.equal(lightFloor(1), LIGHT_NIGHT_FLOOR);
  // The light theme's muted ink (#3a3a36, Y about .043) needs Y >= .37 behind it for 4.5:1; the night stays a little lower.
  const muted = luminance([0x3a / 255, 0x3a / 255, 0x36 / 255]);
  for (const floor of [LIGHT_FLOOR, LIGHT_NIGHT_FLOOR]) assert.ok((floor + .05) / (muted + .05) >= 4.5, `floor ${floor}`);
  assert.ok(LIGHT_NIGHT_FLOOR < LIGHT_FLOOR);
  // Dark: the faint ink (#c0c0c0) over the ceiling, and over the ceiling under a 2% card tint of the text.
  const faint = luminance([0xc0 / 255, 0xc0 / 255, 0xc0 / 255]);
  assert.ok((faint + .05) / (DARK_CEILING * .98 + .76 * .02 + .05) >= 4.5);
});

test('clouds keep a wide gap between lit and shaded sides at dawn, dusk and noon', () => {
  for (const time of [hm(6, 30), hm(12), hm(17, 30), hm(18, 40)]) {
    const { light, shade } = skyColorsAt(time);
    assert.ok(luminance(light) > 2.5 * luminance(shade), `form at ${time}`);
  }
  // Dawn and dusk: warm lit side, cool shaded side.
  for (const time of [hm(6, 30), hm(18, 40)]) {
    const { light, shade } = skyColorsAt(time);
    assert.ok(light[0] > light[2] && shade[2] > shade[0], `warm against cool at ${time}`);
  }
});

test('the moon crosses the night and is down by day', () => {
  assert.equal(moonPosition(hm(13)).visible, false);
  assert.equal(moonPosition(hm(0, 30)).visible, true);
  assert.ok(moonPosition(hm(0, 45)).elevation > .9);
});

test('sky colours: blue day, warm dawn and dusk horizons, dark night', () => {
  const noon = skyColorsAt(hm(12));
  assert.ok(noon.top[2] > noon.top[0] + .3, 'noon zenith is blue');
  assert.equal(noon.night, 0);
  for (const time of [hm(6, 20), hm(18, 30)]) {
    const { horizon } = skyColorsAt(time);
    assert.ok(horizon[0] > horizon[2], `horizon is warm at ${time}`);
  }
  const midnight = skyColorsAt(hm(0));
  assert.equal(midnight.night, 1);
  assert.ok(luminance(midnight.top) < .01 && luminance(noon.top) > .15);
});

test('sky colours change continuously, also across midnight', () => {
  for (let m = 0; m < 24 * 60; m++) {
    const a = skyColorsAt(m), b = skyColorsAt(m + 1);
    for (const key of ['top', 'mid', 'horizon', 'light', 'shade']) {
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[key][i] - b[key][i]) < .02, `${key} jumps at minute ${m}`);
    }
  }
  assert.deepEqual(skyColorsAt(24 * 60), skyColorsAt(0));
  assert.deepEqual(skyColorsAt(-60), skyColorsAt(23 * 60));
});

test('?sky= parses HH:MM only', () => {
  assert.equal(parseSkyTime('06:30'), 390);
  assert.equal(parseSkyTime('23:59'), 1439);
  for (const bad of [null, '', '24:00', '6:60', 'noon', '06:30x']) assert.equal(parseSkyTime(bad), null);
});
