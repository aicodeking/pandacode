import { expect, test, type Page } from '@playwright/test';

/* The bundle import pane: a preview lists what will change and writes nothing, and only a
 * second, explicit action applies it. Mounted directly against the preview's bot host, since
 * the entry lives inside the Bots window. */
const fixture = (page: Page) => page.locator('#bundles-fixture');

const bundle = {
  bots: [
    { name: 'Desk Lead', role: 'Coordinates', instructions: 'Lead the desk.', provider: 'claude', model: 'sonnet', mode: 'ask', heartbeatMinutes: 0 },
    { name: 'Risk Manager', role: 'Checks risk', instructions: 'Check risk.', provider: 'claude', model: 'sonnet', mode: 'ask', heartbeatMinutes: 0, channels: [{ kind: 'web' }] },
  ],
};

type Call = { command: string; args: Record<string, unknown> };
const calls = (page: Page) => page.evaluate(() => (window as any).__bundles.calls as Call[]);

async function mount(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.evaluate(async () => {
    const { mountBotsImport } = await import('/src/bots-import.ts');
    const { invokeBots } = await import('/src/preview-bots.ts');
    const host = { addProject: (name: string) => ({ id: `p-${name}`, name }), emit: () => undefined };
    const dialog = document.createElement('dialog');
    dialog.id = 'bundles-fixture';
    const target = document.createElement('div');
    dialog.append(target);
    document.body.append(dialog);
    dialog.showModal();
    const state = { calls: [] as Call[] };
    (window as any).__bundles = state;
    mountBotsImport(target, {
      call: async (command: string, args: Call['args'] = {}) => {
        state.calls.push({ command, args });
        return invokeBots(command, args, host as never);
      },
      changed: async () => undefined,
      close: () => dialog.close(),
    });
  });
}

async function choose(page: Page, content: string): Promise<void> {
  await fixture(page).locator('input[type=file]').setInputFiles({ name: 'bots.json', mimeType: 'application/json', buffer: Buffer.from(content) });
}

test.describe('bot bundle import pane', () => {
  test('previews without importing, then imports on request', async ({ page }) => {
    await mount(page);
    await choose(page, JSON.stringify(bundle));

    const preview = fixture(page).getByRole('list', { name: 'Bundle preview' });
    await expect(preview).toContainText('Desk Lead');
    await expect(preview).toContainText('Risk Manager');
    await expect(preview).toContainText('Create');

    expect((await calls(page)).map(call => call.command)).toEqual(['bots_import_preview']);
    await expect(fixture(page).getByRole('list', { name: 'Import results' })).toHaveCount(0);

    await fixture(page).getByRole('button', { name: /Import bots/ }).click();
    await expect(fixture(page).getByRole('list', { name: 'Import results' })).toContainText('Created');
    expect((await calls(page)).map(call => call.command)).toEqual(['bots_import_preview', 'bots_import']);
  });

  test('sends the document as a JSON string, not a parsed object', async ({ page }) => {
    await mount(page);
    await choose(page, JSON.stringify(bundle));
    await expect(fixture(page).getByRole('list', { name: 'Bundle preview' })).toBeVisible();
    const [preview] = await calls(page);
    expect(typeof preview.args.doc).toBe('string');
    expect(JSON.parse(preview.args.doc as string).bots).toHaveLength(2);
  });

  test('rejects a document that is not a bundle, before anything is applied', async ({ page }) => {
    await mount(page);
    await choose(page, '{"nope":true}');
    await expect(fixture(page).getByRole('alert')).toContainText('must contain a bots list');
    await expect(fixture(page).getByRole('list', { name: 'Bundle preview' })).toHaveCount(0);

    await choose(page, 'not json');
    await expect(fixture(page).getByRole('alert')).toContainText('not valid JSON');
    expect(await calls(page)).toEqual([]);
  });

  test('keeps a failed bot visible instead of dropping it', async ({ page }) => {
    await mount(page);
    await choose(page, JSON.stringify({ bots: [bundle.bots[0], { ...bundle.bots[0], name: '' }] }));
    await expect(fixture(page).getByRole('alert')).toContainText('could not be imported');
    await expect(fixture(page).getByRole('list', { name: 'Bundle preview' })).toContainText('Desk Lead');
  });
});
