import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, deferred, settle, controller, routedController } from './voice-dictation-harness.mjs';

// The mic tooltip names this platform's shortcut (`src/platform.ts` reads navigator.platform once, when the voice
// modules first load below): pin a Mac so the expected ⌘⇧D doesn't depend on the host OS.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });

test('late recording meter cannot reopen Stop after upload or failure', async () => {
  const { voiceEventPhase } = await import('../src/voice-dictation.ts');
  assert.equal(voiceEventPhase('starting', 'recording'), 'recording');
  assert.equal(voiceEventPhase('recording', 'recording'), 'recording');
  assert.equal(voiceEventPhase('transcribing', 'recording'), 'transcribing');
  assert.equal(voiceEventPhase('error', 'recording'), 'error');
  assert.equal(voiceEventPhase('review', 'error'), 'review');
  assert.equal(voiceEventPhase('transcribing', 'error'), 'error');
});

test('cancel args always carry the requestId; Retry only appears with retained audio', async () => {
  const { voiceCancelArgs, voiceActions } = await import('../src/voice-dictation.ts');
  assert.deepEqual(voiceCancelArgs({ requestId: 'r', captureId: '' }), { requestId: 'r' });
  assert.deepEqual(voiceCancelArgs({ requestId: 'r', captureId: 'c' }), { requestId: 'r', captureId: 'c' });
  assert.deepEqual(voiceActions('error', { captureId: 'c' }), ['retry', 'record', 'settings', 'cancel']);
  assert.deepEqual(voiceActions('error', { captureId: 'c', retryable: false }), ['record', 'settings', 'cancel']);
  assert.deepEqual(voiceActions('error', { captureId: 'c', retryable: true }), ['retry', 'record', 'settings', 'cancel']);
  assert.deepEqual(voiceActions('error', { captureId: '' }), ['record', 'settings', 'cancel']);
  assert.deepEqual(voiceActions('review', { captureId: 'c', transcript: ' ' }), ['record', 'cancel']);
  assert.deepEqual(voiceActions('review', { captureId: 'c', transcript: 'hi' }), ['insert', 'cancel']);
  assert.deepEqual(voiceActions('starting', { captureId: '' }), ['cancel']);
});

