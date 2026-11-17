import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { mergeLayer, type Layer } from '../src/extensions/runtime-dynamic-items';
import { LOCATION, MAX_BUTTONS, MAX_HEIGHT, MAX_SHOWN, MIN_HEIGHT, PERMISSION, arrange, bandSegments, checkItem, checkView, clickContext, menuRows, stepPlacement, viewHeight, type Granted } from '../src/extensions/runtime-composer-band';
import type { ExtensionSnapshot } from '../src/extensions/manager';

// Preview column of R1001 (a live, task-scoped composer band). The groups run the deterministic model in
// src/extensions/runtime-composer-band.ts, which mirrors src-tauri/src/extensions/runtime_composer_band.rs (whose own unit tests
// are `runtime_composer_band::tests`). A real service answering through the broker and the native rich panel in the installed
// app are reported in their own columns: this file claims only the preview and model column.
//
// Refusal-test reconciliation (Q002, Q003, Q004, Q047, Q095, Q096, Q097, Q127): the composer rows these tests protect refuse a
// package any control of the composer itself (mode, model, effort, team, send, stop, approve, deny, the draft and the protected
// location). This slice delivers one new permissioned thing, the band (`ui.presentation`), and it carries no composer control,
// so no composer assertion changes. Each refusal is retained, with its non-security reason:
// - a forged overlay still cannot hide the draft or another protected control: the band's hide and order apply to band segments
//   only, and a band id is not a composer control id (predictability: the composer must stay usable);
// - send, stop and approvals are never reachable from the band: a band click runs an owned command with the captured task and
//   project and never the draft (the draft and the approval flow are host state, not package state);
// - the band module never imports the bridge or names a send, stop or approval command (asserted below as a source check).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const load = (path: string) => JSON.parse(read(`tests/fixtures/extensions/runtime-composer-band/${path}`));
const fixtures = { usage: load('extension.json'), rich: load('rich/extension.json'), plain: load('plain/extension.json'), second: load('second/extension.json') };
const fixtureSource = read('tests/fixtures/extensions/runtime-composer-band/main.cjs');
const moduleSource = read('src/extensions/runtime-composer-band.ts');

const snapshot = (manifests: unknown[], options: { safeMode?: boolean; enabled?: (id: string) => boolean } = {}): ExtensionSnapshot => ({
  safeMode: options.safeMode ?? false, diagnostics: [],
  packages: manifests.map(manifest => ({ manifest, enabled: options.enabled ? options.enabled((manifest as { id: string }).id) : true, icons: {} })),
} as unknown as ExtensionSnapshot);
const everyone: Granted = () => true;
const keys = (snap: ExtensionSnapshot, granted: Granted = everyone) => bandSegments(snap, granted).map(segment => segment.key);
const clone = <T>(value: T): T => structuredClone(value);

test('extensions runtime composer band: the four fixture packages validate, declare the grant and the usage service uses its calls', () => {
  for (const manifest of Object.values(fixtures)) {
    expect(manifest.permissions, manifest.id).toContain(PERMISSION);
    expect(validateContract('packages', [manifest]).ok, manifest.id).toBe(true);
  }
  expect(fixtures.usage.permissions).toEqual(expect.arrayContaining(['runtime.service', 'ui.dynamic']));
  expect(fixtures.rich.permissions).toContain('ui.richViews');
  for (const call of ['panda.ui.register', 'panda.ui.update', 'scope: { taskId', 'dispose()', 'sample.band-usage/control']) expect(fixtureSource, call).toContain(call);
  expect(fixtureSource).not.toMatch(/credentials\.|secrets\./);
});

