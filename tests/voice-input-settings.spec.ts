import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release } from './voice-test-helpers';

test.describe('voice input', () => {
  for (const stage of ['transcribing', 'review']) for (const change of ['off', 'delete'])
    test(`successful profile ${change} preserves ${stage} speech`, async ({ page }) => {
      await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
      if (stage === 'review') { await prompt(page).fill('changed'); await release(page); }
      await page.keyboard.press('Meta+,');
      const settings = page.getByRole('region', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
      const voice = page.locator('#voice-settings');
      if (change === 'off') await voice.getByRole('button', { name: 'Turn off voice input', exact: true }).click();
      else {
        await voice.getByRole('button', { name: 'Delete Local speech', exact: true }).click();
        await voice.getByRole('button', { name: 'Confirm deleting Local speech', exact: true }).click();
      }
      await expect(voice).toContainText(change === 'off' ? 'Voice input turned off.' : 'Speech profile deleted.');
      await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      await expect(pill(page)).toHaveAttribute('data-phase', stage);
      expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(false);
      if (stage === 'transcribing') { await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.'); }
      else {
        await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
        await expect(prompt(page)).toHaveValue('changed A dictated draft.');
      }
    });

  for (const stage of ['transcribing', 'review']) test(`failed configuration refresh preserves speech during ${stage}`, async ({ page }) => {
    const warnings: string[] = []; page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    if (stage === 'review') { await prompt(page).fill('changed'); await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review'); }
    await page.evaluate(() => {
      (window as any).__voiceFailCommands = { voice_configuration: 1 };
      window.dispatchEvent(new Event('voice-configuration-changed'));
    });
    await expect.poll(() => warnings.some(text => text.includes('Voice configuration refresh failed.'))).toBe(true);
    await expect(pill(page)).toHaveAttribute('data-phase', stage);
    if (stage === 'transcribing') { await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.'); }
    else {
      await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
      await expect(prompt(page)).toHaveValue('changed A dictated draft.');
    }
  });

  test('configuration selects models and preserves profiles without exposing credentials', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    const voice = page.locator('#voice-settings');
    await expect(voice).toContainText('Voice input is off');
    await voice.getByRole('button', { name: 'Speech provider', exact: true }).click();
    await page.getByRole('dialog', { name: 'Speech provider', exact: true }).getByRole('menuitemradio', { name: 'Groq', exact: true }).click();
    await voice.getByRole('button', { name: 'Speech model', exact: true }).click();
    await page.getByRole('dialog', { name: 'Speech model', exact: true }).getByRole('menuitemradio', { name: 'whisper-large-v3', exact: true }).click();
    await voice.getByLabel('Profile name', { exact: true }).fill('Speech test');
    await voice.getByLabel('API key', { exact: true }).fill('preview-secret-only');
    await voice.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(voice).toContainText('Speech profile saved.');
    await expect(voice).toContainText('Voice input is off');
    await expect(voice.getByLabel('API key', { exact: true })).toHaveValue('');
    await voice.getByRole('button', { name: 'Use Speech test', exact: true }).click();
    await expect(voice).toContainText('Ready to dictate: Speech test');
    await voice.getByRole('button', { name: 'Edit Speech test', exact: true }).click();
    await expect(voice.getByRole('button', { name: 'Speech model', exact: true })).toContainText('whisper-large-v3');
    await expect(voice).toContainText('Key saved securely');
    expect(JSON.stringify(await calls(page))).not.toContain('preview-secret-only');
    expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await page.keyboard.press('Meta+,');
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await expect(voice).toContainText('Ready to dictate: Speech test');
    await voice.getByRole('button', { name: 'Turn off voice input', exact: true }).click();
    await expect(voice).toContainText('Voice input is off');
    await voice.getByRole('button', { name: 'Delete Speech test', exact: true }).click();
    const cancelDelete = voice.getByRole('button', { name: 'Cancel deleting Speech test', exact: true });
    await expect(cancelDelete).toBeFocused();
    expect((await calls(page)).some((c: any) => c.command === 'voice_delete_profile')).toBe(false);
    await cancelDelete.press('Escape');
    await expect(voice.getByRole('button', { name: 'Delete Speech test', exact: true })).toBeFocused();
    await voice.getByRole('button', { name: 'Delete Speech test', exact: true }).click();
    await voice.getByRole('button', { name: 'Confirm deleting Speech test', exact: true }).click();
    await expect(voice).toContainText('No speech profiles yet.');
  });

  test('cloud profile without a key opens setup without attempting native Start', async ({ page }) => {
    await open(page, 'missing-key');
    // The mic already says a key is needed, and setup lands on that profile's API key field.
    const mic = page.getByRole('button', { name: 'Set up dictation', exact: true });
    await expect(mic).toHaveAttribute('data-tip', /API key/);
    await mic.click();
    const voice = page.locator('#voice-settings');
    const key = voice.getByLabel('API key', { exact: true });
    await expect(key).toBeFocused();
    await expect(key).toBeInViewport();
    await expect(voice.getByRole('heading', { name: 'Edit OpenAI speech', exact: true })).toBeVisible();
    expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
    expect(await page.evaluate(() => (window as any).__voiceState().active.length)).toBe(0);
  });

  test('failed profile save preserves edits and a deliberate retry clears the key field', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    // Voice input starts off: the setup mic opens Settings → Voice.
    await page.getByRole('button', { name: 'Set up dictation', exact: true }).click({ force: true });
    const voice = page.locator('#voice-settings');
    await voice.getByLabel('Profile name', { exact: true }).fill('Unsaved speech');
    await voice.getByLabel('API key', { exact: true }).fill('entered-preview-key');
    await page.evaluate(() => { (window as any).__voiceFailCommands = { voice_save_profile: 1 }; });
    await voice.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(voice.getByRole('alert')).toContainText('Your edits are kept');
    await expect(voice.getByLabel('Profile name', { exact: true })).toHaveValue('Unsaved speech');
    await expect(voice.getByLabel('API key', { exact: true })).toHaveValue('entered-preview-key');
    await voice.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(voice).toContainText('Speech profile saved.');
    await expect(voice.getByLabel('API key', { exact: true })).toHaveValue('');
    expect(JSON.stringify(await calls(page))).not.toContain('entered-preview-key');
  });

  test('Enter saves a profile without selecting it and destination typing is not live', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    // Voice input starts off: the setup mic opens Settings → Voice.
    await page.getByRole('button', { name: 'Set up dictation', exact: true }).click({ force: true });
    const voice = page.locator('#voice-settings');
    const name = voice.getByLabel('Profile name', { exact: true });
    await expect(name).toHaveAttribute('maxlength', '80');
    await expect(voice.getByLabel('Language (optional)', { exact: true })).toHaveAttribute('maxlength', '32');
    await expect(voice.locator('.voice-destination')).not.toHaveAttribute('aria-live', /polite|assertive/);
    await name.fill('Keyboard speech');
    await name.evaluate(el => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperties(event, { isComposing: { value: true }, keyCode: { value: 229 } });
      el.dispatchEvent(event);
    });
    expect((await calls(page)).some((c: any) => c.command === 'voice_save_profile')).toBe(false);
    await name.press('Enter');
    await expect(voice).toContainText('Speech profile saved.');
    await expect(voice).toContainText('Voice input is off');
    expect((await calls(page)).some((c: any) => c.command === 'voice_select_profile')).toBe(false);
  });

  test('Escape dismisses Settings and its model menu before cancelling dictation', async ({ page }) => {
    await open(page);
    await start(page);
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await page.locator('#voice-settings').getByRole('button', { name: 'Speech model', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Speech model', exact: true })).toBeHidden();
    await expect(settings).toBeVisible();
    expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.keyboard.press('Escape');
    await expect(pill(page)).toBeHidden();
  });

  test('Advanced reveals custom destination and reopens an invalid endpoint on save', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    // Voice input starts off: the setup mic opens Settings → Voice.
    await page.getByRole('button', { name: 'Set up dictation', exact: true }).click({ force: true });
    const voice = page.locator('#voice-settings');
    const advanced = voice.locator('.voice-advanced');
    await expect(advanced).not.toHaveAttribute('open', '');
    await voice.getByRole('button', { name: 'Speech provider', exact: true }).click();
    await page.getByRole('dialog', { name: 'Speech provider', exact: true }).getByRole('menuitemradio', { name: 'Local or custom server', exact: true }).click();
    await expect(advanced).toHaveAttribute('open', '');
    await voice.getByLabel('Transcription endpoint', { exact: true }).fill('');
    await advanced.locator('summary').click();
    await voice.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(advanced).toHaveAttribute('open', '');
    await expect(voice.getByLabel('Transcription endpoint', { exact: true })).toBeFocused();
    expect((await calls(page)).some((c: any) => c.command === 'voice_save_profile')).toBe(false);
  });

  test('first microphone use opens Settings / Voice and focuses where audio goes', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page)).toBeEnabled();
    // Voice input is off until it is set up, and the mic says so.
    // aria-disabled reads as unavailable but still activates; Playwright needs force to click it.
    await page.getByRole('button', { name: 'Set up dictation', exact: true }).click({ force: true });
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(settings.getByRole('tab', { name: 'Voice', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByRole('heading', { name: 'Voice', exact: true, level: 2 })).toBeVisible();
    const destination = page.locator('#voice-settings').getByRole('combobox', { name: 'Send microphone audio to', exact: true });
    await expect(destination).toBeInViewport();
    await expect(destination).toBeFocused();
    expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
  });

  for (const width of [320, 390, 860]) test(`permission guidance and Cancel fit at ${width}px before and after the wait`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page);
    await page.evaluate(() => { (window as any).__voiceStartHold = 'permission'; });
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'starting');
    const checkGeometry = async () => {
      const geometry = await pill(page).evaluate(el => ({
        pill: el.getBoundingClientRect().toJSON(), composer: document.querySelector('#composer')!.getBoundingClientRect().toJSON(),
        clipped: [...el.querySelectorAll<HTMLElement>('.voice-label, .voice-context')]
          .some(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1),
      }));
      expect(geometry.clipped).toBe(false);
      expect(geometry.pill.x).toBeGreaterThanOrEqual(0);
      expect(geometry.pill.right).toBeLessThanOrEqual(width + 1);
      if (width <= 520) expect(geometry.pill.bottom).toBeLessThanOrEqual(geometry.composer.y);
      await expect(pill(page).getByRole('button', { name: 'Cancel dictation', exact: true })).toBeInViewport();
    };
    await expect(pill(page).locator('.voice-label')).toHaveText('Starting microphone…');
    await checkGeometry();
    await expect(pill(page).locator('.voice-label')).toHaveText('Check microphone permission', { timeout: 7000 });
    await checkGeometry();
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
    expect(await page.evaluate(() => (window as any).__voiceState().active)).toEqual([]);
  });

  test('correcting a rejected key requires a fresh recording while Retry keeps its snapshot', async ({ page }) => {
    await open(page, 'invalid-key');
    await start(page);
    const original = await page.evaluate(() => (window as any).__voiceState().active[0]);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await expect(pill(page)).toContainText(/original settings/i);
    await expect(pill(page).getByRole('button', { name: 'Retry original recording', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__voiceState().active)).toEqual([{ ...original, recording: false }]);
    await pill(page).getByRole('button', { name: 'Open voice input settings', exact: true }).click();
    const voice = page.locator('#voice-settings');
    await voice.getByRole('button', { name: 'Edit Local speech', exact: true }).click();
    await voice.getByLabel('API key', { exact: true }).fill('corrected-preview-key');
    await voice.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(voice).toContainText('Speech profile saved.');
    await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await pill(page).getByRole('button', { name: 'Retry original recording', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await expect(prompt(page)).toHaveValue('');
    await expect(pill(page)).toContainText('Retry resends');
    expect(await page.evaluate(() => (window as any).__voiceState().active)).toEqual([{ ...original, recording: false }]);
    await pill(page).getByRole('button', { name: 'Discard and record again', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  for (const width of [540, 390, 320]) test(`saved profile actions stack within ${width}px Settings`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page, 'long-profile');
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    const voice = page.locator('#voice-settings');
    await voice.scrollIntoViewIfNeeded();
    const off = await voice.getByRole('button', { name: 'Turn off voice input', exact: true }).evaluate(el => {
      const rect = (node: Element) => {
        const { x, y, right, bottom } = node.getBoundingClientRect();
        return { x, y, right, bottom };
      };
      const range = document.createRange();
      range.selectNodeContents(el);
      return { button: rect(el), card: rect(el.closest('.voice-summary')!),
        text: [...range.getClientRects()].map(({ x, y, right, bottom }) => ({ x, y, right, bottom })) };
    });
    expect(off.button.x).toBeGreaterThanOrEqual(off.card.x);
    expect(off.button.right).toBeLessThanOrEqual(off.card.right);
    for (const text of off.text) {
      expect(text.x, 'Off text fits inside its button').toBeGreaterThanOrEqual(off.button.x);
      expect(text.right, 'Off text fits inside its button').toBeLessThanOrEqual(off.button.right);
      expect(text.y).toBeGreaterThanOrEqual(off.button.y);
      expect(text.bottom).toBeLessThanOrEqual(off.button.bottom);
    }
    const profile = voice.locator('.voice-profile').first();
    const body = await profile.locator(':scope > div').first().boundingBox();
    const actions = await profile.locator('.settings-row-actions').boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(body!.y + body!.height - 1);
    for (const button of await profile.getByRole('button').all()) {
      const rect = await button.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await settings.locator('.settings-content').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const editor = await voice.evaluate(el => {
      const heading = el.querySelector('h4')!;
      const range = document.createRange();
      range.selectNodeContents(heading);
      const rect = (node: Element) => {
        const { x, y, right, bottom, width, height } = node.getBoundingClientRect();
        return { x, y, right, bottom, width, height };
      };
      return { heading: rect(heading), lines: range.getClientRects().length,
        button: rect(el.querySelector('[data-voice-new]')!), field: rect(el.querySelector('.voice-field')!) };
    });
    expect(editor.lines, 'the editor heading wraps by words, not single letters').toBeLessThanOrEqual(3);
    for (const rect of [editor.heading, editor.button, editor.field]) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width + 1);
    }
    expect(editor.heading.right <= editor.button.x + 1 || editor.button.right <= editor.heading.x + 1
      || editor.heading.bottom <= editor.button.y + 1 || editor.button.bottom <= editor.heading.y + 1,
    'the heading and New profile button do not overlap').toBe(true);
    expect(editor.field.y).toBeGreaterThanOrEqual(Math.max(editor.heading.bottom, editor.button.bottom));
  });

  test('turning voice off during transcription keeps the stopped recording', async ({ page }) => {
    await open(page, 'delayed');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    await page.locator('#voice-settings').getByRole('button', { name: 'Turn off voice input', exact: true }).click();
    await release(page);
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(false);
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  for (const via of ['click', 'shortcut']) test(`voice off shows a setup mic and ${via} opens Settings → Voice without recording`, async ({ page }) => {
    await open(page, 'local-unsupported');
    const mic = page.locator('#composer .voice-mic');
    await expect(mic).toHaveAccessibleName('Set up dictation'); await expect(mic).not.toHaveAttribute('aria-disabled', /.*/);
    await expect(mic).toHaveAttribute('data-tip', /Voice input is off/); await expect(mic).not.toHaveAttribute('title');
    if (via === 'click') await mic.click(); else { await prompt(page).focus(); await page.keyboard.press('Meta+Shift+d'); }
    await expect(page.locator('#voice-settings').getByRole('combobox', { name: 'Send microphone audio to', exact: true })).toBeFocused();
    expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
  });
});
