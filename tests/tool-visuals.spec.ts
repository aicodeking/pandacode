import { expect, test, type Page } from '@playwright/test';

// Tool rows that show what a call did: an image an agent viewed as a thumbnail (opening a viewer, never
// toggling the row), a `sed -n` read as `Read [file]`, and a test run's pass/fail summary.
// Seeds one extra turn into the preview's Tool gallery thread (preview-traces.ts) before it opens.
const SHOTS = '.pandacode/progress-shots';
const IMAGE_PATH = '/private/tmp/claude-501/shots/settings-dark.png';
const SECOND_IMAGE_PATH = '/private/tmp/claude-501/shots/settings-light.png';
const PLAYWRIGHT_OUTPUT = [
  'Exit code: 1', 'Output:',
  'Running 14 tests using 4 workers',
  '  ✘  3 [chromium] › tests/voice-input.spec.ts:210:1 › dictation keeps the caret (1.2s)',
  '', '  1 failed', '  13 passed (8.4s)', '',
].join('\n');

type SeedTool = { id: string; name: string; input: unknown; output: string };

const SEED_TOOLS: SeedTool[] = [
  { id: 'visual-image', name: 'Read', input: { file_path: IMAGE_PATH }, output: '[Non-text content omitted]' },
  { id: 'visual-sed', name: 'Bash', input: { command: "sed -n '210,222p' tests/voice-input.spec.ts" }, output: "test('dictation keeps the caret', async ({ page }) => {" },
  { id: 'visual-tests', name: 'Command', input: '/bin/zsh -lc "npx playwright test tests/voice-input.spec.ts"\nWorking directory: /repo', output: PLAYWRIGHT_OUTPUT },
  { id: 'visual-image-2', name: 'Read', input: { file_path: SECOND_IMAGE_PATH }, output: '[Non-text content omitted]' },
];

// Expandable rows, one-line rows with nothing to open, and a housekeeping row, side by side in one group.
const ROW_TOOLS: SeedTool[] = [
  { id: 'row-ls', name: 'Bash', input: { command: 'ls' }, output: 'a\nb' },
  { id: 'row-sleep', name: 'sleep', input: { durationMs: 30000 }, output: '' },
  { id: 'row-compact', name: 'Compact context', input: '', output: '' },
  { id: 'row-tsc', name: 'Bash', input: { command: 'npx tsc --noEmit' }, output: '' },
  { id: 'row-tools', name: 'ToolSearch', input: { query: 'select:Read,Edit' }, output: '' },
];

async function openSeeded(page: Page, tools: SeedTool[] = SEED_TOOLS) {
  await page.goto('/?trace');
  await page.evaluate(async ({ tools }) => {
    const traces = await import('/src/preview-traces.ts' as string);
    const sessionId = traces.GALLERY_ID as string;
    const at = Date.now() - 20_000;
    traces.galleryMessages.push(
      { id: 8999, sessionId, role: 'user', content: 'Check the voice input screen.', createdAt: at - 1000 },
      ...tools.map((tool, index) => ({
        id: 9001 + index, sessionId, role: 'tool', createdAt: at + (index + 1) * 100,
        content: JSON.stringify({ type: 'tool_activity', version: 1, id: tool.id, name: tool.name, status: 'completed',
          input: typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input), output: tool.output }),
      })),
      { id: 9100, sessionId, role: 'assistant', content: 'One test still fails.', createdAt: at + 1000 },
    );
  }, { tools });
  await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
  const card = page.locator('.turn-card').last();
  await card.locator('details.turn-activity > summary').click();
  await expect(card.locator('details.turn-activity')).toHaveAttribute('open', '');
  // A short trace may sit in a folded group; open it so the rows show.
  const group = card.locator('details.tool-group').last();
  if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  return card;
}

test('a failed reveal says so inside the viewer', async ({ page }) => {
  // The preview's reveal_path refuses paths outside `/`, so a Windows path stands in for a reveal that fails.
  const card = await openSeeded(page, [{ id: 'visual-win', name: 'Read', input: { file_path: 'C:\\shots\\win.png' }, output: '[Non-text content omitted]' }]);
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await card.locator('details.tool-trace[data-tool-key="tool:visual-win"] > summary .tool-image-thumb').click();
  const viewer = page.locator('dialog.tool-image-viewer');
  await expect(viewer).toBeVisible();
  const notice = viewer.locator('.tool-image-viewer-notice');
  await expect(notice).toHaveAttribute('aria-live', 'polite');
  await expect(notice).toHaveText('');
  await viewer.locator('[data-tool-image-action="reveal"]').click();
  await expect(notice).toHaveText('Couldn’t reveal the file');
  await expect(notice).toBeVisible();
  expect(errors.some(text => text.includes('reveal_path failed'))).toBe(true);
});