test('extensions runtime composer band: a band item is a status with at most three command buttons and a band view is 24 to 96 px without placement', () => {
  const item = clone(fixtures.usage.contributes.menus[0]);
  expect(item.items).toHaveLength(MAX_BUTTONS);
  expect(checkItem(item)).toBeNull();
  expect(checkItem({ ...item, presentation: 'button' })).toBe('InvalidShape');
  expect(checkItem({ ...item, items: [...item.items, { id: 'sample.band-usage/band-more', kind: 'command', title: 'More', command: 'sample.band-usage/open' }] })).toBe('LimitExceeded');
  expect(checkItem({ ...item, items: [{ id: 'sample.band-usage/sep', kind: 'separator' }] })).toBe('InvalidShape');
  // An item of another location is not judged by the band rules.
  expect(checkItem({ ...item, location: 'panda.status.items', presentation: 'button' })).toBeNull();

  const view = clone(fixtures.rich.contributes.views[0]);
  expect([MIN_HEIGHT, MAX_HEIGHT]).toEqual([24, 96]);
  for (const height of [24, 48, 96]) expect(checkView({ ...view, rich: { ...view.rich, minSize: { width: 160, height } } }), String(height)).toBeNull();
  for (const height of [23, 97, 160]) expect(checkView({ ...view, rich: { ...view.rich, minSize: { width: 160, height } } }), String(height)).toBe('InvalidShape');
  expect(checkView({ ...view, rich: { ...view.rich, placement: 'inspector' } })).toBe('InvalidShape');
  // Outside the band the inspector minimum stays 160.
  expect(checkView({ ...view, location: 'panda.inspector.views' })).toBe('InvalidShape');
  expect(checkView({ ...view, location: 'panda.inspector.views', rich: { ...view.rich, minSize: { width: 160, height: 160 } } })).toBeNull();
  expect(checkView({ ...view, location: 'panda.nowhere' })).toBe('InvalidShape');
  expect(viewHeight({ rich: { minSize: { height: 500 } } })).toBe(MAX_HEIGHT);
  expect(viewHeight({ rich: { minSize: { height: 4 } } })).toBe(MIN_HEIGHT);
  // The schema and both semantic validators agree with the model.
  expect(validateContract('packages', [{ ...fixtures.rich, contributes: { views: [{ ...view, rich: { ...view.rich, minSize: { width: 160, height: 200 } } }] } }]).ok).toBe(false);
  expect(validateContract('packages', [{ ...fixtures.usage, contributes: { ...fixtures.usage.contributes, menus: [{ ...item, items: [...item.items, { id: 'sample.band-usage/band-more', kind: 'command', title: 'More', command: 'sample.band-usage/open' }] }] } }]).ok).toBe(false);
});

test('extensions runtime composer band: three segments are drawn, the rest fold into a menu with every frozen field', () => {
  const snap = snapshot([fixtures.usage, fixtures.rich, fixtures.plain, fixtures.second]);
  const segments = bandSegments(snap, everyone);
  expect(segments.map(segment => segment.owner)).toEqual(['sample.band-usage', 'sample.band-rich', 'sample.band-plain', 'sample.band-second']);
  const [usage, rich] = segments;
  expect(usage).toMatchObject({ kind: 'status', text: 'Usage 0%', tone: 'neutral', progress: 0, command: 'sample.band-usage/open', icon: 'chart', label: 'Usage band', tooltip: 'Usage band: Tokens used by this task' });
  expect(usage.buttons.map(button => button.title)).toEqual(['Pause', 'Resume', 'Reset']);
  expect(rich).toMatchObject({ kind: 'view', height: 48 });
  const arranged = arrange(segments, { order: ids => ids, hidden: () => false });
  expect(arranged.shown).toHaveLength(MAX_SHOWN);
  expect(arranged.overflow.map(segment => segment.owner)).toEqual(['sample.band-second']);
  const rows = menuRows(arranged);
  expect(rows[0]).toEqual({ id: 'open:sample.band-second/band', label: 'Second band: Second' });
  expect(rows.every(row => row.id.includes(':') || row.id === 'restore')).toBe(true);
  // One segment per package, even when it declares several: the view wins, else the first valid status item.
  const crowded = clone(fixtures.plain);
  crowded.contributes.menus.push({ ...crowded.contributes.menus[0], id: 'sample.band-plain/other', text: 'Other' });
  expect(bandSegments(snapshot([crowded]), everyone).map(segment => segment.text)).toEqual(['Plain']);
  // A segment's text and a hidden `visible: false` item are respected; more than three buttons never reach the row.
  const quiet = clone(fixtures.plain);
  quiet.contributes.menus[0].visible = false;
  expect(bandSegments(snapshot([quiet]), everyone)).toEqual([]);
});

test('extensions runtime composer band: hide, reorder and restore apply to segments and the keyboard menu offers each step', () => {
  const snap = snapshot([fixtures.usage, fixtures.rich, fixtures.plain, fixtures.second]);
  const segments = bandSegments(snap, everyone);
  const byKey = (...order: string[]) => (ids: string[]) => [...order.filter(key => ids.includes(key)), ...ids.filter(key => !order.includes(key))];
  const second = 'sample.band-second/band', usage = 'sample.band-usage/band';
  const ordered = arrange(segments, { order: byKey(second), hidden: () => false });
  expect(ordered.shown[0].key).toBe(second);
  expect(ordered.overflow.map(segment => segment.key)).toEqual(['sample.band-plain/band']);
  const hidden = arrange(segments, { order: ids => ids, hidden: id => id === usage });
  expect(hidden.hidden.map(segment => segment.key)).toEqual([usage]);
  expect(hidden.shown.map(segment => segment.key)).not.toContain(usage);
  expect(hidden.shown).toHaveLength(MAX_SHOWN);
  const rows = menuRows(hidden).map(row => row.id);
  expect(rows).toContain(`show:${usage}`);
  expect(rows).toContain(`hide:${second}`);
  expect(rows).not.toContain(`earlier:${hidden.shown[0].key}`);
  const visible = [...hidden.shown, ...hidden.overflow].map(segment => segment.key);
  expect(stepPlacement(visible, visible[1], 'earlier')).toEqual({ id: visible[1], target: visible[0], side: 'before' });
  expect(stepPlacement(visible, visible[0], 'earlier')).toBeNull();
  expect(stepPlacement(visible, visible[visible.length - 1], 'later')).toBeNull();
  // Restore puts everything back in the built-in order.
  const restored = arrange(segments, { order: ids => ids, hidden: () => false });
  expect(restored.hidden).toEqual([]);
  expect(restored.shown.map(segment => segment.key)).toEqual(segments.slice(0, MAX_SHOWN).map(segment => segment.key));
});

