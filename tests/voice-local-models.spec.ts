import { expect, test, type Page } from '@playwright/test';
import {
  CANARY, NEMOTRON, TDT, UNIFIED, VOXTRAL, WHISPER, card, languages, localState, modelNames, models, openVoiceSettings, prompt, voice,
} from './voice-local-helpers';

// Titles start with "voice input" so the WebKit config's grep picks this file up.

test.describe('voice input local models', () => {
  test('voice input has its own Settings / Voice page between Appearance and Agents', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(settings.getByRole('tab', { name: 'Voice', exact: true })).toBeVisible();
    const tabs = await settings.locator('.settings-nav-list>[role="tab"]').allTextContents();
    expect(tabs.slice(tabs.indexOf('Appearance'), tabs.indexOf('Appearance') + 3)).toEqual(['Appearance', 'Voice', 'Agents']);
    const tab = settings.getByRole('tab', { name: 'Voice', exact: true });
    await expect(tab.locator('svg rect')).toHaveCount(1);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByRole('heading', { name: 'Voice', exact: true, level: 2 })).toBeVisible();
    const headings = await voice(page).locator('.voice-card-title').allTextContents();
    expect(headings).toEqual(['Input', 'Transcription', 'Speech services']);
    const panes = await voice(page).locator('.voice-browser-pane').evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(({ x, y }) => ({ x, y })));
    expect(panes[1].x).toBeGreaterThan(panes[0].x + 100);
    expect(Math.abs(panes[1].y - panes[0].y)).toBeLessThanOrEqual(1);
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(page.locator('#settings-panel-general')).not.toContainText('Voice input');
    await expect(page.locator('#settings-panel-general #voice-settings')).toHaveCount(0);
  });

  test('voice input Set up dictation opens Settings / Voice directly, also from another open Settings page', async ({ page }) => {
    // No `voice-input` group redirect: Set up dictation asks for the Voice page itself.
    for (const file of ['/src/settings.ts', '/src/main.ts']) expect(await (await page.request.get(file)).text()).not.toContain('voice-input');
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#composer .voice-mic')!.click());
    await expect(settings.getByRole('tab', { name: 'Voice', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(voice(page).getByRole('combobox', { name: 'Send microphone audio to', exact: true })).toBeFocused();
  });

  test('voice input Set up dictation and Settings search both open Settings / Voice', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    // The setup mic works (it opens Settings), so it is not marked disabled; its tooltip names the missing step.
    const setup = page.getByRole('button', { name: 'Set up dictation', exact: true });
    await expect(setup).not.toHaveAttribute('aria-disabled', /.*/);
    await expect(setup).toHaveAttribute('data-tip', 'Set up dictation · Voice input is off. Turn it on in Settings → Voice.');
    await setup.click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(settings.getByRole('tab', { name: 'Voice', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(voice(page).getByRole('combobox', { name: 'Send microphone audio to', exact: true })).toBeFocused();
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    for (const words of ['whisper', 'parakeet', 'dictation microphone']) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+K');
      await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill(words);
      const hit = page.locator('#command-results button[data-action="settings-page"]');
      await expect(hit.first()).toHaveText('Settings › Voice');
      if (words === 'whisper') {
        await hit.first().click();
        await expect(page.locator('#settings-panel-voice')).toBeVisible();
        await expect(card(page, UNIFIED)).toBeVisible();
        await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      }
    }
  });

  test('voice input language search and multi-select filter the models', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const all = languages(page).getByRole('option', { name: 'All languages', exact: true });
    await expect(all).toHaveAttribute('aria-selected', 'true');
    const names = await languages(page).locator('.voice-language-row .ds-row-title').allTextContents();
    expect(names.slice(0, 4)).toEqual(['All languages', 'English', 'Chinese', 'Spanish']);
    await languages(page).getByRole('option', { name: 'Japanese', exact: true }).click();
    await expect(languages(page).getByRole('option', { name: 'Japanese', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(all).toHaveAttribute('aria-selected', 'false');
    await expect(voice(page).getByRole('heading', { name: 'Models for Japanese', exact: true })).toBeVisible();
    expect(await modelNames(page)).toEqual([WHISPER, NEMOTRON]);
    await voice(page).getByRole('searchbox', { name: 'Search languages', exact: true }).fill('wel');
    await languages(page).getByRole('option', { name: 'Welsh', exact: true }).click();
    await expect(voice(page).getByRole('heading', { name: 'Models for Japanese and Welsh', exact: true })).toBeVisible();
    expect(await modelNames(page)).toEqual([WHISPER]);
    await voice(page).getByRole('searchbox', { name: 'Search languages', exact: true }).fill('');
    await all.click();
    expect((await modelNames(page)).length).toBe(6);
    await voice(page).getByRole('searchbox', { name: 'Search models', exact: true }).fill('quick on any hardware');
    expect(await modelNames(page)).toEqual([CANARY]);
    await voice(page).getByRole('searchbox', { name: 'Search models', exact: true }).fill('nemotron-3.5');
    expect(await modelNames(page)).toEqual([NEMOTRON]);
  });

  test('voice input model cards show sorted facts and badges', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const order = await modelNames(page);
    expect(order).toEqual([UNIFIED, WHISPER, CANARY, NEMOTRON, TDT, VOXTRAL]);
    const tdt = card(page, TDT);
    // Browsing all languages, a model that supports English leads with it rather than its best-scoring language.
    await expect(tdt.locator('.voice-model-facts')).toHaveText(/^·English: A- \(4\.83% error\).*Speed: 1\.2 s \/ 30 s.*25 languages.*740 MB.*CC-BY-4\.0/);
    await expect(card(page, NEMOTRON).locator('.voice-model-fact').first()).toHaveText('·English: B (7.90% error)');
    await expect(tdt.locator('.voice-model-badge')).toHaveCount(0);
    await expect(card(page, UNIFIED).locator('.voice-model-badge')).toHaveText(['Recommended', 'Live preview']);
    await expect(card(page, CANARY).locator('.voice-model-badge')).toHaveText(['Recommended', 'Translate']);
    await languages(page).getByRole('option', { name: 'English', exact: true }).click();
    await languages(page).getByRole('option', { name: 'German', exact: true }).click();
    await expect(tdt.locator('.voice-model-facts')).toContainText('English: A- (4.83% error)');
    await expect(tdt.locator('.voice-model-facts')).toContainText('German: B+ (5.24% error)');
    await expect(tdt.locator('.voice-model-facts strong').first()).toHaveText('A-');
    await expect(card(page, UNIFIED)).toBeHidden();
  });

  test('voice input download shows progress, verifies, then selects', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    const canary = card(page, CANARY);
    await canary.getByRole('button', { name: `Download ${CANARY}`, exact: true }).click();
    const bar = canary.getByRole('progressbar', { name: `Download ${CANARY}`, exact: true });
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(canary.getByRole('button', { name: `Cancel downloading ${CANARY}`, exact: true })).toBeFocused();
    await page.evaluate(() => { const w = window as any; w.__voiceLocalHoldVerify = true; w.__voiceLocalHold = false; });
    await expect(canary.getByText('Verifying…')).toBeVisible();
    await expect(canary.getByRole('button', { name: `Cancel downloading ${CANARY}` })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__voiceLocalHoldVerify = false; });
    const select = canary.getByRole('button', { name: `Select ${CANARY}`, exact: true });
    await expect(select).toBeVisible();
    await expect(voice(page).locator('[data-voice-local-status]')).toHaveText(`${CANARY} downloaded.`);
    await select.click();
    await expect(canary.getByRole('button', { name: `${CANARY} selected`, exact: true })).toBeDisabled();
    await expect(canary.getByRole('button', { name: `Test ${CANARY}`, exact: true })).toBeFocused();
    // The card stays where it was while the page is open.
    expect(await modelNames(page)).toEqual([UNIFIED, WHISPER, CANARY, NEMOTRON, TDT, VOXTRAL]);
    await expect(card(page, UNIFIED).getByRole('button', { name: `Select ${UNIFIED}`, exact: true })).toBeVisible();
    const state = await localState(page);
    expect(state.preferences.selectedModel).toBe('handy-computer/canary-180m-flash-gguf');
  });

  test('voice input download can be cancelled', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    const tdt = card(page, TDT);
    await tdt.getByRole('button', { name: `Download ${TDT}`, exact: true }).click();
    await tdt.getByRole('button', { name: `Cancel downloading ${TDT}`, exact: true }).click();
    await expect(tdt.getByRole('button', { name: `Download ${TDT}`, exact: true })).toBeFocused();
    await expect(tdt.getByRole('progressbar')).toHaveCount(0);
    expect((await localState(page)).downloads).toEqual([]);
  });

  test('voice input a cancel that arrives as the download finishes announces the installed model', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    const tdt = card(page, TDT);
    await tdt.getByRole('button', { name: `Download ${TDT}`, exact: true }).click();
    // The preview finishes installing before it handles the cancel, like a native cancel that lands too late.
    await page.evaluate(() => { (window as any).__voiceLocalCancelTooLate = true; });
    await tdt.getByRole('button', { name: `Cancel downloading ${TDT}`, exact: true }).click();
    await expect(voice(page).locator('[data-voice-local-status]')).toHaveText(`${TDT} downloaded.`);
    await expect(tdt.getByRole('button', { name: `Select ${TDT}`, exact: true })).toBeFocused();
    await expect(tdt.getByRole('button', { name: `Download ${TDT}`, exact: true })).toHaveCount(0);
    expect((await localState(page)).models.find((m: any) => m.id.endsWith('parakeet-tdt-0.6b-v3-gguf')).state).toBe('installed');
  });

  test('voice input download failures stay on the card', async ({ page }) => {
    for (const [scenario, text] of [['local-disk-full', 'Not enough disk space'], ['local-verify-failed', 'did not match its checksum']]) {
      await openVoiceSettings(page, scenario);
      const canary = card(page, CANARY);
      await canary.getByRole('button', { name: `Download ${CANARY}`, exact: true }).click();
      await expect(canary.getByRole('alert')).toContainText(text);
      await expect(canary.getByRole('button', { name: `Download ${CANARY}`, exact: true })).toBeEnabled();
    }
  });

  test('voice input unsupported computers cannot pick this device', async ({ page }) => {
    await openVoiceSettings(page, 'local-unsupported');
    const destination = voice(page).getByRole('combobox', { name: 'Send microphone audio to', exact: true });
    await expect(destination).toHaveValue('off');
    await expect(destination.locator('option[value="local"]')).toBeDisabled();
    await expect(models(page).getByRole('note')).toContainText('not supported on this computer');
    await expect(card(page, CANARY).getByRole('button', { name: `Download ${CANARY}`, exact: true })).toBeDisabled();
  });

  test('voice input delete asks first and Escape keeps the model', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const whisper = card(page, WHISPER);
    await whisper.getByRole('button', { name: `Delete ${WHISPER}`, exact: true }).click();
    const keep = whisper.getByRole('button', { name: `Keep ${WHISPER}`, exact: true });
    await expect(keep).toBeFocused();
    await expect(whisper).toContainText('This frees 46 MB.');
    await keep.press('Escape');
    await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
    await expect(whisper.getByRole('button', { name: `Delete ${WHISPER}`, exact: true })).toBeFocused();
    await whisper.getByRole('button', { name: `Delete ${WHISPER}`, exact: true }).click();
    await whisper.getByRole('button', { name: `Confirm deleting ${WHISPER}`, exact: true }).click();
    await expect(whisper.getByRole('button', { name: `Download ${WHISPER}`, exact: true })).toBeFocused();
    expect((await localState(page)).models.find((m: any) => m.id.endsWith('whisper-tiny-gguf')).state).toBe('downloadable');
  });

  test('voice input model test shows a transcript in the card only', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    await expect(card(page, WHISPER).getByRole('button', { name: `Test ${WHISPER}` })).toHaveCount(0);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    const stop = unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true });
    await expect(stop).toBeFocused();
    await stop.click();
    await expect(unified.locator('.voice-model-transcript')).toHaveText('Testing local speech on this device.');
    await page.evaluate(() => { (window as any).__voiceLocalText = '  '; });
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    await expect(unified.locator('.voice-model-transcript')).toHaveText('No speech recognized. Try again.');
    await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(prompt(page)).toHaveValue('');
  });

  test('voice input microphone test plays back here and devices list the saved one', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const device = voice(page).getByRole('combobox', { name: 'Microphone', exact: true });
    await expect(device).toHaveValue('Wireless Headset');
    await expect(device.locator('option')).toHaveText(['System default', 'MacBook Pro Microphone (default)', 'Studio USB Mic', 'Wireless Headset (not connected)']);
    await device.selectOption('');
    await expect.poll(async () => (await localState(page)).preferences.deviceName).toBeNull();
    await voice(page).getByRole('button', { name: 'Refresh microphones', exact: true }).click();
    await expect(device.locator('option')).toHaveCount(3);
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(voice(page).getByText(/Recording test… \d+ s left/)).toBeVisible();
    await voice(page).getByRole('button', { name: 'Stop test', exact: true }).click();
    const playback = voice(page).getByRole('group', { name: 'Microphone test recording', exact: true });
    const play = playback.getByRole('button', { name: 'Play test recording', exact: true });
    await expect(play).toBeFocused();
    await expect(playback).toContainText('1.0 s recorded');
    await play.click();
    await expect(playback.getByRole('button', { name: 'Stop playback', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(playback.getByRole('button', { name: 'Play test recording', exact: true })).toBeVisible({ timeout: 4_000 });
    expect((await localState(page)).micTesting).toBe(false);
  });

  for (const width of [1440, 1100, 900]) test(`voice input microphone test status does not reflow the Microphone row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await openVoiceSettings(page, 'local-ready');
    const description = voice(page).locator('#voice-mic-description');
    const row = description.locator('xpath=ancestor::div[contains(@class,"voice-setting-row")]');
    const measure = async () => ({ text: (await description.boundingBox())!, row: (await row.boundingBox())! });
    // Measure once the device list (which sizes the select) has loaded.
    await expect(voice(page).getByRole('combobox', { name: 'Microphone', exact: true }).locator('option')).toHaveCount(4);
    const before = await measure();
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(voice(page).getByText(/Testing System default… \d+ s left/)).toBeVisible();
    const during = await measure();
    expect(during.text.height).toBe(before.text.height);
    expect(during.text.width).toBe(before.text.width);
    expect(during.row.height).toBe(before.row.height);
    await voice(page).getByRole('button', { name: 'Stop test', exact: true }).click();
    await expect(voice(page).getByRole('button', { name: 'Play test recording', exact: true })).toBeVisible();
    const after = await measure();
    expect(after.text.height).toBe(before.text.height);
    expect(after.row.height).toBe(before.row.height);
  });

  test('voice input model facts never start a wrapped line with a separator', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    let lineStarts = 0;
    for (let width = 1000; width <= 1800; width += 50) {
      await page.setViewportSize({ width, height: 940 });
      const bad = await models(page).locator('.voice-model-card').evaluateAll(cards => cards.flatMap(card => {
        const edge = card.querySelector('.voice-model-description, .voice-model-name')!.getBoundingClientRect().left;
        const facts = [...card.querySelectorAll('.voice-model-fact')].map(fact => fact.getBoundingClientRect());
        return [...card.querySelectorAll('.voice-model-fact')].flatMap((fact, index) => {
          const box = facts[index], dot = fact.querySelector('.voice-model-dot')?.getBoundingClientRect();
          const first = !facts.some((other, i) => i !== index && Math.abs(other.top - box.top) < 2 && other.left < box.left);
          if (!first || !dot || !dot.width) return [];
          (window as any).__lineStarts = ((window as any).__lineStarts ?? 0) + 1;
          return dot.left + dot.width / 2 >= edge ? [`${card.getAttribute('data-model-id')}: ${fact.textContent}`] : [];
        });
      }));
      expect(bad, `width ${width}`).toEqual([]);
      lineStarts = await page.evaluate(() => (window as any).__lineStarts ?? 0);
    }
    // Wrapped lines did occur, so the check above saw separators at line starts.
    expect(lineStarts).toBeGreaterThan(0);
  });

  test('voice input Stop during a pending model test start cancels it and goes back to idle', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalStartHold = true; });
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    const test = unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true });
    await expect(test).toBeFocused();
    // Cancel goes out at once (native aborts the pending start, which rejects with "Voice input was cancelled.").
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel').length).toBe(1);
    await page.evaluate(() => (window as any).__voiceLocalStartRelease());
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls))
      .filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel').length).toBe(1);
    expect((await localState(page)).testing).toBeNull();
    await expect(unified).not.toContainText('Test failed');
    await expect(unified.locator('.voice-model-transcript')).toHaveCount(0);
    await expect(test).toBeEnabled();
    expect((await page.evaluate(() => (window as any).__voiceCalls)).some((c: any) => c.command === 'voice_local_test_model' && c.action === 'stop')).toBe(false);
  });

  test('voice input a running model test disables its Delete and native refuses deleting it', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED), remove = unified.getByRole('button', { name: `Delete ${UNIFIED}`, exact: true });
    await expect(remove).toBeEnabled();
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true })).toBeVisible();
    await expect(remove).toBeDisabled();
    // Other cards stay deletable; only the tested model is protected.
    await expect(card(page, WHISPER).getByRole('button', { name: `Delete ${WHISPER}`, exact: true })).toBeEnabled();
    // The preview module instance the app loaded (same URL, so the same state) answers like native.
    const refused = await page.evaluate(async id => {
      const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => new URL(name).pathname === '/src/preview.ts')!;
      const preview = await import(/* @vite-ignore */ url);
      return preview.invoke('voice_local_delete', { modelId: id }).then(() => 'deleted', (e: any) => String(e?.message ?? e));
    }, (await localState(page)).testing);
    expect(refused).toBe('Stop the model test first.');
    await page.evaluate(() => { (window as any).__voiceLocalStopHold = true; });
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Transcribing test of ${UNIFIED}`, exact: true })).toBeVisible();
    await expect(remove).toBeDisabled();
    await page.evaluate(() => (window as any).__voiceLocalStopRelease());
    await expect(unified.locator('.voice-model-transcript')).toBeVisible();
    await expect(remove).toBeEnabled();
  });

  test('voice input leaving Settings while a model test transcribes cancels the transcription', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await page.evaluate(() => { (window as any).__voiceLocalStopHold = true; });
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Transcribing test of ${UNIFIED}`, exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel').length).toBe(1);
    await page.keyboard.press('Meta+,');
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await expect(unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true })).toBeEnabled();
    await expect(unified).not.toContainText('Test failed');
    await expect(unified.locator('.voice-model-transcript')).toHaveCount(0);
  });

  test('voice input leaving Settings during a pending model test start cancels it', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalStartHold = true; });
    await card(page, UNIFIED).getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel').length).toBe(1);
    await page.evaluate(() => (window as any).__voiceLocalStartRelease());
    await expect.poll(async () => (await localState(page)).testing).toBeNull();
    expect((await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_local_test_model' && c.action === 'cancel').length).toBe(1);
  });

  for (const how of ['Stop', 'leaving Settings']) test(`voice input ${how} during a pending microphone test start cancels it`, async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalStartHold = true; });
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    const stop = voice(page).getByRole('button', { name: 'Stop test', exact: true });
    await expect(stop).toBeVisible();
    if (how === 'Stop') {
      await stop.click();
      await expect(voice(page).getByRole('button', { name: 'Test microphone', exact: true })).toBeFocused();
    } else await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_mic_test_cancel').length).toBe(1);
    await page.evaluate(() => (window as any).__voiceLocalStartRelease());
    await expect.poll(async () => (await page.evaluate(() => (window as any).__voiceCalls)).filter((c: any) => c.command === 'voice_mic_test_cancel').length).toBe(1);
    expect((await localState(page)).micTesting).toBe(false);
    expect((await page.evaluate(() => (window as any).__voiceCalls)).some((c: any) => c.command === 'voice_mic_test_stop')).toBe(false);
    if (how === 'Stop') {
      await expect(voice(page).locator('[data-voice-mic-panel]')).toBeHidden();
      await expect(voice(page).locator('[data-voice-input-error]')).toBeHidden();
      await expect(voice(page).getByRole('button', { name: 'Test microphone', exact: true })).toBeVisible();
    }
  });

  test('voice input a cancelled Stop result leaves the model and microphone tests idle, not failed', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true }).click();
    await page.evaluate(() => { (window as any).__voiceLocalStopCancelled = true; });
    await unified.getByRole('button', { name: `Stop testing ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Test ${UNIFIED}`, exact: true })).toBeFocused();
    await expect(unified).not.toContainText('Test failed');
    await expect(unified.locator('.voice-model-transcript')).toHaveCount(0);
    await voice(page).getByRole('button', { name: 'Test microphone', exact: true }).click();
    await expect(voice(page).getByText(/Testing System default…/)).toBeVisible();
    await page.evaluate(() => { (window as any).__voiceLocalStopCancelled = true; });
    await voice(page).getByRole('button', { name: 'Stop test', exact: true }).click();
    await expect(voice(page).getByRole('button', { name: 'Test microphone', exact: true })).toBeVisible();
    await expect(voice(page).locator('[data-voice-mic-panel]')).toBeHidden();
    await expect(voice(page).locator('[data-voice-input-error]')).toBeHidden();
  });

  test('voice input refuses to delete the model an unfinished dictation is using', async ({ page }) => {
    await page.goto('/?voice=local-ready');
    await expect(prompt(page)).toBeEnabled();
    await page.evaluate(() => { (window as any).__voiceHold = true; });
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Voice dictation', exact: true })).toHaveAttribute('data-phase', 'recording');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'Voice dictation', exact: true })).toHaveAttribute('data-phase', 'transcribing');
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    const unified = card(page, UNIFIED);
    await unified.getByRole('button', { name: `Delete ${UNIFIED}`, exact: true }).click();
    await unified.getByRole('button', { name: `Confirm deleting ${UNIFIED}`, exact: true }).click();
    await expect(unified).toContainText('A dictation is using this model.');
    expect((await localState(page)).models.find((m: any) => m.id.endsWith('parakeet-unified-en-0.6b-gguf')).state).toBe('installed');
    // Another installed model is free to go.
    const whisper = card(page, WHISPER);
    await whisper.getByRole('button', { name: `Delete ${WHISPER}`, exact: true }).click();
    await whisper.getByRole('button', { name: `Confirm deleting ${WHISPER}`, exact: true }).click();
    await expect(whisper.getByRole('button', { name: `Download ${WHISPER}`, exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).__voiceRelease === 'function');
    await page.evaluate(() => (window as any).__voiceRelease());
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    await page.keyboard.press('Meta+,');
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await unified.getByRole('button', { name: `Delete ${UNIFIED}`, exact: true }).click();
    await unified.getByRole('button', { name: `Confirm deleting ${UNIFIED}`, exact: true }).click();
    await expect(unified.getByRole('button', { name: `Download ${UNIFIED}`, exact: true })).toBeVisible();
  });

  test('voice input destination switches between this device, off and a service', async ({ page }) => {
    await openVoiceSettings(page, 'ready');
    const destination = voice(page).getByRole('combobox', { name: 'Send microphone audio to', exact: true });
    const readiness = voice(page).locator('[data-voice-readiness]');
    await expect(destination).toHaveValue('profile:voice-preview');
    await expect(destination.locator('option')).toHaveText(['This device', 'Off', 'Local speech']);
    await expect(voice(page).locator('[data-voice-language-row]')).toBeHidden();
    await destination.selectOption('local');
    await expect(readiness).toHaveText(/Transcribing on this device/);
    await expect(voice(page).locator('[data-voice-language-row]')).toBeVisible();
    expect((await localState(page)).preferences.destination).toBe('local');
    await destination.selectOption('off');
    await expect(readiness).toHaveText('Voice input is off');
    await destination.selectOption('profile:voice-preview');
    await expect(readiness).toHaveText('Ready to dictate: Local speech');
    await voice(page).getByRole('button', { name: 'Turn off voice input', exact: true }).click();
    await expect(destination).toHaveValue('off');
  });

  test('voice input shortcut mode persists across Settings visits', async ({ page }) => {
    const settings = await openVoiceSettings(page, 'local-ready');
    const mode = voice(page).getByRole('combobox', { name: 'Dictation shortcut', exact: true });
    await expect(mode).toHaveValue('auto');
    await mode.selectOption('hold');
    await expect.poll(async () => (await localState(page)).preferences.shortcutMode).toBe('hold');
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await page.keyboard.press('Meta+,');
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await expect(voice(page).getByRole('combobox', { name: 'Dictation shortcut', exact: true })).toHaveValue('hold');
  });

  test('voice input language follows the selected model', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const language = voice(page).getByRole('combobox', { name: 'Language', exact: true });
    await expect(language.locator('option')).toHaveText(['Auto-detect', 'English']);
    await expect(voice(page).locator('#voice-language-pick-description')).toHaveText(`${UNIFIED} transcribes English.`);
    await card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true }).click();
    await expect(voice(page).locator('#voice-language-pick-description')).toHaveText(`${WHISPER} detects the language automatically.`);
    await expect(language.locator('option')).toHaveCount(100);
    await language.selectOption('ja');
    await expect.poll(async () => (await localState(page)).preferences.language).toBe('ja');
    await expect(voice(page).locator('#voice-language-pick-description')).toHaveText(`${WHISPER} transcribes Japanese.`);
  });

  // WebKit follows macOS, where Tab skips buttons unless Full Keyboard Access is on; there the rows are focused directly.
  test('voice input browser works from the keyboard', async ({ page, browserName }) => {
    await openVoiceSettings(page, 'local-ready');
    const tab = async (target: ReturnType<Page['locator']>) => {
      if (browserName === 'webkit') await target.focus(); else await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
    };
    const search = voice(page).getByRole('searchbox', { name: 'Search languages', exact: true });
    await search.focus();
    await page.keyboard.type('japan');
    // The list is one Tab stop (a div, so WebKit tabs to it too); arrows move inside it.
    await page.keyboard.press('Tab');
    await expect(languages(page).getByRole('option', { name: 'All languages', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(languages(page).getByRole('option', { name: 'Japanese', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(languages(page).getByRole('option', { name: 'Japanese', exact: true })).toHaveAttribute('aria-selected', 'true');
    await search.focus();
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
    const modelSearch = voice(page).getByRole('searchbox', { name: 'Search models', exact: true });
    await modelSearch.focus();
    await tab(card(page, WHISPER).getByRole('link', { name: 'Apache-2.0', exact: true }));
    await tab(card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true }));
    await page.keyboard.press('Enter');
    await expect(card(page, WHISPER).getByRole('button', { name: `Test ${WHISPER}`, exact: true })).toBeFocused();
  });

  test('voice input ArrowDown moves from each search into its list and ArrowUp from the first row returns', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const search = voice(page).getByRole('searchbox', { name: 'Search languages', exact: true });
    const option = (name: string) => languages(page).getByRole('option', { name, exact: true });
    await search.focus(); await page.keyboard.press('ArrowDown');
    await expect(option('All languages')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(search).toBeFocused();
    await page.keyboard.type('japan'); await page.keyboard.press('ArrowDown');
    await expect(option('Japanese')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(option('All languages')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(search).toBeFocused();
    const modelSearch = voice(page).getByRole('searchbox', { name: 'Search models', exact: true });
    await modelSearch.focus(); await page.keyboard.press('ArrowDown');
    await expect(card(page, UNIFIED).getByRole('button', { name: `${UNIFIED} selected`, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(modelSearch).toBeFocused();
    await modelSearch.fill('whisper'); await page.keyboard.press('ArrowDown');
    await expect(card(page, WHISPER).getByRole('button', { name: `Select ${WHISPER}`, exact: true })).toBeFocused();
  });

  test('voice input languages list is one Tab stop with arrow, Home, End and type-ahead keys', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const list = languages(page), option = (name: string) => list.getByRole('option', { name, exact: true });
    await expect(list).toHaveAttribute('aria-multiselectable', 'true');
    expect(await list.locator('[tabindex="0"]').count()).toBe(1);
    await voice(page).getByRole('searchbox', { name: 'Search languages', exact: true }).focus();
    const modelSearch = voice(page).getByRole('searchbox', { name: 'Search models', exact: true });
    let presses = 0;
    while (presses < 5 && !(await modelSearch.evaluate(el => el === document.activeElement))) { await page.keyboard.press('Tab'); presses++; }
    await expect(modelSearch).toBeFocused();
    expect(presses).toBeLessThanOrEqual(2);
    await page.keyboard.press('Shift+Tab');
    await expect(option('All languages')).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await expect(option('Chinese')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(option('English')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(option('English')).toHaveAttribute('aria-selected', 'true');
    await expect(option('English')).toBeFocused();
    expect(await option('English').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('End');
    const last = list.getByRole('option').last();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('Home');
    await expect(option('All languages')).toBeFocused();
    await page.keyboard.press('w');
    await expect(option('Welsh')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(option('Welsh')).toHaveAttribute('aria-selected', 'true');
    await expect(voice(page).getByRole('heading', { name: 'Models for English and Welsh', exact: true })).toBeVisible();
    // Leaving and coming back lands on the row last used.
    await page.keyboard.press('Tab');
    await expect(modelSearch).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(option('Welsh')).toBeFocused();
    expect(await list.locator('[tabindex="0"]').count()).toBe(1);
  });

  test('voice input names every catalog language, even where Intl.DisplayNames has no name', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const rows = await languages(page).getByRole('option').evaluateAll(els => els.map(el => ({
      code: el.getAttribute('data-voice-language'), name: el.textContent?.trim() ?? '',
    })));
    expect(rows.length).toBeGreaterThan(90);
    const unnamed = rows.filter(row => row.code && (row.name === row.code || row.name.toLowerCase() === row.code.toLowerCase()));
    expect(unnamed).toEqual([]);
    expect(rows.find(row => row.code === 'ba')?.name).toBe('Bashkir');
    expect(rows.find(row => row.code === 'bo')?.name).toBe('Tibetan');
  });

  test('voice input browser keeps its marks in forced colours and Increase Contrast', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active', contrast: 'more' });
    await openVoiceSettings(page, 'local-ready');
    await page.evaluate(() => { (window as any).__voiceLocalHold = true; });
    await languages(page).getByRole('option', { name: 'English', exact: true }).click();
    const english = languages(page).getByRole('option', { name: 'English', exact: true });
    expect(await english.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    const tdt = card(page, TDT);
    await tdt.getByRole('button', { name: `Download ${TDT}`, exact: true }).click();
    const track = tdt.locator('.voice-model-progress-track');
    expect(await track.evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('solid');
    const badge = card(page, CANARY).locator('.voice-model-badge').first();
    expect(await badge.evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('solid');
    // The Recommended star is a mark like the badge border: CanvasText, not the accent, in forced colours.
    const canvasText = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'CanvasText'; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
    expect(await badge.locator('.icon').evaluate(el => getComputedStyle(el).color)).toBe(canvasText);
    await page.emulateMedia({ forcedColors: 'none', contrast: 'more' });
    expect(await badge.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
    const fill = tdt.locator('.voice-model-progress-fill');
    expect(await fill.evaluate(el => getComputedStyle(el).width)).toBe(await track.evaluate(el => getComputedStyle(el).width));
  });

  test('voice input browser stacks without overflow at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const settings = await openVoiceSettings(page, 'local-ready');
    expect(await settings.locator('.settings-content').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const panes = await voice(page).locator('.voice-browser-pane').evaluateAll(els => els.map(el => el.getBoundingClientRect().x));
    expect(Math.abs(panes[0] - panes[1])).toBeLessThanOrEqual(1);
  });

  test('voice input short windows cap the Languages list so its search and the models stay in view', async ({ page }) => {
    for (const height of [600, 520]) {
      await page.setViewportSize({ width: 1000, height });
      const settings = await openVoiceSettings(page, 'local-ready');
      const content = settings.locator('.settings-content');
      const list = languages(page);
      const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      const cap = Math.min(26 * rem, 0.45 * height);
      expect((await list.boundingBox())!.height, `${height}px`).toBeLessThanOrEqual(cap + 1);
      expect(await list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
      // No scroll containment: a capped list hands the wheel to the page once it ends.
      expect(await list.evaluate(el => getComputedStyle(el).overscrollBehaviorY)).toBe('auto');
      // Each pane, its search included, fits inside the scrolling page.
      const visible = await content.evaluate(el => el.clientHeight);
      for (const pane of await voice(page).locator('.voice-browser-pane').all()) {
        expect((await pane.boundingBox())!.height, `${height}px pane`).toBeLessThanOrEqual(visible);
      }
      // Choosing a language near the end of the list leaves the models header on screen.
      const option = list.getByRole('option').last();
      await option.scrollIntoViewIfNeeded();
      await option.click();
      await expect(option).toHaveAttribute('aria-selected', 'true');
      await expect(voice(page).getByRole('heading', { name: /^Models for / })).toBeInViewport();
      await expect(voice(page).getByRole('searchbox', { name: 'Search languages', exact: true })).toBeInViewport();
    }
  });

  test('voice input Speech services summary spaces its title and description like the service rows', async ({ page }) => {
    await openVoiceSettings(page, 'local-ready');
    const summary = voice(page).locator('.voice-summary');
    const title = summary.locator('[data-voice-readiness]'), note = summary.locator('small');
    await expect(note).toHaveText('Speech models are separate from your coding agent.');
    const gap = (await note.boundingBox())!.y - ((await title.boundingBox())!.y + (await title.boundingBox())!.height);
    expect(gap).toBeGreaterThanOrEqual(3.5);
    expect(gap).toBeLessThanOrEqual(4.5);
    const reference = voice(page).locator('.voice-setting-description').first();
    const type = (el: Element) => { const style = getComputedStyle(el); return [style.fontSize, style.lineHeight, style.color]; };
    expect(await note.evaluate(type)).toEqual(await reference.evaluate(type));
  });
});
