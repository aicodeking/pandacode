import { expect, test, type Page } from '@playwright/test';

// Voice dictation in the browser preview: a fake catalog and a scripted
// recording (partials, levels, final transcript) exercise the composer flow.
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const mic = (page: Page) => page.locator('.composer-voice-button');
const bar = (page: Page) => page.locator('.voice-bar');
const voiceCalls = (page: Page): Promise<string[]> => page.evaluate(() => ((window as any).__voiceCalls ?? []));
const tab = (page: Page, name: string) => page.locator('.settings-nav').getByRole('tab', { name, exact: true });

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      if (command.startsWith('voice_')) ((window.__voiceCalls ??= []).push(command));
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
}

async function openVoiceSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Settings|Open settings/i }).first().click();
  await tab(page, 'Voice').click();
  await expect(page.locator('#voice-settings')).toBeVisible();
}

test('the mic appears once voice is enabled and dictates into the prompt for review', async ({ page }) => {
  await open(page);
  // Off by default: no mic button, and the composer works untouched.
  await expect(mic(page)).toHaveCount(0);

  await openVoiceSettings(page);
  await page.locator('#voice-enabled').click();
  await expect(page.locator('#voice-settings .voice-picked').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mic(page)).toBeVisible();

  await mic(page).click();
  await expect(bar(page)).toBeVisible();
  // Live partial text streams into the prompt, replacing previous partials.
  await expect(prompt(page)).toHaveValue(/Okay, run the/, { timeout: 4_000 });
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_start');
  await bar(page).locator('.voice-stop').click();
  // The final transcript settles for review — never sent on its own.
  await expect(prompt(page)).toHaveValue('Okay, run the test suite and report failures.');
  await expect(bar(page)).toHaveCount(0);
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  const calls = await voiceCalls(page);
  expect(calls).toContain('voice_stop');
  expect(calls).not.toContain('send_message');
});

test('Esc cancels a recording and leaves the draft as it was', async ({ page }) => {
  await open(page);
  await openVoiceSettings(page);
  await page.locator('#voice-enabled').click();
  await page.keyboard.press('Escape');
  await expect(mic(page)).toBeVisible();

  await prompt(page).fill('Keep this. ');
  await mic(page).click();
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(mic(page)).toBeVisible();
  // The prefix typed before dictation survives a cancel.
  await expect(prompt(page)).toHaveValue('Keep this. ');
});

test('settings lists models, downloads one, and selects it for the quality pass', async ({ page }) => {
  await open(page);
  await openVoiceSettings(page);
  await page.locator('#voice-enabled').click();
  const panel = page.locator('#voice-settings');
  await expect(panel.getByText('Moonshine Base')).toBeVisible();
  await expect(panel.getByText('SenseVoice Small')).toBeVisible();
  await expect(panel.getByText('Parakeet TDT 0.6B v3')).toBeVisible();

  const moonshine = panel.locator('.voice-model', { hasText: 'Moonshine Base' });
  await moonshine.getByRole('button', { name: 'Download' }).click();
  await expect(moonshine).toHaveCount(1);
  await expect(moonshine.getByRole('button', { name: 'Download' })).toBeHidden({ timeout: 8_000 });
  await expect(moonshine).toContainText('Ready');
  await moonshine.getByRole('button', { name: 'Use' }).click();
  await expect(moonshine.getByRole('button', { name: 'Selected' })).toBeVisible();
});

test('hold mode records while the button is pressed', async ({ page }) => {
  await open(page);
  await openVoiceSettings(page);
  await page.locator('#voice-enabled').click();
  await page.locator('#voice-settings [data-interaction="hold"]').click();
  await page.keyboard.press('Escape');
  await expect(mic(page)).toBeVisible();

  const micBox = await mic(page).boundingBox();
  await page.mouse.move(micBox!.x + micBox!.width / 2, micBox!.y + micBox!.height / 2);
  await page.mouse.down();
  await expect(bar(page)).toBeVisible();
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_start');
  await page.mouse.up();
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_stop');
});

test('online mode: pick a provider, save its key, run the connectivity test', async ({ page }) => {
  await open(page);
  await openVoiceSettings(page);
  const panel = page.locator('#voice-settings');
  await page.locator('#voice-enabled').click();

  // Online is inert until a provider is configured; pick one first.
  await panel.locator('[data-mode="online"]').click();
  await expect(panel.locator('.voice-provider')).toBeVisible();
  await panel.locator('.voice-provider').selectOption('groq');
  // The provider switch adopts the preset's default model.
  await expect(panel.locator('.voice-model-select')).toHaveValue('whisper-large-v3-turbo');
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_save_settings');

  // The test refuses without a key, then succeeds once one is saved.
  await panel.locator('.voice-test').click();
  await expect(page.locator('#toast')).toContainText('Save an API key first.');
  await panel.locator('.voice-key').fill('sk-test');
  await panel.locator('.voice-key-save').click();
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_set_key');
  await expect(panel.locator('.voice-key')).toHaveValue('');
  await panel.locator('.voice-test').click();
  await expect.poll(async () => await voiceCalls(page)).toContain('voice_test_provider');
  await expect(page.locator('#toast')).toContainText('is connected.');
});