test('cancelling a pending Start cancels its requestId at once; a late start reply is cancelled and a fresh start works', async () => {
  const { createVoiceDictation } = await import('../src/voice-dictation.ts');
  const { prompt, form, click } = fakeDom();
  const calls = [], starts = [], cancels = [];
  const configuration = { selectedProfileId: 'p', profiles: [{ id: 'p', name: 'Local', model: 'whisper-1', endpoint: 'http://127.0.0.1:8080/inference' }] };
  const host = {
    call(command, args) {
      calls.push([command, args]);
      if (command === 'voice_configuration') return Promise.resolve(configuration);
      if (command === 'voice_start') { const d = deferred(); starts.push({ args, ...d }); return d.promise; }
      if (command === 'voice_cancel') { const d = deferred(); cancels.push({ args, ...d }); return d.promise; }
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(() => {}), thread: () => 't', settings() {}, isImeKey: () => false, enter() {}, announce() {},
  };
  const voice = createVoiceDictation(host);
  voice.bind(prompt);
  const pill = voice.pill.element; // the card mounts only once it is shown

  click('toggle'); await settle();
  assert.equal(starts.length, 1);
  const first = starts[0].args.requestId;
  click('cancel');
  assert.deepEqual(cancels.map(c => c.args), [{ requestId: first }], 'cancel is sent synchronously, before the start reply');
  assert.equal(pill.hidden, true);

  click('toggle'); await settle();
  assert.equal(starts.length, 1, 'a fresh Start waits for the earlier cancel');
  cancels[0].resolve(); await settle();
  assert.equal(starts.length, 2);
  const second = starts[1].args.requestId;
  assert.notEqual(second, first);

  starts[0].resolve({ captureId: 'late' }); await settle();
  assert.deepEqual(cancels[1].args, { requestId: first, captureId: 'late' });
  assert.equal(pill.dataset.phase, 'starting', 'the late reply leaves the fresh capture alone');

  starts[1].resolve({ captureId: 'fresh' }); await settle();
  assert.equal(pill.dataset.phase, 'recording');
  assert.equal(pill.hidden, false);
});

test('cancelling before voice_start is reached never starts the old request', async () => {
  const { createVoiceDictation } = await import('../src/voice-dictation.ts');
  const { prompt, click } = fakeDom();
  const config = deferred(), calls = [];
  const host = {
    call(command, args) { calls.push([command, args]); return command === 'voice_configuration' ? config.promise : new Promise(() => {}); },
    subscribe: () => Promise.resolve(() => {}), thread: () => 't', settings() {}, isImeKey: () => false, enter() {}, announce() {},
  };
  const voice = createVoiceDictation(host);
  voice.bind(prompt);
  click('toggle'); await settle();
  voice.invalidate();
  const cancel = calls.find(([command]) => command === 'voice_cancel');
  assert.ok(cancel?.[1].requestId && !('captureId' in cancel[1]));
  config.resolve({ selectedProfileId: 'p', profiles: [{ id: 'p', name: 'Local', model: 'm', endpoint: 'http://127.0.0.1:1/x' }] }); await settle();
  assert.equal(calls.some(([command]) => command === 'voice_start'), false);
});

test('terminal rejection repaints an existing error state without Retry or resend guidance; Record again reads current Settings', async () => {
  const h = await controller(); h.prompt.value = 'keep draft'; await h.start(); h.click('stop');
  h.event({ phase: 'error', message: 'Audio stopped.' });
  const actions = h.pill.children.at(-1), details = h.pill.children[1].children;
  assert.equal(h.pill.dataset.phase, 'transcribing', 'generic error must not claim retained audio');
  actions.children.find(button => button.dataset.voice === 'cancel').focus();
  h.result.reject({ message: 'No microphone audio was captured. Record again.', retryable: false }); await settle();
  assert.equal(h.pill.dataset.phase, 'error');
  assert.equal(details[0].textContent, 'No microphone audio was captured. Record again.');
  assert.deepEqual(actions.children.map(button => button.dataset.voice), ['record', 'settings', 'cancel']);
  assert.equal(document.activeElement, h.pill, 'metadata replacement preserves stable focus');
  assert.doesNotMatch(details[1].textContent, /Retry|resend|original/i);
  assert.equal(`${details[0].textContent} ${details[1].textContent}`.match(/record again/gi).length, 1, 'the card says Record again once');
  h.click('retry'); await settle();
  assert.equal(h.calls.some(([name]) => name === 'voice_retry'), false, 'stale Retry controls cannot send');
  assert.equal(h.prompt.value, 'keep draft');
  h.config.selectedProfileId = 'new'; h.config.profiles.push({ ...h.config.profiles[0], id: 'new', name: 'New', model: 'new-model' });
  h.click('record'); await settle();
  // Start carries no profile id (native uses the saved destination); the fresh read shows the new profile.
  assert.equal('profileId' in h.calls.filter(([name]) => name === 'voice_start').at(-1)[1], false);
  assert.match(h.pill.children[1].children[1].textContent, /New · new-model/);
  assert.equal(h.pill.dataset.phase, 'recording');
  assert.equal(h.prompt.value, 'keep draft');
  h.click('cancel');
});

test('provider rejection retains original-recording Retry after an early error event and ignores a discarded retry result', async () => {
  const h = await controller(); h.prompt.value = 'keep draft'; await h.start(); h.click('stop');
  h.event({ phase: 'error', message: 'Provider failed.' });
  h.result.reject({ message: 'Provider unavailable. Try again.', retryable: true }); await settle();
  const actions = h.pill.children.at(-1), details = h.pill.children[1].children;
  assert.equal(details[0].textContent, 'Provider unavailable. Try again.');
  assert.equal(actions.children[0].attributes['aria-label'], 'Retry original recording');
  assert.match(details[1].textContent, /Retry resends to Local/);
  h.config.profiles[0].name = 'Changed';
  h.click('retry'); await settle();
  assert.deepEqual(h.calls.find(([name]) => name === 'voice_retry')[1], { captureId: 'c' });
  h.click('record'); await settle();
  h.retry.resolve({ captureId: 'c', text: 'stale text' }); await settle();
  assert.equal(h.prompt.value, 'keep draft');
  assert.equal(h.pill.dataset.phase, 'recording');
  h.click('cancel');
});

test('legacy Error and string upload failures keep a useful message and retry action', async () => {
  for (const reason of [new Error('Legacy provider error.'), 'Legacy provider error.']) {
    const h = await controller(); await h.start(); h.click('stop'); h.result.reject(reason); await settle();
    assert.equal(h.pill.children[1].children[0].textContent, 'Legacy provider error.');
    assert.equal(h.pill.children.at(-1).children[0].attributes['aria-label'], 'Retry original recording');
    h.click('cancel');
  }
});

test('a startup failure after an early capture event never offers retained-audio recovery', async () => {
  const pending = deferred();
  let requestId, receive;
  const h = await controller({
    call(command, args) {
      if (command === 'voice_configuration') return Promise.resolve({ selectedProfileId: 'p', profiles: [{ id: 'p', provider: 'custom', name: 'Local', model: 'm', endpoint: 'http://127.0.0.1:1/x' }] });
      if (command === 'voice_start') { requestId = args.requestId; return pending.promise; }
      return Promise.resolve();
    },
    subscribe(fn) { receive = fn; return Promise.resolve(() => {}); },
  });
  await h.start();
  receive({ requestId, captureId: 'early', phase: 'error', message: 'Microphone stopped.', elapsedMs: 0, level: 0 });
  pending.reject(new Error('Microphone could not start.')); await settle();
  assert.equal(h.pill.children[1].children[0].textContent, 'Microphone could not start.');
  assert.deepEqual(h.pill.children.at(-1).children.map(button => button.dataset.voice), ['record', 'settings', 'cancel']);
  h.click('cancel');
});

test('microphone stays start/stop/status only, keeps shortcut through redraws, and leaves recovery tray usable', async () => {
  const h = await controller(); await h.start();
  assert.match(h.mic.attributes['data-tip'], /· ⌘⇧D$/);
  assert.equal(h.mic.attributes.title, undefined, 'one tooltip: data-tip, never a native title');
  assert.equal(h.mic.attributes['aria-label'], 'Stop dictation');
  h.click('stop'); h.click('toggle');
  assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false, 'mic cannot implicitly cancel processing');
  h.result.reject({ message: 'A long actionable error. Fix the profile and record again.', retryable: true }); await settle();
  h.click('toggle');
  assert.equal(h.calls.some(([name]) => name === 'voice_retry'), false, 'mic cannot implicitly retry');
  assert.equal(document.activeElement, h.pill);
  assert.equal('data-voice-active' in h.form.attributes, false);
  assert.match(h.mic.attributes['data-tip'], /· ⌘⇧D$/);
  assert.match(h.pill.children[1].children[0].textContent, /Fix the profile/);
  assert.equal(h.pill.children[1].children[1].textContent.match(/record again/gi), null, 'the error already says record again');
  // A redraw keeps the one platform shortcut (this Mac's), never both chords or a native title.
  h.voice.bind(h.prompt); assert.match(h.mic.attributes['data-tip'], /· ⌘⇧D$/);
  assert.doesNotMatch(h.mic.attributes['data-tip'], /Ctrl/); assert.equal(h.mic.attributes.title, undefined);
  h.click('cancel'); assert.equal(document.activeElement, h.prompt);
});

