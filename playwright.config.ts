import { defineConfig } from '@playwright/test';
import { acquireBrowserRun, reportDirectory } from './scripts/playwright-artifacts.mjs';

// Ports select servers, not permanent artifact directories. One suite owns this checkout at a time;
// the lease is taken before Playwright can clear any previous output. Listing tests is read-only.
acquireBrowserRun();
const port = Number(process.env.PW_PORT ?? 1420);
// Historical port-* evidence is left untouched. Latest results are replaceable; archive deliberately
// with PW_REPORT_DIR when a particular failure or baseline must remain available.
export const outputRoot = reportDirectory(process.cwd(), 'chromium', process.env.PW_REPORT_DIR);
export const webkitOutputRoot = reportDirectory(process.cwd(), 'webkit', process.env.PW_REPORT_DIR);
// The diff benchmark (~90 s) runs only when named or with PERF=1. Workers inherit the env.
if (process.argv.some(arg => arg.includes('diff-perf') || arg.includes('transcript-perf'))) process.env.PERF = '1';
export const perfSpecs = process.env.PERF === '1' ? ['**/diff-perf.spec.ts', '**/transcript-perf.spec.ts'] : [];

const config = defineConfig({
  testDir: './tests',
  testMatch: ['**/crash-recovery.spec.ts', '**/voice-input-*.spec.ts', '**/voice-local-models.spec.ts', '**/voice-local-tests.spec.ts', '**/keyboard-layout.spec.ts', '**/desktop-pandas.spec.ts', '**/council.spec.ts', '**/external-links.spec.ts', '**/remove-project.spec.ts', '**/run-project.spec.ts', '**/harness-privacy.spec.ts', '**/terminal.spec.ts', '**/thread-order.spec.ts', '**/sidebar-sections.spec.ts', '**/thread-panels.spec.ts', '**/agent-updates.spec.ts', '**/thread-deletion.spec.ts', '**/agent-usage.spec.ts', '**/grok.spec.ts', '**/compact-menus.spec.ts', '**/attachments.spec.ts', '**/sketch.spec.ts', '**/worktrees.spec.ts', '**/github.spec.ts', '**/github-hub.spec.ts', '**/remote.spec.ts', '**/simulator.spec.ts', '**/colors.spec.ts', '**/token-saver.spec.ts', '**/support.spec.ts', '**/jev-live.spec.ts', '**/jev-assist.spec.ts', '**/jev.spec.ts', '**/message-actions.spec.ts', '**/opencode-models.spec.ts', '**/overlay.spec.ts', '**/moodboards.spec.ts', '**/provider-settings.spec.ts', '**/ui.spec.ts', '**/browser.spec.ts', '**/board.spec.ts', '**/streaming.spec.ts', '**/provider-handoff.spec.ts', '**/concurrency.spec.ts', '**/subagents.spec.ts', '**/architect.spec.ts', '**/team-profiles.spec.ts', '**/agent-teams.spec.ts', '**/vm.spec.ts', '**/deploy.spec.ts', '**/turn-changes.spec.ts', '**/wallpapers.spec.ts', '**/wallpaper-settings.spec.ts', '**/settings.spec.ts', '**/layout-preferences.spec.ts', '**/agent-input.spec.ts', '**/agent-tools.spec.ts', '**/slash-commands.spec.ts', '**/file-mentions.spec.ts', '**/command-center.spec.ts', '**/goal-workflow.spec.ts', '**/conversation-import.spec.ts', '**/message-queue.spec.ts', '**/steering.spec.ts', '**/usage-limit.spec.ts', '**/bots.spec.ts', '**/bots-web.spec.ts', '**/bots-create.spec.ts', '**/bots-thread.spec.ts', '**/bots-channels.spec.ts', '**/queue-parity.spec.ts', '**/markdown.spec.ts', '**/document-viewer.spec.ts', '**/file-explorer.spec.ts', '**/file-editor.spec.ts', '**/office-viewer.spec.ts', '**/generative-ui.spec.ts', '**/search-panel.spec.ts', '**/design-canvas.spec.ts', '**/skills-library.spec.ts', '**/skill-manager.spec.ts', '**/jj.spec.ts', '**/capabilities.spec.ts', '**/recipes.spec.ts', '**/github-hub-keyboard.spec.ts', '**/chats.spec.ts', '**/connections.spec.ts', '**/account-pool.spec.ts', '**/inspector-new-task.spec.ts', '**/inspector-tabs.spec.ts', '**/changes-view.spec.ts', '**/cloud-agents.spec.ts', '**/tray-popover.spec.ts', '**/model-picker.spec.ts', '**/remote-progress.spec.ts', '**/remote-images.spec.ts', '**/remote-first-message.spec.ts', '**/remote-connect-ux.spec.ts', '**/remote-pairing.spec.ts', '**/remote-diagnostics.spec.ts', '**/remote-thread-open.spec.ts', '**/remote-subagents.spec.ts', '**/agent-traces.spec.ts', '**/sidebar-keyboard.spec.ts', '**/model-routing.spec.ts', '**/model-tiers.spec.ts', '**/thread-header-overlay.spec.ts', '**/action-dock.spec.ts', '**/thinking.spec.ts', '**/agents-dock.spec.ts', '**/tool-trace-gallery.spec.ts', '**/tool-visuals.spec.ts', ...perfSpecs, '**/progress-pip.spec.ts', '**/schedules.spec.ts', '**/schedules-settings.spec.ts', '**/machine-orchestration.spec.ts', '**/btw.spec.ts', '**/composer-tray.spec.ts', '**/sky.spec.ts', '**/scenes.spec.ts', '**/turn-card.spec.ts', '**/thread-tiles.spec.ts', '**/transcript-window.spec.ts', '**/transcript-rows.spec.ts', '**/composer-undo.spec.ts', '**/project-relink.spec.ts', '**/cloud-settings.spec.ts', '**/pointer-drag.spec.ts', '**/thread-errors.spec.ts', '**/toast-errors.spec.ts', '**/error-banners.spec.ts', '**/settings-warm.spec.ts'],
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 4),
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  outputDir: outputRoot,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
    command: process.env.PW_PROD
      ? `node scripts/playwright-artifacts.mjs --preview ${port}`
      : port !== 1420 ? `npx vite --port ${port} --strictPort --host 127.0.0.1` : 'npm run dev',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.PW_PROD,
    timeout: process.env.PW_PROD ? 180_000 : 30_000,
  },
});

