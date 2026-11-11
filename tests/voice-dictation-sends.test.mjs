import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, settle, controller, flakyConfigurationController } from './voice-dictation-harness.mjs';

test('configuration disable or captured profile deletion cancels; selecting another profile keeps snapshot', async () => {
  const { voiceConfigurationCancels } = await import('../src/voice-dictation.ts');
  const configuration = { selectedProfileId: 'other', profiles: [{ id: 'captured' }, { id: 'other' }] };
  assert.equal(voiceConfigurationCancels('captured', configuration), false);
  assert.equal(voiceConfigurationCancels('captured', { ...configuration, selectedProfileId: null }), true);
  assert.equal(voiceConfigurationCancels('captured', { ...configuration, profiles: [{ id: 'other' }] }), true);
});

test('automatic capture failure offers truthful first-send copy then original-recording Retry after upload failure', async () => {
  for (const message of ['Recording limit reached.', 'Microphone input stopped.']) {
    const h = await controller(); await h.start();
    h.event({ phase: 'error', message });
    const actions = h.pill.children.at(-1), details = h.pill.children[1].children;
    assert.equal(actions.children[0].attributes['aria-label'], 'Transcribe recording');
    assert.doesNotMatch(details[1].textContent, /Retry|resend/i);
    h.click('retry'); await settle();
    assert.equal(h.calls.filter(([name]) => name === 'voice_stop').length, 1);
    assert.equal(h.calls.some(([name]) => name === 'voice_retry'), false);
    h.event({ phase: 'error', message: 'Provider failed.' });
    h.result.reject({ message: 'Provider unavailable.', retryable: true }); await settle();
    assert.equal(actions.children[0].attributes['aria-label'], 'Retry original recording');
    h.click('cancel');
  }
});

test('cloud profile missing a key opens voice Settings before microphone startup', async () => {
  const h = await controller(); h.config.profiles[0].provider = 'openai'; await h.start();
  assert.equal(h.calls.some(([name]) => name === 'voice_start'), false);
  assert.equal(h.settingsOpened(), 1);
});

test('transcript waits for a newer configuration refresh that starts while an older refresh is pending', async () => {
  const first = deferred(), second = deferred(); let configurationReads = 0, h;
  const config = { selectedProfileId: 'p', profiles: [{ id: 'p', provider: 'custom', name: 'Local', model: 'whisper', endpoint: 'http://127.0.0.1:1/inference' }] };
  h = await controller({ call(command) {
    if (command === 'voice_configuration') return configurationReads++ === 0 ? Promise.resolve(config) : configurationReads === 2 ? first.promise : second.promise;
    if (command === 'voice_start') return Promise.resolve({ captureId: 'c' });
    if (command === 'voice_stop') return h.result.promise;
    return Promise.resolve();
  } });
  await h.start(); h.click('stop'); h.windowEvent('voice-configuration-changed');
  h.result.resolve({ captureId: 'c', text: 'held speech' }); await Promise.resolve();
  h.windowEvent('voice-configuration-changed'); first.resolve(config); await settle();
  assert.equal(h.prompt.value, '', 'a stale refresh must not authorize insertion');
  second.resolve({ ...config, selectedProfileId: null }); await settle();
  assert.equal(h.prompt.value, 'held speech'); assert.equal(h.pill.hidden, true);
});

test('empty Enter after Stop preserves transcription while a typed draft can still submit', async () => {
  const h = await controller(); await h.start(); h.click('stop'); h.prompt.focus();
  assert.equal(h.key('Enter').defaultPrevented, true);
  assert.equal(h.key('Enter', { shiftKey: true }).defaultPrevented, undefined);
  h.prompt.setRangeText('typed', 0, 0); h.input();
  assert.equal(h.key('Enter').defaultPrevented, undefined); h.click('cancel');
});

test('sending a typed draft preserves the in-flight transcript for explicit insertion into the cleared composer', async () => {
  const h = await controller(); h.prompt.value = 'draft'; await h.start(); h.click('stop');
  assert.ok(h.voice.beginSubmit()); h.prompt.value = '';
  assert.equal(h.prompt.value, ''); assert.equal(h.pill.dataset.phase, 'transcribing');
  h.result.resolve({ captureId: 'c', text: 'held transcript' }); await settle(); h.voice.submitSettled('t');
  assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.prompt.value, '');
  h.click('insert'); assert.equal(h.prompt.value, 'held transcript');
});

