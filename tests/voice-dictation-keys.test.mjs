import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, settle, controller, routedController } from './voice-dictation-harness.mjs';

test('Stop returns typing focus immediately, held Enter cannot submit, and completion keeps typing focus', async () => {
  const h = await controller(); await h.start();
  const actions = h.pill.children.at(-1);
  actions.children.find(button => button.dataset.voice === 'stop').focus();
  h.click('stop');
  assert.equal(document.activeElement, h.prompt);
  assert.equal(h.pill.tabIndex, -1);
  h.key('Enter', { repeat: true });
  assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false);
  assert.ok(actions.children.some(button => button.dataset.voice === 'cancel'), 'explicit Cancel remains keyboard reachable');
  h.result.resolve({ captureId: 'c', text: 'hello' }); await settle();
  assert.equal(h.prompt.value, 'hello');
  assert.equal(document.activeElement, h.prompt);
  assert.equal(h.pill.hidden, true);
});

test('Escape belongs to foreground Settings, menus, dialogs, outside focus and IME; only composer Escape discards', async () => {
  const h = await controller(); await h.start();
  h.prompt.focus();
  for (const foreground of ['settings', 'menu', 'dialog', 'popover']) {
    h.foreground({ kind: foreground });
    assert.equal(h.key('Escape').defaultPrevented, undefined, foreground);
  }
  h.foreground(null);
  h.element().focus(); assert.equal(h.key('Escape').defaultPrevented, undefined);
  h.prompt.focus(); assert.equal(h.key('Escape', { keyCode: 229 }).defaultPrevented, undefined);
  assert.equal(h.key('Escape', { isComposing: true }).defaultPrevented, undefined);
  assert.equal(h.key('Escape').defaultPrevented, true);
  assert.equal(h.pill.hidden, true);
  assert.equal(document.activeElement, h.prompt);
});