config.testMatch.push('**/extensions-development.spec.ts');
config.testMatch.push('**/extensions-performance.spec.ts');
config.testMatch.push('**/extensions-content-coverage.spec.ts');
config.testMatch.push('**/extensions-terminal-coverage.spec.ts');
config.testMatch.push('**/extensions-simulator-coverage.spec.ts');
config.testMatch.push('**/extensions-vm-coverage.spec.ts');
config.testMatch.push('**/extensions-design-coverage.spec.ts');
config.testMatch.push('**/extensions-btw-coverage.spec.ts');
config.testMatch.push('**/extensions-board-coverage.spec.ts');
config.testMatch.push('**/extensions-github-hub-coverage.spec.ts');
config.testMatch.push('**/extensions-pull-coverage.spec.ts');
config.testMatch.push('**/extensions-worktrees-coverage.spec.ts');
config.testMatch.push('**/extensions-settings-coverage.spec.ts');
config.testMatch.push('**/extensions-sidebar-coverage.spec.ts');
config.testMatch.push('**/extensions-sidebar-bots-coverage.spec.ts');
config.testMatch.push('**/extensions-team-controls-coverage.spec.ts');
config.testMatch.push('**/extensions-agent-roster-coverage.spec.ts');
config.testMatch.push('**/extensions-status-coverage.spec.ts');
config.testMatch.push('**/extensions-core-dialogs-coverage.spec.ts');
config.testMatch.push('**/extensions-owned-dialogs-coverage.spec.ts');
config.testMatch.push('**/extensions-moodboards-coverage.spec.ts');
config.testMatch.push('**/extensions-cloud-coverage.spec.ts');
config.testMatch.push('**/extensions-machine-coverage.spec.ts');
config.testMatch.push('**/extensions-workspace-coverage.spec.ts');
config.testMatch.push('**/extensions-tools-coverage.spec.ts');
config.testMatch.push('**/extensions-storage.spec.ts');
config.testMatch.push('**/extensions-jobs.spec.ts');
config.testMatch.push('**/extensions-connections.spec.ts');
config.testMatch.push('**/extensions-services.spec.ts');
config.testMatch.push('**/extensions-views.spec.ts');
config.testMatch.push('**/extensions-rich-views.spec.ts');
config.testMatch.push('**/extensions-placement.spec.ts');
config.testMatch.push('**/extensions-appearance.spec.ts');
config.testMatch.push('**/extensions-replacement.spec.ts');
config.testMatch.push('**/extensions-documents-coverage.spec.ts');
config.testMatch.push('**/extensions-diff-coverage.spec.ts');
config.testMatch.push('**/extensions-search-coverage.spec.ts');
config.testMatch.push('**/extensions-browser-coverage.spec.ts');
config.testMatch.push('**/extensions-composer-conformance.spec.ts');
config.testMatch.push('**/extensions-transcript-conformance.spec.ts');
config.testMatch.push('**/extensions-provider-history.spec.ts');
config.testMatch.push('**/extensions-harness.spec.ts');
config.testMatch.push('**/extensions-provider-catalog.spec.ts');
config.testMatch.push('**/extensions-provider-teams.spec.ts');
config.testMatch.push('**/extensions-provider-cli.spec.ts');
config.testMatch.push('**/extensions-provider-skills.spec.ts');
config.testMatch.push('**/extensions-remote.spec.ts');
config.testMatch.push('**/extensions-multiwindow.spec.ts');
config.testMatch.push('**/extensions-updates.spec.ts');
config.testMatch.push('**/extensions-primitives-coverage.spec.ts');
config.testMatch.push('**/extensions-controls-coverage.spec.ts');
config.testMatch.push('**/extensions-window-coverage.spec.ts');
config.testMatch.push('**/extensions-project-scope.spec.ts');
config.testMatch.push('**/extensions-composer-controls-coverage.spec.ts');
config.testMatch.push('**/extensions-composer-panels-coverage.spec.ts');
config.testMatch.push('**/extensions-attach-wake-coverage.spec.ts');
config.testMatch.push('**/extensions-thread-extras-coverage.spec.ts');
config.testMatch.push('**/extensions-tiles-picker-coverage.spec.ts');
config.testMatch.push('**/extensions-commands-extras-coverage.spec.ts');
config.testMatch.push('**/extensions-task-menus-coverage.spec.ts');
config.testMatch.push('**/extensions-window-menus-coverage.spec.ts');
config.testMatch.push('**/extensions-bot-conversation-coverage.spec.ts');
config.testMatch.push('**/extensions-gap-closure.spec.ts');
config.testMatch.push('**/extensions-runtime-grants.spec.ts');
config.testMatch.push('**/extensions-runtime-grants-manager.spec.ts');
config.testMatch.push('**/extensions-runtime-native-consents.spec.ts');
config.testMatch.push('**/extensions-runtime-family-consents.spec.ts');
config.testMatch.push('**/extensions-runtime-service-lifetime.spec.ts');
config.testMatch.push('**/extensions-runtime-duplex-channel.spec.ts');
config.testMatch.push('**/extensions-runtime-private-secrets.spec.ts');
config.testMatch.push('**/upstream-remote-extensions.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-events.spec.ts');
config.testMatch.push('**/extensions-runtime-connection-adapters.spec.ts');
config.testMatch.push('**/extensions-runtime-held-credentials.spec.ts');
config.testMatch.push('**/extensions-runtime-sign-in.spec.ts');
config.testMatch.push('**/extensions-runtime-code-folders.spec.ts');
config.testMatch.push('**/extensions-runtime-service-supervision.spec.ts');
config.testMatch.push('**/extensions-runtime-content-resources.spec.ts');
config.testMatch.push('**/extensions-runtime-usage-resources.spec.ts');
config.testMatch.push('**/extensions-runtime-provider-launch.spec.ts');
config.testMatch.push('**/extensions-runtime-service-status.spec.ts');
config.testMatch.push('**/extensions-runtime-executor-placement.spec.ts');
config.testMatch.push('**/extensions-runtime-dynamic-items.spec.ts');
config.testMatch.push('**/extensions-runtime-composer-band.spec.ts');
config.testMatch.push('**/extensions-runtime-transcript-presentation.spec.ts');
config.testMatch.push('**/extensions-runtime-tool-row-replacement.spec.ts');
config.testMatch.push('**/extensions-runtime-dialog-navigation.spec.ts');
config.testMatch.push('**/extensions-runtime-notifications.spec.ts');
config.testMatch.push('**/extensions-runtime-tasks-start.spec.ts');
config.testMatch.push('**/extensions-runtime-tasks-messages.spec.ts');
config.testMatch.push('**/extensions-runtime-tasks-drafts.spec.ts');
config.testMatch.push('**/extensions-runtime-terminals.spec.ts');
config.testMatch.push('**/extensions-runtime-guests.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-cloud.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-projects.spec.ts');
config.testMatch.push('**/extensions-runtime-tasks-control.spec.ts');
config.testMatch.push('**/extensions-runtime-tasks-flow.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-settings.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-automation.spec.ts');
config.testMatch.push('**/extensions-runtime-workspace-schedules.spec.ts');
config.testMatch.push('**/extensions-runtime-provider-state.spec.ts');
config.testMatch.push('**/extensions-runtime-provider-speed.spec.ts');
config.testMatch.push('**/extensions-runtime-preview.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-fixtures.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-payload.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-registration.spec.ts');
config.testMatch.push('**/extensions-runtime-harness-coverage.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-context.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-decisions.spec.ts');
config.testMatch.push('**/extensions-runtime-hook-resolution.spec.ts');
config.testMatch.push('**/extensions-runtime-model-tools.spec.ts');
config.testMatch.push('**/extensions-runtime-tool-servers.spec.ts');
config.testMatch.push('**/extensions-runtime-cli-intent.spec.ts');
config.testMatch.push('**/extensions-runtime-model-call.spec.ts');
config.testMatch.push('**/extensions-runtime-protected-presentation.spec.ts');
config.testMatch.push('**/extensions-runtime-document-editors.spec.ts');
config.testMatch.push('**/extensions-runtime-document-save.spec.ts');
config.testMatch.push('**/extensions-runtime-new-file-templates.spec.ts');
config.testMatch.push('**/upstream-semantic-remote-images.spec.ts');
config.testMatch.push('**/upstream-tool-images-extensions.spec.ts');
config.testMatch.push('**/upstream-workers-extensions.spec.ts');
config.testMatch.push('**/upstream-menu-usage-extensions.spec.ts');
config.testMatch.push('**/upstream-explorer-extensions.spec.ts');
config.testMatch.push('**/upstream-editor-extensions.spec.ts');
config.testMatch.push('**/upstream-tool-rows-extensions.spec.ts');
config.testMatch.push('**/upstream-recovery-extensions.spec.ts');
config.testMatch.push('**/upstream-errors-extensions.spec.ts');
config.testMatch.push('**/upstream-speed-extensions.spec.ts');
config.testMatch.push('**/upstream-acp-example.spec.ts');
config.testMatch.push('**/upstream-api-tools-example.spec.ts');
config.testMatch.push('**/extensions-example-live-board.spec.ts');
config.testMatch.push('**/extensions-runtime-rich-mount.spec.ts');
config.testMatch.push('**/extensions-runtime-rich-assets.spec.ts');
config.testMatch.push('**/extensions-runtime-rich-channel.spec.ts');
config.testMatch.push('**/extensions-runtime-rich-focus.spec.ts');
config.testMatch.push('**/extensions-runtime-panel-only.spec.ts');
config.testMatch.push('**/extensions-runtime-harness-console.spec.ts');
config.testMatch.push('**/extensions-runtime-windows-panels.spec.ts');
config.testMatch.push('**/extensions-runtime-pending-requests.spec.ts');
export default defineConfig(config, {
  // Project read coverage is explicit, like every experimental extension surface.
  testMatch: [...config.testMatch as string[], '**/extensions-trust.spec.ts', ...(process.platform === 'win32' && process.arch === 'x64' ? ['**/extensions-runtime.spec.ts'] : []), '**/extensions-project-reads.spec.ts', '**/extensions-inventory.spec.ts', '**/extensions-context.spec.ts', '**/extensions-baseline.spec.ts', '**/extensions-install.spec.ts', '**/extensions-catalog.spec.ts', '**/extensions-layout.spec.ts', '**/extensions-menus.spec.ts', '**/extensions-dialogs.spec.ts', '**/extensions-view-actions.spec.ts', '**/extensions-thread-actions.spec.ts', '**/extensions-settings-actions.spec.ts', '**/extensions-windows.spec.ts', '**/tray-popover.spec.ts'],
});
