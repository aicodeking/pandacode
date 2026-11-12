/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { demoCommand, demoKeys, handlers, type DemoTerminal } from '../src/demo/terminal.ts';
import type { DemoContext } from '../src/demo/index.ts';
import {
  ACTIVE_POLL_MS, applySgr, colorOf, emptyScreen, feed, FULL_PAGE, gridFor, IDLE_POLL_MS, lineInput, lineSpans, MAX_ERROR_POLL_MS, MAX_LINES,
  nextPollDelay, resizeScreen, screenText, terminalSubtitle, TERMINAL_KEYS, type PollState,
} from '../src/store/terminal.ts';

const text = (data: string | string[], cols = 80) => screenText([data].flat().reduce(feed, emptyScreen(cols, 24)));

test('plain output, newlines and carriage returns', () => {
  assert.equal(text('hello\r\nworld'), 'hello\nworld');
  assert.equal(text('downloading 10%\rdownloading 100%'), 'downloading 100%');
  assert.equal(text('abc\rX'), 'Xbc');
  // A bare LF keeps the column, as on a real terminal.
  assert.equal(text('ab\ncd'), 'ab\n  cd');
});

test('backspace, tab and the bell', () => {
  assert.equal(text('abc\b\bX'), 'aXc');
  assert.equal(text('ab\b \b'), 'a');
  assert.equal(text('\b\bx'), 'x');
  assert.equal(text('a\tb'), 'a       b');
  assert.equal(text('ding\x07'), 'ding');
});

test('long lines wrap at the column count, and a CR after a full row stays on that row', () => {
  assert.equal(text('abcdefgh', 4), 'abcd\nefgh');
  assert.equal(text('abcd\r\nef', 4), 'abcd\nef');
  assert.equal(text('abcd\rX', 4), 'Xbcd');
});

test('SGR colours and weight become styled runs', () => {
  const screen = feed(emptyScreen(), '\x1b[1;31merror\x1b[0m: \x1b[38;5;208mwarn\x1b[38;2;1;2;255m!\x1b[m done');
  const spans = lineSpans(screen.lines[0]);
  assert.deepEqual(spans.map(s => s.text), ['error', ': ', 'warn', '!', ' done']);
  assert.deepEqual(spans[0].style, { bold: true, fg: 1 });
  assert.deepEqual(spans[1].style, {});
  assert.equal(spans[2].style.fg, 208);
  assert.equal(spans[3].style.fg, '#0102ff');
  assert.equal(spans[4].style, spans[1].style);
});

test('applySgr toggles attributes and keeps equal styles identical', () => {
  const bold = applySgr({}, [1]);
  assert.equal(applySgr(bold, [1]), bold);
  assert.deepEqual(applySgr(bold, [22, 4, 92, 104]), { underline: true, fg: 10, bg: 12 });
  assert.deepEqual(applySgr({ fg: 3, bg: 4, inverse: true }, [39, 49, 27]), {});
  assert.deepEqual(applySgr({ bold: true }, []), {});
});

test('clear line and clear screen', () => {
  assert.equal(text('hello world\x1b[6D\x1b[K'), 'hello');
  assert.equal(text('hello\x1b[2K\rbye'), 'bye');
  assert.equal(text('old\r\nstuff\x1b[H\x1b[2Jfresh'), 'fresh');
  assert.equal(text('one\r\ntwo\r\nthree\x1b[2A\r\x1b[J'), '');
  assert.equal(text('abcdef\x1b[3D\x1b[1K'), '    ef');
});

test('cursor moves and insert/delete characters, as line editors use them', () => {
  assert.equal(text('hello\x1b[3D\x1b[Pxy'), 'hexy');
  assert.equal(text('held\x1b[2D\x1b[2@lo'), 'helold');
  assert.equal(text('abcdef\x1b[3G\x1b[2X'), 'ab  ef');
  assert.equal(text('a\x1b[5Cb'), 'a     b');
});

test('other escapes are stripped, including ones split across chunks', () => {
  assert.equal(text('\x1b]0;user@host: ~\x07$ ls'), '$ ls');
  assert.equal(text('\x1b]2;title\x1b\\ok'), 'ok');
  assert.equal(text('\x1b[?2004h\x1b[?25l\x1b(Bplain\x1b=\x1b>'), 'plain');
  assert.equal(text(['\x1b[3', '1mred\x1b', '[0m!']), 'red!');
  const split = feed(emptyScreen(), 'a\x1b[1');
  assert.equal(split.pending, '\x1b[1');
  assert.equal(screenText(feed(split, 'mb')), 'ab');
  assert.equal(lineSpans(feed(split, 'mb').lines[0])[1].style.bold, true);
});

test('feed never mutates its input and shares unchanged lines', () => {
  const before = feed(emptyScreen(), 'one\r\ntwo\r\n');
  const snapshot = JSON.stringify(before);
  const after = feed(before, 'three');
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(after.lines[0], before.lines[0]);
  assert.notEqual(after.lines[2], before.lines[2]);
  assert.equal(feed(after, ''), after);
});

test('scrollback is capped', () => {
  const screen = feed(emptyScreen(), 'x\r\n'.repeat(MAX_LINES + 50));
  assert.equal(screen.lines.length, MAX_LINES);
  assert.equal(screen.row, MAX_LINES - 1);
});

test('emoji and other astral characters take one cell', () => {
  assert.equal(text('🐼a\b\bb'), 'ba');
});

