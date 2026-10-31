import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

// The preview's pretend simulator draws a home screen at 402×874 points; nothing here
// touches Xcode. Calls are recorded so gestures can be checked in points.
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__simCalls ?? []).filter((entry: any) => entry.command === command), command);
const inputs = async (page: Page) => (await calls(page, 'simulator_input')).map(entry => entry.args.input);

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__simEmit ??= (name, event) => emit(name, event);
      if (command.startsWith('simulator_') && command !== 'simulator_frame') (window.__simCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'simulator_frame') (window.__simFrames = (window.__simFrames ?? 0) + 1);
      if (command === 'simulator_pose' && window.__simPoseHold) await window.__simPoseHold;
      if (command === 'simulator_pose' && window.__simPoseFail) throw new Error(window.__simPoseFail);
      if (command === 'simulator_frame' && window.__simFrameHold) await window.__simFrameHold;
      switch (command) {
    `) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
}
/** The phone tab in the right sidebar opens the simulator. */
async function showSimulator(page: Page): Promise<void> {
  await expect(page.locator('.task-item.selected')).toBeVisible(); // the panel opens once the task loads
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-simulator');
  await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
}
/** The display after facing forward: the screen is centered in the stage. */
async function stage(page: Page) {
  const box = (await page.locator('.sim-stage').boundingBox())!;
  return { box, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
}
async function faceForward(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Face forward' }).click();
  await page.waitForTimeout(700);
}

test('the simulator opens in the inspector with a live 3D device', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.inspector-tabs [data-action="tab-simulator"]')).toHaveClass(/selected/);
  await expect(page.locator('#inspector-content')).toBeHidden();
  await expect(panel.locator('.sim-device-name')).toHaveText('iPhone 17 Pro');
  await expect(panel.locator('.sim-device-runtime')).toHaveText('iOS 26.2 · Running');
  await expect(panel.locator('canvas.sim-canvas')).toBeVisible();
  // The booted device was chosen for agents too, and frames flow.
  expect((await calls(page, 'simulator_select'))[0].args).toEqual({ udid: '3720D4A0-B8C5-4DAC-9425-6A4685BC533E' });
  await expect.poll(() => page.evaluate(() => (window as any).__simFrames ?? 0)).toBeGreaterThan(0);
  await expect(panel.locator('.sim-axe')).toBeHidden();
  // Leaving the tab stops asking for frames.
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#inspector-content')).toBeVisible();
  const before = await page.evaluate(() => (window as any).__simFrames);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).__simFrames)).toBeLessThanOrEqual(before + 1);
});

test('clicks and drags on the display become taps and swipes in points; elsewhere they turn the device', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  await faceForward(page);
  const { box, center } = await stage(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(1);
  const tap = (await inputs(page))[0];
  expect(tap.kind).toBe('tap');
  expect(Math.abs(tap.x - 201)).toBeLessThan(12);
  expect(Math.abs(tap.y - 437)).toBeLessThan(20);
  // A drag up the display is a swipe up.
  await page.mouse.move(center.x, center.y + 120); await page.mouse.down();
  await page.mouse.move(center.x, center.y - 80, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await inputs(page)).length).toBe(2);
  const swipe = (await inputs(page))[1];
  expect(swipe.kind).toBe('swipe');
  expect(swipe.endY).toBeLessThan(swipe.y - 100);
  // Dragging the empty stage orbits the model and sends nothing.
  await page.mouse.move(box.x + 12, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 60, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await inputs(page)).toHaveLength(2);
  // Turned away, the same point no longer lands where it did; facing forward restores it.
  await faceForward(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(3);
  expect(Math.abs((await inputs(page))[2].x - 201)).toBeLessThan(12);
});

test('typing, keys and hardware buttons reach the device', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  await faceForward(page);
  const { center } = await stage(page);
  await page.mouse.click(center.x, center.y);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await inputs(page)).slice(1)).toEqual([{ kind: 'type', text: 'hello' }, { kind: 'key', key: 'return' }]);
  await page.locator('#simulator-panel').getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('#simulator-panel').getByRole('button', { name: 'Lock', exact: true }).click();
  await expect.poll(async () => (await inputs(page)).slice(3)).toEqual([{ kind: 'button', button: 'home' }, { kind: 'button', button: 'lock' }]);
  await page.locator('#simulator-panel').getByRole('button', { name: 'Toggle dark appearance' }).click();
  await expect.poll(async () => (await calls(page, 'simulator_appearance')).at(-1)?.args.mode).toBe('dark');
});

test('power, device choice and agent requests to show the simulator', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  await panel.getByRole('button', { name: 'Shut down simulator' }).click();
  await expect(panel.locator('.sim-device-runtime')).toHaveText('iOS 26.2 · Shutdown');
  await expect(panel.getByRole('button', { name: 'Home', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(panel.locator('.sim-device-runtime')).toHaveText('iOS 26.2 · Running');
  expect((await calls(page, 'simulator_power')).map(entry => entry.args.on)).toEqual([false, true]);
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /iPad Air/ }).click();
  await expect(panel.locator('.sim-device-name')).toHaveText('iPad Air 11-inch (M3)');
  expect((await calls(page, 'simulator_select')).at(-1).args).toEqual({ udid: '5B7E2C1A-0D3F-4E8B-9A61-2F4C8D7E9B10' });
  // An agent booting a device brings the panel back.
  await openInspectorTab(page, 'tab-files');
  await page.locator('.inspector-tabs [data-action="tab-files"]').click();
  await expect(panel).toBeHidden();
  await page.evaluate(() => (window as any).__simEmit('simulator-changed', { udid: '5B7E2C1A-0D3F-4E8B-9A61-2F4C8D7E9B10', show: true }));
  await expect(panel).toBeVisible();
});

test('the device wears its launch finish and remembers another', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const finish = page.getByRole('button', { name: /Device finish/ });
  await expect(finish).toHaveAccessibleName('Device finish: Cosmic Orange');
  await finish.click();
  await page.getByRole('menuitemradio', { name: 'Silver' }).click();
  await expect(finish).toHaveAccessibleName('Device finish: Silver');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.simulatorFinish') ?? '{}'))).toEqual({ 'iPhone-17-Pro': 'silver' });
  await page.reload();
  await showSimulator(page);
  await expect(page.getByRole('button', { name: /Device finish/ })).toHaveAccessibleName('Device finish: Silver');
});

test('Android emulators sit beside iOS simulators with Back and Recents', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /Pixel 9/ }).click();
  await expect(panel.locator('.sim-device-runtime')).toHaveText('Android 15 · Shutdown');
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(panel.locator('.sim-device-runtime')).toHaveText('Android 15 · Running');
  expect((await calls(page, 'simulator_power')).at(-1).args).toEqual({ udid: 'android:Pixel_9_API_35', on: true });
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await panel.getByRole('button', { name: 'Recent apps' }).click();
  await panel.getByRole('button', { name: 'Home', exact: true }).click();
  await expect.poll(async () => (await inputs(page)).map(input => input.button)).toEqual(['back', 'recents', 'home']);
  await expect(page.getByRole('button', { name: /Device finish/ })).toHaveAccessibleName('Device finish: Obsidian');
  // Touch maps to dp like iOS points.
  await faceForward(page);
  const { center } = await stage(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(4);
  const tap = (await inputs(page))[3];
  expect(Math.abs(tap.x - 206)).toBeLessThan(14);
  expect(Math.abs(tap.y - 457)).toBeLessThan(22);
});

test('Android can be set up in one click when the SDK is missing', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__simEmit ??= (name, event) => emit(name, event);
      if (command.startsWith('simulator_') && command !== 'simulator_frame') (window.__simCalls ??= []).push({ command, args: structuredClone(args) });
      const noAndroid = value => ({ ...value, android: false, devices: value.devices.filter(d => d.platform !== 'android') });
      if (command === 'simulator_status' && !window.__androidReady) return noAndroid(previewSimulator.status());
      if (command === 'simulator_select' && !window.__androidReady) return noAndroid(previewSimulator.select(args.udid));
      if (command === 'android_setup') window.__androidReady = true;
      switch (command) {
    `) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await expect(page.getByRole('menuitemradio', { name: /Pixel 9/ })).toHaveCount(0);
  await page.getByRole('menuitemradio', { name: /Set up Android emulator/ }).click();
  await expect(panel.locator('.sim-status')).toContainText(/Android setup \d\/5/);
  await expect(page.locator('#toast')).toContainText('Android emulator ready');
  await expect(panel.locator('.sim-device-name')).toHaveText('Pixel 9 API 35');
});

