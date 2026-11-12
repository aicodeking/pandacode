import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base, { webkitOutputRoot } from '../../../../playwright.config';

// Dedicated qualification runner: requires the independently built native experiment.
// Reuse the checkout artifact lease, source-fingerprinted production build and strict port.
export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: ['continuity.spec.ts'],
  webServer: { ...(Array.isArray(base.webServer) ? base.webServer[0] : base.webServer), cwd: fileURLToPath(new URL('../../../../', import.meta.url)) },
  fullyParallel: false,
  workers: 1,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', outputDir: webkitOutputRoot, use: { browserName: 'webkit', launchOptions: {} } }],
});
