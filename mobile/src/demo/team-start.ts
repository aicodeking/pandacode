// Demo answers for the `team` feature group (src/connect/api/team.ts): team.start adds a running
// architect task the way task.start adds a task (its team shows as working until the canned
// reply), and team.roster lists the demo computer's installed harnesses and one named team.
// Nothing touches the network. See ./index.ts.
import type { TeamRoster } from '../connect/api/team.ts';
import type { StartParams } from '../connect/types.ts';
import { started, withTask } from '../demo-host.ts';
import type { DemoHandlers } from './index.ts';

/** The demo's one named agent team (Settings → Agent teams on the desktop). */
export const DEMO_NAMED_TEAM = { id: 'review-crew', name: 'Review crew', auto: false, workers: 3, lead: { provider: 'claude', model: 'opus' } } as const;

export const handlers: DemoHandlers = {
  'team.roster': ({ state, deviceId }): TeamRoster => ({
    harnesses: (state.providers[deviceId] ?? []).filter(p => p.installed).map(p => ({ id: p.id, name: p.name, models: p.models?.length ?? 0 })),
    teams: [{ ...DEMO_NAMED_TEAM, lead: { ...DEMO_NAMED_TEAM.lead } }],
  }),
  'team.start': ({ host, deviceId, state, reply }, p) => {
    const prompt = String(p?.prompt ?? '').trim();
    if (!prompt) throw new Error('Missing prompt.');
    if (!state.tasks[deviceId]?.projects.some(project => project.id === p?.projectId)) throw new Error('That project is no longer on this computer.');
    if (p?.auto === false && p?.profileId !== DEMO_NAMED_TEAM.id) throw new Error('That team is no longer on this computer.');
    const named = p?.auto === false;
    const sessionId = `demo-team-${host.now().toString(36)}-${state.tasks[deviceId]?.tasks.length ?? 0}`;
    const params: StartParams = {
      projectId: p.projectId, prompt, worktree: false,
      provider: named ? DEMO_NAMED_TEAM.lead.provider : String(p.provider ?? 'claude'),
      model: named ? DEMO_NAMED_TEAM.lead.model : String(p.model ?? 'default'),
      ...(p.mode && { mode: p.mode }), ...(p.effort && { effort: p.effort }),
    };
    host.set(next => {
      const made = started(next, deviceId, sessionId, params, host.now());
      return { ...made, tasks: withTask({ ...next, ...made }, deviceId, sessionId, { team: { status: 'running', activeWorkers: 0 } }) };
    });
    reply(sessionId);
    return { sessionId };
  },
};
