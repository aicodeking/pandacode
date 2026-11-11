import { expect, test } from '@playwright/test';
import { prompt, pill, open, start, release, watchWaveFrames, waveFrameState, canvasPixels, matchesCanvasColor, mockVoiceSend } from './voice-test-helpers';

test.describe('voice input', () => {
  for (const width of [320, 1440]) test(`canvas preserves exact composer bounds and draft selection through recording, Stop and Cancel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 }); await watchWaveFrames(page); await open(page, 'delayed');
    await prompt(page).fill('Keep this draft and selection.');
    await prompt(page).evaluate(el => { (window as any).__originalPrompt = el; (el as HTMLTextAreaElement).setSelectionRange(5, 9); });
    await page.evaluate(() => document.fonts.ready);
    const before = await page.locator('#composer').boundingBox();
    await start(page);
    await expect(page.locator('.voice-wave-canvas')).toHaveCSS('opacity', '1');
    await expect(prompt(page)).toHaveCSS('opacity', '0');
    expect(await page.locator('#composer').boundingBox()).toEqual(before);
    expect(await prompt(page).evaluate(el => ({ same: el === (window as any).__originalPrompt, start: (el as HTMLTextAreaElement).selectionStart, end: (el as HTMLTextAreaElement).selectionEnd })))
      .toEqual({ same: true, start: 5, end: 9 });
    await expect(prompt(page)).toHaveValue('Keep this draft and selection.');
    await expect.poll(async () => (await waveFrameState(page)).count).toBeGreaterThan(3);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveCSS('opacity', '1');
    expect(await page.locator('#composer').boundingBox()).toEqual(before);
    expect((await waveFrameState(page)).pending).toBe(0);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await release(page);
    await expect(prompt(page)).toHaveValue('Keep this draft and selection.');
    expect(await page.locator('#composer').boundingBox()).toEqual(before);
    expect(await prompt(page).evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([5, 9]);
  });

  test('canvas pixels move between level events, match the accent and all waveform frames stop on cancel or hide', async ({ page }) => {
    await watchWaveFrames(page); await open(page);
    await page.evaluate(() => { (window as any).__voiceManualLevels = true; }); await start(page);
    await page.evaluate(() => { const w = window as any; w.__previewEmit('voice-event', { ...w.__voiceState().active[0], phase: 'recording', level: .64, elapsedMs: 100 }); });
    const canvas = page.locator('.voice-wave-canvas');
    await expect(canvas).toHaveCSS('opacity', '1');
    await page.waitForTimeout(200);
    const pixels = () => canvas.evaluate(canvasPixels);
    const first = await pixels(); await page.waitForTimeout(120); const second = await pixels();
    expect(first.colored).toBeGreaterThan(100); expect(matchesCanvasColor(first)).toBe(true); expect(second.image).not.toBe(first.image);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hidden = await waveFrameState(page); expect(hidden.pending).toBe(0);
    await page.waitForTimeout(100); expect((await waveFrameState(page)).count).toBe(hidden.count);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await waveFrameState(page)).count).toBeGreaterThan(hidden.count);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    const cancelled = await waveFrameState(page); expect(cancelled.pending).toBe(0);
    await page.waitForTimeout(220); expect((await waveFrameState(page)).count).toBe(cancelled.count);
    await expect(canvas).toHaveCSS('opacity', '0'); await expect(prompt(page)).toHaveCSS('opacity', '1');
  });

  test('reduced motion swaps instantly, uses no frames and samples a static waveform at most once per second', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await watchWaveFrames(page); await open(page);
    await start(page);
    const canvas = page.locator('.voice-wave-canvas');
    await expect(canvas).toHaveCSS('transition-duration', '0s'); await expect(prompt(page)).toHaveCSS('opacity', '0');
    await page.waitForTimeout(2200);
    const state = await waveFrameState(page); expect(state.count).toBe(0); expect(state.pending).toBe(0);
    // Ignore initial sizing paints; subsequent audio samples must be at least a second apart.
    const updates = state.draws.filter((at: number) => at > state.draws[0] + 250);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < updates.length; i++) expect(updates[i] - updates[i - 1]).toBeGreaterThanOrEqual(999);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(prompt(page)).toHaveCSS('opacity', '1');
  });

  test('canvas follows display density, resizing and accent changes while recording', async ({ browser, browserName }) => {
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 940 } });
    const page = await context.newPage();
    try {
      await open(page); await start(page);
      const canvas = page.locator('.voice-wave-canvas');
      const dimensions = () => canvas.evaluate(node => { const el = node as HTMLCanvasElement, r = el.getBoundingClientRect(), p = document.querySelector('#prompt')!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, px: el.width, py: el.height, prompt: { x: p.x, y: p.y, width: p.width, height: p.height } }; });
      const before = await dimensions(); expect(before.px).toBe(Math.ceil(before.width * 2)); expect(before.py).toBe(Math.ceil(before.height * 2));
      await page.setViewportSize({ width: 860, height: 940 });
      await expect.poll(async () => (await dimensions()).width).not.toBe(before.width);
      await expect.poll(async () => {
        const current = await dimensions();
        return current.x === current.prompt.x && current.y === current.prompt.y
          && current.width === current.prompt.width && current.height === current.prompt.height;
      }).toBe(true);
      const resized = await dimensions(); expect(resized.px).toBe(Math.ceil(resized.width * 2));
      expect({ x: resized.x, y: resized.y, width: resized.width, height: resized.height }).toEqual(resized.prompt);
      if (browserName === 'chromium') {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 940, deviceScaleFactor: 3, mobile: false });
        await expect.poll(async () => (await dimensions()).px).toBe(Math.ceil(resized.width * 3));
      }
      const margins = await canvas.evaluate(node => {
        const el = node as HTMLCanvasElement, style = getComputedStyle(document.querySelector('#prompt')!);
        // Rounded edge antialiasing may touch the adjacent physical pixel.
        const left = Math.max(1, Math.floor(parseFloat(style.paddingLeft) * devicePixelRatio) - 1), top = Math.floor(parseFloat(style.paddingTop) * devicePixelRatio), ctx = el.getContext('2d')!;
        const blank = (data: Uint8ClampedArray) => [...data].every((value, i) => i % 4 !== 3 || value === 0);
        return { left: blank(ctx.getImageData(0, 0, left, el.height).data), top: blank(ctx.getImageData(0, 0, el.width, top).data) };
      });
      expect(margins).toEqual({ left: true, top: true });
      await page.evaluate(() => document.documentElement.style.setProperty('--accent-ink', 'CanvasText'));
      await expect.poll(async () => { const pixels = await canvas.evaluate(canvasPixels); return matchesCanvasColor(pixels); }).toBe(true);
      await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    } finally { await context.close(); }
  });

  test('prompt keeps design-system transitions and forced recording dot uses CanvasText', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' }); await open(page); await start(page);
    const transitions = await prompt(page).evaluate(el => getComputedStyle(el).transitionProperty.split(',').map(p => p.trim()));
    expect.soft(transitions).toEqual(expect.arrayContaining(['opacity', 'background-color', 'box-shadow']));
    const dot = await pill(page).locator('.voice-dot').evaluate(el => {
      const probe = document.createElement('span'); probe.style.color = 'CanvasText'; document.body.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return { active: matchMedia('(forced-colors: active)').matches, actual: getComputedStyle(el).backgroundColor, expected };
    });
    if (dot.active) expect.soft(dot.actual).toBe(dot.expected);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
  });

  for (const reduced of [false, true]) test(`canvas rect fallback draws without roundRect with reduced motion ${reduced}`, async ({ page }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => { delete (CanvasRenderingContext2D.prototype as any).roundRect; });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await open(page); await start(page); if (reduced) await page.waitForTimeout(1150);
    await expect.poll(() => page.locator('.voice-wave-canvas').evaluate(node => {
      const el = node as HTMLCanvasElement, ctx = el.getContext('2d')!;
      const data = ctx.getImageData(0, 0, el.width, el.height).data;
      const style = getComputedStyle(document.querySelector('#prompt')!);
      const center = (el.offsetHeight + parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / 2 * devicePixelRatio;
      return [...data].some((v, i) => i % 4 === 3 && v > 0
        && Math.abs(Math.floor(i / 4 / el.width) - center) > 2 * devicePixelRatio);
    })).toBe(true);
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording'); expect(errors).toEqual([]);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
  });

  test('floating card anchors without has selector support', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'delayed'); await start(page);
    await page.evaluate(() => {
      for (const sheet of document.styleSheets) for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const rule = sheet.cssRules[i];
        if (rule instanceof CSSStyleRule && rule.selectorText.includes('.composer-area:has(')) sheet.deleteRule(i);
      }
      window.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.composer-area')).toHaveCSS('position', 'relative');
    expect(await pill(page).evaluate(el => el.offsetParent === document.querySelector('.composer-area'))).toBe(true);
  });

  test('voice controls retain a focus ring when focus-visible selectors are unsupported', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await page.evaluate(() => {
      const remove = (sheet: CSSStyleSheet | CSSGroupingRule) => {
        for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
          const rule = sheet.cssRules[i];
          if (rule instanceof CSSStyleRule && rule.selectorText.includes(':focus-visible')) sheet.deleteRule(i);
          else if ('cssRules' in rule) remove(rule as CSSGroupingRule);
        }
      };
      for (const sheet of document.styleSheets) remove(sheet);
    });
    const stop = pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true });
    await stop.focus(); await expect(stop).toHaveCSS('outline-style', 'solid'); await expect(stop).toHaveCSS('outline-width', '2px');
  });

  test('leaving card cannot receive input without native inert support', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(HTMLElement.prototype, 'inert', { configurable: true, get: () => false, set() {} }));
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = /leave:\s*(?:\(\s*element\s*\)|element)\s*=>\s*materializeOut\(element,\s*\{\s*scale:\s*1,\s*y:\s*0\s*\}\s*\),?/;
      expect(marker.test(source)).toBe(true);
      await route.fulfill({ response, body: source.replace(marker, 'leave: element => new Promise(resolve => { window.__voiceLeaveFinish = resolve; }),') });
    });
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    const leaving = page.locator('.voice-pill');
    await expect(leaving).toHaveAttribute('data-voice-leaving', ''); await expect(leaving).toHaveAttribute('aria-hidden', 'true');
    await expect(leaving).toHaveCSS('pointer-events', 'none'); await expect(leaving.locator('button').first()).toBeDisabled();
    await page.evaluate(() => (window as any).__voiceLeaveFinish()); await expect(leaving).toBeHidden(); await release(page);
  });

  for (const outcome of ['review', 'error']) test(`wide tray returns during transcription and remains visible in ${outcome}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 940 }); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceStartHold = 'permission'; });
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    const tray = page.locator('#composer > .composer-tray');
    await expect(pill(page)).toHaveAttribute('data-phase', 'starting'); await expect(tray).toHaveCSS('visibility', 'hidden');
    await page.waitForFunction(() => (window as any).__voiceState().held.length > 0);
    await page.evaluate(() => { const w = window as any; for (const id of w.__voiceState().held) w.__voiceStartRelease(id); });
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording'); await expect(tray).toHaveCSS('visibility', 'hidden');
    await page.keyboard.press('Enter'); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(tray).toHaveCSS('visibility', 'visible');
    await prompt(page).fill('changed');
    if (outcome === 'error') await page.evaluate(() => { (window as any).__voiceFailNext = true; });
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', outcome);
    await expect(tray).toHaveCSS('visibility', 'visible');
  });

  test('only overflowing details enter keyboard order as content and size change', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'A transcript to review. '.repeat(8); });
    await start(page); const details = pill(page).locator('.voice-details');
    const short = async () => {
      await expect.poll(() => details.evaluate(el => el.tabIndex)).toBe(-1);
      await expect(details).not.toHaveAttribute('role', 'region');
      await expect(details).not.toHaveAttribute('aria-label', 'Dictation details');
    };
    await short(); await page.keyboard.press('Enter'); await prompt(page).fill('changed');
    await page.setViewportSize({ width: 860, height: 250 }); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(details).toHaveAttribute('tabindex', '0');
    await expect(details).toHaveAttribute('role', 'region'); await expect(details).toHaveAttribute('aria-label', 'Dictation details');
    await page.setViewportSize({ width: 860, height: 940 }); await short();
  });

  test('measured narrow attribute controls the tray without container queries', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 940 }); await open(page, 'delayed'); await start(page);
    const composer = page.locator('#composer'), tray = page.locator('#composer > .composer-tray');
    await expect(composer).not.toHaveAttribute('data-voice-narrow'); await expect(tray).toHaveCSS('visibility', 'hidden');
    await page.setViewportSize({ width: 860, height: 940 }); await expect(composer).toHaveAttribute('data-voice-narrow', '');
    await expect(tray).toHaveCSS('visibility', 'visible');
    const attributeRule = await composer.evaluate(el => {
      const tray = el.querySelector('.composer-tray')!;
      el.removeAttribute('data-voice-narrow'); const hidden = getComputedStyle(tray).visibility;
      el.setAttribute('data-voice-narrow', ''); const visible = getComputedStyle(tray).visibility;
      return [hidden, visible];
    });
    expect(attributeRule).toEqual(['hidden', 'visible']);
    await page.setViewportSize({ width: 1440, height: 940 }); await expect(composer).not.toHaveAttribute('data-voice-narrow');
  });

  for (const palette of ['light', 'dark'] as const) test(`opaque ${palette} recovery remains legible without backdrop blur`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: palette });
    await page.addInitScript(theme => localStorage.setItem('pandacode.theme', theme), palette);
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'delayed');
    await start(page); await page.keyboard.press('Enter'); await prompt(page).fill('changed'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    const alpha = (el: Element) => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    };
    expect(await pill(page).locator('.voice-transcript').evaluate(alpha)).toBe(255);
    const fallback = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      .filter((rule): rule is CSSSupportsRule => rule instanceof CSSSupportsRule && rule.conditionText.startsWith('not') && rule.conditionText.includes('-webkit-backdrop-filter:'))
      .flatMap(rule => [...rule.cssRules].map(child => child.cssText)).join('\n'));
    expect(fallback).toContain('var(--panel)');
    // Apply the unsupported-feature branch explicitly in modern browser engines.
    await page.addStyleTag({ content: `${fallback} .voice-pill { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }` });
    expect(await pill(page).evaluate(alpha)).toBe(255);
    await page.getByRole('log', { name: 'Conversation', exact: true }).evaluate(el => {
      const busy = document.createElement('p'); busy.textContent = 'Busy conversation text behind the review card. '.repeat(300); el.prepend(busy);
    });
    await page.mouse.move(1, 1);
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`${palette}-opaque-recovery.png`) });
    await testInfo.attach('opaque-recovery', { body: screenshot, contentType: 'image/png' });
  });

  test('wide composer retains wallpaper frost during dictation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 940 }); await open(page, 'delayed');
    const before = await page.locator('#composer').evaluate(el => getComputedStyle(el).backdropFilter);
    expect(before).toMatch(/blur/); await start(page);
    await expect(page.locator('#composer')).toHaveCSS('backdrop-filter', before);
  });

  for (const phase of ['starting', 'recording']) test(`redraw keeps ${phase} voice guidance after ordinary composer attributes`, async ({ page }) => {
    await open(page, phase === 'starting' ? 'start-delayed' : 'delayed');
    await page.evaluate(() => { (window as any).__voiceManualLevels = true; });
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', phase);
    await page.evaluate(() => window.dispatchEvent(new Event('pandacode-github-change')));
    await expect(prompt(page)).toHaveAttribute('aria-description', /Escape cancels dictation/);
    await expect(prompt(page)).not.toHaveAttribute('aria-description', /Enter to send/);
  });

  for (const palette of ['light', 'dark'] as const) test(`wide review is outside the frosted composer and uses shared ${palette} glass`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: palette });
    await page.addInitScript(theme => localStorage.setItem('pandacode.theme', theme), palette);
    await open(page, 'delayed'); const before = await page.locator('#composer').evaluate(el => getComputedStyle(el).backdropFilter);
    await start(page); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    // A next draft keeps the speech in review (an empty composer after a settled send would take it directly).
    await page.keyboard.type('send'); await prompt(page).press('Enter'); await expect(prompt(page)).toHaveValue('');
    await prompt(page).fill('Next draft'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(pill(page).locator('.voice-label')).toHaveText('Transcript ready to insert.');
    await expect(page.locator('#composer')).toHaveCSS('backdrop-filter', before);
    const material = await pill(page).evaluate(el => {
      const reference = document.createElement('div'); reference.className = 'dialog-plate'; document.body.append(reference);
      const selector = document.documentElement.dataset.theme === 'dark'
        ? 'html[data-theme="dark"] .dialog-plate' : '.dialog-plate';
      const rule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
        .find(rule => rule instanceof CSSStyleRule && rule.selectorText === selector && rule.style.backdropFilter.includes('54px')) as CSSStyleRule;
      reference.style.backdropFilter = rule.style.backdropFilter; reference.style.background = 'var(--glass-warm)';
      const expected = getComputedStyle(reference).backdropFilter, expectedFill = getComputedStyle(reference).backgroundColor; reference.remove();
      return { outside: !el.closest('#composer'), actual: getComputedStyle(el).backdropFilter, expected,
        fill: getComputedStyle(el).backgroundColor, expectedFill };
    });
    expect(material.outside).toBe(true); expect(material.actual).toBe(material.expected);
    expect(material.fill).toBe(material.expectedFill);
  });

  test('baseline shares the left-edge fade and resize observations do not loop', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await open(page, 'delayed'); await page.evaluate(() => { (window as any).__voiceManualLevels = true; }); await start(page);
    await expect(page.locator('.voice-wave-canvas')).toHaveCSS('opacity', '1');
    const alpha = await page.locator('.voice-wave-canvas').evaluate(el => {
      const canvas = el as HTMLCanvasElement, ctx = canvas.getContext('2d')!, style = getComputedStyle(document.querySelector('#prompt')!);
      const left = parseFloat(style.paddingLeft), y = (el.clientHeight + parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / 2;
      const sample = (x: number) => ctx.getImageData(Math.floor(x * devicePixelRatio), Math.floor(y * devicePixelRatio), 1, 1).data[3];
      return { edge: sample(left + 2), solid: sample(left + 30) };
    });
    expect(alpha.edge).toBeGreaterThan(0); expect(alpha.edge).toBeLessThan(alpha.solid / 2);
    for (const width of [860, 1024, 1440, 860]) { await page.setViewportSize({ width, height: 940 }); await page.waitForTimeout(100); }
    expect(errors.filter(text => /ResizeObserver/.test(text))).toEqual([]);
  });

  // Sample composited PNG pixels as well as the canvas backing store.
  for (const palette of ['light', 'dark', 'forced'] as const) for (const width of [860, 1024, 1440])
    test(`actual PNG canvas waveform contrast in ${palette} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 940 });
      await page.emulateMedia(palette === 'forced' ? { forcedColors: 'active', colorScheme: 'light' } : { colorScheme: palette });
      await page.addInitScript(theme => localStorage.setItem('pandacode.theme', theme), palette === 'forced' ? 'light' : palette);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await open(page, 'delayed');
      if (width === 1024 && !await page.locator('.inspector').isVisible()) await page.getByRole('button', { name: 'Toggle inspector', exact: true }).click();
      await start(page);
      const canvas = page.locator('.voice-wave-canvas');
      await expect(canvas).toHaveCSS('opacity', '1');
      await expect(prompt(page)).toHaveCSS('opacity', '0');
      await page.mouse.move(2, 2);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await canvas.evaluate(el => {
        const r = el.getBoundingClientRect(), p = document.querySelector('#prompt')!.getBoundingClientRect();
        const padding = getComputedStyle(document.querySelector('#prompt')!);
        const centerY = r.y + (r.height + parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom)) / 2;
        return { centerY, x: r.x, y: r.y, width: r.width, height: r.height, promptWidth: p.width, promptHeight: p.height,
          backingWidth: (el as HTMLCanvasElement).width, ratio: devicePixelRatio,
          overflow: document.documentElement.scrollWidth - innerWidth };
      });
      expect(geometry.width).toBe(geometry.promptWidth); expect(geometry.height).toBe(geometry.promptHeight);
      expect(geometry.backingWidth).toBe(Math.ceil(geometry.width * geometry.ratio)); expect(geometry.overflow).toBeLessThanOrEqual(1);
      const pixelPath = testInfo.outputPath(`${palette}-recording-${width}.png`);
      const image = await page.screenshot({ path: pixelPath });
      const x = Math.floor(geometry.x + geometry.width / 2), y = Math.floor(geometry.centerY);
      const pixels = await page.evaluate(async ({ png, x, y }) => {
        const bytes = Uint8Array.from(atob(png), byte => byte.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const decoded = document.createElement('canvas');
        decoded.width = bitmap.width; decoded.height = bitmap.height;
        const context = decoded.getContext('2d')!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        // Map CSS sample points to screenshot pixels, including the display's pixel density.
        const scaleX = decoded.width / innerWidth, scaleY = decoded.height / innerHeight;
        const sample = (cssY: number) => [...context.getImageData(
          Math.floor(x * scaleX), Math.floor(cssY * scaleY), 1, 1,
        ).data].slice(0, 3);
        return { bar: sample(y), surface: sample(y + 16) };
      }, { png: image.toString('base64'), x, y });
      const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((a, c, i) => a + c * [.2126, .7152, .0722][i], 0);
      const a = luminance(pixels.bar), b = luminance(pixels.surface), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      expect(contrast, `${palette} rendered pixels must meet 3:1`).toBeGreaterThanOrEqual(3);
      await testInfo.attach('canvas-recording', { body: image, contentType: 'image/png' });
      await testInfo.attach('pixel-contrast', { body: Buffer.from(JSON.stringify({ palette, width, geometry, pixels, contrast })), contentType: 'application/json' });
      await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
      await expect(prompt(page)).toHaveCSS('opacity', '1'); await expect(canvas).toHaveCSS('opacity', '0');
      expect(errors).toEqual([]);
      await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await release(page);
    });

  for (const width of [860, 1024, 1440]) test(`quiet guidance preserves captured source and oversized source is readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page, 'disclosure-profile');
    await page.evaluate(() => { (window as any).__voiceManualLevels = true; (window as any).__voiceHold = true; (window as any).__voiceRecordedMs = 6500; });
    await start(page);
    const context = pill(page).locator('.voice-context');
    const source = await context.textContent();
    expect(source!.length).toBeGreaterThan(760);
    await page.evaluate(() => {
      const w = window as any, active = w.__voiceState().active[0];
      for (const elapsedMs of [1000, 4500]) w.__previewEmit('voice-event', { ...active, phase: 'recording', level: 0, elapsedMs });
    });
    await expect(pill(page).locator('.voice-label')).toContainText(/No input.*Check microphone/);
    await expect(context).toHaveText(source!);
    await expect(context).toHaveAttribute('title', source!);
    await expect(context).toHaveJSProperty('tabIndex', -1);
    expect(await pill(page).getAttribute('aria-description')).toContain(source!);
    const disclosure = await context.evaluate(el => {
      const details = el.closest<HTMLElement>('.voice-details')!;
      const viewport = details.scrollHeight > details.clientHeight + 1 ? details : el;
      const r = viewport.getBoundingClientRect(), css = getComputedStyle(viewport);
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom,
        horizontal: viewport.scrollWidth - viewport.clientWidth,
        vertical: viewport.scrollHeight - viewport.clientHeight, overflowY: css.overflowY, overflowX: css.overflowX,
        pageOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(disclosure.x).toBeGreaterThanOrEqual(0); expect(disclosure.right).toBeLessThanOrEqual(width + 1);
    expect(disclosure.y).toBeGreaterThanOrEqual(0); expect(disclosure.bottom).toBeLessThanOrEqual(941);
    expect(disclosure.pageOverflow).toBeLessThanOrEqual(1);
    if (disclosure.horizontal > 1) expect(disclosure.overflowX).toBe('hidden');
    if (disclosure.vertical > 1) expect(['auto', 'scroll']).toContain(disclosure.overflowY);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(context).toHaveText(source!);
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await release(page);
  });

  for (const mode of ['normal', 'reduced', 'forced'] as const) test(`measured waveform and continuous phase surface at 860px in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 940 });
    if (mode === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
    await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceManualLevels = true; });
    const composerBefore = await page.locator('#composer').boundingBox();
    await start(page);
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    const levels = [0, 0.04, 0.25, 1, 0.09];
    const samples = await page.evaluate(levels => {
      const w = window as any, active = w.__voiceState().active[0];
      return levels.map((level, index) => {
        w.__previewEmit('voice-event', { ...active, phase: 'recording', elapsedMs: (index + 1) * 1100, level });
        return document.querySelector<HTMLMeterElement>('.voice-pill meter')!.value;
      });
    }, levels);
    expect(samples).toEqual(levels);
    await expect(page.locator('.voice-wave-canvas')).toHaveCSS('opacity', '1');
    await expect(prompt(page)).toHaveCSS('opacity', '0');
    const geometry = await pill(page).evaluate(el => {
      const r = el.getBoundingClientRect(), c = document.querySelector('#composer')!.getBoundingClientRect();
      return { x: r.x, right: r.right, composerWidth: c.width, composerHeight: c.height,
        clipped: [...el.querySelectorAll<HTMLElement>('.voice-label,.voice-context')].some(n => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1),
        controls: [...el.querySelectorAll('button')].map(n => { const b = n.getBoundingClientRect(); return { x: b.x, right: b.right, bottom: b.bottom }; }) };
    });
    expect(geometry.composerWidth).toBeLessThanOrEqual(860);
    expect(geometry.composerHeight).toBeCloseTo(composerBefore!.height, 0);
    expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(861);
    expect(geometry.clipped).toBe(false);
    await expect(page.locator('#model-picker-trigger')).toBeVisible();
    await expect(page.locator('#model-picker-trigger')).toBeEnabled();
    for (const b of geometry.controls) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.right).toBeLessThanOrEqual(861); expect(b.bottom).toBeLessThanOrEqual(940); }
    const frames = await pill(page).evaluate(async el => {
      const before = el.getBoundingClientRect();
      const samples: any[] = [];
      (el.querySelector('[data-voice="stop"]') as HTMLButtonElement).click();
      const started = performance.now();
      do {
        await new Promise(requestAnimationFrame);
        const r = el.getBoundingClientRect();
        samples.push({ opacity: Number(getComputedStyle(el).opacity), phase: (el as HTMLElement).dataset.phase,
          x: r.x, y: r.y, width: r.width, height: r.height, same: el === document.querySelector('.voice-pill') });
      } while (performance.now() - started < 350 || samples.length < 4);
      return { before: { x: before.x, y: before.y, width: before.width, height: before.height }, samples };
    });
    expect(frames.samples.length).toBeGreaterThan(3);
    for (const frame of frames.samples) {
      expect(frame.same).toBe(true); expect(frame.opacity).toBe(1); expect(frame.phase).toBe('transcribing');
      // Text and actions can change, but this is the same settled status surface.
      expect(frame.width).toBeCloseTo(frames.before.width, 0);
      expect(frame.height).toBeCloseTo(frames.before.height, 0);
      expect(frame.x).toBeCloseTo(frames.before.x, 0);
      expect(frame.y).toBeCloseTo(frames.before.y, 0);
    }
    await expect(page.locator('.voice-wave-canvas')).toHaveCSS('opacity', '0');
    await expect(prompt(page)).toHaveCSS('opacity', '1');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await release(page);
  });

  test('forced colors render primary action glyphs at rest and on hover', async ({ page, browserName }, testInfo) => {
    const evidence: unknown[] = [];
    await page.emulateMedia({ forcedColors: 'active' });
    const forcedColors = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
    expect(forcedColors).toBe(true);
    await page.setViewportSize({ width: 860, height: 940 });
    const readable = async (name: string) => {
      const button = pill(page).getByRole('button', { name, exact: true });
      for (const state of ['rest', 'hover', 'focus']) {
        const hovered = state === 'hover';
        await button.evaluate(el => (el as HTMLElement).blur());
        if (hovered) await button.hover(); else await page.mouse.move(2, 2);
        if (state === 'focus') await button.focus();
        const roi = await button.evaluate(el => {
          const text = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!;
          const range = document.createRange(); range.selectNodeContents(text);
          const r = range.getBoundingClientRect(), b = el.getBoundingClientRect();
          return { x: Math.ceil(r.x - b.x) + 1, y: Math.ceil(r.y - b.y) + 1, width: Math.max(1, Math.floor(r.width) - 2), height: Math.max(1, Math.floor(r.height) - 2), color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, forcedColorAdjust: getComputedStyle(el).forcedColorAdjust };
        });
        const bytes = [...await button.screenshot({ animations: 'disabled' })];
        const variation = await page.evaluate(async ({ bytes, roi }) => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
          const data = context.getImageData(roi.x, roi.y, roi.width, roi.height).data;
          let min = 255, max = 0;
          for (let i = 0; i < data.length; i += 4) { const luminance = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]; min = Math.min(min, luminance); max = Math.max(max, luminance); }
          return max - min;
        }, { bytes, roi });
        evidence.push({ name, state, hovered, roi, variation });
        expect(variation, `${name} ${hovered ? 'hover' : 'rest'} must paint visible glyphs, not a solid forced-color backplate`).toBeGreaterThan(64);
      }
    };
    await open(page, 'failure'); await start(page);
    await readable('Stop and transcribe'); await readable('Cancel dictation');
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await readable('Retry original recording'); await readable('Discard and record again'); await readable('Discard dictation');
    await open(page, 'no-audio'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    await readable('Discard and record again');
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await prompt(page).pressSequentially('Edited'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await readable('Insert transcript at cursor'); await readable('Discard dictation');
    await testInfo.attach('forced-primary-glyphs', { body: Buffer.from(JSON.stringify({ browserName, forcedColors, samples: evidence }, null, 2)), contentType: 'application/json' });
  });

  test('voice entry motion is brief, changes opacity and position only, and settles', async ({ page }) => {
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(keyframes, options) {
        if (this.classList.contains('voice-pill')) {
          ((window as any).__voiceMotion ??= []).push({ keyframes, duration: typeof options === 'number' ? options : options?.duration });
        }
        return animate.call(this, keyframes, options);
      };
    });
    await open(page);
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-ready'));
    await start(page);
    const motion = await page.evaluate(() => (window as any).__voiceMotion);
    expect(motion.length).toBeGreaterThan(0);
    for (const animation of motion) {
      expect(Number(animation.duration)).toBeGreaterThan(0);
      expect(Number(animation.duration)).toBeLessThanOrEqual(500);
      for (const frame of animation.keyframes) {
        expect(Object.keys(frame).every(key => ['opacity', 'transform', 'translate', 'offset', 'easing', 'composite'].includes(key))).toBe(true);
      }
    }
    await expect.poll(() => pill(page).evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    await expect(pill(page)).toHaveCSS('opacity', '1');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
  });

  for (const height of [940, 390, 280]) test(`sending while transcribing into review causes no ResizeObserver loop at 860x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 860, height });
    await page.addInitScript(() => {
      window.addEventListener('error', event => { ((window as any).__r13Errors ??= []).push(String(event.message)); });
    });
    const logged: string[] = []; page.on('console', message => logged.push(message.text())); page.on('pageerror', error => logged.push(error.message));
    await mockVoiceSend(page, 'hold'); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'Long review. '.repeat(200); });
    await start(page); await page.keyboard.press('Enter');
    await prompt(page).fill('Send while transcribing.'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue(''); await prompt(page).fill('Expanded draft.\n'.repeat(14)); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(250);
    const errors = [...logged, ...await page.evaluate(() => (window as any).__r13Errors ?? [])];
    expect(errors.filter(text => /ResizeObserver/.test(text))).toEqual([]);
  });

  test('the prompt keeps design-system transitions until dictation is used, then fades both ways', async ({ page }) => {
    await open(page, 'delayed');
    const properties = () => prompt(page).evaluate(el => getComputedStyle(el).transitionProperty.split(',').map(p => p.trim()));
    expect(await properties()).not.toContain('opacity');
    await start(page); expect(await properties()).toContain('opacity');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await expect(pill(page)).toBeHidden();
    expect(await properties()).toContain('opacity');
  });
  const DOT_ACCENTS = [{ mode: 'wallpaper' }, { mode: 'classic' }, { mode: 'custom', color: '#2fb8c4' }] as const;
  for (const palette of ['light', 'dark'] as const) for (const accent of DOT_ACCENTS) test(`Listening dot keeps 3:1 against the pill in ${palette} with a ${'color' in accent ? accent.color : accent.mode} accent`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: palette });
    await page.addInitScript(({ theme, accent }) => { localStorage.setItem('pandacode.theme', theme); localStorage.setItem('pandacode.palette', JSON.stringify({ accent, vsix: null, cache: null })); }, { theme: palette, accent });
    await open(page, 'delayed'); await start(page);
    await expect(pill(page).locator('.voice-label')).toHaveText(/Listening/, { timeout: 5000 });
    const dot = pill(page).locator('.voice-dot');
    await page.mouse.move(2, 2);
    const box = (await dot.boundingBox())!;
    const image = await page.screenshot({ animations: 'disabled' });
    const pixels = await page.evaluate(async ({ png, box }) => {
      const bytes = Uint8Array.from(atob(png), byte => byte.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const decoded = document.createElement('canvas');
      decoded.width = bitmap.width; decoded.height = bitmap.height;
      const context = decoded.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      const scale = decoded.width / innerWidth;
      const sample = (x: number, y: number) => [...context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data].slice(0, 3);
      const cy = box.y + box.height / 2;
      return { dot: sample(box.x + box.width / 2, cy), surface: sample(box.x - 4, cy) };
    }, { png: image.toString('base64'), box });
    const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((a, c, i) => a + c * [.2126, .7152, .0722][i], 0);
    const a = luminance(pixels.dot), b = luminance(pixels.surface), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    expect(contrast, `${palette} Listening dot ${JSON.stringify(pixels)}`).toBeGreaterThanOrEqual(3);
  });
});