test('voice Enter consumes repeats and release while next deliberate Enter and IME remain available', async () => {
  const h = await controller(); await h.start();
  h.pill.children.at(-1).children.find(button => button.dataset.voice === 'stop').focus();
  assert.equal(h.key('Enter').defaultPrevented, true);
  h.result.resolve({ captureId: 'c', text: 'hello' }); await settle();
  assert.equal(document.activeElement, h.prompt);
  assert.equal(h.key('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(h.key('Enter', { keyCode: 229 }).defaultPrevented, undefined);
  assert.equal(h.key('Enter', { type: 'keyup' }).defaultPrevented, true);
  assert.equal(h.key('Enter').defaultPrevented, undefined);
});

test('shortcut belongs only to draft and voice controls; unrelated editing retains focus after insertion', async () => {
  const h = await controller(), other = h.element(); other.focus();
  assert.equal(h.key('D', { ctrlKey: true, shiftKey: true }).defaultPrevented, undefined);
  assert.equal(h.calls.filter(([command]) => command !== 'voice_preferences').length, 0, 'only the startup preference read');
  h.prompt.focus(); assert.equal(h.key('D', { ctrlKey: true, shiftKey: true }).defaultPrevented, true); await settle();
  h.click('stop'); other.focus(); h.result.resolve({ captureId: 'c', text: 'hello' }); await settle();
  assert.equal(document.activeElement, other);
  assert.equal(h.prompt.value, 'hello');
});

test('explicit Insert during composition gives deduped guidance and retains both transcript and draft', async () => {
  const h = await controller(); h.prompt.value = 'draft'; await h.start(); h.input();
  h.click('stop'); h.composition('compositionstart'); h.result.resolve({ captureId: 'c', text: 'held words' }); await settle();
  h.composition('compositionstart'); h.click('insert');
  assert.equal(h.prompt.value, 'draft');
  assert.equal(h.pill.children[1].children[2].textContent, 'held words');
  assert.equal(h.pill.children[1].children[0].textContent, 'Finish composing, then choose Insert at cursor.');
  const count = h.announcements.length; h.click('insert'); assert.equal(h.announcements.length, count);
  h.composition('compositionend'); assert.equal(h.prompt.value, 'draft');
  h.click('insert'); assert.match(h.prompt.value, /held words/);
});

test('recording locks the prompt, blocks submission and turns non-IME Enter into Stop while preserving selection', async () => {
  for (const prior of [false, true]) {
    const h = await controller(); h.prompt.readOnly = prior; h.prompt.value = 'keep draft'; h.prompt.setSelectionRange(2, 5);
    await h.start(); assert.equal(h.prompt.readOnly, true);
    assert.equal(h.submit().defaultPrevented, true); assert.equal(h.submit().stopped, true);
    h.prompt.focus(); assert.equal(h.key('Enter', { keyCode: 229 }).defaultPrevented, undefined);
    assert.equal(h.pill.dataset.phase, 'recording');
    assert.equal(h.key('Enter').defaultPrevented, true); assert.equal(h.pill.dataset.phase, 'transcribing');
    assert.equal(h.prompt.readOnly, prior); assert.equal(h.submit().defaultPrevented, undefined);
    assert.deepEqual([h.prompt.value, h.prompt.selectionStart, h.prompt.selectionEnd], ['keep draft', 2, 5]);
    h.click('cancel');
    await h.start(); h.click('cancel'); assert.equal(h.prompt.readOnly, prior);
  }
});

test('explicit Stop restores the draft even when the pointer previously focused a different control', async () => {
  const h = await controller(); await h.start(); h.element().focus(); h.click('stop');
  assert.equal(document.activeElement, h.prompt); h.click('cancel');
});

test('permission startup locks submission and guidance, ignores Enter and restores the original description on cancel', async () => {
  const pending = deferred(); let h;
  h = await controller({ call(command) {
    if (command === 'voice_configuration') return Promise.resolve(h.config);
    if (command === 'voice_start') return pending.promise;
    return Promise.resolve();
  } });
  h.prompt.setAttribute('aria-description', 'Enter to send'); await h.start();
  assert.equal(h.pill.dataset.phase, 'starting'); assert.equal(h.prompt.readOnly, true);
  assert.doesNotMatch(h.prompt.getAttribute('aria-description'), /Enter to send/);
  h.prompt.focus(); assert.equal(h.key('Enter').defaultPrevented, true);
  assert.equal(h.submit().defaultPrevented, true); assert.equal(h.voice.prepareSubmit(), false);
  h.click('cancel'); assert.equal(h.prompt.readOnly, false);
  assert.equal(h.prompt.getAttribute('aria-description'), 'Enter to send');
  pending.resolve({ captureId: 'late' }); await settle();
});

test('empty Enter during transcription explains that the recording is still pending', async () => {
  const h = await controller(); await h.start(); h.click('stop'); h.prompt.focus();
  assert.equal(h.key('Enter').defaultPrevented, true);
  assert.match(h.pill.children[1].children[0].textContent, /transcri.*still|still.*transcri/i);
  h.click('cancel');
});

test('unlock recomputes prompt guidance from the current running state', async () => {
  let description = 'Enter to queue';
  const h = await controller({ describePrompt: () => description });
  h.prompt.setAttribute('aria-description', description); await h.start();
  description = 'Enter to send'; h.click('stop');
  assert.equal(h.prompt.getAttribute('aria-description'), description); h.click('cancel');
});

test('Escape from a review draft cannot discard controller-owned text', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  h.prompt._value = 'edited'; h.input(); h.result.resolve({ captureId: 'c', text: 'kept' }); await settle();
  h.prompt.focus(); assert.equal(h.key('Escape').defaultPrevented, undefined);
  assert.equal(h.pill.hidden, false); h.click('cancel');
});

test('mouse start focuses the locked prompt and composer/card Enter stops recording', async () => {
  const h = await controller(); await h.start(); assert.equal(document.activeElement, h.prompt);
  h.form.focus(); assert.equal(h.key('Enter').defaultPrevented, true);
  assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});

test('legacy popover selector failures leave shortcuts, cancellation and insertion usable', async () => {
  const h = await controller(), query = document.querySelector;
  document.querySelector = selector => {
    if (selector.includes(':popover-open')) throw new DOMException('Unsupported selector', 'SyntaxError');
    return query(selector);
  };
  h.prompt.focus(); assert.equal(h.key('d', { metaKey: true, shiftKey: true }).defaultPrevented, true);
  await settle(); assert.equal(h.pill.dataset.phase, 'recording');
  h.key('Escape'); assert.equal(h.pill.hidden, true);
  await h.start(); h.key('Enter'); h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'speech'); assert.equal(h.pill.hidden, true);
});

test('focused composer buttons keep Enter and Space instead of stopping recording', async () => {
  const h = await controller(); await h.start();
  const attach = h.element(); attach.closest = selector => selector.includes('button') ? attach : null;
  h.form.append(attach); attach.focus();
  for (const key of ['Enter', ' ']) assert.equal(h.key(key).defaultPrevented, undefined);
  assert.equal(h.pill.dataset.phase, 'recording'); h.click('cancel');
});

