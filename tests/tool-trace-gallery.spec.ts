import { expect, test } from '@playwright/test';

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
  await expect(page.locator('.tool-group-label').first()).toHaveText("Coordinated 7 team steps");
  await expect(page.locator('.tool-group-summary').first().locator('.tool-group-status')).toHaveText([' · 1 running']);
  // Rows with nothing beyond the sentence are plain lines, not empty disclosures.
  await expect(page.locator('.tool-trace[data-static] summary, .tool-trace[data-static] .tool-trace-chevron')).toHaveCount(0);
  expect(await page.locator('.tool-trace[data-static]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/collapsed.png`, fullPage: true });
});
