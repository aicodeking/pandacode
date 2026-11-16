import { expect, test, type Page } from '@playwright/test';

type File = { path: string; index: string; working: string };

function patch(path: string, adds: number, dels: number): string {
  const lines = [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, `@@ -1,${dels + 1} +1,${adds + 1} @@`, ' const keep = true;'];
  for (let i = 0; i < dels; i++) lines.push(`-const removed${i} = ${i};`);
  for (let i = 0; i < adds; i++) lines.push(`+const added${i} = ${i};`);
  return `${lines.join('\n')}\n`;
}

async function mount(page: Page, files: File[], diffs: Record<string, string>, options: { hold?: boolean } = {}): Promise<void> {
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(({ files, diffs, hold }) => {
    const h = (window as any).harness;
    Object.assign(h.diffs, diffs);
    h.hold = !!hold;
    h.mount();
    h.status = { branch: 'main', isRepo: true, files };
    h.view.update(h.status);
  }, { files, diffs, hold: options.hold });
}

const calls = (page: Page) => page.evaluate(() => (window as any).harness.calls as unknown[][]);
const loads = async (page: Page) => (await calls(page)).filter(c => c[0] === 'loadDiff').map(c => `${c[1]}:${c[2]}`);
const pick = (page: Page, id: string) => page.evaluate(id => (window as any).harness.lastMenu.onSelect(id), id);

const FILES: File[] = [
  { path: 'src/app/main.ts', index: ' ', working: 'M' },
  { path: 'src/new-file.ts', index: 'A', working: ' ' },
  { path: 'README.md', index: ' ', working: 'D' },
  { path: 'notes/todo.txt', index: '?', working: '?' },
  { path: 'src/both.ts', index: 'M', working: 'M' },
];
const DIFFS = {
  'src/app/main.ts': patch('src/app/main.ts', 3, 1),
  'src/new-file.ts': patch('src/new-file.ts', 4, 0),
  'README.md': patch('README.md', 0, 2),
  'notes/todo.txt': patch('notes/todo.txt', 1, 0),
  'src/both.ts': patch('src/both.ts', 1, 1),
};

