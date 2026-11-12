import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const owned = new Set<ReturnType<typeof spawn>>();
test.afterEach(async () => {
  await Promise.all([...owned].map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); })));
});

function native(caseName: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Trusted native runtime fixture requires the explicitly qualified Windows x64 target');
  const directory = resolve('src-tauri/target/debug/deps');
  const binary = process.env.PANDACODE_EXTENSION_TEST_BINARY ?? readdirSync(directory).filter(name => /^pandacode_lib-[a-z0-9]+\.exe$/.test(name)).map(name => resolve(directory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!binary) throw new Error('Build the actual application native tests first; no fallback');
  const child = spawn(binary, ['--exact', 'extensions::packages::tests::trusted_native_driver', '--nocapture'], { env: { ...process.env, PANDACODE_EXTENSION_CASE: caseName, PANDACODE_EXTENSION_CANCEL_FROM_STDIN: caseName === 'cancel' ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.add(child); child.once('close', () => { owned.delete(child); });
  let output = '', errors = '', ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('TRUSTED_READY ')) ready(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  const finished = new Promise<{ case: string; status: string; dialogs: unknown[] | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`Native application fixture failed (${code}) ${output}\n${errors}`)); return; }
      const line = output.split(/\r?\n/).find(line => line.startsWith('TRUSTED_RESULT '));
      if (!line) { reject(new Error(`No native evidence: ${output}`)); return; }
      resolve(JSON.parse(line.slice('TRUSTED_RESULT '.length)));
    });
  });
  const guard = setTimeout(() => child.kill(), 25_000);
  void finished.finally(() => clearTimeout(guard)).catch(() => {});
  const overlap = Promise.race([started, finished.then(() => { throw new Error('Host exited before overlap'); })]);
  void overlap.catch(() => {}); // Success-only commands intentionally have no overlap acknowledgement.
  return { child, finished, started: overlap, output: () => output };
}

for (const fault of ['loop', 'timeout', 'allocation', 'exception']) {
  test(`extensions runtime: real native ${fault} preserves the same core stream and typing`, async ({ page }, info) => {
    test.setTimeout(40_000);
    await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true }; });
    await page.goto('/?extensions-baseline');
    const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled(); await prompt.fill('Native fault continuity'); await prompt.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    const element = await prompt.elementHandle(); const host = native(fault);
    try {
      await host.started; expect(host.child.exitCode).toBeNull();
      for (const token of ['one ', 'two ', 'three ']) {
        await page.evaluate(text => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text }), token);
        await prompt.pressSequentially(token, { delay: 0 });
      }
      expect(host.child.exitCode).toBeNull();
      await expect(prompt).toHaveValue('one two three '); await expect(page.locator('#stream-region .live-text')).toHaveText('one two three');
      const result = await host.finished; expect(result.status).toBe(['loop', 'timeout'].includes(fault) ? 'Timeout' : 'HostUnavailable'); expect(result.dialogs).toBeNull();
      await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'after' }));
      await prompt.pressSequentially('after'); await expect(prompt).toHaveValue('one two three after');
      await expect(page.locator('#stream-region .live-text')).toHaveText('one two three after');
      expect(await element!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
      await expect(prompt).toHaveAttribute('data-session-id', 'session-1');
      expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['send_message', 'stop_session'].includes(call.command)).map((call: any) => call.command))).toEqual(['send_message']);
      await info.attach('native-owned-host-evidence', { body: host.output(), contentType: 'text/plain' });
    } finally { if (host.child.exitCode === null) host.child.kill(); await host.finished.catch(() => {}); }
  });
}

test('extensions runtime: native executable Project summary DTO opens the current host dialog, not browser evaluation', async ({ page }, info) => {
  test.setTimeout(40_000);
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/project-summary/extension.json', 'utf8'));
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.wallpapers', 'false'); localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'native-fixture', trusted: true } }])); }, manifest);
  let evidence = '', complete!: () => void;
  const nativeComplete = new Promise<void>(resolve => { complete = resolve; });
  await page.exposeFunction('__extensionsNativeFixture', async (request: { op: string }) => {
    if (request.op === 'cancel') return { ok: true, value: null };
    const host = native('summary'); const result = await host.finished; evidence = host.output(); complete();
    return { ok: true, value: { schemaVersion: 1, dialogs: result.dialogs } };
  });
  await page.goto('/?project-context&native-extension-fixture'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Executable project summary', exact: true }).click();
  await page.getByRole('region', { name: 'Executable command', exact: true }).getByRole('button', { name: 'Allow project summaries and run', exact: true }).click();
  await nativeComplete;
  const dialog = page.getByRole('dialog', { name: 'Executable project summary — sample.project-summary', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Captured project', exact: true })).toHaveValue('orbit (project-1)');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await info.attach('native-project-summary-through-preview-renderer-not-installed-webview', { body: evidence, contentType: 'text/plain' });
});

test('extensions runtime: cancelling native owned work suppresses late UI, releases subscriptions and allows independent recovery', async ({ page }, info) => {
  test.setTimeout(40_000);
  const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/project-summary/extension.json', 'utf8'));
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'native-fixture', trusted: true } }])); }, manifest);
  let host: ReturnType<typeof native> | undefined, created!: () => void;
  const launched = new Promise<void>(resolve => { created = resolve; });
  await page.exposeFunction('__extensionsNativeFixture', async (request: { op: string }) => {
    if (request.op === 'cancel') { host?.child.stdin.write('cancel\n'); return { ok: true, value: null }; }
    host = native('cancel'); created(); const result = await host.finished;
    expect(result.status).toBe('Cancelled'); expect(result.dialogs).toBeNull();
    return { ok: false, error: { schemaVersion: 1, code: 'Cancelled', path: '$', ids: [] } };
  });
  await page.goto('/?project-context&native-extension-fixture'); await expect(page.locator('#prompt')).toBeEnabled(); await page.locator('#prompt').fill('Keep cancelled-host draft');
  await page.getByRole('button', { name: 'Executable project summary', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Executable command', exact: true });
  await panel.getByRole('button', { name: 'Allow project summaries and run', exact: true }).click();
  await launched; await host!.started;
  await panel.getByRole('button', { name: 'Cancel executable command', exact: true }).focus(); await page.keyboard.press('Escape');
  await host!.finished; await expect(panel).toHaveCount(0); await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Keep cancelled-host draft');
  expect(host!.output()).toContain('"case":"recovery"');
  await info.attach('native-cancellation-subscription-disposal-and-recovery', { body: host!.output(), contentType: 'text/plain' });
});
