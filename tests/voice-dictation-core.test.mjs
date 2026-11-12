import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownsVoiceResult, voiceInsertion, voiceInsertionRange } from '../src/voice-dictation.ts';
import { fakeDom, deferred, settle, controller, threadController } from './voice-dictation-harness.mjs';

test('ownership rejects stale requests, captures, navigation generations and threads', () => {
  const owner = { requestId: 'r', captureId: 'c', threadId: 't', generation: 2 };
  assert.equal(ownsVoiceResult(owner, { ...owner }), true);
  for (const [key, value] of Object.entries({ requestId: 'old', captureId: 'old', threadId: 'other', generation: 4 })) {
    assert.equal(ownsVoiceResult(owner, { ...owner, [key]: value }), false, key);
  }
});

test('insertion replaces captured selection and adds only needed boundary spaces', () => {
  assert.deepEqual(voiceInsertion('hello old world', 6, 9, 'new'), { text: 'new', value: 'hello new world', caret: 9 });
  assert.deepEqual(voiceInsertion('ab', 1, 1, 'words'), { text: ' words ', value: 'a words b', caret: 8 });
  assert.equal(voiceInsertion('hello', 5, 5, '   ').value, 'hello');
  assert.equal(voiceInsertion('hello\n', 6, 6, 'next').value, 'hello\nnext');
});

test('text anchors accept unchanged drafts or a unique prefix and reject missing or ambiguous prefixes', () => {
  const anchor = { draft: 'hello tail', start: 5, end: 5, before: 'hello', after: ' tail' };
  assert.deepEqual(voiceInsertionRange(anchor, anchor.draft), { start: 5, end: 5 });
  assert.deepEqual(voiceInsertionRange(anchor, 'new hello tail'), { start: 9, end: 9 });
  assert.equal(voiceInsertionRange(anchor, 'replacement'), null);
  assert.equal(voiceInsertionRange(anchor, 'hello hello'), null);
  assert.equal(voiceInsertionRange({ ...anchor, before: '' }, 'edited'), null);
});

test('empty transcripts never delete a selected draft', () => {
  assert.deepEqual(voiceInsertion('keep this', 0, 9, '  '), { text: '', value: 'keep this', caret: 0 });
});

test('changed draft keeps transcript in review; mic cannot insert, explicit insertion respects current selection', async () => {
  const h = await controller(); h.prompt.value = 'keep draft'; h.prompt.setSelectionRange(4, 4); await h.start();
  h.click('stop'); h.prompt._value = 'other edited draft'; h.prompt.setSelectionRange(6, 12); h.input(); h.result.resolve({ captureId: 'c', text: 'new words' }); await settle();
  assert.equal(h.pill.dataset.phase, 'review');
  assert.equal('data-voice-active' in h.form.attributes, false);
  h.click('toggle'); assert.equal(h.prompt.value, 'other edited draft');
  h.click('insert'); assert.equal(h.prompt.value, 'other new words draft');
  assert.equal(document.activeElement, h.prompt);
});

test('a transcript arriving over Settings waits for explicit insertion without taking foreground focus', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  const settings = h.element(); h.foreground(settings); settings.focus();
  h.result.resolve({ captureId: 'c', text: 'held transcript' }); await settle(); h.voice.submitSettled('t');
  assert.equal(h.prompt.value, '');
  assert.equal(h.pill.dataset.phase, 'review');
  assert.equal(document.activeElement, settings);
  assert.match(h.pill.children[1].children[0].textContent, /Return to your draft/);
  assert.match(h.announcements.at(-1), /Place the cursor or select text.*Insert at cursor/);
  h.foreground(null); h.click('cancel');
});

test('only recovery relocation re-enters the same visible surface', async () => {
  const entries = []; const h = await controller({ enter: element => entries.push(element) }); await h.start();
  h.click('stop'); assert.equal(entries.filter(element => element === h.pill).length, 1);
  h.result.reject({ message: 'Retry available.', retryable: true }); await settle();
  assert.equal(entries.filter(element => element === h.pill).length, 2);
  const count = entries.length; h.voice.bind(h.prompt); assert.equal(entries.length, count);
  h.click('retry'); assert.equal(entries.filter(element => element === h.pill).length, 3);
  h.click('cancel'); h.retry.resolve({ captureId: 'c', text: 'discarded' }); await settle();
});