test.describe('changes view', () => {
test('stacks every changed file with totals, pills and inline diffs', async ({ page }) => {
  test.slow();
  await mount(page, FILES, DIFFS);
  const view = page.locator('#host.changes-view');
  await expect(view.locator('.cv-scope-label')).toHaveText('All changes');
  await expect(view.locator('.cv-files')).toHaveText('5 files');
  await expect(view.locator('.cv-adds')).toHaveText('+9');
  await expect(view.locator('.cv-dels')).toHaveText('-4');
  await expect(view.locator('.cv-file')).toHaveCount(5);
  await expect(view.locator('.cv-file .cv-name')).toHaveText(['todo.txt', 'README.md', 'main.ts', 'both.ts', 'new-file.ts']);
  await expect(view.locator('.cv-file .cv-pill')).toHaveText(['Untracked', 'Deleted', 'Modified', 'Modified', 'Added']);
  const main = view.locator('.cv-file[data-path="src/app/main.ts"]');
  await expect(main.locator('.cv-dir')).toHaveText('src/app');
  await expect(main.locator('.cv-stat')).toHaveText('+3-1');
  await expect(view.locator('.cv-file[data-path="README.md"] .cv-stat')).toHaveText('-2');
  await expect(view.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
  await expect(view.locator('.diff-viewer-toolbar').first()).toBeHidden();
  // A file with staged and unstaged edits shows the working tree; staged-only shows the index.
  expect(await loads(page)).toEqual(expect.arrayContaining(['src/both.ts:false', 'src/new-file.ts:true', 'notes/todo.txt:false']));
  const box = await view.locator('.cv-header').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(33);
  const fileBox = await main.locator('.cv-file-header').boundingBox();
  expect(fileBox!.height).toBeLessThanOrEqual(31);
  await page.screenshot({ path: 'test-results/changes-view.png', clip: { x: 0, y: 0, width: 470, height: 700 } });
});

test('loads patches only as files near the viewport', async ({ page }) => {
  const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/f${String(i).padStart(2, '0')}.ts`, index: ' ', working: 'M' }));
  const diffs = Object.fromEntries(files.map(f => [f.path, patch(f.path, 30, 0)]));
  await mount(page, files, diffs);
  await expect(page.locator('.cv-file')).toHaveCount(60);
  await expect.poll(async () => (await loads(page)).length).toBeGreaterThan(0);
  const early = await loads(page);
  expect(early.length).toBeLessThan(60);
  expect(early).toEqual(files.slice(0, early.length).map(f => `${f.path}:false`));
  await page.locator('.cv-file[data-path="src/f59.ts"]').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await loads(page)).includes('src/f59.ts:false')).toBe(true);
});

test('update keeps unchanged diffs mounted and re-mounts only changed patches', async ({ page }) => {
  test.slow();
  await mount(page, FILES, DIFFS);
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
  const viewer = (path: string) => `.cv-file[data-path="${path}"] .diff-viewer`;
  const same = (path: string) => page.evaluate(selector => (window as any).kept[selector] === document.querySelector(selector), viewer(path));
  const keep = () => page.evaluate(selectors => { (window as any).kept = Object.fromEntries(selectors.map(s => [s, document.querySelector(s)])); }, FILES.map(f => viewer(f.path)));
  await keep();
  const before = (await loads(page)).length;
  // The identical status object never refetches.
  await page.evaluate(() => { const h = (window as any).harness; h.view.update(h.status); });
  expect((await loads(page)).length).toBe(before);
  // A new status object quietly refetches loaded paths; identical text re-mounts nothing.
  await page.evaluate(files => (window as any).harness.view.update({ branch: 'main', isRepo: true, files }), FILES);
  await expect.poll(async () => (await loads(page)).length).toBe(before + 5);
  for (const file of FILES) expect(await same(file.path)).toBe(true);
  // Same status codes but new text: only that file's viewer is replaced, with the new content.
  await page.evaluate(text => { const h = (window as any).harness; h.diffs['src/app/main.ts'] = text; h.view.update({ ...h.status }, undefined, { refetch: true }); }, patch('src/app/main.ts', 6, 1));
  await expect(page.locator(viewer('src/app/main.ts'))).toHaveCount(1);
  await expect.poll(() => same('src/app/main.ts')).toBe(false);
  await expect(page.locator('.cv-file[data-path="src/app/main.ts"] .cv-stat')).toHaveText('+6-1');
  await expect(page.locator('.cv-adds')).toHaveText('+12');
  await expect.poll(() => page.evaluate(selector => document.querySelector(selector)?.querySelector('diffs-container')?.shadowRoot?.textContent ?? '', viewer('src/app/main.ts'))).toContain('added5');
  for (const file of FILES.filter(f => f.path !== 'src/app/main.ts')) expect(await same(file.path)).toBe(true);
  // A status code change refetches just that path from the other side.
  const mark = (await loads(page)).length;
  const changed = FILES.map(f => f.path === 'src/app/main.ts' ? { ...f, index: 'M', working: ' ' } : f);
  await page.evaluate(files => (window as any).harness.view.update({ branch: 'main', isRepo: true, files }, undefined, { refetch: false }), changed);
  await expect.poll(async () => (await loads(page)).slice(mark)).toEqual(['src/app/main.ts:true']);
  expect(await same('README.md')).toBe(true);
  await page.evaluate(files => (window as any).harness.view.update({ branch: 'main', isRepo: true, files }, undefined, { refetch: false }), changed.filter(f => f.path !== 'README.md'));
  await expect(page.locator('.cv-file')).toHaveCount(4);
  await expect(page.locator('.cv-files')).toHaveText('4 files');
});

test('narrow panels keep trailing folders, keep code unbroken (scrolls) and slim hunk headers', async ({ page }) => {
  const path = 'packages/frontend/src/components/settings/Account.tsx';
  const long = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n keep\n-a\n+            const message = "averyveryverylongunbrokenstringliteralthatmustwrapsomewhereinsideitselfok";\n@@ -40,2 +40,2 @@ second\n keep2\n-b\n+c\n`;
  await page.setViewportSize({ width: 440, height: 600 });
  await mount(page, [{ path, index: ' ', working: 'M' }], { [path]: long });
  await page.addStyleTag({ content: '#host { width: 400px !important; }' });
  const dir = page.locator('.cv-dir');
  await expect(dir).toHaveAttribute('title', 'packages/frontend/src/components/settings');
  await expect.poll(() => dir.textContent()).toMatch(/^…\/(?:[a-z]+\/)*settings$/);
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(1, { timeout: 15_000 });
  const metrics = () => page.evaluate(() => {
    const root = document.querySelector('diffs-container')!.shadowRoot!;
    const line = root.querySelector<HTMLElement>('[data-content] [data-line-type="change-addition"]')!;
    const separator = root.querySelector<HTMLElement>('[data-content] [data-separator="metadata"]')!;
    return { wordBreak: getComputedStyle(line).wordBreak, firstRow: line.getClientRects()[0] && line.querySelector('span')!.getClientRects()[0].top - line.getBoundingClientRect().top, separator: separator.getBoundingClientRect().height };
  });
  await expect.poll(async () => (await metrics()).wordBreak).not.toBe('break-all');
  const { separator } = await metrics();
  expect(separator).toBeLessThanOrEqual(21);
  await page.screenshot({ path: 'test-results/changes-view-narrow.png', clip: { x: 0, y: 0, width: 410, height: 260 } });
});

test('collapses per file and all at once', async ({ page }) => {
  await mount(page, FILES, DIFFS);
  const main = page.locator('.cv-file[data-path="src/app/main.ts"]');
  await main.locator('.cv-toggle').click();
  await expect(main).toHaveClass(/collapsed/);
  await expect(main.locator('.cv-file-body')).toBeHidden();
  await expect(main.locator('.cv-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.locator('.cv-file.collapsed')).toHaveCount(5);
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator('.cv-file.collapsed')).toHaveCount(0);
});

test('scope menu filters staged and unstaged changes', async ({ page }) => {
  await mount(page, FILES, DIFFS);
  await page.locator('.cv-scope').click();
  await pick(page, 'staged');
  await expect(page.locator('.cv-scope-label')).toHaveText('Staged');
  await expect(page.locator('.cv-file .cv-name')).toHaveText(['both.ts', 'new-file.ts']);
  await expect.poll(async () => (await loads(page)).includes('src/both.ts:true')).toBe(true);
  await page.locator('.cv-scope').click();
  await pick(page, 'unstaged');
  await expect(page.locator('.cv-file .cv-name')).toHaveText(['todo.txt', 'README.md', 'main.ts', 'both.ts']);
});

test('menus stage, unstage, open and copy without reaching the document', async ({ page }) => {
  await mount(page, FILES, DIFFS);
  await page.evaluate(() => document.addEventListener('click', e => { if ((e.target as HTMLElement).closest('#host')) (window as any).leaked = true; }));
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = await page.evaluate(() => (window as any).harness.lastMenu.items.map((i: any) => i.label));
  expect(menu).toEqual(['Stage all', 'Unstage all', 'Commit…', 'Refresh']);
  await pick(page, 'stage-all');
  await page.getByRole('button', { name: 'More actions' }).click();
  await pick(page, 'unstage-all');
  await page.getByRole('button', { name: 'More actions' }).click();
  await pick(page, 'refresh');
  await page.locator('.cv-file[data-path="src/both.ts"] [data-cv-action="file-menu"]').click();
  expect(await page.evaluate(() => (window as any).harness.lastMenu.items.map((i: any) => i.label))).toEqual(['Stage file', 'Unstage file', 'Open file', 'Copy path']);
  await pick(page, 'open');
  const log = (await calls(page)).filter(c => c[0] !== 'loadDiff' && c[0] !== 'choose');
  expect(log).toEqual([
    ['stage', ['src/app/main.ts', 'README.md', 'notes/todo.txt', 'src/both.ts'], true],
    ['stage', ['src/new-file.ts', 'src/both.ts'], false],
    ['refresh'],
    ['openFile', 'src/both.ts'],
  ]);
  expect(await page.evaluate(() => (window as any).leaked)).toBeUndefined();
});

test('inline commit bar submits on Enter and cancels on Escape', async ({ page }) => {
  await mount(page, FILES, DIFFS);
  await page.getByRole('button', { name: 'More actions' }).click();
  await pick(page, 'commit');
  const input = page.getByRole('textbox', { name: 'Commit message' });
  await expect(input).toBeFocused();
  const submit = page.locator('.cv-commit-submit');
  await expect(submit).toBeDisabled();
  await input.fill('Tidy changes view');
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: 'test-results/changes-view-commit.png', clip: { x: 0, y: 0, width: 470, height: 200 } });
  await input.press('Enter');
  await expect(page.locator('.cv-commit')).toBeHidden();
  expect((await calls(page)).find(c => c[0] === 'commit')).toEqual(['commit', 'Tidy changes view']);
  await page.getByRole('button', { name: 'More actions' }).click();
  await pick(page, 'commit');
  await input.fill('discard');
  await input.press('Escape');
  await expect(page.locator('.cv-commit')).toBeHidden();
  await page.evaluate(files => (window as any).harness.view.update({ branch: 'main', isRepo: true, files }), FILES.filter(f => f.index === ' ' || f.index === '?'));
  await page.getByRole('button', { name: 'More actions' }).click();
  await pick(page, 'commit');
  await input.fill('nothing staged');
  await expect(submit).toBeDisabled();
});

test('shows clean, not-a-repo, error and per-file failure states', async ({ page }) => {
  await mount(page, [], {});
  await expect(page.locator('.cv-state')).toHaveText('Working tree clean');
  await page.evaluate(() => (window as any).harness.view.update({ branch: '', isRepo: false, files: [] }));
  await expect(page.locator('.cv-state')).toHaveText('Not a Git repository');
  await page.evaluate(() => (window as any).harness.view.update(null, 'git status failed'));
  await expect(page.locator('.cv-state-error')).toContainText('git status failed');
  await page.locator('.cv-state-error').getByRole('button', { name: 'Retry' }).click();
  expect((await calls(page)).some(c => c[0] === 'refresh')).toBe(true);
  await page.evaluate(() => {
    const h = (window as any).harness;
    h.diffs['bad.ts'] = new Error('diff exploded');
    h.view.update({ branch: 'main', isRepo: true, files: [{ path: 'bad.ts', index: ' ', working: 'M' }] });
  });
  await expect(page.locator('.cv-file .cv-error')).toContainText('diff exploded');
  await page.evaluate(() => { (window as any).harness.diffs['bad.ts'] = 'diff --git a/bad.ts b/bad.ts\n--- a/bad.ts\n+++ b/bad.ts\n@@ -1 +1 @@\n-a\n+b\n'; });
  await page.locator('.cv-file .cv-error').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.cv-file .cv-stat')).toHaveText('+1-1');
});

test('passes truncation to the viewer and strips the marker', async ({ page }) => {
  await mount(page, [{ path: 'big.ts', index: ' ', working: 'M' }], { 'big.ts': `${patch('big.ts', 2, 0)}\n\n[Preview truncated at 256 KiB]\n` });
  await expect(page.locator('.cv-file')).toHaveAttribute('data-truncated', 'true');
  await expect(page.locator('.diff-viewer-status')).toContainText('shortened', { timeout: 15_000 });
  await expect(page.locator('.cv-file .cv-stat')).toHaveText('+2');
});


test('diff workers start on demand, survive mounted idle and restart after disposal', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__diffWorkers = { started: 0, stopped: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).__diffWorkers.started++; }
      terminate() { (window as any).__diffWorkers.stopped++; super.terminate(); }
    };
  });
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  expect(await page.evaluate(() => (window as any).__diffWorkers.started)).toBe(0);
  const mountViewer = () => page.evaluate(async patch => {
    const modulePath = '/src/diff-viewer.ts';
    const { mountDiffViewer } = await import(/* @vite-ignore */ modulePath);
    const viewer = mountDiffViewer(document.querySelector('#host'), { patch, path: 'a.ts' });
    (window as any).__idleViewer = viewer;
    await viewer.ready;
  }, patch('a.ts', 2, 1));
  await mountViewer();
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  expect(await page.evaluate(() => (window as any).__diffWorkers.started)).toBe(2);
  await page.clock.install();
  await page.clock.fastForward(301_000);
  expect(await page.evaluate(() => (window as any).__diffWorkers.stopped)).toBe(0);
  await page.evaluate(() => (window as any).__idleViewer.dispose());
  await page.clock.fastForward(301_000);
  await expect.poll(() => page.evaluate(() => (window as any).__diffWorkers.stopped)).toBe(2);
  await page.clock.resume();
  await mountViewer();
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  expect(await page.evaluate(() => (window as any).__diffWorkers.started)).toBe(4);
});

