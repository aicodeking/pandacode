import { expect, test, type Page } from '@playwright/test';

const form = (page: Page) => page.locator('.agent-input');
const question = { kind: 'questions', questions: [{ id: 'theme', header: 'Theme', question: 'Which theme should I use?', options: [{ label: 'Yellow', description: 'Warm accents' }, { label: 'Green', description: 'Bamboo accents' }], isOther: true }] };
async function emit(page: Page, kind: string, data?: unknown, sessionId = 'session-1', requestId = 'run:request-1', text = ''): Promise<void> {
  await page.evaluate(event => (window as any).__inputEmit(event), { sessionId, requestId, kind, text, data });
}
const answers = (page: Page) => page.evaluate(() => (window as any).__inputResponses);

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__inputEmit ??= event => agent(event);
      window.__inputResponses ??= [];
      window.__inputOpened ??= [];
      if (command === 'open_external_url') { window.__inputOpened.push(args.url); return; }
      if (command === 'respond_user_input') {
        window.__inputResponses.push(structuredClone(args));
        if (window.__inputHold) { await new Promise(resolve => { window.__inputRelease = resolve; }); }
        if (window.__inputFail) { window.__inputFail = false; throw new Error('Temporary reply failure'); }
        return;
      }
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
});

test('agent input preserves typed answers while tools and tokens stream and across task switches', async ({ page }) => {
  await emit(page, 'input_request', question);
  await expect(form(page)).toBeVisible();
  const input = form(page).getByRole('textbox', { name: 'Theme', exact: true });
  await input.fill('Amber and forest green');
  const original = await input.elementHandle();
  await emit(page, 'text', undefined, 'session-1', '', 'More streamed progress.');
  await emit(page, 'tool', undefined, 'session-1', '', 'Read README');
  await expect(input).toHaveValue('Amber and forest green');
  await expect(input).toBeFocused();
  expect(await original!.evaluate(node => node === document.querySelector('.agent-input input[type=text]'))).toBe(true);
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(form(page)).toBeHidden();
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(input).toHaveValue('Amber and forest green');
  await form(page).getByRole('button', { name: 'Submit answers' }).click();
  await expect(form(page)).toBeHidden();
  expect(await answers(page)).toEqual([{ sessionId: 'session-1', requestId: 'run:request-1', response: { answers: { theme: ['Amber and forest green'] } } }]);
});

test('agent input sends choices and secret answers and clears native cancellations', async ({ page }) => {
  await emit(page, 'input_request', { kind: 'questions', questions: [question.questions[0], { id: 'secret', header: 'Token', question: 'Enter a private token', isSecret: true }] });
  await form(page).getByRole('radio', { name: 'Yellow Warm accents' }).check();
  const secret = form(page).locator('input[type=password]');
  await secret.fill('test-secret-value');
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('test-secret-value')))).toBe(false);
  const secretNode = await secret.elementHandle();
  await form(page).getByRole('button', { name: 'Submit answers' }).click();
  await expect(form(page)).toBeHidden();
  expect(await secretNode!.evaluate(node => (node as HTMLInputElement).value)).toBe('');
  expect((await answers(page))[0].response.answers).toEqual({ theme: ['Yellow'], secret: ['test-secret-value'] });
  await emit(page, 'input_request', question, 'session-1', 'run:request-2');
  await expect(form(page)).toBeVisible();
  await emit(page, 'input_cancelled', undefined, 'session-1', 'run:request-2');
  await expect(form(page)).toBeHidden();
});