test('successful transcript waits in review while the prompt is disabled and remains insertable afterwards', async () => {
  const h = await controller(); await h.start(); h.click('stop'); h.prompt.disabled = true;
  h.result.resolve({ captureId: 'c', text: 'recover this' }); await settle();
  assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.prompt.value, '');
  h.click('insert'); assert.equal(h.pill.dataset.phase, 'review');
  h.prompt.disabled = false; h.click('insert'); assert.equal(h.prompt.value, 'recover this');
});

for (const [draft, caret, edited, expected] of [
  ['hello', 5, 'hello typed', 'hello spoken typed'],
  ['head tail', 5, 'new head tail', 'new head spoken tail'],
]) test(`stopped text anchor follows edits: ${edited}`, async () => {
  const h = await controller(); h.prompt.value = draft; h.prompt.setSelectionRange(caret, caret);
  await h.start(); h.click('stop'); h.prompt.value = edited;
  h.result.resolve({ captureId: 'c', text: 'spoken' }); await settle();
  assert.equal(h.prompt.value, expected); assert.equal(h.pill.hidden, true);
});

test('empty review submission and Escape in the draft preserve the transcript; Escape inside the card discards', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  h.prompt._value = 'edited'; h.input(); h.result.resolve({ captureId: 'c', text: 'kept' }); await settle();
  h.prompt._value = ''; h.input();
  assert.equal(h.voice.prepareSubmit(), true); assert.equal(h.pill.dataset.phase, 'review');
  h.prompt.focus(); assert.equal(h.key('Escape').defaultPrevented, undefined);
  assert.equal(h.pill.hidden, false); h.pill.focus();
  assert.equal(h.key('Escape').defaultPrevented, true); assert.equal(h.pill.hidden, true);
});

test('typing and clearing back to an empty Stop-time draft keeps the transcript in review', async () => {
  const h = await controller(); await h.start(); h.click('stop');
  h.prompt.value = 'typed'; h.input(); h.prompt.value = '';
  h.result.resolve({ captureId: 'c', text: 'kept' }); await settle();
  assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.prompt.value, ''); h.click('cancel');
});

test('origin thread retains transcription while another thread is displayed and reviews on return', async () => {
  let thread = 't'; const h = await controller({ thread: () => thread });
  await h.start(); h.click('stop'); thread = 'other'; h.voice.bind(h.prompt);
  assert.equal(h.calls.some(([name]) => name === 'voice_cancel'), false);
  h.result.resolve({ captureId: 'c', text: 'origin speech' }); await settle();
  assert.equal(h.prompt.value, ''); assert.equal(h.pill.hidden, true);
  thread = 't'; h.voice.bind(h.prompt);
  assert.equal(h.pill.dataset.phase, 'review'); h.click('insert'); assert.equal(h.prompt.value, 'origin speech');
});

test('empty review copy is neutral and the captured address is not an extra tab stop', async () => {
  const h = await controller(); await h.start(); h.click('stop'); h.prompt.value = 'typed'; h.input(); h.prompt.value = '';
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.pill.children[1].children[0].textContent, 'Transcript ready to insert.');
  assert.notEqual(h.pill.children[1].children[1].tabIndex, 0); h.click('cancel');
});

test('locked keyboard and selectionchange preserve the saved insertion selection', async () => {
  const h = await controller(); h.prompt.value = 'Keep this draft.'; h.prompt.setSelectionRange(5, 5); await h.start();
  for (const [key, options] of [['a', { metaKey: true }], ['ArrowRight', { shiftKey: true }]]) {
    assert.equal(h.key(key, options).defaultPrevented, true);
  }
  h.prompt.setSelectionRange(0, h.prompt.value.length);
  h.selection(); assert.deepEqual([h.prompt.selectionStart, h.prompt.selectionEnd], [5, 5]);
  h.prompt.setSelectionRange(0, h.prompt.value.length);
  h.click('stop'); assert.deepEqual([h.prompt.selectionStart, h.prompt.selectionEnd], [5, 5]);
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'Keep speech this draft.');
});

test('dictation details expose a scrolling region only while overflowing', async () => {
  const h = await controller(); await h.start(); const details = h.pill.children[1];
  assert.equal(details.tabIndex, -1); assert.equal(details.attributes.role, undefined);
  details.clientHeight = 40; details.scrollHeight = 200; h.pill.toggleAttribute('data-floating', true);
  h.event({ phase: 'recording', elapsedMs: 2000 });
  assert.equal(details.tabIndex, 0); assert.equal(details.attributes.role, 'region');
  assert.equal(details.attributes['aria-label'], 'Dictation details');
  details.scrollHeight = 40; h.resize(); h.frame(16);
  assert.equal(details.tabIndex, -1); assert.equal(details.attributes.role, undefined);
  assert.equal(details.attributes['aria-label'], undefined); h.click('cancel');
});

