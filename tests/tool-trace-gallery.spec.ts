import { expect, test, type Page } from '@playwright/test';

// Review gallery for tool traces: every family renders its specific verb, then full-page shots for design review.
const OUT = 'test-results/trace-gallery';

for (const theme of ['light', 'dark'] as const) {
  test(`tool trace gallery renders every family (${theme})`, async ({ page }) => {
    await page.goto(`/tool-trace-gallery.html?theme=${theme}`);
    await expect(page.locator('body[data-ready="true"]')).toBeAttached();
    const sections = page.locator('section[data-gallery-family]');
    expect(await sections.count()).toBeGreaterThanOrEqual(7);
    for (const section of await sections.all()) {
      const expected = (await section.getAttribute('data-expect'))!.split('|');
      const verbs = await section.locator('.tool-trace > :is(summary, .tool-trace-summary) > .tool-trace-verb').allTextContents();
      expect(verbs, await section.getAttribute('data-gallery-family') ?? '').toEqual(expected);
    }
    // PandaCode tools never fall back to the generic `Used [PandaCode] …` row.
    await expect(page.locator('.tool-trace[data-tool-name*="pandacode"] .tool-trace-chip', { hasText: /^PandaCode$/ })).toHaveCount(0);
    for (const family of ['team', 'task', 'vm', 'simulator', 'design', 'browser', 'cloud', 'code', 'bot', 'jev', 'agent', 'mcp']) {
      await expect(page.locator(`.tool-trace[data-tool-family="${family}"]`).first()).toBeVisible();
    }
    await expect(page.locator('.tool-trace-roster > li').first()).toBeVisible();
    await expect(page.locator('.tool-trace-bubble').first()).toBeVisible();
    await expect(page.locator('.tool-trace-kv').first()).toBeVisible();
    // Rows stay one line.
    for (const summary of await page.locator('.tool-trace > :is(summary, .tool-trace-summary)').all()) {
      expect((await summary.boundingBox())!.height).toBeLessThan(34);
    }
    await page.screenshot({ path: `${OUT}/${theme}.png`, fullPage: true });
  });
}

