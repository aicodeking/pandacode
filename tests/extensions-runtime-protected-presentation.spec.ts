import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { DIALOG_EXTRAS, MAIN_DIALOG_PROTECTED, OWNED_DIALOG_PROTECTED, dialogTarget } from '../src/extensions/surfaces';
import { isEligibleDialog } from '../src/extensions/dialog-accessory';
import {
  agrees, BUILT_IN_ONLY, EXTRA_BUDGET_MS, EXTRA_DIALOGS, isolate, lines, MAX_DIALOG_NOTES, omittedLine, OWNER_ONLY, PERMISSION, policy,
  reconcile, requiredPermissions, row, visible, type Contribution, type Resolution,
} from '../src/extensions/runtime-protected-presentation';
// Preview column of R1003 (attributed hook notes on tool and approval rows, extras in eight formerly protected dialogs). The notes
// and the dialog rules are pure, so this spec runs in the test runner's Node: it checks the webview twin
// (src/extensions/runtime-protected-presentation.ts) of the native module (src-tauri/src/extensions/runtime_protected_presentation.rs,
// whose tests read the same cases.json), the registry and the schema the dialogs are admitted through. The drawn band in an open
// dialog (accessibility, Enter and Escape, disabling during an open extra) and the installed-app column are pending, not claimed.
const fixtures = new URL('./fixtures/extensions/runtime-protected-presentation/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const plain = read('no-grant.json');
const cases = read('cases.json');
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
type Obj = Record<string, any>;

function contributionsOf(scripted: Obj): Contribution[] {
  const own = (scripted.contributions ?? []) as Contribution[];
  if (!scripted.fill) return own;
  const filled = Array.from({ length: scripted.fill.count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return { owner: `sample.n${n}`, name: `Pkg ${n}`, id: `sample.n${n}/note`, dialog: scripted.dialog, text: `note ${n}`, permissions: scripted.fill.permissions, enabled: true } as Contribution;
  });
  return [...own, ...filled];
}

test.describe('extensions protected presentation: R1003 attributed notes and protected-dialog extras', () => {
  test('the eight dialogs are extras, github-behind stays built-in and extension-form stays owner-only', () => {
    expect(EXTRA_DIALOGS.map(([id]) => id)).toEqual(['remove-project', 'delete-task', 'delete-bot', 'delete-cloud', 'worktree-cleanup', 'provider-connections', 'machine-link', 'skill-add']);
    expect([...BUILT_IN_ONLY]).toEqual(['github-behind']);
    expect([...OWNER_ONLY]).toEqual(['extension-form']);
    expect(cases.limits).toMatchObject({ notes: MAX_DIALOG_NOTES, budgetMs: EXTRA_BUDGET_MS });
  });

  for (const scripted of cases.policy as Obj[]) {
    test(`policy: ${scripted.dialog} is ${scripted.policy}`, () => {
      expect(policy(scripted.dialog)).toBe(scripted.policy);
      expect(requiredPermissions(scripted.dialog)).toEqual(scripted.required);
    });
  }

  test('the registry and the schema admit exactly the eight and keep the two exceptions', () => {
    const ids = (schema.$defs.mainDialogId.enum as string[]);
    for (const [dialog, target] of EXTRA_DIALOGS) {
      expect(ids, dialog).toContain(dialog);
      expect(isEligibleDialog(dialog), dialog).toBe(true);
      expect(DIALOG_EXTRAS.some(([id]) => id === dialog), dialog).toBe(true);
      expect(dialogTarget(dialog), dialog).toBe(target);
    }
    for (const dialog of BUILT_IN_ONLY) { expect(isEligibleDialog(dialog)).toBe(false); expect(MAIN_DIALOG_PROTECTED.some(([id]) => id === dialog)).toBe(true); expect(ids).not.toContain(dialog); }
    for (const dialog of OWNER_ONLY) { expect(isEligibleDialog(dialog)).toBe(false); expect(OWNED_DIALOG_PROTECTED.some(([id]) => id === dialog)).toBe(true); expect(ids).not.toContain(dialog); }
    expect(MAIN_DIALOG_PROTECTED.map(([id]) => id)).toEqual(['github-behind']);
    expect(OWNED_DIALOG_PROTECTED.map(([id]) => id)).toEqual(['extension-form']);
  });

  test('a package with ui.presentation may name each of the eight; without it the manifest is refused; the two exceptions are refused for all', () => {
    expect(manifest.permissions).toContain(PERMISSION);
    expect(manifest.contributes.dialogExtras.map((extra: Obj) => extra.dialog)).toEqual(EXTRA_DIALOGS.map(([id]) => id));
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    const refused = validateContract('packages', [plain]) as Obj;
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('PermissionDenied');
    for (const dialog of ['github-behind', 'extension-form']) {
      const forged = structuredClone(manifest) as Obj;
      forged.contributes.dialogExtras = [{ id: 'sample.protected-notes/x', dialog, text: 'No.' }];
      expect((validateContract('packages', [forged]) as Obj).ok, dialog).toBe(false);
    }
  });

  for (const scripted of cases.visible as Obj[]) {
    test(`notes: ${scripted.id}`, () => {
      const shown = visible(contributionsOf(scripted), scripted.dialog, scripted.safeMode, scripted.order ?? [], scripted.formOwner);
      if (scripted.expect.ids) expect(shown.notes.map(note => note.id)).toEqual(scripted.expect.ids);
      if (scripted.expect.lines) expect(shown.notes.map(note => `${note.name}: ${note.text}`)).toEqual(scripted.expect.lines);
      if (scripted.expect.count !== undefined) expect(shown.notes).toHaveLength(scripted.expect.count);
      expect(shown.omitted).toBe(scripted.expect.omitted);
      expect(omittedLine(shown)).toBe(scripted.expect.omittedLine ?? null);
    });
  }

  test('disabling, revoking or safe mode clears the extras at the next draw and enabling brings them back', () => {
    const base: Contribution = { owner: 'sample.protected-notes', name: 'Protected notes', id: 'sample.protected-notes/delete-task', dialog: 'delete-task', text: 'Hello.', permissions: ['ui.contribute', 'ui.presentation'], enabled: true };
    expect(visible([base], 'delete-task', false).notes).toHaveLength(1);
    expect(visible([{ ...base, enabled: false }], 'delete-task', false).notes).toHaveLength(0);
    expect(visible([{ ...base, permissions: ['ui.contribute'] }], 'delete-task', false).notes).toHaveLength(0);
    expect(visible([base], 'delete-task', true).notes).toHaveLength(0);
    expect(visible([base], 'delete-task', false).notes).toHaveLength(1);
  });

  for (const scripted of cases.rows as Obj[]) {
    test(`row: ${scripted.id}`, () => {
      const source = row(scripted.resolution as Resolution, scripted.notes);
      expect(source.kind).toBe(scripted.expect.kind);
      expect(source.decider?.owner ?? null).toBe(scripted.expect.decidedBy);
      expect(agrees(source, scripted.decidedBy)).toBe(scripted.expect.agrees);
      expect(lines(source, scripted.tool)).toEqual(scripted.expect.lines);
      if (scripted.expect.reconciledKind) {
        const kept = reconcile(source, scripted.decidedBy);
        expect(kept.kind).toBe(scripted.expect.reconciledKind);
        expect(kept.decider).toBeNull();
        expect(lines(kept, scripted.tool)).toEqual(scripted.expect.reconciledLines);
        expect(agrees(kept, null)).toBe(true);
      } else expect(reconcile(source, scripted.decidedBy)).toEqual(source);
    });
  }

  test('a slow or broken extra becomes a code and the host decision is untouched', async () => {
    const decision = { approved: false, decidedBy: 'sample.guard' };
    const before = structuredClone(decision);
    expect(await isolate(() => 7, 200)).toEqual({ ok: true, value: 7 });
    expect(await isolate(() => new Promise<number>(resolve => setTimeout(() => resolve(1), 400)), 40)).toEqual({ ok: false, code: 'Timeout' });
    expect(await isolate(() => { throw new Error('broken extra'); }, 200)).toEqual({ ok: false, code: 'Failed' });
    expect(await isolate(() => Promise.reject(new Error('broken extra')), 200)).toEqual({ ok: false, code: 'Failed' });
    expect(decision).toEqual(before);
  });
});
