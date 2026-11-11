import { expect, type Page } from '@playwright/test';

// Shared by voice-local-models.spec.ts and voice-local-tests.spec.ts. Titles there start with "voice input" so the
// WebKit config's grep picks those files up.
export const UNIFIED = 'Parakeet Unified English 0.6B';
export const TDT = 'Parakeet TDT 0.6B v3';
export const CANARY = 'Canary 180M Flash';
export const WHISPER = 'Whisper Tiny';
export const NEMOTRON = 'Nemotron Streaming 3.5';
/** The preview's `unsupportedReason` for the `local-unsupported*` scenarios. */
export const UNSUPPORTED_REASON = 'This computer’s processor lacks the instructions the speech engine needs.';
export const VOXTRAL = 'Voxtral Small 24B';

export const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
export const voice = (page: Page) => page.locator('#voice-settings');
export const languages = (page: Page) => voice(page).getByRole('listbox', { name: 'Languages', exact: true });
export const models = (page: Page) => voice(page).locator('[data-voice-models]');
export const card = (page: Page, name: string) => models(page).getByRole('listitem', { name, exact: true });
export const localState = (page: Page) => page.evaluate(() => (window as any).__voiceLocalState());

export async function openVoiceSettings(page: Page, scenario = '') {
  await page.goto(scenario ? `/?voice=${scenario}` : '/');
  await expect(prompt(page)).toBeEnabled();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
  await expect(card(page, UNIFIED)).toBeVisible();
  return settings;
}
export const modelNames = (page: Page) => models(page).locator('.voice-model-name').allTextContents();
