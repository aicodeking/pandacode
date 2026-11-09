import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
// @ts-expect-error plain ESM helper without types
import { startHost } from '../../scripts/web-e2e/host.mjs';

/** Starts the isolated native host, pairs through the real pairing screen, saves the session. */
export default async function globalSetup(config: FullConfig) {
  mkdirSync('.web-e2e', { recursive: true });
  const host = await startHost();
  const use = config.projects[0].use;
  const browser = await chromium.launch(use.launchOptions);
  const page = await browser.newPage();
  await page.goto(host.origin);
  await page.locator('input[name="token"]').fill(host.code);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => document.cookie.includes('pandacode_csrf='), undefined, { timeout: 30_000 });
  await page.context().storageState({ path: '.web-e2e/state.json' });
  await browser.close();
  // Paths only; never the pairing code.
  writeFileSync('.web-e2e/host.json', JSON.stringify({ origin: host.origin, pid: host.pid, workspace: host.workspace, log: host.log }));
  process.env.PANDACODE_WEB_E2E_WORKSPACE = JSON.stringify(host.workspace);
  return async () => { await host.stop(); };
}
