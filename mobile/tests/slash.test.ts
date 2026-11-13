/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeQueue, filterCommands, insertCommand, isSlashText, moved, parseBtw, phoneAction, runsOnPhone, slashQuery, type SlashCommand } from '../src/store/slash.ts';

const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, description: '', kind: 'native', source: 'x', available: true, ...extra });

test('the menu opens only while a lone command name is typed at the start', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/Rev'), 'rev');
  assert.equal(slashQuery('/review now'), null);
  assert.equal(slashQuery(' /review'), null);
  assert.equal(slashQuery('hello'), null);
});

test('commands are recognised as the desktop composer does', () => {
  assert.ok(isSlashText('/review'));
  assert.ok(isSlashText('/review the diff'));
  assert.ok(isSlashText('/?'));
  assert.ok(!isSlashText('/ nope'));
  assert.ok(!isSlashText('path/to/file'));
});

test('filtering ranks prefix, then name, then description, terminal-only last', () => {
  const commands = [
    cmd('/vim', { available: false, description: 'review mode' }),
    cmd('/security-review'),
    cmd('/compact', { description: 'review history' }),
    cmd('/review'),
    cmd('/model'),
  ];
  assert.deepEqual(filterCommands(commands, 'rev').map(c => c.name), ['/review', '/security-review', '/compact', '/vim']);
  assert.equal(filterCommands(commands, '').length, 5);
  assert.equal(filterCommands(commands, '', 2).length, 2);
  assert.deepEqual(filterCommands(commands, 'zzz'), []);
});

test('picking a command leaves room for its arguments', () => {
  assert.equal(insertCommand(cmd('/review')), '/review ');
});

test('/btw parses like the desktop', () => {
  assert.equal(parseBtw('/btw'), '');
  assert.equal(parseBtw('/BTW why is CI red?'), 'why is CI red?');
  assert.equal(parseBtw('/btwx'), null);
  assert.equal(parseBtw('hello'), null);
});

test('app controls map onto phone screens or are refused', () => {
  assert.deepEqual(phoneAction(null), { kind: 'send' });
  assert.deepEqual(phoneAction('init'), { kind: 'send' });
  assert.deepEqual(phoneAction('btw'), { kind: 'btw' });
  assert.deepEqual(phoneAction('model'), { kind: 'route', pathname: '/task-settings', focus: 'model' });
  assert.deepEqual(phoneAction('diff'), { kind: 'route', pathname: '/changes' });
  assert.deepEqual(phoneAction('help'), { kind: 'menu' });
  assert.deepEqual(phoneAction('console'), { kind: 'unsupported' });
  assert.ok(runsOnPhone(cmd('/review')));
  assert.ok(!runsOnPhone(cmd('/console', { action: 'console' })));
  assert.ok(!runsOnPhone(cmd('/vim', { available: false })));
});

test('queue moves clamp to the list and decoding drops bad rows', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b'], 5, 1), ['a', 'b']);
  const entries = decodeQueue({ entries: [{ id: 'q', text: 'hi', position: 1, attachments: 2, truncated: 1 }, { id: 3 }, null] });
  assert.deepEqual(entries, [{ id: 'q', position: 1, text: 'hi', truncated: true, attachments: 2, createdAt: 0, updatedAt: 0 }]);
  assert.deepEqual(decodeQueue(null), []);
});
