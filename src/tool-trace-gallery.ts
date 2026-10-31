// Dev-only review page (tool-trace-gallery.html, not in the production build): every tool family's row and card.
// ?theme=dark switches theme; ?collapsed=1 leaves groups and rows closed.
import './styles.css';
import './tool-trace.css';
import './tool-cards.css';
import type { ToolActivity } from './types';
import { escape } from './dom.ts';
import { renderToolGroup } from './tool-activity.ts';

type Case = { verb: string; name: string; input?: unknown; output?: unknown; status?: ToolActivity['status'] };
const j = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
const A = 'mcp__pandacode_architect__pandacode_';

const FAMILIES: [string, Case[]][] = [
  ['Team', [
    { verb: 'Dispatched', name: A + 'dispatch_workers', input: { assignments: [
      { key: 'ui', name: 'Trace visualizations', provider: 'claude', model: 'opus', prompt: 'Render every tool call as a readable row and card.', files: ['src/tool-trace.ts', 'src/tool-trace.css', 'src/tool-activity.ts', 'src/subagents.ts', 'tests/tool-trace.test.mjs'] },
      { key: 'rust', name: 'Native schema audit', profileId: 'codex-high', reasoningEffort: 'high', prompt: 'List every pandacode_* schema.', files: ['src-tauri/src'], readOnly: true, dependsOn: ['ui'] },
    ] }, output: { workerIds: [{ workerId: 'w1', status: 'running' }, { workerId: 'w2', status: 'queued' }], queued: true } },
    { verb: 'Sent message to', name: 'pandacode_send_team_message', input: { recipient: 'worker-2', key: 'k1', message: 'Please leave src/preview.ts to me; I am adding the gallery data there.' }, output: { messageId: 4, saved: true, duplicate: false } },
    { verb: 'Checked mailbox', name: 'pandacode_read_team_mailbox', output: { messages: [{ id: 1, sender: 'architect', recipient: 'worker-1', message: 'Keep files under 800 lines.', createdAt: 1761550000 }, { id: 2, sender: 'worker-2', recipient: 'worker-1', message: 'Schemas are in agent_tools.rs and architect.rs.', createdAt: 1761550300 }], nextCursor: 2, hasMore: false } },
    { verb: 'Read team directory', name: 'pandacode_team_directory', output: { you: 'w1', workers: [{ id: 'w1', name: 'Trace visualizations', status: 'running', files: ['src/tool-trace.ts'] }, { id: 'w2', name: 'Native audit', status: 'completed', readOnly: true, files: [] }] } },
    { verb: 'Checked', name: 'pandacode_list_workers', output: { status: 'running', round: 1, maxRounds: 3, workers: [{ id: 'w1', name: 'Trace visualizations', status: 'completed', summary: 'Catalog, cards and gallery done.' }, { id: 'w2', name: 'Native audit', status: 'failed', error: 'Timed out reading providers.rs' }] } },
    { verb: 'Saved checkpoint', name: 'pandacode_checkpoint_worker', input: { key: 'c1', summary: 'Catalog written, tests green.', nextSteps: 'Polish CSS and screenshots.', blocker: 'playwright.config.ts testMatch is outside my scope.' } },
    { verb: 'Finished team', name: 'pandacode_finish_team', input: { summary: 'Shipped PandaCode tool traces.\n\n- 80 tools have specific rows\n- Subagent and MCP cards show prompts and arguments' } },
    { verb: 'Cancelled', name: 'pandacode_cancel_worker', status: 'running', input: { workerId: 'w2', reason: 'Superseded by the native audit in w3.' } },
  ]],
  ['Tasks', [
    { verb: 'Created task', name: 'pandacode_create_task', input: { title: 'Polish onboarding', description: 'Tighten copy on the welcome screen.' }, output: { id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', title: 'Polish onboarding', provider: 'claude', model: 'sonnet', status: 'idle', stage: 'pending' } },
    { verb: 'Listed tasks', name: 'pandacode_list_tasks', output: { tasks: [{ id: 't1', title: 'Fix sidebar drag', status: 'running', stage: 'in_progress' }, { id: 't2', title: 'Release 0.3.33', status: 'idle', stage: 'review' }, { id: 't3', title: 'Cloud agents docs', status: 'idle', stage: 'completed' }], nextOffset: null } },
    { verb: 'Steered', name: 'pandacode_steer_task', input: { taskId: 't1', text: 'Use morph() instead of replacing the list.' }, output: { delivered: true } },
    { verb: 'Moved', name: 'pandacode_set_task_stage', input: { taskId: 't2', stage: 'review' }, output: { id: 't2', title: 'Release 0.3.33', stage: 'review' } },
    { verb: 'Created worktree', name: 'pandacode_create_worktree', input: { branch: 'pandacode/trace-gallery' } },
  ]],
  ['Machines', [
    { verb: 'Listed machines', name: 'pandacode_vm_list', output: { engine: 'Tart installed', vms: [{ name: 'macos-vm', running: true, diskGb: 50 }, { name: 'ubuntu-dev', running: false, diskGb: 20 }], cloud: [{ id: 'daytona:abc', name: 'sandbox-1', provider: 'daytona', state: 'running', os: 'linux', desktop: true }] } },
    { verb: 'Took screenshot of', name: 'pandacode_vm_screenshot', input: { name: 'macos-vm' }, output: 'Screenshot 1280×800' },
    { verb: 'Clicked', name: 'pandacode_vm_control', input: { name: 'macos-vm', action: 'click', x: 420, y: 88 } },
    { verb: 'Scrolled', name: 'pandacode_vm_control', input: { name: 'macos-vm', action: 'scroll', direction: 'down', x: 640, y: 400, amount: 6 } },
    { verb: 'Ran', name: 'pandacode_vm_exec', input: { name: 'ubuntu-dev', command: 'npm ci && npm test' }, output: { exitCode: 0, stdout: 'added 812 packages\n# pass 131\n# fail 0', stderr: '' } },
    { verb: "Couldn't create", name: 'pandacode_vm_manage', status: 'failed', input: { action: 'create', name: 'fedora-box', image: 'fedora' }, output: 'Not enough free disk space for fedora (needs 5 GB).' },
    { verb: 'Listed simulators', name: 'pandacode_simulator_devices', output: { shown: 'A1', touchInput: 'available', devices: [{ udid: 'A1', name: 'iPhone 17 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', state: 'Booted' }, { udid: 'android:emulator-5554', name: 'Pixel 9', runtime: 'Android 16', state: 'Shutdown' }] } },
    { verb: 'Typed', name: 'pandacode_simulator_control', input: { action: 'type', text: 'hello@example.com' } },
  ]],
  ['Design & preview', [
    { verb: 'Wrote artboard', name: 'pandacode_design_write', input: { name: 'Login.html', html: '<!doctype html>\n<title>Login</title>\n<style>body{margin:0}</style>\n<main>…</main>' }, output: { saved: '.pandacode/design/Login.html' } },
    { verb: 'Listed artboards', name: 'pandacode_design_list', output: { folder: '.pandacode/design', artboards: [{ name: 'Login.html', path: '.pandacode/design/Login.html', size: 4210, modified: 1 }, { name: 'Home.html', path: '.pandacode/design/Home.html', size: 18800, modified: 1 }], openComments: 2 } },
    { verb: 'Read design comments', name: 'pandacode_design_comments', input: { status: 'open' }, output: { comments: [{ id: 'c1', artboard: 'Login.html', selector: 'main > button', text: 'Make the button full width on phones.', status: 'open' }] } },
    { verb: 'Opened preview', name: 'pandacode_open_browser', input: { url: 'http://127.0.0.1:1420/' }, output: { url: 'http://127.0.0.1:1420/', title: 'PandaCode', loading: false } },
    { verb: 'Opened preview', name: 'pandacode_preview_file', input: { path: 'tool-trace-gallery.html' } },
    { verb: 'Listed local servers', name: 'pandacode_list_local_servers', output: [{ port: 1420, process: 'node', url: 'http://127.0.0.1:1420' }, { port: 5432, process: 'postgres', url: 'http://127.0.0.1:5432' }] },
  ]],
  ['Code, cloud & bots', [
    { verb: 'Ran', name: 'pandacode_cloud_cli', input: { tool: 'wrangler', args: 'deploy --env production' }, output: { exitCode: 0, stdout: 'Uploaded panda-site (2.31 sec)\nDeployed panda-site triggers\n  https://panda-site.example.workers.dev', stderr: '', truncated: false } },
    { verb: 'Searched code', name: 'pandacode_code_search', input: { query: 'renderToolActivity' }, output: { query: 'renderToolActivity', symbols: false, truncated: false, results: 'src/tool-activity.ts:58:export function renderToolActivity(\nsrc/subagents.ts:261:        const key = …\nsrc/main.ts:4120:  renderToolActivity(entry.content, key)' } },
    { verb: 'Tracking changes to', name: 'pandacode_track_files', input: { action: 'begin', paths: ['src/tool-trace.ts', 'src/tool-trace-pandacode.ts', 'src/tool-trace.css'] }, output: { captureId: 'cap-1', status: 'started' } },
    { verb: 'Named', name: 'pandacode_title', input: { title: 'Tool trace visualizations' } },
    { verb: 'Remembered', name: 'pandacode_bot_remember', input: { content: 'The user prefers summaries before 9am.' } },
    { verb: 'Scheduled', name: 'pandacode_bot_schedule', input: { title: 'Morning digest', prompt: 'Summarize overnight PRs', kind: 'weekdays', timeOfDay: '08:30' } },
    { verb: 'Started browser test', name: 'pandacode_jev_test', status: 'running', input: { url: 'http://127.0.0.1:1420/', goal: 'Sign in with the demo account and reach the dashboard', viewport: 'mobile', expectedText: 'Welcome' } },
    { verb: 'Waited for test', name: 'pandacode_jev_wait', input: { runId: 'run-42' }, output: { runId: 'run-42', status: 'passed', summary: 'Signed in and reached the dashboard.', checks: [{ name: 'Expected text “Welcome”', passed: true }, { name: 'URL ends with /dashboard', passed: true }] } },
  ]],
  ['Subagents & MCP', [
    { verb: 'Started', name: 'Task', input: { subagent_type: 'Explore', description: 'Find tool name spellings', prompt: 'Search src-tauri/src/providers* for how MCP tool names are recorded for each harness.' }, output: 'Claude: mcp__pandacode_architect__pandacode_x. Codex: “server · tool”. Host tools: bare pandacode_x.' },
    { verb: 'Started', name: 'Agent', status: 'running', input: { subagent_type: 'code-reviewer', description: 'Review trace cards' } },
    { verb: 'Read the', name: 'mcp__github__list_issues', input: { owner: 'pandacode', repo: 'pandacode', labels: ['bug', 'ui'], state: 'open', filter: { since: '2026-10-01' } }, output: { total_count: 2, items: [{ number: 812, title: 'Trace rows wrap' }, { number: 815, title: 'Dark chips' }] } },
    { verb: 'Used', name: 'mcp__acme__deploy_site', input: { site: 'panda-site', env: 'production' }, output: { id: 'dep_42', url: 'https://panda-site.example.com', status: 'ready' } },
    { verb: 'Searched', name: 'docs · search', input: { query: 'lifetimes' }, output: 'Three results\n1. The Book: Validating references\n2. Nomicon: Lifetimes' },
    { verb: "Couldn't use", name: 'mcp__linear__create_issue', status: 'failed', input: { title: 'Gallery' }, output: 'Unauthorized: token expired' },
  ]],
  ['Built-in tools', [
    { verb: 'Ran', name: 'Bash', input: { command: 'npm test -- --runInBand' }, output: 'Exit code: 1\nWall time: 3s\nOutput:\n# pass 127\n# fail 4' },
    { verb: 'Edited', name: 'Edit', input: { file_path: 'src/tool-trace.css', old_string: '.tool-trace-verb{flex:none}', new_string: '.tool-trace-verb{flex:none;white-space:nowrap}' } },
    { verb: 'Searched', name: 'Grep', input: { pattern: 'pandacode_', path: 'src-tauri/src' }, output: 'Found 3 files\nsrc-tauri/src/agent_tools.rs\nsrc-tauri/src/architect.rs\nsrc-tauri/src/vm/tools.rs' },
  ]],
];

const params = new URLSearchParams(location.search);
const collapsed = params.has('collapsed');
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const css = document.createElement('style');
css.textContent = 'html,body{height:auto;overflow:auto;background:var(--bg)}#gallery{max-width:780px;margin:0 auto;padding:24px 24px 48px;color:var(--text)}#gallery h2{margin:22px 0 6px 6px;font-size:.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}';
document.head.append(css);

let n = 0;
const gallery = document.getElementById('gallery')!;
gallery.innerHTML = `<h1 style="font-size:1rem;margin:0 0 4px 6px">Tool trace gallery</h1>` + FAMILIES.map(([title, cases]) => {
  const entries = cases.map(c => ({ key: `case-${n++}`, content: { id: `case-${n}`, name: c.name, status: c.status ?? 'completed', input: j(c.input ?? {}), output: j(c.output) } as ToolActivity }));
  return `<section data-gallery-family="${escape(title)}" data-expect="${escape(cases.map(c => c.verb).join('|'))}"><h2>${escape(title)}</h2>${renderToolGroup(entries, !collapsed, true)}</section>`;
}).join('');
if (!collapsed) gallery.querySelectorAll<HTMLDetailsElement>('.tool-activity').forEach(row => { row.open = true; });
document.body.dataset.ready = 'true';
