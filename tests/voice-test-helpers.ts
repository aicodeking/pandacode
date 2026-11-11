// Shared helpers for the voice-input-*.spec.ts browser suites.
import { expect, type Page } from '@playwright/test';

export const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
export const pill = (page: Page) => page.getByRole('group', { name: 'Voice dictation', exact: true });
export const calls = (page: Page) => page.evaluate(() => (window as any).__voiceCalls ?? []);
export async function open(page: Page, scenario = 'ready') {
  await page.goto(`/?voice=${scenario}`);
  await expect(prompt(page)).toBeEnabled();
}
export async function start(page: Page) {
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
}
export async function release(page: Page) {
  await page.waitForFunction(() => typeof (window as any).__voiceRelease === 'function');
  await page.evaluate(() => (window as any).__voiceRelease());
}

export async function watchWaveFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set<number>();
    w.__waveFrames = { pending, count: 0, draws: [] as number[] };
    window.requestAnimationFrame = callback => {
      if (callback.name !== 'waveTick') return request(callback);
      const id = request(now => { pending.delete(id); w.__waveFrames.count++; callback(now); });
      pending.add(id); return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.classList.contains('voice-wave-canvas')) w.__waveFrames.draws.push(performance.now());
      return clear.apply(this, args);
    };
  });
}
export const waveFrameState = (page: Page) => page.evaluate(() => {
  const state = (window as any).__waveFrames;
  return { count: state.count, pending: state.pending.size, draws: state.draws };
});


export function canvasPixels(node: Element) {
  const el = node as HTMLCanvasElement, ctx = el.getContext('2d')!;
  const data = ctx.getImageData(0, 0, el.width, el.height).data;
  const expected = document.createElement('canvas').getContext('2d')!;
  expected.fillStyle = getComputedStyle(el).color; expected.fillRect(0, 0, 1, 1);
  const style = getComputedStyle(document.querySelector('#prompt')!);
  const center = Math.floor((el.height + (parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) * devicePixelRatio) / 2);
  const ink = ctx.getImageData(Math.floor(el.width / 2), center, 1, 1).data;
  return { image: el.toDataURL(), colored: [...data].filter((_, i) => i % 4 === 3 && data[i] > 0).length,
    ink: [...ink].join(','), expected: [...expected.getImageData(0, 0, 1, 1).data].join(',') };
}

export function matchesCanvasColor(pixels: { ink: string; expected: string }) {
  const actual = pixels.ink.split(',').map(Number), expected = pixels.expected.split(',').map(Number);
  // WebKit gradient interpolation can round an eight-bit color channel by one.
  return actual[3] === expected[3] && actual.slice(0, 3).every((value, index) => Math.abs(value - expected[index]) <= 1);
}

export async function mockVoiceSend(page: Page, mode: 'hold' | 'fail') {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    const code = mode === 'fail'
      ? "if (command === 'send_message') throw new Error('Voice regression send failed.');"
      : "if (command === 'send_message') { session(args.sessionId).status = 'running'; window.__voiceFinishRun = () => { session(args.sessionId).status = 'idle'; emit('agent-event', { sessionId: args.sessionId, kind: 'done', text: '' }); }; return; }";
    await route.fulfill({ response, body: source.replace(marker, `${code} switch (command) {`) });
  });
}

export async function chooseSendTarget(page: Page, target: string) {
  if (target === 'normal') return;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Connections', exact: true }).click();
  if (target === 'cloud') {
    await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
    const fold = settings.locator('details.cloud-more');
    if (!await fold.evaluate(el => (el as HTMLDetailsElement).open)) await fold.locator('summary').click();
    await settings.getByRole('button', { name: 'Connect E2B', exact: true }).click();
    await settings.getByLabel('E2B API key').fill('preview');
    await settings.getByRole('form', { name: 'Connect E2B' }).locator('[type="submit"]').click();
  } else {
    await settings.getByRole('tab', { name: 'Remote access', exact: true }).click();
    const remote = settings.getByRole('tabpanel', { name: 'Remote access', exact: true });
    await remote.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await expect(remote.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  }
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.locator('.new-task-button').click(); await page.locator('#composer-computer').click();
  await page.getByRole('menuitemradio', { name: target === 'cloud' ? 'Cloud · E2B' : 'Studio iMac', exact: true }).click();
}
