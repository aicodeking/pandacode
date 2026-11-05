import { defineConfig } from '@playwright/test';

// README screenshots: the browser preview with showcase data, captured at 2x and framed.
// Run with `npm run screenshots`; images land in docs/screenshots/.
const chrome = process.env.PANDACODE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: '.',
  testMatch: ['capture.spec.ts'],
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/pandacode-screenshots/results',
  use: {
    baseURL: 'http://127.0.0.1:1437',
    viewport: { width: 1512, height: 945 },
    deviceScaleFactor: 2,
    launchOptions: { executablePath: chrome },
    reducedMotion: 'no-preference',
  },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 1437 --strictPort', cwd: '../..', url: 'http://127.0.0.1:1437', reuseExistingServer: false, timeout: 60_000 },
});
