import { defineConfig } from '@playwright/test';
import base, { webkitOutputRoot, perfSpecs } from './playwright.config';

// Native macOS uses WebKit: cover range dragging and the board lifecycle independently of Chrome.
const config = defineConfig(base, {
  workers: 1,
  outputDir: webkitOutputRoot,
  testMatch: ['**/voice-input-*.spec.ts', '**/voice-local-models.spec.ts', '**/voice-local-tests.spec.ts', '**/keyboard-layout.spec.ts', '**/desktop-pandas.spec.ts', '**/council.spec.ts', '**/external-links.spec.ts', '**/office-viewer.spec.ts', '**/conversation-import.spec.ts', '**/message-queue.spec.ts', '**/steering.spec.ts', '**/usage-limit.spec.ts', '**/run-project.spec.ts', '**/harness-privacy.spec.ts', '**/terminal.spec.ts', '**/thread-order.spec.ts', '**/message-actions.spec.ts', '**/thread-panels.spec.ts', '**/agent-updates.spec.ts', '**/thread-deletion.spec.ts', '**/agent-usage.spec.ts', '**/grok.spec.ts', '**/compact-menus.spec.ts', '**/attachments.spec.ts', '**/sketch.spec.ts', '**/worktrees.spec.ts', '**/github.spec.ts', '**/github-hub.spec.ts', '**/remote.spec.ts', '**/simulator.spec.ts', '**/colors.spec.ts', '**/token-saver.spec.ts', '**/support.spec.ts', '**/jev.spec.ts', '**/jev-live.spec.ts', '**/browser.spec.ts', '**/overlay.spec.ts', '**/moodboards.spec.ts', '**/provider-settings.spec.ts', '**/ui.spec.ts', '**/board.spec.ts', '**/streaming.spec.ts', '**/concurrency.spec.ts', '**/subagents.spec.ts', '**/architect.spec.ts', '**/team-profiles.spec.ts', '**/turn-changes.spec.ts', '**/wallpapers.spec.ts', '**/wallpaper-settings.spec.ts', '**/settings.spec.ts', '**/layout-preferences.spec.ts', '**/agent-input.spec.ts', '**/agent-tools.spec.ts', '**/slash-commands.spec.ts', '**/command-center.spec.ts', '**/goal-workflow.spec.ts', '**/conversation-import.spec.ts', '**/bots.spec.ts', '**/bots-web.spec.ts', '**/bots-create.spec.ts', '**/bots-thread.spec.ts', '**/bots-channels.spec.ts', '**/queue-parity.spec.ts', '**/markdown.spec.ts', '**/design-canvas.spec.ts', '**/skills-library.spec.ts', '**/skill-manager.spec.ts', '**/jj.spec.ts', '**/capabilities.spec.ts', '**/recipes.spec.ts', '**/github-hub-keyboard.spec.ts', '**/cloud-agents.spec.ts', '**/cloud-agents.spec.ts', '**/thread-header-overlay.spec.ts', '**/action-dock.spec.ts', '**/agent-teams.spec.ts', '**/deploy.spec.ts', '**/model-tiers.spec.ts', '**/machine-orchestration.spec.ts', '**/composer-tray.spec.ts', '**/turn-card.spec.ts', ...perfSpecs, '**/composer-undo.spec.ts', '**/project-relink.spec.ts', '**/cloud-settings.spec.ts', '**/pointer-drag.spec.ts', '**/progress-pip.spec.ts'],
  grep: /voice input|keyboard layouts|desktop pandas|Council|progress-pip|pointer drag|telemetry switch|failed save puts the switch back|failed load offers|a PDF opens in a tab|a Word document renders|a spreadsheet shows a grid|disposes the viewer|an image opens in a tab|Design canvas|system browser|project run|thread order|terminal|history|thread panels|Agent updates|task deletion|Agent usage|Grok|one line|info mark|behind marks|attach|Attach|sketch|paste|dropping|folders appear|Help|support|Jev|jev|browser|launcher|shortcut recorder|moodboard|provider connections|reasoning|Default thumb tap|loads full model names|project board|streaming|tool|turn activity|reported context|working phrases|live status|approvals|concurrency|subagents|architect|team profiles|turn changes|wallpapers|settings organization|layout preferences|agent input|agent tools|slash commands|command center|goal workflow|worktree|branch control|GitHub|simulator|Android|accent|VS Code theme|packs ride along|RTK is offered|turning on a missing tool|light and dark toggle|mentions offer|importing issues|pull request|conversations|Go to anything|queue|steer|usage limit|Resume at reset|overdue resume|reset time|hits a limit|bots|bot from|memories can|schedules show|chat channels|web channel|rules validate|pausing, editing|the sidebar lists bots|a bot page|enriched markdown|parser runs under the app CSP|chatting with a bot|suggestions send|greets with|replies render|history, idle|without a token|revoked while open|use the Enriched Markdown engine|Telegram setup|Slack setup|Discord setup|WhatsApp setup|web chat is one click|Cline|thread header overlay|action dock|finds text in the thread|Rules & library|Skill manager|Agent teams|team inheritance|deploy|Google Cloud connects|Rank models|dragging a chip|picks a chip up|Reset clears every tier|until the tiers load|diff perf|machine orchestration|composer-tray|saved turns: header sentence and time|Read more expands and collapses the reply|composer undo|Locate folder|cloud sandboxes/,
  use: { browserName: 'webkit', launchOptions: {} },
});
config.testMatch = [...config.testMatch as string[], '**/extensions-provider-catalog.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-provider-teams.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-provider-cli.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-provider-skills.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-remote.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-multiwindow.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-updates.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions updates`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions multiwindow`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions remote`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions skills`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions CLI`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions teams`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions provider catalog`);

config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions runtime|extensions trust|inspector strip|the inspector opens|the . menu lists|tabs select|the open tabs|opening a view|the strip is|the sky settles sustained`);
config.testMatch = [...config.testMatch as string[], '**/inspector-tabs.spec.ts', '**/sky.spec.ts', '**/extensions-development.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions development`);
config.testMatch = [...config.testMatch as string[], '**/extensions-storage.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions storage`);
config.testMatch = [...config.testMatch as string[], '**/extensions-jobs.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions jobs`);
config.testMatch = [...config.testMatch as string[], '**/extensions-connections.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions connections`);
config.testMatch = [...config.testMatch as string[], '**/extensions-services.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions services`);
config.testMatch = [...config.testMatch as string[], '**/extensions-views.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions views`);
config.testMatch = [...config.testMatch as string[], '**/extensions-rich-views.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions rich views`);
config.testMatch = [...config.testMatch as string[], '**/extensions-placement.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions placement`);
config.testMatch = [...config.testMatch as string[], '**/extensions-appearance.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions appearance`);
config.testMatch = [...config.testMatch as string[], '**/extensions-replacement.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-documents-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-content-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-tools-coverage.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions tools`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions content`);
config.testMatch = [...config.testMatch as string[], '**/extensions-diff-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-search-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-browser-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-simulator-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-vm-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-design-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-btw-coverage.spec.ts', '**/btw.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-board-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-github-hub-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-pull-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-worktrees-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-moodboards-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-cloud-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-machine-coverage.spec.ts'];
config.testMatch = [...config.testMatch as string[], '**/extensions-workspace-coverage.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Workspace audit:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Machines extension:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Cloud extension:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Moodboard extension:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Worktree extension:`);
config.testMatch = [...config.testMatch as string[], '**/extensions-settings-coverage.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Settings extension:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|Pull extension:|a linked open pull request merges|a pull request the agent opens`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|GitHub hub extension:|lists repositories|Solve starts a linked thread|a thread starts from the Threads tab|typing survives the view|repositories not pushed|Actions show each run|a run expands|a run.s jobs show|Check workflow files|when gh fails`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|board:|the sidebar view menu|board cards say`);
config.testMatch = [...config.testMatch as string[], '**/sidebar-sections.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|sidebar sections|every row keeps one indicator|rows sit on the section card`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|btw:|side thread|side prompt|side panel|queued side|/btw|the final answer stays visible`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|design:|Design canvas`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|vm:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|simulator:`);
config.testMatch = [...config.testMatch as string[], '**/extensions-terminal-coverage.spec.ts', '**/terminal.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|terminal`);
config.testMatch = [...config.testMatch as string[], '**/search-panel.spec.ts', '**/inspector-tabs.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|search:|search lists matching|toggles reach the backend|the panel opens on Changes|the tab strip runs|inspector strip attaches|the inspector opens on a single|menu lists closed views|tabs select on click|the open tabs and the selected|opening a view from elsewhere|the strip is one tablist`);
config.testMatch = [...config.testMatch as string[], '**/changes-view.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|stacks every changed file|loads the first eight|update keeps unchanged diffs|narrow panels keep trailing|collapses per file|scope menu filters|menus stage, unstage|inline commit bar|shows clean, not-a-repo|passes truncation`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|diff:`);
config.testMatch = [...config.testMatch as string[], '**/document-viewer.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|renders Markdown as a reader|renders README HTML|shows code with line numbers`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|documents:`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions replacement`);
config.testMatch = [...config.testMatch as string[], '**/extensions-composer-conformance.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions composer`);
config.testMatch = [...config.testMatch as string[], '**/extensions-transcript-conformance.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions transcript`);
config.testMatch = [...config.testMatch as string[], '**/extensions-provider-history.spec.ts'];
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions provider history`);
config.grep = new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions harness`);
config.testMatch = [...config.testMatch as string[], '**/extensions-harness.spec.ts'];
export default defineConfig(config, {
  testMatch: [...config.testMatch as string[], '**/extensions-trust.spec.ts', ...(process.platform === 'win32' && process.arch === 'x64' ? ['**/extensions-runtime.spec.ts'] : []), '**/extensions-project-reads.spec.ts', '**/extensions-inventory.spec.ts', '**/extensions-context.spec.ts', '**/extensions-baseline.spec.ts', '**/extensions-install.spec.ts', '**/extensions-catalog.spec.ts', '**/extensions-layout.spec.ts', '**/extensions-menus.spec.ts', '**/extensions-dialogs.spec.ts', '**/extensions-view-actions.spec.ts', '**/extensions-thread-actions.spec.ts', '**/extensions-settings-actions.spec.ts', '**/extensions-windows.spec.ts', '**/tray-popover.spec.ts', '**/agents-dock.spec.ts', '**/generative-ui.spec.ts'],
  grep: new RegExp(`${config.grep instanceof RegExp ? config.grep.source : ''}|extensions project reads|extensions inventory|extensions context|extensions baseline|extensions install|extensions catalog|extensions layout|extensions menus|extensions dialogs|extensions view actions|extensions thread actions|extensions settings actions|extensions windows|menu bar popover|the widget stays|running agents widget|Escape closes the header popover|the working ring|the pinned window|toggling the widget setting|overlay copies live Markdown|streamed markdown|a table sorts|buttons and forms|custom views|invalid specs|stats, tree|details collapse|Antigravity installation|resource usage lives|the command palette|Model routing is its|settings open on Recommended|settings deep links`),
});
