import { test, expect } from '@playwright/test';

async function offlinePairing(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/pandacode/preferences', route => route.fulfill({ status: 503, body: 'offline' }));
  await page.route('**/api/pandacode/session', route => route.fulfill({ status: 401, body: 'invalid' }));
  await page.goto('/?web');
}

test('host accent prepaints and refreshes the actual palette without accepting stale CSS caches', async ({ page }) => {
  await offlinePairing(page);
  const result = await page.evaluate(async () => {
    const { applyWallpaperAccentSeed, storeAppearance } = await import('/src/web-preferences.ts');
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    storeAppearance({ 'pandacode.palette': JSON.stringify({ accent: { mode: 'wallpaper' }, vsix: null }), 'pandacode.wallpapers': 'false' });
    applyWallpaperAccentSeed({ wallpaperAccentSeed: '#aabbcc' });
    const { palette, restorePalette, SKY_SCENE } = await import('/src/palette.ts');
    const { accentTokens, vsixTokens } = await import('/src/palette-core.ts');
    const { parseHex } = await import('/src/color.ts');
    const accent = () => root.style.getPropertyValue('--accent');
    const expected = (hex: string) => accentTokens(parseHex(hex)!.rgb, 'dark')['--accent'];
    const initial = accent() === expected('#aabbcc');
    applyWallpaperAccentSeed({ wallpaperAccentSeed: '#cc3388' }); palette.reload();
    const refreshed = accent() === expected('#cc3388');
    // A browser's former generated cache cannot override the host color.
    localStorage.setItem('pandacode.palette', JSON.stringify({ accent: { mode: 'wallpaper' }, vsix: null, cache: { key: '#112233:dark', tokens: { '--accent': 'red' } } }));
    restorePalette(); const cacheIgnored = accent() === expected('#cc3388');
    storeAppearance({ 'pandacode.palette': JSON.stringify({ accent: { mode: 'custom', color: '#55cc11' }, vsix: null }) }); palette.reload();
    const custom = accent() === expected('#55cc11');
    const theme = { id: 'fixture', name: 'Fixture', extension: 'fixture', kind: 'dark' as const, colors: { 'editor.background': '#112233', 'editor.foreground': '#eeeeee', 'focusBorder': '#cc66dd' } };
    storeAppearance({ 'pandacode.palette': JSON.stringify({ accent: { mode: 'wallpaper' }, vsix: theme }) }); palette.reload();
    const vsix = accent() === vsixTokens(theme).tokens['--accent'] && root.hasAttribute('data-vsix');
    storeAppearance({ 'pandacode.palette': JSON.stringify({ accent: { mode: 'wallpaper' }, vsix: null }) }); palette.reload(); palette.setWallpaper(SKY_SCENE);
    const sky = accent() === expected('#3a80dc');
    applyWallpaperAccentSeed({ wallpaperAccentSeed: '#bad' }); palette.reload();
    const malformedCleared = palette.wallpaperColor === undefined;
    return { initial, refreshed, cacheIgnored, custom, vsix, sky, malformedCleared };
  });
  expect(result).toEqual({ initial: true, refreshed: true, cacheIgnored: true, custom: true, vsix: true, sky: true, malformedCleared: true });
});

test('offline browser mode shows pairing inside the viewport without preview data', async ({ page }) => {
  await offlinePairing(page);
  await expect(page.getByRole('heading', { name: 'PandaCode' })).toBeVisible();
  await expect(page.getByText('Enter the one-time pairing code')).toBeVisible();
  await expect(page.getByText('Browser preview')).toHaveCount(0);
  expect(await page.locator('.web-pairing').boundingBox()).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  const box = await page.locator('.web-pairing').boundingBox(); const viewport = page.viewportSize()!;
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
});

