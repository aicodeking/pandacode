import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Broad desktop-preview regression with bounded disk use. Native/gateway
// acceptance lives in separate suites; preview responses do not prove it.
export default defineConfig({
  ...base,
  outputDir: `playwright-report/regression-${process.env.PW_RUN_ID ?? 'local'}`,
  use: { ...base.use, screenshot: 'off', trace: 'off' },
  webServer: {
    command: `npx vite --config vite.regression.config.ts --port ${Number(process.env.PW_PORT ?? 1420)} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${Number(process.env.PW_PORT ?? 1420)}`,
    timeout: 30000,
    reuseExistingServer: false,
  },
});