test('recording shows configured limit, announces its approaching limit once, and processing timer stops on discard', async () => {
  const h = await controller(); await h.start();
  assert.match(h.pill.children[2].textContent, /0:00.*2:00/);
  h.event({ phase: 'recording', elapsedMs: 110000 });
  h.event({ phase: 'recording', elapsedMs: 111000 });
  assert.equal(h.announcements.filter(text => /10 seconds/.test(text)).length, 1);
  h.click('stop');
  assert.equal(h.pill.attributes['aria-busy'], 'true');
  assert.equal(h.timers.size, 1);
  h.click('cancel'); assert.equal(h.timers.size, 0);
});

test('silence hint requires three seconds of measured zero input and clears when a level arrives', async () => {
  const h = await controller(); await h.start();
  h.event({ phase: 'recording', elapsedMs: 1000, level: 0 });
  h.event({ phase: 'recording', elapsedMs: 3999, level: 0 });
  assert.equal(h.pill.children[1].children[0].textContent, 'Listening');
  h.event({ phase: 'recording', elapsedMs: 4000, level: 0 });
  assert.equal(h.pill.children[1].children[0].textContent, 'No input · Check microphone');
  h.event({ phase: 'recording', elapsedMs: 4200, level: 0 });
  assert.equal(h.announcements.filter(text => text === 'No input').length, 1);
  h.event({ phase: 'recording', elapsedMs: 4500, level: 0.1 });
  assert.equal(h.pill.children[1].children[0].textContent, 'Listening');
  h.event({ phase: 'recording', elapsedMs: 5000, level: 0 });
  h.event({ phase: 'recording', elapsedMs: 8000, level: 0 });
  assert.equal(h.announcements.filter(text => text === 'No input').length, 2, 'one warning per low-signal episode');
  h.click('cancel');
});

