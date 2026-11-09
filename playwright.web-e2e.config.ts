import { defineConfig } from '@playwright/test';

// End-to-end suite against a real native PandaCode with --web-gateway (scripts/web-e2e/host.mjs).
// Build first: `npm run web-e2e:build`. One native host per run; tests share it, so run serially.
const port = Number(process.env.PANDACODE_WEB_E2E_PORT ?? 6091);
export default defineConfig({
  testDir: './tests/web-e2e',
  globalSetup: './tests/web-e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: '.web-e2e/results.json' }]],
  outputDir: '.web-e2e/output',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    storageState: '.web-e2e/state.json',
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: process.env.PANDACODE_TEST_CHROME ? { executablePath: process.env.PANDACODE_TEST_CHROME } : {},
  },
});
