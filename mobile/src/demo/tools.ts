// Demo answers for the `tools` feature group (src/connect/api/tools.ts): progress snapshots drawn as
// SVG, a passing check, two recipes, a small skills library and one local server. See ./index.ts.
import { sent } from '../demo-host.ts';
import type { DemoHandlers } from './index.ts';

const MIN = 60_000;
const DEMO_SCRIPT_TERMINAL = 'demo-terminal';
/** The demo run script's terminal while it runs, for runScript.get's `running`. */
let demoScript: string | null = null;

const frame = (title: string, accent: string, bars: number) => {
  const rows = Array.from({ length: bars }, (_, i) => `<rect x="24" y="${70 + i * 34}" width="${300 - i * 40}" height="18" rx="6" fill="#d9d4cb"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#faf8f4"/><rect width="400" height="44" fill="${accent}"/>`
    + `<text x="24" y="29" font-family="Helvetica" font-size="18" fill="#fff">${title}</text>${rows}</svg>`;
};

const SNAPSHOTS = [
  { id: 'p3', iteration: 3, title: 'Account page with passkeys', note: 'Password sign-in stays as a fallback below.', kind: 'image', accent: '#3a7bd5', bars: 4, ago: 3 },
  { id: 'p2', iteration: 2, title: 'Passkey prompt', kind: 'image', accent: '#6a5acd', bars: 3, ago: 9 },
  { id: 'p1', iteration: 1, title: 'First layout', kind: 'image', accent: '#888888', bars: 2, ago: 15 },
] as const;

export const handlers: DemoHandlers = {
  'progress.list': ({ host }) => ({
    snapshots: SNAPSHOTS.map(({ accent: _a, bars: _b, ago, ...s }) => ({ ...s, annotations: [], createdAt: host.now() - ago * MIN, width: 400, height: 300 })),
    truncated: false,
  }),
  'progress.thumb': (_ctx, p) => image(String(p.id)),
  'progress.media': (_ctx, p) => image(String(p.id)),
  'checks.plan': () => ({ name: 'npm test' }),
  'checks.run': () => new Promise(resolve => setTimeout(() => resolve({ checked: true, name: 'npm test', ok: true, output: '', truncated: false }), 1200)),
  'recipes.list': () => ({
    recipes: [
      { name: 'ship-it', description: 'Test, review and commit', scope: 'project', steps: [{ kind: 'check', text: 'npm test' }, { kind: 'prompt', text: 'Review the changed files.' }, { kind: 'approval', text: 'Ready to commit?' }] },
      { name: 'tidy', description: 'Lint and format the touched files', scope: 'global', steps: [{ kind: 'slash', command: '/lint', text: 'Run the linter and fix what it reports.' }] },
    ],
  }),
  'recipes.plan': (_ctx, p) => p.name === 'tidy'
    ? { steps: [{ index: 0, status: 'fallback', reason: '/lint is not offered by claude; the step\'s own text is sent instead.' }], count: 1, blocked: false }
    : {
      steps: [
        { index: 0, status: 'supported', reason: 'The agent runs the check and reports the result.' },
        { index: 1, status: 'supported', reason: 'Sent as a message.' },
        { index: 2, status: 'manual', reason: 'Waits for you to confirm before the next step.' },
      ],
      count: 3,
      blocked: false,
    },
  'recipes.run': (ctx, p) => {
    // The first step goes out now; the rest wait in the task's queue on a real computer.
    const sessionId = String(p.sessionId);
    ctx.host.set(s => sent(s, ctx.deviceId, sessionId, p.name === 'tidy' ? 'Run the linter and fix what it reports.' : 'Run this check and report the result, including any failures:\nnpm test', ctx.host.now()));
    ctx.reply(sessionId);
    return { sent: 1, queued: p.name === 'tidy' ? 0 : 2 };
  },
  'skills.list': () => ({
    project: null,
    items: [
      { id: 'review', name: 'code-review', kind: 'skill', description: 'Reviews a diff for bugs before it ships.', source: 'anthropics/skills/code-review', findings: 0, acknowledged: true },
      { id: 'house-style', name: 'house-style', kind: 'rule', description: 'Short sentences, plain words, no exclamation marks.', source: '~/notes/house-style.md', findings: 0, acknowledged: true },
      { id: 'deploy', name: 'deploy', kind: 'skill', description: 'Deploys the web app to staging.', source: 'acme/skills/deploy', findings: 1, acknowledged: false },
    ],
    harnesses: [
      { harness: 'claude', installed: true, prompt: false, cells: [{ id: 'review', scope: 'user', status: 'active', surface: '~/.claude/skills/code-review' }, { id: 'house-style', scope: 'user', status: 'off', surface: '~/.claude/CLAUDE.md' }, { id: 'deploy', scope: 'user', status: 'off', surface: '~/.claude/skills/deploy' }] },
      { harness: 'codex', installed: true, prompt: false, cells: [{ id: 'review', scope: 'user', status: 'off', surface: '~/.codex/skills/code-review' }, { id: 'house-style', scope: 'user', status: 'active', surface: '~/.codex/AGENTS.md' }, { id: 'deploy', scope: 'user', status: 'off', surface: '~/.codex/skills/deploy' }] },
    ],
    truncated: false,
  }),
  'skills.activate': (_ctx, p) => {
    if (p.id === 'deploy' && p.active) throw new Error("Review this skill's safety findings in PandaCode on the computer first.");
    return { kept: [] };
  },
  'runScript.get': () => ({ script: { path: '.pandacode/run.sh', previewUrl: 'http://localhost:5173' }, running: demoScript ? { terminalId: demoScript } : null }),
  'runScript.start': () => {
    demoScript = DEMO_SCRIPT_TERMINAL;
    return { status: 'started', terminalId: DEMO_SCRIPT_TERMINAL };
  },
  'runScript.stop': (_ctx, p) => {
    if (typeof p.terminalId !== 'string' || !p.terminalId || p.terminalId !== demoScript) throw new Error('That run script is not running here.');
    demoScript = null;
    return { status: 'stopped' };
  },
  'localServers.list': () => ({ servers: [{ port: 5173, process: 'node', url: 'http://localhost:5173' }, { port: 6006, process: 'storybook', url: 'http://localhost:6006' }] }),
};

function image(id: string) {
  const snapshot = SNAPSHOTS.find(s => s.id === id);
  if (!snapshot) throw new Error('That snapshot has no image.');
  const data = btoa(frame(snapshot.title, snapshot.accent, snapshot.bars));
  return { mime: 'image/svg+xml', total: data.length, offset: 0, data, done: true };
}