test('permission wait clock reflects elapsed time and keeps a single timer across redraws', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const pending = deferred(), announcements = [];
  // Keep the initial request waiting on the subscription to model an unfinished start.
  const dom = fakeDom();
  const { createVoiceDictation } = await import('../src/voice-dictation.ts');
  const voice = createVoiceDictation({ call: () => pending.promise, subscribe: () => pending.promise, thread: () => 't', settings() {}, isImeKey: () => false, enter() {}, announce: text => announcements.push(text) });
  voice.bind(dom.prompt); dom.click('toggle');
  const pill = voice.pill.element; now = 4000; [...dom.timers.values()][0]();
  assert.match(pill.children[1].children[1].textContent, /operating system/);
  assert.equal(pill.children[2].textContent, '0:04');
  voice.bind(dom.prompt); assert.equal(dom.timers.size, 1);
  assert.equal(announcements.filter(text => text === 'Check microphone permission').length, 1);
  voice.invalidate(); assert.equal(dom.timers.size, 0);
});

test('an interrupted exit cannot hide a fresh recording and departing controls are inert', async () => {
  const leaving = deferred();
  const h = await controller({ leave: () => leaving.promise }); await h.start();
  h.click('cancel');
  assert.equal(h.pill.inert, true);
  await h.start(); assert.equal(h.pill.inert, false);
  leaving.resolve(); await settle();
  assert.equal(h.pill.hidden, false);
  assert.equal(h.pill.dataset.phase, 'recording');
  h.click('cancel'); await settle();
});

test('canvas animates between measured levels, keeps raw RMS and stops when transcription restores the draft', async () => {
  const entries = []; const h = await controller({ enter: element => entries.push(element) }); await h.start();
  h.event({ phase: 'recording', level: 0.04, elapsedMs: 100 });
  h.event({ phase: 'recording', level: 0.25, elapsedMs: 200 });
  const meter = h.pill.children[3];
  assert.equal(h.inputArea.children[0].className, 'voice-wave-canvas');
  assert.equal(h.form.hasAttribute('data-voice-recording'), true);
  h.frame(0); h.frame(100);
  assert.ok(h.draws.at(-1).some(bar => bar[3] > 1));
  assert.equal(h.frames.size, 1);
  assert.equal(meter.value, 0.25);
  assert.match(meter.attributes['aria-valuetext'], /25 percent RMS/);
  h.click('stop');
  assert.equal(h.form.hasAttribute('data-voice-recording'), false);
  assert.equal(h.frames.size, 0);
  assert.equal(entries.filter(element => element === h.pill).length, 1);
  h.click('cancel');
});

test('reduced motion never schedules frames; review announcement does not repeat', async () => {
  const h = await controller(); h.motion.matches = true; await h.start();
  h.event({ phase: 'recording', elapsedMs: 100, level: 0.04 });
  h.event({ phase: 'recording', elapsedMs: 200, level: 0.81 });
  assert.equal(h.frames.size, 0);
  h.event({ phase: 'recording', elapsedMs: 1100, level: 0.25 });
  assert.equal(h.frames.size, 0);
  h.click('stop'); h.prompt._value = 'changed'; h.input(); h.result.resolve({ captureId: 'c', text: 'review me' }); await settle();
  assert.equal(h.pill.children[1].children[2].textContent, 'review me');
  assert.match(h.announcements.at(-1), /Transcript available below/);
  const count = h.announcements.length; h.voice.bind(h.prompt); h.voice.bind(h.prompt);
  assert.equal(h.announcements.length, count);
  h.click('cancel');
});

test('recording and transcribing retain the same captured destination with accessible waiting guidance', async () => {
  const h = await controller();
  h.config.profiles[0].name = 'My custom · unparsed profile';
  await h.start();
  const context = h.pill.children[1].children[1];
  h.event({ phase: 'recording', elapsedMs: 13000, level: 0.2 });
  const recordedClock = h.pill.children[2].textContent;
  const captured = 'Audio goes to My custom · unparsed profile · whisper-1 · 127.0.0.1:8080';
  assert.equal(context.textContent, captured);
  assert.equal(context.title, captured);
  h.config.profiles[0].name = 'Changed';
  h.config.profiles[0].model = 'different-model';
  h.click('stop');
  assert.equal(recordedClock, '0:13 / 2:00', 'recording shows the limit');
  assert.equal(h.pill.children[2].textContent, '0:13', 'transcribing keeps the recorded duration but drops the limit');
  assert.equal(context.textContent, captured, 'common phases keep identical context geometry and original destination');
  assert.equal(context.title, captured);
  assert.match(h.pill.attributes['aria-description'], /You can keep typing; Cancel discards this recording/);
  assert.equal(h.pill.hidden, false);
  h.click('cancel');
});