test('iPhone Duo is added from the device menu and takes three poses', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  const pose = panel.locator('[data-sim="pose"]');
  await expect(pose).toBeHidden();
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /Add iPhone Duo/ }).click();
  await expect(panel.locator('.sim-device-name')).toHaveText('iPhone Duo');
  expect((await calls(page, 'simulator_create_duo')).length).toBe(1);
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(panel.locator('.sim-device-runtime')).toHaveText('iOS 27.1 · Running');
  await expect(pose).toBeVisible();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed');
  await pose.click();
  await page.getByRole('menuitemradio', { name: /Open/ }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Open');
  await expect.poll(async () => (await calls(page, 'simulator_pose')).at(-1)?.args).toEqual({ udid: 'A1B2C3D4-0000-4000-8000-00000000D0D0', pose: 'open' });
  await page.getByRole('button', { name: /Device finish/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Night Sky' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Star White' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await faceForward(page);
  const { center } = await stage(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(1);
  const inner = (await inputs(page))[0];
  expect(inner.x).toBeGreaterThan(0); expect(inner.x).toBeLessThan(951);
  expect(inner.y).toBeGreaterThan(0); expect(inner.y).toBeLessThan(669);
  await pose.click();
  await page.getByRole('menuitemradio', { name: /Closed/ }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed');
  await page.waitForTimeout(1200);
  await faceForward(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(2);
  const cover = (await inputs(page))[1];
  expect(cover.x).toBeGreaterThan(0); expect(cover.x).toBeLessThan(466);
  expect(cover.y).toBeGreaterThan(0); expect(cover.y).toBeLessThan(678);
});

test('iPhone Duo folds on click and shows a spinner until the new display answers', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel'), screen = panel.locator('.sim-stage');
  const pose = panel.locator('[data-sim="pose"]');
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /Add iPhone Duo/ }).click();
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed');
  await expect.poll(() => page.evaluate(() => (window as any).__simFrames ?? 0)).toBeGreaterThan(0);
  // Hold the native fold and the frames: the hinge must still move at once.
  await page.evaluate(() => {
    const w = window as any;
    w.__simPoseHold = new Promise(resolve => { w.__simPoseRelease = resolve; });
    w.__simFrameHold = new Promise(resolve => { w.__simFrameRelease = resolve; });
  });
  await pose.click();
  await page.getByRole('menuitemradio', { name: /Open/ }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Open', { timeout: 200 });
  await expect(screen).toHaveAttribute('aria-busy', 'true');
  await expect(pose).toBeEnabled();
  await page.evaluate(() => { const w = window as any; w.__simPoseHold = null; w.__simPoseRelease(); });
  await page.waitForTimeout(300);
  await expect(screen).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => { const w = window as any; w.__simFrameHold = null; w.__simFrameRelease(); });
  await expect(screen).not.toHaveAttribute('aria-busy');
  expect((await calls(page, 'simulator_pose')).at(-1).args.pose).toBe('open');

  // A fold that fails moves back and says why.
  // Held, so the hinge is seen moving before the failure comes back.
  await page.evaluate(() => { const w = window as any; w.__simPoseFail = 'The hinge is stuck.'; w.__simPoseHold = new Promise(resolve => { w.__simPoseRelease = resolve; }); });
  await pose.click();
  await page.getByRole('menuitemradio', { name: /Closed/ }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed', { timeout: 200 });
  await page.evaluate(() => { const w = window as any; w.__simPoseHold = null; w.__simPoseRelease(); });
  await expect(page.locator('#toast')).toContainText('The hinge is stuck.');
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Open');
  await expect(screen).not.toHaveAttribute('aria-busy');
});

test('rapid pose changes keep the window responsive and end in the last pose', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  const pose = panel.locator('[data-sim="pose"]');
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /Add iPhone Duo/ }).click();
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed');
  // The first fold hangs natively while four more clicks arrive.
  await page.evaluate(() => { const w = window as any; w.__simPoseHold = new Promise(resolve => { w.__simPoseRelease = resolve; }); });
  for (const name of ['Open', 'Book', 'Closed', 'Open', 'Book']) {
    await pose.click();
    await page.getByRole('menuitemradio', { name: new RegExp(name) }).click();
    await expect(pose).toHaveAccessibleName(`iPhone Duo pose: ${name}`, { timeout: 200 });
  }
  // The main thread stays free: timers keep their schedule while the folds wait.
  const lag = await page.evaluate(() => new Promise<number>(resolve => {
    let worst = 0, last = performance.now(), ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 20); last = now; if (++ticks === 25) { clearInterval(timer); resolve(worst); } }, 20);
  }));
  expect(lag).toBeLessThan(150);
  await page.evaluate(() => { const w = window as any; w.__simPoseHold = null; w.__simPoseRelease(); });
  // Only the fold in flight and the newest one reach the simulator.
  await expect.poll(async () => (await calls(page, 'simulator_pose')).map(entry => entry.args.pose)).toEqual(['open', 'book']);
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Book');
  await expect(panel.locator('.sim-stage')).not.toHaveAttribute('aria-busy');
});