test('agent input retries failed replies and keeps submissions attached to their original task', async ({ page }) => {
  await emit(page, 'input_request', question);
  await form(page).getByRole('radio', { name: 'Green Bamboo accents' }).check();
  await page.evaluate(() => { (window as any).__inputFail = true; });
  await form(page).getByRole('button', { name: 'Submit answers' }).click();
  await expect(form(page).getByRole('alert')).toHaveText('Temporary reply failure');
  await expect(form(page).getByRole('radio', { name: 'Green Bamboo accents' })).toBeChecked();
  await page.evaluate(() => { (window as any).__inputHold = true; });
  await form(page).getByRole('button', { name: 'Submit answers' }).click();
  await expect(form(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await page.locator('.task-item[data-id="session-2"]').click();
  await emit(page, 'input_request', question, 'session-2', 'second:request');
  await expect(form(page)).toHaveAttribute('data-request-id', 'second:request');
  await page.evaluate(() => { (window as any).__inputHold = false; (window as any).__inputRelease(); });
  await expect(form(page)).toHaveAttribute('data-request-id', 'second:request');
  await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form(page)).toBeHidden();
  const sent = await answers(page);
  expect(sent.map((entry: any) => entry.sessionId)).toEqual(['session-1', 'session-1', 'session-2']);
  expect(sent[2].response).toEqual({ answers: {} });
});

test('agent input renders primitive integration forms and refuses unsupported schemas', async ({ page }) => {
  await emit(page, 'input_request', { kind: 'form', message: 'Configure this integration', schema: { type: 'object', properties: {
    name: { type: 'string', title: 'Display name', minLength: 2 }, count: { type: 'integer', title: 'Retries', minimum: 1, maximum: 5 }, enabled: { type: 'boolean', title: 'Enabled', default: true }, color: { type: 'string', title: 'Color', enum: ['yellow', 'green'] }, permissions: { type: 'array', title: 'Permissions', items: { type: 'string', enum: ['read', 'write'] }, minItems: 1 },
  }, required: ['name', 'count', 'color', 'permissions'] } });
  await form(page).getByRole('textbox', { name: 'Display name', exact: true }).fill('Bamboo');
  await form(page).getByRole('spinbutton', { name: 'Retries', exact: true }).fill('3');
  await form(page).getByRole('combobox', { name: 'Color', exact: true }).selectOption({ label: 'green' });
  await form(page).getByRole('group', { name: 'Permissions', exact: true }).getByRole('checkbox', { name: 'read', exact: true }).check();
  await form(page).getByRole('button', { name: 'Submit answers' }).click();
  await expect(form(page)).toBeHidden();
  expect((await answers(page))[0].response).toEqual({ action: 'accept', content: { name: 'Bamboo', count: 3, enabled: true, color: 'green', permissions: ['read'] } });
  await emit(page, 'input_request', { kind: 'form', message: 'Nested settings', schema: { type: 'object', properties: { nested: { type: 'object', properties: {} } } } }, 'session-1', 'unsupported');
  await expect(form(page).getByRole('alert')).toContainText('cannot display yet');
  await expect(form(page).getByRole('button', { name: 'Submit answers' })).toBeHidden();
  await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form(page)).toBeHidden();
  expect((await answers(page))[1].response).toEqual({ action: 'cancel', content: null });
});

test('agent input opens URL requests only on an explicit click and requires separate confirmation', async ({ page }) => {
  await emit(page, 'input_request', { kind: 'url', message: 'Authorize your integration', url: 'https://example.com/connect?token=fixture' });
  await expect(form(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__inputOpened)).toEqual([]);
  expect(await answers(page)).toEqual([]);
  await form(page).getByRole('button', { name: 'Open in browser', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inputOpened)).toEqual(['https://example.com/connect?token=fixture']);
  expect(await answers(page)).toEqual([]);
  await form(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(form(page)).toBeHidden();
  expect((await answers(page))[0].response).toEqual({ action: 'accept', content: null });
  await emit(page, 'input_request', { kind: 'url', message: 'Bad link', url: 'javascript:alert(1)' }, 'session-1', 'bad-url');
  await expect(form(page).getByRole('alert')).toContainText('supported web address');
  await expect(form(page).getByRole('button', { name: 'Open in browser', exact: true })).toHaveCount(0);
});

test('agent input remains available in the board panel and disappears when work stops', async ({ page }) => {
  await emit(page, 'input_request', question);
  await form(page).getByRole('textbox', { name: 'Theme', exact: true }).fill('Keep this board answer');
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Open task: Make search feel instant', exact: true }).click();
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByRole('textbox', { name: 'Theme', exact: true })).toHaveValue('Keep this board answer');
  await emit(page, 'status', undefined, 'session-1', '', 'Stopping agent');
  await expect(form(page)).toBeHidden();
  await emit(page, 'done');
  await expect(form(page)).toBeHidden();
});