test('long transcription exposes elapsed wait without repeated live announcements or losing capture context', async t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const h = await controller(); await h.start(); h.event({ phase: 'recording', elapsedMs: 6500 });
  h.click('stop'); const clock = h.pill.children[2], context = h.pill.children[1].children[1];
  const destination = context.textContent;
  now = 10000; [...h.timers.values()][0]();
  assert.equal(h.pill.children[1].children[0].textContent, 'Still transcribing · 0:10');
  assert.equal(clock.textContent, '0:06');
  assert.match(clock.attributes['aria-label'], /Recorded 0:06.*Waiting 0:10/);
  assert.equal(clock.attributes['aria-live'], 'off');
  const count = h.announcements.length;
  now = 11000; [...h.timers.values()][0]();
  assert.equal(h.announcements.length, count);
  assert.match(clock.attributes['aria-label'], /Waiting 0:11/);
  assert.equal(context.textContent, destination);
  h.click('cancel');
});

test('quiet guidance keeps destination and recording duration queryable; reduced motion meter remains raw', async () => {
  const h = await controller(); h.motion.matches = true; await h.start();
  const context = h.pill.children[1].children[1], destination = context.textContent;
  h.event({ phase: 'recording', elapsedMs: 1000, level: 0 });
  h.event({ phase: 'recording', elapsedMs: 4000, level: 0 });
  assert.equal(context.textContent, destination); assert.equal(context.tabIndex, -1);
  assert.match(h.pill.children[2].attributes['aria-label'], /Recorded 0:04/);
  h.event({ phase: 'recording', elapsedMs: 4100, level: 0.36 });
  assert.equal(h.pill.children[3].value, 0.36);
  assert.equal(h.pill.children[3].attributes['aria-valuetext'], '36 percent RMS input');
  h.click('cancel');
});

test('reduced motion keeps the initial entry but makes recovery relocation and control changes immediate', async () => {
  const run = async reduced => {
    const entries = []; const h = await controller({ enter: element => entries.push(element) });
    h.motion.matches = reduced; await h.start();
    const actions = h.pill.children.at(-1), count = target => entries.filter(element => element === target).length;
    h.click('stop');
    h.result.reject({ message: 'Retry available.', retryable: true }); await settle();
    h.click('retry');
    const counts = { pill: count(h.pill), actions: count(actions) };
    h.click('cancel'); h.retry.resolve({ captureId: 'c', text: 'discarded' }); await settle();
    return counts;
  };
  const normal = await run(false), reduced = await run(true);
  assert.equal(normal.pill, 3); assert.ok(normal.actions >= 1);
  assert.deepEqual(reduced, { pill: 1, actions: 0 });
});

test('hidden documents stop waveform frames, resume without catching up and cancel releases the loop', async () => {
  const h = await controller(); await h.start(); h.frame(0); h.frame(80);
  assert.equal(h.frames.size, 1);
  h.visibility(true); assert.equal(h.frames.size, 0);
  const count = h.draws.length;
  h.event({ phase: 'recording', level: .8 }); assert.equal(h.draws.length, count);
  h.visibility(false); assert.equal(h.frames.size, 1);
  h.frame(50000); assert.equal(h.frames.size, 1);
  h.click('cancel'); assert.equal(h.frames.size, 0);
});

test('rebinding a kept textarea moves its canvas into the new input wrapper without losing recording', async () => {
  const h = await controller(); await h.start(); const canvas = h.inputArea.children[0];
  const replacement = h.replaceInputArea(); h.voice.bind(h.prompt);
  assert.equal(canvas.parentElement, replacement);
  assert.equal(h.pill.dataset.phase, 'recording'); assert.equal(h.frames.size, 1);
  h.click('cancel');
});

test('pixel-density media changes resize the backing store without a window resize and re-arm the watcher', async () => {
  const h = await controller(); await h.start(); const canvas = h.inputArea.children[0];
  assert.equal(canvas.width, 300); h.density(2); assert.equal(canvas.width, 600);
  assert.equal(h.mediaQueries.get('(resolution: 1dppx)').callbacks.size, 0);
  assert.equal(h.mediaQueries.get('(resolution: 2dppx)').callbacks.size, 1);
  h.density(3); assert.equal(canvas.width, 900); h.click('cancel');
});

test('waveform batches bars into one path and clears the previous frame synchronously on a fresh Start', async () => {
  const h = await controller(); await h.start(); h.event({ phase: 'recording', level: 1 });
  const before = { ...h.drawStats }; h.frame(0); h.frame(100);
  assert.equal(h.drawStats.paths - before.paths, 2); assert.equal(h.drawStats.fills - before.fills, 2);
  assert.ok(h.draws.at(-1).some(bar => bar[3] > 1));
  h.click('cancel'); await h.start(); assert.deepEqual(h.draws.at(-1), []); h.click('cancel');
});

