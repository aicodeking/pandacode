import { expect, test, type Page } from '@playwright/test';

/* Images and attached context on a task that runs on another computer (PandaCode Connect):
 * the first prompt (remote_start_task) and follow-ups (send_message on the mirror) carry
 * pasted, picked and dropped images as imageIds, which remote/images.rs copies to the host;
 * documents are inlined as text here, never read through the mirror's workspace. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const chips = (page: Page) => page.locator('#attachments .prompt-chip');
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__calls ?? []).filter((entry: any) => entry.command === command).map((entry: any) => entry.args), command);
const starts = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__remoteStarts ?? []);

/** Records every preview command, signs in to Connect and chooses Studio iMac for a New task. */
async function newTaskOnStudio(page: Page) {
  test.slow();
  await page.addInitScript(() => { (window as any).__remoteStartStep = 1; });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    // The first `switch (command)` sees every command except remote_start_task, which the
    // preview records in `__remoteStarts`.
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, match => `(window.__calls ??= []).push({ command, args: structuredClone(args) });\n${match}`)) });
  });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
  await page.locator('.new-task-button').click();
  await page.locator('#composer-computer').click();
  await page.getByRole('menuitemradio', { name: 'Studio iMac' }).click();
  await prompt(page).waitFor();
}

async function pasteImage(page: Page, name: string) {
  await prompt(page).focus();
  await page.evaluate(([base64, name]) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type: 'image/png' }));
    document.querySelector('#prompt')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [PNG, name]);
}

async function dropImage(page: Page, name: string) {
  await page.evaluate(([base64, name]) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type: 'image/png' }));
    data.items.add(new File(['# Notes\n\nDropped spec'], 'notes.md', { type: 'text/markdown' }));
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [PNG, name]);
}

/** Starts the task on Studio iMac with one pasted image and waits for the mirror to open. */
async function startWithImage(page: Page) {
  await newTaskOnStudio(page);
  await pasteImage(page, 'first.png');
  await expect(chips(page)).toHaveCount(1);
  await prompt(page).fill('Match this layout over there');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  await expect(page.locator('#composer-area .remote-start-strip')).toHaveCount(0);
}

test('the first prompt to another computer carries its pasted image', async ({ page }) => {
  await startWithImage(page);
  const [imported] = await calls(page, 'import_prompt_image');
  const started = await starts(page);
  expect(started).toHaveLength(1);
  expect(started[0].imageIds).toHaveLength(1);
  expect(started[0].imageIds[0]).toBeTruthy();
  expect(imported.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(started[0].prompt).toMatch(/^Match this layout over there\n\nAttached image: first\.png/);
  // The chip went out with the message, and the host's first send names the image.
  await expect(chips(page)).toHaveCount(0);
  const sent = await calls(page, 'send_message');
  expect(sent.at(-1).imageIds).toEqual(started[0].imageIds);
  await expect(page.locator('#toast')).not.toContainText('can’t be sent');
});

test('a follow-up on a mirror sends images from paste, drop and the + menu, with documents inline', async ({ page }) => {
  await startWithImage(page);
  const mirror = (await starts(page))[0].sessionId;
  // Let the preview's first run finish so the follow-up is a new turn.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 });

  await pasteImage(page, 'follow-up.png');
  await dropImage(page, 'dropped.png');
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: /Attach files…/ }).click();
  // Pasted, dropped and picked images, the dropped notes and the picked PDF.
  await expect(chips(page)).toHaveCount(5);
  await prompt(page).fill('Now these too');
  await page.keyboard.press('Enter');

  await expect.poll(async () => (await calls(page, 'send_message')).filter(args => args.text.startsWith('Now these too'))).toHaveLength(1);
  const sent = (await calls(page, 'send_message')).find(args => args.text.startsWith('Now these too'));
  expect(sent.sessionId).toBe(mirror);
  expect(sent.imageIds).toHaveLength(3);
  expect(new Set(sent.imageIds).size).toBe(3);
  // Documents travel as text from this computer.
  expect(sent.text).toContain('Document context: notes.md');
  expect(sent.text).toContain('Document context: Product brief.pdf');
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator('#toast')).not.toContainText('runs on');
});

test('a mirror follow-up takes at most four images, like a local task', async ({ page }) => {
  await startWithImage(page);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 });
  const mirror = (await starts(page))[0].sessionId;
  for (let index = 0; index < 4; index++) await pasteImage(page, `shot-${index}.png`);
  await expect(chips(page)).toHaveCount(4);
  await pasteImage(page, 'one-too-many.png');
  await expect(page.locator('#toast')).toContainText('Attach up to 4 images per message');
  await expect(chips(page)).toHaveCount(4);
  await prompt(page).fill('Compare all four');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).filter(args => args.text.startsWith('Compare all four'))).toHaveLength(1);
  const sent = (await calls(page, 'send_message')).find(args => args.text.startsWith('Compare all four'));
  expect(sent.sessionId).toBe(mirror);
  expect(sent.imageIds).toHaveLength(4);
  // Nothing on a mirror reads through its workspace here (the preview refuses it like native).
  expect((await calls(page, 'read_file')).filter(args => args.sessionId === mirror)).toHaveLength(0);
});
