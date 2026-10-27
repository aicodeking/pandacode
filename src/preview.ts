import { previewHub, previewRepos } from './preview-github-hub';
import type { AgentEvent, BrowserStatus, FileEntry, GitStatus, Message, MessagePage, Project, Provider, ProviderId, ProviderModel, Session, TaskStage, ToolActivity } from './types';
import { fallbackModel } from './model-catalog';
import { historicalProvider } from './provider-handoff';
import { isPreviewableFile } from './file-links';
import type { CommandPanel, GoalState } from './command-center';
import { createPreviewArchitect } from './preview-architect';
import type { TeamSnapshot, TeamWorker } from './architect-types';
import { createPreviewCloud, createPreviewVm } from './preview-vm';
import { createPreviewTurnChanges } from './preview-turn-changes';
// Bundled with the preview, not lazily imported: a late module load during a paused test clock stalled startup.
import { invokeBots, previewBotBusy } from './preview-bots';
import { invokeRemote, previewRemoteStart } from './preview-remote';
import { createPreviewDesign } from './preview-design';
import { BRIEF_ID, GALLERY_ID, briefAnswer, briefMessages, briefTimings, briefTools, galleryMessages } from './preview-traces';
import { createPreviewSkills } from './preview-skills';
import { previewCapabilities } from './preview-capabilities';
import { recipesCommand } from './preview-recipes';
import { openCodePreviewKey, openCodePreviewModels, previewOpenCodeChoices, previewOpenCodeSelection } from './preview-opencode';
const turnChanges = createPreviewTurnChanges();
const now = Date.now();
const sampleReadme = '<div align="center">\n\n<img src="docs/banner.png" alt="Orbit banner" width="100%" onerror="alert(1)"/>\n\n[![Build](https://img.shields.io/badge/build-passing-green)](https://example.com/ci)\n\n<script>alert(1)</script>\n\n<a href="https://example.com/x" download class="toast">Get</a>\n\n</div>\n\n# Orbit\n\nA tiny search index for the browser preview.\n\n## Usage\n\n- Build the index with `createSearchIndex`.\n- Call `search(query)`.\n\n> Results are case-insensitive.\n';
const sampleSource = '// Browser preview — sample source\nexport function createSearchIndex(items) {\n  return {\n    search(query) {\n      return items.filter(item =>\n        item.title.toLowerCase().includes(query.toLowerCase())\n      );\n    }\n  };\n}\n';
const previewWorkspaceFiles = ['index.html', '.gitignore', 'README.md', 'package.json', 'tsconfig.json', 'src/main.ts', 'src/style.css', 'src/components/search.ts', 'src/components/search.test.ts', 'src/lib/search-index.ts', 'public/favicon.svg', 'docs/design notes.md'];
const sampleTestOutput = 'PASS src/components/search.test.ts\n  ✓ filters results as the query changes\n  ✓ preserves keyboard selection\n\nTests: 12 passed, 12 total\nTime: 0.8s\nSample output — no command was executed.';
function encodeTool(tool: ToolActivity): string { return JSON.stringify({ type: 'tool_activity', version: 1, ...tool }); }
let projects: Project[] = [{ id: 'project-1', name: 'orbit', path: '/Users/you/Projects/orbit' }, { id: 'project-2', name: 'pandacode', path: '/Users/you/Projects/pandacode' }];
let sessions: Session[] = [
  { id: 'session-1', projectId: 'project-1', title: 'Make search feel instant', provider: 'claude', model: 'sonnet', mode: 'ask', status: 'idle', createdAt: now - 420000, updatedAt: now, archived: false, worktreePath: null, resumeId: 'preview-session', lastResponseAt: now - 300000 },
  { id: 'session-2', projectId: 'project-1', title: 'Refine the navigation', provider: 'codex', model: '', mode: 'ask', status: 'idle', createdAt: now - 8200000, updatedAt: now - 8000000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: null },
  { id: 'session-3', projectId: 'project-1', title: 'Add keyboard shortcuts', provider: 'kimi', model: '', mode: 'ask', status: 'idle', createdAt: now - 86400000, updatedAt: now - 86400000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: null },
  { id: 'session-4', projectId: 'project-2', title: 'Explore the project', provider: 'codex', model: '', mode: 'ask', status: 'idle', createdAt: now - 345600000, updatedAt: now - 172800000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: now - 259200000 },
];
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('trace')) sessions = [...sessions, { id: 'session-5', projectId: 'project-1', title: 'Polish the trace view', provider: 'claude', model: 'sonnet', mode: 'ask', status: 'idle', createdAt: now - 60000, updatedAt: now + 1000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: now }];
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('trace')) sessions = [...sessions,
  { id: BRIEF_ID, projectId: 'project-1', title: 'Morning brief', provider: 'claude', model: 'sonnet', mode: 'ask', status: 'idle', createdAt: now - 50000, updatedAt: now + 2000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: null },
  { id: GALLERY_ID, projectId: 'project-1', title: 'Tool gallery', provider: 'claude', model: 'sonnet', mode: 'ask', status: 'idle', createdAt: now - 40000, updatedAt: now + 3000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: now - 100000 }];