test('colours map for both schemes', () => {
  assert.equal(colorOf('#123456', true), '#123456');
  assert.notEqual(colorOf(1, true), colorOf(1, false));
  assert.equal(colorOf(16, true), '#000000');
  assert.equal(colorOf(231, true), '#ffffff');
  assert.equal(colorOf(232, true), '#080808');
});

test('the grid fits the measured box, clamped for narrow panes', () => {
  assert.deepEqual(gridFor(360, 600, 7.2, 16), { cols: 50, rows: 37 });
  assert.deepEqual(gridFor(100, 30, 7.2, 16), { cols: 20, rows: 4 });
  assert.deepEqual(gridFor(0, 0, 0, 16), { cols: 20, rows: 4 });
  const resized = resizeScreen(feed(emptyScreen(80, 24), 'x'.repeat(60)), 40, 10);
  assert.equal(resized.cols, 40);
  assert.equal(resized.col, 39);
});

const poll = (extra: Partial<PollState> = {}): PollState => ({ visible: true, exited: false, now: 10_000, lastActivity: 9_000, failures: 0, lastRead: 0, ...extra });

test('polling is fast while active, slow when quiet and stops when hidden or ended', () => {
  assert.equal(nextPollDelay(poll()), ACTIVE_POLL_MS);
  assert.equal(nextPollDelay(poll({ lastActivity: 0 })), IDLE_POLL_MS);
  assert.equal(nextPollDelay(poll({ visible: false })), null);
  assert.equal(nextPollDelay(poll({ exited: true })), null);
  assert.equal(nextPollDelay(poll({ lastRead: FULL_PAGE })), 0);
});

test('failed reads back off up to a cap', () => {
  const delays = [1, 2, 3, 4, 5, 10].map(failures => nextPollDelay(poll({ failures })));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, MAX_ERROR_POLL_MS, MAX_ERROR_POLL_MS]);
  assert.equal(nextPollDelay(poll({ failures: 3, visible: false })), null);
});

test('keys and labels', () => {
  assert.equal(lineInput('ls'), 'ls\r');
  const keys = new Map(TERMINAL_KEYS.map(k => [k.label, k.data]));
  assert.equal(keys.get('^C'), '\x03');
  assert.equal(keys.get('Esc'), '\x1b');
  assert.equal(keys.get('↑'), '\x1b[A');
  assert.ok(TERMINAL_KEYS.every(k => k.accessibilityLabel));
  assert.equal(terminalSubtitle({ cwd: '/Users/me/app', running: true, kind: 'shell' }), 'app · Running');
  assert.equal(terminalSubtitle({ cwd: 'C:\\code\\api', running: false, exitCode: 2, kind: 'script' }), 'Run script · api · Exited 2');
});

// ---- the demo shell ----

const ctx = (): DemoContext => ({
  host: {} as DemoContext['host'],
  deviceId: 'demo-terminal-test',
  state: { tasks: { 'demo-terminal-test': { tasks: [{ sessionId: 's1', projectId: 'p1' }], projects: [{ id: 'p1', name: 'app' }] } } } as unknown as DemoContext['state'],
  reply: () => undefined,
});

test('the demo shell opens, echoes, runs commands and exits', async () => {
  const c = ctx();
  const { terminalId } = handlers['terminal.open'](c, { sessionId: 's1', cols: 40, rows: 20 }) as { terminalId: string };
  const listed = (handlers['terminal.list'](c, {}) as { terminals: { id: string; cwd: string; sessionId?: string; running: boolean }[] }).terminals;
  assert.deepEqual(listed.map(t => [t.id, t.cwd, t.sessionId, t.running]), [[terminalId, '/Users/demo/app', 's1', true]]);
  const read = (after: number) => handlers['terminal.read'](c, { terminalId, after }) as { data: string; next: number; exited: boolean; exitCode?: number };
  const first = read(0);
  assert.match(screenText(feed(emptyScreen(), first.data)), /demo:~\/app\$$/);
  handlers['terminal.write'](c, { terminalId, data: 'echo hi\r' });
  const second = read(first.next);
  assert.match(screenText(feed(emptyScreen(), second.data)), /echo hi\nhi\n/);
  handlers['terminal.write'](c, { terminalId, data: 'exit\r' });
  const last = read(second.next);
  assert.equal(last.exited, true);
  assert.equal(last.exitCode, 0);
  assert.throws(() => handlers['terminal.write'](c, { terminalId, data: 'x' }), /closed/);
  handlers['terminal.close'](c, { terminalId });
  assert.throws(() => read(0), /Terminal is closed/);
  assert.throws(() => handlers['terminal.open'](c, { cols: 40, rows: 20 }), /Choose a project/);
});

test('the demo shell edits its line and ignores arrow keys', () => {
  const t: DemoTerminal = { id: 't', title: 'zsh', cwd: '/x/app', kind: 'shell', output: '', line: '', running: true, escape: '' };
  const typed = demoKeys(t, 'pwdd\x7f\x1b[A');
  assert.equal(typed.line, 'pwd');
  assert.match(demoKeys(typed, '\r').output, /\r\n\/x\/app\r\n/);
  assert.equal(demoKeys(t, '\x04').running, false);
  assert.equal(demoKeys(typed, '\x03').line, '');
  assert.equal(demoCommand('nope', '/'), 'nope: command not found');
  assert.equal(demoCommand('exit', '/'), null);
});
