import { expect, test } from '@playwright/test';

// Thinking text streams into one closed fold per turn, above the answer.
test('streams thinking into a closed fold above the answer', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const source = await (await route.fetch()).text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ contentType: 'text/javascript', body: source.replace(marker, `window.__agent = agent; $&`) });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __agent?: unknown }).__agent));
  const id = await page.locator('.task-item[aria-current="page"]').first().getAttribute('data-id');
  expect(id).toBeTruthy();
  const emit = (kind: string, text: string) => page.evaluate(([sessionId, kind, text]) => (window as unknown as { __agent: (e: unknown) => void }).__agent({ sessionId, kind, text }), [id, kind, text]);
  await emit('thinking', 'Weighing the ');
  await emit('thinking', 'options.');
  await emit('text', 'Here is the answer.');
  const fold = page.locator('#stream-region details.thinking-block');
  await expect(fold).toBeVisible();
  await expect(fold).not.toHaveAttribute('open', '');
  await expect(fold.locator('summary')).toHaveText('Thinking');
  await fold.locator('summary').click();
  await expect(fold.locator('.thinking-text')).toHaveText('Weighing the options.');
  await emit('thinking', ' More.');
  await expect(fold).toHaveAttribute('open', '');
  await expect(fold.locator('.thinking-text')).toHaveText('Weighing the options. More.');
  const above = await fold.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('#stream-region .live-message')!) & Node.DOCUMENT_POSITION_FOLLOWING));
  expect(above).toBe(true);
});