for (const path of ['slash picker', 'Clear draft', '/btw clear', '/btw insert', 'report attach',
  'remote send clear', 'cloud send clear', 'failed-send restore']) {
  test(`stopped capture survives programmatic draft changes from ${path}`, async () => {
    const h = await controller(); await h.start(); h.click('stop');
    h.prompt.value = 'replacement'; h.prompt.value = ''; h.prompt.value = 'restored draft';
    assert.equal(h.pill.dataset.phase, 'transcribing');
    assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false);
    h.result.resolve({ captureId: 'c', text: 'retained transcript' }); await settle();
    assert.equal(h.pill.dataset.phase, 'review');
    h.prompt.value = 'another replacement';
    h.click('insert'); assert.match(h.prompt.value, /retained transcript/);
  });
}

for (const phase of ['transcribing', 'review']) test(`failed configuration reads preserve ${phase} speech`, async () => {
  const config = { selectedProfileId: 'p', profiles: [{ id: 'p', provider: 'custom', name: 'Local', model: 'whisper', endpoint: 'http://localhost' }] };
  let reads = 0, h; const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
  try {
    h = await controller({ call(command) {
      if (command === 'voice_configuration') return reads++ ? Promise.reject(new Error('read failed')) : Promise.resolve(config);
      if (command === 'voice_start') return Promise.resolve({ captureId: 'c' });
      if (command === 'voice_stop') return h.result.promise;
      return Promise.resolve();
    } });
    await h.start(); h.click('stop');
    if (phase === 'review') { h.prompt.value = 'changed'; h.input(); h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); }
    h.windowEvent('voice-configuration-changed'); await settle();
    assert.equal(h.pill.dataset.phase, phase); assert.equal(h.pill.hidden, false);
    assert.match(warnings[0][0], /configuration refresh failed/);
    if (phase === 'transcribing') { h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); assert.equal(h.prompt.value, 'speech'); }
    else { h.prompt.setSelectionRange(7, 7); h.click('insert'); assert.equal(h.prompt.value, 'changed speech'); }
  } finally { console.warn = warn; }
});

for (const phase of ['transcribing', 'review']) for (const change of ['off', 'delete'])
  test(`successful configuration ${change} preserves ${phase} speech`, async () => {
    const h = await controller(); await h.start(); h.click('stop');
    if (phase === 'review') { h.prompt.value = 'changed'; h.input(); h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); }
    h.config.selectedProfileId = null;
    if (change === 'delete') h.config.profiles = [];
    h.windowEvent('voice-configuration-changed'); await settle();
    assert.equal(h.pill.hidden, false); assert.equal(h.pill.dataset.phase, phase);
    assert.equal(h.calls.some(([command]) => command === 'voice_cancel'), false);
    if (phase === 'transcribing') { h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); assert.equal(h.prompt.value, 'speech'); }
    else { h.click('insert'); assert.match(h.prompt.value, /speech/); }
  });

test('a removed profile keeps a failed stopped recording available for original-audio retry', async () => {
  const h = await controller(); await h.start(); h.click('stop'); h.config.profiles = []; h.config.selectedProfileId = null;
  h.windowEvent('voice-configuration-changed'); await settle();
  h.result.reject({ message: 'Provider unavailable.', retryable: true }); await settle();
  assert.equal(h.pill.dataset.phase, 'error'); assert.equal(h.pill.hidden, false);
  assert.ok(h.pill.children.at(-1).children.some(button => button.dataset.voice === 'retry')); h.click('cancel');
});

test('send holds a completed transcript until settlement and then reviews it', async () => {
  const h = await controller(); await h.start(); h.click('stop'); assert.ok(h.voice.beginSubmit());
  h.result.resolve({ captureId: 'c', text: 'held speech' }); await settle();
  assert.equal(h.prompt.value, ''); assert.equal(h.pill.dataset.phase, 'transcribing');
  h.voice.submitSettled('t'); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel');
});

test('configuration refresh uses the phase at completion instead of its old startup phase', async () => {
  const startup = deferred(), refresh = deferred(); let reads = 0, h;
  h = await controller({ call(command) {
    if (command === 'voice_configuration') return reads++ ? refresh.promise : Promise.resolve(h.config);
    if (command === 'voice_start') return startup.promise;
    return Promise.resolve();
  } });
  await h.start(); h.windowEvent('voice-configuration-changed'); startup.resolve({ captureId: 'c' }); await settle();
  refresh.resolve(h.config); await settle(); assert.equal(h.pill.hidden, false); assert.equal(h.pill.dataset.phase, 'recording'); h.click('cancel');
});