test('focused details handle scrolling keys without relying on WebKit default scrolling', async () => {
  const h = await controller(); await h.start(); h.key('Enter');
  const details = h.pill.children[1]; details.scrollTop = 0; details.clientHeight = 100; details.scrollHeight = 500;
  h.pill.querySelector = selector => selector === '.voice-details' ? details : null; details.focus();
  assert.equal(h.key('ArrowDown').defaultPrevented, true); assert.ok(details.scrollTop > 0);
  h.key('ArrowUp'); assert.equal(details.scrollTop, 0);
  h.key('PageDown'); assert.ok(details.scrollTop >= details.clientHeight);
  h.prompt.focus(); assert.equal(h.key('ArrowDown').defaultPrevented, undefined); h.click('cancel');
});

test('another origin shows pending mic guidance and a brief visible hint without starting again', async () => {
  let thread = 't'; const h = await controller({ thread: () => thread }); await h.start(); h.click('stop');
  thread = 'other'; h.voice.bind(h.prompt);
  assert.equal(h.mic.attributes['aria-label'], 'Dictation pending in another thread');
  assert.match(h.mic.attributes['data-tip'], /Dictation pending in another thread/); assert.equal(h.mic.attributes.title, undefined);
  h.click('toggle'); assert.equal(h.pill.hidden, false);
  assert.equal(h.pill.children[1].children[0].textContent, 'Dictation is waiting in “Original thread”.');
  assert.equal(h.calls.filter(([name]) => name === 'voice_start').length, 1);
  for (const callback of [...h.timeouts.values()]) callback();
  assert.equal(h.pill.hidden, true);
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); thread = 't'; h.voice.bind(h.prompt); h.click('insert');
  assert.equal(h.mic.attributes['aria-label'], 'Start dictation'); assert.match(h.mic.attributes['data-tip'], /^Start dictation · /);
  assert.equal(h.mic.attributes.title, undefined);
});

test('narrow tray rule uses measured attributes without a container query', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/voice-dictation.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@container/); assert.match(css, /\[data-voice-narrow\]/);
  const h = await controller(); h.form.clientWidth = 500; await h.start();
  assert.equal(h.form.hasAttribute('data-voice-narrow'), true);
  h.form.clientWidth = 1100; h.resize(); h.frame(0); assert.equal(h.form.hasAttribute('data-voice-narrow'), false); h.click('cancel');
});

test('unavailable backdrop blur has a solid token fallback and opaque transcript surface', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/voice-dictation.css', import.meta.url), 'utf8');
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(css, /\.voice-transcript\s*\{[^}]*background:\s*var\(--panel-surface\)/);
});

test('leaving voice surface has inert-independent pointer and accessibility guards', async () => {
  const exit = deferred(); const h = await controller({ leave: () => exit.promise }); await h.start(); h.click('cancel');
  assert.equal(h.pill.attributes['data-voice-leaving'], ''); assert.equal(h.pill.attributes['aria-hidden'], 'true');
  assert.ok(h.pill.children.at(-1).children.every(button => button.disabled));
  exit.resolve(); await settle(); assert.equal(h.pill.hidden, true);
});

test('unbinding placement clears the old composer area stacking attribute', async () => {
  const { createVoicePillPlacement } = await import('../src/voice-pill-placement.ts');
  const h = fakeDom(), area = h.element(), pill = h.element(), details = h.element();
  h.form.closest = selector => selector === '.composer-area' ? area : null; h.form.clientWidth = 1000;
  const placement = createVoicePillPlacement(pill, details);
  placement.paint(h.prompt, false, false); assert.equal(area.hasAttribute('data-voice-surface'), true);
  area.setAttribute('data-voice-compact', ''); h.form.setAttribute('data-voice-compact', '');
  h.form.style.setProperty('--voice-prompt-height', '36px');
  placement.paint(null, false, false); assert.equal(area.hasAttribute('data-voice-surface'), false);
  assert.equal(area.hasAttribute('data-voice-compact'), false);
  assert.equal(h.form.hasAttribute('data-voice-compact'), false);
  assert.equal(h.form.style['--voice-prompt-height'], undefined);
});