test('pairing dialog remains clickable with the shared dialog styles loaded', async ({ page }) => {
  await page.goto('/?web');
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.className = 'web-pairing dialog-plate';
    dialog.innerHTML = '<form method="dialog"><input aria-label="Pairing code"><button type="submit">Pair</button></form>';
    document.body.append(dialog); dialog.showModal();
  });
  await expect(page.locator('dialog.web-pairing')).toBeVisible();
  expect(await page.locator('dialog.web-pairing').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('auto');
  await page.locator('dialog.web-pairing input').fill('ABC123');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.locator('dialog.web-pairing')).toBeHidden();
});

test('invalid pairing fails clearly, clears the token, and keeps it out of URL/storage', async ({ page }) => {
  await offlinePairing(page);
  const input = page.getByLabel('Pairing code'); await input.fill('secret-test-code'); await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('status')).toContainText('Could not connect');
  await expect(input).toHaveValue('');
  expect(page.url()).not.toContain('secret-test-code');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('secret-test-code');
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/src/preview.ts')))).toBe(false);
});

test('password mode offers reusable sign-in and clears failed credentials', async ({ page }) => {
  await offlinePairing(page);
  await page.route('**/api/pandacode/login-mode', route => route.fulfill({ json: { mode: 'password' } }));
  await page.reload();
  const input = page.getByLabel('Instance password');
  await expect(input).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await input.fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Could not sign in');
  await expect(input).toHaveValue('');
  expect(page.url()).not.toContain('test-password');
});

test('host saves the session policy and revokes only the selected browser', async ({ page }) => {
  await offlinePairing(page);
  await page.evaluate(async () => {
    let sessions = [
      { id: 'first-session', remainingSeconds: null },
      { id: 'second-session', remainingSeconds: 3600 },
    ];
    const calls: unknown[] = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === 'web_gateway_info') return {
          enabled: true, origin: 'https://panda.test', passwordMode: true, sessionLimitSeconds: null,
        };
        if (command === 'web_gateway_sessions') return sessions;
        if (command === 'web_gateway_revoke_session') sessions = sessions.filter(session => session.id !== args.id);
      } },
    });
    Object.assign(window, { sessionManagementCalls: calls });
    const { mountWebGatewaySettings } = await import('/src/web-gateway-settings.ts');
    const host = document.createElement('section');
    document.body.replaceChildren(host);
    mountWebGatewaySettings(host);
  });
  const duration = page.getByLabel('Session duration for new sign-ins');
  await expect(duration).toHaveValue('none');
  await duration.selectOption('2d');
  await expect(page.getByText('Saved for new sign-ins.')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke Session first-se' }).click();
  await expect(page.getByText('Session first-se')).toHaveCount(0);
  await expect(page.getByText('Session second-s')).toBeVisible();
  const calls = await page.evaluate(() => Reflect.get(window, 'sessionManagementCalls'));
  expect(calls).toContainEqual({ command: 'web_gateway_set_session_limit', args: { setting: '2d' } });
  expect(calls).toContainEqual({ command: 'web_gateway_revoke_session', args: { id: 'first-session' } });
});

test('browser sign-out revokes the session before reloading the login screen', async ({ page }) => {
  await offlinePairing(page);
  await page.route('**/api/pandacode/login-mode', route => route.fulfill({ json: { mode: 'password' } }));
  await page.route('**/api/pandacode/session/details', route => route.fulfill({ json: { remainingSeconds: null } }));
  let signedOut = false;
  await page.route('**/api/pandacode/session', route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
    signedOut = true;
    return route.fulfill({ status: 204 });
  });
  await page.evaluate(async () => {
    document.cookie = 'pandacode_csrf=fixture-csrf; Path=/';
    const { mountBrowserWorkspaceSettings } = await import('/src/web-gateway-settings.ts');
    const host = document.createElement('section');
    document.body.prepend(host);
    mountBrowserWorkspaceSettings(host);
  });
  await expect(page.getByText('No server-side expiration.')).toBeVisible();
  await Promise.all([
    page.waitForEvent('framenavigated', frame => frame === page.mainFrame()),
    page.getByRole('button', { name: 'Sign out', exact: true }).click(),
  ]);
  expect(signedOut).toBe(true);
  await expect(page.getByLabel('Instance password')).toBeVisible();
});

