import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceVoiceWaveform, createVoiceWaveform, smoothVoiceAmplitude, voiceAmplitude, voiceWaveBars } from '../src/voice-waveform.ts';

test('attack and release are independent of frame rate; attack is faster', () => {
  for (const target of [0, 1]) {
    let split = 1 - target;
    for (let i = 0; i < 12; i++) split = smoothVoiceAmplitude(split, target, 100 / 12);
    assert.ok(Math.abs(split - smoothVoiceAmplitude(1 - target, target, 100)) < 1e-12);
  }
  assert.ok(smoothVoiceAmplitude(0, 1, 100) > 1 - smoothVoiceAmplitude(1, 0, 100));
  assert.deepEqual([-1, 0, .25, 1, 2, NaN, Infinity].map(voiceAmplitude), [0, 0, .5, 1, 1, 0, 0]);
});

test('history and scroll advance between input events, at the same speed across refresh rates', () => {
  let a = createVoiceWaveform(), b = createVoiceWaveform();
  a = advanceVoiceWaveform(a, .25, 400);
  for (let i = 0; i < 40; i++) b = advanceVoiceWaveform(b, .25, 10);
  assert.equal(a.samples.length, 5);
  a.samples.forEach((sample, i) => assert.ok(Math.abs(sample - b.samples[i]) < 1e-12));
  const before = voiceWaveBars(a, 300, 60, 2);
  a = advanceVoiceWaveform(a, .25, 20);
  const after = voiceWaveBars(a, 300, 60, 2);
  assert.equal(before[0].x - after[0].x, 1.5);
  assert.ok(after[0].height > before[0].height, 'live amplitude grows between history samples');
  for (const bar of after) {
    assert.ok(Math.abs(bar.y + bar.height / 2 - 30) < 1e-12);
    assert.ok(bar.height >= 1 && bar.height <= 60);
  }
});

test('silence remains a thin baseline and history stays bounded after a long capture', () => {
  let state = createVoiceWaveform();
  assert.ok(voiceWaveBars(state, 300, 30).every(bar => bar.height === 1));
  for (let i = 0; i < 2000; i++) state = advanceVoiceWaveform(state, 1, 1000);
  assert.equal(state.samples.length, 1024);
  assert.equal(voiceWaveBars(state, 300, 0)[0].height, 0);
});


test('bars respect text padding and snap horizontal positions to physical pixels', () => {
  const state = advanceVoiceWaveform(createVoiceWaveform(), .64, 115);
  const padding = { left: 16, right: 8, top: 12, bottom: 6 };
  for (const ratio of [1, 1.5, 2, 3]) for (const bar of voiceWaveBars(state, 300, 60, ratio, padding)) {
    assert.ok(bar.x >= padding.left && bar.x + bar.width <= 300 - padding.right);
    assert.ok(Math.abs(bar.x * ratio - Math.round(bar.x * ratio)) < 1e-10);
    assert.ok(bar.y >= padding.top && bar.y + bar.height <= 60 - padding.bottom);
    assert.equal(bar.y + bar.height / 2, 33);
  }
});


test('static reduced-motion samples return fresh bounded state without mutating prior history', async () => {
  const { staticVoiceWaveform, HISTORY_SIZE } = await import('../src/voice-waveform.ts');
  const previous = Object.freeze({ amplitude: .1, remainderMs: 40, samples: Object.freeze(Array(HISTORY_SIZE).fill(.1)) });
  const next = staticVoiceWaveform(previous, .25);
  assert.equal(next.amplitude, .5); assert.equal(next.remainderMs, 0);
  assert.equal(next.samples.length, HISTORY_SIZE); assert.equal(next.samples.at(-1), .5);
  assert.equal(previous.samples.at(-1), .1); assert.equal(previous.remainderMs, 40);
  assert.notEqual(next.samples, previous.samples);
});


test('display-rate advancement returns fresh state and never mutates a frozen prior frame', () => {
  const state = Object.freeze({ amplitude: .1, remainderMs: 40, samples: Object.freeze([.1]) });
  const next = advanceVoiceWaveform(state, .8, 160);
  assert.notEqual(next, state); assert.notEqual(next.samples, state.samples);
  assert.equal(next.samples.length, 3); assert.equal(state.remainderMs, 40);
  assert.deepEqual(state.samples, [.1]);
});


test('frames between sample boundaries share immutable history and append only when due', () => {
  const first = advanceVoiceWaveform(createVoiceWaveform(), .25, 80);
  Object.freeze(first.samples); Object.freeze(first);
  const between = advanceVoiceWaveform(first, .8, 16);
  assert.notEqual(between, first); assert.equal(between.samples, first.samples);
  const appended = advanceVoiceWaveform(between, .8, 64);
  assert.notEqual(appended.samples, first.samples); assert.equal(appended.samples.length, first.samples.length + 1);
  assert.equal(first.samples.length, 1);
});
