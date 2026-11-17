import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { checkEditorDeclarations, DocumentEditors, extensionOf, MAX_TEXT_BYTES, PERMISSION, type Content, type Entry, type Wiring } from '../src/extensions/runtime-document-editors';
import { DocumentSave, kindOf, readReturn, type SaveEnv, type SaveMember, type Trigger } from '../src/extensions/runtime-document-save';
// Preview column of R0902 (saving host buffers through bounded package hooks). The browser preview runs no panel and no
// service, so this spec runs in the test runner's Node: it drives the webview twin (src/extensions/runtime-document-save.ts)
// of the native module (src-tauri/src/extensions/runtime_document_save.rs, whose tests read the same scenarios.json) on a
// virtual clock, with scripted hooks and a stand-in panel. No installed app, no real formatter service and no real file is
// touched here (those items are "prepared, not run" in the receipt).
const fixtures = new URL('./fixtures/extensions/runtime-document-save/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const corpus = read('scenarios.json');
type Obj = Record<string, any>;

/** `"{pad:N}"` anywhere in a fixture stands for N `x` characters. */
function expand(value: any): any {
  if (typeof value === 'string') { const match = /^\{pad:(\d+)\}$/.exec(value); return match ? 'x'.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  return value;
}

/** A virtual clock: timers fire in order, only when everything else has settled. */
function clock() {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>(resolve => { timers.push({ at: now + ms, resolve }); }),
    /** Lets promises settle, then fires the earliest timer, until `until()` or no timer is due before `limit`. */
    async drive(until: () => boolean, limit = Number.POSITIVE_INFINITY) {
      for (;;) {
        await tick();
        if (until()) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) return;
        if (next.at > limit) { timers.unshift(next); now = limit; return; }
        now = Math.max(now, next.at); next.resolve();
      }
    },
  };
}

const entry: Entry = { owner: manifest.id, version: '1.0.0', packageName: manifest.name, editors: (checkEditorDeclarations(manifest) as { editors: any[] }).editors };
const text = (value: string): Content => ({ text: value });

interface Rig { editors: DocumentEditors; save: DocumentSave; env: SaveEnv; time: ReturnType<typeof clock>; state: { granted: boolean; attached: Set<string>; failWrite: boolean }; written: Content[]; delivered: { owner: string; frame: any }[]; frames: Obj[] }
/** A registry with the fixture package's editor, hooks scripted by `members` and a host writer that records. */
function rig(members: Obj[] = [], projectId = 'p1'): Rig {
  const time = clock();
  const state = { granted: true, attached: new Set<string>(members.map(member => member.owner)), failWrite: false };
  const written: Content[] = []; const delivered: Rig['delivered'] = []; const frames: Obj[] = [];
  const wiring: Wiring = {
    source: () => [entry],
    holds: (_owner, _version, permission, project) => state.granted && permission === PERMISSION && (project === null || project === projectId),
    write: async (_project, _path, content) => { if (state.failWrite) return false; written.push(content); return true; },
  };
  const editors = new DocumentEditors(wiring);
  const env: SaveEnv = {
    members: (project, path) => (extensionOf(path) === '.sql' ? members.map((member): SaveMember => ({
      owner: member.owner, name: member.owner, hookId: `${member.owner}/save`, budgetMs: member.budgetMs ?? 100,
      ask: async payload => {
        frames.push({ owner: member.owner, text: payload.text, trigger: payload.trigger });
        if (typeof member.answer.editsBuffer === 'string') editors.editBuiltin(project, path, text(member.answer.editsBuffer));
        await time.sleep(member.answer.afterMs ?? 0);
        if (member.answer.never) await new Promise(() => {});
        if (member.answer.error) throw { code: member.answer.error };
        return expand(member.answer.value);
      },
    })) : []),
    admitted: (owner, project) => state.attached.has(owner) && state.granted && project === projectId,
    holds: (_owner, project) => state.granted && project === projectId,
    deliver: (owner, frame) => { delivered.push({ owner, frame }); },
    now: time.now, sleep: time.sleep,
  };
  return { editors, save: new DocumentSave(editors, env), env, time, state, written, delivered, frames };
}
/** Runs a save to its end on the virtual clock. */
async function run<T>(time: Rig['time'], work: Promise<T>): Promise<T> {
  let done = false; let value: T | undefined;
  void work.then(result => { done = true; value = result; });
  await time.drive(() => done);
  if (!done) throw new Error('the save never finished');
  return value as T;
}
const bufferText = (editors: DocumentEditors, path: string) => { const buffer = editors.buffer('p1', path)!; return { text: (buffer.snapshot().content as { text: string }).text, dirty: buffer.dirty }; };