for (const viewport of [{ width: 360, height: 640 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`pairing remains visible at viewport ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await offlinePairing(page);
    await expect(page.locator('.web-pairing')).toBeVisible();
    const input = page.getByLabel('Pairing code');
    await input.fill('draft'); await input.press('Space'); await input.press('End'); await input.press('x');
    await expect(input).toHaveValue('draft x');
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect(page.locator('.web-pairing')).toBeVisible();
    await expect(input).toHaveValue('draft x');
    const box = await page.locator('.web-pairing').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.width);
  });
}

test('host folder picker navigates roots, directories, and returns a grant after selection', async ({ page }) => {
  await page.goto('/?web');
  await page.evaluate(() => { document.cookie = 'pandacode_csrf=pairing-token'; });
  await page.route('**/api/pandacode/files/roots', route => route.fulfill({ json: [{ id: 'home', label: 'Home' }, { id: 'projects', label: 'Projects' }] }));
  await page.route('**/api/pandacode/files/list**', route => {
    const url = new URL(route.request().url()); const root = url.searchParams.get('root'); const path = url.searchParams.get('path'); const cursor = url.searchParams.get('cursor');
    if (root === 'projects' && path === 'src' && cursor === 'page-2') return route.fulfill({ json: { root, path, entries: [{ name: 'later', path: 'src/later', directory: true }] } });
    if (root === 'projects' && path === 'src') return route.fulfill({ json: { root, path, entries: [{ name: 'main.ts', path: 'src/main.ts', directory: false }, { name: 'lib', path: 'src/lib', directory: true }], nextCursor: 'page-2' } });
    if (root === 'projects' && path === 'src/later') return route.fulfill({ json: { root, path, entries: [] } });
    return route.fulfill({ json: { root, path, entries: [{ name: 'src', path: 'src', directory: true }, { name: 'README.md', path: 'README.md', directory: false }] } });
  });
  await page.route('**/api/pandacode/files/select', route => route.fulfill({ json: { grant: 'grant-projects-src', name: 'src', directory: true } }));
  const result = page.evaluate(async () => { const { WebFiles } = await import('/src/web-files.ts'); return new WebFiles().pickFolder('project'); });
  await expect(page.locator('.web-file-picker')).toBeVisible();
  await page.locator('[data-root]').selectOption('projects'); await expect(page.locator('[data-breadcrumb]')).toContainText('Projects');
  await page.getByRole('button', { name: 'src', exact: false }).click(); await expect(page.locator('[data-breadcrumb]')).toContainText('src');
  // Files remain visible as context in a folder picker, but cannot be selected.
  await expect(page.locator('button[data-path="src/main.ts"]')).toBeDisabled(); await page.getByRole('button', { name: 'Next' }).click(); await expect(page.getByRole('button', { name: 'later', exact: false })).toBeVisible(); await page.getByRole('button', { name: 'later', exact: false }).click(); await expect(page.locator('[data-breadcrumb]')).toContainText('later'); await page.getByRole('button', { name: 'Up' }).click();
  await page.getByRole('button', { name: 'Up' }).click(); await expect(page.locator('[data-breadcrumb]')).not.toContainText('src');
  await page.getByRole('button', { name: 'src', exact: false }).click(); await page.getByRole('button', { name: 'Select folder' }).click();
  expect(await result).toMatchObject({ grant: 'grant-projects-src' });
});

test('folder picker cancellation resolves null and listing failure keeps Select disabled', async ({ page }) => {
  await page.goto('/?web'); await page.evaluate(() => { document.cookie = 'pandacode_csrf=pairing-token'; });
  await page.route('**/api/pandacode/files/roots', route => route.fulfill({ json: [{ id: 'home', label: 'Home' }] }));
  await page.route('**/api/pandacode/files/list**', route => route.fulfill({ status: 503, body: 'offline' }));
  const result = page.evaluate(async () => { const { WebFiles } = await import('/src/web-files.ts'); return new WebFiles().pickFolder('folder'); });
  await expect(page.locator('[data-select]')).toBeDisabled(); await expect(page.locator('.web-file-picker [role="status"]')).toContainText('File gateway request failed');
  await page.keyboard.press('Escape'); expect(await result).toBeNull();
});

test('folder picker remains clickable when nested over an existing dialog with shared styles', async ({ page }) => {
  await page.goto('/?web'); await page.evaluate(() => { document.cookie = 'pandacode_csrf=pairing-token'; const dialog = document.createElement('dialog'); dialog.className = 'dialog-plate'; dialog.open = true; dialog.innerHTML = '<button type="button" aria-label="Outer dialog action">Outer action</button>'; document.body.append(dialog); });
  await page.route('**/api/pandacode/files/roots', route => route.fulfill({ json: [{ id: 'home', label: 'Home' }] }));
  await page.route('**/api/pandacode/files/list**', route => route.fulfill({ json: { root: 'home', path: '', entries: [{ name: 'workspace', path: 'workspace', directory: true }] } }));
  await page.route('**/api/pandacode/files/select', route => route.fulfill({ json: { grant: 'nested-folder-grant', name: 'workspace', directory: true } }));
  const result = page.evaluate(async () => { const { WebFiles } = await import('/src/web-files.ts'); return new WebFiles().pickFolder('folder'); });
  await expect(page.getByRole('button', { name: 'workspace', exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'workspace', exact: false }).click();
  await page.getByRole('button', { name: 'Select folder' }).click();
  expect(await result).toMatchObject({ grant: 'nested-folder-grant' });
  await page.getByRole('button', { name: 'Outer dialog action' }).click();
});

test('host executable picker selects a file with executable purpose', async ({ page }) => {
  await page.goto('/?web'); await page.evaluate(() => { document.cookie = 'pandacode_csrf=pairing-token'; });
  await page.route('**/api/pandacode/files/roots', route => route.fulfill({ json: [{ id: 'home', label: 'Home' }] }));
  await page.route('**/api/pandacode/files/list**', route => { const cursor = new URL(route.request().url()).searchParams.get('cursor'); return route.fulfill({ json: cursor === 'page-2' ? { root: 'home', path: '', entries: [{ name: 'pandacode-later', path: 'pandacode-later', directory: false }] } : { root: 'home', path: '', entries: [{ name: 'pandacode', path: 'pandacode', directory: false }], nextCursor: 'page-2' } }); });
  let request: Record<string, unknown> | undefined;
  await page.route('**/api/pandacode/files/select', async route => { request = route.request().postDataJSON(); await route.fulfill({ json: { grant: 'grant-executable', name: 'pandacode' } }); });
  const result = page.evaluate(async () => { const { WebFiles } = await import('/src/web-files.ts'); return new WebFiles().pickHostFile('executable'); });
  await expect(page.getByRole('button', { name: 'pandacode' })).toBeVisible(); await page.getByRole('button', { name: 'Next' }).click(); await expect(page.getByRole('button', { name: 'pandacode-later' })).toBeVisible(); await page.getByRole('button', { name: 'pandacode-later' }).click(); await page.getByRole('button', { name: 'Select file' }).click();
  expect(await result).toMatchObject({ grant: 'grant-executable' }); expect(request).toMatchObject({ root: 'home', path: 'pandacode-later', kind: 'file', purpose: 'executable' });
});

test('session repair cancel preserves the mounted workspace and draft', async ({ page }) => {
  await offlinePairing(page);
  await page.evaluate(() => { const draft = document.createElement('textarea'); draft.setAttribute('aria-label', 'Draft'); document.body.append(draft); });
  await page.evaluate(async () => { const { mountWebConnectionStatus } = await import('/src/web-runtime.ts'); mountWebConnectionStatus(); });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } })));
  const draft = page.locator('textarea').first(); await draft.fill('unsent draft');
  await page.getByRole('button', { name: 'Pair again' }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(draft).toHaveValue('unsent draft');
});

test('session repair posts a one-time code and closes only after recovery', async ({ page }) => {
  await offlinePairing(page);
  await page.unroute('**/api/pandacode/session');
  await page.evaluate(async () => { const { mountWebConnectionStatus } = await import('/src/web-runtime.ts'); mountWebConnectionStatus(); });
  await page.route('**/api/pandacode/session', async route => { await route.fulfill({ status: 204 }); });
  await page.route('**/api/pandacode/runtime-snapshot', async route => { await route.fulfill({ json: { sequence: 4, truncated: false, events: [] } }); });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } })));
  await page.getByRole('button', { name: 'Pair again' }).click(); const input = page.getByRole('dialog').locator('input'); await input.fill('  one-time-code  ');
  const request = page.waitForRequest('**/api/pandacode/session'); await page.getByRole('button', { name: 'Pair', exact: true }).click(); const sent = await request; expect(JSON.parse(sent.postData()!)).toEqual({ token: 'one-time-code' });
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => ({ url: location.href, storage: Object.keys(localStorage), input: document.querySelector('dialog input')?.value ?? '' }))).toMatchObject({ url: expect.stringContaining('?web'), storage: [], input: '' });
});


test('password session repair submits the password and restores the workspace', async ({ page }) => {
  await offlinePairing(page);
  await page.route('**/api/pandacode/login-mode', route => route.fulfill({ json: { mode: 'password' } }));
  await page.route('**/api/pandacode/session', route => {
    expect(route.request().postDataJSON()).toEqual({ token: 'fixture-password' });
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/pandacode/runtime-snapshot', route => route.fulfill({ json: { sequence: 4, truncated: false, events: [] } }));
  await page.evaluate(async () => {
    const { mountWebConnectionStatus } = await import('/src/web-runtime.ts');
    mountWebConnectionStatus();
    window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } }));
  });
  await page.getByRole('button', { name: 'Pair again' }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Instance password');
  await expect(input).toHaveAttribute('autocomplete', 'current-password');
  await input.fill('fixture-password');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('session repair escape and failed pairing preserve the draft', async ({ page }) => {
  await offlinePairing(page); await page.evaluate(() => { const draft = document.createElement('textarea'); draft.setAttribute('aria-label', 'Draft'); document.body.append(draft); });
  await page.evaluate(async () => { const { mountWebConnectionStatus } = await import('/src/web-runtime.ts'); mountWebConnectionStatus(); });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } })));
  const draft = page.getByLabel('Draft'); await draft.fill('keep this draft'); await page.getByRole('button', { name: 'Pair again' }).click(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(draft).toHaveValue('keep this draft');
  await page.route('**/api/pandacode/session', route => route.fulfill({ status: 401, body: 'invalid' })); await page.getByRole('button', { name: 'Pair again' }).click(); const input = page.getByRole('dialog').locator('input'); await input.fill('bad-code'); await page.getByRole('button', { name: 'Pair', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await expect(input).toHaveValue(''); await expect(draft).toHaveValue('keep this draft');
});

for (const view of ['launcher', 'tray']) {
  test(`browser URL cannot bypass pairing through native ${view} entry`, async ({ page }) => {
    await page.route('**/api/pandacode/preferences', route => route.fulfill({ status: 401 }));
    await page.goto(`/?web&view=${view}`);
    await expect(page.getByLabel('Pairing code')).toBeVisible();
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/src\/(overlay|tray-popover)\.ts/.test(entry.name)))).toBe(false);
  });
}

test('canceled pairing response cannot close a later repair dialog', async ({ page }) => {
  await offlinePairing(page); await page.evaluate(async () => { const { mountWebConnectionStatus } = await import('/src/web-runtime.ts'); mountWebConnectionStatus(); });
  let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; }); let requests = 0;
  await page.unroute('**/api/pandacode/session'); await page.route('**/api/pandacode/session', async route => { requests++; if (requests === 1) { await delayed; await route.fulfill({ status: 204 }); } else await route.fulfill({ status: 401, body: 'invalid' }); });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } })));
  await page.getByRole('button', { name: 'Pair again' }).click(); await page.getByRole('dialog').locator('input').fill('old-code'); await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByRole('dialog').locator('button[data-cancel]').click(); await page.getByRole('button', { name: 'Pair again' }).click(); await expect(page.getByRole('dialog')).toBeVisible(); release(); await new Promise(resolve => setTimeout(resolve, 50)); await expect(page.getByRole('dialog')).toBeVisible();
});

test('browser external link fallback is accessible and does not navigate', async ({ page }) => {
  await page.goto('/?web');
  await page.evaluate(async () => { const { openWebExternal } = await import('/src/web-external.ts'); (window as any).__openWebExternal = openWebExternal; });
  await page.evaluate(() => { Object.defineProperty(window, 'open', { value: undefined, configurable: true }); (window as any).__openWebExternal('https://example.test/help'); });
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute('aria-labelledby', 'web-external-link-title');
  const link = dialog.getByRole('link', { name: 'https://example.test/help' }); await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer'); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page).toHaveURL(/\?web/);
});

test('revealing a host path browses only its located root without minting a grant', async ({ page }) => {
  await offlinePairing(page);
  await page.evaluate(() => { document.cookie = 'pandacode_csrf=fixture-csrf'; });
  let selections = 0;
  await page.route('**/api/pandacode/files/locate', route => {
    expect(route.request().postDataJSON()).toEqual({ path: '/fixture/src/target.txt' });
    expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
    return route.fulfill({ json: { root: 'fixture', path: 'src', name: 'target.txt' } });
  });
  await page.route('**/api/pandacode/files/roots', route => route.fulfill({ json: [{ id: 'fixture', label: 'Fixture' }] }));
  await page.route('**/api/pandacode/files/list**', route => {
    expect(new URL(route.request().url()).searchParams.get('path')).toBe('src');
    return route.fulfill({ json: { entries: [{ name: 'target.txt', path: 'src/target.txt', directory: false }] } });
  });
  await page.route('**/api/pandacode/files/select', route => { selections++; return route.fulfill({ status: 500 }); });
  await page.evaluate(async () => {
    const { WebFiles } = await import('/src/web-files.ts');
    (window as any).__revealDone = false;
    void new WebFiles().reveal('/fixture/src/target.txt').then(() => { (window as any).__revealDone = true; });
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Host files' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Folder path', exact: true })).toHaveValue('src');
  await expect(dialog.getByRole('button', { name: 'Select folder' })).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('target.txt');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__revealDone)).toBe(true);
  expect(selections).toBe(0);
});

async function mountFixtureTerminal(page: import('@playwright/test').Page, snapshotHandler: (route: import('@playwright/test').Route) => Promise<void>, writeHandler?: (route: import('@playwright/test').Route) => Promise<void>) {
  await offlinePairing(page);
  await page.route('**/api/pandacode/commands/**', route => {
    const command = new URL(route.request().url()).pathname.split('/').pop();
    if (command === 'write_terminal' && writeHandler) return writeHandler(route);
    return route.fulfill({ json: command === 'get_terminal_preferences' ? {} : command === 'start_terminal' ? 't' : null });
  });
  await page.route('**/api/pandacode/terminals/t/snapshot', snapshotHandler);
  await page.evaluate(async () => {
    class Socket {
      onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void;
      constructor() { (window as any).__terminalSockets.push(this); queueMicrotask(() => this.onopen?.()); }
      send() {} close() { this.onclose?.(); }
    }
    (window as any).__terminalSockets = [];
    window.WebSocket = Socket as unknown as typeof WebSocket;
    const host = document.createElement('section'); host.id = 'terminal-test';
    host.style.cssText = 'position:fixed;inset:0;width:800px;height:400px;background:var(--panel);z-index:50'; document.body.append(host);
    const { mountTerminal } = await import('/src/terminal.ts');
    (window as any).__terminalErrors = [];
    (window as any).__terminalController = await mountTerminal(host, { projectId: 'fixture' }, error => (window as any).__terminalErrors.push(String(error)));
  });
}

test('terminal recovery replaces output and resumes keyboard input after a sequence gap', async ({ page }) => {
  let count = 0; let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; }); const writes: string[] = [];
  await mountFixtureTerminal(page, async route => {
    count++; if (count > 1) await delayed;
    await route.fulfill({ json: { terminalId: 't', baseSequence: 1, nextSequence: count === 1 ? 1 : 3, data: count === 1 ? 'initial\r\n' : 'initial\r\none\r\nduring\r\n', exit: false, truncated: false } });
  }, async route => { writes.push(route.request().postDataJSON().data); await route.fulfill({ json: null }); });
  const terminal = page.locator('#terminal-test'); await expect(terminal.locator('.xterm-screen')).toContainText('initial');
  await page.evaluate(() => (window as any).__terminalSockets[0].onmessage({ data: JSON.stringify({ type: 'terminal-event', sequence: 1, payload: { terminalId: 't', terminalSequence: 2, data: 'one\r\n' } }) }));
  await expect(terminal.locator('.xterm-screen')).toContainText('one');
  await page.evaluate(() => { window.dispatchEvent(new Event('pandacode-web-runtime-reset')); window.dispatchEvent(new Event('pandacode-web-runtime-restored')); });
  await expect(terminal.getByRole('alert')).toContainText('Reconnecting');
  const input = terminal.locator('.xterm-helper-textarea'); await input.press('Space'); expect(writes).toEqual([]);
  await page.evaluate(() => (window as any).__terminalSockets[0].onmessage({ data: JSON.stringify({ type: 'terminal-event', sequence: 2, payload: { terminalId: 't', terminalSequence: 3, data: 'during\r\n' } }) }));
  release(); await expect(terminal.getByRole('alert')).toBeHidden();
  await expect(terminal.locator('.xterm-screen')).toContainText('during');
  const text = await terminal.locator('.xterm-screen').textContent(); expect(text?.match(/initial/g)).toHaveLength(1); expect(text?.match(/during/g)).toHaveLength(1);
  await input.press('Space'); await expect.poll(() => writes.join('')).toBe(' ');
  await page.evaluate(() => (window as any).__terminalController.dispose());
});

test('terminal output loss cannot be bypassed with Resume input', async ({ page }) => {
  let snapshots = 0, writes = 0;
  await mountFixtureTerminal(page, async route => { snapshots++; await route.fulfill({ json: { terminalId: 't', baseSequence: 1, nextSequence: 1, data: 'prompt', exit: false, truncated: snapshots > 1 } }); }, async route => { writes++; await route.fulfill({ status: 504 }); });
  const terminal = page.locator('#terminal-test'), input = terminal.locator('.xterm-helper-textarea');
  await input.press('x'); await expect(terminal.getByRole('button', { name: 'Resume input' })).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('pandacode-web-runtime-reset')); window.dispatchEvent(new Event('pandacode-web-runtime-restored')); });
  await expect(terminal.getByRole('alert')).toContainText('Close and reopen');
  await expect(terminal.getByRole('button', { name: 'Resume input' })).toHaveCount(0);
  await input.press('Space'); expect(writes).toBe(1);
  await page.evaluate(() => (window as any).__terminalController.dispose());
});
