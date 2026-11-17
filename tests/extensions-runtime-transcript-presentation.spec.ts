import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { DraftModel, PERMISSION as DRAFT_PERMISSION } from '../src/extensions/runtime-tasks-drafts';
import {
  CONVERSATION_CAPABILITIES, MAX_FRAMES, MAX_FRAME_CHARS, MAX_INTERVAL_MS, MAX_OPACITY, MAX_PRESENTATIONS, MIN_FRAMES, MIN_INTERVAL_MS, PERMISSION, SELECTION_KEY,
  checkAll, checkConversationProvider, checkPresentation, choose, conversationAllowed, frameIndex, menuRows, offers, opacity, readSelection, resolveOffer, writeSelection, type Granted,
} from '../src/extensions/runtime-transcript-presentation';
import type { ExtensionSnapshot } from '../src/extensions/manager';

// Preview and model column of R1002 (conversation-only transcript, selectable working indicator and backdrop, ghost text). The
// groups run the deterministic model in src/extensions/runtime-transcript-presentation.ts, which mirrors
// src-tauri/src/extensions/runtime_transcript_presentation.rs (whose own unit tests are `runtime_transcript_presentation::tests`).
// The page group runs the mounted interface in the preview. Native panels behind the thread and the installed app are reported
// in their own columns: this file claims only the preview and model column.
//
// Refusal-test reconciliation (Q061, Q126). The assertions these rows protect belong to the closed `timeline` recipe: a transcript
// replacement needs `tasks.transcript.read` and `tasks.tools.read`, otherwise the text is "content redacted (... not granted)", and
// `respond_approval` and `send_message` are never reachable from it. This slice adds a second recipe, `conversation`, which
// delivers no transcript or tool content to the package at all (the host hides the tool steps itself), so its one permission is
// `ui.presentation`. The permissioned assertions that change are the new `conversation` ones below (granted shows it, missing or
// revoked restores the built-in thread). Every `timeline` refusal is retained unchanged, with its non-security reason:
// - the `timeline` recipe still names the two read permissions, because a package that chooses to draw the history from its own
//   content must be able to read it (a stable, declared contract rather than a withheld capability);
// - the unauthorized, stale and foreign-owner denials of `extensions-replacement.test.mjs` and `extensions-transcript-conformance.spec.ts`
//   (a function renderer, `html` presentation, a recovery mid-stream) keep predictability: the host transcript must keep working
//   whatever a package does, and approvals and sending stay host-owned (asserted below as a source check).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const load = (path: string) => JSON.parse(read(`tests/fixtures/extensions/runtime-transcript-presentation/${path}`));
const look = load('look/extension.json'), bad = load('bad/extension.json');
const sky = read('tests/fixtures/extensions/runtime-transcript-presentation/look/assets/sky.svg');
const moduleSource = read('src/extensions/runtime-transcript-presentation.ts');
const clone = <T>(value: T): T => structuredClone(value);

const snapshot = (manifests: unknown[], options: { safeMode?: boolean; enabled?: boolean } = {}): ExtensionSnapshot => ({
  safeMode: options.safeMode ?? false, diagnostics: [],
  packages: manifests.map(manifest => ({ manifest, enabled: options.enabled ?? true, icons: { 'sample.look/sky-art': sky } })),
} as unknown as ExtensionSnapshot);
const everyone: Granted = () => true;
const views = look.contributes.views.map((view: { id: string }) => view.id), assets = look.contributes.icons.map((icon: { asset: string }) => icon.asset);
const [dots, bar, night, aurora] = look.contributes.presentations;

test('extensions runtime transcript presentation: the fixture validates and the bad one is refused with a frozen code', () => {
  expect(look.permissions).toContain(PERMISSION);
  expect(validateContract('packages', [look]).ok).toBe(true);
  expect(validateContract('packages', [bad]).ok).toBe(false);
  expect(look.contributes.presentations.map((item: { kind: string }) => item.kind)).toEqual(['working-indicator', 'working-indicator', 'backdrop', 'backdrop']);
  expect(look.contributes.components[0]).toMatchObject({ slot: 'panda.transcript', presentation: 'conversation' });
});