test.describe('extensions document save: R0902 bounded package hooks', () => {
  test('the fixture package is a valid contract with an editor and a save.before hook', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(manifest.contributes.hooks).toEqual([{ id: 'sample.sqlfmt/save', event: 'save.before', budgetMs: 100, match: { extensions: ['.sql'] } }]);
    expect(manifest.permissions).toContain('documents.editors');
  });

  test('a hook without documents.editors is refused by the contract', () => {
    const without = structuredClone(manifest);
    without.permissions = without.permissions.filter((permission: string) => permission !== 'documents.editors');
    delete without.contributes.editors; delete without.runtime.files;
    const result = validateContract('packages', [without]) as Obj;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('PermissionDenied');
  });

  test('returns are read strictly: { text } only, at most 4 MiB', () => {
    expect(readReturn(null)).toEqual({ kind: 'empty' });
    expect(readReturn({})).toEqual({ kind: 'empty' });
    expect(readReturn({ text: 'a' })).toEqual({ kind: 'applied', text: 'a' });
    expect(readReturn({ text: 5 })).toEqual({ kind: 'refused', code: 'InvalidShape' });
    expect(readReturn({ text: 'a', refuse: true })).toEqual({ kind: 'refused', code: 'InvalidShape' });
    expect(readReturn('a')).toEqual({ kind: 'refused', code: 'InvalidShape' });
    expect(readReturn({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) })).toEqual({ kind: 'refused', code: 'LimitExceeded' });
  });

  for (const scenario of corpus.scenarios as Obj[]) {
    test(`scenario: ${scenario.id}`, async () => {
      const path = scenario.path ?? 'q.sql';
      const owners: Obj[] = scenario.members;
      const live = rig(owners);
      const { editors, save, time } = live;
      editors.open('p1', path, text(scenario.disk), { readOnly: scenario.readOnly === true });
      if (scenario.buffer !== scenario.disk) editors.editBuiltin('p1', path, text(scenario.buffer));
      const mounted = editors.mount('p1', path, 'sample.sqlfmt/sql');
      if (!mounted.ok) throw new Error('mount');
      const mount = mounted.mount;
      if (scenario.diskChange) editors.diskChanged('p1', path, text(scenario.diskChange));
      // The panel's callback, through the twin so the host waits for it before the hooks run.
      if (mount.owner) save.onWillSave(mount.id, async () => {
        if (scenario.willSave === 'slow') await time.sleep(5_000);
        if (scenario.willSave === 'throw') throw new Error('boom');
      });
      const result = await run(time, scenario.via === 'panel' ? save.saveFromPanel(mount.id, 'p1', path) : save.save('p1', path, scenario.trigger as Trigger));
      const during = live.delivered.length;
      if (scenario.settleMs) await time.drive(() => false, time.now() + scenario.settleMs);

      const expectation = scenario.expect;
      expect(result.ok ? null : result.code, 'error').toBe(expectation.error);
      expect(live.written.length ? (live.written[live.written.length - 1] as { text: string }).text : null, 'written').toBe(expectation.written);
      expect(bufferText(editors, path), 'buffer').toEqual({ text: expectation.buffer, dirty: expectation.dirty });
      expect(live.frames.map(frame => frame.owner), 'asked').toEqual(expectation.asked);
      expect(live.frames, 'frames').toEqual(expectation.frames);
      const shown = (items: Rig['delivered']) => items.map(item => ({ owner: item.owner, applied: item.frame.receipt.applied, code: item.frame.receipt.code ?? null }));
      expect(shown(live.delivered.slice(0, during)), 'receipts').toEqual(expectation.receipts);
      expect(live.delivered.slice(during).map(item => item.owner), 'late').toEqual(expectation.late);
      expect(live.delivered.slice(during).every(item => item.frame.receipt.applied === false && item.frame.receipt.code === 'Timeout'), 'late receipts are never applied').toBe(true);
      expect(save.audit.filter(entry => entry.action === 'will-save' && entry.detail !== 'ok').map(entry => entry.detail), 'willSave').toEqual(expectation.willSave);
      expect(save.drain(mount.id).map(kindOf), 'events').toEqual(expectation.events);
      expect(JSON.stringify(save.audit), 'the audit never carries content').not.toContain('select');
    });
  }

  test('replacements and saved revisions arrive in revision order', async () => {
    const { editors, save, time } = rig();
    editors.open('p1', 'q.sql', text('a'));
    const mounted = editors.mount('p1', 'q.sql', 'sample.sqlfmt/sql');
    if (!mounted.ok) throw new Error('mount');
    editors.diskChanged('p1', 'q.sql', text('b'));
    editors.editBuiltin('p1', 'q.sql', text('c'));
    await run(time, save.save('p1', 'q.sql'));
    editors.revert('p1', 'q.sql');
    const events = save.drain(mounted.mount.id);
    expect(events.map(kindOf)).toEqual(['replace:disk', 'didSave', 'replace:revert']);
    const revisions = events.map(event => event.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(save.drain(mounted.mount.id)).toEqual([]);
  });

  test('a failed write keeps the buffer; a removed package keeps the unsaved changes and loses its hook and editor', async () => {
    const live = rig([{ owner: 'sample.sqlfmt', answer: { value: { text: 'SELECT 1;' } } }]);
    const { editors, save, time, state } = live;
    editors.open('p1', 'q.sql', text('a'));
    const mounted = editors.mount('p1', 'q.sql', 'sample.sqlfmt/sql');
    if (!mounted.ok) throw new Error('mount');
    editors.editBuiltin('p1', 'q.sql', text('mine'));
    state.failWrite = true;
    expect(await run(time, save.save('p1', 'q.sql'))).toEqual({ ok: false, code: 'HostUnavailable' });
    // The formatter's text is the host's unsaved text; the failed write lost nothing.
    expect(bufferText(editors, 'q.sql')).toEqual({ text: 'SELECT 1;', dirty: true });
    state.granted = false; state.attached.clear();
    const fallback = save.packageGone('sample.sqlfmt');
    expect(fallback.map(mount => [mount.editor, mount.failure])).toEqual([['builtin', 'grant-revoked']]);
    expect(await run(time, save.saveFromPanel(mounted.mount.id, 'p1', 'q.sql'))).toEqual({ ok: false, code: 'NotFound' });
    state.failWrite = false; live.frames.length = 0;
    expect(await run(time, save.save('p1', 'q.sql'))).toMatchObject({ ok: true, transformed: false });
    expect(live.frames).toEqual([]);
    expect(live.written[live.written.length - 1]).toEqual(text('SELECT 1;'));
  });

  test('a save from a panel whose grant was revoked answers PermissionDenied and falls the mount back', async () => {
    const live = rig([{ owner: 'sample.sqlfmt', answer: { value: { text: 'X' } } }]);
    live.editors.open('p1', 'q.sql', text('a'));
    const mounted = live.editors.mount('p1', 'q.sql', 'sample.sqlfmt/sql');
    if (!mounted.ok) throw new Error('mount');
    live.state.granted = false;
    expect(await run(live.time, live.save.saveFromPanel(mounted.mount.id, 'p1', 'q.sql'))).toEqual({ ok: false, code: 'PermissionDenied' });
    expect(live.editors.mounts('p1', 'q.sql').map(mount => mount.failure)).toEqual(['grant-revoked']);
    expect(live.written).toEqual([]);
    expect(live.frames).toEqual([]);
  });

  test('a byte buffer is saved as it is and no hook is asked', async () => {
    const live = rig([{ owner: 'sample.sqlfmt', answer: { value: { text: 'X' } } }]);
    live.editors.open('p1', 'blob.sql', { bytes: new Uint8Array([1, 2, 3]) });
    live.editors.editBuiltin('p1', 'blob.sql', { bytes: new Uint8Array([4, 5]) });
    expect(await run(live.time, live.save.save('p1', 'blob.sql'))).toMatchObject({ ok: true, transformed: false });
    expect(live.frames).toEqual([]);
    expect(live.written).toEqual([{ bytes: new Uint8Array([4, 5]) }]);
  });

  test('an unknown trigger is refused before anything runs', async () => {
    const live = rig();
    live.editors.open('p1', 'q.sql', text('a'));
    expect(await run(live.time, live.save.save('p1', 'q.sql', 'sometimes' as Trigger))).toEqual({ ok: false, code: 'InvalidShape' });
    expect(live.written).toEqual([]);
  });
});