test('hidden Changes views do not fetch patches or start diff workers', async ({ page }) => {
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(() => { document.querySelector<HTMLElement>('#host')!.hidden = true; });
  await page.evaluate(({ files, diffs }) => {
    const h = (window as any).harness;
    Object.assign(h.diffs, diffs); h.mount();
    h.view.update({ branch: 'main', isRepo: true, files });
  }, { files: FILES, diffs: DIFFS });
  await page.waitForTimeout(200);
  expect(await loads(page)).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(e => /diff-viewer|worker\.js/.test(e.name)))).toBe(false);
  await page.evaluate(() => { document.querySelector<HTMLElement>('#host')!.hidden = false; });
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
});

test('collapsed diffs dispose their viewers and reopen cached patches without fetching', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__stopped = 0;
    window.Worker = class extends NativeWorker {
      terminate() { (window as any).__stopped++; super.terminate(); }
    };
  });
  await mount(page, FILES, DIFFS);
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
  const before = await loads(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.locator('.diff-viewer')).toHaveCount(0);
  await page.clock.fastForward(301_000);
  await expect.poll(() => page.evaluate(() => (window as any).__stopped)).toBe(2);
  await page.clock.resume();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
  expect(await loads(page)).toEqual(before);
});

test('fallback viewers do not pin the diff engine', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__stopped = 0;
    window.Worker = class extends NativeWorker {
      terminate() { (window as any).__stopped++; super.terminate(); }
    };
  });
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(async patch => {
    const modulePath = '/src/diff-viewer.ts';
    const { mountDiffViewer } = await import(/* @vite-ignore */ modulePath);
    const host = document.querySelector('#host');
    const active = mountDiffViewer(host, { patch, path: 'a.ts' });
    await active.ready;
    for (const input of [{ patch: '', binary: true }, { patch, error: 'Unavailable' }, { patch: 'x'.repeat(2_000_001) }, { patch: 'malformed' }]) {
      const fallback = document.createElement('div'); document.body.append(fallback);
      await mountDiffViewer(fallback, input).ready;
    }
    (window as any).__active = active;
  }, patch('a.ts', 2, 1));
  await page.clock.install();
  await page.evaluate(() => (window as any).__active.dispose());
  await page.clock.fastForward(301_000);
  await expect.poll(() => page.evaluate(() => (window as any).__stopped)).toBe(2);
});

