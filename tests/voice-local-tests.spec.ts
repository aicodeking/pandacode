import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  CANARY, NEMOTRON, TDT, UNIFIED, UNSUPPORTED_REASON, VOXTRAL, WHISPER, card, languages, localState, modelNames, models, openVoiceSettings, prompt, voice,
} from './voice-local-helpers';

// Titles start with "voice input" so the WebKit config's grep picks this file up.

test.describe('voice input local models', () => {
  test('voice input deleting the selected model disables Language and matches the composer setup', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    const language = voice(page).getByRole('combobox', { name: 'Language', exact: true });
    await expect(language).toBeEnabled();
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Delete ${UNIFIED}`, exact: true }).click();
    await unified.getByRole('button', { name: `Confirm deleting ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Download ${UNIFIED}`, exact: true })).toBeVisible();
    await expect(language).toBeDisabled();
    await expect(voice(page).locator('[data-voice-language-row]')).toBeVisible();
    await expect(voice(page).locator('#voice-language-pick-description')).toHaveText('Download or select a model below to choose its language.');
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(page.locator('#composer .voice-mic')).toHaveAccessibleName('Set up dictation');
  });

  test('voice input keeps focus on the card while verifying, then moves it to Select', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    const canary = card(page, CANARY);
    await canary.getByRole('button', { name: `Download ${CANARY}`, exact: true }).click();
    await expect(canary.getByRole('button', { name: `Cancel downloading ${CANARY}`, exact: true })).toBeFocused();
    await page.evaluate(() => { const w = window as any; w.__voiceLocalHoldVerify = true; w.__voiceLocalHold = false; });
    await expect(canary.getByText('Verifying…')).toBeVisible();
    await expect(canary).toBeFocused();
    await page.evaluate(() => { (window as any).__voiceLocalHoldVerify = false; });
    await expect(canary.getByRole('button', { name: `Select ${CANARY}`, exact: true })).toBeFocused();
  });

  test('voice input other downloads wait while one model downloads', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    await card(page, CANARY).getByRole('button', { name: `Download ${CANARY}`, exact: true }).click();
    const other = card(page, TDT).getByRole('button', { name: `Download ${TDT}`, exact: true });
    await expect(other).toHaveAttribute('aria-disabled', 'true');
    await expect(other).toHaveAttribute('data-tip', `Wait for ${CANARY} to finish or cancel it`);
    await other.click({ force: true });
    await expect(card(page, TDT).getByRole('alert')).toHaveCount(0);
    expect((await localState(page)).downloads).toEqual(['handy-computer/canary-180m-flash-gguf']);
    await card(page, CANARY).getByRole('button', { name: `Cancel downloading ${CANARY}`, exact: true }).click();
    await expect(other).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('voice input model search empty states name their cause', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const search = voice(page).getByRole('searchbox', { name: 'Search models', exact: true });
    await search.fill('zzz');
    await expect(models(page).locator('.voice-browser-empty')).toHaveText('No models match “zzz”.');
    await search.fill('');
    await languages(page).getByRole('option', { name: 'Welsh', exact: true }).click();
    await languages(page).getByRole('option', { name: 'Norwegian Bokmål', exact: true }).click();
    await expect(models(page).locator('.voice-browser-empty')).toHaveText('No models support every selected language.');
    await search.fill('zzz');
    await expect(models(page).locator('.voice-browser-empty')).toHaveText('No models match “zzz” and support every selected language.');
  });

  test('voice input Set up dictation with no model lands on the recommended Download', async ({ page }) => {
    await page.goto('/?voice=local-fresh');
    await expect(prompt(page)).toBeEnabled();
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Set up dictation');
    await mic.click({ force: true });
    await expect(card(page, UNIFIED).getByRole('button', { name: `Download ${UNIFIED}`, exact: true })).toBeFocused();
  });

  test('voice input partial downloads offer Resume', async ({ page }) => {
    await openVoiceSettings(page, 'local-partial');
    const canary = card(page, CANARY);
    const resume = canary.getByRole('button', { name: `Resume downloading ${CANARY}`, exact: true });
    await expect(resume).toHaveText('Resume (40%)');
    await expect(canary.locator('.voice-model-partial')).toHaveText('Partly downloaded');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    await resume.click();
    await expect(canary.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  test('voice input buttons and selects keep borders in forced colours; copy names the benchmark source', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    for (const target of [
      unified.getByRole('button', { name: `${UNIFIED} selected`, exact: true }), unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }),
      unified.getByRole('button', { name: `Delete ${UNIFIED}`, exact: true }), voice(page).getByRole('combobox', { name: 'Language', exact: true }),
    ]) expect(await target.evaluate(el => [el.getAttribute('aria-label'), getComputedStyle(el).borderTopStyle, getComputedStyle(el).borderTopWidth])).toEqual([await target.getAttribute('aria-label'), 'solid', '1px']);
    await expect(voice(page).locator('.voice-explainer')).toContainText('measured on the Handy project’s benchmark GPU');
    await expect(voice(page).locator('.voice-explainer')).not.toContainText('Handy’s benchmark GPU');
  });

  test('voice input microphone test announces start without a per-second countdown', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    const panel = voice(page).locator('[data-voice-mic-panel]');
    const status = panel.getByRole('status');
    await expect(status).toHaveText('Recording a 10-second test from System default because Wireless Headset is not connected. Speak normally.');
    const countdown = panel.locator('[data-voice-mic-countdown]');
    await expect(countdown).toHaveText('10 s left');
    expect(await countdown.evaluate(el => Boolean(el.closest('[aria-hidden="true"]')))).toBe(true);
    const node = await status.elementHandle();
    await expect(countdown).toHaveText('9 s left', { timeout: 3000 });
    expect(await node!.evaluate(el => el.isConnected)).toBe(true);
    await expect(status).toHaveText('Recording a 10-second test from System default because Wireless Headset is not connected. Speak normally.');
  });

  test('voice input first download auto-selects and later saves keep the selection', async ({ page }) => {
    await openVoiceSettings(page, 'local-fresh');
    const language = voice(page).getByRole('combobox', { name: 'Language', exact: true });
    await expect(language).toBeDisabled();
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Download ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `${UNIFIED} selected`, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(language).toBeEnabled();
    await expect(voice(page).locator('#voice-language-pick-description')).toHaveText(`${UNIFIED} transcribes English.`);
    const state = await localState(page);
    expect(state.preferences.selectedModel).toBe('handy-computer/parakeet-unified-en-0.6b-gguf');
    expect(state.vad.state).toBe('installed');
    await voice(page).getByRole('combobox', { name: 'Dictation shortcut', exact: true }).selectOption('toggle');
    await expect.poll(async () => (await localState(page)).preferences.shortcutMode).toBe('toggle');
    expect((await localState(page)).preferences.selectedModel).toBe('handy-computer/parakeet-unified-en-0.6b-gguf');
  });

  test('voice input licence links open externally when the catalog has one', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const link = card(page, UNIFIED).getByRole('link', { name: 'CC-BY-4.0', exact: true });
    await expect(link).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(card(page, VOXTRAL).getByRole('link', { name: 'Apache-2.0', exact: true })).toHaveAttribute('href', 'https://www.apache.org/licenses/LICENSE-2.0');
  });

  test('voice input renders models whose benchmark has no speed', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const voxtral = card(page, VOXTRAL);
    await expect(voxtral.locator('.voice-model-facts')).toContainText('Speed not measured');
    await expect(voxtral.locator('.voice-model-facts')).toContainText('English: A (3.55% error)');
    await expect(voxtral.locator('.voice-model-facts')).not.toContainText(/null|NaN|undefined/);
    expect(await modelNames(page)).toContain(VOXTRAL);
  });

  test('voice input preference saves send only the changed fields', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const shortcut = voice(page).getByRole('combobox', { name: 'Dictation shortcut', exact: true });
    await shortcut.selectOption('hold');
    await expect.poll(async () => (await localState(page)).preferencePatches).toEqual([{ shortcutMode: 'hold' }]);
    await voice(page).getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
    await expect.poll(async () => (await localState(page)).preferencePatches).toEqual([{ shortcutMode: 'hold' }, { language: 'en' }]);
    const state = await localState(page);
    expect(state.preferences).toMatchObject({ shortcutMode: 'hold', language: 'en', selectedModel: 'handy-computer/parakeet-unified-en-0.6b-gguf', destination: 'local' });
  });

  test('voice input Set up dictation with downloaded but unselected models lands on Select', async ({ page }) => {
    await page.goto('/?voice=local-unselected');
    await expect(prompt(page)).toBeEnabled();
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Set up dictation');
    await expect(mic).toHaveAttribute('data-tip', /Select a downloaded model in Settings → Voice to dictate on this device\./);
    await mic.click({ force: true });
    await expect(card(page, UNIFIED).getByRole('button', { name: `Select ${UNIFIED}`, exact: true })).toBeFocused();
  });

  test('voice input waiting downloads describe and announce why they wait', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    await card(page, CANARY).getByRole('button', { name: `Download ${CANARY}`, exact: true }).click();
    const other = card(page, TDT).getByRole('button', { name: `Download ${TDT}`, exact: true });
    const reason = `Wait for ${CANARY} to finish or cancel it`;
    await expect(other).toHaveAccessibleDescription(reason);
    const status = voice(page).locator('[data-voice-local-status]');
    await other.click({ force: true });
    await expect(status).toHaveText(reason);
    await expect(status).toBeVisible();
    await page.evaluate(() => { (document.querySelector('[data-voice-local-status]') as HTMLElement).textContent = ''; });
    await other.focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(reason);
    expect((await localState(page)).downloads).toEqual(['handy-computer/canary-180m-flash-gguf']);
  });

  test('voice input narrow model list grows with the page and keeps separators with their facts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openVoiceSettings(page, 'local-ready');
    const list = models(page);
    expect(await list.evaluate(el => [getComputedStyle(el).maxHeight, el.scrollHeight - el.clientHeight])).toEqual(['none', 0]);
    const dots = await list.locator('.voice-model-dot').evaluateAll(els => els.map(el => {
      const fact = el.parentElement!, next = el.nextSibling;
      const range = document.createRange(); range.selectNodeContents(fact);
      // Tops within 3px are one line (the inline-block separator rounds a pixel off the text).
      const tops = [...range.getClientRects()].map(rect => rect.top).sort((a, b) => a - b);
      const lines = tops.filter((top, i) => !i || top - tops[i - 1] > 3).length;
      // A fact wider than the whole card wraps inside itself; its separator must still sit on its first line.
      const full = fact.getBoundingClientRect().width >= fact.parentElement!.getBoundingClientRect().width - 1;
      const after = document.createRange(); after.selectNodeContents(fact); after.setStartAfter(el);
      const withText = Math.abs(el.getBoundingClientRect().top - after.getClientRects()[0].top) <= 3;
      return { grouped: fact.classList.contains('voice-model-fact'), hasNext: Boolean(next), oneLine: full || lines === 1, withText };
    }));
    expect(dots.length).toBeGreaterThan(10);
    for (const dot of dots) expect(dot).toEqual({ grouped: true, hasNext: true, oneLine: true, withText: true });
  });

  test('voice input microphone buttons keep borders in forced colours', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openVoiceSettings(page, 'local-ready');
    for (const target of [
      voice(page).getByRole('button', { name: 'Test microphone', exact: true }), voice(page).getByRole('button', { name: 'Refresh microphones', exact: true }),
    ]) expect(await target.evaluate(el => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).borderTopWidth])).toEqual(['solid', '1px']);
  });
  test('voice input speech service buttons keep ButtonBorder outlines in forced colours like the model actions', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openVoiceSettings(page, 'local-ready');
    const reference = await card(page, UNIFIED).getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).evaluate(el => getComputedStyle(el).borderTopColor);
    for (const target of [
      voice(page).getByRole('button', { name: 'Edit Local speech', exact: true }), voice(page).getByRole('button', { name: 'Use Local speech', exact: true }),
      voice(page).getByRole('button', { name: 'New profile', exact: true }),
    ]) expect(await target.evaluate(el => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderTopColor])).toEqual(['solid', '1px', reference]);
  });
  test('voice input preview catalog uses only real catalog entries', async ({ page }) => {
    const real = JSON.parse(readFileSync(new URL('../src-tauri/src/voice/local/catalog.json', import.meta.url), 'utf8'));
    await page.goto('/?voice=local-ready');
    await expect(prompt(page)).toBeEnabled();
    const fixture = await page.evaluate(() => (window as any).__voiceLocalCatalog());
    expect(fixture.defaultModel).toBe(real.defaultModel);
    expect(fixture.models.map((model: any) => model.name)).not.toContain('MedASR');
    expect(fixture.models.some((model: any) => model.benchmark && model.benchmark.secondsPer30s === null)).toBe(true);
    for (const model of fixture.models) {
      const entry = real.models.find((item: any) => item.id === model.id);
      expect(entry, model.id).toBeTruthy();
      const { state: _state, active: _active, downloaded: _downloaded, ...catalogFields } = model;
      expect(catalogFields, model.id).toEqual(entry);
    }
  });

  test('voice input mic has one tooltip naming this platform’s shortcut', async ({ page }) => {
    await page.goto('/?voice=ready');
    await expect(prompt(page)).toBeEnabled();
    const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Start dictation');
    await expect(mic).toHaveAttribute('data-tip', `Start dictation · ${mac ? '⌘⇧D' : 'Ctrl⇧D'}`);
    expect(await mic.getAttribute('title')).toBeNull();
    await page.goto('/?voice=local-unselected');
    await expect(mic).toHaveAccessibleName('Set up dictation');
    expect(await mic.getAttribute('title')).toBeNull();
  });

  test('voice input on an unsupported computer with no service points to Speech services', async ({ page }) => {
    await page.goto('/?voice=local-unsupported-new');
    await expect(prompt(page)).toBeEnabled();
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Set up dictation');
    const tip = await mic.getAttribute('data-tip');
    expect(tip).not.toContain('Voice input is off');
    expect(tip).toContain('On-device speech models are not supported on this computer.');
    expect(tip).toContain(UNSUPPORTED_REASON);
    expect(tip).toContain('Add a speech service in Settings → Voice.');
    await mic.click({ force: true });
    await expect(voice(page).locator('.voice-services').getByRole('button', { name: 'Speech provider', exact: true })).toBeFocused();
    await expect(models(page).getByRole('note')).toContainText('not supported on this computer');
    await expect(models(page).getByRole('note')).toContainText(UNSUPPORTED_REASON);
  });

  test('voice input lists the catalog default first among recommended models', async ({ page }) => {
    await openVoiceSettings(page, 'local-fresh');
    expect(await modelNames(page)).toEqual([UNIFIED, CANARY, NEMOTRON, TDT, VOXTRAL, WHISPER]);
  });

  test('voice input says which language a model will use instead of an unsupported one', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const language = voice(page).getByRole('combobox', { name: 'Language', exact: true });
    const note = voice(page).locator('#voice-language-pick-description');
    await card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true }).click();
    await language.selectOption('ja');
    await expect(note).toHaveText(`${WHISPER} transcribes Japanese.`);
    await card(page, UNIFIED).getByRole('button', { name: `Select ${UNIFIED}`, exact: true }).click();
    await expect(note).toHaveText(`Japanese isn’t supported by ${UNIFIED}; it will use English.`);
    await expect(language).toHaveValue('ja');
    await expect(language.locator('option[value="ja"]')).toHaveText('Japanese (not supported)');
    await expect(language.locator('option[value="ja"]')).toHaveAttribute('data-unsupported', '');
    await expect(language.locator('option[value="en"]')).not.toHaveAttribute('data-unsupported', '');
  });

  test('voice input model test names the model it tests', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true })).toBeFocused();
    const starts = await page.evaluate(() => ((window as any).__voiceCalls ?? []).filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'start'));
    expect(starts).toEqual([{ command: 'voice_local_test_model', action: 'start', modelId: 'handy-computer/parakeet-unified-en-0.6b-gguf' }]);
    expect((await localState(page)).testing).toBe('handy-computer/parakeet-unified-en-0.6b-gguf');
  });
});

test.describe('voice input microphone level meter', () => {
  const listenerCount = (page: Page, name: string) => page.evaluate(n => (window as any).__previewListenerCount(n), name);
  const emitLevel = (page: Page, level: number) => page.evaluate(value => (window as any).__previewEmit('voice://mic-test-level', { level: value }), level);

  test('voice input microphone test shows a live input level only while recording', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceMicLevelManual = true; });
    expect(await listenerCount(page, 'voice://mic-test-level')).toBe(0);
    const testButton = voice(page).locator('[data-voice-mic-test]');
    await testButton.click();
    const panel = voice(page).locator('[data-voice-mic-panel]');
    const meter = panel.getByRole('meter', { name: 'Microphone input level', exact: true });
    await expect(meter).toHaveAttribute('aria-valuetext', 'No sound yet');
    await expect(meter).toHaveAttribute('aria-valuenow', '0');
    await expect(panel.locator('[data-voice-mic-level-text]')).toHaveText('No sound yet');
    await expect.poll(() => listenerCount(page, 'voice://mic-test-level')).toBe(1);
    const node = await meter.elementHandle();
    await emitLevel(page, 0.62);
    await expect(meter).toHaveAttribute('aria-valuenow', '62');
    await expect(meter).toHaveAttribute('aria-valuetext', 'Hearing you');
    await expect(panel.locator('[data-voice-mic-level-text]')).toHaveText('Hearing you');
    await expect(panel.locator('.voice-mic-level-bar[data-on]')).toHaveCount(3);
    // The level updates the same meter in place, so the countdown and status are not re-rendered.
    expect(await node!.evaluate(el => el.isConnected)).toBe(true);
    // The meter carries its own state; the start announcement is not repeated.
    await expect(panel.getByRole('status')).toHaveText('Recording a 10-second test from System default because Wireless Headset is not connected. Speak normally.');
    expect(await panel.locator('[data-voice-mic-level-text]').evaluate(el => Boolean(el.closest('[aria-hidden="true"]')))).toBe(true);
    await emitLevel(page, 2);
    await expect(meter).toHaveAttribute('aria-valuenow', '100');
    await emitLevel(page, Number.NaN);
    await expect(meter).toHaveAttribute('aria-valuenow', '0');
    // Bars animate opacity only, with tokens; nothing scales layout.
    const bar = panel.locator('.voice-mic-level-bar').first();
    expect(await bar.evaluate(el => getComputedStyle(el).transitionProperty)).toBe('opacity');
    await testButton.click();
    await expect(meter).toHaveCount(0);
    await expect.poll(() => listenerCount(page, 'voice://mic-test-level')).toBe(0);
    // Leaving the page (suspend) also stops listening.
    await voice(page).getByRole('button', { name: 'Play test recording', exact: true }).waitFor();
    await testButton.click();
    await expect(meter).toBeVisible();
    await expect.poll(() => listenerCount(page, 'voice://mic-test-level')).toBe(1);
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await expect.poll(() => listenerCount(page, 'voice://mic-test-level')).toBe(0);
  });

  test('voice input microphone level stops listening when the start is abandoned', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalStartHold = true; });
    const testButton = voice(page).getByRole('button', { name: /Test microphone|Stop test/ });
    await testButton.click();
    await expect(voice(page).locator('[data-voice-mic-panel]')).toContainText('Starting System default');
    await testButton.click();
    await expect.poll(() => listenerCount(page, 'voice://mic-test-level')).toBe(0);
  });

  test('voice input microphone level meter is stepped with reduced motion and visible in forced colours', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceMicLevelManual = true; });
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await emitLevel(page, 0.5);
    const bars = voice(page).locator('.voice-mic-level-bar');
    await expect(bars).toHaveCount(5);
    const styles = await bars.evaluateAll(els => els.map(el => { const s = getComputedStyle(el); return { duration: s.transitionDuration, opacity: s.opacity, bg: s.backgroundColor, border: s.borderTopStyle, on: el.hasAttribute('data-on') }; }));
    for (const style of styles) {
      expect(style.duration).toBe('0s');
      expect(style.opacity).toBe('1');
      expect(style.border).toBe('solid');
    }
    // Lit bars fill with the system text colour; unlit ones stay outlined so the meter never disappears.
    expect(styles.filter(s => s.on).map(s => s.bg)).not.toContain('rgba(0, 0, 0, 0)');
    expect(styles.filter(s => !s.on).every(s => s.bg === 'rgba(0, 0, 0, 0)')).toBe(true);
  });

  test('voice input microphone level stays live with reduced motion, stepping without transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceMicLevelManual = true; });
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    const bars = voice(page).locator('.voice-mic-level-bar');
    await expect(bars).toHaveCount(5);
    const read = () => bars.evaluateAll(els => els.map(el => { const s = getComputedStyle(el); return { on: el.hasAttribute('data-on'), opacity: s.opacity, duration: s.transitionDuration, height: el.getBoundingClientRect().height }; }));
    // Five stepped bars of rising height, not a flat line.
    const heights = (await read()).map(bar => bar.height);
    expect(new Set(heights).size).toBe(5);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
    for (const [level, lit] of [[0.3, 2], [0.62, 3], [1, 5], [0, 0]] as const) {
      await emitLevel(page, level);
      await expect(voice(page).locator('.voice-mic-level-bar[data-on]')).toHaveCount(lit);
      const styles = await read();
      // The state changes at once: no transition, and lit bars read differently from unlit ones.
      for (const style of styles) { expect(style.duration).toBe('0s'); expect(Number(style.opacity)).toBe(style.on ? 1 : 0.22); }
    }
    await expect(voice(page).getByRole('meter', { name: 'Microphone input level', exact: true })).toHaveAttribute('aria-valuenow', '0');
  });

  test('voice input preview mock emits microphone levels during the test', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(voice(page).getByRole('meter', { name: 'Microphone input level', exact: true })).toHaveAttribute('aria-valuetext', 'Hearing you', { timeout: 3000 });
  });
});

test.describe('voice input settings focus, lists, results and races', () => {
  test('voice input Set up dictation never leaves focus on the page body', async ({ page }) => {
    await page.goto('/?voice=local-fresh');
    await expect(prompt(page)).toBeEnabled();
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Set up dictation');
    await mic.focus();
    await page.evaluate(() => {
      const w = window as any, seen: string[] = (w.__focusTrail = []);
      const sample = () => { const el = document.activeElement; seen.push(!el || el === document.body ? 'BODY' : `${el.tagName}${el.id ? `#${el.id}` : ''}`); };
      w.__focusTimer = setInterval(sample, 0);
      const frame = () => { sample(); w.__focusFrame = requestAnimationFrame(frame); }; frame();
      document.addEventListener('focusout', () => queueMicrotask(sample), true);
    });
    await page.keyboard.press('Enter');
    await expect(card(page, UNIFIED).getByRole('button', { name: `Download ${UNIFIED}`, exact: true })).toBeFocused();
    await page.waitForTimeout(300);
    const trail: string[] = await page.evaluate(() => { const w = window as any; clearInterval(w.__focusTimer); cancelAnimationFrame(w.__focusFrame); return w.__focusTrail; });
    expect(trail.length).toBeGreaterThan(5);
    expect(trail.filter(entry => entry === 'BODY')).toEqual([]);
  });

  test('voice input speech service delete matches the model trash buttons, and its text uses the card type tokens', async ({ page }) => {
    for (const media of [{}, { contrast: 'more' as const }, { forcedColors: 'active' as const }]) {
      await page.emulateMedia({ contrast: null, forcedColors: null, ...media });
      await openVoiceSettings(page, 'local-ready');
      const trash = card(page, UNIFIED).getByRole('button', { name: `Delete ${UNIFIED}`, exact: true });
      const remove = voice(page).locator('[data-voice-delete]').first();
      await expect(remove).toBeVisible();
      // ds buttons draw their hairline as an inset shadow; forced colours swap it for a system border.
      const border = (el: Element) => { const s = getComputedStyle(el); return [s.borderTopStyle, s.borderTopWidth, s.borderTopColor, s.boxShadow, s.width, s.height]; };
      expect(await remove.evaluate(border), JSON.stringify(media)).toEqual(await trash.evaluate(border));
      const [style, , , shadow] = await remove.evaluate(border);
      if ('forcedColors' in media) expect(style).toBe('solid');
      else expect(shadow, JSON.stringify(media)).toContain('inset');
    }
    await page.emulateMedia({ contrast: null, forcedColors: null });
    const font = (el: Element) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight]; };
    const rowTitle = await voice(page).locator('#voice-mic').evaluate(font);
    const description = await voice(page).locator('#voice-mic-description').evaluate(el => { const s = getComputedStyle(el); return [s.fontSize, s.color]; });
    const profile = voice(page).locator('.voice-profile').first();
    expect(await profile.locator('strong').evaluate(font)).toEqual(rowTitle);
    for (const line of await profile.locator('small:not(.voice-profile-model)').all()) expect(await line.evaluate(el => { const s = getComputedStyle(el); return [s.fontSize, s.color]; })).toEqual(description);
    expect(await profile.locator('.voice-profile-model').evaluate(el => getComputedStyle(el).fontSize)).toBe(description[0]);
  });

  test('voice input explainer cites the Handy models benchmark in a sentence with an external link', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const explainer = voice(page).locator('.voice-explainer');
    await expect(explainer).toContainText('Grades and speeds come from the Handy models benchmark.');
    await expect(explainer).not.toContainText('(Handy models catalog)');
    const link = explainer.getByRole('link', { name: 'Handy models benchmark', exact: true });
    await expect(link).toHaveAttribute('href', 'https://github.com/handy-computer/models');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('voice input headings step down one level at a time and badges read separately', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const panel = page.locator('#settings-panel-voice');
    const levels = await panel.locator('h1,h2,h3,h4,h5,h6').evaluateAll(els => els.filter(el => (el as HTMLElement).offsetParent !== null || el.closest('[hidden]') === null).map(el => Number(el.tagName[1])));
    expect(levels[0]).toBe(2);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `heading ${i}: ${levels.join(',')}`).toBeLessThanOrEqual(1);
    for (const name of ['Input', 'Transcription', 'Speech services']) await expect(voice(page).getByRole('heading', { name, exact: true, level: 3 })).toBeVisible();
    await expect(voice(page).getByRole('heading', { name: 'Languages', exact: true, level: 4 })).toBeVisible();
    await expect(voice(page).getByRole('heading', { name: /^Models for/, level: 4 })).toBeVisible();
    await expect(card(page, UNIFIED).getByRole('heading', { name: UNIFIED, exact: true, level: 5 })).toBeVisible();
    const badges = card(page, UNIFIED).getByRole('list', { name: 'Model features', exact: true });
    expect(await badges.getByRole('listitem').allTextContents()).toEqual(['Recommended', 'Live preview']);
  });

  test('voice input model test results land in a live region that existed before the result', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const announcer = voice(page).locator('[data-voice-model-announcer]');
    await expect(announcer).toHaveAttribute('role', 'status');
    await expect(announcer).toHaveText('');
    const node = await announcer.elementHandle();
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await expect(announcer).toHaveText(`Testing ${UNIFIED}. Say a sentence, then stop.`);
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    const transcript = unified.locator('.voice-model-transcript');
    await expect(transcript).toBeVisible();
    const text = (await transcript.textContent())!.trim();
    await expect(announcer).toHaveText(`${UNIFIED} heard: ${text}`);
    expect(await node!.evaluate(el => el.isConnected)).toBe(true);
    await expect(transcript).not.toHaveAttribute('role', /.+/);
    await expect(unified.getByRole('status')).toHaveCount(0);
  });

  test('voice input a disconnected saved microphone says the test uses the system default', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const device = voice(page).getByRole('combobox', { name: 'Microphone', exact: true });
    await expect(device).toHaveValue('Wireless Headset');
    await expect(device.locator('option:checked')).toHaveText('Wireless Headset (not connected)');
    // The fallback reads on a hint under the select, which also describes it; the select's title names the device.
    const hint = voice(page).locator('[data-voice-device-hint]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Not connected — using System default.');
    expect((await device.getAttribute('aria-describedby'))!.split(' ')).toContain(await hint.getAttribute('id'));
    await expect(device).toHaveAccessibleDescription(/Not connected — using System default\./);
    await expect(device).toHaveAttribute('title', 'Wireless Headset (not connected)');
    // At 1280 wide the option text is not cut off.
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await device.evaluate((el: HTMLSelectElement) => {
      const probe = document.createElement('span'), style = getComputedStyle(el);
      probe.style.font = style.font; probe.style.whiteSpace = 'pre'; probe.textContent = el.selectedOptions[0].text;
      document.body.append(probe); const text = probe.getBoundingClientRect().width; probe.remove();
      return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - text;
    })).toBeGreaterThanOrEqual(0);
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    const panel = voice(page).locator('[data-voice-mic-panel]');
    await expect(panel).toContainText(/Testing System default… \d+ s left/);
    await expect(panel.getByRole('status')).toContainText('from System default because Wireless Headset is not connected');
    await voice(page).getByRole('button', { name: 'Stop test', exact: true }).click();
    await expect(voice(page).getByRole('button', { name: 'Play test recording', exact: true })).toBeVisible();
    // A connected device keeps the plain wording.
    await device.selectOption('Studio USB Mic');
    await expect.poll(async () => (await localState(page)).preferences.deviceName).toBe('Studio USB Mic');
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(panel).toContainText(/Recording test… \d+ s left/);
    await expect(panel).not.toContainText('System default');
    await expect(hint).toBeHidden();
    await expect(device).toHaveAttribute('title', 'Studio USB Mic');
    await expect(device).not.toHaveAccessibleDescription(/Not connected/);
  });

  test('voice input device hint lines up with the microphone controls in narrow Settings', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 520 });
    await openVoiceSettings(page, 'local-ready');
    const device = voice(page).getByRole('combobox', { name: 'Microphone', exact: true });
    const hint = voice(page).locator('[data-voice-device-hint]');
    await expect(hint).toBeVisible();
    const controls = voice(page).locator('.voice-setting-controls:has([data-voice-device])');
    // The narrow rule moves the controls to the left; the hint under them follows, starting where they start.
    expect(await controls.evaluate(el => getComputedStyle(el).justifyContent)).toBe('flex-start');
    const first = await voice(page).locator('[data-voice-mic-test]').boundingBox();
    const textX = await hint.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().x; });
    expect(Math.abs(textX - first!.x)).toBeLessThanOrEqual(1);
    expect(await hint.evaluate(el => getComputedStyle(el.parentElement!).textAlign)).toMatch(/^(start|left)$/);
  });

  test('voice input inner lists hand wheel scrolling to the page in a short window', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 480 });
    const settings = await openVoiceSettings(page, 'local-ready');
    const content = settings.locator('.settings-content');
    // Short window: both lists are capped to a share of the window, with no scroll containment.
    for (const list of [languages(page), models(page)]) {
      expect(await list.evaluate(el => getComputedStyle(el).maxHeight)).toBe(`${Math.min(26 * 16, 0.45 * 480)}px`);
      expect(await list.evaluate(el => getComputedStyle(el).overscrollBehaviorY)).toBe('auto');
      // Bring the list to the top of the page, with page left to scroll below it, and scroll the list to its end.
      await list.evaluate(el => {
        const scroller = el.closest('.settings-content')!;
        scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
        el.scrollTop = el.scrollHeight;
      });
      const before = await content.evaluate(el => el.scrollTop);
      expect(await content.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(20);
      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 60));
      // Past the end of the list the wheel scrolls the page. Real wheel events finish a sub-pixel remainder of the list
      // first (a scrollTop write rounds), so poll a little longer than usual.
      await expect.poll(async () => { await page.mouse.wheel(0, 120); return content.evaluate(el => el.scrollTop); }, { timeout: 15_000 }).toBeGreaterThan(before);
    }
  });

  test('voice input browser lists are capped at 26rem in a tall window', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openVoiceSettings(page, 'local-ready');
    for (const list of [languages(page), models(page)]) {
      const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(await list.evaluate(el => getComputedStyle(el).maxHeight)).toBe(`${26 * rem}px`);
      expect((await list.boundingBox())!.height).toBeLessThanOrEqual(26 * rem + 1);
      expect(await list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    }
  });

  test('voice input PageDown and PageUp move a page of languages, clamped at the ends', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const list = languages(page), options = list.getByRole('option');
    const focusedIndex = () => list.evaluate(el => [...el.querySelectorAll('[role="option"]')].indexOf(document.activeElement!));
    const count = await options.count();
    expect(count).toBeGreaterThan(22);
    await options.first().focus();
    await page.keyboard.press('PageDown');
    const step = await focusedIndex();
    expect(step).toBeGreaterThanOrEqual(5);
    expect(step).toBeLessThanOrEqual(10);
    await expect(options.nth(step)).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('PageDown');
    expect(await focusedIndex()).toBe(2 * step);
    await page.keyboard.press('PageUp');
    expect(await focusedIndex()).toBe(step);
    await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp');
    expect(await focusedIndex()).toBe(0);
    await page.keyboard.press('End');
    await page.keyboard.press('PageDown');
    expect(await focusedIndex()).toBe(count - 1);
    await page.keyboard.press('PageUp');
    expect(await focusedIndex()).toBe(count - 1 - step);
  });

  test('voice input Refresh microphones announces and shows the result even when the list is unchanged', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const device = voice(page).getByRole('combobox', { name: 'Microphone', exact: true });
    await expect(device.locator('option')).toHaveCount(4);
    const live = voice(page).locator('[data-voice-device-status]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');
    await voice(page).getByRole('button', { name: 'Refresh microphones', exact: true }).click();
    await expect(live).toHaveText('Microphones refreshed: 2 found');
    await expect(live).toBeVisible();
    await expect(device.locator('option')).toHaveCount(4);
    await expect(live).toBeHidden({ timeout: 6_000 });
  });

  test('voice input cards keep their place after Select and Download until the list is filtered or revisited', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    const start = [UNIFIED, WHISPER, CANARY, NEMOTRON, TDT, VOXTRAL];
    expect(await modelNames(page)).toEqual(start);
    const focusedCard = () => page.evaluate(() => document.activeElement?.closest('.voice-model-card')?.getAttribute('aria-label') ?? null);
    await card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true }).click();
    await expect(card(page, WHISPER).getByRole('button', { name: `Test ${WHISPER}`, exact: true })).toBeFocused();
    expect(await modelNames(page)).toEqual(start);
    await card(page, TDT).getByRole('button', { name: `Download ${TDT}`, exact: true }).click();
    await expect(card(page, TDT).getByRole('button', { name: `Select ${TDT}`, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(voice(page).locator('[data-voice-local-status]')).toContainText(`${TDT} downloaded`);
    expect(await modelNames(page)).toEqual(start);
    expect(await focusedCard()).toBe(TDT);
    // A search re-sorts.
    const search = voice(page).getByRole('searchbox', { name: 'Search models', exact: true });
    await search.fill('a'); await search.fill('');
    const sorted = [WHISPER, UNIFIED, TDT, CANARY, NEMOTRON, VOXTRAL];
    await expect.poll(() => modelNames(page)).toEqual(sorted);
    // So does a fresh visit, after an action reordered nothing.
    await card(page, UNIFIED).getByRole('button', { name: `Select ${UNIFIED}`, exact: true }).click();
    await expect(card(page, UNIFIED).getByRole('button', { name: `Test ${UNIFIED}`, exact: true })).toBeFocused();
    expect(await modelNames(page)).toEqual(sorted);
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await page.keyboard.press('Meta+,');
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await expect.poll(() => modelNames(page)).toEqual([UNIFIED, TDT, WHISPER, CANARY, NEMOTRON, VOXTRAL]);
  });

  test('voice input model list notices are list items, never bare children of the list', async ({ page }) => {
    const bare = () => models(page).evaluate(el => [...el.children].filter(child => child.getAttribute('role') !== 'listitem').map(child => child.outerHTML.slice(0, 80)));
    await openVoiceSettings(page, 'local-ready');
    await voice(page).getByRole('searchbox', { name: 'Search models', exact: true }).fill('zzz');
    await expect(models(page).getByRole('listitem')).toHaveText('No models match “zzz”.');
    expect(await bare()).toEqual([]);
    await openVoiceSettings(page, 'local-unsupported');
    await expect(models(page).getByRole('note')).toContainText('not supported on this computer');
    expect(await bare()).toEqual([]);
  });

  test('voice input a test the window close ended goes back to idle without an error', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const levelListeners = () => page.evaluate(() => (window as any).__previewListenerCount('voice://mic-test-level'));
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(voice(page).getByText(/s left/)).toBeVisible();
    await expect.poll(levelListeners).toBe(1);
    await page.evaluate(() => (window as any).__voiceSimulateTestEnded('mic'));
    await expect(voice(page).locator('[data-voice-mic-panel]')).toBeHidden();
    await expect(voice(page).locator('[data-voice-input-error]')).toBeHidden();
    await expect(voice(page).getByRole('button', { name: 'Test microphone', exact: true })).toBeVisible();
    expect(await levelListeners()).toBe(0);
    expect((await localState(page)).micTesting).toBe(false);
    // The countdown's own stop never fires afterwards.
    expect((await page.evaluate(() => (window as any).__voiceCalls)).some((c: any) => c.command === 'voice_mic_test_stop')).toBe(false);

    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__voiceSimulateTestEnded('model'));
    await expect(unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true })).toBeVisible();
    await expect(unified).not.toContainText('Test failed');
    await expect(unified.getByRole('alert')).toHaveCount(0);
    expect((await localState(page)).testing).toBeNull();
  });

  test('voice input a delete that reaches a model under test never cancels it or races native', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    const stop = unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true });
    await expect(stop).toBeVisible();
    const id = (await localState(page)).testing;
    // No control offers Delete while testing (it is disabled); a confirm that arrives anyway must leave the test alone.
    await unified.evaluate((el, modelId) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.voiceModelConfirmDelete = modelId; el.append(button); button.click();
    }, id);
    await page.waitForTimeout(300);
    const calls = await page.evaluate(() => (window as any).__voiceCalls);
    expect(calls.filter((c: any) => c.command === 'voice_local_delete')).toEqual([]);
    expect(calls.filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel')).toEqual([]);
    await expect(stop).toBeVisible();
    expect((await localState(page)).testing).toBe(id);
  });

  test('voice input a preference reload started before a save never brings back the older values', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const mode = voice(page).getByRole('combobox', { name: 'Dictation shortcut', exact: true });
    await expect(mode).toHaveValue('auto');
    // Select reloads the preferences; hold that reply (it carries the values from before the save below).
    await page.evaluate(() => { (window as any).__voicePreferencesHold = true; });
    await card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__voicePreferencesRelease)).toBe('function');
    await mode.selectOption('hold');
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__voicePreferencesRelease());
    await expect(card(page, WHISPER).getByRole('button', { name: `${WHISPER} selected`, exact: true })).toBeVisible();
    await expect.poll(async () => (await localState(page)).preferences.shortcutMode).toBe('hold');
    await page.waitForTimeout(300);
    await expect(mode).toHaveValue('hold');
  });

  test('voice input progress fill transitions only after the app is ready', () => {
    const css = readFileSync(new URL('../src/voice-settings.css', import.meta.url), 'utf8');
    const ungated = css.split('}').filter(rule => /voice-model-progress-fill[^{]*\{[^}]*transition:\s*scale/.test(rule) && !/html\[data-ready\]/.test(rule));
    expect(ungated).toEqual([]);
    expect(css).toMatch(/html\[data-ready\][^{]*\.voice-model-progress-fill\{[^}]*transition:scale/);
  });
});