test('nested sends release held speech only after the last settlement', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  h.voice.beginSubmit(); h.voice.beginSubmit();
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  h.voice.submitSettled('t'); assert.equal(h.pill.dataset.phase, 'transcribing');
  h.voice.submitSettled('t'); assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.voice.sends.size, 0); h.click('cancel');
});

test('submit failure finishes restoration before held speech becomes review', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  await assert.rejects(h.voice.submit(async () => {
    h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
    assert.equal(h.pill.dataset.phase, 'transcribing'); h.prompt.value = 'restored'; throw new Error('Send failed.');
  }), /Send failed/);
  assert.equal(h.prompt.value, 'restored'); assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.voice.sends.size, 0); h.click('cancel');
});

test('uncommitted empty Send leaves the stopped insertion anchor and send registry untouched', async () => {
  const h = await controller(); await h.start(); h.click('stop'); assert.equal(h.voice.prepareSubmit(), true);
  assert.equal(h.voice.sends.size, 0);
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'speech'); assert.equal(h.pill.hidden, true);
});

for (const phase of ['starting', 'recording']) test(`a failed configuration read after a settings change never cancels ${phase} dictation`, async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const h = await flakyConfigurationController({ holdStart: phase === 'starting' }); await h.start();
    assert.equal(h.pill.dataset.phase, phase);
    h.state.failReads = true; h.windowEvent('voice-configuration-changed'); await settle(); await settle();
    assert.equal(h.pill.dataset.phase, phase);
    assert.equal(h.calls.some(([command]) => command === 'voice_cancel'), false);
    assert.equal(h.announcements.some(text => /cancelled/i.test(text)), false);
    if (phase === 'starting') { h.started.resolve({ captureId: 'c' }); await settle(); assert.equal(h.pill.dataset.phase, 'recording'); }
    h.state.failReads = false; h.click('stop'); h.result.resolve({ captureId: 'c', text: 'kept speech' }); await settle();
    assert.equal(h.prompt.value, 'kept speech');
  } finally { console.warn = warn; }
});

test('a successful configuration that removes the profile still cancels a capture with no audio yet', async () => {
  const h = await flakyConfigurationController({ holdStart: true }); await h.start();
  assert.equal(h.pill.dataset.phase, 'starting');
  h.config.selectedProfileId = null; h.windowEvent('voice-configuration-changed'); await settle();
  assert.equal(h.pill.hidden, true);
  assert.equal(h.calls.some(([command]) => command === 'voice_cancel'), true);
});

test('dictation started while an earlier send is pending inserts automatically at its own anchor', async () => {
  const h = await controller(); const settled = h.voice.beginSubmit('t'); assert.ok(settled);
  h.prompt.value = 'Next message:'; h.prompt.setSelectionRange(13, 13); h.input();
  await h.start(); h.click('stop');
  h.result.resolve({ captureId: 'c', text: 'spoken words' }); await settle();
  assert.equal(h.prompt.value, 'Next message: spoken words'); assert.equal(h.pill.hidden, true);
  settled(); assert.equal(h.pill.hidden, true);
});

test('a transcript whose anchor predates only a later send is held until that send settles', async () => {
  const h = await controller(); const first = h.voice.beginSubmit('t');
  await h.start(); h.click('stop'); const second = h.voice.beginSubmit('t');
  h.result.resolve({ captureId: 'c', text: 'held speech' }); await settle();
  assert.equal(h.pill.dataset.phase, 'transcribing'); assert.equal(h.prompt.value, '');
  first(); assert.equal(h.pill.dataset.phase, 'transcribing');
  second(); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel');
});

test('a transcript arriving after a send fully settled inserts into the empty composer', async () => {
  const h = await controller(); h.prompt.value = 'sent'; h.prompt.setSelectionRange(4, 4); await h.start(); h.click('stop');
  const settled = h.voice.beginSubmit('t'); h.prompt.value = ''; h.prompt.setSelectionRange(0, 0); settled();
  h.result.resolve({ captureId: 'c', text: 'after the send' }); await settle();
  assert.equal(h.prompt.value, 'after the send'); assert.equal(h.pill.hidden, true);
});

