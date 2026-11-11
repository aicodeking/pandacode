import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release, mockVoiceSend } from './voice-test-helpers';

test.describe('voice input', () => {
  test('successful preview transcript remains recoverable when the prompt is temporarily disabled', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).evaluate(el => { (el as HTMLTextAreaElement).disabled = true; });
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(pill(page)).toContainText('A dictated draft.');
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await prompt(page).evaluate(el => { (el as HTMLTextAreaElement).disabled = false; });
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
  });

  test('stopped transcript survives slash picker completion', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('/hel'); await page.locator('.slash-menu').getByRole('option').first().click();
    await expect(prompt(page)).toHaveValue('/help '); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
  });

  test('stopped transcript survives Clear draft while the agent is running', async ({ page }) => {
    await mockVoiceSend(page, 'hold'); await open(page, 'delayed');
    await prompt(page).fill('Keep the agent running'); await prompt(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await prompt(page).fill('Call Bob'); await start(page); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    await expect(prompt(page)).toHaveValue(''); await prompt(page).fill('Call Bob about lunch'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(prompt(page)).toHaveValue('Call Bob about lunch');
  });

  test('stopped transcript survives the /btw composer clear', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('/btw side question'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue(''); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
  });

  test('stopped transcript survives failed-send draft restoration', async ({ page }) => {
    await mockVoiceSend(page, 'fail'); await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('restore this message'); await prompt(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    await expect(prompt(page)).toHaveValue('restore this message');
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
  });

  test('Send with an empty review draft preserves the transcript without sending', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('edited'); await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await prompt(page).press('ControlOrMeta+a'); await prompt(page).press('Backspace');
    const count = await page.locator('.user-message').count();
    await prompt(page).press('Enter');
    await page.waitForTimeout(220); await expect(pill(page)).toBeVisible();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'review'); await expect(page.locator('.user-message')).toHaveCount(count);
  });

  test('Escape in a review draft preserves the transcript, while Escape in the voice card discards', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('edited'); await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await prompt(page).press('Escape'); await page.waitForTimeout(220); await expect(pill(page)).toBeVisible();
    await pill(page).focus(); await page.keyboard.press('Escape'); await expect(pill(page)).toBeHidden();
  });

  for (const [draft, caret, edited, expected] of [
    ['hello', 5, 'hello typed', 'hello A dictated draft. typed'],
    ['head tail', 5, 'new head tail', 'new head A dictated draft. tail'],
  ] as const) test(`stopped anchor inserts through edits: ${edited}`, async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill(draft);
    await prompt(page).evaluate((el, at) => (el as HTMLTextAreaElement).setSelectionRange(at, at), caret);
    await start(page); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).fill(edited); await release(page); await expect(prompt(page)).toHaveValue(expected);
    await expect(pill(page)).toBeHidden();
  });

  for (const selection of [[11, 11], [8, 11]]) test(`auto insertion preserves the typing selection ${selection}`, async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('hello'); await start(page); await page.keyboard.press('Enter');
    await page.keyboard.type(' world'); await prompt(page).evaluate((el, range) => el.setSelectionRange(range[0], range[1]), selection);
    await release(page); await expect(prompt(page)).toHaveValue('hello A dictated draft. world');
    await expect(prompt(page)).toBeFocused();
    const offset = ' A dictated draft.'.length;
    expect(await prompt(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection.map(at => at + offset));
    await page.keyboard.type('!');
    const value = 'hello A dictated draft. world', [first, last] = selection.map(at => at + offset);
    await expect(prompt(page)).toHaveValue(value.slice(0, first) + '!' + value.slice(last));
  });

  test('review details keep focus and scroll through a composer refresh', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'Review scroll preservation. '.repeat(200); });
    await start(page); await page.keyboard.press('Enter'); await prompt(page).fill('changed'); await release(page);
    const details = pill(page).getByRole('region', { name: 'Dictation details', exact: true });
    await details.focus(); await page.keyboard.press('PageDown');
    const top = await details.evaluate(el => el.scrollTop); expect(top).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new Event('pandacode-github-change')));
    await expect(details).toBeFocused(); expect(await details.evaluate(el => el.scrollTop)).toBe(top);
  });

  test('empty Send during transcription preserves automatic insertion', async ({ page }) => {
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await release(page);
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
    expect((await calls(page)).some((call: any) => call.command === 'send_message')).toBe(false);
  });

  test('review preserves paragraph and list breaks exactly as insertion does', async ({ page }) => {
    const text = 'First paragraph.\n\n- First item\n- Second item';
    await open(page, 'delayed'); await page.evaluate(text => { (window as any).__voiceText = text; }, text);
    await start(page); await page.keyboard.press('Enter'); await prompt(page).fill('changed'); await release(page);
    const transcript = pill(page).locator('.voice-transcript');
    await expect(transcript).toHaveCSS('white-space', 'pre-wrap');
    expect(await transcript.innerText()).toBe(text);
    await prompt(page).fill(''); await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue(text);
  });

  test('explicit Insert during IME explains pending action and held Enter cannot send its later insertion', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).focus();
    await prompt(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    const insert = pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true });
    await insert.click();
    await expect(pill(page)).toContainText('Finish composing, then choose Insert at cursor.');
    await expect(prompt(page)).toHaveValue('');
    await prompt(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await insert.focus(); await page.keyboard.down('Enter');
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(prompt(page)).toBeFocused();
    const before = await page.locator('.message').count();
    await page.keyboard.down('Enter'); await page.keyboard.down('Enter');
    expect(await page.locator('.message').count()).toBe(before);
    await page.keyboard.up('Enter'); await page.keyboard.type(' Safe typing');
    await expect(prompt(page)).toHaveValue('A dictated draft. Safe typing');
    await page.keyboard.press('Enter'); await expect.poll(() => page.locator('.message').count()).toBeGreaterThan(before);
  });

  for (const reduced of [false, true]) test(`recovery transition preserves draft typing and focus with reduced motion ${reduced}`, async ({ page }, testInfo) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).fill('Original edited draft');
    await prompt(page).focus();
    await page.evaluate(() => {
      (window as any).__voiceRecoveryMotion = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.matches('.voice-pill,.voice-controls')) (window as any).__voiceRecoveryMotion.push({ target: this.className, frames, options });
        return animate.call(this, frames, options);
      };
    });
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(prompt(page)).toBeFocused();
    await page.keyboard.type(' Still typing');
    await expect(prompt(page)).toHaveValue('Original edited draft Still typing');
    const motion = await page.evaluate(() => (window as any).__voiceRecoveryMotion);
    if (reduced) expect(motion).toEqual([]);
    else expect(motion.length).toBeGreaterThan(0);
    await testInfo.attach('recovery-motion', { body: Buffer.from(JSON.stringify({ reduced, motion })), contentType: 'application/json' });
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('Original edited draft Still typing A dictated draft.');
    await expect(prompt(page)).toBeFocused();
  });

  test('inserted dictation keeps typing focus and held Enter cannot send before deliberate Enter', async ({ page }) => {
    await open(page, 'delayed');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).focus();
    await page.keyboard.down('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await release(page);
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    await expect(prompt(page)).toBeFocused();
    const before = await page.locator('.message').count();
    // Playwright marks a second down as repeat; this is a held key, not a new gesture.
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    expect(await page.locator('.message').count()).toBe(before);
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    await page.keyboard.up('Enter');
    await page.keyboard.type(' Continued typing');
    await expect(prompt(page)).toHaveValue('A dictated draft. Continued typing');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.message').count()).toBeGreaterThan(before);
  });

  test('transcript waits for IME completion without stealing draft focus', async ({ page }) => {
    await open(page, 'delayed');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).focus();
    await prompt(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(prompt(page)).toBeFocused();
    await expect(prompt(page)).toHaveValue('');
    await prompt(page).evaluate(el => {
      for (const key of ['Enter', 'Escape']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true });
        Object.defineProperties(event, { isComposing: { value: true }, keyCode: { value: 229 } });
        el.dispatchEvent(event);
      }
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    await expect(prompt(page)).toBeFocused();
    await page.keyboard.type(' More');
    await expect(prompt(page)).toHaveValue('A dictated draft. More');
  });

  test('ambiguous draft edits retain explicit insertion at the current cursor', async ({ page }) => {
    await open(page, 'delayed');
    await prompt(page).pressSequentially('Original');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).pressSequentially(' Original');
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(prompt(page)).toHaveValue('Original Original');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft. Original Original');
  });

  test('redraw preserves textarea identity and dictated insertion is undoable', async ({ page, browserName }) => {
    await open(page);
    await prompt(page).pressSequentially('Typed');
    await prompt(page).evaluate(el => { (el as any).__voiceKept = true; });
    await start(page);
    await page.evaluate(() => window.dispatchEvent(new Event('pandacode-github-change')));
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    expect(await prompt(page).evaluate(el => (el as any).__voiceKept)).toBe(true);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveValue('Typed A dictated draft.');
    // Chromium discards textarea undo history on reattachment; WebKit is the native target.
    if (browserName === 'webkit') {
      await prompt(page).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      await expect(prompt(page)).not.toHaveValue('Typed A dictated draft.');
      await expect(prompt(page)).not.toHaveValue(/A dictated draft/);
      await prompt(page).press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
      await expect(prompt(page)).toHaveValue('Typed A dictated draft.');
    }
  });

  test('a programmatic rewrite around a short anchor sends speech to review', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('the');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
    await start(page); await page.keyboard.press('Enter');
    await prompt(page).evaluate(el => { (el as HTMLTextAreaElement).value = 'Run the tests'; });
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review'); await expect(prompt(page)).toHaveValue('Run the tests');
  });
});
