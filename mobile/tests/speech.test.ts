import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTranscript, appendFinal, deviceLanguage, startOptions } from '../src/ui/speech-text.ts';

test('startOptions prefers on-device recognition when asked', () => {
  const onDevice = startOptions('en-US', true);
  assert.equal(onDevice.requiresOnDeviceRecognition, true);
  assert.equal(onDevice.interimResults, true);
  assert.equal(onDevice.addsPunctuation, true);
  assert.equal(onDevice.iosTaskHint, 'dictation');
  assert.equal(onDevice.androidIntentOptions.EXTRA_LANGUAGE_MODEL, 'language_model_free_form');
  assert.equal(onDevice.androidIntentOptions.EXTRA_PARTIAL_RESULTS, true);
  // Allowing the network service leaves the on-device requirement off.
  assert.equal(startOptions('en-US', false).requiresOnDeviceRecognition, false);
});

test('applyTranscript composes base, settled finals and the live partial', () => {
  assert.equal(applyTranscript('', '', ''), '');
  assert.equal(applyTranscript('Fix the', '', ''), 'Fix the');
  assert.equal(applyTranscript('Fix the', '', 'login bug'), 'Fix the login bug');
  // A new partial replaces the previous one — only finals accumulate.
  assert.equal(applyTranscript('Fix the', '', 'login page'), 'Fix the login page');
  // A settled final and a live partial compose with one space.
  assert.equal(applyTranscript('Fix the', 'login bug', 'now'), 'Fix the login bug now');
  // Typed text without trailing space gets one before the dictation.
  assert.equal(applyTranscript('Also', 'run tests', ''), 'Also run tests');
  // An empty partial keeps the settled text.
  assert.equal(applyTranscript('', 'run tests', ''), 'run tests');
});

test('appendFinal accumulates the segmented finals Android produces', () => {
  let settled = '';
  settled = appendFinal(settled, 'first segment');
  settled = appendFinal(settled, 'second segment');
  assert.equal(settled, 'first segment second segment');
  assert.equal(appendFinal(settled, ''), settled);
  // Existing spacing is preserved, not doubled.
  assert.equal(appendFinal('ends with space ', 'next'), 'ends with space next');
});

test('deviceLanguage falls back to en-US', () => {
  // No native modules in the test runner.
  assert.equal(deviceLanguage(), 'en-US');
});
