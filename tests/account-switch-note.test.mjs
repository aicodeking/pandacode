import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SWITCH_PREFIX, accountSwitchDetail } from '../src/account-switch-note.ts';

const rotation = (from, to) => `${from} reached its usage limit, so this task continues on ${to}.`;
const prepare = (to, from, reason) => `Using ${to} because ${from} ${reason}.`;

test('account switches require the exact marker and preserve the complete nonblank detail', () => {
  assert.equal(ACCOUNT_SWITCH_PREFIX, 'Account switched\n');
  for (const detail of ['Full original native prose.', '  Keep leading and trailing space.  ', 'Line one.\nLine two.', '“研发 <b>"work" & personal</b>” → 默认 🐼']) {
    assert.equal(accountSwitchDetail(ACCOUNT_SWITCH_PREFIX + detail), detail);
  }
  for (const content of ['', ACCOUNT_SWITCH_PREFIX, ACCOUNT_SWITCH_PREFIX + ' \n\t ', 'Account switched', 'Account switched\r\nDetail', 'Account switched: Detail', ' account switched\nDetail', 'account switched\nDetail', 'Intro\n' + ACCOUNT_SWITCH_PREFIX + 'Detail']) {
    assert.equal(accountSwitchDetail(content), null, content);
  }
});

test('complete legacy preparation templates recognize only the finite native reasons and labels', () => {
  const labels = ['“Work”', 'the default Claude account', 'the default Codex account'];
  for (const from of labels) for (const to of labels) for (const reason of ['is out of room or left out of the pool', 'is near its usage limit', 'is running more tasks']) {
    const content = prepare(to, from, reason);
    assert.equal(accountSwitchDetail(content), content);
  }
});

test('complete legacy rotations recognize named and capitalized default Claude and Codex accounts', () => {
  for (const from of ['“Work”', 'The default Claude account', 'The default Codex account']) for (const to of ['“Personal”', 'the default Claude account', 'the default Codex account']) {
    const content = rotation(from, to);
    assert.equal(accountSwitchDetail(content), content);
  }
});

test('legacy labels preserve Unicode, ASCII quotes and HTML-like text through the 60 character boundary', () => {
  for (const name of ['研发 🐼', '<img src=x onerror="boom"> & "Work"', '"quoted"', 'a'.repeat(60), '🐼'.repeat(60)]) {
    const content = rotation(`“${name}”`, 'the default Codex account');
    assert.equal(accountSwitchDetail(content), content);
  }
  for (const name of ['', 'a'.repeat(61), '🐼'.repeat(61), 'nested “name”', 'line\nbreak', 'hidden\u202ename', ' ', ' Work', 'Work ', 'line\u2028break']) {
    assert.equal(accountSwitchDetail(rotation(`“${name}”`, 'the default Claude account')), null, name);
  }
});

test('ordinary notes, partial templates and prose about switching remain ordinary notes', () => {
  const full = rotation('“Work”', 'the default Claude account');
  for (const content of [
    'A report was lost.', 'Account switched successfully.', 'Using the default Claude account.',
    'Using a different account because it is near its usage limit.', 'Account switched\n',
    '“Work” reached its usage limit.', 'This task continues on the default Claude account.',
    prepare('“Personal”', '“Work”', 'reached its usage limit'),
    prepare('“Personal”', '“Work”', 'is busy'), rotation('the default Claude account', '“Personal”'),
    rotation('The default Kimi account', '“Personal”'), rotation('“Work”', 'The default Claude account'),
    full.slice(0, -1), 'Before: ' + full, full + ' More detail.', full + '\n', full + '\r', full + '\n\n', full + '\u2028', full + '\u2029',
    prepare('“Personal”', '“Work”', 'is near its usage limit') + '\n',
  ]) assert.equal(accountSwitchDetail(content), null, content);
});
