/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// demo-host first, as the app loads it: demo/tools.ts uses its helpers inside handlers.
import '../src/demo-host.ts';
import { legacy, parseHello } from '../src/connect/api/hello.ts';
import { entryParams, HUB_ENTRIES, hubSections, offers, versionLine } from '../src/ui/hub/entries.ts';
import { handlers as tools } from '../src/demo/tools.ts';
import { handlers as files } from '../src/demo/files.ts';

const hello = (methods: string[], features: string[] = []) => parseHello({ protocol: 2, appVersion: '0.4.0', methods, features })!;

test('before host.hello settles, every row shows (calls explain themselves)', () => {
  const keys = hubSections(undefined).flatMap(s => s.entries.map(e => e.key));
  assert.deepEqual(keys.sort(), HUB_ENTRIES.map(e => e.key).sort());
});

test('a host shows only the rows it serves, in section order', () => {
  const caps = hello(['tasks.list', 'files.list', 'files.search', 'progress.list'], ['terminal']);
  const sections = hubSections(caps);
  assert.deepEqual(sections.map(s => s.section), ['work', 'project', 'computer']);
  assert.deepEqual(sections.flatMap(s => s.entries.map(e => e.key)), ['tasks', 'progress', 'files', 'search', 'terminal']);
});

test('older hosts keep only Tasks; feature groups need host.hello', () => {
  const sections = hubSections(legacy());
  assert.deepEqual(sections.flatMap(s => s.entries.map(e => e.key)), ['tasks']);
  assert.equal(offers(legacy(), 'feature:terminal'), false);
  assert.equal(offers(undefined, 'feature:terminal'), true);
});

test('route params carry the computer and, for project tools, the project', () => {
  const files = HUB_ENTRIES.find(e => e.key === 'files')!;
  const tasks = HUB_ENTRIES.find(e => e.key === 'tasks')!;
  const usage = HUB_ENTRIES.find(e => e.key === 'usage')!;
  assert.deepEqual(entryParams(files, 'mac', 'web'), { device: 'mac', project: 'web' });
  assert.deepEqual(entryParams(files, 'mac', null), { device: 'mac' });
  assert.deepEqual(entryParams(tasks, 'mac', 'web'), { computer: 'mac' });
  assert.deepEqual(entryParams(usage, 'mac', 'web'), { device: 'mac' });
});

test('the version line', () => {
  assert.equal(versionLine(undefined), '');
  assert.equal(versionLine(hello([])), 'PandaCode 0.4.0');
  assert.match(versionLine(legacy()), /older/);
});

test('every hub tool the demo serves has a demo answer', () => {
  const demo = new Set([...Object.keys(tools), ...Object.keys(files)]);
  for (const entry of HUB_ENTRIES) {
    if (['files', 'search', 'recipes', 'servers', 'progress', 'checks', 'skills'].includes(entry.key)) assert.ok(demo.has(entry.needs), entry.needs);
  }
  for (const method of ['progress.thumb', 'progress.media', 'checks.run', 'recipes.plan', 'recipes.run', 'skills.activate', 'runScript.start', 'localServers.list', 'files.read', 'files.image', 'files.grep', 'projects.list']) {
    assert.ok(demo.has(method), method);
  }
});

test('demo progress images are whole SVG pages', () => {
  const ctx = { host: { now: () => 0 } as never, deviceId: 'studio', state: {} as never, reply: () => undefined };
  const list = tools['progress.list'](ctx, { sessionId: 'auth' }) as { snapshots: { id: string }[] };
  assert.ok(list.snapshots.length > 0);
  const thumb = tools['progress.thumb'](ctx, { sessionId: 'auth', id: list.snapshots[0].id }) as { mime: string; done: boolean; total: number; data: string };
  assert.equal(thumb.mime, 'image/svg+xml');
  assert.equal(thumb.done, true);
  assert.equal(thumb.total, thumb.data.length);
  assert.throws(() => tools['skills.activate'](ctx, { id: 'deploy', active: true }), /safety/);
});

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('feature screens load again when their computer comes back online, and show loading on Retry', () => {
  const common = source('ui/hub/common.tsx');
  assert.match(common, /export const keyDevice = \(key: string\) => key\.split\(\/\[\/:\]\/, 1\)\[0\]/);
  assert.match(common, /export function useLoad<T>\(load: [^,]+, key: string, device: string = keyDevice\(key\)\)/);
  assert.match(common, /useReloadOnReconnect\(device, run\);/);
  // A Retry clears the stale error first, so screens draw their loading state while it runs.
  assert.match(common, /setState\(s => \(s\.key === key \? \{ key, value: s\.value, loading: true \} : \{ key, loading: true \}\)\);/);
  // Every caller's key leads with the device id, which is what keyDevice reads.
  for (const file of ['app/servers.tsx', 'app/design.tsx', 'app/files.tsx', 'app/checks.tsx', 'app/terminal.tsx', 'app/computer-settings.tsx']) {
    for (const [, key] of source(file).matchAll(/useLoad\([^,]+, ([^)]+)\)/g)) assert.match(key, /^(device|key|`\$\{device\}[/:])/, `${file}: ${key}`);
  }
});

test('the reconnect reload is one shared hook, used by every screen with its own load', () => {
  const hook = source('ui/useReloadOnReconnect.ts');
  assert.match(hook, /export const cameOnline = \(was: boolean \| undefined, now: boolean\) => was === false && now;/);
  assert.match(hook, /export function useReloadOnReconnect\(device: string, reload: \(\) => unknown\): void/);
  assert.match(hook, /if \(cameOnline\(was, online\)\) void latest\.current\(\);/);
  for (const name of ['changes', 'queue', 'branches', 'github', 'schedules', 'pull', 'worktree', 'usage', 'bot-admin', 'github-item', 'machines', 'schedule', 'board']) {
    const file = source(`app/${name}.tsx`);
    assert.match(file, /import \{ useReloadOnReconnect \} from '\.\.\/ui\/useReloadOnReconnect\.ts';/, name);
    assert.match(file, /useReloadOnReconnect\(device, /, name);
  }
});

test('the board\'s refresh error offers Retry', () => {
  assert.match(source('app/board.tsx'), /title="Couldn’t refresh the board" body=\{error\} action=\{\{ label: 'Retry', onPress: refresh \}\}/);
});

test('the computer hub says why a project tool is closed', () => {
  const hub = source('app/computer/[device].tsx');
  assert.match(hub, /if \(!projects\) return failed \? 'Projects didn’t load' : 'Loading projects…';/);
  assert.match(hub, /return projects\.length \? 'Pick a project above' : 'Add a project first';/);
  assert.match(hub, /blocked \? projectsLabel : entry\.subtitle/);
});

test('the run script\'s preview address copies with a toast', () => {
  const servers = source('app/servers.tsx');
  assert.match(servers, /const copyPreview = \(preview: string\) => Clipboard\.setStringAsync\(preview\)/);
  assert.match(servers, /showToast\(\{ title: 'Preview address copied'/);
  assert.match(servers, /onPress=\{\(\) => void copyPreview\(preview\)\} onLongPress=\{\(\) => void copyPreview\(preview\)\}/);
});
