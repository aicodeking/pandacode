import { test, type Page } from '@playwright/test';
import { openInspectorTab } from '../../tests/inspector-tab-helper';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

/* Captures the README screenshots from the browser preview: full windows and close-ups at
 * 2x, each framed with a soft shadow on a transparent background and saved as WebP in docs/screenshots/. The sample
 * data comes from showcase.js and the replacements below, applied only while capturing. */
const out = new URL('../../docs/screenshots/', import.meta.url).pathname;
const raw = '/tmp/pandacode-screenshots/raw/';
const showcase = readFileSync(new URL('./showcase.js', import.meta.url), 'utf8');

// Preview-only wording reads as placeholder text in a screenshot; swap in realistic copy.
const copy: [RegExp | string, string][] = [
  [/Sample Claude Code model metadata\./g, 'Anthropic model via Claude Code.'],
  [/Sample Codex model metadata\./g, 'OpenAI model via Codex.'],
  [/Sample configured Kimi model\./g, 'Moonshot model via Kimi Code.'],
  [/Sample output — no command was executed\./g, ''],
  [/\/\/ Browser preview — sample source\\n/g, ''],
  ['const output = shortReply ?', 'const output = window.__showcaseReply?.length ? window.__showcaseReply.shift() : shortReply ?'],
  // A capture can take seconds on a busy machine: the stream holds at this cursor, so it lands mid-reply.
  ['if (cursor < output.length) timers.set(s.id,', 'if (cursor >= window.__showcaseHold) return; if (cursor < output.length) timers.set(s.id,'],
];
const architectCopy: [RegExp | string, string][] = [
  [/`### Sample architect review[\s\S]*?\$\{sampleNotice\}`/,
    '`### Command palette shipped\\n\\nThe architect split the work between ${count} workers: one built the palette and its fuzzy search, the other wired every shortcut and the cheat sheet. Both checked in, and the combined changes are ready for review.`'],
  [/const sampleNotice = '[^']*';/, "const sampleNotice = '';"],
  [/Sample assignment explored\. No files were changed\./g, 'Assignment finished and tested.'],
  [/Await the sample architect review\./g, 'Await the architect review.'],
  [/sample summary ready for review\./g, 'summary ready for review.'],
  [/Sample assignment started\./g, 'Assignment started.'],
  [/Explore the sample scope and report a concise result\./g, 'Read the code, make the change and report back.'],
  [/Sample assignment \$\{index \+ 1\}: /g, ''],
  [/is exploring sample assignment \$\{index \+ 1\}/g, 'is working on part ${index + 1}'],
  [/Planning sample worker assignments/g, 'Planning worker assignments'],
  [/\$\{batch\.length\} sample worker/g, '${batch.length} worker'],
];
// Pins the clock so a scene's light is the same on every run.
const DUSK = 'sky=18:50', NIGHT = 'sky=21:30', MORNING = 'sky=10:30';
const HIDE = '.preview-status, .preview-notice, .settings-preview-note, #toast';

