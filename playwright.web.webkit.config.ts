import { defineConfig } from '@playwright/test';
import base from './playwright.web.config';

export default defineConfig(base, {
  workers: 1,
  outputDir: 'playwright-report/webkit-webui',
  use: { ...base.use, browserName: 'webkit', launchOptions: {} },
});
