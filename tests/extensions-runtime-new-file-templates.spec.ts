import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { BUILTIN, checkEditorDeclarations, DocumentEditors, PERMISSION, type Content, type Entry as EditorEntry, type Wiring } from '../src/extensions/runtime-document-editors';
import { checkNewFileDeclarations, NewFiles, targetPath, validRelative, MAX_PATH, MAX_TEMPLATE_PATH, type Env, type Entry, type Project } from '../src/extensions/runtime-new-file-templates';
// Preview column of R0903 (templated new files and the editor choice of ui.reveal). The browser preview runs no panel and
// no archive, so this spec runs in the test runner's Node: it drives the webview twin
// (src/extensions/runtime-new-file-templates.ts) of the native module (src-tauri/src/extensions/runtime_new_file_templates.rs,
// whose tests read the same cases.json) over an in-memory project, the templates of the fixture archive and the R0901
// registry. Installed-app proof (a real new-file menu, floating editor window, save, safe-mode reopen on Windows) is
// "prepared, not run" in the receipt.
const fixtures = new URL('./fixtures/extensions/runtime-new-file-templates/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixtures));
const manifest = JSON.parse(read('extension.json').toString('utf8'));
const cases = JSON.parse(read('cases.json').toString('utf8'));
type Obj = Record<string, any>;
const OWNER = manifest.id as string;
const normalize = (text: string) => text.replace(/\r\n/g, '\n');
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** `"{pad:N}"` anywhere in a fixture stands for N `x` characters. */
function expand(value: any): any {
  if (typeof value === 'string') { const match = /^\{pad:(\d+)\}$/.exec(value); return match ? 'x'.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  return value;
}

/** The fixture manifest with one refusal case applied to its first new-file item. */
function refusalManifest(scripted: Obj): Obj {
  const next = structuredClone(manifest) as Obj;
  const base = next.contributes.newFiles[0];
  const derive = (changes: Obj) => {
    const item = structuredClone(base) as Obj;
    for (const [key, value] of Object.entries(changes.set ?? {})) item[key] = expand(value);
    for (const key of changes.drop ?? []) delete item[key];
    return item;
  };
  let list = [derive(scripted), ...(scripted.extra ?? []).map(derive)];
  if (typeof scripted.count === 'number') list = Array.from({ length: scripted.count }, (_, index) => ({ ...structuredClone(base), id: `${OWNER}/n${index}` }));
  next.contributes.newFiles = list;
  if (scripted.permissions) next.permissions = scripted.permissions;
  return next;
}

const checked = checkNewFileDeclarations(manifest);
if (!checked.ok) throw new Error('the fixture manifest must be valid');
const declaredEditors = (checkEditorDeclarations(manifest) as { editors: any[] }).editors;

class Disk implements Project {
  files = new Map<string, Uint8Array>();
  stale = false;
  readOnly = false;
  known() { return !this.stale; }
  async createNew(_project: string, path: string, bytes: Uint8Array) {
    if (this.files.has(path)) return { ok: false as const, code: 'Conflict' as const };
    this.files.set(path, bytes);
    return { ok: true as const };
  }
  async read(_project: string, path: string) {
    const bytes = this.files.get(path);
    return bytes ? { ok: true as const, bytes, readOnly: this.readOnly } : { ok: false as const, code: 'NotFound' as const };
  }
}

interface Rig { editors: DocumentEditors; flow: NewFiles; disk: Disk; state: { grant: boolean; dynamic: boolean; editorsGone: boolean; templateMissing: boolean }; audit: () => Obj[] }
/** A registry with the fixture package's editors, the package's new-file items, an in-memory project and the archive's templates. */
function rig(existing: string[] = [], disk = new Disk()): Rig {
  const state = { grant: true, dynamic: true, editorsGone: false, templateMissing: false };
  for (const path of existing) disk.files.set(path, encoder.encode('old'));
  const editorEntry = (): EditorEntry => ({ owner: OWNER, version: '1.0.0', packageName: manifest.name, editors: state.editorsGone ? [] : declaredEditors });
  const holds = (_owner: string, _version: string, permission: string, _project: string | null) => state.grant && permission === PERMISSION;
  const wiring: Wiring = {
    source: () => [editorEntry()],
    holds,
    write: async (_project, path, content: Content) => { disk.files.set(path, 'text' in content ? encoder.encode(content.text) : content.bytes); return true; },
  };
  const editors = new DocumentEditors(wiring);
  const entry: Entry = { owner: OWNER, version: '1.0.0', packageName: manifest.name, items: (checked as { items: any[] }).items };
  const env: Env = {
    source: () => [entry],
    holds,
    dynamic: () => state.dynamic,
    template: (_owner, _version, path) => (state.templateMissing || !path.startsWith('templates/') ? undefined : new Uint8Array(read(path))),
    files: disk,
  };
  const flow = new NewFiles(env);
  return { editors, flow, disk, state, audit: () => flow.audit as unknown as Obj[] };
}

test.describe('extensions custom editors: R0903 templated new files', () => {
  test('the fixture package is a valid contract with three new-file items and a shipped archive', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(checked.items.map(item => [item.id, item.extension, item.template, item.editor ?? null])).toEqual([
      ['sample.notes/note', '.note', 'templates/empty.note', 'sample.notes/note'],
      ['sample.notes/data', '.dat', 'templates/blank.dat', 'sample.notes/hex'],
      ['sample.notes/blank', '.note', 'templates/empty.note', null],
    ]);
    expect(normalize(decoder.decode(read('templates/empty.note')))).toBe('# New note\n');
    expect(normalize(decoder.decode(read('templates/blank.dat')))).toBe('DAT1\n');
    expect(checkNewFileDeclarations({ id: OWNER })).toEqual({ ok: true, items: [] });
  });

  for (const scripted of cases.refusals as Obj[]) {
    test(`refusal: ${scripted.id}`, () => {
      const result = checkNewFileDeclarations(refusalManifest(scripted)) as Obj;
      expect(result.ok).toBe(false);
      expect({ code: result.refusal.code, at: result.refusal.at, ids: result.refusal.ids }).toEqual(scripted.expect);
      const contract = validateContract('packages', [refusalManifest(scripted)]) as Obj;
      expect(contract.ok).toBe(false);
      expect(JSON.stringify(contract)).toContain(scripted.expect.code);
    });
  }

  test('paths are safe and carry the declared extension', () => {
    for (const good of ['a', 'dir/a', 'dir/a.note', 'A.NOTE', ' padded ']) expect(targetPath(good, '.note').ok, good).toBe(true);
    expect(targetPath('dir/a', '.note')).toEqual({ ok: true, path: 'dir/a.note' });
    expect(targetPath('A.NOTE', '.note')).toEqual({ ok: true, path: 'A.NOTE' });
    for (const bad of ['', '..', '../a', 'a/../b', '/abs', 'C:/a', 'c:a', 'a\\b', 'a//b', './a', 'a/', 'CON', 'dir/nul.note', 'a.sql', 'a?', 'a\0b', 'trailing.']) {
      expect(targetPath(bad, '.note'), JSON.stringify(bad)).toEqual({ ok: false, code: 'InvalidShape' });
    }
    expect(validRelative('templates/empty.note', MAX_TEMPLATE_PATH)).toBe(true);
    expect(validRelative('a'.repeat(MAX_PATH + 1), MAX_PATH)).toBe(false);
  });

  for (const scripted of cases.flows as Obj[]) {
    test(`flow: ${scripted.id}`, async () => {
      const r = rig(scripted.existing ?? []);
      r.state.grant = scripted.grant ?? true; r.state.editorsGone = scripted.editorsGone ?? scripted.editorGone ?? false; r.state.templateMissing = scripted.templateMissing ?? false;
      r.disk.stale = scripted.staleProject ?? false;
      const before = new Map(r.disk.files);
      const answer = await r.flow.handle(r.editors, { op: 'create', projectId: 'p1', item: scripted.item, name: scripted.name, editor: scripted.choice ?? null });
      const expected = scripted.expect as Obj;
      if (expected.ok) {
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
        expect({ path: answer.path, editor: answer.editor, reason: answer.reason, bytes: answer.bytes }).toEqual({ path: expected.path, editor: expected.editor, reason: expected.reason, bytes: expected.bytes });
        expect(normalize(decoder.decode(r.disk.files.get(expected.path)!))).toBe(expected.content);
        expect(r.editors.buffer('p1', expected.path)?.encoding).toBe(expected.encoding);
        expect(r.audit().at(-1)).toMatchObject({ action: 'new-file', owner: OWNER, projectId: 'p1', path: expected.path, editor: expected.editor });
        expect(JSON.stringify(r.audit())).not.toContain('New note');
      } else {
        expect({ ok: answer.ok, code: answer.code, what: answer.what }).toEqual(expected);
        expect([...r.disk.files.entries()], 'a refusal creates nothing and never overwrites').toEqual([...before.entries()]);
      }
    });
  }

  for (const scripted of cases.reveals as Obj[]) {
    test(`reveal: ${scripted.id}`, async () => {
      const r = rig();
      for (const [path, text] of Object.entries(scripted.files as Record<string, string>)) r.disk.files.set(path, encoder.encode(text));
      r.state.dynamic = scripted.dynamic ?? true; r.state.editorsGone = scripted.editorGone ?? false;
      const answer = await r.flow.handle(r.editors, { op: 'reveal', projectId: 'p1', path: scripted.path, editor: scripted.editor ?? null }, OWNER);
      const expected = scripted.expect as Obj;
      if (expected.ok) {
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
        expect({ editor: answer.editor, reason: answer.reason }).toEqual({ editor: expected.editor, reason: expected.reason });
        expect(decoder.decode(r.disk.files.get(scripted.path)!)).toBe(scripted.files[scripted.path]);
      } else {
        expect({ ok: answer.ok, code: answer.code, what: answer.what }).toEqual(expected);
      }
    });
  }

  test('the host-owned buffer is shared: a revealed file joins the window that created it', async () => {
    const r = rig();
    const created = await r.flow.create(r.editors, 'p1', 'sample.notes/note', 'notes/today');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    r.editors.editBuiltin('p1', created.path, { text: '# New note\n\nunsaved' });
    const opened = await r.flow.reveal(r.editors, OWNER, 'p1', created.path, 'sample.notes/plain', 'inspector');
    expect(opened.ok).toBe(true);
    const buffer = r.editors.buffer('p1', created.path)!;
    expect(buffer.dirty).toBe(true);
    expect(buffer.snapshot().content).toEqual({ text: '# New note\n\nunsaved' });
    expect(r.editors.mounts('p1', created.path).map(mount => [mount.editor, mount.placement])).toEqual([['sample.notes/note', 'window'], ['sample.notes/plain', 'inspector']]);
  });

  test('create, edit, save, disable the package and reopen: the saved text is intact and the built-in editor shows it', async () => {
    const r = rig();
    const created = await r.flow.create(r.editors, 'p1', 'sample.notes/note', 'notes/today');
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(created.editor).toBe('sample.notes/note');
    expect(r.editors.editBuiltin('p1', created.path, { text: '# New note\n\nedited' })).toBeTruthy();
    expect(await r.editors.save('p1', created.path, 'user')).toMatchObject({ ok: true });
    expect(decoder.decode(r.disk.files.get(created.path)!)).toBe('# New note\n\nedited');
    // The package is disabled (or PandaCode starts in safe mode) and the app restarts: a new registry over the same disk.
    r.state.editorsGone = true;
    const restarted = rig([], r.disk);
    restarted.state.editorsGone = true;
    const reopened = await restarted.flow.reveal(restarted.editors, null, 'p1', created.path);
    expect(reopened).toMatchObject({ ok: true, editor: BUILTIN, reason: 'selected' });
    expect(restarted.editors.buffer('p1', created.path)?.snapshot().content).toEqual({ text: '# New note\n\nedited' });
    // With the package back, the same file opens in its default editor again, over the same content.
    const back = rig([], r.disk);
    expect(await back.flow.reveal(back.editors, null, 'p1', created.path)).toMatchObject({ ok: true, editor: 'sample.notes/note' });
  });

  test('a revoked grant keeps an existing file and gives the built-in editor over the same buffer', async () => {
    const r = rig();
    const created = await r.flow.create(r.editors, 'p1', 'sample.notes/note', 'notes/today');
    if (!created.ok) throw new Error(JSON.stringify(created));
    r.state.grant = false;
    expect(r.editors.grantsChanged().map(mount => mount.failure)).toEqual(['grant-revoked']);
    expect(await r.flow.create(r.editors, 'p1', 'sample.notes/note', 'other')).toMatchObject({ ok: false, code: 'PermissionDenied', what: 'grant' });
    expect(r.flow.menu('p1')).toEqual([]);
    expect(decoder.decode(r.disk.files.get(created.path)!)).toBe(decoder.decode(read('templates/empty.note')));
  });

  test('the menu lists granted items, ordered, each labelled with its package', () => {
    const r = rig();
    expect(r.flow.menu('p1').map(item => [item.id, item.package])).toEqual([['sample.notes/blank', 'Notes'], ['sample.notes/data', 'Notes'], ['sample.notes/note', 'Notes']]);
  });

  test('a request without a project or an operation is an explicit InvalidShape', async () => {
    const r = rig();
    for (const request of [{}, { op: 'create' }, { op: 'create', projectId: 'p1' }, { op: 'reveal', projectId: 'p1' }, { op: 'nothing', projectId: 'p1' }]) {
      expect(await r.flow.handle(r.editors, request as never)).toEqual({ ok: false, code: 'InvalidShape', what: 'request' });
    }
  });
});