async function prepare(page: Page, theme: 'light' | 'dark', query = DUSK): Promise<void> {
  await page.addInitScript(t => { localStorage.setItem('pandacode.theme', t); }, theme);
  const rewrite = (pattern: string, replacements: [RegExp | string, string][], append = '') => page.route(pattern, async route => {
    const response = await route.fetch();
    let body = await response.text();
    for (const [from, to] of replacements) body = body.replace(from, to);
    await route.fulfill({ response, body: body + append });
  });
  await rewrite('**/src/preview.ts*', copy, `\n${showcase}\n`);
  await rewrite('**/src/preview-architect.ts*', architectCopy);
  await rewrite('**/src/preview-turn-changes.ts*', [[/Browser preview sample only\./g, 'Matching ignores case and surrounding spaces.'], [/# Browser preview sample/g, '# Orbit']]);
  await page.goto(`/?${query}`);
  await page.locator('#navigation .task-item').first().waitFor();
}

// The preview gives threads sample wake-ups; their strip over the composer distracts from the picture.
const hidePreviewBits = (page: Page) => page.addStyleTag({ content: `${HIDE} { visibility: hidden !important; } :has(> .wake-line) { display: none !important; }` });
/** Hides what only the browser preview shows (its status label, notices, toasts). */
async function tidy(page: Page): Promise<void> {
  await hidePreviewBits(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 940);
  await page.waitForTimeout(800);
}
// The inspector's diffs load after the row appears; the sample hunks all name this function.
const diffsLoaded = (page: Page) => page.locator('#inspector').getByText('mountSearch').first().waitFor();
const open = async (page: Page, title: string) => {
  await page.locator('#navigation .task-item', { hasText: title }).click();
  await page.locator('#transcript .turn-card').last().waitFor();
  await diffsLoaded(page);
};
const reply = (page: Page, text: string) => page.evaluate(value => { ((window as any).__showcaseReply ??= []).push(value); }, text);
const showView = async (page: Page, name: string) => {
  await page.getByRole('button', { name: /^Workspace view: / }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
};
const showInspector = async (page: Page) => {
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
};

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }, settle = true): Promise<void> {
  if (settle) await tidy(page);
  else await hidePreviewBits(page);
  await page.screenshot({ path: `${raw}${name}.png`, clip });
}
async function element(page: Page, name: string, selector: string, pad = 0, maxHeight = Infinity): Promise<void> {
  await tidy(page);
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.screenshot({ path: `${raw}${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(maxHeight, box.height + pad * 2) } });
}

/** Frames a capture: rounded corners and a soft shadow on a transparent background, so it
 * sits cleanly on any page (GitHub's light and dark themes alike). */
async function frame(page: Page, name: string, { dark = true, zoom = false } = {}): Promise<void> {
  const image = readFileSync(`${raw}${name}.png`).toString('base64');
  const pad = zoom ? 40 : 56;
  const edge = dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)';
  // A blank page of its own: the app's timers keep running in a document that setContent reuses.
  const sheet = await page.context().newPage();
  await sheet.setViewportSize({ width: 1700, height: 1200 });
  await sheet.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div id="frame" style="display:inline-block;padding:${pad}px ${pad}px ${pad + 16}px"><img src="data:image/png;base64,${image}" style="display:block;border-radius:${zoom ? 14 : 12}px;box-shadow:0 24px 60px -24px rgba(0,0,0,.42),0 6px 16px -8px rgba(0,0,0,.18),0 0 0 1px ${edge}"></div></body></html>`);
  // Shown at half its pixel size, so the 2x frame keeps every captured pixel.
  await sheet.locator('#frame img').evaluate(async (img: HTMLImageElement) => { await img.decode(); img.style.width = `${img.naturalWidth / 2}px`; });
  await sheet.locator('#frame').screenshot({ path: `${raw}${name}-framed.png`, omitBackground: true });
  await sheet.close();
  execFileSync('cwebp', ['-quiet', '-q', '88', '-m', '6', ...(zoom ? [] : ['-resize', '2000', '0']), `${raw}${name}-framed.png`, '-o', `${out}${name}.webp`]);
}

test.beforeAll(() => { mkdirSync(raw, { recursive: true }); mkdirSync(out, { recursive: true }); });

test('conversation', async ({ page }) => {
  await prepare(page, 'dark');
  await open(page, 'Make search feel instant');
  await shot(page, 'conversation');
  await element(page, 'turn-card', '#transcript .turn-card', 20);
  await page.getByRole('button', { name: /^Model: / }).click();
  await page.getByRole('dialog', { name: 'Harness and model', exact: true }).waitFor();
  await page.waitForTimeout(500);
  await hidePreviewBits(page);
  const picker = (await page.getByRole('dialog', { name: 'Harness and model', exact: true }).boundingBox())!;
  await page.screenshot({ path: `${raw}model-picker.png`, clip: picker });
  await page.keyboard.press('Escape');
  await frame(page, 'conversation');
  await frame(page, 'turn-card', { zoom: true });
  await frame(page, 'model-picker', { zoom: true });
});

test('streaming', async ({ page }) => {
  await prepare(page, 'dark', NIGHT);
  await page.getByText(/^Show \d+ more$/).first().click();
  await page.locator('#navigation .task-item', { hasText: 'Add keyboard shortcuts' }).click();
  await page.evaluate(() => { (window as any).__showcaseHold = 250; });
  await reply(page, 'I’ll add a command palette on **⌘K** and move the navigation into it.\n\n1. **Palette.** A fuzzy finder over projects, tasks and commands, with recent items first.\n2. **Shortcuts.** Every action gets a binding, listed in a `?` cheat sheet.\n3. **Focus.** Arrow keys move through results; Escape returns focus where it was.\n\nStarting with the palette component and its tests.');
  await page.locator('#prompt').fill('Make every navigation action reachable from the keyboard, with a ⌘K palette');
  await page.locator('#prompt').press('Enter');
  // Mid-reply: the card is still live when the capture is taken.
  await page.locator('#transcript .turn-card.is-live .turn-card-reply').filter({ hasText: 'Focus.' }).waitFor();
  await page.waitForTimeout(2500);
  const pane = (await page.locator('.conversation-pane').boundingBox())!;
  await shot(page, 'streaming', { x: pane.x, y: pane.y, width: pane.width, height: 480 }, false);
  await frame(page, 'streaming', { zoom: true });
});

test('board', async ({ page }) => {
  await prepare(page, 'dark');
  await showView(page, 'Board');
  await page.locator('.board-card, .board-task').first().waitFor();
  await shot(page, 'board');
  await frame(page, 'board');
});

test('github', async ({ page }) => {
  await prepare(page, 'dark');
  await showView(page, 'GitHub');
  const hub = page.getByRole('region', { name: 'GitHub', exact: true });
  await hub.getByRole('tab', { name: /Pull requests/ }).click();
  await hub.locator('.gh-item').first().waitFor();
  await shot(page, 'github');
  await frame(page, 'github');
});

test('agent team', async ({ page }) => {
  await prepare(page, 'dark');
  await page.locator('#navigation .task-item', { hasText: 'Refine the navigation' }).click();
  await page.locator('#team-trigger').click();
  await page.getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
  await page.locator('#team-trigger[data-on]').waitFor();
  await page.waitForTimeout(600);
  await page.locator('#prompt').fill('Ship a command palette with fuzzy search, and a shortcut for every navigation action');
  await page.locator('#prompt').press('Enter');
  await page.getByText('Command palette shipped').first().waitFor({ timeout: 45_000 });
  await page.locator('#transcript .turn-card:not(.is-live)').last().waitFor();
  await diffsLoaded(page);
  await page.locator('#agents-toggle').click();
  await page.locator('#agents-flyout').waitFor();
  await page.waitForTimeout(500);
  await hidePreviewBits(page);
  await page.screenshot({ path: `${raw}agents-flyout.png` });
  await frame(page, 'agents-flyout');
});

test('inspector and diff', async ({ page }) => {
  await prepare(page, 'dark');
  await open(page, 'Make search feel instant');
  await showInspector(page);
  await openInspectorTab(page, 'tab-simulator');
  await page.waitForTimeout(3500);
  await shot(page, 'simulator');
  await page.locator('#inspector-toggle').click();
  await page.locator('#transcript .turn-card-foot-open').last().click();
  await page.waitForTimeout(1200);
  await element(page, 'diff', '#dialog .dialog-plate, #dialog', 0, 345);
  await frame(page, 'simulator');
  await frame(page, 'diff', { zoom: true });
});

test('tiled threads', async ({ page }) => {
  await prepare(page, 'dark');
  await open(page, 'Make search feel instant');
  await page.locator('#inspector-toggle').click();
  for (const title of ['Polish the onboarding flow', 'Stabilize the date tests', 'Trim the bundle']) {
    await page.locator('#navigation .task-item', { hasText: title }).click({ modifiers: ['Meta'] });
    await page.locator(`.thread-tile:has-text("${title}")`).waitFor();
  }
  await page.locator('.thread-tile').evaluateAll(tiles => Promise.all(tiles.flatMap(tile => tile.getAnimations().map(animation => animation.finished.catch(() => undefined)))));
  await page.waitForTimeout(1500);
  await shot(page, 'tiled-threads');
  await frame(page, 'tiled-threads');
});

test('settings', async ({ page }) => {
  await prepare(page, 'dark');
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.waitForTimeout(800);
  await shot(page, 'settings');
  await frame(page, 'settings');
});

test('light theme and a daytime scene', async ({ page }) => {
  await prepare(page, 'light', MORNING);
  await open(page, 'Stabilize the date tests');
  await page.waitForTimeout(1500);
  await shot(page, 'scenes');
  await frame(page, 'scenes', { dark: false });
});

test('bot', async ({ page }) => {
  await prepare(page, 'dark');
  await page.locator('.sidebar-bots-bar').click();
  const sidebar = page.getByRole('region', { name: 'Bots', exact: true });
  await sidebar.getByRole('button', { name: 'Add bot or channel' }).click();
  await sidebar.getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New bot' }).click();
  const bots = page.getByRole('dialog', { name: /^(Bots|New bot)$/ });
  await bots.getByRole('textbox', { name: 'Name' }).fill('Scout');
  await bots.getByRole('button', { name: 'Create bot' }).click();
  await page.locator('#breadcrumb .bot-crumb').waitFor();
  await reply(page, 'Here’s your morning digest:\n\n- **orbit:** the instant-search PR (#130) merged and CI is green.\n- **Issues:** #131, the shortcut cheat sheet, has two new comments from Devon.\n- **Calendar:** demo with Sam on Friday at 14:00. The deck is in your Drafts.\n\nShall I send this every weekday at 9?');
  await page.locator('#prompt').fill('Good morning! What did I miss?');
  await page.locator('#prompt').press('Enter');
  await page.locator('#transcript .agent-message').last().waitFor();
  await page.waitForTimeout(6000);
  // The preview attaches sample file changes to every turn; a digest has none.
  await page.addStyleTag({ content: '.turn-changes-row, .turn-changes { display: none !important; }' });
  await page.locator('#inspector-toggle').click();
  await shot(page, 'bot');
  await page.locator('#breadcrumb').getByRole('button', { name: 'Scout settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Scout settings' }).getByRole('tab', { name: /Connections/ }).click();
  await page.waitForTimeout(700);
  await element(page, 'bot-settings', '#dialog .dialog-plate, #dialog');
  await frame(page, 'bot');
  await frame(page, 'bot-settings', { zoom: true });
});