test('canvas size uses layout dimensions even when an ancestor is transformed', async () => {
  const h = await controller(); h.prompt.offsetWidth = 300; h.prompt.offsetHeight = 60;
  h.prompt.getBoundingClientRect = () => ({ width: 600, height: 120 });
  await h.start(); const canvas = h.inputArea.children[0];
  assert.equal(canvas.width, 300); assert.equal(canvas.height, 60);
  assert.equal(canvas.style.width, '300px'); h.click('cancel');
});

test('extracted renderer binds, starts, clears, stops and destroys its frames and media listeners', async () => {
  const { createVoiceWaveCanvas } = await import('../src/voice-wave-canvas.ts');
  const h = fakeDom(), renderer = createVoiceWaveCanvas(() => .8);
  renderer.bind(h.prompt); renderer.start(); h.frame(0); h.frame(100);
  assert.equal(h.frames.size, 1); renderer.clear(); assert.deepEqual(h.draws.at(-1), []);
  renderer.stop(); assert.equal(h.frames.size, 0);
  renderer.start(); assert.equal(h.frames.size, 1); renderer.destroy(); assert.equal(h.frames.size, 0);
  assert.equal(h.inputArea.children.length, 0);
  assert.equal(h.mediaQueries.get('(resolution: 1dppx)').callbacks.size, 0);
  h.visibility(true); assert.equal(h.frames.size, 0);
});

test('missing canvas context keeps the read-only draft visible and schedules no waveform frames', async () => {
  const h = await controller({ canvasContext: false }); h.prompt.value = 'visible draft'; await h.start();
  assert.equal(h.prompt.readOnly, true);
  assert.equal(h.form.hasAttribute('data-voice-recording'), false); assert.equal(h.frames.size, 0);
  assert.equal(h.prompt.value, 'visible draft'); h.click('cancel');
});

test('cancellation failures warn with the capture identity instead of disappearing', async t => {
  const warnings = []; t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const h = await controller(); await h.start();
  const pending = deferred();
  const failed = await controller({ call(command) {
    if (command === 'voice_configuration') return Promise.resolve(h.config);
    if (command === 'voice_start') return Promise.resolve({ captureId: 'warn-capture' });
    if (command === 'voice_cancel') return pending.promise;
    return Promise.resolve();
  } });
  await failed.start(); failed.click('cancel'); pending.reject(new Error('cancel unavailable')); await settle();
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /warn-capture/); assert.match(warnings[0][0], /cancel/i);
});

test('renderer fades the leading edge with a short alpha ramp while filling one bar path', async () => {
  const h = await controller(); await h.start(); h.frame(0);
  const ramp = h.drawStats.gradients.at(-1);
  assert.ok(ramp); assert.equal(ramp.coordinates[2] - ramp.coordinates[0], 24);
  assert.deepEqual(ramp.stops, [[0, 'transparent'], [1, 'rgb(0, 0, 0)']]); h.click('cancel');
});

test('leaving recording stops and transcribes rather than cancelling the origin speech', async () => {
  let thread = 't'; const h = await controller({ thread: () => thread }); await h.start();
  thread = 'other'; h.voice.bind(h.prompt);
  assert.equal(h.calls.some(([name]) => name === 'voice_stop'), true);
  assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false);
  h.result.resolve({ captureId: 'c', text: 'origin speech' }); await settle();
  thread = 't'; h.voice.bind(h.prompt); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel');
});

test('capture transitions preserve frozen previous state and deletion discards an offscreen capture', async () => {
  const { transitionVoiceCapture } = await import('../src/voice-capture.ts');
  const previous = Object.freeze({ requestId: 'r', captureId: 'c', threadId: 't', generation: 0, phase: 'recording' });
  const next = transitionVoiceCapture(previous, { phase: 'transcribing', message: 'waiting' });
  assert.notEqual(next, previous); assert.equal(previous.phase, 'recording'); assert.equal(next.phase, 'transcribing');
  let thread = 't'; const h = await controller({ thread: () => thread }); await h.start(); h.click('stop');
  thread = 'other'; h.voice.bind(h.prompt); h.voice.discardThreads(['t']);
  h.result.resolve({ captureId: 'c', text: 'deleted speech' }); await settle();
  thread = 't'; h.voice.bind(h.prompt); assert.equal(h.pill.hidden, true); assert.equal(h.prompt.value, '');
});

test('resize observation defers backing-store writes until the next frame', async () => {
  const h = await controller(); await h.start(); const canvas = h.inputArea.children[0];
  const before = canvas.width; h.prompt.offsetWidth = 400; h.resize();
  assert.equal(canvas.width, before); h.frame(0); assert.equal(canvas.width, 400); h.click('cancel');
});