test('extensions runtime composer band: an item scoped to a task shows only while that task is in view and follows the service', () => {
  const base = snapshot([fixtures.usage]);
  const layer = (text: string, progress: number): Layer => ({ revision: 1, owners: { 'sample.band-usage': { menus: [{ id: 'sample.band-usage/task-band', location: LOCATION, command: 'sample.band-usage/open', presentation: 'status', text, tone: 'info', progress, scope: { taskId: 'T1' } }], commands: [], views: [], slashCommands: [], overrides: { 'sample.band-usage/band': { text: `Usage ${progress}%`, progress } } } } });
  const forTask = (taskId: string | null, source: Layer | null) => mergeLayer(base, source, { taskId, projectId: 'P' });
  // Task T1: the manifest item with its override, and the scoped item, which is another segment key of the same package.
  const inT1 = forTask('T1', layer('This task: 40%', 40)).packages[0].manifest.contributes.menus as { id: string; text?: string; progress?: number }[];
  expect(inT1.map(menu => menu.id)).toEqual(['sample.band-usage/band', 'sample.band-usage/header', 'sample.band-usage/task-band']);
  expect(inT1[0]).toMatchObject({ text: 'Usage 40%', progress: 40 });
  // Task T2: the scoped item is not part of the snapshot, so the band shows only the package's manifest segment.
  const inT2 = forTask('T2', layer('This task: 40%', 40)).packages[0].manifest.contributes.menus as { id: string }[];
  expect(inT2.map(menu => menu.id)).not.toContain('sample.band-usage/task-band');
  // A service event changes the progress and the text of what the band reads; with no layer the manifest values return.
  expect(bandSegments(forTask('T1', layer('This task: 90%', 90)), everyone)[0]).toMatchObject({ text: 'Usage 90%', progress: 90 });
  expect(bandSegments(forTask('T1', null), everyone)[0]).toMatchObject({ text: 'Usage 0%', progress: 0 });
  // The click hands the captured task and project, never the draft, and the item's own arguments once.
  expect(clickContext({ project: 'P', task: 'T1', generation: 4 }, { build: 41 })).toEqual({ schemaVersion: 1, windowId: 'main', surfaceId: LOCATION, revision: 4, projectId: 'P', sessionId: 'T1', args: { build: 41 } });
  expect(clickContext({ generation: 1 })).toEqual({ schemaVersion: 1, windowId: 'main', surfaceId: LOCATION, revision: 1 });
});

test('extensions runtime composer band: revoke, disable and safe mode remove the band and nothing else', () => {
  const all = [fixtures.usage, fixtures.rich, fixtures.plain, fixtures.second];
  expect(keys(snapshot(all))).toHaveLength(4);
  expect(keys(snapshot(all), (owner) => owner !== 'sample.band-plain')).not.toContain('sample.band-plain/band');
  expect(keys(snapshot(all), () => false)).toEqual([]);
  expect(keys(snapshot(all, { enabled: id => id !== 'sample.band-rich' }))).not.toContain('sample.band-rich/band');
  expect(keys(snapshot(all, { safeMode: true }))).toEqual([]);
  // A package that never declared the permission shows nothing even when the host would grant it.
  const undeclared = clone(fixtures.plain);
  undeclared.permissions = ['ui.contribute'];
  expect(keys(snapshot([undeclared]))).toEqual([]);
});

test('extensions runtime composer band: the band never touches the composer, is styled from an always-loaded stylesheet and is wired once', () => {
  // Source ownership (Q047, Q127): no send, stop, approval or bridge access, and no lazily imported stylesheet.
  for (const forbidden of ['send_message', 'stop_session', 'respond_approval', 'respond_user_input', "from '../bridge'", '.css\'', '#prompt']) expect(moduleSource, forbidden).not.toContain(forbidden);
  const css = read('src/extensions/extensions.css');
  for (const selector of ['.composer-band', '.composer-band-segment', '.composer-band-progress-fill', '.composer-band-view']) expect(css, selector).toContain(selector);
  expect(css).not.toMatch(/composer-band[^{]*\{[^}]*#[0-9a-fA-F]{3,6}\b/);
  expect(css).not.toMatch(/composer-band[^{]*\{[^}]*(transition:[^;]*(width|height|top|left)|backdrop-filter)/);
  expect(read('src/main.ts')).toContain('runtime-composer-band');
  expect(read('src/extensions/surfaces.ts')).toContain(LOCATION);
  expect(read('src/extensions/schema-v1.json')).toContain(LOCATION);
});