test('iPhone Duo follows a pose changed outside PandaCode', async ({ page }) => {
  await open(page);
  await showSimulator(page);
  const panel = page.locator('#simulator-panel');
  const pose = panel.locator('[data-sim="pose"]');
  await panel.getByRole('button', { name: 'Choose simulator' }).click();
  await page.getByRole('menuitemradio', { name: /Add iPhone Duo/ }).click();
  await panel.getByRole('button', { name: 'Boot simulator' }).click();
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Closed');
  await page.evaluate(() => (window as any).__simSetPose('A1B2C3D4-0000-4000-8000-00000000D0D0', 'open'));
  await expect(pose).toHaveAccessibleName('iPhone Duo pose: Open', { timeout: 5000 });
  expect((await calls(page, 'simulator_pose')).length).toBe(0);
  await page.waitForTimeout(1200);
  await faceForward(page);
  const { center } = await stage(page);
  await page.mouse.click(center.x, center.y);
  await expect.poll(async () => (await inputs(page)).length).toBe(1);
  const inner = (await inputs(page))[0];
  expect(inner.x).toBeGreaterThan(0); expect(inner.x).toBeLessThan(951);
  expect(inner.y).toBeGreaterThan(0); expect(inner.y).toBeLessThan(669);
});

test('Add iPhone Duo is disabled without Xcode 27.1', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      if (command === 'simulator_status') return { ...previewSimulator.status(), duoAvailable: false };
      if (command === 'simulator_select') return { ...previewSimulator.select(args.udid), duoAvailable: false };
      switch (command) {
    `) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // Startup restores the inspector; toggling it before then would close it again.
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await showSimulator(page);
  await page.locator('#simulator-panel').getByRole('button', { name: 'Choose simulator' }).click();
  const add = page.getByRole('menuitemradio', { name: /Add iPhone Duo/ });
  await expect(add).toBeDisabled();
  await expect(page.locator('.floating-menu')).toContainText('Needs Xcode 27.1 or later');
});

test.describe('on Windows', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
  });

  test('the Simulators tab lists Android emulators only, with no Xcode or AXe notes', async ({ page }) => {
    await open(page);
    await showSimulator(page);
    const panel = page.locator('#simulator-panel');
    await expect(panel.locator('.sim-device-name')).toHaveText('Pixel 9 API 35');
    await expect(panel.locator('.sim-axe')).toBeHidden();
    await panel.getByRole('button', { name: 'Choose simulator' }).click();
    await expect(page.getByRole('menuitemradio')).toHaveText([/Pixel 9/]);
    await expect(page.getByRole('menuitemradio', { name: /iPhone Duo|Set up Android/ })).toHaveCount(0);
  });

  test('without the Android SDK the panel says to install it', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'simulator_status') return { available: false, axe: false, axeInstall: 'brew install cameroncooke/axe/axe', android: false, devices: [], selected: null, screen: null, error: 'xcrun was not found.' };
        switch (command) {
      `) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await showSimulator(page);
    const panel = page.locator('#simulator-panel');
    await expect(panel.locator('.sim-status')).toHaveText('Install Android Studio (or the Android command-line tools) into %LOCALAPPDATA%\\Android\\Sdk, create an emulator in Device Manager, then reopen this tab.');
    await expect(panel.locator('.sim-axe')).toBeHidden();
  });
});