/** The seeded gallery with its image row, collecting page errors; the viewer's Copy path writes to `window.copied`. */
async function openVisuals(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // The viewer's Copy path writes here instead of the system clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string[] }).copied = [...((window as unknown as { copied?: string[] }).copied ?? []), text]; } } });
  });
  const card = await openSeeded(page);
  const imageRow = card.locator('details.tool-trace[data-tool-key="tool:visual-image"]');
  const thumb = imageRow.locator(':scope > summary .tool-image-thumb');
  return { card, imageRow, thumb, errors, viewer: page.locator('dialog.tool-image-viewer') };
}

test('tool rows show viewed images, file reads and test results', async ({ page }) => {
  const { card, imageRow, thumb, errors } = await openVisuals(page);
  await expect(imageRow.locator(':scope > summary .tool-trace-verb')).toHaveText('Viewed');
  await expect(thumb.locator('img')).toHaveAttribute('src', /^data:image\//);
  await expect(imageRow.locator(':scope > summary .tool-image-name')).toHaveText('settings-dark.png');

  const sedRow = card.locator('details.tool-trace[data-tool-key="tool:visual-sed"]');
  await expect(sedRow.locator(':scope > summary .tool-trace-verb')).toHaveText('Read');
  await expect(sedRow.locator(':scope > summary .tool-trace-chip')).toHaveText('voice-input.spec.ts');
  await expect(sedRow.locator(':scope > summary .tool-trace-object')).toHaveText('lines 210–222');

  const testRow = card.locator('details.tool-trace[data-tool-key="tool:visual-tests"]');
  await expect(testRow.locator(':scope > summary .tool-trace-verb')).toHaveText('Tests failed');
  await expect(testRow.locator(':scope > summary .tool-trace-chip')).toHaveText('playwright');
  // `Tests failed` already says it failed, so the row carries no exit-code badge.
  await expect(testRow.locator(':scope > summary .tool-trace-badge')).toHaveCount(0);
  await testRow.locator(':scope > summary').click();
  const summary = testRow.locator('.tool-test-summary');
  await expect(summary).toHaveAttribute('data-status', 'fail');
  await expect(summary.locator('.tool-test-pass')).toHaveText('13 passed');
  await expect(summary.locator('.tool-test-fail')).toHaveText('1 failed');
  await expect(summary.locator('.tool-test-failure')).toContainText('dictation keeps the caret');

  // The expanded image row shows the larger preview.
  await imageRow.locator(':scope > summary .tool-trace-verb').click();
  await expect(imageRow).toHaveAttribute('open', '');
  await expect(imageRow.locator('.tool-image-card img')).toHaveAttribute('src', /^data:image\//);
  // The row title names the file, so the card's caption carries only meta.
  await expect(imageRow.locator('.tool-image-card .tool-image-name')).toHaveCount(0);
  await sedRow.locator(':scope > summary .tool-trace-verb').click();
  await expect(sedRow).toHaveAttribute('open', '');
  if (process.env.TOOL_VISUALS_SHOT) {
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${SHOTS}/tool-visuals.png` });
  }
  expect(errors).toEqual([]);
});

test('a viewed image thumbnail opens a viewer that steps through the thread’s images', async ({ page }) => {
  const { imageRow, thumb, errors, viewer } = await openVisuals(page);
  // Clicking the thumbnail opens the viewer and leaves the row closed.
  await thumb.click();
  await expect(viewer).toBeVisible();
  const image = viewer.locator('.tool-image-viewer-image');
  await expect(image).toHaveAttribute('src', /^data:image\//);
  await expect(imageRow).not.toHaveAttribute('open', '');
  // Header: name, path, pixel size, and where this image sits among the thread's images.
  await expect(viewer.locator('.tool-image-viewer-name')).toHaveText('settings-dark.png');
  await expect(viewer.locator('.tool-image-viewer-path')).toHaveText(IMAGE_PATH);
  // A long path cuts in the middle: the folder ellipsizes and the file name stays whole.
  await expect(viewer.locator('.tool-image-viewer-path-tail')).toHaveText('settings-dark.png');
  const tail = await viewer.locator('.tool-image-viewer-path-tail').evaluate(node => node.scrollWidth <= node.clientWidth);
  expect(tail).toBe(true);
  await expect(viewer.locator('.tool-image-viewer-size')).toHaveText('320 × 200');
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('1 of 2');
  await expect(viewer.locator('[data-tool-image-action="prev"]')).toBeDisabled();

  // An image that already fits has nothing to zoom: Actual size stays disabled and the fit limits hold.
  const zoom = viewer.locator('[data-tool-image-action="zoom"]');
  await expect(zoom).toBeDisabled();
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  expect(await image.evaluate(node => getComputedStyle(node).maxWidth)).not.toBe('none');
  // The disabled zoom button wraps the image: the app-wide `button:disabled` fade must not dim it. The opacity the
  // reader sees is the product of the image's and every ancestor's up to the dialog.
  const seenOpacity = (node: Element) => {
    let opacity = 1;
    for (let at: Element | null = node; at && at.tagName !== 'DIALOG'; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
    return opacity;
  };
  expect(await zoom.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
  await expect.poll(() => image.evaluate(seenOpacity)).toBe(1);

  // → and the Next button step through; ← steps back.
  await page.keyboard.press('ArrowRight');
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('2 of 2');
  await expect(viewer.locator('.tool-image-viewer-name')).toHaveText('settings-light.png');
  await expect(viewer).toHaveAttribute('aria-label', 'settings-light.png');
  await expect(image).toHaveAttribute('src', /^data:image\//);
  await expect(viewer.locator('[data-tool-image-action="next"]')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('1 of 2');
  await viewer.locator('[data-tool-image-action="next"]').click();
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('2 of 2');

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(imageRow).not.toHaveAttribute('open', '');
  expect(errors).toEqual([]);
});

test('the image viewer copies the shown image’s path and reveals it', async ({ page }) => {
  const { thumb, errors, viewer } = await openVisuals(page);
  await thumb.click();
  await expect(viewer).toBeVisible();
  await viewer.locator('[data-tool-image-action="next"]').click();
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('2 of 2');

  // Copy path copies the image on show and says so.
  const copy = viewer.locator('[data-tool-image-action="copy"]');
  // The label slot is as wide as the wider of "Copy path" and "Copied" (no reserved blank), and the button never
  // moves or resizes when the label swaps. Layout boxes, not getBoundingClientRect: the click's press `scale` is still
  // easing back to 1 when the label swaps, and a scaled rect reads ~1px narrower under load.
  const copyBox = () => copy.evaluate(element => {
    const button = element as HTMLElement;
    const slot = button.querySelector<HTMLElement>('.tool-image-viewer-copy-label')!, text = slot.querySelector<HTMLElement>(':scope > span')!;
    return { x: button.offsetLeft, width: button.offsetWidth, blank: slot.offsetWidth - text.offsetWidth };
  });
  const idle = await copyBox();
  expect(idle.blank).toBeLessThanOrEqual(1);
  await copy.click();
  await expect(copy).toHaveText('Copied');
  const copied = await copyBox();
  expect({ x: copied.x, width: copied.width }).toEqual({ x: idle.x, width: idle.width });
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([SECOND_IMAGE_PATH]);
  await expect(copy).toHaveText('Copy path');
  const reveal = viewer.locator('[data-tool-image-action="reveal"]');
  await expect(reveal).toBeVisible();
  // The platform's wording, as in the file menus.
  const platform = await page.evaluate(() => navigator.platform);
  await expect(reveal).toHaveText(/Mac/i.test(platform) ? 'Reveal in Finder' : /Win/i.test(platform) ? 'Show in Explorer' : 'Open folder');
  await reveal.click();
  await expect(viewer.locator('.tool-image-viewer-notice')).toHaveText('');
  expect(errors).toEqual([]);
});

test('static and expandable tool rows share one icon column and one row height', async ({ page }) => {
  const card = await openSeeded(page, ROW_TOOLS);
  const rows = card.locator('.tool-trace');
  await expect(rows).toHaveCount(ROW_TOOLS.length);
  await expect(card.locator('.tool-trace[data-static]')).not.toHaveCount(0);
  const boxes = await rows.evaluateAll(nodes => nodes.map(row => {
    const icon = row.querySelector('.tool-trace-icon')!.getBoundingClientRect();
    const line = row.firstElementChild!.getBoundingClientRect();
    const verb = row.querySelector('.tool-trace-verb')!.getBoundingClientRect();
    return { text: (row.textContent ?? '').slice(0, 24), static: row.hasAttribute('data-static'), iconX: icon.x, iconWidth: icon.width, textX: verb.x, height: line.height };
  }));
  const [first] = boxes;
  for (const box of boxes) {
    expect(Math.abs(box.iconX - first.iconX), `icon x of ${box.text}`).toBeLessThanOrEqual(1);
    expect(box.iconWidth, `icon size of ${box.text}`).toBe(first.iconWidth);
    expect(Math.abs(box.textX - first.textX), `text x of ${box.text}`).toBeLessThanOrEqual(1);
    expect(box.height, `row height of ${box.text}`).toBe(first.height);
  }
});

// Images whose names differ wildly in length, one absolute (Reveal shows) and one relative (Reveal hides).
const STEP_TOOLS: SeedTool[] = [
  { id: 'step-short', name: 'Read', input: { file_path: '/tmp/a.png' }, output: '[Non-text content omitted]' },
  { id: 'step-long', name: 'Read', input: { file_path: 'test-results/a-very-long-screenshot-name-for-the-settings-page-in-dark-mode-at-1440-wide-with-the-sidebar-open-and-the-inspector-showing-changes.png' }, output: '[Non-text content omitted]' },
];

for (const theme of ['light', 'dark'] as const) {
  test(`the viewer's controls stay put while stepping (${theme})`, async ({ page }) => {
    const card = await openSeeded(page, STEP_TOOLS);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    // Thumbnails keep the thread that rendered them.
    const thumbs = card.locator('summary .tool-image-thumb');
    await expect(thumbs).toHaveCount(2);
    const sessionId = await page.evaluate(async () => (await import('/src/preview-traces.ts' as string)).GALLERY_ID as string);
    for (const thumb of await thumbs.all()) await expect(thumb).toHaveAttribute('data-tool-image-session', sessionId);
    await thumbs.first().click();
    const viewer = page.locator('dialog.tool-image-viewer');
    await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('1 of 2');
    await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
    const boxes = () => viewer.evaluate(dialog => Object.fromEntries(['prev', 'next', 'copy', 'close'].map(name => {
      const box = dialog.querySelector(`[data-tool-image-action="${name}"]`)!.getBoundingClientRect();
      return [name, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) }];
    })));
    const plate = () => viewer.locator('.tool-image-viewer-plate').evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; });
    const first = await boxes(), firstPlate = await plate();
    await viewer.locator('[data-tool-image-action="next"]').click();
    await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('2 of 2');
    await expect(viewer.locator('[data-tool-image-action="reveal"]')).toBeHidden();
    await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
    expect(await boxes()).toEqual(first);
    expect(await plate()).toEqual(firstPlate);
    // The long name ellipsizes inside the header instead of widening it.
    const name = viewer.locator('.tool-image-viewer-name');
    expect(await name.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis')).toBe(true);
  });
}