test('tray hides only during microphone startup and recording', async () => {
  const pending = deferred(); const h = await controller({
    call(command) {
      if (command === 'voice_configuration') return Promise.resolve({ selectedProfileId: 'p', profiles: [{ id: 'p', name: 'Local', model: 'whisper', endpoint: 'http://localhost' }] });
      if (command === 'voice_start') return pending.promise;
      if (command === 'voice_stop') return h.result.promise;
      return Promise.resolve();
    },
  });
  await h.start(); assert.equal(h.form.hasAttribute('data-voice-active'), true);
  pending.resolve({ captureId: 'c' }); await settle(); assert.equal(h.form.hasAttribute('data-voice-active'), true);
  h.click('stop'); assert.equal(h.form.hasAttribute('data-voice-active'), false); h.click('cancel');
});

test('voice failures use one named logger and preserve operation identity and cause', async () => {
  const { logVoiceFailure } = await import('../src/voice-capture.ts');
  assert.equal(typeof logVoiceFailure, 'function');
  const warn = console.warn, warnings = [], error = new Error('failed'); console.warn = (...args) => warnings.push(args);
  try { logVoiceFailure({ operation: 'cancellation', requestId: 'r', captureId: 'c' }, error); }
  finally { console.warn = warn; }
  assert.equal(warnings[0][0], 'Voice cancellation failed.');
  assert.deepEqual(warnings[0][1], { requestId: 'r', captureId: 'c' }); assert.equal(warnings[0][2], error);
});

test('cancellation tracking contains only unresolved operations and releases settled entries', async () => {
  const { VoiceCaptures } = await import('../src/voice-capture.ts'); fakeDom(); const cancellations = [];
  const captures = new VoiceCaptures({ thread: () => 't', call(command) { if (command === 'voice_cancel') { const next = deferred(); cancellations.push(next); return next.promise; } return Promise.resolve(); }, changed() {}, announce() {} });
  for (let i = 0; i < 20; i++) {
    captures.value = { requestId: String(i), captureId: 'c', threadId: 't', generation: i, phase: 'error', elapsedMs: 0, level: 0 };
    captures.invalidate();
    assert.ok(captures.cancelling instanceof Set); assert.equal(captures.cancelling.size, 1);
    cancellations.at(-1).resolve(); await settle(); assert.equal(captures.cancelling.size, 0);
  }
});

test('an idle waveform never reads its colour; Start refreshes it', async () => {
  globalThis.__mutationCallbacks = [];
  const h = await controller(), original = globalThis.getComputedStyle; let reads = 0;
  globalThis.getComputedStyle = element => { if (element?.className === 'voice-wave-canvas') reads++; return original(element); };
  try {
    for (const callback of globalThis.__mutationCallbacks) callback([]);
    h.resize(); h.voice.bind(h.prompt);
    assert.equal(reads, 0, 'theme changes and redraws while idle skip colour reads');
    await h.start(); assert.equal(h.pill.dataset.phase, 'recording');
    assert.ok(reads >= 1, 'Start reads the current colour'); h.click('cancel');
  } finally { globalThis.getComputedStyle = original; }
});

test('voice input starts without a profile id so the saved destination decides', async () => {
  const h = await routedController(); h.prompt.focus(); h.shortcut('keydown', 0); await settle();
  assert.equal(h.pill.dataset.phase, 'recording');
  const start = h.calls.find(([command]) => command === 'voice_start')[1];
  assert.ok(start.requestId); assert.equal('profileId' in start, false); h.click('cancel');
});

test('the local route says audio stays on this device and transcribes on it', async () => {
  const h = await routedController({ destination: 'local' }); await h.start();
  assert.match(h.pill.children[1].children[1].textContent, /on this device/i);
  h.click('stop'); assert.equal(h.pill.dataset.phase, 'transcribing');
  assert.equal(h.pill.children[1].children[0].textContent, 'Transcribing on this device…'); h.click('cancel');
});

for (const [name, options, pattern] of [
  ['off', { destination: 'off' }, /Voice input is off/],
  ['a local route without an installed model', { destination: 'local', catalog: { platformSupported: true, models: [{ id: 'm1', name: 'Parakeet', state: 'downloadable', active: false }] } }, /Download a speech model/],
  ['an unsupported computer', { destination: 'local', catalog: { platformSupported: false, models: [] } }, /not supported/],
]) test(`voice input shows a setup state for ${name} and never starts native capture`, async () => {
  const h = await routedController(options);
  assert.equal(h.mic.attributes['aria-label'], 'Set up dictation');
  assert.equal(h.mic.attributes['aria-disabled'], undefined, 'the setup mic works (it opens Settings), so it is not aria-disabled');
  assert.match(h.mic.attributes['data-tip'], pattern); assert.equal(h.mic.attributes.title, undefined);
  h.prompt.focus(); assert.equal(h.shortcut('keydown', 0).defaultPrevented, true); await settle();
  assert.equal(h.calls.some(([command]) => command === 'voice_start'), false);
  assert.equal(h.settingsOpened(), 1); assert.ok(h.announcements.some(text => pattern.test(text)));
});

