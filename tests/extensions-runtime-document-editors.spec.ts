import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import {
  Assembler, BUILTIN, candidatesFor, checkEditorDeclarations, chunkBytes, chunkContent, chunkText, CHUNK_BYTES, DocumentEditors, extensionOf,
  HostBuffer, MAX_BYTES_BYTES, MAX_TEXT_BYTES, PERMISSION, selectEditor, type Chunk, type Content, type Entry, type Wiring,
} from '../src/extensions/runtime-document-editors';
// Preview column of R0901 (custom editors bound to audited host buffers). The browser preview runs no panel, so this spec
// runs in the test runner's Node: it checks the declarations and refusals, the editor selection (default, option, two
// defaults, remembered "Open with"), the chunked wire form (4 MiB text, 16 MiB bytes), and the host buffer through the
// webview twin (src/extensions/runtime-document-editors.ts) of the native module
// (src-tauri/src/extensions/runtime_document_editors.rs, whose tests read the same cases.json). Panels are stand-ins that
// speak the wire form; no installed app, no real panel window and no real file is touched here (those items are
// "prepared, not run" in the receipt).
const fixtures = new URL('./fixtures/extensions/runtime-document-editors/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const rival = read('rival.json');
const cases = read('cases.json');
type Obj = Record<string, any>;

/** `"{pad:N}"` anywhere in a fixture stands for N characters. */
function expand(value: any): any {
  if (typeof value === 'string') { const match = /^\{pad:(\d+)\}$/.exec(value); return match ? 'x'.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  return value;
}
const base = (): Obj => structuredClone(manifest.contributes.editors[0]);
function refusalManifest(scripted: Obj): Obj {
  const changed = base();
  for (const [key, value] of Object.entries(scripted.set ?? {})) changed[key] = expand(value);
  for (const key of scripted.drop ?? []) delete changed[key];
  let editors = [changed];
  for (const extra of scripted.extra ?? []) { const more = structuredClone(changed); for (const [key, value] of Object.entries(extra.set ?? {})) more[key] = expand(value); editors.push(more); }
  if (scripted.count) editors = Array.from({ length: scripted.count }, (_, index) => ({ ...base(), id: `sample.notebook/e${index}` }));
  const copy = structuredClone(manifest);
  copy.contributes.editors = editors;
  if (scripted.permissions) copy.permissions = scripted.permissions;
  return copy;
}

const entryOf = (source: Obj): Entry => ({ owner: source.id, version: '1.0.0', packageName: source.name, editors: (checkEditorDeclarations(source) as { editors: any[] }).editors });
const ENTRIES: Record<string, Entry> = { notebook: entryOf(manifest), rival: entryOf(rival) };

/** A registry over the named packages. `files` is the disk the host writes to; `state.granted` is the user's grant. */
function wired(names: string[] = ['notebook'], projectId = 'p1') {
  const state = { granted: true, writes: 0, failWrite: false };
  const files = new Map<string, Content>();
  const wiring: Wiring = {
    source: () => names.map(name => ENTRIES[name]),
    holds: (_owner, _version, permission, project) => state.granted && permission === PERMISSION && (project === null || project === projectId),
    write: async (project, path, content) => { if (state.failWrite) return false; state.writes += 1; files.set(`${project}/${path}`, content); return true; },
  };
  return { editors: new DocumentEditors(wiring), state, files };
}
const text = (value: string): Content => ({ text: value });
/** A stand-in panel: the page API over the wire form (read, edit by chunks). */
function panel(editors: DocumentEditors, mountId: string) {
  let revision = 0; let counter = 0;
  return {
    read() {
      const result = editors.read(mountId);
      if (!result.ok) return result;
      revision = result.revision;
      const assembler = new Assembler(result.encoding, () => 0);
      let content: Content | null = null;
      for (const chunk of result.chunks) { const step = assembler.accept(chunk); if (step.ok && step.done) content = step.content; }
      return { ...result, content: content! };
    },
    edit(content: Content) {
      let answer: ReturnType<DocumentEditors['edit']> = { ok: true, done: false };
      for (const chunk of chunkContent(content, `panel-${++counter}`, revision)) answer = editors.edit(mountId, chunk);
      if (answer.ok && answer.revision !== undefined) revision = answer.revision;
      return answer;
    },
  };
}

test.describe('extensions custom editors: R0901 host buffers', () => {
  test('the fixture packages are valid contracts and declare their editors', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect((validateContract('packages', [rival]) as Obj).ok).toBe(true);
    expect(ENTRIES.notebook.editors.map(editor => [editor.id, editor.priority, editor.encoding])).toEqual([
      ['sample.notebook/sql', 'default', 'text'], ['sample.notebook/table', 'option', 'text'], ['sample.notebook/hex', 'default', 'bytes'],
    ]);
    expect(extensionOf('src/a/Query.SQL')).toBe('.sql');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });

  for (const scripted of cases.refusals as Obj[]) {
    test(`refusal: ${scripted.id}`, () => {
      const result = checkEditorDeclarations(refusalManifest(scripted)) as Obj;
      expect(result.ok).toBe(false);
      expect({ code: result.refusal.code, at: result.refusal.at, ids: result.refusal.ids }).toEqual(scripted.expect);
      const contract = validateContract('packages', [refusalManifest(scripted)]) as Obj;
      expect(contract.ok).toBe(false);
      expect(JSON.stringify(contract)).toContain(scripted.expect.code);
    });
  }

  for (const scripted of cases.selection as Obj[]) {
    test(`selection: ${scripted.id}`, () => {
      const entries = (scripted.packages as string[]).map(name => ENTRIES[name]);
      const selection = selectEditor(candidatesFor(entries, scripted.extension, () => true), scripted.remembered);
      expect(selection).toEqual(scripted.expect);
    });
  }

  test('an installed fixture owns its extension; the built-in editor and the way back are one click', () => {
    const { editors } = wired(['notebook', 'rival']);
    expect(editors.select('p1', 'q.sql')).toMatchObject({ editor: BUILTIN, reason: 'conflict', ask: ['sample.notebook/sql', 'sample.rival/sql'] });
    editors.open('p1', 'q.sql', text('select 1'));
    const builtin = editors.mount('p1', 'q.sql', BUILTIN);
    if (!builtin.ok) throw new Error('mount');
    // One click: the package editor (and the choice is remembered), one click back: the built-in editor.
    const toPanel = editors.switchTo(builtin.mount.id, 'sample.notebook/sql');
    expect(toPanel.ok && toPanel.mount.owner).toBe('sample.notebook');
    expect(editors.select('p1', 'q.sql')).toMatchObject({ editor: 'sample.notebook/sql', reason: 'remembered' });
    const back = editors.switchTo((toPanel as any).mount.id, BUILTIN);
    expect(back.ok && back.mount.editor).toBe(BUILTIN);
    expect(editors.select('p1', 'q.sql')).toMatchObject({ editor: BUILTIN, reason: 'remembered' });
    expect(editors.mounts('p1', 'q.sql')).toHaveLength(1);
    expect(editors.switchTo((back as any).mount.id, 'sample.gone/editor')).toEqual({ ok: false, code: 'NotFound' });
  });

  test('a file the package does not claim, or whose encoding differs, opens in the built-in editor', () => {
    const { editors } = wired();
    editors.open('p1', 'a.txt', text('hello'));
    expect(editors.select('p1', 'a.txt')).toMatchObject({ editor: BUILTIN, reason: 'builtin', options: [] });
    const refused = editors.mount('p1', 'a.txt', 'sample.notebook/sql');
    expect(refused.ok && refused.mount).toMatchObject({ editor: BUILTIN, owner: null, failure: 'editor-removed' });
    editors.open('p1', 'b.sql', text('x'));
    const wrongEncoding = editors.mount('p1', 'b.sql', 'sample.notebook/hex');
    expect(wrongEncoding.ok && wrongEncoding.mount.editor).toBe(BUILTIN);
  });

  test('read and edit go through the host buffer and the audit never records content', () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('select 1'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql', 'window') as { ok: true; mount: { id: string } };
    const page = panel(editors, mount.mount.id);
    expect((page.read() as any).content).toEqual(text('select 1'));
    expect(page.edit(text('select 2'))).toMatchObject({ ok: true, done: true, revision: 1 });
    expect(buffer.snapshot().content).toEqual(text('select 2'));
    expect(buffer.dirty).toBe(true);
    // The built-in editor edits the same buffer; the panel's next read sees it.
    expect(editors.editBuiltin('p1', 'q.sql', text('select 3'))).toMatchObject({ ok: true, revision: 2 });
    expect((page.read() as any).content).toEqual(text('select 3'));
    expect(editors.audit.map(entry => entry.action)).toEqual(['mount', 'read', 'edit', 'edit', 'read']);
    expect(JSON.stringify(editors.audit)).not.toContain('select');
    expect(editors.audit.every(entry => entry.projectId === 'p1' && entry.path === 'q.sql')).toBe(true);
  });

  test('a window and the inspector show one buffer', () => {
    const { editors } = wired();
    editors.open('p1', 'q.sql', text('a'));
    const window = editors.mount('p1', 'q.sql', 'sample.notebook/sql', 'window') as { ok: true; mount: { id: string } };
    const inspector = editors.mount('p1', 'q.sql', 'sample.notebook/sql', 'inspector') as { ok: true; mount: { id: string } };
    panel(editors, window.mount.id).edit(text('from the window'));
    expect((panel(editors, inspector.mount.id).read() as any).content).toEqual(text('from the window'));
    // Closing one view keeps the changed buffer for the other.
    editors.unmount(window.mount.id);
    expect(editors.buffer('p1', 'q.sql')!.snapshot().content).toEqual(text('from the window'));
    editors.unmount(inspector.mount.id);
    expect(editors.buffer('p1', 'q.sql')).toBeDefined();
  });

  test('a disk change replaces an unchanged buffer and tells the panel; a changed buffer keeps its edits', () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    expect(editors.diskChanged('p1', 'q.sql', text('two'))).toBe('replaced');
    expect(buffer.snapshot().content).toEqual(text('two'));
    const replaced = editors.replaced.get(mount.mount.id)!;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ reason: 'disk', revision: 1 });
    expect(replaced[0].chunks[0].data).toBe('two');
    // Unsaved work is never lost.
    panel(editors, mount.mount.id).read();
    editors.editBuiltin('p1', 'q.sql', text('mine'));
    expect(editors.diskChanged('p1', 'q.sql', text('three'))).toBe('conflict');
    expect(buffer.snapshot().content).toEqual(text('mine'));
    expect(buffer.conflict).toEqual(text('three'));
    expect(editors.replaced.get(mount.mount.id)).toHaveLength(1);
    expect(editors.diskChanged('p1', 'q.sql', text('three'))).toBe('conflict');
  });

  test('revert replaces the buffer with the disk content and says so', () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('disk'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    editors.editBuiltin('p1', 'q.sql', text('edited'));
    expect(editors.revert('p1', 'q.sql')).toMatchObject({ ok: true });
    expect(buffer.snapshot().content).toEqual(text('disk'));
    expect(buffer.dirty).toBe(false);
    expect(editors.replaced.get(mount.mount.id)!.map(entry => entry.reason)).toEqual(['revert']);
  });

  test('a conflict blocks the save until the user keeps their buffer or takes the disk', async () => {
    const { editors, files, state } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    editors.editBuiltin('p1', 'q.sql', text('mine'));
    editors.diskChanged('p1', 'q.sql', text('theirs'));
    expect(await editors.save('p1', 'q.sql')).toEqual({ ok: false, code: 'Conflict' });
    expect(state.writes).toBe(0);
    expect(editors.resolveConflict('p1', 'q.sql', 'keep')).toEqual({ ok: true });
    expect(await editors.save('p1', 'q.sql')).toEqual({ ok: true, revision: 1 });
    expect(files.get('p1/q.sql')).toEqual(text('mine'));
    expect(buffer.dirty).toBe(false);
    // Take the disk: the buffer follows the disk and the panels hear a replacement.
    editors.editBuiltin('p1', 'q.sql', text('again'));
    editors.diskChanged('p1', 'q.sql', text('disk wins'));
    expect(editors.resolveConflict('p1', 'q.sql', 'disk')).toEqual({ ok: true });
    expect(buffer.snapshot().content).toEqual(text('disk wins'));
    expect(editors.resolveConflict('p1', 'q.sql', 'disk')).toEqual({ ok: false, code: 'NotFound' });
  });

  test('the host saves: onWillSave delivers a pending edit first, and a failed write keeps the buffer dirty', async () => {
    const { editors, files, state } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    const page = panel(editors, mount.mount.id); page.read();
    editors.onWillSave(mount.mount.id, async () => { page.edit(text('pending')); });
    editors.onWillSave(mount.mount.id, async () => { throw new Error('a broken callback never blocks a save'); });
    state.failWrite = true;
    expect(await editors.save('p1', 'q.sql')).toEqual({ ok: false, code: 'HostUnavailable' });
    expect(buffer.dirty).toBe(true);
    state.failWrite = false;
    expect(await editors.saveFromPanel(mount.mount.id)).toMatchObject({ ok: true });
    expect(files.get('p1/q.sql')).toEqual(text('pending'));
    expect(buffer.dirty).toBe(false);
    expect(editors.audit.at(-1)).toMatchObject({ action: 'save', detail: 'package' });
  });

  test('read-only keeps the buffer, refuses edits and saves, and still reads', async () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('locked'), { readOnly: true });
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    const page = panel(editors, mount.mount.id);
    expect((page.read() as any).readOnly).toBe(true);
    expect(page.edit(text('nope'))).toEqual({ ok: false, code: 'ReadOnly' });
    expect(await editors.save('p1', 'q.sql')).toEqual({ ok: false, code: 'ReadOnly' });
    expect(editors.editBuiltin('p1', 'q.sql', text('nope'))).toEqual({ ok: false, code: 'ReadOnly' });
    expect(buffer.snapshot().content).toEqual(text('locked'));
    expect(buffer.dirty).toBe(false);
  });

  test('revoking the grant keeps the unsaved buffer and gives a usable built-in editor', () => {
    const { editors, state } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    const page = panel(editors, mount.mount.id);
    page.edit(text('unsaved'));
    state.granted = false;
    // The next request is refused, and the mount has already fallen back to the built-in editor.
    expect(editors.read(mount.mount.id)).toEqual({ ok: false, code: 'PermissionDenied' });
    const mounts = editors.mounts('p1', 'q.sql');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ editor: BUILTIN, owner: null, failure: 'grant-revoked' });
    expect(buffer.snapshot().content).toEqual(text('unsaved'));
    expect(editors.editBuiltin('p1', 'q.sql', text('still editable'))).toMatchObject({ ok: true });
    expect(editors.select('p1', 'q.sql')).toMatchObject({ editor: BUILTIN, options: [] });
    // Narrowing without an explicit request is caught by the sweep as well.
    state.granted = true;
    const again = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    state.granted = false;
    expect(editors.grantsChanged().map(entry => entry.failure)).toEqual(['grant-revoked']);
    expect(editors.mounts('p1', 'q.sql').some(entry => entry.id === again.mount.id)).toBe(false);
  });

  test('a failed panel keeps the buffer and the built-in editor takes over', () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    panel(editors, mount.mount.id).edit(text('half done'));
    const fallback = editors.panelFailed(mount.mount.id);
    expect(fallback.ok && fallback.mount).toMatchObject({ editor: BUILTIN, failure: 'panel-failed' });
    expect(buffer.snapshot().content).toEqual(text('half done'));
    expect(editors.read(mount.mount.id)).toEqual({ ok: false, code: 'NotFound' });
    expect(editors.panelFailed(mount.mount.id)).toEqual({ ok: false, code: 'NotFound' });
  });

  test('a panel that closes mid-edit leaves the buffer unchanged', () => {
    const { editors } = wired();
    const buffer = editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    const chunks = chunkText('y'.repeat(CHUNK_BYTES * 2 + 5), 't1', 0);
    expect(editors.edit(mount.mount.id, chunks[0])).toEqual({ ok: true, done: false });
    editors.abortTransfer(mount.mount.id);
    expect(editors.edit(mount.mount.id, chunks[1])).toEqual({ ok: false, code: 'InvalidShape' });
    // A chunk of an older revision than the host's is stale.
    editors.editBuiltin('p1', 'q.sql', text('newer'));
    expect(editors.edit(mount.mount.id, chunkText('late', 't2', 0)[0])).toEqual({ ok: false, code: 'StaleContext' });
    expect(buffer.snapshot().content).toEqual(text('newer'));
  });

  for (const scripted of cases.chunks as Obj[]) {
    test(`chunks: ${scripted.id}`, () => {
      const isText = scripted.encoding === 'text';
      const source = isText ? 'x'.repeat(scripted.bytes) : new Uint8Array(scripted.bytes).fill(7);
      const chunks: Chunk[] = isText ? chunkText(source as string, 't', 0) : chunkBytes(source as Uint8Array, 't', 0);
      expect(chunks).toHaveLength(scripted.expectChunks);
      expect(chunks.every(chunk => chunk.totalBytes === scripted.bytes && chunk.schemaVersion === 1)).toBe(true);
      expect(chunks.map(chunk => chunk.final)).toEqual(chunks.map((_, index) => index === chunks.length - 1));
      expect(chunks.every((chunk, index) => chunk.offset === Math.min(index * CHUNK_BYTES, scripted.bytes))).toBe(true);
      expect(chunks.every(chunk => chunk.encoding === (isText ? 'utf8' : 'base64'))).toBe(true);
      const assembler = new Assembler(isText ? 'text' : 'bytes', () => 0);
      let done: Content | null = null;
      for (const chunk of chunks) { const step = assembler.accept(chunk); expect(step.ok).toBe(true); if (step.ok && step.done) done = step.content; }
      expect(done).not.toBeNull();
      expect('text' in done! ? done.text.length : done!.bytes.length).toBe(scripted.bytes);
    });
  }

  test('text is cut at code point boundaries and round-trips', () => {
    const source = 'é€😀'.repeat(7);
    const chunks = chunkText(source, 't', 0, 5);
    expect(chunks.every(chunk => new TextEncoder().encode(chunk.data).length <= 5)).toBe(true);
    expect(chunks.map(chunk => chunk.data).join('')).toBe(source);
    const assembler = new Assembler('text', () => 0);
    let out: Content | null = null;
    for (const chunk of chunks) { const step = assembler.accept(chunk); if (step.ok && step.done) out = step.content; }
    expect(out).toEqual(text(source));
  });

  test('the limits: 4 MiB of text and 16 MiB of bytes, no more', () => {
    expect([MAX_TEXT_BYTES, MAX_BYTES_BYTES, CHUNK_BYTES]).toEqual([4_194_304, 16_777_216, 196_608]);
    const big: Chunk = { schemaVersion: 1, transfer: 't', revision: 0, encoding: 'utf8', offset: 0, totalBytes: MAX_TEXT_BYTES + 1, data: 'x', final: false };
    expect(new Assembler('text', () => 0).accept(big)).toEqual({ ok: false, code: 'LimitExceeded' });
    expect(new Assembler('bytes', () => 0).accept({ ...big, encoding: 'base64', totalBytes: MAX_BYTES_BYTES + 1, data: 'AA==' })).toEqual({ ok: false, code: 'LimitExceeded' });
    expect(new Assembler('bytes', () => 0).accept({ ...big, encoding: 'base64', totalBytes: MAX_BYTES_BYTES, data: 'AA==' })).toEqual({ ok: true, done: false });
    const buffer = new HostBuffer('p1', 'a.sql', 'text', false, text('x'));
    expect(buffer.edit({ text: 'y'.repeat(MAX_TEXT_BYTES + 1) })).toEqual({ ok: false, code: 'LimitExceeded' });
    expect(buffer.edit({ bytes: new Uint8Array(1) })).toEqual({ ok: false, code: 'InvalidShape' });
    expect(buffer.dirty).toBe(false);
  });

  test('the wire form refuses a mismatch, a gap and a short final chunk', () => {
    const chunks = chunkText('z'.repeat(CHUNK_BYTES + 10), 't', 0);
    expect(new Assembler('text', () => 0).accept({ ...chunks[0], encoding: 'base64' })).toEqual({ ok: false, code: 'InvalidShape' });
    expect(new Assembler('bytes', () => 0).accept(chunks[0])).toEqual({ ok: false, code: 'InvalidShape' });
    const gap = new Assembler('text', () => 0);
    gap.accept(chunks[0]);
    expect(gap.accept({ ...chunks[1], offset: chunks[1].offset + 1 })).toEqual({ ok: false, code: 'InvalidShape' });
    expect(gap.open).toBe(false);
    expect(new Assembler('text', () => 0).accept({ ...chunks[0], final: true })).toEqual({ ok: false, code: 'InvalidShape' });
    expect(new Assembler('text', () => 5).accept(chunks[0])).toEqual({ ok: false, code: 'StaleContext' });
  });

  test('a byte document moves in chunks and is edited as bytes', () => {
    const { editors } = wired();
    const bytes = new Uint8Array(CHUNK_BYTES + 100).map((_, index) => index % 251);
    const buffer = editors.open('p1', 'image.bin', { bytes });
    const mount = editors.mount('p1', 'image.bin', 'sample.notebook/hex') as { ok: true; mount: { id: string } };
    const page = panel(editors, mount.mount.id);
    const first = page.read() as any;
    expect(first.encoding).toBe('bytes');
    expect(first.chunks).toHaveLength(2);
    expect(first.content).toEqual({ bytes });
    const edited = bytes.slice(); edited[7] = 255;
    expect(page.edit({ bytes: edited })).toMatchObject({ ok: true, done: true, revision: 1 });
    expect(buffer.snapshot().content).toEqual({ bytes: edited });
    expect(page.edit(text('not bytes'))).toMatchObject({ ok: false });
  });

  test('the rich channel delegates pandaView.document through one entry', async () => {
    const { editors, files } = wired();
    editors.open('p1', 'q.sql', text('one'));
    const mount = editors.mount('p1', 'q.sql', 'sample.notebook/sql') as { ok: true; mount: { id: string } };
    const opened = await editors.handle(mount.mount.id, { op: 'read' }) as Obj;
    expect(opened).toMatchObject({ ok: true, revision: 0, encoding: 'text', readOnly: false });
    expect(await editors.handle(mount.mount.id, { op: 'edit', chunk: chunkText('two', 'w1', 0)[0] })).toMatchObject({ ok: true, done: true, revision: 1 });
    expect(await editors.handle(mount.mount.id, { op: 'save' })).toEqual({ ok: true, revision: 1 });
    expect(files.get('p1/q.sql')).toEqual(text('two'));
    expect(await editors.handle(mount.mount.id, { op: 'delete' })).toEqual({ ok: false, code: 'InvalidShape' });
    expect(await editors.handle('mount-404', { op: 'read' })).toEqual({ ok: false, code: 'NotFound' });
  });

  test('remembering a choice no editor backs is refused', () => {
    const { editors } = wired();
    expect(editors.remember('p1', 'q.sql', 'sample.rival/sql')).toEqual({ ok: false, code: 'NotFound' });
    expect(editors.remember('p1', 'q.sql', BUILTIN)).toEqual({ ok: true });
    expect(editors.rememberedFor('Q.SQL')).toBe(BUILTIN);
  });
});
