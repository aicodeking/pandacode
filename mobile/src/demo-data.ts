// Fake computers, tasks and messages for demo mode (src/demo.ts). Screenshots only.
import type { Device, Message, TaskSummary, ToolActivity } from './connect/types.ts';
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
    t('flaky', 'Fix the flaky upload test on CI', 'relay', 'codex', 'fix/upload-retry', 6, { status: 'running' }),
    t('icons', 'Which icon set should the toolbar use?', 'design-system', 'opencode', 'main', 14, { status: 'waiting', pending: [{ kind: 'input_request', requestId: 'q1', text: 'Pick one' }] }),
    t('docs', 'Document the Connect relay protocol', 'pandacode', 'claude', 'docs/relay', 9),
    t('perf', 'Speed up the sidebar morph on large projects', 'pandacode', 'kimi', 'perf/sidebar', 40),
    t('migrate', 'Migrate billing webhooks to the new queue', 'payments', 'glm', 'chore/queue', 95, { status: 'failed' }),
    t('readme', 'Refresh the README screenshots', 'pandacode', 'grok', 'main', 3 * 1440),
    t('lint', 'Turn on the stricter lint rules', 'relay', 'codex', 'chore/lint', 5 * 1440),
    t('snooze', 'Review the dependency upgrade PR', 'pandacode-web', 'deepseek', 'deps/october', 30),
  ];
  const laptop: TaskSummary[] = [t('offline', 'Polish the onboarding copy', 'marketing-site', 'antigravity', 'copy/onboarding', 25)];
  const tool = (id: string, name: string, input: string, output: string, status: ToolActivity['status'] = 'completed'): ToolActivity => ({ id, name, status, input, output });
  let id = 0;
  const m = (role: string, content: string, at: number, turnDurationMs: number | null = null): Message => ({ id: ++id, role, content, createdAt: now - at * MIN, turnDurationMs });
  const toolMessage = (activity: ToolActivity, at: number) => m('tool', JSON.stringify(activity), at);
  const docs: Message[] = [
    m('user', 'Write a short doc for the relay protocol: frames, sealing, and replay protection.', 16),
    toolMessage(tool('t1', 'Read', 'src-tauri/src/remote/crypto.rs', 'pub fn seal(…)'), 15.8),
    toolMessage(tool('t2', 'Grep', 'nonce|ts', '14 matches in 3 files'), 15.6),
    toolMessage(tool('t3', 'Write', 'docs/relay-protocol.md', 'Wrote 112 lines'), 14),
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
    toolMessage(tool('t4', 'Edit', 'docs/relay-protocol.md', '+18 −0'), 9.5),
    m('assistant', 'Added a Mermaid sequence diagram under **Handshake** showing phone → relay → host and the sealed reply. It renders on GitHub.', 9, 41_000),
  ];
  const auth: Message[] = [
    m('user', 'Add passkey sign-in to the account page. Keep password sign-in as a fallback.', 4),
    toolMessage(tool('a1', 'Read', 'app/account/page.tsx', ''), 3.8),
    m('assistant', 'I need the `@simplewebauthn/server` package for the registration and assertion checks.', 2.5, 90_000),
  ];
  const flaky: Message[] = [m('user', 'The upload test fails about one run in ten on CI. Find out why and fix it.', 6)];
  const tasks = { studio: { tasks: studio, projects: [], loadedAt: now }, laptop: { tasks: laptop, projects: [], loadedAt: now } };
  const live: Record<string, Live> = {
    'studio/auth': { ...idleLive(), status: 'waiting', activity: 'Waiting for approval', approvals: [{ kind: 'approval', requestId: 'r1', text: 'Run `npm install @simplewebauthn/server` in **pandacode-web**?', tool: tool('b1', 'Bash', 'npm install @simplewebauthn/server', '', 'running') }] },
    'studio/flaky': {
      ...idleLive(), status: 'running', activity: 'Running Bash',
      items: [
        { kind: 'tool', tool: tool('f1', 'Grep', 'retry', '6 matches') },
        { kind: 'text', text: 'The test races the upload\'s **retry timer**: it asserts before the second attempt settles. I\'m switching it to fake timers and' },
        { kind: 'tool', tool: tool('f2', 'Bash', 'npm test -- upload --repeat 50', '', 'running') },
      ],
    },
    'studio/icons': { ...idleLive(), status: 'waiting', inputs: [{ kind: 'input_request', requestId: 'q1', text: '', data: { kind: 'questions', questions: [{ id: 'set', header: 'Icons', question: 'Which icon set should the toolbar use?', options: [{ label: 'SF Symbols', description: 'Native on Apple platforms' }, { label: 'Lucide', description: 'Same everywhere' }] }] } }] },
  };
  // One project with an icon from its computer (projects.icons); the rest keep their initials.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><circle cx="16" cy="16" r="8" fill="#f5c400"/></svg>';
  useIcons.setState({ cache: { [iconKey('studio', 'pandacode')]: { url: `data:image/svg+xml;base64,${btoa(svg)}`, at: now } } });
  useConnect.setState({
    ready: true, signedIn: true, connected: true, configured: true, deviceId: 'phone',
    account: { id: '1', login: 'pandadev', avatarUrl: '' },
    devices, tasks,
    messages: { 'studio/docs': docs, 'studio/auth': auth, 'studio/flaky': flaky },
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
