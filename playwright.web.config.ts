import { defineConfig } from '@playwright/test';

const port = Number(process.env.PW_WEB_PORT ?? 1439);
const browserName = process.env.PW_WEB_ENGINE ?? 'chromium';
if (browserName !== 'chromium' && browserName !== 'firefox' && browserName !== 'webkit') {
  throw new Error('PW_WEB_ENGINE must be chromium, firefox, or webkit');
}
export default defineConfig({
  testDir: './tests', testMatch: ['**/web-ui.spec.ts', '**/web-workspace.spec.ts', '**/web-workspace-*.spec.ts', '**/web-browser.spec.ts'], fullyParallel: true, workers: 2,
  timeout: 20_000, expect: { timeout: 5_000 }, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, browserName, viewport: { width: 1024, height: 768 },
    launchOptions: browserName === 'chromium' && process.env.PANDACODE_TEST_CHROME ? { executablePath: process.env.PANDACODE_TEST_CHROME } : {} },
  webServer: { command: `npx vite --port ${port} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 },
});
