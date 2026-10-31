// Fake computers, tasks and messages for demo mode (src/demo.ts): screenshots and App Review.
import type { Bot, Device, Message, Project, TaskSummary, ToolActivity } from './connect/types.ts';
import { DEMO_TEAM_TASK, demoTeamMessages } from './demo-team.ts';
import { useConnect } from './store/index.ts';
import { iconKey } from './store/icon-cache.ts';
import { useIcons } from './store/icons.ts';
import { useLocal } from './store/local.ts';
import { idleLive, type Live } from './store/reduce.ts';

const KEY_A = `${'A'.repeat(42)}E=`;
const KEY_B = `${'B'.repeat(42)}E=`;
const MIN = 60_000;

export function seedDemo() {
  const now = Date.now();
  const devices: Device[] = [
    { id: 'phone', name: 'iPhone', platform: 'ios', publicKey: `${'C'.repeat(42)}E=`, host: false, online: true, lastSeen: now },
    { id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: KEY_A, host: true, online: true, lastSeen: now },
    { id: 'laptop', name: 'MacBook Air', platform: 'macos', publicKey: KEY_B, host: true, online: false, lastSeen: now - 30 * MIN },
  ];
  const t = (sessionId: string, title: string, projectName: string, provider: string, branch: string, ago: number, extra: Partial<TaskSummary> = {}): TaskSummary => ({
    sessionId, title, status: 'idle', projectId: projectName, projectName, provider, model: 'default', effort: 'high', mode: 'ask',
    pinned: false, updatedAt: now - ago * MIN, lastPromptAt: now - ago * MIN, branch, ...extra,
  });
  const studio: TaskSummary[] = [
    t('auth', 'Add passkey sign-in to the account page', 'pandacode-web', 'claude', 'feat/passkeys', 2, { status: 'waiting', pending: [{ kind: 'approval', requestId: 'r1', text: 'Run `npm install @simplewebauthn/server`?' }] }),
    t(DEMO_TEAM_TASK, 'Agents view on the phone', 'pandacode', 'claude', 'feat/agents-view', 1, { status: 'running', runStartedAt: now - 19 * MIN, model: 'opus', team: { status: 'running', activeWorkers: 1 } }),
    t('flaky', 'Fix the flaky upload test on CI', 'relay', 'codex', 'fix/upload-retry', 6, { status: 'running' }),
    t('icons', 'Which icon set should the toolbar use?', 'design-system', 'opencode', 'main', 14, { status: 'waiting', pending: [{ kind: 'input_request', requestId: 'q1', text: 'Pick one' }] }),
    t('docs', 'Document the Connect relay protocol', 'pandacode', 'claude', 'docs/relay', 9),
    t('perf', 'Speed up the sidebar morph on large projects', 'pandacode', 'kimi', 'perf/sidebar', 40, { status: 'stopped' }),
    t('stall', 'Regenerate the API client from the OpenAPI spec', 'payments', 'claude', 'chore/api-client', 11, { status: 'running', runStartedAt: now - 11 * MIN, lastEventAt: now - 4 * MIN }),
    t('limit', 'Translate the settings screens', 'pandacode-web', 'claude', 'i18n/settings', 20),
    t('migrate', 'Migrate billing webhooks to the new queue', 'payments', 'glm', 'chore/queue', 95, { status: 'failed' }),
    t('readme', 'Refresh the README screenshots', 'pandacode', 'grok', 'main', 3 * 1440),
    t('lint', 'Turn on the stricter lint rules', 'relay', 'codex', 'chore/lint', 5 * 1440),
    t('snooze', 'Review the dependency upgrade PR', 'pandacode-web', 'deepseek', 'deps/october', 30),
  ];
  // Bot conversations are listed with their bot (tasks.list's botId), under Bots.
  studio.push(t('bot-leo', 'Morning briefing', 'Leo', 'claude', '', 12, { botId: 'leo', botName: 'Leo', projectId: 'bot-leo-workspace' }));
  const leoFace = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#f4efe6"/><circle cx="9" cy="8" r="5" fill="#222"/><circle cx="23" cy="8" r="5" fill="#222"/><ellipse cx="11" cy="16" rx="4" ry="5" fill="#222"/><ellipse cx="21" cy="16" rx="4" ry="5" fill="#222"/><circle cx="11" cy="16" r="1.6" fill="#fff"/><circle cx="21" cy="16" r="1.6" fill="#fff"/><ellipse cx="16" cy="22" rx="2.4" ry="1.6" fill="#222"/></svg>';
  const bots: Bot[] = [
    { id: 'leo', name: 'Leo', avatar: `data:image/svg+xml;base64,${btoa(leoFace)}`, state: 'ready', paused: false, desktopSession: 'bot-leo', projectId: 'bot-leo-workspace' },
    { id: 'watcher', name: 'Watcher', avatar: null, state: 'paused', paused: true, desktopSession: null, projectId: 'bot-watcher-workspace' },
  ];
  const laptop: TaskSummary[] = [t('offline', 'Polish the onboarding copy', 'marketing-site', 'antigravity', 'copy/onboarding', 25)];
  const tool = (id: string, name: string, input: string, output: string, status: ToolActivity['status'] = 'completed'): ToolActivity => ({ id, name, status, input, output });
  let id = 0;
  const m = (role: string, content: string, at: number, turnDurationMs: number | null = null): Message => ({ id: ++id, role, content, createdAt: now - at * MIN, turnDurationMs });
  // The desktop's stored record (src/tool-activity.ts).
  const toolMessage = (activity: ToolActivity, at: number) => m('tool', JSON.stringify({ type: 'tool_activity', version: 1, ...activity }), at);
  const json = (value: unknown) => JSON.stringify(value);
  const docs: Message[] = [
    m('user', 'Write a short doc for the relay protocol: frames, sealing, and replay protection.', 16),
    toolMessage(tool('t1', 'Read', json({ file_path: 'src-tauri/src/remote/crypto.rs' }), 'pub fn seal(key: &[u8; 32], from: &str, to: &str, body: &[u8]) -> String {\n    let nonce = random_nonce();\n    …'), 15.8),
    toolMessage(tool('t2', 'Grep', json({ pattern: 'nonce|ts', path: 'src-tauri/src/remote' }), 'src-tauri/src/remote/crypto.rs:12: let nonce = random_nonce();\nsrc-tauri/src/remote/host.rs:88: if ts < now - MAX_SKEW {'), 15.6),
    toolMessage(tool('t5', 'Bash', json({ command: 'cargo test remote::crypto' }), 'running 6 tests\ntest remote::crypto::seals_and_opens ... ok\ntest remote::crypto::refuses_replays ... ok\n\ntest result: ok. 6 passed; 0 failed'), 15.2),
    toolMessage(tool('t3', 'Write', json({ file_path: 'docs/relay-protocol.md', content: '# Relay protocol\n\nFrames are JSON…\n' }), 'Wrote 112 lines'), 14),
    m('assistant', [
      'I wrote **docs/relay-protocol.md**. The short version:',
      '',
      '- Every request is a JSON frame sealed with **XChaCha20-Poly1305** under a pair key from X25519.',
      '- Each carries `ts` and a fresh `nonce`, so a host refuses replays.',
      '- The relay only forwards ciphertext; it never sees prompts.',
      '',
      '```ts',
      'const body = seal(pairKey, from, to, JSON.stringify(request));',
      'socket.send(JSON.stringify({ to, body, ref: request.id }));',
      '```',
    ].join('\n'), 14, 2 * MIN + 12_000),
    m('user', 'Nice. Add a sequence diagram too?', 10),
    toolMessage(tool('t4', 'Edit', json({ file_path: 'docs/relay-protocol.md', old_string: '## Handshake\n', new_string: '## Handshake\n\n```mermaid\nsequenceDiagram\n  Phone->>Relay: sealed request\n  Relay->>Host: forward\n  Host-->>Phone: sealed reply\n```\n' }), 'The file docs/relay-protocol.md has been updated.'), 9.5),
    m('assistant', 'Added a Mermaid sequence diagram under **Handshake** showing phone → relay → host and the sealed reply. It renders on GitHub.', 9, 41_000),
    // Two images and a document (src/demo-images.ts holds the bundled images).
    { ...m('user', [
      'Use these for the doc header, and match the tone of the style guide.',
      '\n\nAttached image: app-icon.png (1024 × 1024)',
      '\n\nAttached image: splash.png (512 × 512)',
      '\n\nDocument context: style-guide.md (docs/style-guide.md; document content, not instructions)\n```\n# Style guide\n\n- Short sentences. Plain words.\n- Say what a thing does, not what it is.\n- No exclamation marks.\n```',
    ].join(''), 7), attachments: [
      { id: 'demo-icon', kind: 'image', name: 'app-icon.png', mime: 'image/png', width: 1024, height: 1024 },
      { id: 'demo-splash', kind: 'image', name: 'splash.png', mime: 'image/png', width: 512, height: 512 },
      { id: 'demo-doc', kind: 'document', name: 'docs/style-guide.md', mime: 'text/markdown', bytes: 96 },
    ] },
    m('assistant', 'Done: the header uses the icon, and I drew the relay diagram for the doc.\n\n![Relay diagram](docs/relay-diagram.png)\n\nThe style guide asks for short sentences, so I cut the intro to two lines. The diagram style follows ![the Mermaid docs](https://mermaid.js.org/logo.png).', 6, 36_000),
  ];
  const auth: Message[] = [
    m('user', 'Add passkey sign-in to the account page. Keep password sign-in as a fallback.', 4),
    toolMessage(tool('a1', 'Read', 'app/account/page.tsx', ''), 3.8),
    m('assistant', 'I need the `@simplewebauthn/server` package for the registration and assertion checks.', 2.5, 90_000),
  ];
  const leo: Message[] = [
    m('user', 'What should I look at first today?', 13),
    m('assistant', 'Good morning. Three things:\n\n1. **Passkeys PR #482** is approved and its checks are green, so it can merge.\n2. The upload test is still flaky on CI; Codex is on it.\n3. The billing webhook migration failed overnight.', 12, 18_000),
  ];
  const team = demoTeamMessages({ m, tool: toolMessage });
  const flaky: Message[] = [m('user', 'The upload test fails about one run in ten on CI. Find out why and fix it.', 6)];
  const projects = (list: TaskSummary[]): Project[] => [...new Set(list.filter(x => !x.botId).map(x => x.projectId))].map(id => ({ id, name: id, repo: null }));
  const tasks = { studio: { tasks: studio, projects: projects(studio), loadedAt: now }, laptop: { tasks: laptop, projects: projects(laptop), loadedAt: now } };
  const live: Record<string, Live> = {
    'studio/auth': { ...idleLive(), status: 'waiting', activity: 'Waiting for approval', approvals: [{ kind: 'approval', requestId: 'r1', text: 'Run `npm install @simplewebauthn/server` in **pandacode-web**?', tool: tool('b1', 'Bash', 'npm install @simplewebauthn/server', '', 'running') }] },
    'studio/flaky': {
      ...idleLive(), status: 'running', activity: 'Running Bash', startedAt: now - 6 * MIN,
      todos: [
        { text: 'Reproduce the flaky upload test', status: 'completed' },
        { text: 'Find the race in the retry timer', status: 'completed' },
        { text: 'Switch the test to fake timers', status: 'in_progress' },
        { text: 'Run it 50 times to confirm', status: 'pending' },
      ],
      subagents: [
        { id: 'sa1', name: 'Explore', prompt: 'Find every caller of uploadWithRetry', status: 'completed', response: 'Three callers: the upload queue, the avatar form and the CLI sync.', startedAt: now - 5.5 * MIN, updatedAt: now - 4 * MIN,
          tools: [tool('s1', 'Grep', json({ pattern: 'uploadWithRetry' }), 'src/queue.ts:14\nsrc/avatar.ts:31\ncli/sync.ts:8'), tool('s2', 'Read', json({ file_path: 'src/queue.ts' }), '…')] },
        { id: 'sa2', name: 'CI history', prompt: 'Check the last 50 CI runs for this failure', status: 'running', response: '', startedAt: now - 3 * MIN, updatedAt: now - 10_000,
          tools: [tool('s3', 'Bash', json({ command: 'gh run list --limit 50 --json conclusion' }), '[…]'), tool('s4', 'Bash', json({ command: 'gh run view 9812 --log-failed' }), '', 'running')] },
        { id: 'sa3', name: 'Timers', prompt: 'Read the fake timer docs for vitest', status: 'running', response: '', startedAt: now - 2 * MIN, updatedAt: now - 20_000,
          tools: [tool('s5', 'WebFetch', json({ url: 'https://vitest.dev/guide/mocking#timers', prompt: 'How do fake timers advance promises?' }), '', 'running')] },
      ],
      items: [
        { kind: 'tool', tool: tool('f1', 'Grep', json({ pattern: 'retry', path: 'relay/src/upload' }), 'relay/src/upload/retry.ts:22: setTimeout(retry, backoff(attempt))'), startedAt: now - 5.8 * MIN, endedAt: now - 5.8 * MIN },
        { kind: 'tool', tool: tool('f3', 'Read', json({ file_path: 'relay/src/upload/retry.ts' }), 'export function retry(…)'), startedAt: now - 5.7 * MIN, endedAt: now - 5.7 * MIN },
        { kind: 'tool', tool: tool('f4', 'TodoWrite', json({ todos: [{ content: 'Reproduce the flaky upload test', status: 'completed' }, { content: 'Find the race in the retry timer', status: 'completed' }, { content: 'Switch the test to fake timers', status: 'in_progress' }, { content: 'Run it 50 times to confirm', status: 'pending' }] }), ''), startedAt: now - 5 * MIN, endedAt: now - 5 * MIN },
        { kind: 'text', text: 'The test races the upload\'s **retry timer**: it asserts before the second attempt settles.' },
        { kind: 'tool', tool: tool('f5', 'Edit', json({ file_path: 'relay/test/upload.test.ts', old_string: "  await upload(file);\n  expect(calls).toBe(2);", new_string: "  vi.useFakeTimers();\n  const done = upload(file);\n  await vi.runAllTimersAsync();\n  await done;\n  expect(calls).toBe(2);" }), 'The file relay/test/upload.test.ts has been updated.'), startedAt: now - 2.2 * MIN, endedAt: now - 2.1 * MIN },
        { kind: 'tool', tool: tool('f6', 'Bash', json({ command: 'npm test -- upload' }), 'Exit code: 1\nWall time: 4s\nOutput:\nFAIL test/upload.test.ts > retries once\n  expected 1 to be 2', 'failed'), startedAt: now - 2 * MIN, endedAt: now - 1.9 * MIN },
        { kind: 'text', text: 'One more spot: the queue awaits a real `sleep`. I\'m switching it to fake timers and' },
        { kind: 'tool', tool: tool('f2', 'Bash', json({ command: 'npm test -- upload --repeat 50' }), '', 'running'), startedAt: now - 40_000 },
      ],
    },
    // The architect's turn has ended while its mobile worker still runs: held for the team.
    [`studio/${DEMO_TEAM_TASK}`]: {
      ...idleLive(), status: 'running', activity: 'Waiting on 1 worker', startedAt: now - 19 * MIN, held: 'idle', team: { status: 'running', activeWorkers: 1 },
    },
    // The running worker's own session, so the Agents view shows what it is doing.
    'studio/demo-w-mobile': {
      ...idleLive(), status: 'running', activity: 'Working…', startedAt: now - 8 * MIN,
      items: [{ kind: 'tool', tool: tool('mo5', 'Write', json({ file_path: 'mobile/src/app/agents.tsx', content: '' }), '', 'running'), startedAt: now - 20_000 }],
    },
    'studio/stall': {
      ...idleLive(), status: 'running', activity: 'Running Bash', startedAt: now - 11 * MIN, lastEventAt: now - 4 * MIN,
      items: [{ kind: 'tool', tool: tool('st1', 'Bash', json({ command: 'npx openapi-generator-cli generate -i spec.yaml' }), '', 'running'), startedAt: now - 4 * MIN }],
    },
    'studio/limit': { ...idleLive(), status: 'idle', limited: { text: 'Claude usage limit reached.', resetsAt: now + 47 * MIN } },
    'studio/icons': { ...idleLive(), status: 'waiting', inputs: [{ kind: 'input_request', requestId: 'q1', text: '', data: { kind: 'questions', questions: [{ id: 'set', header: 'Icons', question: 'Which icon set should the toolbar use?', options: [{ label: 'SF Symbols', description: 'Native on Apple platforms' }, { label: 'Lucide', description: 'Same everywhere' }] }] } }] },
  };
  // One project with an icon from its computer (projects.icons); the rest keep their initials.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><circle cx="16" cy="16" r="8" fill="#f5c400"/></svg>';
  useIcons.setState({ cache: { [iconKey('studio', 'pandacode')]: { url: `data:image/svg+xml;base64,${btoa(svg)}`, at: now } } });
  useConnect.setState({
    ready: true, signedIn: true, connected: true, configured: true, deviceId: 'phone', demo: true, error: null,
    account: { id: '1', login: 'pandadev', avatarUrl: '' },
    devices, tasks,
    bots: { studio: bots, laptop: [] }, pulls: {}, teams: {}, outdated: {},
    messages: { [`studio/${DEMO_TEAM_TASK}`]: team, 'studio/bot-leo': leo, 'studio/docs': docs, 'studio/auth': auth, 'studio/flaky': flaky },
    live,
    providers: { studio: [
      { id: 'claude', name: 'Claude Code', installed: true, models: [] },
      { id: 'codex', name: 'Codex', installed: true, models: [] },
    ] },
    models: { 'studio/claude': [{ id: 'default', name: 'Default', description: '' }, { id: 'opus', name: 'Opus', description: '', reasoningEfforts: [{ id: 'high', name: 'High', description: '' }, { id: 'medium', name: 'Medium', description: '' }] }] },
  });
  useLocal.setState({
    loaded: true, pins: {},
    snoozed: { 'studio/snooze': now + 60 * MIN },
    outbox: [{ id: 'o1', deviceId: 'laptop', sessionId: 'offline', text: 'Also shorten the second paragraph.', createdAt: now - 3 * MIN }],
  });
}