test('voice input setup state clears when Settings turns it on', async () => {
  const h = await routedController({ destination: 'off' }); assert.equal(h.mic.attributes['aria-label'], 'Set up dictation');
  h.prefs.destination = 'local'; await h.refresh();
  assert.equal(h.mic.attributes['aria-label'], 'Start dictation'); assert.equal(h.mic.attributes['aria-disabled'], undefined);
});

/** A controller that also hears `voice://transcript` (the window closed while recording). */
async function closeController() {
  let transcript;
  const h = await controller({ subscribeTranscript(fn) { transcript = fn; return Promise.resolve(() => {}); } });
  const requestId = () => h.calls.find(([name]) => name === 'voice_start')[1].requestId;
  const stops = () => h.calls.filter(([name]) => name === 'voice_stop');
  return { ...h, requestId, stops, transcript: payload => transcript({ captureId: 'c', requestId: requestId(), text: 'closed speech', ...payload }) };
}

test('window close: native transcribing leaves recording at once and the Stop path inserts the transcript once', async () => {
  const h = await closeController(); h.prompt.value = 'Draft: '; await h.start();
  assert.equal(h.pill.dataset.phase, 'recording');
  h.event({ phase: 'transcribing', elapsedMs: 0, level: 0 });
  assert.equal(h.pill.dataset.phase, 'transcribing', 'native stopped the recording: the pill leaves recording');
  assert.deepEqual(h.stops().map(([, args]) => args), [{ captureId: 'c' }], 'voice_stop joins the native transcription');
  h.transcript();
  assert.equal(h.stops().length, 1, 'the transcript event does not start a second Stop');
  h.result.resolve({ captureId: 'c', text: 'closed speech' }); await settle();
  assert.equal(h.prompt.value, 'closed speech Draft: ', 'inserted at the saved anchor (the caret, at the start)');
  h.transcript(); await settle();
  assert.equal(h.prompt.value.match(/closed speech/g).length, 1, 'never inserted twice');
});

test('window close: a transcript event without a transcribing event still shows transcribing, then inserts', async () => {
  const h = await closeController(); h.prompt.value = 'Draft: '; await h.start();
  h.transcript();
  assert.equal(h.pill.dataset.phase, 'transcribing');
  assert.equal(h.stops().length, 1);
  h.result.resolve({ captureId: 'c', text: 'closed speech' }); await settle();
  assert.equal(h.prompt.value, 'closed speech Draft: ', 'inserted at the saved anchor (the caret, at the start)');
});

test('window close: an edited draft goes to review instead of inserting', async () => {
  const h = await closeController(); h.prompt.value = 'Draft: '; await h.start();
  h.transcript(); h.prompt._value = 'changed'; h.input();
  h.result.resolve({ captureId: 'c', text: 'closed speech' }); await settle();
  assert.equal(h.pill.dataset.phase, 'review');
  assert.equal(h.prompt.value, 'changed');
  h.click('cancel');
});

test('window close: transcripts for foreign or discarded captures are ignored', async () => {
  const h = await closeController(); h.prompt.value = 'Draft: '; await h.start();
  h.transcript({ captureId: 'other' }); h.transcript({ requestId: 'someone-else' });
  assert.equal(h.pill.dataset.phase, 'recording');
  assert.equal(h.stops().length, 0);
  h.click('cancel'); await settle();
  h.transcript(); await settle();
  assert.equal(h.stops().length, 0, 'a discarded capture never stops or inserts');
  assert.equal(h.prompt.value, 'Draft: ');
  // A Stop already in flight owns the result; the event adds nothing.
  await h.start(); h.click('stop');
  h.transcript({ captureId: 'c' });
  assert.equal(h.stops().length, 1);
});

test('window close: a failure after native stopped keeps Retry with the original audio', async () => {
  const h = await closeController(); h.prompt.value = 'Draft: '; await h.start();
  h.event({ phase: 'transcribing', elapsedMs: 0, level: 0 });
  h.result.reject({ message: 'Speech service unavailable.', retryable: true }); await settle();
  assert.equal(h.pill.dataset.phase, 'error');
  h.click('retry'); await settle();
  assert.equal(h.calls.filter(([name]) => name === 'voice_retry').length, 1);
  h.retry.resolve({ captureId: 'c', text: 'closed speech' }); await settle();
  assert.equal(h.prompt.value, 'closed speech Draft: ', 'inserted at the saved anchor (the caret, at the start)');
});
