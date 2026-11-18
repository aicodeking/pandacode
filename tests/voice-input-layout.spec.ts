import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release, mockVoiceSend } from './voice-test-helpers';

// Layout in narrow and short windows: floating cards, long review and error text, tray controls and the composer's
// size. Split from voice-input-visual.spec.ts; titles start inside 'voice input' so the WebKit config's grep picks them up.
test.describe('voice input', () => {
  test('short floating cards keep actions visible and unobscured while only the text scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'disclosure-profile');
    await page.evaluate(() => { (window as any).__voiceHold = true; (window as any).__voiceText = 'A lengthy transcript. '.repeat(150); });
    await start(page);
    const checkActions = async () => {
      await page.mouse.move(1, 1);
      await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
      const geometry = await pill(page).evaluate(el => {
        const r = el.getBoundingClientRect(), styles = getComputedStyle(el);
        const details = el.querySelector<HTMLElement>('.voice-details')!;
        return { top: r.top, bottom: r.bottom, overflow: styles.overflowY, blur: styles.backdropFilter || (styles as any).webkitBackdropFilter,
          parentBlur: getComputedStyle(document.querySelector('#composer')!).backdropFilter,
          textScroll: details.scrollHeight > details.clientHeight,
          actions: [...el.querySelectorAll('button')].map(button => { const b = button.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, inCard: b.top >= r.top && b.bottom <= r.bottom,
              clear: button.contains(document.elementFromPoint(b.x + b.width - 2, b.y + b.height / 2)) }; }) };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(580);
      expect(geometry.overflow).not.toBe('auto'); expect(geometry.textScroll).toBe(true);
      expect(geometry.blur).toMatch(/blur/); expect(geometry.parentBlur).toMatch(/blur/);
      for (const action of geometry.actions) { expect(action.inCard).toBe(true); expect(action.clear).toBe(true); }
      await pill(page).locator('.voice-details').evaluate(el => { el.scrollTop = el.scrollHeight; });
      for (const button of await pill(page).getByRole('button').all()) await expect(button).toBeInViewport();
    };
    await checkActions(); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('edited'); await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await checkActions(); await pill(page).getByRole('button', { name: 'Discard dictation', exact: true }).click();
  });

  for (const height of [390, 280]) test(`short ${height}px window keeps review details and actions usable`, async ({ page }) => {
    await page.setViewportSize({ width: 860, height }); await mockVoiceSend(page, 'hold'); await open(page, 'delayed');
    await prompt(page).fill('Send while transcribing.');
    await page.evaluate(() => { (window as any).__voiceText = 'Long review. '.repeat(200); });
    await start(page); await page.keyboard.press('Enter'); await prompt(page).press('Enter');
    await expect(page.locator('#composer.composer-running')).toBeVisible();
    await prompt(page).fill('Expanded draft.\n'.repeat(14)); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect.poll(() => pill(page).evaluate(el => {
      const card = el.getBoundingClientRect(), composer = document.querySelector('#composer')!.getBoundingClientRect();
      const details = el.querySelector<HTMLElement>('.voice-details')!, heading = el.querySelector('.voice-label')!.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(details).lineHeight);
      const actions = [...el.querySelectorAll('button')].every(button => {
        const r = button.getBoundingClientRect(); return r.top >= card.top && r.bottom <= card.bottom && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      return card.top >= 8 && card.bottom <= composer.top - 4 && heading.top >= 8 && heading.bottom <= card.bottom
        && details.clientHeight >= 2 * line - 1 && actions;
    })).toBe(true);
    for (const button of await page.locator('#composer .composer-actions button').all()) {
      if (await button.isVisible()) expect(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    }
    await expect(pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true })).toBeVisible();
    await expect(pill(page).getByRole('button', { name: 'Discard dictation', exact: true })).toBeVisible();
  });

  for (const [width, height] of [[1000, 380], [860, 360], [1200, 420]]) test(`${width}x${height} window never clips transcribing details or the review box`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'A short dictated review.'; });
    await start(page); await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    const unclipped = () => pill(page).evaluate(el => {
      const details = el.querySelector<HTMLElement>('.voice-details')!, card = el.getBoundingClientRect();
      const box = details.getBoundingClientRect(), transcript = el.querySelector<HTMLElement>('.voice-transcript')!;
      const shown = transcript.hidden ? null : transcript.getBoundingClientRect();
      return el.getAnimations().length === 0 && details.scrollHeight <= details.clientHeight + 1 && card.top >= 0 && card.bottom <= innerHeight
        && (!shown || (shown.bottom <= box.bottom + 0.5 && shown.top >= box.top - 0.5));
    });
    await expect.poll(unclipped).toBe(true);
    await prompt(page).fill('Edited while transcribing.'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(pill(page).locator('.voice-transcript')).toBeVisible();
    await expect.poll(unclipped).toBe(true);
    for (const button of await pill(page).getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 });
  });

  test('wide transcription pill leaves every tray control clickable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 940 }); await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(pill(page)).toHaveAttribute('data-floating', '');
    await expect.poll(() => page.locator('#composer > .composer-tray').evaluate(el => {
      const controls = [...el.querySelectorAll<HTMLElement>('button')].filter(button => button.getClientRects().length);
      return controls.length >= 3 && controls.every(button => {
        const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      });
    })).toBe(true);
  });

  test('expanded next draft keeps the long review card and heading within the short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await mockVoiceSend(page, 'hold'); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'A lengthy review transcript. '.repeat(150); });
    await start(page); await page.keyboard.press('Enter'); await prompt(page).fill('Sent message'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue(''); await prompt(page).fill('Expanded next draft.\n'.repeat(14)); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect.poll(() => pill(page).evaluate(el => {
      const card = el.getBoundingClientRect(), heading = el.querySelector('.voice-label')!.getBoundingClientRect();
      return card.top >= 8 && card.bottom <= innerHeight - 8 && heading.top >= 8 && heading.bottom <= innerHeight - 8;
    })).toBe(true);
  });

  for (const width of [320, 390, 860]) for (const phase of ['error', 'review']) test(`long ${phase} stays readable at ${width}px with the normal tray usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page, 'delayed');
    await page.evaluate(phase => {
      (window as any).__voiceText = 'A lengthy dictated phrase to review safely in the composer. '.repeat(5);
      (window as any).__voiceFailNext = phase === 'error';
      (window as any).__voiceErrorText = 'The speech service rejected this recording. Retry uses the original model and destination. To use corrected settings, discard and record again. '.repeat(2);
    }, phase);
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    if (phase === 'review') await prompt(page).pressSequentially('My edited draft');
    await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', phase);
    // Check settled readability; WebKit includes transient materialization overflow in scrollWidth.
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    const geometry = await pill(page).evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, right: rect.right, overflow: el.scrollWidth - el.clientWidth,
        clipped: [...el.querySelectorAll<HTMLElement>('.voice-label, .voice-context')].some(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) };
    });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width + 1);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.clipped).toBe(false);
    for (const control of await pill(page).getByRole('button').all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    const model = page.locator('#model-picker-trigger');
    await expect(model).toBeVisible();
    await expect(model).toBeEnabled();
    await model.click();
    await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pill(page)).toHaveAttribute('data-phase', phase);
    await pill(page).getByRole('button', { name: 'Discard dictation', exact: true }).click();
  });

  for (const width of [320, 390, 860]) test(`review puts its source on its own line and never breaks a model name at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 }); await open(page, 'delayed');
    await start(page); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).pressSequentially('My edited draft'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    const layout = await pill(page).locator('.voice-context').evaluate(context => {
      const lines = (node: Node, text: string) => {
        const at = node.textContent!.indexOf(text), range = document.createRange();
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let offset = 0, n: Node | null;
        while ((n = walker.nextNode())) {
          const length = n.textContent!.length;
          if (at >= offset && at + text.length <= offset + length) { range.setStart(n, at - offset); range.setEnd(n, at - offset + text.length); break; }
          offset += length;
        }
        return [...new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top)))];
      };
      const instruction = lines(context, 'Insert at cursor.'), source = lines(context, 'Local speech');
      return { text: context.textContent, model: lines(context, 'whisper-1').length,
        ownLine: Math.min(...source) > Math.max(...instruction) };
    });
    expect(layout.text).not.toMatch(/Insert at cursor\.\s*·/);
    expect(layout.model).toBe(1);
    expect(layout.ownLine).toBe(true);
    await pill(page).getByRole('button', { name: 'Discard dictation', exact: true }).click();
  });

  for (const width of [320, 390]) test(`keeps composer height and voice controls inside ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page, 'delayed');
    const before = await page.locator('#composer').boundingBox();
    await start(page);
    const after = await page.locator('#composer').boundingBox();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    const bounds = await pill(page).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await expect(pill(page).locator('.voice-context')).toContainText('whisper-1');
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    // The UI paints transcribing before the asynchronous preview IPC is logged.
    await expect.poll(async () => (await calls(page)).some((c: any) => c.command === 'voice_stop')).toBe(true);
    // A late native meter frame must not revive recording after Stop.
    await page.evaluate(() => {
      const w = window as any, start = w.__voiceCalls.find((c: any) => c.command === 'voice_start');
      const stop = w.__voiceCalls.find((c: any) => c.command === 'voice_stop');
      w.__previewEmit('voice-event', { requestId: start.requestId, captureId: stop.captureId, phase: 'recording', elapsedMs: 2000, level: 0.8 });
    });
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(page.locator('.voice-mic')).toHaveAccessibleName('Show dictation status');
    await page.locator('.voice-mic').click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await release(page);
    await expect(pill(page)).toBeHidden();
    await expect(prompt(page)).toHaveValue('');
  });

  test('docked inspector leaves a supported desktop composer narrow enough for wrapped voice controls', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 940 });
    await open(page, 'delayed');
    if (!await page.locator('.inspector').isVisible()) await page.getByRole('button', { name: 'Toggle inspector', exact: true }).click();
    await expect(page.locator('.inspector')).toBeVisible();
    const before = await page.locator('#composer').boundingBox();
    expect(before!.width).toBeLessThanOrEqual(520);
    await start(page);
    let recordingBounds: { x: number; y: number; width: number; height: number } | null = null;
    for (const phase of ['recording', 'transcribing']) {
      await expect(pill(page)).toHaveAttribute('data-phase', phase);
      const bounds = await pill(page).boundingBox();
      const composer = await page.locator('#composer').boundingBox();
      await expect(page.locator('#model-picker-trigger')).toBeVisible();
      await expect(page.locator('#model-picker-trigger')).toBeEnabled();
      if (phase === 'recording') recordingBounds = bounds;
      else { expect(bounds!.height).toBeCloseTo(recordingBounds!.height, 0); expect(bounds!.y).toBeCloseTo(recordingBounds!.y, 0); }
      expect(composer!.height).toBeCloseTo(before!.height, 0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composer!.y + 1);
      const clipped = await pill(page).evaluate(el => [...el.querySelectorAll<HTMLElement>('.voice-label,.voice-context')].some(n => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1));
      expect(clipped).toBe(false);
      for (const control of await pill(page).getByRole('button').all()) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(composer!.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(composer!.x + composer!.width + 1);
      }
      if (phase === 'recording') await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    }
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await release(page);
  });
});
