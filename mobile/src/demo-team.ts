// Demo mode's architect task (src/demo.ts): a lead with three workers in different states, one
// with a checkpoint, and the team tool calls in its transcript, so the Agents view and the
// PandaCode tool sentences show offline. demo-host.ts answers task.team and task.workerMessages here.
import type { Message, ToolActivity } from './connect/types.ts';

export const DEMO_TEAM_TASK = 'team';
const MIN = 60_000;
const A = 'mcp__pandacode_architect__pandacode_';
const json = (value: unknown) => JSON.stringify(value);

const ASSIGNMENTS = [
  { key: 'host-team', name: 'Host: team over Connect', provider: 'codex', model: 'gpt-6', files: ['src-tauri/src/remote', 'docs/remote-access.md'], prompt: 'Add `task.team` and `task.workerMessages` to the Connect host.\n\n**Acceptance:** both methods documented, a live `team` event per changed worker, tests pass.' },
  { key: 'mobile-agents', name: 'Mobile: agents view', provider: 'claude', model: 'opus', files: ['mobile/src', 'mobile/tests'], dependsOn: ['w-host'], prompt: 'Add an Agents screen to the phone app listing team workers and subagents, each opening its trace.' },
  { key: 'review', name: 'Review the protocol', provider: 'kimi', model: 'kimi-k2', files: ['docs/remote-access.md'], readOnly: true, prompt: 'Review the new methods for replay safety and size limits. Report findings only.' },
];

/** The team as task.team sends it. */
export function demoTeam(now: number) {
  return {
    mode: 'auto', status: 'running', rounds: { used: 2, max: 8 },
    workers: [
      { id: 'w-host', name: ASSIGNMENTS[0].name, provider: 'codex', model: 'gpt-6', status: 'completed', attempt: 1, sessionId: 'demo-w-host', files: ASSIGNMENTS[0].files, dependsOn: [], assignment: ASSIGNMENTS[0].prompt,
        summary: 'Added `task.team` and `task.workerMessages` with a live `team` event per changed worker. 14 host tests pass.', checkpoint: null, startedAt: now - 18 * MIN, updatedAt: now - 9 * MIN },
      { id: 'w-mobile', name: ASSIGNMENTS[1].name, provider: 'claude', model: 'opus', status: 'running', attempt: 1, sessionId: 'demo-w-mobile', files: ASSIGNMENTS[1].files, dependsOn: ['w-host'], assignment: ASSIGNMENTS[1].prompt, summary: '',
        checkpoint: { summary: 'Tool sentences and the team store are done and tested (127 tests pass).', nextSteps: 'Build the Agents screen, then check it in the simulator.', blocker: null, updatedAt: now - 3 * MIN },
        startedAt: now - 8 * MIN, updatedAt: now - 20_000 },
      { id: 'w-review', name: ASSIGNMENTS[2].name, provider: 'kimi', model: 'kimi-k2', status: 'failed', attempt: 1, sessionId: 'demo-w-review', files: ASSIGNMENTS[2].files, dependsOn: [], readOnly: true, assignment: ASSIGNMENTS[2].prompt,
        summary: '', error: 'Kimi usage limit reached. Resets in 40 minutes.', checkpoint: null, startedAt: now - 17 * MIN, updatedAt: now - 12 * MIN },
    ],
  };
}

type Builder = { m: (role: string, content: string, at: number, turnDurationMs?: number | null) => Message; tool: (activity: ToolActivity, at: number) => Message };
const t = (id: string, name: string, input: unknown, output = '', status: ToolActivity['status'] = 'completed'): ToolActivity => ({ id, name, status, input: json(input), output });