test('extensions runtime transcript presentation: an indicator has two to sixteen short frames 80 to 1000 ms apart', () => {
  expect([MIN_FRAMES, MAX_FRAMES, MAX_FRAME_CHARS, MIN_INTERVAL_MS, MAX_INTERVAL_MS]).toEqual([2, 16, 16, 80, 1000]);
  expect(checkPresentation(dots, views, assets)).toBeNull();
  expect(checkPresentation({ ...dots, frames: ['·'] }, views, assets)).toBe('LimitExceeded');
  expect(checkPresentation({ ...dots, frames: Array.from({ length: 17 }, (_, n) => String(n)) }, views, assets)).toBe('LimitExceeded');
  expect(checkPresentation({ ...dots, frames: ['a', 'a'.repeat(17)] }, views, assets)).toBe('LimitExceeded');
  expect(checkPresentation({ ...dots, frames: ['a', ''] }, views, assets)).toBe('LimitExceeded');
  for (const ms of [79, 1001]) expect(checkPresentation({ ...dots, intervalMs: ms }, views, assets), String(ms)).toBe('LimitExceeded');
  for (const ms of [80, 1000]) expect(checkPresentation({ ...dots, intervalMs: ms }, views, assets), String(ms)).toBeNull();
  expect(checkPresentation({ ...dots, intervalMs: 'fast' }, views, assets)).toBe('InvalidShape');
  // The schema and both semantic validators agree with the model.
  for (const frames of [['·'], Array.from({ length: 17 }, (_, n) => String(n)), ['a', 'a'.repeat(17)]]) {
    const manifest = clone(look); manifest.contributes.presentations = [{ ...dots, frames }];
    expect(validateContract('packages', [manifest]).ok, JSON.stringify(frames)).toBe(false);
  }
  for (const intervalMs of [79, 1001]) {
    const manifest = clone(look); manifest.contributes.presentations = [{ ...dots, intervalMs }];
    expect(validateContract('packages', [manifest]).ok, String(intervalMs)).toBe(false);
  }
});