test('locked selection rebases after a programmatic rejected-draft prepend', async () => {
  const h = await controller(); h.prompt.value = 'head selected tail'; h.prompt.setSelectionRange(5, 13); await h.start();
  h.prompt.value = 'Original\nhead selected tail'; h.selection(); h.click('stop');
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'Original\nhead speech tail');
});

test('locked selection follows a unique anchor after replacement and reviews ambiguous replacements', async () => {
  // A one-sided match ('new head changed' keeps only the text before the selection) is no longer enough.
  for (const draft of ['new head selected tail', 'new head changed', 'head X head Y', 'replacement']) {
    const h = await controller(); h.prompt.value = 'head selected tail'; h.prompt.setSelectionRange(5, 13); await h.start();
    h.prompt.value = draft; h.selection(); h.click('stop'); h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
    if (draft === 'new head selected tail') assert.equal(h.prompt.value, 'new head speech tail');
    else { assert.equal(h.prompt.value, draft); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel'); }
  }
});

test('origin hint names its task and Go to thread activates the retained origin', async () => {
  let thread = 't', visited; const h = await controller({ thread: () => thread, threadTitle: () => 'Original task', showThread: id => { visited = id; } });
  await h.start(); h.click('stop'); thread = 'other'; h.voice.bind(h.prompt); h.click('toggle');
  assert.match(h.pill.children[1].children[0].textContent, /Original task/);
  assert.ok(h.pill.children.at(-1).children.some(button => button.dataset.voice === 'origin'));
  h.click('origin'); assert.equal(visited, 't'); h.click('cancel');
});

test('sent draft anchors never attach to a retyped next message with the same prefix', async () => {
  const h = await controller(); h.prompt.value = 'Call Bob'; h.prompt.setSelectionRange(8, 8); await h.start(); h.click('stop');
  assert.ok(h.voice.beginSubmit()); h.prompt.value = ''; h.prompt.value = 'Call Bob about lunch'; h.input();
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle(); h.voice.submitSettled('t');
  assert.equal(h.prompt.value, 'Call Bob about lunch'); assert.equal(h.pill.dataset.phase, 'review'); h.click('cancel');
});

for (const [start, end] of [[11, 11], [8, 11]]) test(`auto insertion keeps the current selection ${start}..${end}`, async () => {
  const h = await controller(); h.prompt.value = 'hello'; h.prompt.setSelectionRange(5, 5); await h.start(); h.click('stop');
  h.prompt.value = 'hello world'; h.prompt.setSelectionRange(start, end); h.input();
  h.result.resolve({ captureId: 'c', text: 'speech' }); await settle();
  assert.equal(h.prompt.value, 'hello speech world');
  assert.deepEqual([h.prompt.selectionStart, h.prompt.selectionEnd], [start + 7, end + 7]);
});

test('audio-free origin error can be replaced when starting from another thread', async () => {
  let thread = 't', attempts = 0, h;
  h = await controller({ thread: () => thread, call(command) {
    if (command === 'voice_configuration') return Promise.resolve(h.config);
    if (command === 'voice_start') { attempts++; return Promise.reject(new Error('Permission denied.')); }
    return Promise.resolve();
  } });
  await h.start(); assert.equal(h.pill.dataset.phase, 'error'); thread = 'other'; h.voice.bind(h.prompt); await h.start();
  assert.equal(attempts, 2); h.click('cancel');
});

test('voice glass supports prefixed WebKit blur and shares solid panel fills and toast shadows', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/voice-dictation.css', import.meta.url), 'utf8');
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(css, /background:\s*var\(--panel\)/);
  assert.match(css, /0 18px 40px -16px var\(--glass-shadow-deep\)/);
});

