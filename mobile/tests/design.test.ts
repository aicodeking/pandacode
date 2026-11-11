/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesignComment } from '../src/connect/api/design.ts';
import type { Method } from '../src/connect/rpc.ts';
import type { DemoHost } from '../src/demo-host.ts';
import type { ConnectState } from '../src/store/index.ts';
import { artboardSubtitle, artboardTitle, pinPoint, tapToArtboard, threadOrder, whereLabel } from '../src/ui/design/geometry.ts';

const NOW = new Date(2026, 10, 9, 14, 0).getTime();
// A 1024×2048 PNG rendered at 2 pixels per CSS pixel (a 512×1024 artboard), shown 256 points wide.
const SIZE = { width: 1024, height: 2048, scale: 2 };
const SHOWN = 256;

const comment = (extra: Partial<DesignComment> = {}): DesignComment => ({
  id: 'c', artboard: 'home.html', selector: 'body', bbox: { x: 92, y: 192, width: 16, height: 16 }, text: 'Hi', status: 'open', createdAt: 0, ...extra,
});

test('a tap maps to the artboard’s CSS pixels and stays on it', () => {
  assert.deepEqual(tapToArtboard({ x: 50, y: 100 }, SIZE, SHOWN), { x: 100, y: 200 });
  assert.deepEqual(tapToArtboard({ x: 0, y: 0 }, SIZE, SHOWN), { x: 0, y: 0 });
  assert.deepEqual(tapToArtboard({ x: -5, y: 9999 }, SIZE, SHOWN), { x: 0, y: 1024 });
  assert.deepEqual(tapToArtboard({ x: 300, y: 10 }, SIZE, SHOWN), { x: 512, y: 20 });
  // Zoomed to twice the width, the same spot on the artboard is twice as far in.
  assert.deepEqual(tapToArtboard({ x: 100, y: 200 }, SIZE, SHOWN * 2), { x: 100, y: 200 });
  for (const bad of [0, -1, NaN]) assert.deepEqual(tapToArtboard({ x: 5, y: 5 }, SIZE, bad), { x: 0, y: 0 });
  assert.deepEqual(tapToArtboard({ x: 5, y: 5 }, { ...SIZE, scale: 0 }, SHOWN), { x: 0, y: 0 });
});

test('a comment’s pin sits at its box’s centre, and only on the shown preview', () => {
  assert.deepEqual(pinPoint(comment().bbox, SIZE, SHOWN), { x: 50, y: 100 });
  assert.deepEqual(pinPoint(comment().bbox, SIZE, SHOWN * 2), { x: 100, y: 200 });
  // The preview only shows the top of a tall artboard.
  assert.equal(pinPoint({ x: 10, y: 5000, width: 10, height: 10 }, SIZE, SHOWN), null);
  assert.equal(pinPoint({ x: -50, y: 10, width: 10, height: 10 }, SIZE, SHOWN), null);
  assert.equal(pinPoint(comment().bbox, SIZE, 0), null);
  // A tap round-trips to the same pin.
  const at = tapToArtboard({ x: 80, y: 40 }, SIZE, SHOWN);
  assert.deepEqual(pinPoint({ x: at.x, y: at.y, width: 0, height: 0 }, SIZE, SHOWN), { x: 80, y: 40 });
});

test('the thread lists one artboard, open first then oldest, numbered', () => {
  const list = [
    comment({ id: 'r', status: 'resolved', createdAt: 1 }),
    comment({ id: 'b', createdAt: 3 }),
    comment({ id: 'x', artboard: 'about.html', createdAt: 0 }),
    comment({ id: 'a', createdAt: 2 }),
  ];
  const before = JSON.stringify(list);
  assert.deepEqual(threadOrder(list, 'home.html').map(c => [c.id, c.number]), [['a', 1], ['b', 2], ['r', 3]]);
  assert.equal(JSON.stringify(list), before, 'threadOrder leaves its input alone');
  assert.deepEqual(threadOrder(list, 'none.html'), []);
});

test('titles, subtitles and where a pin is read plainly', () => {
  assert.equal(artboardTitle('home.html'), 'home');
  assert.equal(artboardTitle('home.html.bak'), 'home.html.bak');
  assert.equal(artboardSubtitle(1, 10), '1 open comment');
  assert.equal(artboardSubtitle(3, 10), '3 open comments');
  assert.equal(artboardSubtitle(0, 512), '512 bytes');
  assert.equal(artboardSubtitle(0, 4096), '4 KB');
  assert.equal(whereLabel(comment()), 'x 100, y 200');
  assert.equal(whereLabel(comment({ selector: 'header > button' })), 'header > button · x 100, y 200');
});

test('the demo answers every design method', async () => {
  const { demoCall } = await import('../src/demo-host.ts');
  const task = { sessionId: 's1', title: 't', status: 'idle', projectId: 'app', projectName: 'app', provider: 'claude', model: 'default', effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null };
  let state = {
    devices: [{ id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { studio: { tasks: [task], projects: [{ id: 'app', name: 'app', repo: null }], loadedAt: 0 } },
    messages: {}, live: {}, outdated: {}, sent: {}, bots: {},
  } as unknown as ConnectState;
  const host: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => NOW };
  const call = (method: string, params: object = {}) => demoCall(host, 'studio', method as Method, params) as Promise<any>;
  const at = { projectId: 'app' };

  const list = await call('design.list', at);
  assert.deepEqual(list.artboards.map((a: { name: string }) => a.name), ['home.html', 'settings.html']);
  assert.equal(list.open['home.html'], 2);
  assert.equal(list.preview, true);
  await assert.rejects(call('design.list', {}), /Choose a project/);
  await assert.rejects(call('design.list', { projectId: 'gone' }), /no longer exists/);

  assert.match((await call('design.read', { sessionId: 's1', name: 'home' })).text, /<title>Home/);
  await assert.rejects(call('design.read', { ...at, name: 'nope' }), /No artboard named nope.html/);
  const page = await call('design.preview', { ...at, name: 'home.html' });
  assert.equal(page.mime, 'image/svg+xml');
  assert.ok(page.done && page.total === page.data.length && page.scale === 1);

  const { comment: made } = await call('design.comment', { ...at, artboard: 'home', x: 40, y: 50, text: '  Bigger  ' });
  assert.deepEqual([made.artboard, made.text, made.status, made.bbox.x + made.bbox.width / 2], ['home.html', 'Bigger', 'open', 40]);
  await assert.rejects(call('design.comment', { ...at, artboard: 'home', x: 1, y: 1, text: ' ' }), /Write a comment/);
  const home = (await call('design.comments', { ...at, artboard: 'home.html' })).comments;
  assert.ok(home.some((c: DesignComment) => c.id === made.id) && home.every((c: DesignComment) => c.artboard === 'home.html'));

  assert.equal((await call('design.resolve', { ...at, commentId: made.id })).comment.status, 'resolved');
  assert.equal((await call('design.list', at)).open['home.html'], 2);
  assert.equal((await call('design.resolve', { ...at, commentId: made.id, status: 'open' })).comment.status, 'open');
  await assert.rejects(call('design.resolve', { ...at, commentId: 'gone' }), /no longer exists/);
});