// The preview persists sidebar preferences only, never sample conversation data.
const THREAD_ORDER_KEY = 'pandacode.preview.threadOrder';
type ThreadOrder = { id: string; pinned: boolean; sidebarOrder: number | null };
function loadThreadOrder(): void {
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(THREAD_ORDER_KEY) ?? '[]'); } catch { return; }
  if (!Array.isArray(saved)) return;
  for (const entry of saved) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.pinned !== 'boolean'
      || entry.sidebarOrder !== null && (!Number.isSafeInteger(entry.sidebarOrder) || entry.sidebarOrder < 0)) continue;
    const task = sessions.find(task => task.id === entry.id);
    if (task) { task.pinned = entry.pinned; task.sidebarOrder = entry.sidebarOrder; }
  }
}
function saveThreadOrder(order: ThreadOrder[]): void {
  // Write before applying, so storage failures do not leave an unsaved UI order.
  localStorage.setItem(THREAD_ORDER_KEY, JSON.stringify(order));
  const saved = new Map(order.map(entry => [entry.id, entry]));
  for (const task of sessions) {
    const entry = saved.get(task.id);
    if (entry) { task.pinned = entry.pinned; task.sidebarOrder = entry.sidebarOrder; }
  }
}
function threadOrder(task: Session): ThreadOrder { return { id: task.id, pinned: Boolean(task.pinned), sidebarOrder: task.sidebarOrder ?? null }; }
function compareThreadOrder(a: Session, b: Session): number {
  const activity = (task: Session) => task.lastPromptAt == null ? task.lastResponseAt ?? task.createdAt : Math.max(task.lastPromptAt, task.lastResponseAt ?? 0);
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || (a.sidebarOrder ?? Number.MAX_SAFE_INTEGER) - (b.sidebarOrder ?? Number.MAX_SAFE_INTEGER)
    || activity(b) - activity(a) || a.id.localeCompare(b.id);
}
for (const s of sessions) {
  s.pinned = false;
  s.sidebarOrder = null;
  s.taskStage = s.lastResponseAt ? 'review' : 'pending';
  s.taskDescription = '';
  s.completedAt = null;
}
// One sample task already tracks a GitHub issue so chips have something to show.
sessions[2].issue = { kind: 'issue', number: 131, url: 'https://github.com/orbit-labs/orbit/issues/131', title: 'Keyboard shortcut cheat sheet', state: 'open', checkedAt: now };
// Sidebar sections showcase: opt in with ?sections so default session counts stay unchanged.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('sections')) {
  const sample = (id: string, projectId: string, title: string, extra: Partial<Session>): Session => ({ id, projectId, title, provider: 'claude', model: 'sonnet', mode: 'ask', status: 'idle', createdAt: now - 7200000, updatedAt: now - 60000, archived: false, worktreePath: null, resumeId: null, lastResponseAt: null, pinned: false, sidebarOrder: null, taskStage: 'review', taskDescription: '', completedAt: null, ...extra });
  sessions.push(
    sample('sections-running', 'project-1', 'Speed up the search index', { status: 'running', taskStage: 'in_progress', lastPromptAt: now - 95000 }),
    sample('sections-approval', 'project-2', 'Migrate settings storage', { provider: 'codex', model: '', status: 'waiting_approval', taskStage: 'in_progress', lastPromptAt: now - 240000 }),
    sample('sections-review-1', 'project-1', 'Fix the flaky filter test', { lastPromptAt: now - 1500000, lastResponseAt: now - 1200000 }),
    sample('sections-review-2', 'project-2', 'Write the release notes', { provider: 'codex', model: '', lastPromptAt: now - 11000000, lastResponseAt: now - 10800000 }),
    sample('sections-done-1', 'project-1', 'Add dark mode tokens', { taskStage: 'completed', lastResponseAt: now - 90000000, completedAt: now - 86000000 }),
    sample('sections-done-2', 'project-2', 'Remove the old onboarding', { taskStage: 'completed', lastResponseAt: now - 200000000, completedAt: now - 190000000 }),
    sample('sections-done-3', 'project-1', 'Document the keyboard map', { provider: 'kimi', model: '', taskStage: 'completed', lastResponseAt: now - 300000000, completedAt: now - 290000000 }),
    // Needs you without running: a failed run you have not seen, and a usage limit.
    sample('sections-failed', 'project-2', 'Upgrade the build toolchain', { status: 'error', lastPromptAt: now - 900000, lastResponseAt: now - 600000 }),
    sample('sections-limited', 'project-1', 'Profile startup time', { lastPromptAt: now - 1800000, lastResponseAt: now - 1700000, limitedAt: now - 1700000, limitedUntil: now + 3600000 }),
    sample('sections-pinned', 'project-1', 'Release checklist for 1.0', { pinned: true, sidebarOrder: 0, lastResponseAt: now - 432000000 }),
    // A long title on a worktree branch with a linked pull request.
    sample('sections-long', 'project-2', 'Redesign the sidebar rows so long titles, branches and pull requests all fit on one line', { worktreePath: '/Users/you/Projects/pandacode-worktrees/sidebar', worktreeBranch: 'pandacode/sidebar-redesign-compact-rows', pullRequest: { kind: 'pull', number: 482, url: 'https://github.com/aicodeking/pandacode/pull/482', title: 'Compact sidebar rows', state: 'open', checkedAt: now }, lastPromptAt: now - 172000000, lastResponseAt: now - 170000000 }),
    sample('sections-chat', 'sections-chat-project', 'Explain the borrow checker', { lastPromptAt: now - 7000000, lastResponseAt: now - 6900000 }),
    ...['Compare two date libraries', 'Draft a short changelog', 'Name the new CLI flag'].map((title, index) => sample(`sections-chat-${index + 2}`, 'sections-chat-project', title, { lastPromptAt: now - 9000000 - index * 3600000, lastResponseAt: now - 8900000 - index * 3600000 })),
    // Enough threads for "Show more" in a folder and paging in Completed.
    ...['Tidy the logger', 'Rename the config keys', 'Split the router', 'Cache the icon lookups', 'Drop the legacy flag', 'Add a retry to uploads', 'Trim the bundle'].map((title, index) => sample(`sections-many-${index}`, 'project-1', title, { lastResponseAt: now - 200000000 - index * 9000000 })),
    ...['Pin the Node version', 'Fix the tooltip offset', 'Translate the menus', 'Audit the CSP', 'Retire the old icons', 'Speed up cold start', 'Archive old logs', 'Bump the parser', 'Clean the fixtures'].map((title, index) => sample(`sections-old-${index}`, index % 2 ? 'project-2' : 'project-1', title, { taskStage: 'completed', lastResponseAt: now - 310000000 - index * 30000000, completedAt: now - 300000000 - index * 30000000 })),
  );
  projects.push({ id: 'sections-chat-project', name: 'Chat', path: '/Users/you/PandaCode Chats/chat-5ec7105a' });
  // These finished while another thread was open, so they wait in Needs review (or Active, if they failed).
  localStorage.setItem('pandacode.sidebar.unreviewed', JSON.stringify(['sections-review-1', 'sections-review-2', 'sections-failed']));
}
// Saved pins and ranks apply to every sample, the ?sections ones included.
loadThreadOrder();
let id = 10;
const ROUTING_KEY = 'pandacode.preview.routing';
let previewRouting = { enabled: true, mode: 'cheapest', minP: 0.8, profiler: 'missing', error: null as string | null };
try { previewRouting = { ...previewRouting, ...JSON.parse(localStorage.getItem(ROUTING_KEY) ?? '{}') }; } catch { /* Defaults. */ }
const saveRouting = () => { try { localStorage.setItem(ROUTING_KEY, JSON.stringify(previewRouting)); } catch { /* Kept in memory only. */ } };
/** Deterministic stand-in for Panda Router: longer text reads as harder, later pool entries as pricier and stronger. */
function previewRoute(text: string, pool: { provider: string; model: string; name: string }[]) {
  const difficulty = Math.min(0.95, 0.2 + text.length / 400);
  const rated = pool.map((m, i) => ({ provider: m.provider, model: m.model, name: m.name, cardId: `${m.provider}:${m.model}`, pSuccess: Math.max(0.05, Math.min(0.99, 0.95 - difficulty * 0.6 + (i % 7) * 0.05)), estCostUsd: 0.002 * (1 + (i % 9)), estLatencyMs: 2000 + i * 100 }));
  const score = (m: typeof rated[number]) => previewRouting.mode === 'quality' ? m.pSuccess : previewRouting.mode === 'cheapest' ? (m.pSuccess >= previewRouting.minP ? 1 - m.estCostUsd : -1) : m.pSuccess - m.estCostUsd * 5;
  const ranking = [...rated].sort((a, b) => score(b) - score(a));
  return { pick: ranking[0] ?? null, ranking, unrated: [], difficulty: Math.max(1, Math.round(difficulty * 10)), category: /test|bug|fix/i.test(text) ? 'debugging' : 'general coding', profiler: 'onnx', latencyMs: 12 };
}
let previewClaudeMode: 'inherit' | 'subscription' = 'inherit';
const traceRoot = '/Users/you/Projects/orbit';
const traceIndex = `${traceRoot}/src/lib/search-index.ts`;
const traceJson = (value: unknown) => JSON.stringify(value, null, 2);
const traceTools: Omit<ToolActivity, 'id'>[] = [
  { name: 'Bash', status: 'completed', input: traceJson({ command: 'rg -n createSearchIndex src', description: 'Find index usage' }), output: 'src/components/search.ts:3:import { createSearchIndex } from "../lib/search-index";\nsrc/components/search.ts:11:const index = createSearchIndex(items);\nsrc/lib/search-index.ts:5:export function createSearchIndex(items: Item[]) {\nSample output — no command was executed.' },
  { name: 'Read', status: 'completed', input: traceJson({ file_path: traceIndex }), output: 'import type { Item } from "./types";\n\nexport interface SearchIndex {\n  search(query: string): Item[];\n}\n\nexport function createSearchIndex(items: Item[]): SearchIndex {\n  return {\n    search(query) {\n      return items.filter(item =>\n        item.title.toLowerCase().includes(query.toLowerCase())\n      );\n    }\n  };\n}' },
  { name: 'Grep', status: 'completed', input: traceJson({ pattern: 'toLowerCase', path: 'src' }), output: 'src/components/search.ts\nsrc/lib/search-index.ts\nsrc/lib/sort.ts\nsrc/components/filter.ts' },
  { name: 'Glob', status: 'completed', input: traceJson({ pattern: 'src/**/*.test.ts' }), output: 'src/components/search.test.ts\nsrc/lib/search-index.test.ts' },
  { name: 'Edit', status: 'completed', input: traceJson({ file_path: traceIndex, old_string: '    search(query) {\n      return items.filter(item =>\n        item.title.toLowerCase().includes(query.toLowerCase())', new_string: '    search(query) {\n      const needle = normalize(query);\n      return items.filter(item =>\n        normalize(item.title).includes(needle)' }), output: `The file ${traceIndex} has been updated successfully.` },
  { name: 'Write', status: 'completed', input: traceJson({ file_path: `${traceRoot}/src/lib/normalize.ts`, content: '// Case- and accent-insensitive comparison key.\nexport function normalize(text: string): string {\n  return text\n    .normalize("NFKD")\n    .replace(/\\p{M}/gu, "")\n    .toLowerCase();\n}\n' }), output: `File created successfully at: ${traceRoot}/src/lib/normalize.ts` },
  { name: 'WebSearch', status: 'completed', input: traceJson({ query: 'unicode case folding javascript' }), output: 'Web search results for query: "unicode case folding javascript"\n\nLinks: ' + JSON.stringify([{ title: 'String.prototype.toLowerCase() - JavaScript | MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/toLowerCase' }, { title: 'Unicode Case Folding', url: 'https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt' }, { title: 'Case folding in JavaScript — Stack Overflow', url: 'https://stackoverflow.com/questions/1695233/case-folding-javascript' }, { title: 'String.prototype.normalize() - MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize' }]) },
  { name: 'WebFetch', status: 'completed', input: traceJson({ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare', prompt: 'Does localeCompare support case-insensitive comparison?' }), output: 'Yes. Pass `{ sensitivity: "base" }` (or "accent") as the options argument and localeCompare ignores case differences.' },
  { name: 'TodoWrite', status: 'completed', input: traceJson({ todos: [{ content: 'Normalize queries and titles', status: 'completed', activeForm: 'Normalizing queries and titles' }, { content: 'Run the test suite', status: 'in_progress', activeForm: 'Running the test suite' }, { content: 'Update the README usage notes', status: 'pending', activeForm: 'Updating the README' }] }), output: 'Todos have been modified successfully.' },
  { name: 'Command', status: 'completed', input: `/bin/zsh -lc "npm test"\nWorking directory: ${traceRoot}`, output: `Exit code: 0\n${sampleTestOutput}` },
  { name: 'Bash', status: 'failed', input: traceJson({ command: 'npm run lint -- src/lib', description: 'Lint the library folder' }), output: 'src/lib/normalize.ts\n  3:10  error  Unicode property escapes need the "u" flag  regexp/require-unicode-regexp\n\n1 error found\nnpm ERR! Lifecycle script `lint` failed with exit code 1\nExit code: 1\nSample output — no command was executed.' },
  { name: 'mcp__github__list_pull_requests', status: 'completed', input: traceJson({ owner: 'orbit-labs', repo: 'orbit', state: 'open' }), output: traceJson([{ number: 142, title: 'Faster search index', state: 'open' }, { number: 139, title: 'Keyboard cheat sheet', state: 'open' }]) },
];
const traceMessages: Message[] = [
  { id: 101, sessionId: 'session-5', role: 'user', content: 'Make search ignore case and accents, then check the tests.', createdAt: now - 604800000 },
  { id: 102, sessionId: 'session-5', role: 'assistant', content: 'I’ll find where the index is used, normalize both sides of the comparison, and run the tests.', createdAt: now - 604790000 },
  ...traceTools.map((tool, i): Message => ({ id: 110 + i, sessionId: 'session-5', role: 'tool', content: encodeTool({ id: `trace-tool-${i}`, ...tool }), createdAt: now - 604780000 + i * 1000 })),
  { id: 130, sessionId: 'session-5', role: 'assistant', content: 'Search now compares a normalized form of the query and each title, so case and accents no longer matter.\n\n- Added `normalize()` in `src/lib/normalize.ts`.\n- The tests pass; lint flags the new regex and needs the `u` flag follow-up.', createdAt: now - 604000000 },
];
// Trace showcase thread: opt in with ?trace so default session counts stay unchanged.
const showTrace = typeof location !== 'undefined' && new URLSearchParams(location.search).has('trace');
const messages: Record<string, Message[]> = { ...(showTrace ? { 'session-5': traceMessages, [BRIEF_ID]: briefMessages, [GALLERY_ID]: galleryMessages } : {}), 'session-1': [
  { id: 1, sessionId: 'session-1', role: 'user', content: 'Search feels a little slow. Can you make it respond instantly as I type, and keep the keyboard navigation working?', createdAt: now - 420000 },
  { id: 2, sessionId: 'session-1', role: 'assistant', content: 'I’ll trace how the search input updates the results, then check the keyboard interactions.', createdAt: now - 410000 },
  { id: 3, sessionId: 'session-1', role: 'tool', content: encodeTool({ id: 'sample-read', name: 'Read', status: 'completed', input: 'src/components/search.ts', output: sampleSource }), createdAt: now - 400000 },
  { id: 4, sessionId: 'session-1', role: 'assistant', content: 'The input was rebuilding the search index on every keystroke. I moved the index outside the input handler and limited rendering to the visible results.\n\n### What changed\n\n- **One index per dataset.** Reused across queries, refreshed when the data changes.\n- **Immediate feedback.** Results update locally as you type.\n- **Keyboard navigation preserved.** ↑ and ↓ move through results; Enter opens the selection.\n\n```ts\nconst index = createSearchIndex(items);\n\ninput.addEventListener("input", () => {\n  renderResults(index.search(input.value));\n});\n```\n\nThe changes are ready to review in the panel on the right.', createdAt: now - 300000 },
  { id: 5, sessionId: 'session-1', role: 'tool', content: encodeTool({ id: 'sample-bash', name: 'Bash', status: 'completed', input: 'npm test -- --runInBand', output: sampleTestOutput }), createdAt: now - 290000 },
  { id: 7, sessionId: 'session-1', role: 'tool', content: 'Legacy tool report\nOlder saved output remains readable.', createdAt: now - 280000 },
  { id: 8, sessionId: 'session-1', role: 'tool', content: 'Tool finished', createdAt: now - 270000 },
], 'session-4': [{ id: 6, sessionId: 'session-4', role: 'assistant', content: 'The project is a small native workspace for coding agents.', createdAt: now - 259200000 }] };
const providers: Provider[] = [
  { id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample provider', models: ['sonnet', 'opus', 'haiku'].map(id => fallbackModel('claude', id)) },
  { id: 'codex', name: 'Codex', installed: true, path: '/sample/bin/codex', version: 'Sample provider', models: [] },
  { id: 'kimi', name: 'Kimi Code', installed: true, path: '/sample/bin/kimi', version: 'Sample provider', models: [] },
  { id: 'opencode', name: 'OpenCode', installed: true, path: '/sample/bin/opencode', version: 'Sample provider', models: [] },
  { id: 'glm', name: 'GLM Coding Plan', installed: true, path: '/sample/bin/claude', version: 'Sample provider', models: [] },
  { id: 'antigravity', name: 'Antigravity', installed: false, path: null, version: '', models: [] },
  { id: 'grok', name: 'Grok Build', installed: true, path: '/sample/bin/grok', version: 'grok 1.0.40 (sample)', models: [] },
  { id: 'mimo', name: 'MiMo Token Plan', installed: true, path: '/sample/bin/claude', version: 'Sample provider', models: [] },
  { id: 'pi', name: 'Pi', installed: true, path: '/sample/bin/pi', version: 'Sample provider', models: [] },
  { id: 'deepseek', name: 'DeepSeek', installed: true, path: '/sample/bin/dsh', version: 'Sample provider', models: [] },
  { id: 'commandcode', name: 'Command Code', installed: true, path: '/sample/bin/command-code', version: '1.87.1 (sample)', models: [] },
  { id: 'cline', name: 'Cline', installed: true, path: '/sample/bin/cline', version: '3.0.73 (sample)', models: [] },
  { id: 'kilo', name: 'Kilo Code', installed: true, path: '/sample/bin/kilo', version: '7.3.41 (sample)', models: [] },
  { id: 'omp', name: 'Oh My Pi', installed: false, path: null, version: '', models: [] },
  { id: 'github-copilot', name: 'GitHub Copilot CLI', installed: true, path: '/sample/bin/copilot', version: 'GitHub Copilot CLI 1.0.82 (sample)', models: [] },
  { id: 'muse', name: 'Muse Code', installed: true, path: '/sample/bin/muse', version: 'Muse Code 1.4.7 (sample)', models: [] },
  { id: 'devin', name: 'Devin CLI', installed: true, path: '/sample/bin/devin', version: 'devin 3000.11.216 (sample)', models: [] },
];
// Mirrors providers::mimo::ENDPOINTS; the native side is the authority.
const previewMimoEndpoints = [
  { id: 'token-plan-cn', url: 'https://token-plan-cn.xiaomimimo.com/anthropic', label: 'Token Plan · China cluster' },
  { id: 'token-plan-sgp', url: 'https://token-plan-sgp.xiaomimimo.com/anthropic', label: 'Token Plan · Singapore cluster' },
  { id: 'token-plan-ams', url: 'https://token-plan-ams.xiaomimimo.com/anthropic', label: 'Token Plan · Europe cluster' },
  { id: 'api', url: 'https://api.xiaomimimo.com/anthropic', label: 'Pay-as-you-go API' },
];
let previewMimoEndpoint: string | null = null;
/** Named connections; secret values are dropped, only their names are kept, as on the native side. */
let previewConnections: import('./connections').ConnectionSnapshot = { connections: [], tasks: {} };
function previewSaveConnection(input: { id?: string | null; provider: ProviderId; name: string; executable?: string | null; args?: string[]; env?: { name: string; value: string | null; secret: boolean }[]; configDir?: string | null }): import('./connections').ConnectionSnapshot {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw new Error('Give the connection a name of up to 60 characters.');
  if ((input.args ?? []).length > 32 || (input.args ?? []).some(arg => arg.includes('\0'))) throw new Error('Launch arguments must be non-empty, under 1024 characters and contain no NUL.');
  const existing = previewConnections.connections.find(c => c.id === input.id);
  if (input.id && !existing) throw new Error('This connection no longer exists.');
  const env = input.env ?? [];
  const next = { id: existing?.id ?? `connection-${Date.now().toString(36)}`, provider: existing?.provider ?? input.provider, name, executable: input.executable || null, args: input.args ?? [], env: Object.fromEntries(env.filter(v => !v.secret).map(v => [v.name, v.value ?? ''])), secretEnv: env.filter(v => v.secret).map(v => v.name), configDir: input.configDir || null, revision: (existing?.revision ?? 0) + 1 };
  const connections = existing ? previewConnections.connections.map(c => c.id === next.id ? next : c) : [...previewConnections.connections, next];
  previewConnections = { ...previewConnections, connections };
  return previewConnections;
}
// Representative catalog fixtures only; the native app queries installed harnesses.
/** Another computer's smaller catalog (PandaCode Connect). */
const remoteProviders = (): Provider[] => ['claude', 'codex'].map(id => providers.find(p => p.id === id)!).map(p => ({ ...p, models: remoteCatalog(p.id) }));
function remoteCatalog(id: ProviderId): ProviderModel[] {
  if (id === 'claude') return ['sonnet', 'opus'].map(model => fallbackModel('claude', model));
  return id === 'codex' ? ['gpt-5-codex', 'gpt-5'].map(model => fallbackModel('codex', model)) : [];
}
const catalogs: Record<ProviderId, ProviderModel[]> = {
  // Recorded from `kilo acp` 7.3.41; efforts belong to its current model only.
  kilo: [
    { id: 'kilo/stealth/claude-sonnet-4.6', name: 'Kilo Gateway/Stealth: Claude Sonnet 4.6 (20% off)', description: '', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, name: id, description: '' })), defaultReasoningEffort: 'none' },
    { id: 'kilo/anthropic/claude-sonnet-4.6', name: 'Kilo Gateway/Anthropic: Claude Sonnet 4.6', description: '' },
  ],
  pi: [{ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Sample Pi model.', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }], contextWindow: 200000 }],
  omp: [{ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Sample omp model.', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }], contextWindow: 200000 }],
  deepseek: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast, low-cost default.', reasoningEfforts: [{ id: 'off', name: 'Off', description: 'No extended reasoning.' }, { id: 'low', name: 'Low', description: 'Light reasoning.' }, { id: 'high', name: 'High', description: 'Thorough reasoning. Recommended.' }, { id: 'max', name: 'Max', description: 'Maximum reasoning for the hardest tasks.' }], defaultReasoningEffort: 'high', contextWindow: 1000000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Strongest DeepSeek model.', reasoningEfforts: [{ id: 'off', name: 'Off', description: 'No extended reasoning.' }, { id: 'low', name: 'Low', description: 'Light reasoning.' }, { id: 'high', name: 'High', description: 'Thorough reasoning. Recommended.' }, { id: 'max', name: 'Max', description: 'Maximum reasoning for the hardest tasks.' }], defaultReasoningEffort: 'high', contextWindow: 1000000 },
    { id: 'deepseek-v41-flash', name: 'DeepSeek V41 Flash', description: 'Updated Flash model.', reasoningEfforts: [{ id: 'off', name: 'Off', description: 'No extended reasoning.' }, { id: 'low', name: 'Low', description: 'Light reasoning.' }, { id: 'high', name: 'High', description: 'Thorough reasoning. Recommended.' }, { id: 'max', name: 'Max', description: 'Maximum reasoning for the hardest tasks.' }], defaultReasoningEffort: 'high', contextWindow: 1000000 },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', description: 'Experimental image input.', reasoningEfforts: [{ id: 'off', name: 'Off', description: 'No extended reasoning.' }, { id: 'low', name: 'Low', description: 'Light reasoning.' }, { id: 'high', name: 'High', description: 'Thorough reasoning. Recommended.' }, { id: 'max', name: 'Max', description: 'Maximum reasoning for the hardest tasks.' }], defaultReasoningEffort: 'high', contextWindow: 1000000 },
  ],
  commandcode: [
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: 'fast hybrid-attention reasoning', reasoningEfforts: [{ id: 'off', name: 'Off', description: '' }, { id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }, { id: 'max', name: 'Max', description: '' }], defaultReasoningEffort: 'max' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', description: 'best combo of speed & intelligence (recommended)' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'most efficient OpenAI model for focused, high-volume tasks' },
    { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', description: 'long-horizon coding & knowledge work with 1M context' },
  ],
  // Recorded from `cline --acp` 3.0.73; efforts are its --thinking levels.
  cline: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-6-sol'].map((id, index) => ({ id, name: ['Claude Sonnet 5.5', 'Claude Opus 5.5', 'GPT-6 Sol'][index], description: '', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'].map(effort => ({ id: effort, name: effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1), description: '' })) })),
  'github-copilot': [{ id: 'default', name: 'Default', description: 'Use the model configured in GitHub Copilot CLI.' }],
  // Recorded from `devin acp` 3000.11.216: each model lists its own thinking levels.
  devin: ([
    ['adaptive', 'Adaptive', [], ''], ['swe-2-high', 'SWE-2', ['medium', 'high', 'max'], 'high'],
    ['claude-opus-5-5-medium', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6-sol-medium', 'GPT-6 Sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['glm-5-2', 'GLM-5.2 High', ['none', 'high', 'max'], 'high'],
    ['fusion-claude-opus-5-5-medium-sidekick-swe-2-medium', 'Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ] as [string, string, string[], string][]).map(([id, name, efforts, effort]) => ({ id, name, description: id === 'glm-5-2' ? 'Text only' : '', reasoningEfforts: efforts.map(value => ({ id: value, name: value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1), description: '' })), ...(effort ? { defaultReasoningEffort: effort } : {}) })),
  muse: ['muse-wonder-1.0', 'muse-spark-1.3'].map(id => ({ id, name: id, description: '', reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ id: effort, name: effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1), description: '' })), defaultReasoningEffort: 'high', contextWindow: 1007997 })),
  opencode: openCodePreviewModels,
  glm: [
    { id: 'glm-5.3', name: 'GLM-5.3', description: 'Current flagship. Availability depends on your plan.' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', description: 'Fast, low-cost tier. Availability depends on your plan.' },
    { id: 'glm-5.3[1m]', name: 'GLM-5.3 · 1M context', description: 'Flagship with the extended 1M-token context window. Availability depends on your plan.' },
    { id: 'glm-5.3-flash[1m]', name: 'GLM-5.3-Flash · 1M context', description: 'Fast tier with the extended 1M-token context window. Availability depends on your plan.' },
    { id: 'glm-5-turbo', name: 'GLM-5-Turbo', description: 'Fast general-purpose model. Availability depends on your plan.' },
  ],
  mimo: [
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', description: 'Flagship. Token Plan and pay-as-you-go. Availability depends on your plan.' },
    { id: 'mimo-v2.6-pro[1m]', name: 'MiMo-V2.6-Pro · 1M context', description: 'Flagship with the extended 1M-token context window. Availability depends on your plan.' },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', description: 'Fast and a third of Pro\'s credit cost. Availability depends on your plan.' },
  ],
  antigravity: [{ id: 'default', name: 'Server default', description: 'Connect the Antigravity ACP server to load models.' }],
  claude: [
    { id: 'sonnet', name: 'Claude Sonnet 5', description: 'Sample Claude Code model metadata.', reasoningEfforts: ['low', 'medium', 'high'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), description: `Sample ${id} effort.` })), defaultReasoningEffort: 'medium', contextWindow: 200000 },
    { id: 'opus', name: 'Claude Opus 5', description: 'Sample Claude Code model metadata.', reasoningEfforts: ['low', 'medium', 'high', 'max'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), description: `Sample ${id} effort.` })), contextWindow: 1000000 },
    { id: 'haiku', name: 'Claude Haiku 4.5', description: 'Sample Claude Code model metadata.', contextWindow: 200000 },
  ],
  codex: [
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Sample Codex model metadata.', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, name: id === 'xhigh' ? 'Extra high' : id[0].toUpperCase() + id.slice(1), description: `Sample ${id} effort.` })), defaultReasoningEffort: 'medium', contextWindow: 400000 },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Sample Codex model metadata.', reasoningEfforts: ['low', 'medium', 'high'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), description: `Sample ${id} effort.` })) },
  ],
  kimi: [{ id: 'kimi-code/k3', name: 'K3', description: 'Sample configured Kimi model.', reasoningEfforts: [{ id: 'on', name: 'On', description: 'Enable thinking.' }, { id: 'off', name: 'Off', description: 'Disable thinking.' }], contextWindow: 256000 }],
  // Mirrors the initialize modelState that `grok agent stdio` advertises.
  grok: [
    { id: 'grok-4.7', name: 'Grok 4.7', description: 'Frontier model for agentic coding.', reasoningEfforts: [{ id: 'low', name: 'Low', description: 'Fastest responses. Best for simple tasks.' }, { id: 'medium', name: 'Medium', description: 'Strong quality with a faster turnaround.' }, { id: 'high', name: 'High', description: 'Thorough reasoning and quality. Recommended.' }, { id: 'xhigh', name: 'Extra High', description: 'Maximum reasoning for the hardest tasks.' }], defaultReasoningEffort: 'high', contextWindow: 500000 },
    { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', description: 'Fast variant. 2x the price.', reasoningEfforts: [{ id: 'low', name: 'Low', description: 'Fastest responses.' }, { id: 'high', name: 'High', description: 'Thorough reasoning and quality.' }], defaultReasoningEffort: 'high', contextWindow: 500000 },
  ],
};
let git: GitStatus = { branch: 'feat/instant-search', isRepo: true, files: [{ path: 'src/components/search.ts', index: ' ', working: 'M' }, { path: 'src/lib/search-index.ts', index: '?', working: '?' }, { path: 'src/components/search.test.ts', index: ' ', working: 'M' }] };
const worktreeGit = new Map<string, GitStatus>();
const previewBranches = new Set<string>(), pushedBranches = new Set<string>(['feat/instant-search']), mergedBranches = new Set<string>();
function checkoutGit(sessionId: unknown): GitStatus {
  const path = sessionId ? session(sessionId).worktreePath : null;
  if (!path) return git;
  const checkout = worktreeGit.get(path);
  if (!checkout) throw new Error('Worktree folder is unavailable.');
  return checkout;
}
/** Mirrors the native naming rules so the browser preview exercises the same paths. */
function previewWorktree(source: Session, args: Record<string, any>): { path: string; branch: string } {
  const parent = projects.find(p => p.id === source.projectId)!;
  const name = String(args.branch ?? '').trim();
  if (!name || name.length > 120 || name.includes('..') || !/^[A-Za-z0-9_/-]+$/.test(name)) throw new Error('Use a branch name with letters, numbers, hyphens, underscores, and slashes');
  const branch = /^(codex|pandacode|kingcode)\//.test(name) ? name : 'pandacode/' + name;
  const exists = previewBranches.has(branch);
  if (args.existing && !exists) throw new Error(`Branch ${branch} does not exist yet. Create it instead.`);
  if (!args.existing && exists) throw new Error(`Branch ${branch} already exists. Use the existing branch or choose another name.`);
  if (args.base && !args.existing && !['main', 'release/1.4', git.branch, ...previewBranches].includes(String(args.base))) throw new Error(`Start point ${args.base} was not found.`);
  const path = parent.path + '-worktrees/' + branch.replaceAll('/', '-');
  if (sessions.some(s => s.worktreePath === path && worktreeGit.has(path))) throw new Error('Worktree destination already exists; choose a different branch');
  previewBranches.add(branch);
  worktreeGit.set(path, { branch, isRepo: true, files: [] });
  return { path, branch };
}
/** A tiny GitHub for the browser preview: one connected repository and a few issues. */
const previewClones = new Map<string, string>();
const previewGithub = (() => {
  const repos: Record<string, { nameWithOwner: string; defaultBranch: string; url: string }> = { 'project-1': { nameWithOwner: 'orbit-labs/orbit', defaultBranch: 'main', url: 'https://github.com/orbit-labs/orbit' } };
  const issues = [
    { projectId: 'project-1', number: 128, title: 'Search index rebuilds on every keystroke', body: 'Typing in the search box feels sluggish.\n\nSteps:\n1. Open the library view\n2. Type quickly\n\nThe index is recreated per input event.', state: 'open', labels: ['bug', 'performance'], assignees: ['you'], updatedAt: new Date(now - 3600_000).toISOString(), author: 'mara' },
    { projectId: 'project-1', number: 131, title: 'Keyboard shortcut cheat sheet', body: 'Add a `?` overlay listing shortcuts.', state: 'open', labels: ['enhancement'], assignees: [], updatedAt: new Date(now - 86400_000).toISOString(), author: 'devon' },
    { projectId: 'project-1', number: 97, title: 'Dark mode contrast for muted text', body: 'Muted text fails WCAG AA on the charcoal surfaces.', state: 'open', labels: ['design'], assignees: ['you'], updatedAt: new Date(now - 2 * 86400_000).toISOString(), author: 'you' },
  ];
  const pulls: { projectId: string; number: number; title: string; body: string; base: string; head: string }[] = [{ projectId: 'project-1', number: 130, title: 'Debounce library search', body: '', base: 'main', head: 'feat/debounce' }];
  let next = 200;
  const url = (projectId: string, kind: 'issue' | 'pull', number: number) => `${repos[projectId]?.url}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`;
  return {
    pulls,
    status(projectId: string) { return { installed: true, version: '2.62.0', authenticated: true, login: 'you', repo: repos[projectId] ?? null, error: repos[projectId] ? null : null }; },
    nextNumber(_projectId: string) { return ++next; },
    search(projectId: string, query: string) {
      const q = query.trim().replace(/^#/, '').toLocaleLowerCase();
      const numeric = /^\d+$/.test(q) ? Number(q) : null;
      const match = (number: number, title: string) => numeric != null ? String(number).startsWith(q) : !q || title.toLocaleLowerCase().includes(q);
      return [
        ...issues.filter(i => i.projectId === projectId && match(i.number, i.title)).map(i => ({ kind: 'issue', number: i.number, title: i.title, state: i.state, url: url(projectId, 'issue', i.number), author: i.author })),
        ...pulls.filter(p => p.projectId === projectId && match(p.number, p.title)).map(p => ({ kind: 'pull', number: p.number, title: p.title, state: 'open', url: url(projectId, 'pull', p.number), author: 'you' })),
      ].slice(0, 20);
    },
    issues(projectId: string, filter: { assignedToMe?: boolean; label?: string; query?: string }) {
      const q = (filter.query ?? '').trim().toLocaleLowerCase();
      return issues.filter(i => i.projectId === projectId && (!filter.assignedToMe || i.assignees.includes('you')) && (!filter.label || i.labels.includes(filter.label)) && (!q || i.title.toLocaleLowerCase().includes(q) || i.body.toLocaleLowerCase().includes(q)))
        .map(i => ({ number: i.number, title: i.title, body: i.body, state: i.state, url: url(projectId, 'issue', i.number), labels: i.labels, assignees: i.assignees, updatedAt: i.updatedAt }));
    },
    resolve(projectId: string, numbers: number[]) {
      return [...new Set(numbers)].slice(0, 5).flatMap(number => {
        const issue = issues.find(i => i.projectId === projectId && i.number === number);
        if (issue) return [{ kind: 'issue', number, title: issue.title, state: issue.state, url: url(projectId, 'issue', number), author: issue.author, body: issue.body, labels: issue.labels, truncated: false }];
        const pull = pulls.find(p => p.projectId === projectId && p.number === number);
        return pull ? [{ kind: 'pull', number, title: pull.title, state: 'open', url: url(projectId, 'pull', number), author: 'you', body: pull.body, labels: [], truncated: false }] : [];
      });
    },
    diff: 'diff --git a/src/lib/search-index.ts b/src/lib/search-index.ts\nindex 3f2a1c0..9b8e7d4 100644\n--- a/src/lib/search-index.ts\n+++ b/src/lib/search-index.ts\n@@ -1,4 +1,6 @@\n-export function buildIndex(items: string[]) {\n+const cache = new WeakMap<string[], Map<string, number[]>>();\n+export function buildIndex(items: string[]) {\n+  const hit = cache.get(items); if (hit) return hit;\n   const index = new Map<string, number[]>();\n   items.forEach((item, i) => index.set(item, [i]));\n   return index;\ndiff --git a/src/components/search.ts b/src/components/search.ts\nindex 1111111..2222222 100644\n--- a/src/components/search.ts\n+++ b/src/components/search.ts\n@@ -3 +3 @@\n-input.addEventListener(\'input\', rebuild);\n+input.addEventListener(\'input\', debounce(rebuild, 120));\n',
    merged: new Map<string, string>(),
    detail(projectId: string, number: number) {
      const pull = pulls.find(p => p.projectId === projectId && p.number === number);
      const at = (hours: number) => new Date(now - hours * 3600_000).toISOString();
      const mergedAt = this.merged.get(`${projectId}:${number}`) ?? '';
      return {
        number, title: pull?.title ?? `Pull request ${number}`, body: pull?.body || 'Reuses **one** search index per dataset.\n\n- Debounces input\n- Caches the index', bodyTruncated: false,
        state: mergedAt ? 'merged' : 'open', url: url(projectId, 'pull', number), author: 'you', base: pull?.base ?? 'main', head: pull?.head ?? 'feat/instant-search',
        additions: 4, deletions: 2, changedFiles: 2, createdAt: at(3), updatedAt: at(1), mergedAt, mergeable: 'mergeable', reviewDecision: 'approved', labels: ['performance'],
        checks: [{ name: 'CI / test', state: 'success', url: 'https://github.com/orbit-labs/orbit/actions/runs/1' }, { name: 'CI / lint', state: 'pending', url: '' }],
        files: [{ path: 'src/lib/search-index.ts', additions: 3, deletions: 1 }, { path: 'src/components/search.ts', additions: 1, deletions: 1 }],
        commits: [{ oid: 'a1b2c3d', headline: 'Cache the search index', author: 'you', date: at(3) }, { oid: 'e4f5a6b', headline: 'Debounce search input', author: 'you', date: at(2) }],
        timeline: [{ kind: 'comment', author: 'mara', body: 'Feels instant now.', state: '', createdAt: at(2) }, { kind: 'review', author: 'devon', body: '', state: 'approved', createdAt: at(1) }],
      };
    },
    refresh(projectId: string, link: NonNullable<Session['issue']>) {
      const issue = issues.find(i => i.projectId === projectId && i.number === link.number);
      return { ...link, title: issue?.title ?? link.title, state: issue?.state ?? link.state, checkedAt: Date.now() };
    },
  };
})();
/** A pretend iOS Simulator: two devices and a drawn home screen that answers taps. */
const previewVm = createPreviewVm();
const previewDesign = createPreviewDesign();
const previewSkills = createPreviewSkills();
const previewCloud = createPreviewCloud();
/** Each preview cloud preparation step takes this long; tests can watch the stages go by. */
const CLOUD_STEP_MS = 400;
function cloudStage(s: Session, stage: NonNullable<Session['cloud']>['stage'], detail: string | null = null): void {
  if (!s.cloud) return;
  s.cloud = { ...s.cloud, stage, detail };
  emit('cloud-agent://progress', { sessionId: s.id, stage, detail });
  emit('sessions-changed', {});
}
const previewSimulator = (() => {
  const devices: { udid: string; name: string; runtime: string; state: string; family: string; deviceType: string; platform?: string; duo?: boolean }[] = [
    { udid: '3720D4A0-B8C5-4DAC-9425-6A4685BC533E', name: 'iPhone 17 Pro', runtime: 'iOS 26.2', state: 'Booted', family: 'phone', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
    { udid: '5B7E2C1A-0D3F-4E8B-9A61-2F4C8D7E9B10', name: 'iPad Air 11-inch (M3)', runtime: 'iOS 26.2', state: 'Shutdown', family: 'pad', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3' },
    { udid: '6C1D3E2F-1A2B-4C3D-8E9F-0A1B2C3D4E5F', name: 'iPhone Air', runtime: 'iOS 26.2', state: 'Shutdown', family: 'phone', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Air' },
    { udid: '7D2E4F30-2B3C-4D4E-9FA0-1B2C3D4E5F60', name: 'iPhone 17', runtime: 'iOS 26.2', state: 'Shutdown', family: 'phone', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
    { udid: 'android:Pixel_9_API_35', name: 'Pixel 9 API 35', runtime: 'Android 15', state: 'Shutdown', family: 'phone', deviceType: 'android:pixel_9', platform: 'android' },
    { udid: '9F406152-4D5E-4F60-B1C2-3D4E5F607182', name: 'iPhone 16e', runtime: 'iOS 26.2', state: 'Shutdown', family: 'phone', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16e' },
    { udid: '8E3F5041-3C4D-4E5F-A0B1-2C3D4E5F6071', name: 'iPad Pro 13-inch (M5)', runtime: 'iOS 26.2', state: 'Shutdown', family: 'pad', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-16GB' },
  ];
  let selected: string | null = null, seq = 1, dark = false;
  const inputs: unknown[] = [];
  let lastTap: { x: number; y: number } | null = null;
  const poses = new Map<string, 'closed' | 'book' | 'open'>();
  const inners: Record<string, { width: number; height: number }> = { A1B2: { width: 951, height: 669 } };
  const screens: Record<string, { width: number; height: number; scale: number; homeButton: boolean }> = { '5B7E': { width: 820, height: 1180, scale: 2, homeButton: false }, '6C1D': { width: 420, height: 912, scale: 3, homeButton: false }, '7D2E': { width: 402, height: 874, scale: 3, homeButton: false }, 'A1B2': { width: 466, height: 678, scale: 3, homeButton: false }, '8E3F': { width: 1032, height: 1376, scale: 2, homeButton: false }, '9F40': { width: 390, height: 844, scale: 3, homeButton: false }, andr: { width: 412, height: 915, scale: 2.625, homeButton: false } };
  (window as any).__simSetPose = (udid: string, pose: 'closed' | 'book' | 'open') => { poses.set(udid, pose); seq++; }; // tests: the hinge moved outside PandaCode
  const screenOf = (udid: string | null) => ({ ...(screens[udid?.slice(0, 4) ?? ''] ?? { width: 402, height: 874, scale: 3, homeButton: false }), inner: inners[udid?.slice(0, 4) ?? ''] ?? null });
  /** The display frames and taps use: the Duo's inner display when it is not closed. */
  const activeOf = (udid: string) => { const screen = screenOf(udid); return screen.inner && (poses.get(udid) ?? 'closed') !== 'closed' ? screen.inner : screen; };
  const status = () => ({ available: true, axe: true, axeInstall: 'brew install cameroncooke/axe/axe', android: true, devices: devices.map(d => ({ platform: 'ios', ...d })), selected, screen: selected ? screenOf(selected) : null, duoAvailable: true, pose: selected && devices.find(d => d.udid === selected)?.duo ? poses.get(selected) ?? 'closed' : null, error: null });
  const apps = ['Messages', 'Safari', 'Photos', 'Camera', 'Maps', 'Weather', 'Notes', 'Settings', 'Orbit', 'Music', 'Clock', 'Files'];
  const colors = ['#34c759', '#0a84ff', '#ff9f0a', '#636366', '#30b0c7', '#5ac8fa', '#ffd60a', '#8e8e93', '#ffd43b', '#ff375f', '#1c1c1e', '#007aff'];
  async function frame(udid: string): Promise<ArrayBuffer> {
    const { width, height } = activeOf(udid), scale = 1.5;
    const canvas = new OffscreenCanvas(width * scale, height * scale), g = canvas.getContext('2d')!;
    g.scale(scale, scale);
    const sky = g.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, dark ? '#1b2a4a' : '#7fb2ff'); sky.addColorStop(1, dark ? '#3a1d4a' : '#ffc6a8');
    g.fillStyle = sky; g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff'; g.font = '600 17px -apple-system, sans-serif'; g.fillText('9:41', 34, 34);
    apps.forEach((name, i) => {
      const col = i % 4, row = Math.floor(i / 4), x = 26 + col * ((width - 52) / 4) + 6, y = 110 + row * 100;
      g.fillStyle = colors[i]; g.beginPath(); g.roundRect(x, y, 62, 62, 14); g.fill();
      g.fillStyle = '#fff'; g.font = '500 11px -apple-system, sans-serif'; g.textAlign = 'center'; g.fillText(name, x + 31, y + 78); g.textAlign = 'start';
    });
    if (lastTap) { g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(lastTap.x, lastTap.y, 18, 0, Math.PI * 2); g.fill(); }
    const image = await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer();
    const out = new Uint8Array(8 + image.byteLength);
    new DataView(out.buffer).setBigUint64(0, BigInt(seq), true);
    out.set(new Uint8Array(image), 8);
    return out.buffer;
  }
  const device = (udid: unknown) => { const found = devices.find(d => d.udid === udid); if (!found) throw new Error('That simulator is not available.'); return found; };
  return {
    inputs, status,
    createDuo() {
      let duo = devices.find(d => d.duo);
      if (!duo) { duo = { udid: 'A1B2C3D4-0000-4000-8000-00000000D0D0', name: 'iPhone Duo', runtime: 'iOS 27.1', state: 'Shutdown', family: 'phone', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', duo: true }; devices.push(duo); }
      selected = duo.udid; return status();
    },
    /** A real fold takes about half a second before the new display answers. */
    async pose(udid: unknown, pose: 'closed' | 'book' | 'open') {
      const found = device(udid);
      await new Promise(resolve => setTimeout(resolve, 250));
      poses.set(found.udid, pose); lastTap = null; seq++; return status();
    },
    select(udid: unknown) { if (udid != null) device(udid); selected = udid == null ? null : String(udid); return status(); },
    power(udid: unknown, on: boolean) { device(udid).state = on ? 'Booted' : 'Shutdown'; seq++; return status(); },
    async frame(udid: unknown, after: number) {
      const found = device(udid);
      if (found.state !== 'Booted') throw new Error(`${found.name} is shutdown. Boot it first.`);
      if (after >= seq) { await new Promise(resolve => setTimeout(resolve, 400)); return new ArrayBuffer(0); }
      return frame(found.udid);
    },
    input(udid: unknown, input: { kind: string; x?: number; y?: number }) {
      const found = device(udid); if (found.state !== 'Booted') throw new Error(`${found.name} is shutdown. Boot it first.`);
      inputs.push(structuredClone(input));
      if (input.kind === 'tap' && input.x != null && input.y != null) lastTap = { x: input.x, y: input.y };
      if (input.kind === 'button') lastTap = null;
      seq++; return `${input.kind} done`;
    },
    appearance(mode: unknown) { dark = mode === 'dark'; seq++; return `Appearance set to ${mode}.`; },
    async capture(udid: unknown) { return (await frame(device(udid).udid)).slice(8); },
  };
})();
/** Imported VS Code themes, as the native importer would store them. */
const previewThemes = (() => {
  const dracula = { id: 'dracula-theme.theme-dracula.dracula', name: 'Dracula', extension: 'Dracula Official', kind: 'dark', colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'sideBar.background': '#21222c', 'activityBar.background': '#343746', 'button.background': '#44475a', 'button.foreground': '#f8f8f2', 'focusBorder': '#bd93f9', 'list.hoverBackground': '#44475a75', 'descriptionForeground': '#6272a4', 'terminal.ansiGreen': '#50fa7b', 'terminal.ansiRed': '#ff5555', 'errorForeground': '#ff5555', 'panel.border': '#bd93f9' } };
  const tokyo = { id: 'enkia.tokyo-night.tokyo-night', name: 'Tokyo Night', extension: 'Tokyo Night', kind: 'dark', colors: { 'editor.background': '#1a1b26', 'editor.foreground': '#a9b1d6', 'sideBar.background': '#16161e', 'button.background': '#3d59a1dd', 'button.foreground': '#ffffff', 'focusBorder': '#545c7e33', 'textLink.foreground': '#7aa2f7', 'list.hoverBackground': '#13131a', 'descriptionForeground': '#515670', 'terminal.ansiGreen': '#73daca', 'terminal.ansiRed': '#f7768e' } };
  const githubLight = { id: 'github.github-vscode-theme.github-light-default', name: 'GitHub Light Default', extension: 'GitHub Theme', kind: 'light', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#1f2328', 'sideBar.background': '#f6f8fa', 'button.background': '#1f883d', 'button.foreground': '#ffffff', 'focusBorder': '#0969da', 'list.hoverBackground': '#eaeef280', 'descriptionForeground': '#656d76', 'panel.border': '#d0d7de' } };
  let installed: any[] = [githubLight];
  const add = (themes: any[]) => { installed = [...installed.filter(t => !themes.some(n => n.id === t.id)), ...themes]; return structuredClone(themes); };
  return {
    list: () => structuredClone(installed),
    import(path: string) { if (!/\.vsix$/i.test(path)) throw new Error('Choose a .vsix file.'); return add([tokyo]); },
    install(id: string) {
      if (!/^[\w-]+\.[\w.-]+$/.test(id.trim())) throw new Error('Use the extension ID, such as dracula-theme.theme-dracula.');
      if (id.trim() !== 'dracula-theme.theme-dracula') throw new Error(`Open VSX has no extension ${id.trim()}.`);
      return add([dracula]);
    },
    remove(id: string) { installed = installed.filter(t => t.id !== id); },
  };
})();
/** Whether the preview's sample machine has rtk; installing it flips this. */
let previewRtk = false;
const listeners = new Map<string, Set<(event: any) => void>>();
const timers = new Map<string, number>();
const activeTools = new Map<string, { activity: ToolActivity; message: Message }>();
let browserHistory: string[] = [], browserIndex = -1;
let browserState: BrowserStatus = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, picking: false };
function browserChanged(): void { browserState.canGoBack = browserIndex > 0; browserState.canGoForward = browserIndex < browserHistory.length - 1; emit('browser-state', { ...browserState }); }
function emit(name: string, event: unknown) { listeners.get(name)?.forEach(fn => fn(event)); }
// Tests: deliver a native event, e.g. a background refresh of the open channel.
(window as any).__previewEmit = emit;
export function listen(name: string, callback: (event: any) => void): () => void { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); return () => listeners.get(name)?.delete(callback); }
/** What the native picker "returns" in the browser preview, so attach flows can be exercised. */
export function samplePick(kind: 'files' | 'folder'): string[] {
  return kind === 'folder' ? ['/Users/you/Projects/orbit-design'] : ['/Users/you/Pictures/dashboard-mockup.png', '/Users/you/Documents/Product brief.pdf'];
}
function agent(event: AgentEvent) { emit('agent-event', event); }
function session(value: unknown): Session { const result = sessions.find(s => s.id === value); if (!result) throw new Error('Task not found'); return result; }
function assertIdle(s: Session): void {
  if (s.status === 'running' || s.status === 'waiting' || timers.has(s.id)) throw new Error('Stop the agent before changing this task.');
}
function taskDetails(title: unknown, description: unknown): { title: string; taskDescription: string } {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Title must be 1–200 characters.');
  if (typeof description !== 'string' || new TextEncoder().encode(description).length > 128 * 1024) throw new Error('Task description must be under 128 KiB.');
  return { title: title.trim(), taskDescription: description.trim() };
}
function taskSummary(s: Session): Session {
  let taskDescription = '', length = 0;
  for (const character of s.taskDescription ?? '') {
    if (length++ === 512) break;
    taskDescription += character;
  }
  return { ...s, taskDescription };
}
function archiveCompletedTasks(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const s of sessions) {
    if (!s.archived && s.taskStage === 'completed' && s.completedAt != null && s.completedAt <= cutoff && s.status !== 'running' && s.status !== 'waiting') s.archived = true;
  }
}
for (const [sessionId, history] of Object.entries(messages)) {
  if (history.some(message => message.role === 'user') && history.some(message => message.role === 'assistant')) {
    const marker: Message = { id: ++id, sessionId, role: 'changes', content: '', createdAt: history.at(-1)!.createdAt };
    turnChanges.finish(marker); history.push(marker);
  }
}
function finishTiming(sessionId: string): void {
  const history = messages[sessionId] ?? [];
  const user = [...history].reverse().find(message => message.role === 'user');
  if (user && user.turnDurationMs == null) user.turnDurationMs = Math.max(0, Date.now() - user.createdAt);
  // The Morning brief reproduces a reference with no file changes, so it gets no changes card.
  if (!user || history.at(-1)?.role === 'changes' || sessionId === BRIEF_ID) return;
  const marker: Message = { id: ++id, sessionId, role: 'changes', content: '', createdAt: Date.now() };
  turnChanges.finish(marker); history.push(marker);
  agent({ sessionId, kind: 'turn_changes', text: '', data: { messageId: marker.id, turnChanges: marker.turnChanges } });
}
/* A task on another computer: like remote/mirror.rs, its history here is what was copied
 * from the host, which happens when a run ends (just before its `done`). */
const mirrorSynced = new Map<string, number>();
function syncMirror(sessionId: string): void { if (mirrorSynced.has(sessionId)) mirrorSynced.set(sessionId, id); }
/* tests: a long mirror thread copied newest page first; older pages land below it with lower
 * ids (`remote_backfill_base + host id` natively) and announce themselves by `mirror-messages`. */
(window as any).__previewMirrorThread = (total: number, tail: number) => {
  const sessionId = 'mirror-long', at = (i: number): Message => ({ id: 100000 + i, sessionId, role: i % 2 ? 'assistant' : 'user', content: `Message ${String(i).padStart(3, '0')}`, createdAt: now - (total - i) * 1000 });
  sessions.unshift({ ...sessions[0], id: sessionId, title: 'Long remote thread', resumeId: null, remoteDevice: { id: 'dev-studio', name: 'Studio iMac' }, lastResponseAt: now });
  messages[sessionId] = Array.from({ length: tail }, (_, k) => at(total - tail + k));
  let oldest = total - tail;
  (window as any).__previewMirrorBackfill = (count: number) => {
    const from = Math.max(0, oldest - count);
    messages[sessionId] = [...Array.from({ length: oldest - from }, (_, k) => at(from + k)), ...messages[sessionId]];
    oldest = from; emit('mirror-messages', { sessionId, older: true });
  };
  emit('sessions-changed', {});
};
/* tests: a mirror whose host runs subagents and an architect team. `list_subagents` answers
 * with what native code would have saved from the host's events; `remote_team` and
 * `remote_worker_messages` answer like remote/mirror.rs from the host's `task.team`. */
const mirrorSubagents = new Map<string, Map<string, unknown>>();
const mirrorTeams = new Map<string, TeamSnapshot>();
const mirrorWorkerMessages = new Map<string, Message[]>();
(window as any).__previewMirrorTeam = (sessionId = 'mirror-team') => {
  sessions.unshift({ ...sessions[0], id: sessionId, title: 'Remote team task', resumeId: null, status: 'running', remoteDevice: { id: 'dev-studio', name: 'Studio iMac' }, lastResponseAt: now });
  messages[sessionId] = [{ id: ++id, sessionId, role: 'user', content: 'Split the docs work', createdAt: now }];
  const worker = (n: number, status: TeamWorker['status'], summary: string): TeamWorker => ({ id: `w${n}`, sessionId: `host-worker-${n}`, profileId: 'auto', name: `Worker ${n}`, provider: 'codex', model: 'gpt-5.5', status, assignment: `Part ${n}`, summary, error: null, dependsOn: [], files: [], readOnly: false, attempt: 1, abandoned: false, checkpoint: null, createdAt: now, updatedAt: now });
  mirrorTeams.set(sessionId, { sessionId, config: { auto: true, workers: [], maxParallel: 0, maxRounds: 6, maxAssignments: 0, workspace: 'shared', summaryLimit: 0 }, status: 'running', round: 1, revision: 1, workers: [worker(1, 'completed', 'Wrote the intro'), worker(2, 'running', '')], error: null, summary: null, updatedAt: now });
  // `__previewMirrorLongWorker(n)`: worker 1's transcript becomes n messages, several pages long.
  (window as any).__previewMirrorLongWorker = (count: number) => mirrorWorkerMessages.set('w1', Array.from({ length: count }, (_, index) => ({ id: index + 1, sessionId: 'host-worker-1', role: index % 2 ? 'assistant' : 'user', content: `Worker line ${index + 1}`, createdAt: now }) as Message));
  mirrorWorkerMessages.set('w1', [{ id: 1, sessionId: 'host-worker-1', role: 'user', content: 'Part 1', createdAt: now }, { id: 2, sessionId: 'host-worker-1', role: 'assistant', content: 'Intro written on the host.', createdAt: now }]);
  emit('sessions-changed', {});
  const w = window as any;
  // The host's `subagent` events, re-emitted under the local id (and saved, as natively).
  w.__mirrorSubagent = (data: { id: string }) => { mirrorSubagents.set(sessionId, new Map(mirrorSubagents.get(sessionId)).set(data.id, data)); agent({ sessionId, kind: 'subagent', text: '', data } as unknown as AgentEvent); };
  // A `team` event: the host changed a worker row.
  w.__mirrorTeamWorker = (row: Partial<TeamWorker> & { id: string }) => {
    const team = mirrorTeams.get(sessionId)!;
    const workers = team.workers.some(item => item.id === row.id) ? team.workers.map(item => item.id === row.id ? { ...item, ...row } : item) : [...team.workers, { ...team.workers[0], ...row }];
    mirrorTeams.set(sessionId, { ...team, workers, revision: team.revision + 1 });
    agent({ sessionId, kind: 'team', text: '', data: row } as unknown as AgentEvent);
  };
};
function finish(sessionId: string, content: string) { const time = Date.now(); messages[sessionId].push({ id: ++id, sessionId, role: 'assistant', content, createdAt: time }); finishTiming(sessionId); const s = session(sessionId); if (content.trim()) s.lastResponseAt = time; s.status = 'idle'; s.taskStage = 'review'; s.updatedAt = time; timers.delete(sessionId); activeTools.delete(sessionId); syncMirror(sessionId); agent({ sessionId, kind: 'done', text: '' }); }
/** Replays the Morning brief reference: five MCP tools (running, then completed), then the answer in chunks. `?replay=N` scales the pace. */
function replayBrief(s: Session): void {
  const speed = Number(new URLSearchParams(location.search).get('replay')) || 1, at = (ms: number) => ms / speed;
  const steps: [number, () => void][] = [[0, () => agent({ sessionId: s.id, kind: 'status', text: 'Working on it…' })]];
  briefTools.forEach((spec, i) => {
    const tool: ToolActivity = { id: `brief-tool-${crypto.randomUUID()}`, ...spec, status: 'running', output: '' };
    const message: Message = { id: ++id, sessionId: s.id, role: 'tool', content: encodeTool(tool), createdAt: 0 };
    const [start, end] = briefTimings.tools[i];
    steps.push([start, () => { message.createdAt = Date.now(); messages[s.id].push(message); activeTools.set(s.id, { activity: tool, message }); agent({ sessionId: s.id, kind: 'tool', text: tool.name, tool: { ...tool } }); }]);
    steps.push([end, () => { tool.status = 'completed'; tool.output = spec.output; message.content = encodeTool(tool); activeTools.delete(s.id); agent({ sessionId: s.id, kind: 'tool', text: `${tool.name} completed`, tool: { ...tool } }); }]);
  });
  for (let cursor = 0, n = 0; cursor < briefAnswer.length; cursor += briefTimings.textChunk, n++) {
    const chunk = briefAnswer.slice(cursor, cursor + briefTimings.textChunk);
    steps.push([briefTimings.textStart + n * briefTimings.textEvery, () => { s.lastResponseAt = Date.now(); agent({ sessionId: s.id, kind: 'text', text: chunk }); }]);
  }
  const last = steps[steps.length - 1][0];
  steps.push([last + 150, () => finish(s.id, briefAnswer)]);
  const run = (index: number) => {
    if (index >= steps.length) return;
    steps[index][1]();
    if (index + 1 < steps.length) timers.set(s.id, window.setTimeout(() => run(index + 1), Math.max(0, at(steps[index + 1][0] - steps[index][0]))));
  };
  timers.set(s.id, window.setTimeout(() => run(0), 0));
}
const codexPreferences: Record<string, string | boolean> = { personality: 'none', memory: false };
const previewImports = [{ id: 'preview-instructions', title: 'Project instructions', description: 'Sample project instructions from Claude Code.', source: 'Claude Code' }, { id: 'preview-skills', title: 'Project skills', description: 'Sample coding skills.', source: 'Kimi Code' }];
const importedPreviewItems = new Set<string>();
function codexTask(value: unknown): Session {
  const task = session(value); if (task.provider !== 'codex') throw new Error('Use the Codex harness for this command.'); return task;
}
function emitGoal(task: Session): void { agent({ sessionId: task.id, kind: 'goal', text: '', data: structuredClone(task.goalState ?? null) }); }
function runPreviewGoal(task: Session): void {
  window.clearTimeout(timers.get(task.id));
  task.status = 'running'; task.taskStage = 'in_progress'; task.completedAt = null;
  agent({ sessionId: task.id, kind: 'status', text: 'Working toward goal (browser preview)' });
  const text = 'This is a sample goal in the browser preview. The native app keeps Codex running across turns and reports its actual goal progress.';
  let cursor = 0;
  const turnStartedAt = Date.now();
  const tick = () => {
    if (task.goalState?.status !== 'active') return;
    if (cursor < text.length) {
      const chunk = text.slice(cursor, cursor + 16); cursor += chunk.length;
      agent({ sessionId: task.id, kind: 'text', text: chunk });
      task.lastResponseAt = Date.now();
      if (cursor >= text.length) {
        const history = (messages[task.id] ??= []);
        const marker: Message = { id: 0, sessionId: task.id, role: 'changes', content: '', createdAt: Date.now() };
        marker.turnDurationMs = Math.max(0, Date.now() - turnStartedAt);
        history.push({ id: ++id, sessionId: task.id, role: 'assistant', content: text, createdAt: Date.now() });
        marker.id = ++id; history.push(marker);
        turnChanges.finish(marker);
        agent({ sessionId: task.id, kind: 'turn_complete', text: '' });
        agent({ sessionId: task.id, kind: 'turn_changes', text: '', data: { messageId: marker.id, turnChanges: marker.turnChanges } });
      }
    }
    task.goalState.tokensUsed += 12; task.goalState.updatedAt = Math.floor(Date.now() / 1000);
    task.goalState.timeUsedSeconds = Math.max(task.goalState.timeUsedSeconds, task.goalState.updatedAt - task.goalState.createdAt);
    if (task.goalState.tokenBudget !== null && task.goalState.tokensUsed >= task.goalState.tokenBudget) {
      task.goalState.status = 'budgetLimited'; task.status = 'idle'; timers.delete(task.id); emitGoal(task); agent({ sessionId: task.id, kind: 'done', text: '' }); return;
    }
    emitGoal(task); timers.set(task.id, window.setTimeout(tick, cursor < text.length ? 35 : 1000));
  };
  timers.set(task.id, window.setTimeout(tick, 150));
}
/** Sample estimated API cost for the Agent usage window: a year of Claude Code and Codex days at 14:00 local. */
const sampleModels = [{ provider: 'claude', name: 'claude-opus-5-5', priced: true }, { provider: 'codex', name: 'gpt-6-astra', priced: true }, { provider: 'codex', name: 'codex-auto-review', priced: false }] as const;
const i2p = (model: number) => sampleModels[model]?.provider ?? 'claude';
function sampleUsageLedger() {
  const today = new Date(); let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows: [number, number, number, number, number, number, number, number][] = [];
  const sessions: { provider: string; first: number; last: number }[] = [];
  for (let back = 364; back >= 0; back--) {
    const hour = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 14).getTime() / 3_600_000);
    const weekend = [0, 6].includes(new Date(hour * 3_600_000).getDay());
    sampleModels.forEach((model, index) => {
      const roll = random();
      if (roll < (weekend ? 0.6 : 0.2) || (index === 2 && roll < 0.8)) return;
      const scale = (index === 0 ? 9e6 : 4e6) * (0.2 + roll * roll * 2.5) * (back < 30 ? 1.6 : 1);
      const [input, read, write, output] = [scale * 0.004, scale * 0.93, scale * 0.04, scale * 0.026].map(Math.round);
      const cost = model.priced ? (index === 0 ? input * 4e-6 + read * 2e-7 + write * 5e-6 + output * 2e-5 : input * 1e-5 + read * 1e-6 + output * 5e-5) : 0;
      const savings = model.priced ? read * (index === 0 ? 3.8e-6 : 9e-6) : 0;
      rows.push([hour, index, input, read, write, output, cost, savings]);
      if (index < 2) sessions.push({ provider: model.provider, first: hour, last: hour });
    });
  }
  return { scannedAt: Date.now(), pricing: { source: 'bundled', fetchedAt: null }, sources: [{ provider: 'claude', files: 40 }, { provider: 'codex', files: 180 }], models: sampleModels, rows, sessions };
}
/** A deterministic year of sample activity: quieter weekends, occasional gaps, today at 3,420 tokens. */
function sampleDailyTokens(): { date: string; tokens: number }[] {
  const today = new Date(); let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return Array.from({ length: 300 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - 299 + i)).flatMap((date, i, all) => {
    if (i === all.length - 1) return [{ date: key(date), tokens: 3420 }];
    const weekend = date.getDay() === 0 || date.getDay() === 6, roll = random();
    if (roll < (weekend ? 0.6 : 0.18)) return [];
    return [{ date: key(date), tokens: Math.round((weekend ? 900 : 2400) * (0.3 + roll * roll * 3.2)) }];
  });
}
/** Preview queues persist in localStorage so a reload behaves like a restart. */
type PreviewQueued = { id: string; sessionId: string; position: number; text: string; attachments: unknown[]; createdAt: number; updatedAt: number };
function previewQueue(): PreviewQueued[] {
  try { return (JSON.parse(localStorage.getItem('pandacode.preview.queue') ?? '[]') as PreviewQueued[]).filter(e => sessions.some(task => task.id === e.sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.position - b.position); } catch { return []; }
}
function savePreviewQueue(queue: PreviewQueued[]): void { try { localStorage.setItem('pandacode.preview.queue', JSON.stringify(queue)); } catch { /* preview only */ } }
/** Sample conversations from the Claude Code and Codex CLIs for the Import conversations window. */
const previewImportables: Record<'claude' | 'codex', { id: string; title: string; folder: string; updatedAt: number; messages: number | null; model: string | null }[]> = {
  claude: [
    { id: '7d3f2c1a-0b4e-4c6d-9a8b-1f2e3d4c5b6a', title: 'Fix login redirect loop', folder: '/Users/you/Projects/orbit', updatedAt: now - 3 * 3600000, messages: 24, model: 'claude-opus-5-5' },
    { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: 'Draft the pricing page copy', folder: '/Users/you/Projects/marketing-site', updatedAt: now - 2 * 86400000, messages: 12, model: 'claude-sonnet-5' },
    { id: '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f', title: 'Old scratch experiment', folder: '/missing/scratch', updatedAt: now - 40 * 86400000, messages: 3, model: null },
  ],
  codex: [
    { id: '4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f', title: 'Speed up the search index', folder: '/Users/you/Projects/pandacode', updatedAt: now - 5 * 3600000, messages: null, model: 'gpt-6-astra' },
  ],
};
/** Mirrors native storage: a New task draft is published by its first saved prompt. */
function settleDraft(task: Session): Session {
  if (task.draft && (messages[task.id] ?? []).some(message => message.role === 'user' && message.content.trim())) { task.draft = false; task.createdAt = Date.now(); }
  return task;
}
function commandPanel(task: Session, request: Record<string, any>): CommandPanel {
  const notes = ['Browser preview · sample data. No harness or account operation is executed.'];
  switch (request.action) {
    case 'usage': return { kind: 'usage', accountLabel: 'Preview account', plan: 'Sample plan', windows: [{ id: 'primary', label: '5-hour limit', usedPercent: 28, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, { id: 'secondary', label: 'Weekly limit', usedPercent: 41 }], stats: [{ label: 'Recorded tokens', value: '83,420' }], daily: sampleDailyTokens(), notes };
    case 'hooks': return { kind: 'hooks', items: [{ id: 'preview-hook', title: 'After editing', description: 'A sample configured lifecycle hook.', source: 'Project', enabled: true }], notes };
    case 'plugins': return { kind: 'plugins', items: [{ id: 'preview-plugin', title: 'Project docs', description: 'Sample documentation integration.', source: 'Project', status: 'Enabled' }], notes };
    case 'preferences': return { kind: 'preferences', fields: [{ id: 'personality', label: 'Response style', type: 'select', value: codexPreferences.personality, options: [{ value: 'none', label: 'Default' }, { value: 'friendly', label: 'Friendly' }, { value: 'pragmatic', label: 'Pragmatic' }] }, { id: 'memory', label: 'Memories', type: 'toggle', value: codexPreferences.memory, description: 'Sample preference for future tasks.' }], notes };
    case 'setPreference': {
      if (request.id === 'personality' && ['none', 'friendly', 'pragmatic'].includes(request.value) || request.id === 'memory' && typeof request.value === 'boolean') codexPreferences[request.id] = request.value;
      else throw new Error('Unknown or invalid Codex preference.');
      return commandPanel(task, { action: 'preferences' });
    }
    case 'imports': return { kind: 'imports', items: previewImports.filter(item => !importedPreviewItems.has(item.id)), notes };
    case 'importSelected': {
      if (!Array.isArray(request.ids) || !request.ids.length || request.ids.some((id: unknown) => !previewImports.some(item => item.id === id))) throw new Error('Select available import items.');
      request.ids.forEach((id: string) => importedPreviewItems.add(id));
      return { kind: 'result', title: 'Sample import complete', description: `${request.ids.length} selected item${request.ids.length === 1 ? '' : 's'} marked imported in this preview.`, notes };
    }
    case 'conversations': return { kind: 'conversations', mode: 'resume', items: [...sessions.filter(s => s.provider === 'codex' && s.projectId === task.projectId && s.resumeId && s.id !== task.id).map(s => ({ id: s.resumeId!, title: s.title, source: 'Codex', updatedAt: s.updatedAt })), { id: 'preview-remote-conversation', title: 'Review project architecture', description: 'Sample Codex conversation in this project.', source: 'Codex' }], cursor: null, notes };
    default: throw new Error('Unknown Codex command operation.');
  }
}
function slashCatalog(provider: ProviderId) {
  const local = [
    ['new', 'Start a new task in this project', 'new'],
    ['model', 'Choose a harness, model, and reasoning effort', 'model'],
    ['permissions', 'Choose this task’s approval behavior', 'permissions'],
    ['settings', 'Open PandaCode settings', 'settings'],
    ['theme', 'Switch appearance', 'theme'],
    ['help', 'Browse available slash commands', 'help'],
    ['skills', 'Browse harness skills', 'skills'],
    ['diff', 'Show changes in this checkout', 'diff'],
    ['status', 'Show task and context status', 'status'],
    ['context', 'Show context usage', 'status'],
    ['mcp', 'Show configured integrations', 'integrations'],
    ['resume', 'Choose a conversation to continue', provider === 'codex' ? 'conversations' : 'resume'],
    ['rename', 'Rename this task', 'rename'],
    ['copy', 'Copy the latest agent response', 'copy'],
    ['pwd', 'Show the working directory', 'pwd'],
    ['console', 'Open the harness console', 'console'],
  ];
  const codex = [
    ['goal', 'Manage the task goal and token budget', 'goal'], ['usage', 'Inspect Codex account usage', 'usage'],
    ['hooks', 'Inspect lifecycle hooks', 'hooks'], ['import', 'Choose setup to import', 'imports'],
    ['plugins', 'Inspect installed plugins', 'plugins'], ['fork', 'Continue in a separate task', 'fork'],
    ['side', 'Continue in a separate task', 'fork'], ['btw', 'Continue in a separate task', 'fork'],
    ['archive', 'Archive this task', 'archive'], ['delete', 'Delete this task', 'delete'],
    ['export', 'Export this conversation', 'export'], ['worktree', 'Create a worktree task', 'worktree'],
    ['plan', 'Choose collaboration mode', 'plan'], ['fast', 'Choose service tier', 'fast'],
    ['agents', 'Browse running tasks', 'agents'], ['subagents', 'Browse child agents', 'subagents'],
    ['mention', 'Attach a workspace file', 'mention'], ['cd', 'Change working directory', 'cd'],
    ['init', 'Create project instructions', 'init'], ['recap', 'Summarize this conversation', 'recap'],
    ['personality', 'Choose response style', 'preferences'], ['experimental', 'Configure experimental features', 'preferences'],
    ['memories', 'Configure memory preferences', 'preferences'], ['ps', 'Inspect background jobs', 'jobs'],
    ['stop', 'Choose jobs to stop', 'jobs'], ['clean', 'Choose jobs to stop', 'jobs'],
  ];
  const accepts = new Set(['rename', 'goal', 'usage', 'conversations', 'fork', 'export', 'worktree', 'plan', 'fast', 'mention', 'cd', 'init', 'recap', 'console']);
  const commands = [...local, ...(provider === 'codex' ? codex : [])].map(([name, description, action]) => ({ id: `pandacode:${name}`, name: `/${name}`, description, kind: 'action', source: 'PandaCode', action, argumentHint: accepts.has(action) ? '[arguments]' : undefined }));
  const native = provider === 'codex' ? ['review', 'compact', 'project-guide'] : provider === 'claude' ? ['compact', 'review', 'project-guide'] : ['compact', 'usage', 'tasks', 'skill:project-guide'];
  const terminal = provider === 'codex' ? ['exit', 'quit', 'keymap', 'vim', 'raw', 'title', 'statusline', 'pets', 'pet', 'clear', 'app', 'ide', 'logout', 'feedback', 'approve'] : provider === 'claude' ? ['exit', 'quit', 'login', 'logout', 'doctor'] : ["yolo", "yes", "auto", "permission", "config", "plan", "swarm", "effort", "thinking", "provider", "providers", "btw", "h", "?", "clear", "sessions", "task", "plugins", "add-dir", "experiments", "experimental", "reload", "reload-tui", "goal", "init", "fork", "title", "feedback", "undo", "editor", "logout", "disconnect", "login", "export-md", "export", "export-debug-zip", "web", "exit", "quit", "q", "version"];
  return { commands: [...commands, ...native.map(name => ({ id: `${provider}:${name}`, name: `/${name}`, description: `Sample ${provider} command`, kind: 'prompt', source: provider, action: undefined, argumentHint: '[arguments]' })), ...terminal.map(name => ({ id: `${provider}:${name}`, name: `/${name}`, description: `Open /${name} in the harness console`, kind: 'action', source: `${provider} console`, action: `console:${name}`, argumentHint: '[arguments]' }))], warnings: [] };
}
function resolveSlash(provider: ProviderId, text: string): { action: string | null; arguments: string } {
  const match = /^\/([\p{L}\p{N}_:.-]+|\?)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return { action: null, arguments: '' };
  const command = slashCatalog(provider).commands.find(command => command.name === `/${match[1]}`);
  if (!command) throw new Error(`Unknown command /${match[1]}. Type / to browse this harness’s commands, or refresh the list.`);
  if (command.action && match[2] && !command.argumentHint) throw new Error(`${command.name} opens a PandaCode control and does not accept arguments.`);
  return { action: command.action ?? null, arguments: match[2] ?? '' };
}

const architect = createPreviewArchitect({
  parent: session,
  assertIdle,
  append: (sessionId, role, content) => {
    const message: Message = { id: ++id, sessionId, role, content, createdAt: Date.now() };
    (messages[sessionId] ??= []).push(message);
    if (role === 'user' && content.trim()) session(sessionId).lastPromptAt = message.createdAt;
    return message;
  },
  finishTiming,
  finishChanges: user => turnChanges.finish(user),
  nextMessageId: () => ++id,
  models: provider => catalogs[provider],
  emit: snapshot => { emit('architect-event', snapshot); emit('sessions-changed', {}); },
  agent,
});

/** Menu bar popover data; `window.__trayCalls` records what it asked for. */
function trayCommand(command: string, args: Record<string, any>): unknown {
  ((window as any).__trayCalls ??= []).push({ command, args });
  if (command !== 'tray_snapshot') return undefined;
  const now = Date.now(), minutes = (m: number) => now - m * 60_000, hours = (h: number) => new Date(now + h * 3_600_000).toISOString();
  return {
    running: [
      { id: 'tray-running-1', title: 'Polish the new onboarding flow and keyboard navigation', project: 'PandaCode', provider: 'claude', at: minutes(4) },
      { id: 'tray-running-2', title: 'Build search indexing', project: 'website', provider: 'codex', at: minutes(27) },
    ],
    waiting: [{ id: 'tray-waiting', title: 'Run the database migration', project: 'api', provider: 'opencode', at: minutes(12) }],
    finished: [
      { id: 'tray-done', title: 'Review the API changes', project: 'api', provider: 'kimi', at: minutes(8) },
      { id: 'tray-failed', title: 'Fix flaky login test', project: 'PandaCode', provider: 'codex', at: minutes(65), failed: true },
    ],
    usage: [
      { provider: 'claude', status: 'ready', plan: 'Max', stale: false, checkedAt: now, windows: [{ label: '5 hours', usedPercent: 42, resetsAt: hours(2.17) }, { label: 'Weekly', usedPercent: 83, resetsAt: hours(70) }] },
      { provider: 'codex', status: 'ready', plan: 'Pro', stale: false, checkedAt: now, windows: [{ label: '5 hours', usedPercent: 97, resetsAt: hours(0.6) }] },
    ],
    checking: false,
  };
}
/** Raw-IPC twin of `invoke`: the body is bytes and named arguments arrive in headers. */
export async function invokeRaw<T>(command: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
  return invoke<T>(command, { ...headers, bytes: body.byteLength });
}
export async function invoke<T>(command: string, args: Record<string, any>): Promise<T> {
  if (command.startsWith('tray_')) return trayCommand(command, args) as T;
  if (command.startsWith('jj_')) return (await import('./preview-jj')).invokeJj<T>(command, args);
  if (command.includes('moodboard')) return (await import('./preview-moodboards')).invokeMoodboards<T>(command, args);
  if (command === 'bots_list' || command.startsWith('bot_')) return invokeBots<T>(command, args, {
    invoke, emit,
    addProject: name => { const p = { id: crypto.randomUUID(), name, path: `/Users/you/PandaCode Bots/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }; projects.push(p); return p; },
  });
  if (command === 'remote_device_grants' || command === 'remote_set_device_grant' || command.startsWith('remote_pair_')) return (await import('./preview-grants')).previewGrants(command, args) as T;
  if (command === 'remote_diagnostics' || command === 'remote_diagnostics_export') return (await import('./preview-diagnostics')).previewDiagnostics(command, args) as T;
  if (command === 'remote_reconnect') {
    // Tests steer it: `__remoteReconnectHold` waits for `__remoteReconnectRelease()`, `__remoteReconnectFail` is an error text.
    const w = window as any; w.__remoteReconnects = (w.__remoteReconnects ?? 0) + 1;
    if (w.__remoteReconnectHold) await new Promise<void>(resolve => { w.__remoteReconnectRelease = () => { w.__remoteReconnectHold = false; resolve(); }; });
    if (w.__remoteReconnectFail) { const failure = w.__remoteReconnectFail; w.__remoteReconnectFail = undefined; throw new Error(failure); }
    return undefined as T;
  }
  if (command === 'remote_repo_check') {
    const w = window as any;
    (w.__remoteRepoChecks ??= []).push(args);
    if (w.__remoteRepoCheckManual) await new Promise<void>(resolve => { w.__remoteRepoCheckRelease = () => { w.__remoteRepoCheckManual = false; resolve(); }; });
    // `window.__remoteBehind` lets tests make GitHub lag this computer.
    const repo = previewGithub.status(args.projectId).repo, behind = w.__remoteBehind ?? {};
    return { repo: repo?.nameWithOwner ?? null, branch: git.branch, ahead: behind.ahead ?? 0, dirty: behind.dirty ?? false, pushed: behind.pushed ?? true } as T;
  }
  if (command === 'remote_cancel_start') {
    const w = window as any;
    (w.__remoteCancelStarts ??= []).push(args);
    if (w.__remoteCancelStartFail) throw new Error(w.__remoteCancelStartFail);
    if (w.__remoteCancelStartHold) await new Promise<void>(resolve => { w.__remoteCancelStartRelease = () => { w.__remoteCancelStartHold = false; resolve(); }; });
    const { cancelPreviewRemoteStart } = await import('./preview-remote');
    // `__remoteCancelStartPending`: the host has not answered; `__remoteCancelStartFailLater()` then ends the start with an error frame.
    if (w.__remoteCancelStartPending) {
      w.__remoteCancelStartPending = false;
      const started = (w.__remoteStarts ?? []).at(-1) ?? {};
      w.__remoteCancelStartFailLater = () => { emit('remote://start-progress', { deviceId: started.deviceId, startId: started.startId ?? null, repo: null, stage: 'error', percent: null, detail: 'Start cancelled.' }); cancelPreviewRemoteStart(String(args.sessionId)); };
      return { cancelled: false, pending: true } as T;
    }
    if (!cancelPreviewRemoteStart(String(args.sessionId))) throw new Error('This remote start is no longer active.');
    return { cancelled: true } as T;
  }
  if (command === 'remote_workspace_image') {
    ((window as any).__remoteWorkspaceImages ??= []).push({ sessionId: args.sessionId, path: args.path });
    return invoke<T>('workspace_image', args);
  }
  if (command === 'remote_start_task') {
    // The task runs on the other computer; here it is an ordinary session that names it.
    const targets = await invokeRemote<{ deviceId: string; name: string; online: boolean }[]>('remote_targets', {}, emit);
    const target = targets.find(item => item.deviceId === args.deviceId && item.online);
    if (!target) throw new Error('That computer is offline.');
    ((window as any).__remoteStarts ??= []).push(args);
    // The host's stages (finding, downloading…), shown by src/remote-progress.ts; may fail on request.
    await previewRemoteStart({ ...args, repo: previewGithub.status(args.projectId).repo?.nameWithOwner }, emit);
    const s = args.sessionId ? session(args.sessionId) : await invoke<Session>('create_session', { projectId: args.projectId, provider: args.provider, model: args.model, mode: args.mode });
    Object.assign(session(s.id), { projectId: args.projectId, provider: args.provider, model: args.model, mode: args.mode, reasoningEffort: args.effort, remoteDevice: { id: target.deviceId, name: target.name }, worktreeBranch: args.branch });
    mirrorSynced.set(s.id, id);
    const w = window as any;
    if (w.__remoteStartAmbiguous) {
      // The reply was lost (remote/mirror.rs): the row stays running and waits; `__remoteStartAttach()` lets the host task appear.
      w.__remoteStartAmbiguous = false;
      Object.assign(session(s.id), { status: 'running', draft: false });
      emit('remote://start-progress', { deviceId: args.deviceId, startId: args.startId ?? null, repo: null, stage: 'starting', percent: null, detail: `Waiting for ${target.name}…` });
      const { holdPreviewRemoteStart } = await import('./preview-remote');
      holdPreviewRemoteStart(String(args.sessionId ?? args.startId ?? ''), () => { Object.assign(session(s.id), { remoteDevice: null, status: 'idle', draft: true }); emit('sessions-changed', {}); });
      // `note`: the worktree note `task.startStatus` carries for the resumed start (remote/mirror.rs `resume_start`).
      w.__remoteStartAttach = async (note?: string) => { holdPreviewRemoteStart(String(args.sessionId ?? args.startId ?? ''), undefined); session(s.id).status = 'idle'; await invoke('send_message', { sessionId: s.id, text: args.prompt, imageIds: args.imageIds ?? [] }); emit('sessions-changed', {}); if (note) emit('remote://start-note', { sessionId: s.id, note }); };
      emit('sessions-changed', {});
      return { sessionId: s.id } as T;
    }
    await invoke('send_message', { sessionId: s.id, text: args.prompt, imageIds: args.imageIds ?? [] });
    emit('sessions-changed', {});
    return (w.__remoteStartBusy ? { sessionId: s.id, note: w.__remoteStartBusy } : { sessionId: s.id }) as T;
  }
  if (command.startsWith('remote_') && command !== 'remote_team' && command !== 'remote_worker_messages') return invokeRemote<T>(command, args, emit);
  if (command === 'cloud_agent_targets') return previewCloud.agentTargets() as T;
  if (command === 'cloud_agent_set_claude_token') { if (!String(args.token ?? '').trim()) throw new Error('Paste the token from claude setup-token.'); return null as T; }
  if (command === 'cloud_agent_start') {
    // The agent runs on a cloud machine; here the machine is prepared on a timer, then the prompt is sent.
    const target = previewCloud.agentTargets().find(item => item.provider === args.provider && item.ready);
    if (!target) throw new Error('Connect this provider in Settings → Cloud first.');
    ((window as any).__cloudStarts ??= []).push(args);
    const s = args.sessionId ? session(args.sessionId) : await invoke<Session>('create_session', { projectId: args.projectId, provider: args.harness, model: args.model, mode: args.mode });
    Object.assign(s, { provider: args.harness, model: args.model, mode: args.mode, reasoningEffort: args.effort, draft: false, worktreeBranch: `pandacode/cloud-${s.id.slice(0, 8)}`, cloud: { provider: target.provider, label: target.label, machine: `${target.provider}:pc-${s.id.slice(0, 8)}`, stage: 'creating', detail: null } });
    const stages = ['installing', 'credentials', 'uploading', 'running'] as const;
    stages.forEach((stage, index) => setTimeout(async () => {
      cloudStage(s, stage);
      if (stage === 'running') { await invoke('send_message', { sessionId: s.id, text: args.prompt }); cloudStage(s, 'ready'); }
    }, (index + 1) * CLOUD_STEP_MS));
    emit('sessions-changed', {});
    return structuredClone(s) as T;
  }
  if (command === 'cloud_agent_action') {
    const s = session(args.sessionId);
    if (!s.cloud) throw new Error('This task does not run on a cloud machine.');
    ((window as any).__cloudActions ??= []).push(args.action);
    // `window.__cloudActionFail` lets tests make one action fail like the provider would.
    if ((window as any).__cloudActionFail === args.action) throw new Error(`${s.cloud.label} could not ${args.action} the machine (HTTP 503).`);
    if (args.action === 'sync') { cloudStage(s, 'syncing'); setTimeout(() => cloudStage(s, 'ready'), CLOUD_STEP_MS); }
    else if (args.action === 'retry') cloudStage(s, 'ready');
    else if (args.action === 'stop') cloudStage(s, 'stopped');
    else if (args.action === 'delete') { s.cloud = { ...s.cloud, machine: null }; cloudStage(s, 'stopped', 'Machine deleted'); }
    else if (args.action !== 'open') throw new Error('Unknown cloud action.');
    return null as T;
  }
  if (command === 'capabilities_inventory' || command === 'cache_alignment') return previewCapabilities(command) as T;
  if (command.startsWith('recipes_')) { const r = recipesCommand(command, args); if (r.handled) return r.result as T; }
  let result: unknown;
  switch (command) {
    case 'check_agent_updates': result = providers.filter(provider => provider.installed && !['glm', 'mimo'].includes(provider.id)).map(provider => {
      const version = provider.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      return { provider: provider.id, name: provider.name, providers: provider.id === 'claude' ? ['claude', 'glm', 'mimo'] : [provider.id], installedVersion: version, latestVersion: version, status: 'current', method: null, canUpdate: false, message: 'Browser preview · installed agents are checked in the desktop app.', checkedAt: Date.now(), docsUrl: null };
    }); break;
    case 'update_agent': throw new Error('Agent updates are available in the desktop app.');
    case 'jev_configuration': result = { enabled: false, decisionsEnabled: false, decisionProvider: 'typesafe', decisionModel: '', openrouterKeySaved: false, pythonPath: '', chromePath: '', textModel: 'inception/mercury-2.5', textBaseUrl: 'https://openrouter.ai/api/v1', typesafeKeySaved: false, textKeySaved: false }; break;
    case 'jev_doctor': result = { ready: false, pythonVersion: '', jevVersion: '', chromePath: '', issues: ['Jev runs in the desktop app. This browser preview does not launch browsers or contact model APIs.'] }; break;
    case 'jev_decision_models': result = args?.provider === 'openrouter' ? [{ id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini' }, { id: 'anthropic/claude-haiku-4.5', name: 'Anthropic: Claude Haiku 4.5' }] : [{ id: 'jev-1.13.0', name: 'jev-1.13.0' }]; break;
    case 'jev_list_runs': case 'jev_assist_list': result = []; break;
    case 'jev_watch_run': break; // Preview never starts Chrome or contacts model providers.
    case 'jev_assist_prepare': {
      const task = session(args.sessionId);
      const request = args.request as {kind: string; query?: string; rules?: string[]};
      const evidence = (messages[task.id] ?? []).filter(m => m.role === 'user' || m.role === 'assistant').slice(-16).map(m => ({id:String(m.id),label:m.role === 'user' ? 'You' : 'Agent',text:m.content.slice(0,1200),truncated:m.content.length>1200}));
      result = {kind:request.kind,title:'Jev assistance',query:request.query ?? '',rules:request.rules ?? [],evidence,candidateCount:evidence.length,inputBytes:new TextEncoder().encode(JSON.stringify(evidence)).length,truncated:false,enabled:false,keySaved:false,fingerprint:'preview'}; break;
    }
    case 'jev_assist_run': case 'jev_assist_save_rules': throw new Error('Jev assistance is an optional desktop add-on. This preview does not call model APIs.');
    case 'jev_save_configuration': case 'jev_install_runtime': case 'jev_start': case 'jev_cancel': case 'jev_read_run': throw new Error('Jev browser testing is available in the desktop app.');
    case 'provider_set_claude_connection_mode': {
      if (!['inherit', 'subscription'].includes(args.mode)) throw new Error('Choose a Claude connection mode.');
      previewClaudeMode = args.mode; return invoke<T>('provider_configuration', {});
    }
    case 'connections_list': result = previewConnections; break;
    case 'connection_save': result = previewSaveConnection(args.connection); break;
    case 'connection_delete': {
      const tasks = Object.fromEntries(Object.entries(previewConnections.tasks).filter(([, id]) => id !== args.id));
      previewConnections = { connections: previewConnections.connections.filter(c => c.id !== args.id), tasks }; result = previewConnections; break;
    }
    case 'connection_assign': {
      if (args.connectionId && !previewConnections.connections.some(c => c.id === args.connectionId)) throw new Error('This connection no longer exists.');
      const { [args.sessionId]: _previous, ...tasks } = previewConnections.tasks;
      previewConnections = { ...previewConnections, tasks: args.connectionId ? { ...tasks, [args.sessionId]: args.connectionId } : tasks }; result = previewConnections; break;
    }
    case 'provider_claude_status': result = {mode: previewClaudeMode, source: 'Saved Claude login', environmentVariables: [], endpoint: null, savedLogin: 'signedIn', conflict: false}; break;
    case 'usage_ledger': result = sampleUsageLedger(); break;
    case 'prompt_activity': result = sampleUsageLedger().rows.filter((_, i) => i % 3 === 0).map(row => [row[0], i2p(row[1]), 1 + (row[0] % 7)]); break;
    case 'agent_usage': {
      const provider = String(args.provider);
      const supported = ['claude', 'codex', 'kimi', 'glm', 'opencode'].includes(provider);
      result = { provider, status: supported ? 'ready' : 'unsupported', checkedAt: Date.now(), stale: false,
        plan: provider === 'codex' ? 'Pro' : provider === 'opencode' ? 'Go' : null,
        windows: supported ? [
          { label: provider === 'opencode' ? 'Go rolling window' : '5-hour window', usedPercent: args.connection ? 91 : provider === 'codex' ? 38 : 22, resetsAt: new Date(Date.now() + 7200000).toISOString() },
          { label: provider === 'opencode' ? 'Go weekly' : 'Weekly', usedPercent: 64, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() },
        ] : [], source: 'Sample limits for the browser preview. No provider request was made.',
        message: supported ? null : 'This harness does not expose account limits. Check its account dashboard.' };
      break;
    }
    case 'provider_configuration': result = { executablePaths: {}, claudeConnectionMode: previewClaudeMode, glmKeySaved: false, glmKeyFromEnvironment: false, deepseekKeySaved: false, deepseekKeyFromEnvironment: false, commandcodeKeySaved: false, commandcodeKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: previewMimoEndpoint, mimoEndpoints: previewMimoEndpoints, secureStorageAvailable: false }; break;
    case 'provider_set_mimo_endpoint':
      if (!previewMimoEndpoints.some(entry => entry.id === args.endpoint)) throw new Error('Choose one of the MiMo endpoints listed in Settings.');
      previewMimoEndpoint = args.endpoint;
      result = { executablePaths: {}, claudeConnectionMode: previewClaudeMode, glmKeySaved: false, glmKeyFromEnvironment: false, deepseekKeySaved: false, deepseekKeyFromEnvironment: false, commandcodeKeySaved: false, commandcodeKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: previewMimoEndpoint, mimoEndpoints: previewMimoEndpoints, secureStorageAvailable: false }; break;
    case 'provider_save_glm_key': case 'provider_remove_glm_key': case 'provider_save_deepseek_key': case 'provider_remove_deepseek_key': case 'provider_save_commandcode_key': case 'provider_remove_commandcode_key': case 'provider_save_mimo_key': case 'provider_remove_mimo_key': case 'provider_set_executable': throw new Error('Provider connections can only be changed in the desktop app.');
    case 'turn_change_summary': {
      session(args.sessionId);
      const summary = (messages[String(args.sessionId)] ?? []).find(m => m.turnChanges?.id === args.changeId)?.turnChanges;
      if (!summary) throw new Error('This change summary does not belong to this task.');
      result = structuredClone(summary); break;
    }
    case 'turn_change_diff': result = turnChanges.diff(args.sessionId, args.changeId, args.path); break;
    case 'model_routing_status': result = { ...previewRouting }; break;
    case 'model_routing_configure': previewRouting = { ...previewRouting, ...(args.enabled != null ? { enabled: Boolean(args.enabled) } : {}), ...(args.mode ? { mode: args.mode } : {}), ...(args.minP != null ? { minP: Math.min(0.95, Math.max(0.5, Number(args.minP))) } : {}) }; saveRouting(); result = { ...previewRouting }; break;
    case 'model_routing_prepare': previewRouting = { ...previewRouting, profiler: 'ready', error: null }; saveRouting(); result = { ...previewRouting }; break;
    case 'model_routing_route': result = previewRoute(String(args.text), args.pool as any[]); break;
    case 'architect_get': result = architect.get(args.sessionId); break;
    case 'architect_configure': result = architect.configure(args.sessionId, args.config, args.architect, args.profileId); break;
    case 'architect_profiles': result = architect.profiles(); break;
    case 'architect_set_lead_guidance': result = architect.setLeadGuidance(args.guidance); break;
    case 'architect_save_profile': result = architect.saveProfile(args.id, args.name, args.setup); break;
    case 'architect_delete_profile': result = architect.deleteProfile(args.id); break;
    case 'architect_start': architect.start(args.sessionId, args.text, args.imageIds); break;
    case 'architect_control': result = architect.control(args.sessionId, args.action); break;
    case 'architect_worker_messages': result = architect.workerMessages(args.sessionId, args.workerId, args.beforeId); break;
    case 'architect_team_messages': result = architect.teamMessages(args.sessionId, args.afterId, args.limit); break;
    case 'task_goal': {
      const task = codexTask(args.sessionId); const request = args.request ?? {};
      if (request.action === 'get') { result = task.goalState ?? null; break; }
      if (architect.get(task.id)) throw new Error('Goals and architect teams need separate tasks.');
      if (task.archived || task.taskStage === 'completed') throw new Error('Reopen this task before changing its goal.');
      if (!['set', 'pause', 'resume', 'clear'].includes(request.action)) throw new Error('Unknown goal action.');
      if (request.action !== 'set' && !task.goalState) throw new Error('This task has no goal yet.');
      const time = Math.floor(Date.now() / 1000);
      if (request.action === 'set') {
        if (typeof request.objective !== 'string' || !request.objective.trim() || new TextEncoder().encode(request.objective).length > 32768 || request.tokenBudget != null && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget < 1)) throw new Error('Enter an objective and an optional positive whole token budget.');
        const starting = !task.goalState;
        task.resumeId ??= 'preview-goal-' + task.id;
        task.goalState = { threadId: task.resumeId, objective: request.objective.trim(), tokenBudget: request.tokenBudget ?? null, status: 'active', tokensUsed: task.goalState?.tokensUsed ?? 0, timeUsedSeconds: task.goalState?.timeUsedSeconds ?? 0, createdAt: task.goalState?.createdAt ?? time, updatedAt: time } satisfies GoalState;
        if (starting) task.lastPromptAt = Date.now();
        if (starting) (messages[task.id] ??= []).push({ id: ++id, sessionId: task.id, role: 'user', content: request.objective.trim(), createdAt: Date.now() });
        emitGoal(task); runPreviewGoal(task);
      } else if (request.action === 'resume') {
        task.goalState!.status = 'active'; task.goalState!.updatedAt = time; emitGoal(task); runPreviewGoal(task);
      } else {
        window.clearTimeout(timers.get(task.id)); timers.delete(task.id);
        if (request.action === 'clear') task.goalState = null;
        else { task.goalState!.status = 'paused'; task.goalState!.updatedAt = time; }
        task.status = 'idle'; emitGoal(task); agent({ sessionId: task.id, kind: 'done', text: '' });
      }
      task.updatedAt = Date.now(); result = task.goalState; break;
    }
    case 'codex_command': result = commandPanel(codexTask(args.sessionId), args.request ?? {}); break;
    case 'codex_jobs': codexTask(args.sessionId); if (args.stopId) throw new Error('This sample task has no background jobs.'); result = { kind: 'jobs', jobs: [], notes: ['Browser preview · no commands are running.'] }; break;
    case 'set_task_preference': {
      const task = codexTask(args.sessionId), request = args.request ?? {};
      if (!['plan', 'fast'].includes(request.action) || typeof request.enabled !== 'boolean') throw new Error('Choose a valid task preference.');
      task.codexSettings ??= {};
      if (request.action === 'plan') task.codexSettings.collaborationMode = { mode: request.enabled ? 'plan' : 'default' };
      else task.codexSettings.serviceTier = request.enabled ? 'fast' : null;
      task.updatedAt = Date.now(); result = task; break;
    }
    case 'get_message_content': {
      const task = session(args.sessionId);
      const message = messages[task.id]?.find(message => message.id === args.messageId && ['user', 'assistant'].includes(message.role));
      if (!message) throw new Error('This saved message does not belong to the source task.');
      result = message.content; break;
    }
    case 'fork_session_at_message': {
      const source = session(args.sessionId), history = messages[source.id] ?? [];
      const boundary = history.findIndex(message => message.id === args.messageId);
      if (!Number.isSafeInteger(args.messageId) || args.messageId <= 0 || boundary < 0 || !['user', 'assistant'].includes(history[boundary].role)) throw new Error('Choose a saved user message or assistant response to fork.');
      const boundaryProvider = historicalProvider(history[boundary], history, source.provider);
      const created: Session = { ...structuredClone(source), id: crypto.randomUUID(), pinned: false, sidebarOrder: null, title: [...source.title].slice(0, 193).join('') + ' (fork)', resumeId: null, status: 'idle', archived: false, goalState: null, contextUsage: null, taskStage: 'in_progress', completedAt: null, lastResponseAt: null, lastPromptAt: null, createdAt: Date.now(), updatedAt: Date.now() };
      const copied: Message[] = history.slice(0, boundary + (args.exclusive ? 0 : 1)).filter(message => !['internal', 'changes'].includes(message.role)).map(message => {
        let content = message.content;
        if (message.role === 'tool') {
          try {
            const tool = JSON.parse(content);
            if (tool.type === 'tool_activity' && tool.version === 1) {
              tool.id = 'fork:' + crypto.randomUUID();
              if (['running', 'waiting'].includes(tool.status)) { tool.status = 'failed'; tool.output = (tool.output ?? '') + '\n[This tool was still running when the conversation was forked.]'; }
              content = JSON.stringify(tool);
            }
          } catch { /* Legacy plain text tool output. */ }
        }
        return { id: ++id, sessionId: created.id, role: message.role, content, createdAt: message.createdAt, coordinationKind: message.coordinationKind };
      });
      if (boundaryProvider !== source.provider) copied.push({ id: ++id, sessionId: created.id, role: 'handoff', content: JSON.stringify({ fromProvider: boundaryProvider, toProvider: source.provider, summary: 'Forked conversation. Earlier responses keep their original harness. The next message carries the saved conversation into the currently selected harness.' }), createdAt: Date.now() });
      created.taskDescription = copied.find(message => message.role === 'user')?.content ?? '';
      sessions.unshift(created); messages[created.id] = copied; result = created; break;
    }
    case 'fork_codex_task': {
      const source = codexTask(args.sessionId); assertIdle(source);
      if (args.remoteId) {
        const previous = sessions.find(s => s.provider === 'codex' && s.projectId === source.projectId && s.resumeId === args.remoteId);
        if (previous) { result = previous; break; }
        if (args.remoteId !== 'preview-remote-conversation') throw new Error('That conversation is not available in this project.');
      } else if (!source.resumeId) throw new Error('Start the conversation before forking it.');
      const created: Session = { ...source, id: crypto.randomUUID(), pinned: false, sidebarOrder: null, title: args.remoteId ? 'Review project architecture' : source.title + ' (fork)', resumeId: args.remoteId ?? crypto.randomUUID(), status: 'idle', archived: false, goalState: null, taskStage: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() };
      sessions.unshift(created); messages[created.id] = args.remoteId ? [{ id: ++id, sessionId: created.id, role: 'assistant', content: 'This is a sample imported conversation. No remote data was read.', createdAt: Date.now() }] : (messages[source.id] ?? []).map(message => ({ ...message, id: ++id, sessionId: created.id })); result = created; break;
    }
    case 'archive_codex_task': { const task = codexTask(args.sessionId); assertIdle(task); task.archived = true; task.updatedAt = Date.now(); break; }
    case 'export_task': { const task = session(args.sessionId); result = `# ${task.title}\n\n` + (messages[task.id] ?? []).map(message => `## ${message.role}\n\n${message.content}\n\n`).join(''); break; }
    case 'list_subagents': return [...(mirrorSubagents.get(String(args.sessionId))?.values() ?? [])] as T;
    case 'remote_team': return structuredClone(mirrorTeams.get(String(args.sessionId)) ?? null) as T;
    case 'remote_worker_messages': {
      // Pages of 40 back from the tail, as `worker_pages` in remote/mirror.rs joins the host's.
      const all = mirrorWorkerMessages.get(String(args.workerId)) ?? [], before = all.filter(message => !args.beforeId || message.id < args.beforeId);
      ((window as any).__remoteWorkerPages ??= []).push(args.beforeId ?? null);
      return { messages: structuredClone(before.slice(-40)), hasOlder: before.length > 40 } as T;
    }
    case 'list_local_servers': result = [{ port: 3000, process: 'node', url: 'http://localhost:3000' }, { port: 5173, process: 'vite', url: 'http://localhost:5173' }]; break;
    case 'browser_open': {
      const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS address.');
      browserHistory = browserHistory.slice(0, browserIndex + 1); browserHistory.push(url.href); browserIndex++;
      browserState = { ...browserState, url: url.href, title: 'Sample app', loading: false, picking: false }; browserChanged(); result = { ...browserState }; break;
    }
    case 'browser_action': if (args.action === 'back' && browserIndex > 0) browserIndex--; else if (args.action === 'forward' && browserIndex < browserHistory.length - 1) browserIndex++; browserState.url = browserHistory[browserIndex] ?? ''; browserState.picking = false; browserChanged(); break;
    case 'browser_pick': browserState.picking = Boolean(args.enabled); browserChanged(); break;
    case 'browser_bounds': break;
    case 'browser_close': browserHistory = []; browserIndex = -1; browserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, picking: false }; browserChanged(); break;
    case 'browser_capture': result = { id: crypto.randomUUID(), name: 'Sample screenshot', path: '/sample/browser-capture.png', mimeType: 'image/png', url: browserState.url, title: browserState.title, width: 1280, height: 800, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }; break;
    // Like the native rowid: projects are pushed in the order they were added.
    case 'list_projects': result = projects.map((project, index) => ({ ...project, addedOrder: index + 1 })); break;
    case 'list_sessions': archiveCompletedTasks(); sessions.forEach(settleDraft); result = [...sessions].filter(task => !task.draft).sort(compareThreadOrder).map(taskSummary); break;
    case 'set_resume_at_reset': {
      const s = session(args.sessionId);
      if (args.enabled && !(s.limitedAt && s.limitedUntil)) throw new Error('This task has no usage limit with a known reset time.');
      s.resumeAtReset = Boolean(args.enabled) && Boolean(s.limitedAt); result = s; break;
    }
    case 'tray_seen': result = null; break;
    case 'clear_usage_limit': { const s = session(args.sessionId); s.limitedAt = null; s.limitedUntil = null; s.resumeAtReset = false; result = null; break; }
    case 'queue_list': result = previewQueue().filter(entry => !args.sessionId || entry.sessionId === args.sessionId); break;
    case 'queue_add': {
      session(args.sessionId);
      const text = String(args.text ?? ''), list = Array.isArray(args.attachments) ? args.attachments : [];
      if (!text.trim() && !list.length) throw new Error('Write a message or add an attachment to queue.');
      const queue = previewQueue(), at = Date.now();
      const entry = { id: crypto.randomUUID(), sessionId: args.sessionId, position: Math.max(-1, ...queue.filter(e => e.sessionId === args.sessionId).map(e => e.position)) + 1, text, attachments: list, createdAt: at, updatedAt: at };
      savePreviewQueue([...queue, entry]); result = entry; break;
    }
    case 'queue_update': {
      const queue = previewQueue(), entry = queue.find(e => e.id === args.id);
      if (!entry) throw new Error('This queued message was already sent or removed.');
      Object.assign(entry, { text: String(args.text ?? ''), attachments: args.attachments ?? [], updatedAt: Date.now() });
      savePreviewQueue(queue); result = entry; break;
    }
    case 'queue_remove': savePreviewQueue(previewQueue().filter(e => e.id !== args.id)); result = null; break;
    case 'queue_reorder': {
      const queue = previewQueue(), own = queue.filter(e => e.sessionId === args.sessionId);
      if ([...own.map(e => e.id)].sort().join() !== [...args.ids].sort().join()) throw new Error('The queue changed. Try reordering again.');
      (args.ids as string[]).forEach((id, position) => { queue.find(e => e.id === id)!.position = position; });
      savePreviewQueue(queue); result = previewQueue().filter(e => e.sessionId === args.sessionId); break;
    }
    case 'queue_take': {
      const queue = previewQueue(), entry = queue.find(e => e.id === args.id);
      if (!entry) throw new Error('This queued message was already sent or removed.');
      savePreviewQueue(queue.filter(e => e.id !== args.id)); result = entry; break;
    }
    case 'queue_restore': {
      const queue = previewQueue(), entry = args.entry as PreviewQueued;
      if (queue.some(e => e.id === entry.id)) throw new Error('This message is already queued.');
      const position = Math.min(1, ...queue.filter(e => e.sessionId === entry.sessionId).map(e => e.position)) - 1;
      const restored = { ...entry, position, updatedAt: Date.now() };
      savePreviewQueue([...queue, restored]); result = restored; break;
    }
    case 'steer_task': {
      const s = session(args.sessionId), w = window as any;
      if (!timers.has(s.id) && s.status !== 'running' && !previewBotBusy(s.id)) throw new Error('The agent is not running; the message stays queued.');
      if (w.__remoteRefuse && s.remoteDevice) throw new Error(w.__remoteRefuse);
      if (w.__remoteSteerHold && s.remoteDevice) await new Promise<void>(resolve => { w.__remoteSteerRelease = () => { w.__remoteSteerHold = false; resolve(); }; });
      // Claude-family, Codex, Pi, Muse and Devin take it live; others hold it for the next turn of the same run.
      const text = String(args.text).trim(), steerId = `steer-${++id}`;
      const mode = ['claude', 'glm', 'mimo', 'codex', 'pi', 'muse', 'devin'].includes(s.provider) ? 'live' : 'next-turn';
      const report = (status: string) => agent({ sessionId: s.id, kind: 'steer' as AgentEvent['kind'], text, data: { id: steerId, status, mode } });
      window.setTimeout(() => report('pending'));
      window.setTimeout(() => {
        // Test hook: a steer whose text mentions this fails, as when the process exits before taking it.
        if (text.includes('[steer-fails]')) return report('failed');
        (messages[s.id] ??= []).push({ id: ++id, sessionId: s.id, role: 'user', content: text, createdAt: Date.now() });
        report('delivered');
        // A sample bot shown as working has no preview run to answer it, so it answers here.
        if (previewBotBusy(s.id)) agent({ sessionId: s.id, kind: 'text', text: 'Got it, I will fold that in. (browser preview)' });
      }, mode === 'live' ? 900 : 1500);
      result = { steered: true, id: steerId, mode }; break;
    }
    case 'list_importable_conversations': {
      const query = String(args.search ?? '').toLowerCase();
      const source = args.provider === 'codex' ? 'codex' : 'claude';
      const imported = (id: string) => sessions.find(task => task.provider === source && task.resumeId === id)?.id ?? null;
      const items = previewImportables[source].filter(item => !query || `${item.title} ${item.folder}`.toLowerCase().includes(query))
        .map(item => ({ ...item, importedTaskId: imported(item.id), unavailable: item.folder.startsWith('/missing') ? 'Its folder no longer exists on this computer.' : null }));
      result = { items, cursor: null, note: items.length ? null : `No ${source === 'codex' ? 'Codex' : 'Claude Code'} conversations were found on this computer.` }; break;
    }
    case 'import_conversations': {
      const source = args.provider === 'codex' ? 'codex' : 'claude';
      const imported: Session[] = [], existing: string[] = [], failed: { id: string; message: string }[] = [];
      for (const conversationId of args.ids as string[]) {
        const found = previewImportables[source].find(item => item.id === conversationId);
        const already = sessions.find(task => task.provider === source && task.resumeId === conversationId);
        if (already) { existing.push(already.id); continue; }
        if (!found || found.folder.startsWith('/missing')) { failed.push({ id: conversationId, message: 'Its folder no longer exists on this computer.' }); continue; }
        let project = projects.find(p => p.path === found.folder);
        if (!project) { project = { id: crypto.randomUUID(), name: found.folder.split('/').pop()!, path: found.folder }; projects.push(project); }
        const created = await invoke<Session>('create_session', { projectId: project.id, provider: source, model: found.model ?? args.model, mode: 'full' });
        const task = session(created.id);
        Object.assign(task, { resumeId: conversationId, title: found.title, taskStage: 'in_progress', createdAt: found.updatedAt - 600000, updatedAt: found.updatedAt, lastPromptAt: found.updatedAt - 600000, lastResponseAt: found.updatedAt });
        messages[task.id] = [{ id: ++id, sessionId: task.id, role: 'user', content: `Imported: ${found.title}`, createdAt: found.updatedAt - 600000 }, { id: ++id, sessionId: task.id, role: 'assistant', content: 'This conversation was imported into PandaCode.', createdAt: found.updatedAt }];
        imported.push(taskSummary(task));
      }
      if (imported.length) emit('sessions-changed', undefined);
      result = { imported, existing, failed }; break;
    }
    case 'discard_draft': {
      const task = sessions.find(item => item.id === args.sessionId);
      if (!task) { result = false; break; }
      settleDraft(task);
      if (!task.draft || (messages[task.id] ?? []).length) { result = false; break; }
      sessions = sessions.filter(item => item.id !== task.id); delete messages[task.id]; architect.remove([task.id]);
      result = true; break;
    }
    case 'pin_session': {
      const task = session(args.sessionId);
      if (typeof args.pinned !== 'boolean') throw new Error('Choose whether to pin this task.');
      saveThreadOrder(sessions.map(item => ({ ...threadOrder(item), ...(item.id === task.id ? { pinned: args.pinned } : {}) })));
      emit('sessions-changed', undefined);
      result = task; break;
    }
    case 'reorder_sessions': {
      const ids: unknown = args.sessionIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Choose between 1 and 500 different tasks to reorder.');
      const tasks = ids.map(id => session(id));
      if (tasks.some(task => Boolean(task.pinned) !== Boolean(tasks[0].pinned))) throw new Error('Reorder tasks within the same group.');
      const selected = new Set(ids), order = [...sessions].sort(compareThreadOrder);
      let index = 0;
      const reordered = order.map(task => selected.has(task.id) ? tasks[index++] : task);
      saveThreadOrder(reordered.map((task, sidebarOrder) => ({ ...threadOrder(task), sidebarOrder })));
      emit('sessions-changed', undefined);
      result = reordered.map(taskSummary); break;
    }
    case 'get_task': result = settleDraft(session(args.sessionId)); break;
    case 'list_providers': result = args.deviceId ? remoteProviders() : providers; break;
    case 'provider_check_connection': result = { installed: true, acpReady: true, sessionReady: true, state: 'ready', message: 'Sample connection check. No prompt sent.' }; break;
    case 'list_slash_commands': result = slashCatalog(session(args.sessionId).provider); break;
    case 'resolve_slash_command': result = resolveSlash(session(args.sessionId).provider, String(args.text)); break;
    case 'list_agent_integrations': result = { servers: [{ name: 'Preview documentation', description: 'Sample MCP integration', status: 'ready', authStatus: 'not required', tools: [{ name: 'search_docs', description: 'Search sample documentation.' }] }], skills: [{ name: 'Project guidelines', description: 'Sample skill', status: 'enabled' }], apps: [], warnings: [] }; break;
    case 'list_app_tools': result = [{ name: 'pandacode_list_tasks', description: 'List project tasks.' }, { name: 'pandacode_code_search', description: 'Search the checkout with the local codedb index.' }, { name: 'pandacode_open_browser', description: 'Open a URL in the app browser.' }]; break;
    case 'run_turn_checks': result = { checked: false, reason: 'Browser preview has no project checks.' }; break;
    case 'agent_ui_request_active': result = true; break;
    case 'resolve_agent_ui_action': break;
    case 'open_external_url': { const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.'); window.open(url.href, '_blank', 'noopener,noreferrer'); break; }
    case 'open_support': window.open('https://github.com/aicodeking/pandacode/issues', '_blank', 'noopener,noreferrer'); break;
    case 'local_sign_app': break;
    case 'app_update_install_supported': result = true; break;
    case 'support_details': result = { version: 'Preview', platform: 'Browser preview', architecture: 'Not reported' }; break;
    case 'browser_inspect': result = args.action === 'read' ? { url: browserState.url, title: browserState.title, text: 'Browser preview sample page', elements: [] } : { dispatched: true }; break;
    case 'list_provider_models': result = args.deviceId ? remoteCatalog(args.provider as ProviderId) : args.provider === 'opencode' ? previewOpenCodeChoices() : catalogs[args.provider as ProviderId] ?? []; break;
    case 'list_opencode_models': result = {models: openCodePreviewModels, selectedModelIds: previewOpenCodeSelection(), error: null}; break;
    case 'save_opencode_models': {
      if (!Array.isArray(args.modelIds) || args.modelIds.length > 100 || args.modelIds.some((id: unknown) => typeof id !== 'string' || !id.includes('/') || id.length > 200)) throw new Error('Choose valid OpenCode models.');
      result = [...new Set(args.modelIds)];
      localStorage.setItem(openCodePreviewKey, JSON.stringify(result));
      emit('provider-models-changed', {provider:'opencode'});
      window.dispatchEvent(new Event('pandacode-preview-models-changed'));
      break;
    }
    case 'add_project': { const p = { id: crypto.randomUUID(), name: args.path.split('/').pop() || 'Project', path: args.path }; projects.push(p); result = p; break; }
    case 'remove_project': architect.remove(sessions.filter(s => s.projectId === args.projectId).map(s => s.id)); projects = projects.filter(p => p.id !== args.projectId); break;
    case 'delete_session': {
      const task = session(args.sessionId); assertIdle(task);
      if (architect.isActive(task.id)) throw new Error('Stop the team before deleting this task.');
      if (task.goalState?.status === 'active') throw new Error('Pause the goal before deleting this task.');
      const deletedSessionIds = [...new Set([task.id, ...(architect.get(task.id)?.workers.map(worker => worker.sessionId) ?? [])])];
      for (const id of deletedSessionIds) { const worker = sessions.find(task => task.id === id); if (worker) assertIdle(worker); }
      architect.remove(deletedSessionIds);
      turnChanges.remove(deletedSessionIds);
      sessions = sessions.filter(task => !deletedSessionIds.includes(task.id));
      saveThreadOrder(sessions.map(threadOrder));
      for (const id of deletedSessionIds) delete messages[id];
      emit('sessions-deleted', { sessionIds: deletedSessionIds }); emit('sessions-changed', undefined);
      result = { deletedSessionIds }; break;
    }
    case 'create_session': { const s: Session = { id: crypto.randomUUID(), ...args, pinned: false, sidebarOrder: null, draft: Boolean(args.draft), mode: args.mode ?? 'full', title: 'New conversation', status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), archived: false, worktreePath: null, resumeId: null, lastResponseAt: null, lastPromptAt: null, reasoningEffort: null, contextUsage: null, taskStage: 'pending', taskDescription: '', completedAt: null } as Session; sessions.unshift(s); messages[s.id] = []; architect.inherit(s.id); result = s; break; }
    case 'chat_create': {
      const project = { id: crypto.randomUUID(), name: 'Chat', path: `/Users/you/PandaCode Chats/chat-${crypto.randomUUID().slice(0, 8)}` }; projects.push(project);
      result = await invoke<Session>('create_session', { projectId: project.id, provider: args.provider, model: args.model, mode: args.mode }); break;
    }
    case 'chat_cleanup': {
      const chat = projects.some(p => p.id === args.projectId && p.path.includes('/PandaCode Chats/')) && !sessions.some(s => s.projectId === args.projectId);
      if (chat) projects = projects.filter(p => p.id !== args.projectId);
      result = chat; break;
    }
    case 'create_board_task': {
      const details = taskDetails(args.title, args.description);
      if (!projects.some(p => p.id === args.projectId)) throw new Error('Project not found.');
      if (!providers.some(p => p.id === args.provider) || typeof args.model !== 'string' || args.model.length > 200) throw new Error('Invalid harness or model.');
      if (!['ask', 'auto', 'plan', 'full'].includes(args.mode)) throw new Error('Unknown permission mode.');
      const s = await invoke<Session>('create_session', { projectId: args.projectId, provider: args.provider, model: args.model, mode: args.mode });
      Object.assign(session(s.id), details);
      result = session(s.id); break;
    }
    case 'update_task_details': {
      const s = session(args.sessionId); assertIdle(s);
      if (s.archived) throw new Error('Restore this task before editing it.');
      Object.assign(s, taskDetails(args.title, args.description), { updatedAt: Date.now() }); result = s; break;
    }
    case 'set_task_stage': {
      const s = session(args.sessionId); assertIdle(s);
      if (s.archived) throw new Error('Restore this task before changing its stage.');
      const stage = args.stage as TaskStage;
      // Like the native store: work in progress only by undoing the completion of a stopped run.
      const undoing = s.taskStage === 'completed' && ['error', 'interrupted'].includes(s.status);
      if (!['pending', 'review', 'completed'].includes(stage) && !(stage === 'in_progress' && undoing)) throw new Error('Start the task to move it to work in progress.');
      s.completedAt = stage === 'completed' ? s.completedAt ?? Date.now() : null;
      s.taskStage = stage; s.updatedAt = Date.now(); result = s; break;
    }
    case 'start_task': {
      const s = session(args.sessionId);
      await invoke('send_message', { sessionId: s.id, text: s.taskDescription?.trim() || s.title }); break;
    }
    case 'update_session': {
      const s = session(args.sessionId);
      if (args.archived === false && s.archived && s.taskStage === 'completed') s.completedAt = Date.now();
      Object.assign(s, Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'sessionId')), { updatedAt: Date.now() }); break;
    }
    case 'set_reasoning_effort': {
      const s = session(args.sessionId);
      if (s.status === 'running' || s.status === 'waiting' || timers.has(s.id)) throw new Error('Stop the agent before changing reasoning effort.');
      const effort = args.reasoningEffort ?? null;
      const team = architect.get(s.id);
      if (team && (team.round > 0 || team.workers.length) && effort !== (s.reasoningEffort ?? null)) throw new Error('This run keeps its architect model and reasoning effort. Start a new task to change them.');
      const supported = catalogs[s.provider].find(model => model.id === (s.model || 'default'))?.reasoningEfforts ?? [];
      if (effort !== null && !supported.some(option => option.id === effort)) throw new Error('This model does not support that reasoning effort.');
      s.reasoningEffort = effort; s.updatedAt = Date.now(); result = s; break;
    }
    case 'configure_session': {
      const s = session(args.sessionId);
      if (!providers.some(p => p.id === args.provider) || typeof args.model !== 'string' || args.model.length > 200) throw new Error('Invalid harness or model.');
      const projectId = args.projectId ?? s.projectId;
      if (!projects.some(p => p.id === projectId)) throw new Error('Project not found.');
      if (s.worktreePath && projectId !== s.projectId) throw new Error('A worktree task must stay in its original project.');
      if (s.status === 'running' || s.status === 'waiting' || timers.has(s.id)) throw new Error('Stop the agent before changing its project, harness, or model.');
      const team = architect.get(s.id);
      if (team && (team.round > 0 || team.workers.length) && (args.provider !== s.provider || args.model !== s.model)) throw new Error('This run keeps its architect model. Start a new task to change it.');
      if (projectId !== s.projectId && (s.resumeId !== null || messages[s.id]?.length)) throw new Error('Start a new task to change its project or harness after a conversation has started.');
      if (args.provider !== s.provider || (args.model || 'default') !== (s.model || 'default')) { s.reasoningEffort = null; s.contextUsage = null; }
      if (args.provider !== s.provider) {
        if (s.resumeId || messages[s.id]?.some(message => ['user', 'assistant', 'coordination'].includes(message.role))) (messages[s.id] ??= []).push({ id: ++id, sessionId: s.id, role: 'handoff', content: JSON.stringify({ fromProvider: s.provider, toProvider: args.provider, summary: 'Switched harness. The next message includes up to 200 recent conversation entries (64 KiB). Files and project stay in place. Older text may be shortened; private reasoning, native tool state, and image contents are not transferred. Reattach images if needed.' }), createdAt: Date.now() });
        s.resumeId = null; s.goalState = null; s.codexSettings = null;
      }
      s.projectId = projectId; s.provider = args.provider; s.model = args.model; s.updatedAt = Date.now(); result = s; break;
    }
    case 'get_messages': {
      const synced = mirrorSynced.get(args.sessionId);
      const history = (messages[args.sessionId] ?? []).filter(message => synced == null || message.id <= synced);
      const current = session(args.sessionId).provider;
      const eligible = history.filter(m => args.beforeId == null || m.id < args.beforeId);
      result = { messages: eligible.slice(-100).map(message => message.role === 'assistant'
        ? { ...message, authorProvider: historicalProvider(message, history, current) } : message), hasOlder: eligible.length > 100 } satisfies MessagePage;
      break;
    }
    case 'send_message': {
      if (resolveSlash(session(args.sessionId).provider, String(args.text)).action) throw new Error('This command opens a PandaCode control.');
      const s = session(args.sessionId), w = window as any; assertIdle(s);
      if (w.__remoteRefuse && s.remoteDevice) throw new Error(w.__remoteRefuse);
      if (w.__remoteSendHold && s.remoteDevice) await new Promise<void>(resolve => { w.__remoteSendRelease = () => { w.__remoteSendHold = false; resolve(); }; });
      let moodboardContext = '';
      for (const boardId of args.moodboardIds ?? []) {
        const board = await invoke<import('./moodboards').MoodboardDetail>('read_moodboard', { projectId: s.projectId, boardId });
        moodboardContext += `\n\nMoodboard: ${board.name} (ID: ${board.id}). Use pandacode_read_moodboard and pandacode_read_moodboard_image to see these visual references.`;
      }
      if (architect.get(s.id)) { architect.start(s.id, String(args.text) + moodboardContext, args.imageIds); break; }
      if (s.archived) throw new Error('Restore this task before starting it.');
      if (s.taskStage === 'completed') throw new Error('Reopen this task before starting it.');
      const text = typeof args.text === 'string' ? args.text.trim() + moodboardContext : '';
      if (!text) throw new Error('Write a message first.');
      if (new TextEncoder().encode(text).length > 128 * 1024) throw new Error('Message and attached context must be under 128 KiB.');
      s.status = 'running'; s.taskStage = 'in_progress'; s.completedAt = null; s.updatedAt = Date.now(); s.lastPromptAt = s.updatedAt; s.limitedAt = null; s.limitedUntil = null; s.resumeAtReset = false; if (s.title === 'New conversation') s.title = text.slice(0, 48); messages[s.id] ??= []; messages[s.id].push({ id: ++id, sessionId: s.id, role: 'user', content: text, createdAt: Date.now() });
      if (s.id === BRIEF_ID) { replayBrief(s); break; }
      agent({ sessionId: s.id, kind: 'status', text: 'Previewing response' });
      const tool: ToolActivity = { id: `preview-tool-${crypto.randomUUID()}`, name: 'Bash', status: 'running', input: 'npm test -- --runInBand', output: '' };
      const toolMessage: Message = { id: ++id, sessionId: s.id, role: 'tool', content: encodeTool(tool), createdAt: Date.now() };
      messages[s.id].push(toolMessage);
      activeTools.set(s.id, { activity: tool, message: toolMessage });
      agent({ sessionId: s.id, kind: 'tool', text: 'Bash', tool: { ...tool } });
      const output = 'This is the browser preview. Your task and conversation are saved in this preview session, but no agent or shell is running here.\n\nOpen the native PandaCode app to work with your files using Claude Code, Codex, or Kimi Code. The desktop app connects to the CLI tools installed on your machine.';
      let cursor = 0;
      const tick = () => {
        const next = output.slice(cursor, cursor + 13); cursor += 13;
        if (next.trim()) s.lastResponseAt = Date.now();
        agent({ sessionId: s.id, kind: 'text', text: next });
        if (tool.status === 'running' && cursor >= 130) {
          tool.status = 'completed'; tool.output = sampleTestOutput;
          toolMessage.content = encodeTool(tool);
          agent({ sessionId: s.id, kind: 'tool', text: 'Bash completed', tool: { ...tool } });
          activeTools.delete(s.id);
        }
        if (cursor < output.length) timers.set(s.id, window.setTimeout(tick, 24)); else finish(s.id, output);
      };
      timers.set(s.id, window.setTimeout(tick, 200)); break;
    }
    case 'stop_session': {
      if (architect.isActive(args.sessionId)) { result = architect.control(args.sessionId, 'stop'); break; }
      const w = window as any;
      if (w.__stopHold) await new Promise<void>(resolve => { w.__stopRelease = () => { w.__stopHold = false; resolve(); }; });
      window.clearTimeout(timers.get(args.sessionId)); timers.delete(args.sessionId);
      finishTiming(args.sessionId);
      const pending = activeTools.get(args.sessionId);
      if (pending) {
        pending.activity.status = 'failed'; pending.activity.output = 'Canceled before completion (browser preview). No command was executed.';
        pending.message.content = encodeTool(pending.activity);
        agent({ sessionId: args.sessionId, kind: 'tool', text: 'Bash canceled', tool: { ...pending.activity } });
        activeTools.delete(args.sessionId);
      }
      const stopped = session(args.sessionId); stopped.status = 'idle'; if (stopped.goalState?.status === 'active') { stopped.goalState.status = 'paused'; emitGoal(stopped); } syncMirror(args.sessionId); agent({ sessionId: args.sessionId, kind: 'done', text: 'Stopped' }); break;
    }
    case 'respond_approval': case 'respond_user_input': break;
    case 'git_status': result = checkoutGit(args.sessionId); break;
    case 'git_diff': result = `diff --git a/${args.path ?? 'src/components/search.ts'} b/${args.path ?? 'src/components/search.ts'}\nindex 64d221a..0e6c9ef 100644\n--- a/${args.path ?? 'src/components/search.ts'}\n+++ b/${args.path ?? 'src/components/search.ts'}\n@@ -12,5 +12,6 @@ export function mountSearch(items) {\n+  const index = createSearchIndex(items);\n+\n   input.addEventListener("input", () => {\n-    const index = createSearchIndex(items);\n-    renderAll(index.search(input.value));\n+    renderResults(index.search(input.value));\n   });\n }`; break;
    case 'git_stage': checkoutGit(args.sessionId).files.forEach(file => { if (args.paths.includes(file.path)) { file.index = args.staged ? 'M' : ' '; file.working = args.staged ? ' ' : 'M'; } }); break;
    case 'git_commit': {
      const checkout = checkoutGit(args.sessionId);
      if (!checkout.files.some(file => file.index !== ' ' && file.index !== '?')) throw new Error('Stage changes before committing.');
      checkout.files = checkout.files.filter(file => file.index === ' ' || file.index === '?'); result = 'Preview commit created'; break;
    }
    case 'create_worktree': {
      const source = session(args.sessionId);
      const worktree = previewWorktree(source, args);
      const created: Session = { ...source, id: crypto.randomUUID(), pinned: false, sidebarOrder: null, worktreePath: worktree.path, worktreeBranch: worktree.branch, title: 'New conversation', mode: 'full', status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), archived: false, resumeId: null, lastResponseAt: null, lastPromptAt: null, contextUsage: null, taskStage: 'pending', taskDescription: '', completedAt: null, issue: null, pullRequest: null };
      sessions.unshift(created); messages[created.id] = []; architect.inherit(created.id); result = created; break;
    }
    case 'attach_worktree': {
      const s = session(args.sessionId);
      if (s.worktreePath || s.resumeId || (messages[s.id] ?? []).length || s.status === 'running' || s.status === 'waiting') throw new Error('This conversation already started. Create a new task in a worktree instead.');
      const worktree = previewWorktree(s, args);
      Object.assign(s, { worktreePath: worktree.path, worktreeBranch: worktree.branch, updatedAt: Date.now() }); result = s; break;
    }
    case 'git_branches': { const checkout = checkoutGit(args.sessionId); result = { current: checkout.branch, defaultBranch: 'main', branches: [...new Set([checkout.branch, 'main', 'release/1.4', ...previewBranches])].filter(Boolean) }; break; }
    case 'git_switch_branch': {
      if (args.sessionId && session(args.sessionId).worktreePath) throw new Error('This task works in its own worktree; its branch stays as it is.');
      const checkout = checkoutGit(args.sessionId), branches = [...new Set([checkout.branch, 'main', 'release/1.4', ...previewBranches])].filter(Boolean);
      if (!branches.includes(String(args.branch))) throw new Error(`There is no local branch named ${args.branch}.`);
      checkout.branch = String(args.branch);
      result = { current: checkout.branch, defaultBranch: 'main', branches }; break;
    }
    case 'worktree_status': {
      const s = session(args.sessionId); if (!s.worktreePath) throw new Error('This task uses the main checkout.');
      const checkout = worktreeGit.get(s.worktreePath);
      result = checkout ? { exists: true, branch: checkout.branch, changes: checkout.files.length, clean: !checkout.files.length, hasUpstream: pushedBranches.has(checkout.branch), ahead: pushedBranches.has(checkout.branch) ? 0 : 1, merged: mergedBranches.has(checkout.branch) } : { exists: false, branch: s.worktreeBranch ?? '', changes: 0, clean: true, hasUpstream: false, ahead: 0, merged: false };
      break;
    }
    case 'merge_worktree': {
      const s = session(args.sessionId); if (!s.worktreePath) throw new Error('This task uses the main checkout.');
      assertIdle(s);
      const checkout = worktreeGit.get(s.worktreePath); if (!checkout) throw new Error('The worktree folder is missing; recreate it first.');
      if (checkout.files.length) throw new Error('The worktree has uncommitted changes. Commit or discard them first; only committed work is merged.');
      const commits = mergedBranches.has(checkout.branch) ? 0 : 1;
      mergedBranches.add(checkout.branch);
      result = { branch: checkout.branch, target: 'main', commits, switchedFrom: null }; break;
    }
    case 'remove_worktree': {
      const s = session(args.sessionId); if (!s.worktreePath) throw new Error('This task uses the main checkout.');
      assertIdle(s);
      const checkout = worktreeGit.get(s.worktreePath), branch = checkout?.branch ?? s.worktreeBranch ?? '';
      if (checkout?.files.length) throw new Error(`fatal: '${s.worktreePath}' contains modified or untracked files, use --force to delete it`);
      worktreeGit.delete(s.worktreePath);
      const deletable = args.deleteBranch && mergedBranches.has(branch);
      if (deletable) previewBranches.delete(branch);
      result = { removed: Boolean(checkout), branch, branchDeleted: Boolean(deletable), note: args.deleteBranch && !deletable && branch ? `Branch ${branch} was kept: error: the branch '${branch}' is not fully merged` : '' }; break;
    }
    case 'recreate_worktree': {
      const s = session(args.sessionId); if (!s.worktreePath) throw new Error('This task uses the main checkout.');
      if (worktreeGit.has(s.worktreePath)) throw new Error('The worktree folder already exists.');
      if (!s.worktreeBranch || !previewBranches.has(s.worktreeBranch)) throw new Error('The worktree\u2019s branch is unknown; create a new worktree instead.');
      worktreeGit.set(s.worktreePath, { branch: s.worktreeBranch, isRepo: true, files: [] }); result = s; break;
    }
    case 'git_push': { const checkout = checkoutGit(args.sessionId); pushedBranches.add(checkout.branch); result = `branch '${checkout.branch}' set up to track 'origin/${checkout.branch}'.`; break; }
    case 'github_status': result = previewGithub.status(args.projectId); break;
    case 'github_repos': result = structuredClone(previewRepos); break;
    // The sample orbit project has an app icon; others show the sidebar's default.
    case 'project_icon': result = args.projectId === 'project-1' ? 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSdnJyB4MT0nMCcgeTE9JzAnIHgyPScxJyB5Mj0nMSc+PHN0b3Agb2Zmc2V0PScwJyBzdG9wLWNvbG9yPScjN2M5Y2ZmJy8+PHN0b3Agb2Zmc2V0PScxJyBzdG9wLWNvbG9yPScjNWI1YmQ2Jy8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nOCcgZmlsbD0ndXJsKCNnKScvPjxjaXJjbGUgY3g9JzE2JyBjeT0nMTYnIHI9JzcnIGZpbGw9J25vbmUnIHN0cm9rZT0nd2hpdGUnIHN0cm9rZS13aWR0aD0nMycvPjxjaXJjbGUgY3g9JzIzJyBjeT0nOScgcj0nMi41JyBmaWxsPSd3aGl0ZScvPjwvc3ZnPg==' : null; break;
    case 'github_repo_pulls': result = previewHub.pulls(String(args.repo)); break;
    case 'github_repo_issues': result = previewHub.issues(String(args.repo)); break;
    case 'github_repo_runs': result = previewHub.runs(String(args.repo)); break;
    case 'github_run_details': result = previewHub.runDetails(String(args.repo), Number(args.id)); break;
    case 'github_project_repos': result = projects.filter(p => p.id === 'project-1' || previewClones.has(p.id)).map(p => ({ projectId: p.id, repo: previewClones.get(p.id) ?? 'orbit-labs/orbit' })); break;
    case 'github_clone_repo': {
      const repo = String(args.repo), name = repo.split('/')[1] ?? repo, path = `${String(args.parent).replace(/\/$/, '')}/${name}`;
      if (projects.some(p => p.path === path)) throw new Error(`${path} already exists. Open it as a project instead, or choose another folder.`);
      const added: Project = { id: `project-${++id}`, name, path };
      projects = [...projects, added]; previewClones.set(added.id, repo); result = added; break;
    }
    case 'github_search': result = previewGithub.search(args.projectId, String(args.query ?? '')); break;
    case 'github_issues': result = previewGithub.issues(args.projectId, args.filter ?? {}); break;
    case 'github_resolve': result = previewGithub.resolve(args.projectId, (args.numbers ?? []) as number[]); break;
    case 'github_refresh_links': result = sessions.filter(s => s.projectId === args.projectId).flatMap(s => [s.issue, s.pullRequest].filter(Boolean).map(link => ({ sessionId: s.id, link: previewGithub.refresh(s.projectId, link!) }))); break;
    case 'set_task_link': {
      const s = session(args.sessionId);
      if (!['issue', 'pull'].includes(args.kind)) throw new Error('Unknown link kind.');
      const link = args.link ? { ...args.link, checkedAt: Date.now() } : null;
      if (args.kind === 'pull') s.pullRequest = link; else s.issue = link;
      result = s; break;
    }
    case 'github_create_pull_request': {
      const s = session(args.sessionId), checkout = checkoutGit(s.id), repo = previewGithub.status(s.projectId).repo;
      if (!repo) throw new Error('This project has no GitHub remote.');
      if (checkout.files.length) throw new Error('Commit or stash your changes before opening a pull request. The Changes tab can commit them.');
      if (!checkout.branch || checkout.branch === args.base) throw new Error(`Create a branch other than ${args.base} before opening a pull request.`);
      if (!String(args.title ?? '').trim()) throw new Error('Give the pull request a title of up to 256 characters.');
      pushedBranches.add(checkout.branch);
      const number = previewGithub.nextNumber(s.projectId);
      s.pullRequest = { kind: 'pull', number, url: `${repo.url}/pull/${number}`, title: String(args.title).trim(), state: 'open', checkedAt: Date.now() };
      previewGithub.pulls.push({ projectId: s.projectId, number, title: s.pullRequest.title, body: String(args.body ?? ''), base: args.base, head: checkout.branch });
      result = s; break;
    }
    case 'github_pull_request': {
      const s = session(args.sessionId); if (!s.pullRequest) throw new Error('This task has no linked pull request.');
      result = previewGithub.detail(s.projectId, s.pullRequest.number); break;
    }
    case 'github_merge_pull_request': {
      const s = session(args.sessionId); if (!s.pullRequest) throw new Error('This task has no linked pull request.');
      if (!['squash', 'merge', 'rebase'].includes(String(args.method))) throw new Error('Choose squash, merge or rebase.');
      previewGithub.merged.set(`${s.projectId}:${s.pullRequest.number}`, new Date().toISOString());
      s.pullRequest = { ...s.pullRequest, state: 'merged', checkedAt: Date.now() };
      result = s; break;
    }
    case 'github_pull_request_diff': {
      const s = session(args.sessionId); if (!s.pullRequest) throw new Error('This task has no linked pull request.');
      result = { patch: previewGithub.diff, truncated: false }; break;
    }
    case 'github_detect_pull_request': {
      // The sample agent never mentions a PR; tests hook this command to simulate one.
      result = null; break;
    }
    case 'github_link_pull_request': {
      const s = session(args.sessionId), repo = previewGithub.status(s.projectId).repo;
      if (!repo) throw new Error('This project has no GitHub remote.');
      const reference = String(args.reference ?? '').trim();
      const number = /^#?\d+$/.test(reference) ? Number(reference.replace('#', '')) : Number(reference.match(new RegExp(`github\\.com/${repo.nameWithOwner}/pull/(\\d+)`, 'i'))?.[1] ?? NaN);
      if (!(number > 0)) throw new Error(reference.includes('/pull/') ? `That pull request is not in ${repo.nameWithOwner}.` : 'Enter a pull request number or its GitHub URL.');
      const pull = previewGithub.pulls.find(p => p.projectId === s.projectId && p.number === number);
      if (!pull) throw new Error(`Pull request #${number} was not found.`);
      s.pullRequest = { kind: 'pull', number, url: `${repo.url}/pull/${number}`, title: pull.title, state: 'open', checkedAt: Date.now() };
      result = s; break;
    }
    case 'token_saver_tools': result = { rtk: previewRtk, rtkVersion: previewRtk ? '1.0.1' : '', rtkInstall: 'brew install rtk' }; break;
    case 'token_saver_install': {
      if (args.tool !== 'rtk') throw new Error('Unknown tool.');
      await new Promise(resolve => setTimeout(resolve, 500));
      previewRtk = true;
      result = { rtk: true, rtkVersion: '1.0.1', rtkInstall: 'brew install rtk' }; break;
    }
    case 'themes_list': result = previewThemes.list(); break;
    case 'theme_import': result = previewThemes.import(String(args.path ?? '')); break;
    case 'theme_install': result = previewThemes.install(String(args.extensionId ?? '')); break;
    case 'theme_remove': previewThemes.remove(String(args.id ?? '')); result = null; break;
    case 'android_setup': {
      for (const [step, label] of ['Installing Java (openjdk@21)…', 'Installing Android command-line tools…', 'Accepting the Android SDK licenses…', 'Downloading the emulator and Android 15 (about 2 GB)…', 'Creating a Pixel 9 emulator…'].entries()) {
        emit('android-setup', { step: step + 1, total: 5, label, done: false, error: null });
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      emit('android-setup', { step: 5, total: 5, label: 'Android emulator ready', done: true, error: null });
      result = 'Pixel_9_API_35'; break;
    }
    case 'cloud_connections': result = previewCloud.connections(); break;
    case 'cloud_connect': result = previewCloud.connect(args.provider, args.key, args.options ?? {}); emit('vm-changed', {}); break;
    case 'cloud_disconnect': result = previewCloud.disconnect(args.provider); emit('vm-changed', {}); break;
    case 'cloud_setup_sandboxes': result = previewCloud.setupSandboxes(); emit('vm-changed', {}); break;
    case 'cloud_instabox_images': result = previewCloud.instaboxImages(); break;
    case 'cloud_instabox_set_image': result = previewCloud.setInstaboxImage(args.image); break;
    case 'cloud_machines': result = previewCloud.list(); break;
    case 'cloud_create': result = previewCloud.create(args.provider, args.name); break;
    case 'cloud_power': result = previewCloud.power(args.id, args.action); break;
    case 'cloud_frame': result = await previewCloud.frame(args.id); break;
    case 'cloud_input': result = previewCloud.input(args.id, args.input); break;
    case 'vm_status': result = previewVm.status(); break;
    case 'vm_setup': result = previewVm.setup(); break;
    case 'vm_show': result = previewVm.show(args.name); break;
    case 'vm_create': result = previewVm.create(args.image, args.name); break;
    case 'vm_power': result = previewVm.power(args.name, args.action, args.share); break;
    case 'vm_frame': result = await previewVm.frame(args.name); break;
    case 'vm_input': result = previewVm.input(args.name, args.input); break;
    case 'vm_desktop': result = previewVm.desktop(args.name); break;
    case 'design_list': result = previewDesign.list(); break;
    case 'design_read': result = previewDesign.read(args.name); break;
    case 'design_comments': result = previewDesign.comments(); break;
    case 'design_save_comments': result = previewDesign.saveComments(args.comments); break;
    case 'skills_list': case 'skills_import_folder': case 'skills_import_github': case 'skills_activate':
    case 'skills_deactivate': case 'skills_matrix': case 'skills_scan': case 'skills_remove':
    case 'skills_catalogs': case 'skills_catalog_add': case 'skills_catalog_refresh': case 'skills_catalog_state': case 'skills_catalog_import': case 'skills_discover':
      result = previewSkills.call(command, args); break;
    case 'simulator_status': result = previewSimulator.status(); break;
    case 'simulator_pose': result = await previewSimulator.pose(args.udid, args.pose); break;
    case 'simulator_create_duo': result = previewSimulator.createDuo(); break;
    case 'simulator_select': result = previewSimulator.select(args.udid); break;
    case 'simulator_power': result = previewSimulator.power(args.udid, Boolean(args.on)); break;
    case 'simulator_frame': result = await previewSimulator.frame(args.udid, Number(args.after ?? 0)); break;
    case 'simulator_input': result = previewSimulator.input(args.udid, args.input); break;
    case 'simulator_appearance': result = previewSimulator.appearance(args.mode); break;
    case 'simulator_capture': result = await previewSimulator.capture(args.udid); break;
    case 'list_files': result = (args.path ? args.path === 'public' ? [{ name: 'favicon.svg', isDir: false }] : args.path === 'src' ? [{ name: 'components', isDir: true }, { name: 'lib', isDir: true }, { name: 'main.ts', isDir: false }, { name: 'style.css', isDir: false }] : [{ name: 'search.ts', isDir: false }, { name: 'search.test.ts', isDir: false }] : [{ name: 'src', isDir: true }, { name: 'public', isDir: true }, { name: 'index.html', isDir: false }, { name: 'package.json', isDir: false }, { name: 'README.md', isDir: false }, { name: 'tsconfig.json', isDir: false }, { name: 'report.pdf', isDir: false }, { name: 'proposal.docx', isDir: false }, { name: 'budget.xlsx', isDir: false }, { name: 'screenshot.png', isDir: false }]).map(f => ({ ...f, path: [args.path, f.name].filter(Boolean).join('/') })) satisfies FileEntry[]; break;
    case 'search_files': {
      const query = String(args.query ?? '').trim().toLocaleLowerCase().replace(/\/$/, '');
      const files = previewWorkspaceFiles.map(path => ({ path, isDir: false }));
      // Folders join typed queries only, like the native index.
      const folders = query ? ['src', 'src/components', 'src/lib', 'public', 'docs'].map(path => ({ path, isDir: true })) : [];
      result = [...files, ...folders]
        .filter(entry => entry.path.toLocaleLowerCase().includes(query))
        .map(entry => ({ name: entry.path.split('/').pop()!, ...entry }))
        .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(query)) - Number(a.name.toLocaleLowerCase().startsWith(query)) || Number(a.isDir) - Number(b.isDir) || a.path.localeCompare(b.path))
        .slice(0, Math.min(100, Math.max(1, Number(args.limit) || 40))) satisfies FileEntry[];
      break;
    }
    case 'search_text': {
      // Sample source stands in for every script; Markdown files read as the sample README.
      const query = String(args.query ?? '');
      let pattern: RegExp;
      try {
        const source = args.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(args.wholeWord ? `\\b(?:${source})\\b` : source, args.matchCase ? 'g' : 'gi');
      } catch (error) { throw new Error(`Invalid regular expression: ${(error as Error).message}`); }
      const files = previewWorkspaceFiles.filter(path => /\.(ts|md)$/.test(path)).map(path => {
        const lines = (path.endsWith('.md') ? sampleReadme : sampleSource).split('\n');
        const matches = lines.flatMap((line, index) => {
          const text = line.trimStart(), ranges = [...text.matchAll(pattern)].filter(m => m[0]).map(m => [m.index!, m.index! + m[0].length]);
          return ranges.length ? [{ line: index + 1, text, ranges }] : [];
        });
        return { path, matches };
      }).filter(file => file.matches.length);
      result = { files, truncated: false };
      break;
    }
    case 'import_prompt_image': {
      // Any picked or pasted image becomes a small PNG id; the thumbnail is a yellow swatch.
      if (!args.path && !args.dataUrl) throw new Error('Choose an image to attach.');
      const name = String(args.name || String(args.path ?? '').split('/').pop() || 'Image.png');
      if (/\.(svg|gif|heic)$/i.test(name)) throw new Error('Choose a PNG, JPEG or WebP image. HEIC, GIF and SVG are not supported yet.');
      result = { id: crypto.randomUUID(), name, width: 1280, height: 800, thumbnail: String(args.dataUrl ?? '').startsWith('data:image/png') ? args.dataUrl : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
      break;
    }
    // Any registry ID shows the yellow swatch; native reads browser-captures/<id>.png.
    case 'prompt_image': result = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(args.id)) ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' : null; break;
    case 'reveal_path': if (!String(args.path ?? '').startsWith('/')) throw new Error('This attachment is no longer on this computer.'); break;
    case 'read_document': {
      const path = String(args.path ?? ''), name = path.split('/').pop() || 'Document';
      if (!path.startsWith('/')) throw new Error('Choose the document with the picker or drop it onto the message.');
      if (/\.(zip|dmg|bin)$/i.test(name)) throw new Error('No readable text was found in this document. It may be scanned images only.');
      const pdf = /\.pdf$/i.test(name);
      result = { name, path, size: pdf ? 48210 : 1830, method: pdf ? 'spotlight' : /\.(docx?|rtf|odt)$/i.test(name) ? 'textutil' : 'text', truncated: /large/i.test(name), text: pdf ? 'Product brief\n\nGoal: make search feel instant.\nSuccess: results appear while typing, under 100 ms.' : '# Notes\n\nKeyboard shortcuts should mirror the menu bar.' };
      break;
    }
    case 'import_dropped_document': {
      // The desktop stages dropped bytes into a temporary file and runs the same extractors.
      const name = String(args['x-pandacode-file-name'] ?? 'Document');
      if (!/\.(pdf|doc|docx|rtf|odt|pages|key|numbers|ppt|pptx|xls|xlsx|epub)$/i.test(name)) throw new Error('No readable text was found in this document. It may be scanned images only.');
      const pdf = /\.pdf$/i.test(name);
      result = { name, path: name, size: pdf ? 48210 : 1830, method: pdf ? 'spotlight' : 'textutil', truncated: false, text: pdf ? 'Product brief\n\nGoal: make search feel instant.\nSuccess: results appear while typing, under 100 ms.' : '# Brief\n\nExtracted from the dropped file.' };
      break;
    }
    case 'describe_folder': {
      const path = String(args.path ?? '');
      if (!path.startsWith('/')) throw new Error('Choose the folder with the picker or drop it onto the message.');
      if (/\.[a-z0-9]{1,5}$/i.test(path)) throw new Error('This is not a folder.');
      result = { name: path.split('/').pop() || path, path, files: 14, folders: 4, truncated: false, listing: 'src/\n  components/\n    Button.tsx\n    Card.tsx\n  main.ts\npublic/\n  favicon.svg\nREADME.md\npackage.json' };
      break;
    }
    case 'resolve_workspace_files': {
      const root = (args.sessionId ? session(args.sessionId).worktreePath : undefined) || projects.find(project => project.id === args.projectId)?.path;
      result = (args.paths as string[]).slice(0, 32).flatMap(input => {
        let path = input.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '').replace(/^\.\//, '');
        if (path.startsWith('file://')) { try { path = decodeURIComponent(new URL(path).pathname); } catch { return []; } }
        if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
        const matches = previewWorkspaceFiles.filter(file => file === path || (!path.includes('/') && file.endsWith('/' + path)));
        return matches.length === 1 ? [{ input, path: matches[0], previewable: isPreviewableFile(matches[0]) }] : [];
      }); break;
    }
    case 'prepare_file_preview': {
      const path = String(args.path);
      if (!previewWorkspaceFiles.includes(path) || !isPreviewableFile(path)) throw new Error('This file cannot be previewed in the browser.');
      result = { path, name: path.split('/').pop(), url: 'http://127.0.0.1:4179/preview/' + encodeURIComponent(args.sessionId ?? args.projectId) + '/' + path.split('/').map(encodeURIComponent).join('/') }; break;
    }
    case 'workspace_image': {
      // A drawn stand-in for any workspace image a question shows.
      if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(String(args.path)) || String(args.path).includes('..')) throw new Error('Only workspace images can be shown');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#2e513b"/><stop offset="1" stop-color="#ffd43b"/></linearGradient></defs><rect width="320" height="180" rx="12" fill="url(#g)"/><text x="160" y="96" fill="#fffcef" font-family="sans-serif" font-size="18" text-anchor="middle">${String(args.path).split('/').pop()}</text></svg>`;
      result = `data:image/svg+xml;base64,${btoa(svg)}`; break;
    }
    // Sample documents are the test fixtures, served by the dev server.
    case 'read_document_file': {
      const sample = ({ pdf: 'sample.pdf', docx: 'sample.docx', xlsx: 'sample.xlsx', png: 'sample.png', svg: 'sample.svg' } as Record<string, string>)[String(args.path).split('.').pop()!.toLowerCase()];
      const response = sample && await fetch(`/tests/fixtures/${sample}`);
      if (!response || !response.ok) throw new Error('Only PDF, Word (.docx) and spreadsheet files can be shown');
      result = await response.arrayBuffer();
      break;
    }
    // Like `Store::workspace_root`: a task on another computer has no checkout here.
    case 'read_file': { const mirror = args.sessionId ? sessions.find(s => s.id === args.sessionId)?.remoteDevice : null; if (mirror) throw new Error(`This task runs on ${mirror.name}.`); }
      result = /\.(md|markdown)$/i.test(args.path) ? sampleReadme : args.path.endsWith('.json') ? '{\n  "name": "orbit",\n  "private": true,\n  "type": "module"\n}' : args.path.endsWith('.html') ? '<!doctype html>\n<html><head><title>Orbit</title></head><body><h1>Orbit</h1></body></html>' : args.path.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>' : sampleSource; break;
    case 'get_metrics': result = { coreRssBytes: 0, activeAgents: timers.size, activeTerminals: 0, databaseBytes: 0 }; break;
    case 'get_terminal_activity': result = { running: false, processNames: [], uncertain: false }; break;
    case 'get_run_script': result = null; break;
    case 'get_run_script_preview': result = null; break;
    case 'get_terminal_preferences': result = {}; break;
    case 'start_run_script_terminal':
    case 'start_harness_terminal': case 'start_terminal': {
      const terminalId = 'preview-terminal-' + crypto.randomUUID(); result = terminalId;
      window.setTimeout(() => emit('terminal-event', { terminalId, data: '\x1b[38;5;108mPandaCode browser preview\x1b[0m\r\nA real PTY is available in the desktop app.\r\n\r\n$ ' }), 100); break;
    }
    case 'write_terminal': emit('terminal-event', { terminalId: args.terminalId, data: args.data === '\r' ? '\r\nPreview mode — no commands executed.\r\n$ ' : args.data }); break;
    case 'resize_terminal': case 'close_terminal': break;
    default: throw new Error(`Unknown preview command: ${command}`);
  }
  return structuredClone(result) as T;
}