test('anchors need both sides: a short one-sided prefix match goes to review', () => {
  const at = (draft, start) => ({ draft, start, end: start, before: draft.slice(0, start), after: draft.slice(start) });
  assert.equal(voiceInsertionRange(at('the', 3), 'Run the tests', true), null, 'a three-letter prefix found mid-draft is not the anchor');
  assert.deepEqual(voiceInsertionRange(at('hello', 5), 'hello typed', true), { start: 5, end: 5 }, 'edit entirely after the anchor');
  assert.deepEqual(voiceInsertionRange(at('head tail', 5), 'new head tail', true), { start: 9, end: 9 }, 'edit entirely before the anchor');
  assert.deepEqual(voiceInsertionRange(at('Call Bob soon', 8), 'Please Call Bob soon!', true), { start: 15, end: 15 }, 'both sides still frame the caret');
  assert.equal(voiceInsertionRange(at('Call Bob soon', 8), 'Please Call Bob very soon', true), null, 'text typed at the caret needs review');
  assert.equal(voiceInsertionRange(at('Call Bob soon', 8), 'Call Bob later', true), null, 'the after side no longer follows the prefix');
  assert.equal(voiceInsertionRange(at('ab ab', 2), 'ab ab ab', true), null, 'ambiguous framing');
  assert.deepEqual(voiceInsertionRange(at('Write the release notes', 9), 'Write the release notes today', false), { start: 9, end: 9 }, 'programmatic replacement keeps an intact anchor');
  assert.equal(voiceInsertionRange(at('the', 3), 'Run the tests', false), null, 'programmatic replacement cannot use a short one-sided prefix');
});

for (const arrival of ['away', 'after return']) test(`returning to an unchanged origin draft auto-inserts speech that arrived ${arrival}`, async () => {
  const h = await threadController(); h.prompt.value = 'hello world'; h.prompt.setSelectionRange(5, 5);
  await h.start(); h.go('u', null);
  if (arrival === 'away') { h.result.resolve({ captureId: 'c', text: 'spoken' }); await settle(); }
  h.prompt.setSelectionRange(11, 11); h.go('t', h.prompt);
  if (arrival !== 'away') { h.result.resolve({ captureId: 'c', text: 'spoken' }); await settle(); }
  assert.equal(h.prompt.value, 'hello spoken world'); assert.equal(h.pill.hidden, true);
});

test('returning to a changed origin draft reviews the speech', async () => {
  const h = await threadController(); h.prompt.value = 'hello world'; h.prompt.setSelectionRange(5, 5);
  await h.start(); h.go('u', null); h.result.resolve({ captureId: 'c', text: 'spoken' }); await settle();
  h.prompt.value = 'replaced entirely'; h.go('t', h.prompt);
  assert.equal(h.pill.dataset.phase, 'review'); assert.equal(h.prompt.value, 'replaced entirely'); h.click('cancel');
});

test('the pending-elsewhere hint names the origin thread in one sentence', async () => {
  const h = await threadController(); await h.start(); h.click('stop'); h.go('u', h.prompt);
  h.click('toggle');
  assert.equal(h.pill.children[1].children[0].textContent, 'Dictation is waiting in “Ship search”.');
  h.go('t', h.prompt); h.click('cancel');
});

test('binding an idle composer does no style or layout reads', async () => {
  const h = await controller(); h.replaceInputArea();
  let reads = 0; const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = element => { reads++; return original(element); };
  const spy = node => {
    for (const name of ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop', 'clientWidth', 'clientHeight', 'scrollHeight']) {
      const value = node[name]; Object.defineProperty(node, name, { configurable: true, get() { reads++; return value; } });
    }
    const rect = node.getBoundingClientRect; node.getBoundingClientRect = () => { reads++; return rect(); };
  };
  try {
    for (const node of [h.prompt, h.form, h.inputArea]) spy(node);
    h.voice.bind(h.prompt);
    assert.equal(reads, 0);
  } finally { globalThis.getComputedStyle = original; }
});

test('the composer and dictation describe the prompt with one shared function', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  // Each phrase is written once, in promptDescription, so bot steering and GitHub mentions read the same everywhere.
  for (const phrase of ['Enter to queue for when the agent finishes', 'Shift Enter for a new line', 'steer current work', 'Type @ to mention a project file${']) {
    assert.equal(main.split(phrase).length - 1, 1, phrase);
  }
  const start = main.indexOf('function renderComposer(');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.match(body, /aria-description="\$\{escape\(promptDescription\(\)\)\}"/);
  assert.doesNotMatch(body, /setAttribute\('aria-description'/);
  assert.match(main, /describePrompt: promptDescription/);
});

test('renderComposer binds dictation once on the normal path, after the prompt node is final', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = main.indexOf('function renderComposer(): void {');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.deepEqual(body.match(/voiceDictation\.bind\((?!null\))[^)]*\)/g), ['voiceDictation.bind(prompt)']);
  assert.ok(body.indexOf('voiceDictation.bind(prompt)') > body.indexOf('fresh.replaceWith(oldPrompt)'));
});