test('Escape on a transcribing status card preserves the pending transcript', async () => {
  const h = await controller(); await h.start(); h.key('Enter');
  h.key('d', { metaKey: true, shiftKey: true }); assert.equal(document.activeElement, h.pill);
  assert.equal(h.key('Escape').defaultPrevented, undefined);
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'speech'); assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false);
});

test('recording submit provides an announced hint without ending the capture', async () => {
  const h = await controller(); await h.start(); assert.equal(h.submit().defaultPrevented, true);
  assert.equal(h.pill.children[1].children[0].textContent, 'Stop dictation to send');
  assert.ok(h.announcements.includes('Stop dictation to send')); assert.equal(h.pill.dataset.phase, 'recording'); h.click('cancel');
});

test('Escape in an error card keeps retained audio for Retry', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  h.result.reject({ message: 'Provider unavailable.', retryable: true }); await settle();
  assert.equal(h.pill.dataset.phase, 'error');
  h.pill.focus(); const event = h.key('Escape');
  assert.equal(h.pill.dataset.phase, 'error'); assert.equal(h.pill.hidden, false);
  assert.equal(h.calls.some(([command]) => command === 'voice_cancel'), false);
  assert.equal(event.defaultPrevented, true, 'Escape is handled, returning focus to the draft');
  assert.equal(document.activeElement, h.prompt); h.click('cancel');
});

test('Toggle shortcut: press starts, a long hold keeps recording, the next press stops', async () => {
  const h = await routedController({ shortcutMode: 'toggle' }); h.prompt.focus();
  h.shortcut('keydown', 0); await settle(); assert.equal(h.pill.dataset.phase, 'recording');
  h.shortcut('keyup', 900); await settle(); assert.equal(h.pill.dataset.phase, 'recording');
  h.shortcut('keydown', 1200); await settle(); assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});

test('Hold shortcut: keydown starts and releasing stops, even a quick release', async () => {
  const h = await routedController({ shortcutMode: 'hold' }); h.prompt.focus();
  h.shortcut('keydown', 0); await settle(); assert.equal(h.pill.dataset.phase, 'recording');
  assert.equal(h.shortcut('keydown', 30, { repeat: true }).defaultPrevented, true, 'repeats are consumed');
  h.shortcut('keyup', 100); await settle(); assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});

test('Hold shortcut released by the modifier (macOS drops the letter keyup) also stops', async () => {
  const h = await routedController({ shortcutMode: 'hold' }); h.prompt.focus();
  h.shortcut('keydown', 0); await settle();
  h.key('Meta', { type: 'keyup', shiftKey: true, timeStamp: 500 }); await settle();
  assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});

test('Hold shortcut released while the microphone is still starting stops once recording begins', async () => {
  const h = await routedController({ shortcutMode: 'hold' }); h.state.holdStart = true; h.prompt.focus();
  h.shortcut('keydown', 0); await settle(); assert.equal(h.pill.dataset.phase, 'starting');
  h.shortcut('keyup', 80); await settle(); assert.equal(h.pill.dataset.phase, 'starting');
  h.started.resolve({ captureId: 'c' }); await settle(); await settle();
  assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});

for (const [held, phase] of [[120, 'recording'], [300, 'transcribing'], [700, 'transcribing']]) test(`Auto shortcut held ${held} ms leaves the capture ${phase}`, async () => {
  const h = await routedController({ shortcutMode: 'auto' }); h.prompt.focus();
  h.shortcut('keydown', 1000); await settle();
  h.shortcut('keyup', 1000 + held); await settle(); assert.equal(h.pill.dataset.phase, phase);
  if (phase === 'recording') { h.shortcut('keydown', 2000); await settle(); assert.equal(h.pill.dataset.phase, 'transcribing'); }
  h.click('cancel');
});

test('the shortcut ignores IME keys and follows a changed mode after Settings', async () => {
  const h = await routedController({ shortcutMode: 'toggle' }); h.prompt.focus();
  h.shortcut('keydown', 0, { isComposing: true }); await settle(); assert.equal(h.pill.hidden, true);
  h.prefs.shortcutMode = 'hold'; await h.refresh();
  h.shortcut('keydown', 10); await settle(); h.shortcut('keyup', 60); await settle();
  assert.equal(h.pill.dataset.phase, 'transcribing'); h.click('cancel');
});
