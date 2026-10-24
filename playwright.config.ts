import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/external-links.spec.ts', '**/remove-project.spec.ts', '**/run-project.spec.ts', '**/terminal.spec.ts', '**/thread-order.spec.ts', '**/thread-panels.spec.ts', '**/agent-updates.spec.ts', '**/thread-deletion.spec.ts', '**/agent-usage.spec.ts', '**/grok.spec.ts', '**/compact-menus.spec.ts', '**/attachments.spec.ts', '**/sketch.spec.ts', '**/worktrees.spec.ts', '**/github.spec.ts', '**/github-hub.spec.ts', '**/remote.spec.ts', '**/simulator.spec.ts', '**/colors.spec.ts', '**/token-saver.spec.ts', '**/support.spec.ts', '**/jev-live.spec.ts', '**/jev-assist.spec.ts', '**/jev.spec.ts', '**/message-actions.spec.ts', '**/opencode-models.spec.ts', '**/overlay.spec.ts', '**/moodboards.spec.ts', '**/provider-settings.spec.ts', '**/ui.spec.ts', '**/browser.spec.ts', '**/board.spec.ts', '**/streaming.spec.ts', '**/concurrency.spec.ts', '**/subagents.spec.ts', '**/architect.spec.ts', '**/team-profiles.spec.ts', '**/agent-teams.spec.ts', '**/vm.spec.ts', '**/deploy.spec.ts', '**/turn-changes.spec.ts', '**/wallpapers.spec.ts', '**/wallpaper-settings.spec.ts', '**/settings.spec.ts', '**/layout-preferences.spec.ts', '**/agent-input.spec.ts', '**/agent-tools.spec.ts', '**/slash-commands.spec.ts', '**/file-mentions.spec.ts', '**/command-center.spec.ts', '**/goal-workflow.spec.ts', '**/conversation-import.spec.ts', '**/message-queue.spec.ts', '**/steering.spec.ts', '**/usage-limit.spec.ts', '**/bots.spec.ts', '**/bots-web.spec.ts', '**/markdown.spec.ts', '**/document-viewer.spec.ts', '**/generative-ui.spec.ts', '**/search-panel.spec.ts', '**/design-canvas.spec.ts', '**/skills-library.spec.ts', '**/jj.spec.ts', '**/capabilities.spec.ts', '**/recipes.spec.ts', '**/github-hub-keyboard.spec.ts', '**/chats.spec.ts', '**/connections.spec.ts', '**/inspector-new-task.spec.ts', '**/cloud-agents.spec.ts', '**/tray-popover.spec.ts'],
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 4),
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1440, height: 940 },
    headless: true,
    launchOptions: {
      // Playwright creates disposable browser contexts; never use a personal profile.
      executablePath: process.env.PANDACODE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