test('a transcript arriving after a settled send still reviews when the composer has other text', async () => {
  const h = await controller(); h.prompt.value = 'sent'; await h.start(); h.click('stop');
  const settled = h.voice.beginSubmit('t'); h.prompt.value = 'next message'; h.input(); settled();
  h.result.resolve({ captureId: 'c', text: 'after the send' }); await settle();
  assert.equal(h.prompt.value, 'next message'); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel');
});

// ---- composer-restore.ts: rejected sends come back before newer text, in written order ----
test('composer restore: a rejected draft with nothing committed goes before newer text, and equal text is not doubled', async () => {
  const { createCommittedDrafts } = await import('../src/composer-restore.ts');
  const drafts = createCommittedDrafts();
  assert.deepEqual(drafts.restore('t', 'Lost', ''), { text: 'Lost', at: 0 });
  assert.deepEqual(drafts.restore('t', 'Lost', 'newer'), { text: 'Lost\nnewer', at: 0 });
  assert.deepEqual(drafts.restore('t', 'Same', 'Same'), { text: 'Same', at: 0 });
});

test('composer restore: rejected sends restore in written order whichever fails first, each its own copy', async () => {
  const { createCommittedDrafts } = await import('../src/composer-restore.ts');
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const drafts = createCommittedDrafts();
    drafts.note('t', 'A'); drafts.note('t', 'B');
    let current = 'newer';
    for (const text of order) current = drafts.restore('t', text, current).text;
    assert.equal(current, 'A\nB\nnewer', order.join(''));
  }
  // Two sends of the same text both come back.
  const drafts = createCommittedDrafts();
  drafts.note('t', 'Same'); drafts.note('t', 'Same');
  const once = drafts.restore('t', 'Same', '').text;
  assert.equal(drafts.restore('t', 'Same', once).text, 'Same\nSame');
});

test('composer restore: B restores after an already restored A at its offset; threads are separate and forgettable', async () => {
  const { createCommittedDrafts } = await import('../src/composer-restore.ts');
  const drafts = createCommittedDrafts();
  drafts.note('t', '  A  '); drafts.note('t', 'B'); drafts.note('u', 'B'); drafts.note('t', '   ');
  assert.deepEqual(drafts.restore('t', 'A', 'new'), { text: 'A\nnew', at: 0 });
  assert.deepEqual(drafts.restore('t', 'B', 'A\nnew'), { text: 'A\nB\nnew', at: 2 });
  drafts.note('u', 'C');
  assert.deepEqual(drafts.restore('u', 'B', ''), { text: 'B', at: 0 });
  drafts.forget(['u']);
  // A forgotten thread no longer knows C was written after B: it goes first instead of after B.
  assert.deepEqual(drafts.restore('u', 'C', 'B'), { text: 'C\nB', at: 0 });
});

test('composer restore: only the most recent commits per thread are kept', async () => {
  const { createCommittedDrafts } = await import('../src/composer-restore.ts');
  const drafts = createCommittedDrafts(2);
  drafts.note('t', 'one'); drafts.note('t', 'two'); drafts.note('t', 'three');
  assert.deepEqual(drafts.restore('t', 'three', ''), { text: 'three', at: 0 });
  assert.deepEqual(drafts.restore('t', 'two', 'three'), { text: 'two\nthree', at: 0 });
  // 'one' was dropped: no place among the restored drafts, so it goes before everything.
  assert.deepEqual(drafts.restore('t', 'one', 'two\nthree'), { text: 'one\ntwo\nthree', at: 0 });
});

test('composer restore: applying a restored draft keeps the selection on the same text', async () => {
  const { applyRestoredDraft } = await import('../src/composer-restore.ts');
  const field = { value: 'A\nnew', selectionStart: 3, selectionEnd: 5, selectionDirection: 'backward',
    setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); } };
  applyRestoredDraft(field, 'A\nnew', 'A\nB\nnew', 2);
  assert.deepEqual([field.value, field.selectionStart, field.selectionEnd, field.selectionDirection], ['A\nB\nnew', 5, 7, 'backward']);
  // A caret before the insertion point stays put.
  field.setSelectionRange(1, 1, 'none'); applyRestoredDraft(field, 'A\nB\nnew', 'A\nB\nC\nnew', 4);
  assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 1]);
});