test('tool trace gallery collapsed groups', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html?collapsed=1');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  await expect(page.locator('.tool-group[open]')).toHaveCount(0);
  await expect(page.locator('.tool-group-label').first()).toHaveText('Coordinated with the team 8 times');
  await expect(page.locator('.tool-group-summary').first().locator('.tool-group-status')).toHaveText([' · 1 running']);
  // Rows with nothing beyond the sentence are plain lines, not empty disclosures.
  await expect(page.locator('.tool-trace[data-static] summary, .tool-trace[data-static] .tool-trace-chevron')).toHaveCount(0);
  expect(await page.locator('.tool-trace[data-static]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/collapsed.png`, fullPage: true });
});

for (const width of [420, 1100, 1440]) {
  test(`group headers ellipsize the sentence and keep every tally inside the header (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tool-trace-gallery.html?collapsed=1');
    await expect(page.locator('body[data-ready="true"]')).toBeAttached();
    const headers = await page.locator('section[data-gallery-family] .tool-group-summary').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), room = node.closest('section')!.getBoundingClientRect();
      const label = node.querySelector<HTMLElement>('.tool-group-label')!;
      const tallies = [...node.querySelectorAll<HTMLElement>('.tool-group-status')].map(tally => {
        const rect = tally.getBoundingClientRect();
        return rect.width > 0 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && tally.scrollWidth <= Math.ceil(rect.width);
      });
      return { text: node.textContent, inside: box.right <= room.right + 0.5, lines: Math.round(box.height / 30), cut: label.scrollWidth > label.clientWidth, tallies };
    }));
    expect(headers.some(header => header.tallies.length > 1)).toBe(true);
    for (const header of headers) {
      expect(header.tallies.every(Boolean), header.text!).toBe(true);
      expect(header.inside, header.text!).toBe(true);
      // One line while the gallery has room; at phone width the tallies may take a second line, never more.
      expect(header.lines, header.text!).toBeLessThanOrEqual(width === 420 ? 2 : 1);
    }
    // A long sentence is cut by CSS (its tallies above stayed whole).
    expect(headers.some(header => header.cut && header.tallies.length)).toBe(true);
  });
}

test('gallery thumbnails load from the preview loader and open the viewer', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const thumb = page.locator('button.tool-image-thumb[data-tool-image]').first();
  // Thumbnails load once near the viewport.
  await thumb.scrollIntoViewIfNeeded();
  await expect(thumb.locator('img')).toHaveAttribute('src', /^data:image\/svg/);
  await thumb.click();
  const viewer = page.locator('dialog.tool-image-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
  await expect(viewer.locator('.tool-image-viewer-path-tail')).toHaveText('rows.png');
});

test('the destructive badge is reachable and reading it never toggles its row; mono objects sit a step smaller', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const row = page.locator('details.tool-trace:has(.tool-trace-badge[data-trace-badge])').first();
  const badge = row.locator('.tool-trace-badge[data-trace-badge]');
  await expect(badge).toHaveAttribute('tabindex', '0');
  await expect(badge).toHaveAttribute('aria-label', /^Destructive: \S/);
  const open = await row.evaluate(details => (details as HTMLDetailsElement).open);
  await badge.click();
  expect(await row.evaluate(details => (details as HTMLDetailsElement).open)).toBe(open);
  await badge.focus();
  await expect(badge).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await row.evaluate(details => (details as HTMLDetailsElement).open)).toBe(open);
  // Clicking the rest of the row still toggles it.
  await row.locator(':scope > summary > .tool-trace-verb').click();
  expect(await row.evaluate(details => (details as HTMLDetailsElement).open)).toBe(!open);
  const mono = page.locator('.tool-trace > summary .tool-trace-object.is-mono').first();
  const ratio = await mono.evaluate(object => parseFloat(getComputedStyle(object).fontSize) / parseFloat(getComputedStyle(object.parentElement!).fontSize));
  expect(ratio).toBeCloseTo(0.9, 2);
});

test('the destructive badge shows its risks in an in-app tooltip on hover and keyboard focus, without moving the row', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const badge = page.locator('.tool-trace-badge[data-trace-badge]').first();
  await expect(badge).not.toHaveAttribute('title', /.*/);
  const risks = JSON.parse((await badge.getAttribute('data-trace-risks'))!) as string[];
  expect(risks.length).toBeGreaterThan(0);
  const tip = page.locator('.tool-trace-tip');
  await badge.scrollIntoViewIfNeeded();
  const before = await badge.boundingBox();
  await badge.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(badge).toBeFocused();
  // A focus ring on plain :focus too, not only :focus-visible.
  expect(await badge.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  await expect(tip).toHaveAttribute('data-open', '');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.tool-trace-tip-line')).toHaveCount(risks.length);
  await expect(tip).toHaveAttribute('aria-hidden', 'true');
  expect(await badge.boundingBox()).toEqual(before);
  // Glass from the shared tokens, at most 360px wide, inside the viewport, and never over its own badge.
  const box = (await tip.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width).toBeLessThanOrEqual(360);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.y >= before!.y + before!.height || box.y + box.height <= before!.y).toBe(true);
  expect(await tip.evaluate(node => getComputedStyle(node).borderTopWidth)).toBe('1px');
  await page.mouse.move(0, 0);
  await badge.blur();
  await expect(tip).not.toHaveAttribute('data-open', /.*/);
  await badge.hover();
  await expect(tip).toHaveAttribute('data-open', '');
  await page.screenshot({ path: `${OUT}/badge-tooltip.png`, clip: { x: Math.max(0, before!.x - 40), y: Math.max(0, before!.y - 20), width: 480, height: 160 } });
});

test('the tooltip wraps between words, one line per risk, and flips above near the bottom', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const badge = page.locator('.tool-trace-badge[data-trace-badge]').first();
  const long = ['Deleted files: rm -rf ./build ./dist ./coverage ./node_modules/.cache --no-preserve-root --one-file-system', 'Force-pushed: git push --force-with-lease origin main'];
  await badge.evaluate((node, risks) => { node.setAttribute('data-trace-risks', JSON.stringify(risks)); }, long);
  // Put the badge near the bottom of the viewport.
  const view = page.viewportSize()!;
  await badge.evaluate((node, height) => { const y = node.getBoundingClientRect().bottom; window.scrollBy(0, y - (height - 24)); }, view.height);
  await badge.hover();
  const tip = page.locator('.tool-trace-tip');
  await expect(tip).toHaveAttribute('data-placement', 'above');
  const lines = tip.locator('.tool-trace-tip-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.first().locator('.tool-trace-tip-reason')).toHaveText('Deleted files');
  expect(await lines.first().locator('code').evaluate(node => getComputedStyle(node).fontFamily)).not.toBe(await lines.first().locator('.tool-trace-tip-reason').evaluate(node => getComputedStyle(node).fontFamily));
  // Every flag stays on one line: a word's box is one line tall.
  for (const word of await tip.locator('.tool-trace-tip-word:not(.is-long)').all()) {
    const rects = await word.evaluate(node => node.getClientRects().length);
    expect(rects).toBe(1);
  }
  expect((await tip.boundingBox())!.width).toBeLessThanOrEqual(360);
  const tipBox = (await tip.boundingBox())!;
  const badgeBox = (await badge.boundingBox())!;
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(badgeBox.y);
});

test('a failed command card keeps its exit badge clear of the raw `</>` button', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const row = page.locator('details.tool-trace[data-tool-failed]', { has: page.locator('.tool-trace-frame .tc-badge.is-failed, .tool-trace-frame .tool-trace-badge.is-failed') }).filter({ hasNot: page.locator('.tool-test-summary') }).first();
  if (await row.getAttribute('open') === null) await row.locator(':scope > summary > .tool-trace-verb').click();
  const frame = row.locator('.tool-trace-frame');
  await frame.hover();
  const exit = frame.locator('.tc-badge.is-failed, .tool-trace-badge.is-failed').first();
  await expect(exit).toHaveText(/^exit \d+$/);
  const raw = frame.locator(':scope > .tool-trace-raw > summary');
  await expect(raw).toBeVisible();
  const [a, b] = [(await exit.boundingBox())!, (await raw.boundingBox())!];
  const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap, JSON.stringify({ exit: a, raw: b })).toBe(false);
});

test('a blocked call reads quietly and its card shows the reason without tags', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const row = page.locator('.tool-trace[data-tool-blocked]').first();
  await expect(row.locator(':scope > summary > .tool-trace-verb')).toHaveText('Blocked:');
  // The refused command reads like every shell row: its program in a chip, the rest mono.
  await expect(row.locator(':scope > summary > .tool-trace-chip')).toHaveText('sleep');
  await expect(row.locator(':scope > summary > .tool-trace-object')).toHaveText('60');
  await expect(row.locator(':scope > summary > .tool-trace-more-steps')).toContainText('+1 more command');
  await expect(row).not.toHaveAttribute('data-tool-failed', /.*/);
  const colors = await row.evaluate(node => {
    const verb = node.querySelector(':scope > summary > .tool-trace-verb')!;
    const failed = document.querySelector('.tool-trace[data-tool-failed] > summary > .tool-trace-verb');
    return { blocked: getComputedStyle(verb).color, failed: failed ? getComputedStyle(failed).color : '' };
  });
  expect(colors.failed).not.toBe('');
  expect(colors.blocked).not.toBe(colors.failed);
  // Its shield takes the warning tone, so a refusal is not missed beside a failure's red.
  const tints = await row.evaluate(node => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ds-warn)';
    node.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    const failedIcon = document.querySelector('.tool-trace[data-tool-failed] > summary > .icon:first-child');
    return { icon: getComputedStyle(node.querySelector(':scope > summary > .icon:first-child')!).color, warn, failed: failedIcon ? getComputedStyle(failedIcon).color : '' };
  });
  expect(tints.icon).toBe(tints.warn);
  expect(tints.icon).not.toBe(tints.failed);
  await expect(row.locator('.tool-trace-note.is-blocked')).toHaveText(/^To wait for a condition/);
  await expect(row.locator('.tool-trace-note.is-blocked')).not.toContainText('Blocked:');
  // The same terminal as every shell card: a `$` prompt and the command in the same mono type.
  await expect(row.locator('.tc-term.is-blocked .tc-dollar')).toHaveText('$');
  await expect(row.locator('.tc-term.is-blocked .tc-command')).toHaveText('sleep 60; cat /tmp/r19-tsc.txt');
  const type = (selector: string) => page.locator(selector).first().evaluate(node => { const style = getComputedStyle(node); return `${style.fontFamily} ${style.fontSize}`; });
  expect(await type('.tc-term.is-blocked .tc-command')).toBe(await type('.tc-term:not(.is-blocked) .tc-command'));
  await expect(row.locator('.tool-trace-card, .tool-trace-inline').first()).not.toContainText('tool_use_error');
  await expect(page.locator('.tool-group-status.is-blocked').first()).toHaveText(' · 1 blocked');
});

test('Escape closes the risk tooltip while the badge keeps focus', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const badge = page.locator('.tool-trace-badge[data-trace-badge]').first();
  const tip = page.locator('.tool-trace-tip');
  await badge.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(badge).toBeFocused();
  await expect(tip).toHaveAttribute('data-open', '');
  await page.keyboard.press('Escape');
  await expect(tip).not.toHaveAttribute('data-open', /.*/);
  await expect(badge).toBeFocused();
});

test('failed compounds keep their lead verb, empty greps are no matches, destructive rows open to their command', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const compound = page.locator('.tool-trace[data-tool-name="Bash"]', { hasText: 'main.ts' }).first();
  await expect(compound.locator(':scope > summary > .tool-trace-badge.is-failed')).toHaveText('exit 2');
  await expect(compound.locator(':scope > summary > .tool-trace-badge.is-failed')).toHaveAttribute('title', 'Then failed with exit 2');
  const search = page.locator('.tool-trace', { hasText: 'zzzNeverThere' });
  await expect(search).not.toHaveAttribute('data-tool-failed', /.*/);
  // `Searched for “x” in [src] · no matches`: the tally follows the place chip.
  await expect(search.locator('.tool-trace-object').last()).toHaveText('· no matches');
  // Coloured by its outcome, not its recorded `failed` status: neither the verb nor the icon is the danger colour.
  const danger = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
  await expect(search).toHaveAttribute('data-tool-status', 'completed');
  for (const part of ['.tool-trace-verb', '.tool-trace-icon']) {
    const color = await search.locator(`:scope > :is(summary, .tool-trace-summary) > ${part}`).evaluate(node => getComputedStyle(node).color);
    expect(color, part).not.toBe(danger);
  }
  // A Claude-shaped failed compound whose tests passed: its runner's chip, the exit badge, the Codex-style card header.
  const compound2 = page.locator('details.tool-trace[data-tool-failed]', { hasText: 'TSC_OK' }).first();
  await expect(compound2.locator(':scope > summary > .tool-trace-verb')).toHaveText('Ran tests');
  await expect(compound2.locator(':scope > summary > .tool-trace-chip')).toHaveText('cargo test');
  await expect(compound2.locator(':scope > summary > .tool-trace-badge.is-failed')).toHaveText('exit 1');
  await expect(compound2.locator('.tool-test-runner')).toHaveText('cargo');
  await expect(compound2.locator('.tc-badge.is-failed')).toHaveText('exit 1');
  await expect(compound2.locator('.tc-term-out')).not.toContainText('Exit code');
  // Every row opens on this page; a destructive one with no output still has a card to open to.
  const clean = page.locator('details.tool-trace', { hasText: 'untracked files' });
  await expect(clean).toHaveAttribute('open', '');
  await expect(clean.locator('.tc-command')).toHaveText('git clean -fdx');
  await expect(page.locator('.tool-trace', { hasText: 'Typecheck failed' }).locator('.tool-trace-object')).toHaveText('· 2 errors');
});

// A turn whose folded header carries failure and blocked tallies, seeded into the preview's Tool gallery thread.
const TALLY_TOOLS = [
  { id: 'tally-read', name: 'Bash', status: 'completed', input: { command: "sed -n '1,40p' src/a-rather-long-module-name-for-the-header.ts" }, output: 'x' },
  { id: 'tally-search', name: 'Bash', status: 'completed', input: { command: 'rg "renderToolActivity" src tests docs scripts' }, output: 'src/a.ts:1:x' },
  { id: 'tally-ls', name: 'Bash', status: 'completed', input: { command: 'ls src/components/very/long/path/to/a/folder' }, output: 'a' },
  { id: 'tally-edit', name: 'Edit', status: 'completed', input: { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }, output: '' },
  { id: 'tally-fail-1', name: 'Bash', status: 'failed', input: { command: 'git push' }, output: 'Exit code 1\nrejected' },
  { id: 'tally-fail-2', name: 'Bash', status: 'failed', input: { command: 'npm publish' }, output: 'Exit code 1\nE403' },
  { id: 'tally-blocked', name: 'Bash', status: 'failed', input: { command: 'sleep 60; cat /tmp/x.txt' }, output: '<tool_use_error>Blocked: sleep 60 followed by: cat /tmp/x.txt. To wait for a condition, use Monitor.</tool_use_error>' },
];

test('the folded turn header keeps its failed and blocked tallies whole at 900px (wrapping before the sentence cuts)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/?trace');
  await page.evaluate(async ({ tools }) => {
    const traces = await import('/src/preview-traces.ts' as string);
    const sessionId = traces.GALLERY_ID as string;
    const at = Date.now() - 20_000;
    traces.galleryMessages.push(
      { id: 8899, sessionId, role: 'user', content: 'Ship it.', createdAt: at - 1000 },
      ...tools.map((tool, index) => ({ id: 8901 + index, sessionId, role: 'tool', createdAt: at + (index + 1) * 100,
        content: JSON.stringify({ type: 'tool_activity', version: 1, id: tool.id, name: tool.name, status: tool.status, input: JSON.stringify(tool.input), output: tool.output }) })),
      { id: 8990, sessionId, role: 'assistant', content: 'Two steps failed.', createdAt: at + 1000 },
    );
  }, { tools: TALLY_TOOLS });
  await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
  const label = page.locator('.turn-card').last().locator('details.turn-activity > summary .turn-activity-label');
  await expect(label.locator('.tool-group-status')).toHaveText([' · 2 failed', ' · 1 blocked']);
  // The separators keep their spaces as rendered (an inline-flex parent once collapsed them: `1 failed· 1 blocked`); a
  // tally that wrapped onto the next line has nothing before it to measure from.
  const gaps = await label.locator('.tool-group-status').evaluateAll(tallies => tallies.flatMap(tally => {
    const range = document.createRange();
    const text = tally.querySelector('.tool-group-sep')!.firstChild!;
    range.setStart(text, text.textContent!.indexOf('·'));
    range.setEnd(text, text.textContent!.indexOf('·') + 1);
    const before = tally.previousElementSibling!.getBoundingClientRect();
    const dot = range.getBoundingClientRect();
    return Math.abs(dot.top - before.top) < before.height / 2 ? [dot.left - before.right] : [];
  }));
  for (const gap of gaps) expect(gap, JSON.stringify(gaps)).toBeGreaterThanOrEqual(2);
  const fits = await label.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('.tool-group-status')].map(tally => {
      const rect = tally.getBoundingClientRect();
      return rect.width > 0 && rect.right <= box.right + 0.5 && tally.scrollWidth <= Math.ceil(rect.width);
    });
  });
  expect(fits).toEqual([true, true]);
  const sentence = label.locator('.trace-summary-sentence');
  await expect(sentence).toHaveCSS('text-overflow', 'ellipsis');
  // The marks give way first: the sentence keeps its whole text, or at least 60% of the label, before it truncates.
  const room = await label.evaluate(node => {
    const words = node.querySelector<HTMLElement>('.trace-summary-sentence')!;
    return { shown: words.clientWidth, full: words.scrollWidth, label: node.getBoundingClientRect().width };
  });
  expect(room.shown, JSON.stringify(room)).toBeGreaterThanOrEqual(Math.min(room.full, room.label * 0.6) - 1);
  await page.screenshot({ path: `${OUT}/folded-tallies-900.png`, clip: { x: 0, y: 0, width: 900, height: 800 } });
});

const SHORT_TOOLS = [
  { id: 'short-push', name: 'Bash', status: 'completed', input: { command: 'git push origin main' }, output: 'main -> main' },
  { id: 'short-checkout', name: 'Bash', status: 'completed', input: { command: 'git checkout -b feat/x' }, output: '' },
  { id: 'short-sed', name: 'Bash', status: 'completed', input: { command: "sed -n '1,40p' src/a.ts" }, output: 'x' },
  { id: 'short-force', name: 'Bash', status: 'completed', input: { command: 'git push --force origin main' }, output: '' },
  { id: 'short-failed', name: 'Bash', status: 'failed', input: { command: 'git push origin main && git status' }, output: 'Exit code 1\nrejected' },
  { id: 'short-described', name: 'Bash', status: 'completed', input: { command: 'git push origin main', description: 'Push main' }, output: 'ok' },
];
async function seedTurn(page: Page, tools: typeof SHORT_TOOLS, firstId: number): Promise<void> {
  await page.evaluate(async ({ tools, firstId }) => {
    const traces = await import('/src/preview-traces.ts' as string);
    const sessionId = traces.GALLERY_ID as string;
    const at = Date.now() - 20_000;
    traces.galleryMessages.push(
      { id: firstId, sessionId, role: 'user', content: 'Push it.', createdAt: at - 1000 },
      ...tools.map((tool, index) => ({ id: firstId + 1 + index, sessionId, role: 'tool', createdAt: at + (index + 1) * 100,
        content: JSON.stringify({ type: 'tool_activity', version: 1, id: tool.id, name: tool.name, status: tool.status, input: JSON.stringify(tool.input), output: tool.output }) })),
      { id: firstId + 50, sessionId, role: 'assistant', content: 'Pushed.', createdAt: at + 1000 },
    );
  }, { tools, firstId });
}

// A short mono object (`origin main`) never ellipsizes while its row still has room to grow.
for (const width of [900, 1440]) {
  test(`short tool-row objects are never cut while space remains (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?trace');
    await seedTurn(page, SHORT_TOOLS, 9100);
    await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
    const card = page.locator('.turn-card').last();
    const trace = card.locator('details.turn-activity');
    if (await trace.getAttribute('open') === null) await trace.locator(':scope > summary').click();
    // `Pushed [origin main]`: the chip that would repeat the verb (`git push`) gives way to what was pushed.
    await expect(card.locator(':is(.tool-trace-object, .tool-trace-chip)', { hasText: /^origin main$/ }).first()).toBeVisible();
    // The same row with a long quote after it, at the steps rail's 556px cap: the quote gives way, the object never does.
    await card.locator('.tool-activity.tool-trace').first().evaluate(async node => {
      const { traceRowHtml } = await import('/src/tool-trace.ts' as string);
      const note = 'Push the branch so the reviewer sees the latest commits before the release goes out tonight';
      const row = traceRowHtml({ kind: 'shell', verb: 'Pushed', chip: { icon: 'branch', label: 'git push', title: 'git push origin main' }, object: 'origin main', mono: true, note });
      node.insertAdjacentHTML('afterend', `<div class="tool-activity tool-trace" data-tool-status="completed" data-tool-kind="shell" data-static data-probe><div class="tool-trace-summary">${row}</div></div>`);
    });
    const probe = card.locator('[data-probe] .tool-trace-object');
    expect(await probe.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(card.locator('[data-probe] .tool-trace-quote')).toHaveCSS('text-overflow', 'ellipsis');
    // While the path can still give way, `+N more commands` and the result (`· 1 passed`) stay whole; only the path ellipsizes.
    await card.locator('.tool-activity.tool-trace').first().evaluate(async node => {
      const { traceRowHtml } = await import('/src/tool-trace.ts' as string);
      const row = traceRowHtml({ kind: 'shell', verb: 'Ran tests', chip: { icon: 'play', label: 'playwright', title: 'npx playwright test' },
        object: 'tests/tool-trace-gallery.spec.ts · 1 passed', mono: true, more: '+12 more commands' });
      node.insertAdjacentHTML('afterend', `<div class="tool-activity tool-trace" data-tool-status="completed" data-tool-kind="shell" data-static data-more-probe><div class="tool-trace-summary">${row}</div></div>`);
    });
    const objects = card.locator('[data-more-probe] .tool-trace-object');
    expect(await objects.last().evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(objects.last()).toHaveText(' · 1 passed');
    const more = card.locator('[data-more-probe] .tool-trace-more-steps');
    expect(await more.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const cut =await card.locator('.tool-trace > :is(summary, .tool-trace-summary)').evaluateAll(rows => rows.flatMap(row => {
      // Room up to the row's own cap (the steps rail ends rows where their card ends).
      const max = getComputedStyle(row).maxWidth;
      // `556px` or `min(556px, 100%)`: the pixel cap (the percentage is the parent's width, measured below).
      const cap = /([\d.]+)px/.test(max) ? parseFloat(/([\d.]+)px/.exec(max)![1]) : Infinity;
      const room = Math.min((row.parentElement as HTMLElement).clientWidth, cap) - row.getBoundingClientRect().width;
      return [...row.querySelectorAll<HTMLElement>(':scope > :is(.tool-trace-object, .tool-trace-quote)')]
        .filter(node => node.scrollWidth > node.clientWidth + 1 && room > 2)
        .map(node => `${node.textContent} (${node.scrollWidth} > ${node.clientWidth}, room ${Math.round(room)})`);
    }));
    expect(cut).toEqual([]);
  });
}

test('piped failures, refusals, diffs, stopped servers and program lists read as what happened', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  // A piped run that exited 0 but printed failures is a failure: red, counted, and no misleading exit badge.
  const piped = page.locator('.tool-trace', { hasText: '2 of 16' });
  await expect(piped).toHaveAttribute('data-tool-failed', '');
  await expect(piped.locator(':scope > summary > .tool-trace-verb')).toHaveText('Tests failed');
  await expect(piped.locator(':scope > summary > .tool-trace-badge')).toHaveCount(0);
  // A denial names the refused command and carries no badge: nothing ran.
  const denied = page.locator('.tool-trace[data-tool-blocked]', { hasText: 'left-pad' });
  await expect(denied.locator(':scope > :is(summary, .tool-trace-summary) > .tool-trace-chip')).toHaveText('npm');
  await expect(denied.locator(':scope > :is(summary, .tool-trace-summary) > .tool-trace-object')).toHaveText('install left-pad');
  await expect(denied.locator(':scope > :is(summary, .tool-trace-summary) > .tool-trace-more-steps')).toContainText(/\+\d+ more commands?/);
  // An interrupted run is quiet, never red; a command that never started names it; a failed edit says why.
  const interrupted = page.locator('.tool-trace[data-tool-interrupted]').first();
  await expect(interrupted.locator(':scope > summary > .tool-trace-verb')).toHaveText('Interrupted:');
  await expect(interrupted).not.toHaveAttribute('data-tool-failed', /.*/);
  await expect(interrupted.locator('.tool-trace-note.is-interrupted')).toHaveText('Interrupted before it reported a result.');
  await expect(page.locator('.tool-trace', { hasText: "Couldn't start" }).locator(':scope > summary > .tool-trace-chip')).toHaveText('cat');
  const edit = page.locator('.tool-trace', { hasText: 'design.tsx' }).first();
  await expect(edit.locator(':scope > summary > .tool-trace-reason')).toHaveText('· string to replace not found');
  // The row already gives the reason, so the card doesn't repeat it.
  await expect(edit.locator('.tool-trace-why')).toHaveCount(0);
  await expect(denied.locator('.tool-trace-badge')).toHaveCount(0);
  // `git diff` output opens in the coloured diff card under its command line.
  const diff = page.locator('details.tool-trace', { hasText: 'tool-text.ts' }).filter({ has: page.locator('.tc-diff-file') });
  await expect(diff.locator('.tc-command')).toHaveText('git diff src/tool-text.ts');
  await expect(diff.locator('.tc-diff-line[data-sign="add"]')).toHaveCount(1);
  await expect(diff.locator('.tc-diff-line[data-sign="del"]')).toHaveCount(1);
  // Four-digit line numbers widen both gutters, so `3414` never runs into its neighbour.
  await expect(diff.locator('pre.tc-diff')).toHaveAttribute('data-digits', '4');
  const overflow = await diff.locator('.tc-gutter').evaluateAll(gutters => gutters.filter(g => g.scrollWidth > g.clientWidth + 0.5).length);
  expect(overflow).toBe(0);
  // A server stopped by a signal is neutral.
  const stopped = page.locator('.tool-trace', { hasText: '(terminated)' });
  await expect(stopped).not.toHaveAttribute('data-tool-failed', /.*/);
  await expect(stopped).toHaveAttribute('data-tool-status', 'completed');
  // A program list's comma sits right against the chip before it.
  const programs = page.locator('.tool-trace', { hasText: 'in ./src' }).filter({ has: page.locator('.tool-trace-join.is-comma') }).first();
  const gap = await programs.locator('.tool-trace-join.is-comma').first().evaluate(comma => comma.getBoundingClientRect().left - comma.previousElementSibling!.getBoundingClientRect().right);
  expect(gap).toBeLessThanOrEqual(0.5);
  // The folded header tallies the piped failure.
  await expect(page.locator('section[data-gallery-family] .tool-group-status.has-failure').first()).toBeVisible();
});

// Every saved tally at once beside a long sentence: the tallies wrap or compress before the sentence gives up its words.
const ALL_TALLY_TOOLS = [
  ...SHORT_TOOLS.slice(0, 4),
  { id: 'all-read', name: 'Read', status: 'completed', input: { file_path: 'src/a-rather-long-module-name-for-the-header.ts' }, output: 'x' },
  { id: 'all-web', name: 'WebSearch', status: 'completed', input: { query: 'tauri updater' }, output: 'Links: []' },
  { id: 'all-edit', name: 'Edit', status: 'completed', input: { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }, output: '' },
  ...TALLY_TOOLS.slice(4),
  { id: 'all-denied', name: 'Bash', status: 'failed', input: { command: 'rm -rf old-site' }, output: 'Permission to use Bash with command rm -rf old-site has been denied.' },
  { id: 'all-interrupted', name: 'Bash', status: 'failed', input: { command: 'npm test' }, output: '\n\n[The turn ended before this tool reported a result.]' },
];

for (const width of [900, 1440]) {
  test(`the folded header's sentence keeps its first 40 characters beside every tally (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?trace');
    await seedTurn(page, ALL_TALLY_TOOLS, 9300);
    await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
    const label = page.locator('.turn-card').last().locator('details.turn-activity > summary .turn-activity-label');
    await expect(label.locator('.tool-group-status')).toHaveText([' · 2 failed', ' · 1 blocked', ' · 1 denied', ' · 1 interrupted']);
    const room = await label.evaluate(node => {
      const words = node.querySelector<HTMLElement>('.trace-summary-sentence')!;
      const text = words.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(40, text.textContent!.length));
      const box = node.getBoundingClientRect();
      const tallies = [...node.querySelectorAll<HTMLElement>('.tool-group-status')].map(tally => {
        const rect = tally.getBoundingClientRect();
        return rect.width > 0 && rect.right <= box.right + 0.5 && tally.scrollWidth <= Math.ceil(rect.width);
      });
      return { first40: range.getBoundingClientRect().width, shown: words.clientWidth, text: text.textContent, tallies };
    });
    expect(room.shown, JSON.stringify(room)).toBeGreaterThanOrEqual(room.first40 - 1);
    expect(room.tallies).toEqual([true, true, true, true]);
    // A tally that wrapped never starts its line with `·`: its separator sits on the line of the item before it, or hangs
    // left of the clipped edge.
    const seps = await label.locator('.trace-summary-text').evaluate(box => {
      const edge = box.getBoundingClientRect().left;
      return [...box.querySelectorAll<HTMLElement>('.tool-group-sep')].map(sep => {
        const rect = sep.getBoundingClientRect();
        const before = sep.parentElement!.previousElementSibling!.getBoundingClientRect();
        return rect.right <= edge + 0.5 || Math.abs(rect.top - before.top) < before.height / 2;
      });
    });
    expect(seps).toEqual([true, true, true, true]);
    await page.screenshot({ path: `${OUT}/folded-all-tallies-${width}.png`, clip: { x: 0, y: 0, width, height: 900 } });
  });
}

test('long row objects carry their whole text and ellipsize in CSS, never with a JS `…` (1440px)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?trace');
  const pattern = 'renderToolActivity|summarizeTools|describeTool|traceRowHtml|groupTallies|summaryIcons|toolPreview|foldedLabelHtml';
  const prompt = 'Find every caller of the folded header and report which ones still clip their tallies before the sentence does';
  await seedTurn(page, [
    { id: 'long-grep', name: 'Grep', status: 'completed', input: { pattern, path: 'src' }, output: 'src/a.ts:1:x' },
    { id: 'long-agent', name: 'Task', status: 'completed', input: { subagent_type: 'Explore', description: prompt }, output: 'done' },
    { id: 'long-short', name: 'Bash', status: 'completed', input: { command: 'git push origin main' }, output: 'ok' },
  ] as typeof SHORT_TOOLS, 9400);
  await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
  const card = page.locator('.turn-card').last();
  const trace = card.locator('details.turn-activity');
  if (await trace.getAttribute('open') === null) await trace.locator(':scope > summary').click();
  const objects = card.locator('.tool-trace > :is(summary, .tool-trace-summary) > .tool-trace-object');
  await expect(objects.filter({ hasText: pattern })).toHaveCount(1);
  await expect(objects.filter({ hasText: prompt })).toHaveCount(1);
  const rows = await objects.evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent ?? '', overflow: getComputedStyle(node).textOverflow, cut: node.scrollWidth > node.clientWidth + 1,
  })));
  for (const row of rows) {
    expect(row.text.endsWith('…'), row.text).toBe(false);
    expect(row.overflow).toBe('ellipsis');
  }
  // The long ones are wider than the row's cap, so CSS is what cuts them.
  expect(rows.filter(row => row.cut).length).toBeGreaterThanOrEqual(1);
});

// Narrow widths: a row never grows past its box, and its badges, exit codes and chevron stay inside it. The object
// ellipsizes first, then the `+N more` tail, then the chip; the trailing marks never shrink.
async function rowOverflows(page: Page, scope: string): Promise<string[]> {
  return page.locator(`${scope} .tool-trace > :is(summary, .tool-trace-summary)`).evaluateAll(rows => rows.flatMap(row => {
    const box = row.getBoundingClientRect();
    if (!box.width) return [];
    const room = row.parentElement!.parentElement!.getBoundingClientRect();
    const fixed = [...row.querySelectorAll<HTMLElement>(':scope > :is(.tool-trace-badge, .tool-trace-chevron, .tool-trace-delta)')];
    const bad = box.right > room.right + 0.5 || row.scrollWidth > Math.ceil(box.width) + 1
      || fixed.some(mark => { const rect = mark.getBoundingClientRect(); return !rect.width || rect.left < box.left - 0.5 || rect.right > box.right + 0.5 || mark.scrollWidth > Math.ceil(rect.width); });
    return bad ? [`${row.textContent!.replace(/\s+/g, ' ').trim()} (content ${row.scrollWidth}px, row ${Math.round(box.width)}px, room ${Math.round(room.width)}px)`] : [];
  }));
}

for (const width of [420, 760]) {
  test(`gallery rows fit their box and keep every badge inside it (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tool-trace-gallery.html');
    await expect(page.locator('body[data-ready="true"]')).toBeAttached();
    expect(await rowOverflows(page, 'section[data-gallery-family]')).toEqual([]);
  });
}

// A lone note (`Screenshot 1280×800`, a saved path, one error line) has no card plate, but its text starts where a card's
// content does, not on the card's outer edge.
test('lone notes line up with card content', async ({ page }) => {
  await page.goto('/tool-trace-gallery.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const notes = await page.locator('.tool-trace-inline').evaluateAll(nodes => nodes.filter(note => note.getBoundingClientRect().width).map(note => {
    const range = document.createRange(); range.selectNodeContents(note);
    // The body column is where the card's plate starts; card content sits 12px in from it.
    return { text: note.textContent, inset: range.getClientRects()[0].left - note.parentElement!.getBoundingClientRect().left };
  }));
  expect(notes.length).toBeGreaterThanOrEqual(2);
  for (const note of notes) expect(Math.abs(note.inset - 12), `${note.text} ${note.inset}px`).toBeLessThanOrEqual(1);
});