test('extensions runtime transcript presentation: a backdrop names one source and an opacity up to one half; no literal accent is added', () => {
  expect(MAX_OPACITY).toBe(0.5);
  expect(checkPresentation(night, views, assets)).toBeNull();
  expect(checkPresentation(aurora, views, assets)).toBeNull();
  for (const value of [0, 0.5]) expect(checkPresentation({ ...night, opacity: value }, views, assets), String(value)).toBeNull();
  for (const value of [0.51, -0.1, 1]) expect(checkPresentation({ ...night, opacity: value }, views, assets), String(value)).toBe('LimitExceeded');
  expect(checkPresentation({ ...night, opacity: '0.2' }, views, assets)).toBe('InvalidShape');
  expect(checkPresentation(night, views, [])).toBe('InvalidShape');
  expect(checkPresentation({ ...night, image: 'assets/sky.png' }, views, ['assets/sky.png'])).toBe('InvalidShape');
  expect(checkPresentation({ ...aurora, view: 'sample.look/other' }, views, assets)).toBe('InvalidShape');
  expect(checkPresentation({ ...aurora, image: 'assets/sky.svg' }, views, assets)).toBe('InvalidShape');
  const neither = clone(aurora); delete neither.view;
  expect(checkPresentation(neither, views, assets)).toBe('InvalidShape');
  expect(checkPresentation({ id: 'sample.look/x', kind: 'theme' }, views, assets)).toBe('InvalidShape');
  expect([opacity(0.2), opacity(0.9), opacity(-1), opacity('x')]).toEqual([0.2, 0.5, 0, 0]);
  for (const value of [0.51, -0.1]) {
    const manifest = clone(look); manifest.contributes.presentations = [{ ...night, opacity: value }];
    expect(validateContract('packages', [manifest]).ok, String(value)).toBe(false);
  }
  const css = read('src/extensions/extensions.css');
  for (const selector of ['.presentation-strip', '.presentation-indicator', '.presentation-backdrop']) expect(css, selector).toContain(selector);
  expect(css).not.toMatch(/presentation-[a-z-]*[^{]*\{[^}]*#[0-9a-fA-F]{3,6}\b/);
  expect(css).not.toMatch(/presentation-[a-z-]*[^{]*\{[^}]*(transition:[^;]*(width|height|top|left)|animation|backdrop-filter)/);
});

test('extensions runtime transcript presentation: the list is bounded to sixteen with unique ids', () => {
  expect(MAX_PRESENTATIONS).toBe(16);
  expect(checkAll(look.contributes.presentations, views, assets)).toBeNull();
  expect(checkAll([dots, dots], views, assets)).toBe('InvalidShape');
  const many = Array.from({ length: 17 }, (_, n) => ({ ...dots, id: `sample.look/p${n}` }));
  expect(checkAll(many, views, assets)).toBe('LimitExceeded');
  expect(checkAll(many.slice(0, 16), views, assets)).toBeNull();
});

test('extensions runtime transcript presentation: only granted, enabled, non-safe packages offer and nothing is chosen for the user', () => {
  const indicators = offers(snapshot([look]), 'working-indicator', everyone), backdrops = offers(snapshot([look]), 'backdrop', everyone);
  expect(indicators.map(offer => offer.key)).toEqual(['sample.look/dots', 'sample.look/bar']);
  expect(backdrops.map(offer => offer.key)).toEqual(['sample.look/sky', 'sample.look/aurora']);
  expect(indicators[0]).toMatchObject({ owner: 'sample.look', label: 'Conversation look', title: 'Dots' });
  // Without a choice the built-in presentation stays; a choice that is not offered any more falls back to it.
  expect(resolveOffer(indicators, undefined)).toBeUndefined();
  expect(resolveOffer(indicators, 'sample.look/bar')?.key).toBe('sample.look/bar');
  expect(resolveOffer(indicators, 'sample.look/gone')).toBeUndefined();
  expect(offers(snapshot([look]), 'backdrop', () => false)).toEqual([]);
  expect(offers(snapshot([look], { enabled: false }), 'backdrop', everyone)).toEqual([]);
  expect(offers(snapshot([look], { safeMode: true }), 'working-indicator', everyone)).toEqual([]);
  const undeclared = clone(look); undeclared.permissions = ['ui.contribute', 'ui.richViews'];
  expect(offers(snapshot([undeclared]), 'working-indicator', everyone)).toEqual([]);
  // An invalid entry is never offered, the rest still are.
  const mixed = clone(look); mixed.contributes.presentations.push({ ...dots, id: 'sample.look/short', frames: ['·'] });
  expect(offers(snapshot([mixed]), 'working-indicator', everyone).map(offer => offer.key)).not.toContain('sample.look/short');
});

test('extensions runtime transcript presentation: the choice is the user\'s, persists and restores the built-in presentation', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
  expect(readSelection(storage)).toEqual({});
  let selection = choose({}, 'working-indicator', 'sample.look/dots');
  selection = choose(selection, 'backdrop', 'sample.look/sky');
  writeSelection(storage, selection);
  expect(readSelection(storage)).toEqual({ indicator: 'sample.look/dots', backdrop: 'sample.look/sky' });
  expect(JSON.parse(store.get(SELECTION_KEY)!)).toEqual({ indicator: 'sample.look/dots', backdrop: 'sample.look/sky' });
  // Choosing "Built-in" removes the entry; with nothing left the key is gone.
  selection = choose(choose(selection, 'working-indicator', ''), 'backdrop', '');
  writeSelection(storage, selection);
  expect(store.has(SELECTION_KEY)).toBe(false);
  store.set(SELECTION_KEY, '{ not json');
  expect(readSelection(storage)).toEqual({});
  // The menu marks the active choice, offers the built-in for each kind and is empty when nothing is offered.
  const indicators = offers(snapshot([look]), 'working-indicator', everyone), backdrops = offers(snapshot([look]), 'backdrop', everyone);
  const rows = menuRows(indicators, backdrops, { indicator: 'sample.look/bar' });
  expect(rows.map(row => row.id)).toEqual(['working-indicator:', 'working-indicator:sample.look/dots', 'working-indicator:sample.look/bar', 'backdrop:', 'backdrop:sample.look/sky', 'backdrop:sample.look/aurora']);
  expect(rows.filter(row => row.selected).map(row => row.id)).toEqual(['working-indicator:sample.look/bar', 'backdrop:']);
  expect(rows.find(row => row.id === 'backdrop:')?.separator).toBe(true);
  expect(menuRows([], [], {})).toEqual([]);
});

test('extensions runtime transcript presentation: reduced motion holds the first frame still', () => {
  const frames = ['a', 'b', 'c'];
  expect([0, 1, 2, 3, 4].map(tick => frameIndex(frames.length, tick, false))).toEqual([0, 1, 2, 0, 1]);
  expect([0, 1, 2, 3, 4].map(tick => frameIndex(frames.length, tick, true))).toEqual([0, 0, 0, 0, 0]);
  expect(frameIndex(0, 7, false)).toBe(0);
  // No CSS animation drives the indicator; the interface starts no timer at all with reduced motion.
  expect(moduleSource).toContain('if (!reduced) timer = setInterval');
  expect(moduleSource).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
});

test('extensions runtime transcript presentation: the conversation transcript needs ui.presentation, its capabilities and a granted package', () => {
  const provider = look.contributes.components[0];
  expect(CONVERSATION_CAPABILITIES).toEqual(['streaming', 'stop-resume', 'host-history']);
  expect(checkConversationProvider(provider)).toBeNull();
  expect(checkConversationProvider({ ...provider, capabilities: ['streaming', 'stop-resume'] })).toBe('InvalidShape');
  expect(checkConversationProvider({ ...provider, capabilities: [...provider.capabilities, 'teleport'] })).toBe('InvalidShape');
  expect(checkConversationProvider({ ...provider, presentation: 'timeline', capabilities: [] })).toBeNull();
  expect(validateContract('packages', [look]).ok).toBe(true);
  const noCapabilities = clone(look); noCapabilities.contributes.components[0].capabilities = ['streaming'];
  expect(validateContract('packages', [noCapabilities]).ok).toBe(false);
  expect(conversationAllowed(snapshot([look]), 'sample.look', everyone)).toBe(true);
  expect(conversationAllowed(snapshot([look]), 'sample.look', () => false)).toBe(false);
  expect(conversationAllowed(snapshot([look], { enabled: false }), 'sample.look', everyone)).toBe(false);
  expect(conversationAllowed(snapshot([look], { safeMode: true }), 'sample.look', everyone)).toBe(false);
  const undeclared = clone(look); undeclared.permissions = ['ui.contribute', 'ui.richViews'];
  expect(conversationAllowed(snapshot([undeclared]), 'sample.look', everyone)).toBe(false);
  expect(conversationAllowed(snapshot([look]), 'someone.else', everyone)).toBe(false);
});

test('extensions runtime transcript presentation: ghost text stays unsent and disappears when the draft, the task or the grant changes', () => {
  const model = new DraftModel();
  model.addTask('T1', 'P'); model.addTask('T2', 'P');
  model.show('main', 'T1');
  const checks = { holds: true, granted: () => true };
  expect(model.call('sample.look', checks, { op: 'suggest', windowId: 'main', text: ' and add tests' })).toMatchObject({ ok: true });
  expect(model.ghost('main')).toMatchObject({ owner: 'sample.look', text: ' and add tests' });
  expect(model.drafts.get('T1')!.text).toBe('');
  // Typing dismisses it, and nothing is sent.
  model.userType('T1', 'Fix the bug');
  expect(model.ghost('main')).toBeNull();
  model.call('sample.look', checks, { op: 'suggest', windowId: 'main', text: ' today' });
  // Showing another task takes the ghost text off the task it left.
  model.show('main', 'T2'); model.show('main', 'T1');
  expect(model.ghost('main')).toBeNull();
  // The user accepts it: it becomes draft text and still nothing is sent.
  model.call('sample.look', checks, { op: 'suggest', windowId: 'main', text: ' today' });
  expect(model.accept('main')).toBe(true);
  expect(model.drafts.get('T1')!.text).toBe('Fix the bug today');
  // A revoked grant and a stopped service clear it.
  model.call('sample.look', checks, { op: 'suggest', windowId: 'main', text: '!' });
  expect(model.sweep(() => false)).toBe(1);
  model.call('sample.look', checks, { op: 'suggest', windowId: 'main', text: '!' });
  expect(model.end('sample.look')).toBe(1);
  expect(model.sent).toEqual([]);
  expect(DRAFT_PERMISSION).toBe('tasks.draft');
});

test('extensions runtime transcript presentation: the module never sends, stops or approves, and is wired once and styled from an always-loaded stylesheet', () => {
  for (const forbidden of ['send_message', 'stop_session', 'respond_approval', 'respond_user_input', "from '../bridge'", '#prompt', '.css\'']) expect(moduleSource, forbidden).not.toContain(forbidden);
  expect(read('src/main.ts')).toContain('runtime-transcript-presentation');
  expect(read('src/extensions/replacement.ts')).toContain('conversation');
  expect(read('src/extensions/schema-v1.json')).toContain('"presentations"');
  expect(read('src/extensions/extensions.css')).toContain('component-conversation');
});

// ---- The mounted interface in the preview --------------------------------------------------------------------------------

type Seed = { manifest: unknown; enabled: boolean; icons: Record<string, string>; executable: { digest: string; trusted: boolean } };
const seed: Seed = { manifest: look, enabled: true, icons: { 'sample.look/sky-art': sky }, executable: { digest: 'preview-look', trusted: true } };

async function setup(page: Page, options: { reduced?: boolean; selection?: Record<string, string> } = {}) {
  await page.emulateMedia({ reducedMotion: options.reduced ? 'reduce' : 'no-preference' });
  await page.addInitScript(({ seed, selection }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([seed]));
    if (selection) localStorage.setItem('pandacode.extensions.presentation.v1', JSON.stringify(selection));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, { seed, selection: options.selection });
  await page.goto('/?extensions-baseline&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(() => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op: 'grant', id: 'sample.look', permission: 'ui.presentation' }));
}
async function running(page: Page) {
  await page.locator('#prompt').fill('Keep this recorded task running'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
}

test('extensions runtime transcript presentation: the user selects an indicator and it ticks, or holds the first frame with reduced motion', async ({ page }) => {
  await setup(page, { selection: { indicator: 'sample.look/dots' } });
  await running(page);
  const indicator = page.locator('[data-presentation-indicator]');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('aria-label', 'Conversation look is working');
  const seen = new Set<string | null>();
  await expect.poll(async () => { seen.add(await indicator.textContent()); return seen.size; }, { timeout: 5000 }).toBeGreaterThan(1);
});

test('extensions runtime transcript presentation: with reduced motion the first frame stays still', async ({ page }) => {
  await setup(page, { reduced: true, selection: { indicator: 'sample.look/dots' } });
  await running(page);
  const indicator = page.locator('[data-presentation-indicator]');
  await expect(indicator).toHaveText('·');
  await page.waitForTimeout(800);
  await expect(indicator).toHaveText('·');
});

test('extensions runtime transcript presentation: nothing changes until the user chooses and the Look menu is keyboard operable', async ({ page }) => {
  await setup(page);
  await expect(page.locator('[data-presentation-backdrop]')).toHaveCount(0);
  const picker = page.locator('[data-presentation-picker]');
  await expect(picker).toBeVisible();
  await picker.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: /Backdrop: Night sky/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Backdrop: Night sky/ }).click();
  const backdrop = page.locator('.presentation-backdrop');
  await expect(backdrop).toHaveCount(1);
  await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  expect(Number(await backdrop.evaluate(node => getComputedStyle(node).opacity))).toBeLessThanOrEqual(0.5);
  // Revoking the grant restores the built-in thread at once and leaves the selection alone.
  await page.evaluate(() => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op: 'revoke', id: 'sample.look', permission: 'ui.presentation' }));
  await expect(backdrop).toHaveCount(0);
  await expect(picker).toBeHidden();
});

test('extensions runtime transcript presentation: a panel backdrop is contained, never takes input and a removed one leaves the thread and the draft alone', async ({ page }) => {
  await setup(page, { selection: { backdrop: 'sample.look/aurora' } });
  await page.locator('#prompt').fill('Draft beside the backdrop');
  const backdrop = page.locator('.presentation-backdrop');
  await expect(backdrop).toHaveCount(1);
  expect(await backdrop.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  // The panel is torn down with the package: the thread, the draft and the composer are untouched.
  await page.evaluate(() => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op: 'revoke', id: 'sample.look', permission: 'ui.presentation' }));
  await expect(backdrop).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('Draft beside the backdrop');
  await expect(page.locator('#transcript')).toBeVisible();
  await expect(page.locator('#prompt')).toBeEnabled();
});