// The launcher window (`?view=launcher`) loads neither the app's stylesheets nor its `reveal_path` permission:
// its viewer has no Reveal button and is styled from the launcher's own tokens.
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC';
for (const theme of ['light', 'dark'] as const) {
  test(`the launcher's viewer has no Reveal and keeps its glass (${theme})`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 650, height: 610 });
    await page.addInitScript(value => { localStorage.setItem('pandacode.theme', value); }, theme);
    const tool = JSON.stringify({ type: 'tool_activity', version: 1, id: 'launcher-shot', name: 'Read', status: 'completed',
      input: JSON.stringify({ file_path: '/tmp/launcher-shot.png' }), output: '[Non-text content omitted]' });
    await page.route('**/src/overlay-client.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /if \(command === ["']overlay_preferences["']\)/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, `
        (window.__overlayCalls ??= []).push({command, args});
        if (command === 'tool_image') return ${JSON.stringify(PNG_URL)};
        if (command === 'reveal_path') throw new Error('not allowed in the launcher');
        if (command === 'overlay_thread') return { provider: 'claude', status: 'idle', hasOlder: false, liveText: '', messages: [
          { id: 1, sessionId: args.sessionId, role: 'user', content: 'Look at the screenshot', createdAt: 1 },
          { id: 2, sessionId: args.sessionId, role: 'tool', content: ${JSON.stringify(tool)}, createdAt: 2 },
          { id: 3, sessionId: args.sessionId, role: 'assistant', content: 'It shows the settings.', createdAt: 3 },
        ] };
        $&`) });
    });
    await page.goto('/?view=launcher');
    await page.locator('.launcher-task[data-task="preview-active"]').click();
    const history = page.locator('.launcher-thread-history');
    const thumb = history.locator('.tool-image-thumb').first();
    // The row sits in the turn's closed activity (and maybe a folded group): open them, outermost first. A
    // refresh of the thread may render the turn again, so this repeats until the thumbnail has loaded.
    const closed = history.locator('details:not([open]):is(.launcher-thread-activity,.tool-group):has(.tool-image-thumb) > summary');
    await expect(async () => {
      for (let tries = 0; tries < 4 && await closed.count(); tries++) await closed.first().click();
      await expect(thumb).toHaveClass(/is-loaded/, { timeout: 1000 });
    }).toPass();
    await thumb.click();
    const viewer = page.locator('dialog.tool-image-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveClass(/\bis-launcher\b/);
    await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', PNG_URL);
    await expect(viewer.locator('[data-tool-image-action="reveal"]')).toHaveCount(0);
    await expect(viewer.locator('[data-tool-image-action="copy"]')).toBeVisible();
    const look = await viewer.evaluate(dialog => {
      const plate = getComputedStyle(dialog.querySelector('.tool-image-viewer-plate')!);
      const copy = getComputedStyle(dialog.querySelector('[data-tool-image-action="copy"]')!);
      return { radius: plate.borderTopLeftRadius, fill: plate.backgroundColor, border: plate.borderTopWidth, blur: plate.backdropFilter || plate.getPropertyValue('-webkit-backdrop-filter'),
        copyHeight: copy.height, copyFill: copy.backgroundColor, copyShadow: copy.boxShadow };
    });
    expect(look.radius).toBe('16px');
    expect(look.border).toBe('1px');
    expect(look.fill).not.toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/);
    expect(look.blur).toContain('blur');
    expect(look.copyHeight).toBe('30px');
    expect(look.copyFill).not.toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/);
    expect(look.copyShadow).not.toBe('none');
    const calls = await page.evaluate(() => ((window as unknown as { __overlayCalls: { command: string }[] }).__overlayCalls).map(call => call.command));
    expect(calls).toContain('tool_image');
    expect(calls).not.toContain('reveal_path');
    // Esc closes the viewer only: the launcher stays on the conversation instead of going back to its list.
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(page.locator('.launcher-thread')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// Narrow windows: no row in the seeded thread grows past its box, and every badge and chevron stays inside it.
for (const width of [420, 760]) {
  test(`seeded rows fit their box and keep every badge inside it (${width}px)`, async ({ page }) => {
    // Opened wide (the sidebar hides at phone width), then narrowed.
    const card = await openSeeded(page);
    await page.setViewportSize({ width, height: 900 });
    // A failed check carries no exit badge any more; its count still sits on the right of the row.
    await expect(card.locator('details.tool-trace[data-tool-key="tool:visual-tests"] > summary .tool-trace-verb')).toHaveText('Tests failed');
    const overflows = await card.locator('.tool-trace > :is(summary, .tool-trace-summary)').evaluateAll(rows => rows.flatMap(row => {
      const box = row.getBoundingClientRect();
      if (!box.width) return [];
      const room = row.parentElement!.parentElement!.getBoundingClientRect();
      const fixed = [...row.querySelectorAll<HTMLElement>(':scope > :is(.tool-trace-badge, .tool-trace-chevron, .tool-trace-delta)')];
      const bad = box.right > room.right + 0.5 || row.scrollWidth > Math.ceil(box.width) + 1
        || fixed.some(mark => { const rect = mark.getBoundingClientRect(); return !rect.width || rect.left < box.left - 0.5 || rect.right > box.right + 0.5; });
      return bad ? [`${row.textContent!.replace(/\s+/g, ' ').trim()} (content ${row.scrollWidth}px, row ${Math.round(box.width)}px)`] : [];
    }));
    expect(overflows).toEqual([]);
  });
}

// At phone width the viewer's actions go icon-only (named by aria-label/title) so the file name keeps its room.
test('the viewer header keeps the file name visible at 420px', async ({ page }) => {
  const card = await openSeeded(page);
  await page.setViewportSize({ width: 420, height: 800 });
  await card.locator('summary .tool-image-thumb').first().click();
  const viewer = page.locator('dialog.tool-image-viewer');
  await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
  const name = viewer.locator('.tool-image-viewer-name');
  await expect(name).toBeVisible();
  expect((await name.boundingBox())!.width).toBeGreaterThan(40);
  for (const action of ['reveal', 'copy']) {
    const button = viewer.locator(`[data-tool-image-action="${action}"]`);
    await expect(button).toBeVisible();
    expect(await button.getAttribute('aria-label')).toBeTruthy();
    const box = (await button.boundingBox())!, plate = (await viewer.locator('.tool-image-viewer-plate').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(plate.x + plate.width + 0.5);
  }
});