test('folding during a pending patch load never mounts a hidden diff', async ({ page }) => {
  const files = [{ path: 'a.ts', index: ' ', working: 'M' }];
  await mount(page, files, { 'a.ts': patch('a.ts', 2, 1) }, { hold: true });
  await expect.poll(async () => (await loads(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.evaluate(async () => {
    const h = (window as any).harness; h.pending.get('a.ts')();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  await expect(page.locator('.cv-stat')).toHaveText('+2-1');
  await expect(page.locator('.diff-viewer')).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(e => /diff-viewer|worker\.js/.test(e.name)))).toBe(false);
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  expect(await loads(page)).toEqual(['a.ts:false']);
});

test('collapsed files defer refresh until expanded and then show the current patch', async ({ page }) => {
  await mount(page, [{ path: 'a.ts', index: ' ', working: 'M' }], { 'a.ts': patch('a.ts', 2, 1) });
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.evaluate(text => {
    const h = (window as any).harness; h.diffs['a.ts'] = text;
    h.view.update({ ...h.status }, undefined, { refetch: true });
  }, patch('a.ts', 7, 1));
  expect(await loads(page)).toEqual(['a.ts:false']);
  await expect(page.locator('.diff-viewer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(page.locator('.cv-stat')).toHaveText('+7-1');
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  expect(await loads(page)).toEqual(['a.ts:false', 'a.ts:false']);
});

test('a failed diff keeps its error and Retry after collapsing and expanding', async ({ page }) => {
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(() => {
    const h = (window as any).harness;
    h.diffs['failed.ts'] = new Error('Diff unavailable'); h.mount();
    h.view.update({ branch: 'main', isRepo: true, files: [{ path: 'failed.ts', index: ' ', working: 'M' }] });
  });
  await expect(page.locator('.cv-error')).toContainText('Diff unavailable');
  await page.getByRole('button', { name: 'Collapse failed.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Expand failed.ts', exact: true }).click();
  await expect(page.locator('.cv-error')).toContainText('Diff unavailable');
  await page.evaluate(text => { (window as any).harness.diffs['failed.ts'] = text; }, patch('failed.ts', 2, 1));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(1, { timeout: 15_000 });
});

test('hiding a mounted Changes view releases workers and restores cached patches and folds', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__hiddenWorkers = { started: 0, stopped: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).__hiddenWorkers.started++; }
      terminate() { (window as any).__hiddenWorkers.stopped++; super.terminate(); }
    };
  });
  await mount(page, FILES, DIFFS);
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(5, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Collapse README.md', exact: true }).click();
  const before = await loads(page);
  await page.clock.install();
  await page.evaluate(() => { document.querySelector<HTMLElement>('#host')!.hidden = true; });
  await expect(page.locator('.diff-viewer')).toHaveCount(0);
  await page.clock.fastForward(301_000);
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenWorkers.stopped)).toBe(2);
  await page.clock.resume();
  await page.evaluate(() => { document.querySelector<HTMLElement>('#host')!.hidden = false; });
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(4, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Expand README.md', exact: true })).toBeVisible();
  expect(await loads(page)).toEqual(before);
  expect(await page.evaluate(() => (window as any).__hiddenWorkers.started)).toBe(4);
});