/** The architect's stored transcript: an earlier finished team, then this round's dispatch and coordination. */
export function demoTeamMessages({ m, tool }: Builder): Message[] {
  return [
    m('user', 'Make the onboarding copy shorter on every screen.', 60),
    tool(t('tm0', `${A}title`, { title: 'Shorter onboarding copy' }, 'Renamed.'), 59.9),
    tool(t('tm1', `${A}dispatch_workers`, { assignments: [{ key: 'copy', name: 'Copy pass', provider: 'claude', model: 'sonnet', files: ['website/src/onboarding'], prompt: 'Cut each onboarding screen to two sentences.' }] }, json({ workerIds: ['w-copy'] })), 59.5),
    tool(t('tm2', `${A}finish_team`, { summary: '**Onboarding copy is shorter.**\n\n- Every screen now has at most two sentences.\n- The welcome screen drops the feature list.\n- Checked in light and dark mode.' }, 'Team finished.'), 41),
    m('assistant', 'The onboarding copy is shorter on every screen.', 41, 19 * MIN),
    m('user', 'Now show team workers on the phone: a host method for the team and an Agents screen in the app.', 19),
    tool(t('tm3', `${A}title`, { title: 'Agents view on the phone' }, 'Renamed.'), 18.9),
    tool(t('tm4', `${A}dispatch_workers`, { assignments: ASSIGNMENTS }, json({ workerIds: ['w-host', 'w-mobile', 'w-review'] })), 18.5),
    tool(t('tm5', `${A}read_worker`, { workerId: 'w-host' }, 'Completed.'), 9),
    tool(t('tm6', `${A}send_team_message`, { recipient: 'w-mobile', key: 'shape', message: 'The host sends `{ team: { mode, rounds, workers } }`; the live `team` event carries one changed worker row.' }, 'Sent.'), 8.8),
    tool(t('tm7', `${A}followup_worker`, { workerId: 'w-host', key: 'limits', prompt: 'Cap `task.workerMessages` pages at 60 messages and document it.' }, 'Queued.'), 8.5),
    m('assistant', 'The host side is done. The mobile worker is building the screen; the review hit a usage limit, so I will retry it when it resets.', 8, 11 * MIN),
  ];
}

/** One worker's transcript, as task.workerMessages sends it. */
export function demoWorkerMessages(workerId: string, now: number): Message[] {
  let id = 0;
  const m = (role: string, content: string, at: number, turnDurationMs: number | null = null): Message => ({ id: ++id, role, content, createdAt: now - at * MIN, turnDurationMs });
  const tool = (activity: ToolActivity, at: number) => m('tool', json({ type: 'tool_activity', version: 1, ...activity }), at);
  const assignment = demoTeam(now).workers.find(w => w.id === workerId)?.assignment ?? '';
  switch (workerId) {
    case 'w-host': return [
      m('user', assignment, 18),
      tool(t('h1', 'Read', { file_path: 'src-tauri/src/remote/host.rs' }, 'pub async fn handle(…)'), 17.5),
      tool(t('h2', 'Edit', { file_path: 'src-tauri/src/remote/host.rs', old_string: '"task.diff" => diff(state, params).await,', new_string: '"task.diff" => diff(state, params).await,\n"task.team" => team(state, params).await,\n"task.workerMessages" => worker_messages(state, params).await,' }, 'Updated.'), 14),
      tool(t('h3', 'Bash', { command: 'cargo test remote::host' }, 'test result: ok. 14 passed; 0 failed'), 10),
      m('assistant', 'Added `task.team` and `task.workerMessages`, with a live `team` event per changed worker. 14 host tests pass.', 9, 9 * MIN),
    ];
    case 'w-mobile': return [
      m('user', assignment, 8),
      tool(t('mo1', 'Read', { file_path: 'mobile/src/store/trace.ts' }, '…'), 7.5),
      tool(t('mo2', 'Write', { file_path: 'mobile/src/store/pandacode-tools.ts', content: '// Sentences for PandaCode tools\n' }, 'Wrote 140 lines'), 6),
      tool(t('mo3', 'Bash', { command: 'npm test' }, '# pass 127\n# fail 0'), 4),
      tool(t('mo4', `${A}checkpoint_worker`, { key: 'naming', summary: 'Tool sentences and the team store are done.', nextSteps: 'Build the Agents screen.' }, 'Saved.'), 3),
      tool(t('mo5', 'Write', { file_path: 'mobile/src/app/agents.tsx', content: '' }, '', 'running'), 0.3),
    ];
    case 'w-review': return [
      m('user', assignment, 17),
      tool(t('r1', 'Read', { file_path: 'docs/remote-access.md' }, '…'), 16),
      m('assistant', 'Kimi usage limit reached. Resets in 40 minutes.', 12, 5 * MIN),
    ];
    default: return [];
  }
}