test('questions render Markdown with workspace images, charts, drawings and safe HTML views', async ({ page }) => {
  const rich = { kind: 'questions', questions: [{
    id: 'maps', header: 'Old maps · [#47](https://github.com/acme/maps/pull/47)',
    question: 'Players already have maps saved under the **old naming**. What should happen to them?\n\n![Before](docs/before.png) ![Remote](https://example.com/after.png)\n\n```chart\n{"type":"bar","title":"Saved maps per world","labels":["lobby","survival","creative"],"series":[{"name":"maps","values":[12,30,7]}]}\n```\n\n```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="gold"/><script>window.__svgRan = true</script></svg>\n```\n\n```html\n<p class="note" onclick="window.__htmlRan = true">Old: <b>survival.map</b></p><script>window.__htmlRan = true</script><img src="x" onerror="window.__htmlRan = true">\n```',
    options: [{ label: '**Move them** (Recommended)', description: 'The first world takes over the old map and its *waypoints*.' }, { label: 'Start fresh', description: 'Every world starts empty.' }],
  }] };
  await emit(page, 'input_request', rich);
  const card = form(page);
  await expect(card).toBeVisible();
  // Markdown in the header, the question and the options.
  await expect(card.locator('.agent-input-header a')).toHaveAttribute('href', 'https://github.com/acme/maps/pull/47');
  await expect(card.locator('.agent-input-question-text strong')).toHaveText('old naming');
  await expect(card.locator('.agent-input-option').first().locator('strong strong')).toHaveText('Move them');
  await expect(card.locator('.agent-input-option').first().locator('small em')).toHaveText('waypoints');
  // A workspace image arrives as a data: URL; a remote one stays a link and is never fetched.
  await expect(card.locator('.rich-image img')).toHaveAttribute('src', /^data:image\//);
  await expect(card.locator('a[href="https://example.com/after.png"]')).toHaveText('Remote');
  await expect(card.locator('img[src^="https:"]')).toHaveCount(0);
  // A chart drawn as SVG, a sanitized drawing and a static HTML view: no script ever runs.
  await expect(card.locator('.rich-chart figcaption')).toHaveText('Saved maps per world');
  await expect(card.locator('.rich-chart svg rect')).toHaveCount(3);
  await expect(card.locator('.rich-svg svg circle')).toHaveCount(1);
  await expect(card.locator('.rich-svg script')).toHaveCount(0);
  await expect.poll(() => card.locator('.rich-html').evaluate(host => host.shadowRoot?.querySelector('.note')?.textContent ?? '')).toBe('Old: survival.map');
  expect(await card.locator('.rich-html').evaluate(host => host.shadowRoot!.innerHTML)).not.toMatch(/script|onclick|onerror/i);
  expect(await card.locator('.rich-html').evaluate(host => host.shadowRoot!.querySelectorAll('img').length)).toBe(0);
  // An option's label stays on one line with its Markdown inline.
  expect(await card.locator('.agent-input-option').first().locator('strong').first().evaluate(el => el.getClientRects().length > 0 && el.getBoundingClientRect().height < 30)).toBe(true);
  await card.locator('.rich-html').click();
  expect(await page.evaluate(() => Boolean((window as any).__svgRan || (window as any).__htmlRan))).toBe(false);
  // Choosing an option sends its exact label back.
  await card.locator('.agent-input-option').first().click();
  await card.getByRole('button', { name: 'Submit answers' }).click();
  await expect(card).toBeHidden();
  expect((await answers(page)).at(-1).response).toEqual({ answers: { maps: ['**Move them** (Recommended)'] } });
});