test('offscreen files suspend their viewers while retaining height and cached patch text', async ({ page }) => {
  const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/f${String(i).padStart(2, '0')}.ts`, index: ' ', working: 'M' }));
  const diffs = Object.fromEntries(files.map(f => [f.path, patch(f.path, 30, 0)]));
  await mount(page, files, diffs);
  const first = page.locator('.cv-file').first();
  await expect(first.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  const height = (await first.locator('.cv-file-body').boundingBox())!.height;
  await page.locator('.cv-file').last().scrollIntoViewIfNeeded();
  await expect(first.locator('.diff-viewer')).toHaveCount(0);
  expect((await first.locator('.cv-file-body').boundingBox())!.height).toBeCloseTo(height, 0);
  await first.scrollIntoViewIfNeeded();
  await expect(first.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  expect((await loads(page)).filter(path => path === 'src/f00.ts:false')).toHaveLength(1);
});

test('document hiding releases mounted diff leases after grace and restores scroll and options', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__workers = { started: 0, stopped: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).__workers.started++; }
      terminate() { (window as any).__workers.stopped++; super.terminate(); }
    };
  });
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(async patch => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const { mountDiffViewer } = await import(/* @vite-ignore */ `${location.origin}/src/diff-viewer.ts`);
    await mountDiffViewer(document.querySelector('#host'), { patch, path: 'a.ts' }).ready;
  }, patch('a.ts', 600, 1));
  expect(await page.evaluate(() => (window as any).__workers.started)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  const content = page.locator('.diff-viewer-content');
  await content.evaluate(el => { el.style.maxHeight = '160px'; el.scrollTop = 180; });
  const top = await content.evaluate(el => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  const visibility = (hidden: boolean) => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await page.clock.install();
  await visibility(true);
  await page.clock.runFor(100);
  await visibility(false);
  expect(await page.evaluate(() => (window as any).__workers.stopped)).toBe(0);
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await visibility(true);
  await page.clock.runFor(1_100);
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'suspended');
  await page.clock.fastForward(601_000);
  await expect.poll(() => page.evaluate(() => (window as any).__workers.stopped)).toBe(2);
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'suspended');
  await visibility(false);
  await page.clock.resume();
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(top);
  expect(await page.evaluate(() => (window as any).__workers.started)).toBe(4);
});

test('Changes patch budget evicts the least recent collapsed text, preserves height and reloads on expand', async ({ page }) => {
  await page.route('**/src/changes-view.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('16 * 1024 * 1024', '900') });
  });
  const files = ['a.ts', 'b.ts', 'c.ts'].map(path => ({ path, index: ' ', working: 'M' }));
  await mount(page, files, Object.fromEntries(files.map(f => [f.path, patch(f.path, 3, 1)])), { hold: true });
  await expect.poll(async () => (await loads(page)).length).toBe(3);
  await page.evaluate(() => { const h = (window as any).harness; h.pending.get('a.ts')(); h.pending.get('b.ts')(); });
  await expect(page.locator('.diff-viewer[data-diff-state="ready"]')).toHaveCount(2, { timeout: 15_000 });
  const first = page.locator('.cv-file[data-path="b.ts"]');
  const height = (await first.locator('.cv-file-body').boundingBox())!.height;
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse b.ts', exact: true }).click();
  // Touch a again: b must be evicted even though a comes first in the file list.
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(page.locator('.cv-file[data-path="a.ts"] .diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.evaluate(() => (window as any).harness.pending.get('c.ts')());
  await expect(page.locator('.cv-file[data-path="c.ts"] .diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(page.locator('.cv-file[data-path="a.ts"] .diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  expect((await loads(page)).filter(p => p === 'a.ts:false')).toHaveLength(1);
  await page.getByRole('button', { name: 'Expand b.ts', exact: true }).click();
  await expect.poll(async () => (await loads(page)).filter(p => p === 'b.ts:false').length).toBe(2);
  expect((await first.locator('.cv-file-body').boundingBox())!.height).toBeCloseTo(height, 0);
  await page.evaluate(() => { const h = (window as any).harness; h.view.update(h.status, undefined, { refetch: false }); });
  await expect(page.locator('.cv-adds')).toHaveText('+9');
  await page.evaluate(() => (window as any).harness.pending.get('b.ts')());
  await expect(first.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  await expect(first.locator('.cv-stat')).toHaveText('+3-1');
});

function longPatch(path: string, lines = 8): string {
  return patch(path, lines, lines).replace(/(const (?:added|removed)\d+ = \d+);/g, '$1 + "' + 'long code '.repeat(100) + '";');
}

for (const virtualized of [false, true]) for (const layout of ['unified', 'split'] as const) for (const suspension of ['fold', 'inspector', 'document'] as const) {
  test(`Changes ${virtualized ? 'virtualized ' : ''}${layout} long-line position survives ${suspension} suspension`, async ({ page }) => {
    await mount(page, [{ path: 'a.ts', index: ' ', working: 'M' }], { 'a.ts': virtualized ? virtualLongPatch() : longPatch('a.ts') });
    const viewer = page.locator('.diff-viewer');
    const code = viewer.locator('diffs-container').first().locator('[data-code]');
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
    if (layout === 'split') {
      await page.locator('#host').evaluate(el => { el.style.width = '1000px'; });
      const split = viewer.getByRole('button', { name: 'Split diff', exact: true, includeHidden: true });
      await expect(split).toBeEnabled();
      await split.evaluate((el: HTMLButtonElement) => el.click());
      await expect(viewer).toHaveAttribute('data-diff-layout', 'split');
    }
    if (virtualized) await expect(viewer.locator('diffs-container')).toHaveCount(3);
    const top = await page.locator('.cv-body').evaluate(el => el.scrollTop);
    const positions = layout === 'split' ? [250, 250] : [250];
    await expect(code).toHaveCount(positions.length);
    await code.evaluateAll(nodes => nodes.forEach(node => { node.scrollLeft = 250; }));
    await expect.poll(() => code.evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual(positions);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const height = (await page.locator('.cv-file-body').boundingBox())!.height;
    if (suspension === 'fold') {
      await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
      await expect(viewer).toHaveCount(0);
      await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
    } else if (suspension === 'inspector') {
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#host')!.hidden = true;
        (window as any).harness.view.setVisible(false);
      });
      await expect(viewer).toHaveCount(0);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#host')!.hidden = false;
        (window as any).harness.view.setVisible(true);
      });
    } else {
      await page.clock.install();
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.runFor(1_100);
      await expect(viewer).toHaveAttribute('data-diff-state', 'suspended');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.resume();
    }
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
    await expect(viewer).toHaveAttribute('data-diff-layout', layout);
    await expect.poll(() => code.evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual(positions);
    await expect.poll(() => page.locator('.cv-body').evaluate(el => el.scrollTop)).toBe(top);
    expect((await page.locator('.cv-file-body').boundingBox())!.height).toBeCloseTo(height, 0);
    expect(await loads(page)).toEqual(['a.ts:false']);
  });
}

test('split diff long-line positions survive document suspension with a clamped side', async ({ page }) => {
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(async patch => {
    const host = document.querySelector<HTMLElement>('#host')!;
    host.style.width = '1000px';
    const { mountDiffViewer } = await import(/* @vite-ignore */ `${location.origin}/src/diff-viewer.ts`);
    await mountDiffViewer(host, { patch, path: 'a.ts', layout: 'split' }).ready;
  }, longPatch('a.ts', 80).replace(/^-const removed.*$/gm, '-const removed = "' + 'x'.repeat(45) + '";'));
  const viewer = page.locator('.diff-viewer');
  const code = viewer.locator('[data-code]');
  await expect(viewer).toHaveAttribute('data-diff-layout', 'split');
  await expect(code).toHaveCount(2);
  await code.last().evaluate(node => { node.scrollLeft = 250; });
  await expect.poll(() => code.last().evaluate(node => node.scrollLeft)).toBe(250);
  await expect.poll(() => code.first().evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  const positions = await code.evaluateAll(nodes => nodes.map(node => node.scrollLeft));
  expect(positions[0]).toBeLessThan(250);
  const content = page.locator('.diff-viewer-content');
  await content.evaluate(el => { el.style.maxHeight = '160px'; el.scrollTop = 180; });
  const top = await content.evaluate(el => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(1_100);
  await expect(viewer).toHaveAttribute('data-diff-state', 'suspended');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.resume();
  await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
  await expect(viewer).toHaveAttribute('data-diff-layout', 'split');
  await expect.poll(() => code.evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual(positions);
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(top);
});

test('an evicted diff reload failure clears reserved height and Retry succeeds', async ({ page }) => {
  await page.route('**/src/changes-view.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('16 * 1024 * 1024', '900') });
  });
  await mount(page, [{ path: 'a.ts', index: ' ', working: 'M' }], { 'a.ts': patch('a.ts', 80, 1) });
  const body = page.locator('.cv-file-body');
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  expect((await body.boundingBox())!.height).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.evaluate(() => { (window as any).harness.diffs['a.ts'] = new Error('Evicted patch unavailable'); });
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(page.locator('.cv-error')).toContainText('Evicted patch unavailable');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect((await body.boundingBox())!.height).toBeLessThan(100);
  await page.evaluate(text => { (window as any).harness.diffs['a.ts'] = text; }, patch('a.ts', 80, 1));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.diff-viewer')).toHaveAttribute('data-diff-state', 'ready');
  expect((await body.boundingBox())!.height).toBeGreaterThan(1000);
  expect(await loads(page)).toEqual(['a.ts:false', 'a.ts:false', 'a.ts:false']);
});

test('Changes keeps Wrap through fold and inspector suspension', async ({ page }) => {
  await mount(page, [{ path: 'a.ts', index: ' ', working: 'M' }], { 'a.ts': patch('a.ts', 8, 1) });
  const viewer = page.locator('.diff-viewer');
  await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  const wrap = viewer.getByRole('button', { name: 'Wrap lines', exact: true, includeHidden: true });
  await wrap.evaluate((el: HTMLButtonElement) => el.click());
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Collapse a.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Expand a.ts', exact: true }).click();
  await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).harness.view.setVisible(false));
  await expect(viewer).toHaveCount(0);
  await page.evaluate(() => (window as any).harness.view.setVisible(true));
  await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
});

function virtualLongPatch(): string {
  const [header, hunk] = longPatch('a.ts', 10).split('@@ -1,11 +1,11 @@');
  const lines = hunk.trim().split('\n').slice(1);
  const changes = Array.from({ length: 10 }, (_, i) => `${lines[i]}\n${lines[i + 10]}\n`).join('');
  return header + Array.from({ length: 40 }, (_, i) => `@@ -${i * 30 + 1},10 +${i * 30 + 1},10 @@\n${changes}`).join('');
}

function deepPatch(path = 'a.ts'): string {
  let text = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (let hunk = 0; hunk < 40; hunk++) {
    text += `@@ -${hunk * 30 + 1},10 +${hunk * 30 + 1},10 @@\n`;
    for (let line = 0; line < 10; line++) {
      text += `-old_h${hunk}_l${line} ${'x'.repeat(220)}\n`;
      text += `+new_h${hunk}_l${line} ${'y'.repeat(300)}\n`;
    }
  }
  return text;
}

type ReaderPosition = {
  top: number;
  height: number;
  anchor: { container: number; side: number; index: string; line: string; text: string; offset: number } | null;
};

async function stableReaderPosition(page: Page, rootSelector: string): Promise<ReaderPosition> {
  const read = () => page.evaluate(selector => {
    const root = document.querySelector<HTMLElement>(selector)!;
    const viewport = root.getBoundingClientRect();
    const visible: ReaderPosition['anchor'][] = [];
    document.querySelectorAll('diffs-container').forEach((container, containerIndex) => {
      container.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]').forEach((code, side) => {
        code.querySelectorAll<HTMLElement>('[data-line][data-line-index]').forEach(line => {
          const rect = line.getBoundingClientRect();
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
          visible.push({
            container: containerIndex,
            side,
            index: line.dataset.lineIndex!,
            line: line.dataset.line ?? '',
            text: line.textContent?.trim().slice(0, 40) ?? '',
            offset: Math.round((rect.top - viewport.top) * 1_000) / 1_000,
          });
        });
      });
    });
    visible.sort((a, b) => a!.offset - b!.offset || a!.container - b!.container || a!.side - b!.side);
    return { top: root.scrollTop, height: root.scrollHeight, anchor: visible[0] ?? null } satisfies ReaderPosition;
  }, rootSelector);
  let previous = '', stable = 0;
  await expect.poll(async () => {
    const position = await read();
    const { offset: _offset, ...identity } = position.anchor ?? { offset: 0 };
    const key = JSON.stringify(identity);
    stable = key === previous ? stable + 1 : 0;
    previous = key;
    return stable;
  }, { timeout: 15_000, intervals: [100] }).toBeGreaterThanOrEqual(5);
  return read();
}

async function waitForDeepExtent(page: Page, rootSelector: string): Promise<void> {
  await expect(page.locator('diffs-container')).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => page.locator(rootSelector).evaluate(el => el.scrollHeight),
    { timeout: 15_000, intervals: [100] }).toBeGreaterThan(7_000);
}

function expectSameReaderAnchor(before: ReaderPosition, after: ReaderPosition): void {
  expect(before.anchor).not.toBeNull();
  expect(after.anchor).not.toBeNull();
  const { offset: beforeOffset, ...beforeIdentity } = before.anchor!;
  const { offset: afterOffset, ...afterIdentity } = after.anchor!;
  expect(afterIdentity).toEqual(beforeIdentity);
  expect(afterOffset).toBeCloseTo(beforeOffset, 0);
}

for (const layout of ['unified', 'split'] as const) {
  test(`standalone deep ${layout} diff preserves its semantic line through document suspension`, async ({ page }) => {
    test.slow();
    await page.goto('/tests/fixtures/changes-view.html');
    await page.waitForFunction(() => (window as any).harnessReady);
    await page.evaluate(async ({ patch, layout }) => {
      const host = document.querySelector<HTMLElement>('#host')!;
      host.style.width = '1000px';
      const { mountDiffViewer } = await import(/* @vite-ignore */ `${location.origin}/src/diff-viewer.ts`);
      const viewer = (window as any).deepViewer = mountDiffViewer(host, { patch, path: 'a.ts', layout });
      await viewer.ready;
      const content = host.querySelector<HTMLElement>('.diff-viewer-content')!;
      content.style.height = content.style.maxHeight = '500px';
    }, { patch: deepPatch(), layout });
    const viewer = page.locator('.diff-viewer');
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
    await expect(viewer).toHaveAttribute('data-diff-layout', layout);
    await waitForDeepExtent(page, '.diff-viewer-content');
    await stableReaderPosition(page, '.diff-viewer-content');
    await page.locator('.diff-viewer-content').evaluate(el => { el.scrollTop = 10_000; });
    await page.waitForTimeout(1_800);
    const before = await stableReaderPosition(page, '.diff-viewer-content');
    expect(before.anchor).not.toBeNull();
    const expectedCodeScroll = layout === 'split' ? [250, 250] : [250];
    const anchorCode = viewer.locator('diffs-container').nth(before.anchor!.container).locator('[data-code]');
    await anchorCode.evaluateAll(nodes => nodes.forEach(node => { node.scrollLeft = 250; }));
    await expect.poll(() => anchorCode.evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual(expectedCodeScroll);
    await page.evaluate(() => new Promise(requestAnimationFrame));

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1_100);
    await expect(viewer).toHaveAttribute('data-diff-state', 'suspended');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
    await page.waitForTimeout(5_000);
    const after = await stableReaderPosition(page, '.diff-viewer-content');

    expectSameReaderAnchor(before, after);
    await expect.poll(() => anchorCode.evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual(expectedCodeScroll);
  });
}

for (const layout of ['unified', 'split'] as const) {
  test(`Changes deep ${layout} diff preserves one outer-list semantic anchor for both inspector hide orders`, async ({ page }) => {
    test.slow();
    await mount(page, [{ path: 'a.ts', index: ' ', working: 'M' }], { 'a.ts': deepPatch() });
    const host = page.locator('#host');
    await host.evaluate(el => { el.style.width = '1000px'; });
    const viewer = page.locator('.diff-viewer');
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
    if (layout === 'split') {
      const split = viewer.getByRole('button', { name: 'Split diff', exact: true, includeHidden: true });
      await expect(split).toBeEnabled();
      await split.evaluate((el: HTMLButtonElement) => el.click());
    }
    await expect(viewer).toHaveAttribute('data-diff-layout', layout);
    await waitForDeepExtent(page, '.cv-body');
    await stableReaderPosition(page, '.cv-body');
    await page.locator('.cv-body').evaluate(el => { el.scrollTop = 10_000; });
    await page.waitForTimeout(1_800);

    for (const hideHostFirst of [true, false]) {
      const before = await stableReaderPosition(page, '.cv-body');
      await page.evaluate(hideFirst => {
        const host = document.querySelector<HTMLElement>('#host')!;
        if (hideFirst) host.hidden = true;
        (window as any).harness.view.setVisible(false);
        host.hidden = true;
      }, hideHostFirst);
      await expect(viewer).toHaveCount(0);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#host')!.hidden = false;
        (window as any).harness.view.setVisible(true);
      });
      await expect(viewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
      await expect(viewer).toHaveAttribute('data-diff-layout', layout);
      await page.waitForTimeout(5_000);
      const after = await stableReaderPosition(page, '.cv-body');
      expectSameReaderAnchor(before, after);
    }
  });
}

test('virtualized split diff restores horizontal positions after document layout and later chunk mounts', async ({ page }) => {
  await page.clock.install();
  await page.goto('/tests/fixtures/changes-view.html');
  await page.waitForFunction(() => (window as any).harnessReady);
  await page.evaluate(async patch => {
    const host = document.querySelector<HTMLElement>('#host')!;
    host.style.width = '1000px';
    const { mountDiffViewer } = await import(/* @vite-ignore */ `${location.origin}/src/diff-viewer.ts`);
    const viewer = (window as any).virtualViewer = mountDiffViewer(host, { patch, path: 'a.ts', layout: 'split' });
    await viewer.ready;
    const content = host.querySelector<HTMLElement>('.diff-viewer-content')!;
    content.style.height = content.style.maxHeight = '500px';
    content.scrollTop = 10000;
  }, virtualLongPatch());
  const viewer = page.locator('.diff-viewer');
  const content = viewer.locator('.diff-viewer-content');
  const chunks = viewer.locator('diffs-container');
  await expect(chunks).toHaveCount(3);
  await expect.poll(() => chunks.last().locator('[data-code]').evaluateAll(nodes => nodes.length === 2 && nodes.every(node => node.scrollWidth > node.clientWidth + 250))).toBe(true);
  let previousGeometry = '', stableGeometry = 0;
  await expect.poll(async () => {
    const geometry = await content.evaluate(el => `${el.scrollTop}:${el.scrollHeight}`);
    stableGeometry = geometry === previousGeometry ? stableGeometry + 1 : 0;
    previousGeometry = geometry;
    return stableGeometry;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(5);
  await viewer.locator('[data-code]').evaluateAll(nodes => nodes.forEach(node => { if (node.clientWidth) node.scrollLeft = 250; }));
  await expect.poll(() => chunks.last().locator('[data-code]').evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual([250, 250]);
  const offsets = () => chunks.evaluateAll(nodes => nodes.map(node => Array.from(node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? [], code => code.clientWidth ? code.scrollLeft : null)));
  await expect.poll(offsets).toContainEqual([250, 250]);
  const before = await offsets();
  const top = await content.evaluate(el => el.scrollTop);
  expect(top).toBeGreaterThan(1000);
  // The first chunk is now a placeholder. Its saved offset must survive two
  // releases without forcing its code to mount, then apply when scrolled into view.
  await expect(chunks.first().locator('[data-code] [data-line]')).toHaveCount(0);
  await page.evaluate(() => {
    const viewer = (window as any).virtualViewer;
    const state = viewer.getReaderState();
    state.code[0] = [250, 250];
    viewer.restoreReaderState(state);
  });
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(1_100);
    await expect(viewer).toHaveAttribute('data-diff-state', 'suspended');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.resume();
    await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
    await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(top);
    await expect.poll(offsets).toEqual(before);
    await expect(viewer).toHaveAttribute('data-diff-layout', 'split');
  }

  await content.evaluate(el => { el.scrollTop = 0; });
  await expect.poll(() => chunks.first().locator('[data-code]').evaluateAll(nodes => nodes.map(node => node.scrollLeft))).toEqual([250, 250]);
  // Disposal must cancel a queued layout restore as well as the virtualizer.
  await page.evaluate(() => {
    const viewer = (window as any).virtualViewer;
    viewer.restoreReaderState(viewer.getReaderState());
    viewer.dispose();
  });
  await expect(viewer).toHaveCount(0);
});

test('Collapse all and Expand all preserve the outer list reader position across multiple files', async ({ page }) => {
  test.slow();
  const files: File[] = [
    { path: 'src/a.ts', index: ' ', working: 'M' },
    { path: 'src/b.ts', index: ' ', working: 'M' },
    { path: 'src/c.ts', index: ' ', working: 'M' },
  ];
  await mount(page, files, {
    'src/a.ts': patch('src/a.ts', 60, 10),
    'src/b.ts': deepPatch('src/b.ts'),
    'src/c.ts': patch('src/c.ts', 40, 5),
  });
  await page.locator('#host').evaluate(el => { el.style.width = '1000px'; });
  const targetViewer = page.locator('.cv-file[data-path="src/b.ts"] .diff-viewer');
  await expect(targetViewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  await expect(targetViewer.locator('diffs-container')).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => page.locator('.cv-body').evaluate(el => el.scrollHeight), { timeout: 15_000 }).toBeGreaterThan(8_000);

  await page.locator('.cv-body').evaluate(el => {
    const bTop = document.querySelector<HTMLElement>('.cv-file[data-path="src/b.ts"]')!.offsetTop;
    el.scrollTop = bTop + 4_500;
  });
  await page.waitForTimeout(1_800);
  const before = await stableReaderPosition(page, '.cv-body');
  expect(before.top).toBeGreaterThan(3_000);
  expect(before.anchor).not.toBeNull();

  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.locator('.cv-file.collapsed')).toHaveCount(3);
  await expect(page.locator('.diff-viewer')).toHaveCount(0);

  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.locator('.cv-file.collapsed')).toHaveCount(0);
  await expect(targetViewer).toHaveAttribute('data-diff-state', 'ready', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  const after = await stableReaderPosition(page, '.cv-body');
  expect(after.anchor).not.toBeNull();
  expect(after.anchor!.line).toBe(before.anchor!.line);
  expect(after.anchor!.text).toBe(before.anchor!.text);
  expect(after.anchor!.offset).toBeCloseTo(before.anchor!.offset, 0);
});
});
