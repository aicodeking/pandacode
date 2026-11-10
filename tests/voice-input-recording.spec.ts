import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release } from './voice-test-helpers';

test.describe('voice input', () => {
  test('recording prompt rejects typing and submission; Enter stops, held Enter cannot send, and typing returns during transcription', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('Keep this draft');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 9));
    const before = await page.locator('.message').count(); await start(page);
    await expect(prompt(page)).toHaveJSProperty('readOnly', true);
    await prompt(page).focus(); await page.keyboard.type('invisible edits'); await expect(prompt(page)).toHaveValue('Keep this draft');
    expect(await prompt(page).evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([5, 9]);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('#composer').evaluate(el => (el as HTMLFormElement).requestSubmit());
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording'); expect(await page.locator('.message').count()).toBe(before);
    await prompt(page).focus(); await page.keyboard.down('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing'); await expect(prompt(page)).toHaveJSProperty('readOnly', false);
    await page.keyboard.down('Enter'); expect(await page.locator('.message').count()).toBe(before); await page.keyboard.up('Enter');
    await prompt(page).pressSequentially('edit'); await release(page);
    await expect(prompt(page)).toHaveValue('Keep A dictated draft. edit draft'); await expect(pill(page)).toBeHidden();
  });

  for (const keyboard of [false, true]) test(`Stop restores immediate typing at the selection with keyboard ${keyboard}`, async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('keep selected text');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 13)); await start(page);
    const stop = pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true });
    if (keyboard) { await stop.focus(); await page.keyboard.down('Enter'); } else await stop.click();
    await expect(prompt(page)).toBeFocused();
    expect(await prompt(page).evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([5, 13]);
    if (keyboard) { await page.keyboard.down('Enter'); await page.keyboard.up('Enter'); }
    await page.keyboard.type('typed'); await expect(prompt(page)).toHaveValue('keep typed text');
    await release(page); await expect(prompt(page)).toHaveValue('keep A dictated draft. typed text');
    await expect(pill(page)).toBeHidden();
  });

  test('permission wait locks the draft and submission, then restores accessible guidance', async ({ page }) => {
    await open(page, 'start-delayed'); await prompt(page).fill('keep waiting draft');
    const original = await prompt(page).getAttribute('aria-description');
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'starting'); await expect(prompt(page)).toHaveJSProperty('readOnly', true);
    await prompt(page).focus(); await page.keyboard.type('lost'); await page.keyboard.press('Enter');
    await expect(prompt(page)).toHaveValue('keep waiting draft'); await expect(pill(page)).toHaveAttribute('data-phase', 'starting');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'starting');
    await expect(prompt(page)).not.toHaveAttribute('aria-description', /Enter to send/);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(prompt(page)).toHaveAttribute('aria-description', original!);
    await page.evaluate(() => { const w = window as any; for (const id of w.__voiceState().held) w.__voiceStartRelease(id); });
  });

  test('clicking the waveform preserves the locked selection and recording guidance', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('keep selected text');
    const original = await prompt(page).getAttribute('aria-description');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 13)); await start(page);
    await expect(prompt(page)).toHaveAttribute('aria-description', /Enter.*stop.*Escape.*cancel/i);
    await page.locator('.voice-wave-canvas').click({ position: { x: 5, y: 5 } });
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('typed'); await expect(prompt(page)).toHaveValue('keep typed text');
    await expect(prompt(page)).toHaveAttribute('aria-description', original!);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await release(page);
  });

  test('missing canvas context keeps the recording draft visible and locked', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args: any[]) {
        if (this.classList.contains('voice-wave-canvas')) return null;
        return original.apply(this, args as any);
      } as typeof original;
    });
    await open(page, 'delayed'); await prompt(page).fill('Visible recording draft'); await start(page);
    await page.waitForTimeout(220);
    await expect(prompt(page)).toHaveCSS('opacity', '1'); await expect(prompt(page)).toHaveJSProperty('readOnly', true);
    await expect(pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true })).toBeVisible();
  });

  test('Send while recording explains how to send and keeps capturing', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('Keep this draft'); await start(page);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(pill(page).locator('.voice-label')).toHaveText('Stop dictation to send');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording'); await expect(prompt(page)).toHaveValue('Keep this draft');
    await expect(pill(page).locator('.voice-label')).toHaveText(/Listening|No input/, { timeout: 5000 });
  });

  for (const phase of ['starting', 'recording']) test(`locked ${phase} selection commands preserve the insertion cursor`, async ({ page }) => {
    if (phase === 'starting') await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace('if (hold !== stage) return;', 'if (hold !== stage) return; await new Promise(resolve => setTimeout(resolve, 600));') });
    });
    await open(page, phase === 'starting' ? 'start-delayed' : 'delayed');
    await page.evaluate(() => { (window as any).__voiceHold = true; });
    await prompt(page).fill('Keep this draft.');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', phase);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => prompt(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([5, 5]);
    if (phase === 'starting') {
      await page.waitForFunction(() => (window as any).__voiceState().held.length > 0);
      await page.evaluate(() => { const w = window as any; for (const id of w.__voiceState().held) w.__voiceStartRelease(id); });
      await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    }
    await page.keyboard.press('Enter'); await release(page);
    await expect(prompt(page)).toHaveValue('Keep A dictated draft. this draft.');
  });

  for (const key of ['Enter', 'Space']) test(`recording leaves Attach ${key} activation intact`, async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).focus();
    await page.keyboard.press(key);
    await expect(page.getByRole('dialog', { name: 'Attach', exact: true })).toBeVisible();
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
  });

  test('long transcription keeps recorded duration and exposes elapsed without live announcement flooding', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 860, height: 940 });
    await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceManualLevels = true; (window as any).__voiceRecordedMs = 6500; });
    await start(page);
    const source = await pill(page).locator('.voice-context').textContent();
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page).getByRole('timer')).toHaveAttribute('aria-live', 'off');
    await expect(pill(page).getByRole('timer')).toHaveAccessibleName(/recorded.*0:06/i);
    await page.evaluate(() => {
      (window as any).__voiceAnnouncements = [];
      new MutationObserver(() => (window as any).__voiceAnnouncements.push(document.querySelector('#composer-live')?.textContent))
        .observe(document.querySelector('#composer-live')!, { childList: true, subtree: true, characterData: true });
    });
    // Real wall time: only audio duration is synthetic. This exercises the service-wait timer.
    const began = Date.now();
    await expect(pill(page).locator('.voice-label')).toContainText('Still transcribing', { timeout: 15_000 });
    await page.waitForTimeout(2100);
    await expect(pill(page).getByRole('timer')).toHaveAccessibleName(/recorded.*0:06.*(?:waiting|transcrib).*0:1[0-9]/i);
    await expect(pill(page).locator('.voice-context')).toHaveText(source!);
    const announcements = await page.evaluate(() => (window as any).__voiceAnnouncements.filter(Boolean));
    expect(announcements.length, 'announce the prolonged wait once, not each elapsed second').toBeLessThanOrEqual(2);
    expect(announcements.some((text: string) => /still transcribing/i.test(text))).toBe(true);
    await prompt(page).fill('Typing during the wait');
    await expect(prompt(page)).toBeFocused();
    await testInfo.attach('long-wait-observation', { body: Buffer.from(JSON.stringify({ observedWallMs: Date.now() - began, syntheticRecordedMs: 6500, announcements })), contentType: 'application/json' });
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await release(page);
    await expect(prompt(page)).toHaveValue('Typing during the wait');
  });

  test('microphone retains shortcut guidance and recording announces the time limit', async ({ page }) => {
    await open(page);
    const mic = page.locator('.voice-mic');
    await expect(mic).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+D Control+Shift+D');
    await expect(mic).toHaveAttribute('data-tip', /⇧D|Shift.*D/i);
    await start(page);
    await expect(mic).toHaveAttribute('data-tip', /⇧D|Shift.*D/i);
    await expect(pill(page)).toContainText(/2:00|2 min|120|two.minute/i);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
  });

  for (const stage of ['permission', 'device', 'reply']) for (const action of ['Cancel', 'navigate', 'disable']) {
    test(`${action} while Start awaits ${stage} permits immediate restart and rejects late reply`, async ({ page }) => {
      await open(page);
      const original = await prompt(page).getAttribute('data-session-id');
      await page.evaluate(stage => { (window as any).__voiceStartHold = stage; }, stage);
      await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
      await expect(pill(page)).toHaveAttribute('data-phase', 'starting');
      await expect.poll(() => page.evaluate(() => (window as any).__voiceState().held.length)).toBe(1);
      const requestId = await page.evaluate(() => (window as any).__voiceCalls.find((c: any) => c.command === 'voice_start').requestId);
      if (action === 'Cancel') await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
      if (action === 'navigate') {
        await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
        await page.locator(`.task-item[data-id="${original}"]`).click();
      }
      if (action === 'disable') {
        await page.keyboard.press('Meta+,');
        const settings = page.getByRole('region', { name: 'Settings', exact: true });
        await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
        await page.locator('#voice-settings').getByRole('button', { name: 'Turn off voice input', exact: true }).click();
        await expect.poll(async () => (await calls(page)).some((c: any) => c.command === 'voice_cancel' && c.requestId === requestId)).toBe(true);
        await page.locator('#voice-settings').getByRole('button', { name: 'Use Local speech', exact: true }).click();
        await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      }
      await expect.poll(async () => (await calls(page)).some((c: any) => c.command === 'voice_cancel' && c.requestId === requestId)).toBe(true);
      await expect(pill(page)).toBeHidden();
      expect(await page.evaluate(() => (window as any).__voiceState().active.length)).toBe(0);
      // The first Start is still held. A new request must acquire the microphone immediately.
      await start(page);
      const current = await page.evaluate(() => (window as any).__voiceState().active[0]);
      expect(current.requestId).not.toBe(requestId);
      await page.evaluate(requestId => (window as any).__voiceStartRelease(requestId), requestId);
      await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
      await expect.poll(() => page.evaluate(() => (window as any).__voiceState().active.length)).toBe(1);
      await expect(prompt(page)).toHaveValue('');
      await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__voiceState().active.length)).toBe(0);
    });
  }

  for (const scenario of ['empty', 'no-audio']) test(`${scenario} offers Record again with a fresh capture`, async ({ page }) => {
    await open(page, scenario);
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toContainText(/No speech detected|No audio captured/);
    await expect(pill(page).locator('[data-voice="retry"]')).toHaveCount(0);
    await expect(pill(page)).not.toContainText(/Retry resends/);
    expect(await page.evaluate(() => (window as any).__voiceState().active)).toEqual([]);
    expect((await calls(page)).some((c: any) => c.command === 'voice_retry')).toBe(false);
    await page.evaluate(() => { (window as any).__voiceText = 'Fresh dictation.'; });
    await pill(page).getByRole('button', { name: 'Discard and record again', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveValue('Fresh dictation.');
    expect((await calls(page)).filter((c: any) => c.command === 'voice_start')).toHaveLength(2);
  });

  test('unavailable recordings reject Stop and Retry as terminal failures', async ({ page }) => {
    await open(page);
    const failures = await page.evaluate(async () => {
      const { invoke } = await import('/src/preview.ts' as string);
      return Promise.all(['voice_stop', 'voice_retry'].map(async command => {
        try { await invoke(command, { captureId: 'missing-recording' }); return null; }
        catch (reason) { return reason; }
      }));
    });
    expect(failures).toEqual([
      { message: 'Recording is no longer available.', retryable: false },
      { message: 'Recording is no longer available.', retryable: false },
    ]);
    expect(await page.evaluate(() => (window as any).__voiceState().active)).toEqual([]);
  });

  for (const message of ['Recording limit reached. Transcribe or discard.', 'Microphone disconnected. Transcribe the captured audio.']) {
    test(`before upload ${message} offers transcription without resend guidance`, async ({ page }) => {
      await open(page);
      await start(page);
      await page.evaluate(message => {
        const active = (window as any).__voiceState().active[0];
        (window as any).__previewEmit('voice-event', { requestId: active.requestId, captureId: active.captureId,
          phase: 'error', elapsedMs: 120000, level: 0, message });
      }, message);
      await expect(pill(page).getByRole('button', { name: 'Transcribe recording', exact: true })).toBeVisible();
      await expect(pill(page)).not.toContainText(/Retry resends/);
      expect((await calls(page)).some((c: any) => c.command === 'voice_stop' || c.command === 'voice_retry')).toBe(false);
      await pill(page).getByRole('button', { name: 'Transcribe recording', exact: true }).click();
      await expect(prompt(page)).toHaveValue('A dictated draft.');
      expect((await calls(page)).filter((c: any) => c.command === 'voice_stop')).toHaveLength(1);
      expect((await calls(page)).some((c: any) => c.command === 'voice_retry')).toBe(false);
    });
  }

  test('records measured input, stops into a draft and never auto-sends', async ({ page }) => {
    await open(page);
    const before = await page.locator('.message').count();
    await start(page);
    const meter = pill(page).getByRole('meter', { name: 'Microphone input level' });
    await expect.poll(() => meter.evaluate(el => (el as HTMLMeterElement).value)).toBeGreaterThan(0);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    await expect(pill(page)).toBeHidden();
    expect(await page.locator('.message').count()).toBe(before);
    expect((await calls(page)).filter((c: any) => c.command === 'voice_stop')).toHaveLength(1);
  });

  test('generic error before terminal rejection never exposes or announces Retry', async ({ page }) => {
    await open(page, 'no-audio');
    await page.evaluate(() => {
      (window as any).__voiceTerminalDelay = 300;
      (window as any).__voiceRecoveryMutations = [];
      const read = () => (window as any).__voiceRecoveryMutations.push({
        text: document.querySelector('.voice-pill')?.textContent,
        live: document.querySelector('#composer-live')?.textContent,
      });
      new MutationObserver(read).observe(document.querySelector('#composer-area')!, { subtree: true, childList: true, characterData: true });
      new MutationObserver(read).observe(document.querySelector('#composer-live')!, { subtree: true, childList: true, characterData: true });
    });
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    // The error already says Record again, so the context explains it without repeating the words.
    await expect(pill(page)).toContainText('Recording again uses your current Settings.');
    await expect(pill(page).getByRole('button', { name: 'Retry original recording', exact: true })).toHaveCount(0);
    const mutations = await page.evaluate(() => (window as any).__voiceRecoveryMutations);
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.some((m: any) => /Retry|Retry resends/.test(`${m.text} ${m.live}`))).toBe(false);
  });

  test('cancel rejects a late transcription result', async ({ page }) => {
    await open(page, 'delayed');
    await prompt(page).fill('Keep this');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await release(page);
    await expect(prompt(page)).toHaveValue('Keep this');
    await expect(pill(page)).toBeHidden();
    expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(true);
  });

  test('failure retains audio for retry and discard ends the attempt', async ({ page }) => {
    await open(page, 'failure');
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await pill(page).getByRole('button', { name: 'Retry original recording', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    expect((await calls(page)).filter((c: any) => c.command === 'voice_start')).toHaveLength(1);
    expect((await calls(page)).filter((c: any) => c.command === 'voice_retry')).toHaveLength(1);
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await pill(page).getByRole('button', { name: 'Discard dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
  });

  for (const [scenario, errorText] of [['failure', ''], ['invalid-key', ''], ['failure', 'Speech service unavailable.']]) {
    test(`${scenario} card says to record again once${errorText ? ' when the error omits it' : ''}`, async ({ page }) => {
      await open(page, scenario);
      if (errorText) await page.evaluate(text => { (window as any).__voiceErrorText = text; }, errorText);
      await start(page);
      await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
      await expect(pill(page)).toHaveAttribute('data-phase', 'error');
      const visible = await pill(page).locator('.voice-details').innerText();
      expect(visible.match(/record again/gi) ?? []).toHaveLength(1);
      const description = await pill(page).getAttribute('aria-description') ?? '';
      expect(description.match(/record again/gi) ?? []).toHaveLength(1);
    });
  }

  for (const height of [320, 360]) test(`recording and transcribing cards keep two lines clear of their actions at 860x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 860, height }); await open(page, 'delayed');
    await prompt(page).fill('Expanded draft.\n'.repeat(14));
    const clear = () => pill(page).evaluate(el => {
      const card = el.getBoundingClientRect(), details = el.querySelector<HTMLElement>('.voice-details')!;
      const line = parseFloat(getComputedStyle(details).lineHeight);
      const parts = [el.querySelector('.voice-label')!, el.querySelector('.voice-clock')!, ...el.querySelectorAll('.voice-control')]
        .map(part => part.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      const inside = parts.every(rect => rect.top >= card.top - .5 && rect.bottom <= card.bottom + .5 && rect.top >= 0 && rect.bottom <= innerHeight);
      const apart = parts.every((a, i) => parts.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
      return { inside, apart, lines: details.clientHeight >= 2 * line - 1, parts: parts.length };
    });
    await start(page);
    await expect.poll(clear).toEqual({ inside: true, apart: true, lines: true, parts: 4 });
    await page.keyboard.press('Enter'); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect.poll(async () => { const { inside, apart, lines } = await clear(); return inside && apart && lines; }).toBe(true);
    await release(page); await expect(prompt(page)).toHaveValue(/A dictated draft\./);
    await expect.poll(() => page.locator('#composer').evaluate(el => el.hasAttribute('data-voice-compact'))).toBe(false);
  });

  test('Escape on an error card keeps the retained recording for Retry', async ({ page }) => {
    await open(page, 'failure'); await start(page); await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await pill(page).focus(); await page.keyboard.press('Escape');
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await expect(pill(page).getByRole('button', { name: 'Retry original recording', exact: true })).toBeVisible();
    expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(false);
  });

  test('the local route starts without a profile id and transcribes on this device', async ({ page }) => {
    await open(page, 'local-ready'); await page.evaluate(() => { (window as any).__voiceHold = true; });
    await start(page);
    await expect(pill(page).locator('.voice-context')).toContainText('Audio stays on this device');
    const begin = (await calls(page)).find((c: any) => c.command === 'voice_start');
    expect(begin.requestId).toBeTruthy(); expect('profileId' in begin).toBe(false);
    await page.keyboard.press('Enter');
    await expect(pill(page).locator('.voice-label')).toHaveText('Transcribing on this device…');
    await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('reduced motion leaves recording controls usable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await start(page);
    await expect(pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true })).toBeEnabled();
    const animations = await pill(page).evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').map(a => ({
      duration: a.effect?.getTiming().duration, iterations: a.effect?.getTiming().iterations,
      keys: (a.effect as KeyframeEffect)?.getKeyframes().flatMap(frame => Object.keys(frame)),
    })));
    // The design system permits brief opacity-only crossfades under Reduce Motion.
    for (const animation of animations) {
      expect(Number(animation.duration)).toBeLessThanOrEqual(150);
      expect(animation.iterations).toBe(1);
      expect(animation.keys.every(key => ['opacity', 'offset', 'computedOffset', 'easing', 'composite'].includes(key))).toBe(true);
    }
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
  });
  const stopCalls = async (page: import('@playwright/test').Page) => (await calls(page)).filter((c: any) => c.command === 'voice_stop').length;
  for (const transcribing of [true, false]) test(`closing the window while recording inserts its transcript once at the anchor (native transcribing event ${transcribing})`, async ({ page }) => {
    await open(page); await prompt(page).fill('Keep this draft');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 9)); await start(page);
    await page.evaluate(() => { (window as any).__voiceHold = true; });
    const closed = await page.evaluate(options => (window as any).__voiceSimulateWindowClose(options), { transcribing });
    expect(closed?.captureId).toBeTruthy();
    // The pill leaves recording as soon as native reports the stop (or, without that event, when the transcript lands).
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await release(page);
    await expect(prompt(page)).toHaveValue('Keep Closed window speech. draft');
    await expect(pill(page)).toBeHidden();
    // The transcript event and the Stop reply carry the same result: it is inserted once.
    await page.evaluate(({ captureId, requestId }) => (window as any).__previewEmit('voice://transcript', { captureId, requestId, text: 'Closed window speech.' }), closed);
    await page.waitForTimeout(200);
    await expect(prompt(page)).toHaveValue('Keep Closed window speech. draft');
    expect(await stopCalls(page)).toBe(1);
  });

  test('closed-window transcripts for a foreign or discarded capture are ignored', async ({ page }) => {
    await open(page); await prompt(page).fill('Keep this draft'); await start(page);
    const active = await page.evaluate(() => (window as any).__voiceState().active[0]);
    await page.evaluate(({ requestId }) => {
      const emit = (window as any).__previewEmit;
      emit('voice://transcript', { captureId: 'voice-capture-foreign', requestId, text: 'Foreign speech.' });
      emit('voice://transcript', { captureId: 'voice-capture-foreign', requestId: 'foreign-request', text: 'Foreign speech.' });
    }, active);
    await page.waitForTimeout(200);
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    expect(await stopCalls(page)).toBe(0);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
    await page.evaluate(({ captureId, requestId }) => (window as any).__previewEmit('voice://transcript', { captureId, requestId, text: 'Discarded speech.' }), active);
    await page.waitForTimeout(200);
    await expect(prompt(page)).toHaveValue('Keep this draft');
    await expect(pill(page)).toBeHidden();
    expect(await stopCalls(page)).toBe(0);
  });
});
