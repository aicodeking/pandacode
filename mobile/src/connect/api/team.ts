// Host calls for the `team` feature group (src-tauri/src/remote/methods/team.rs): starting a task
// whose architect leads a team of agents (team.start, Full access) and what a team may use on the
// computer (team.roster: installed harnesses and the named agent teams from Settings).
//
// With Auto the picked model leads and chooses worker models from every installed harness, as the
// desktop's Team button does; a named team brings its own lead and workers. A team start carries a
// startId like task.start, so a lost reply turns into task.startStatus polls (start-retry.ts).
//
// The helpers above the calls are pure (tests/team-start.test.ts); client.ts is loaded only by the
// calls, so node can load this file.
import { registerMethods, START_TIMEOUT_MS } from '../rpc.ts';
import { draftStartId, followStart, keepsStartId, type DraftStart, type StartReply } from '../start-retry.ts';

export const TEAM_METHODS = registerMethods(['team.start', 'team.roster'] as const);

/** The team choice that leaves worker models to the lead. */
export const AUTO_TEAM = 'auto';

export interface TeamHarness { id: string; name: string; models: number }
export interface NamedTeam { id: string; name: string; auto: boolean; workers: number; lead: { provider: string; model: string } }
export interface TeamRoster { harnesses: TeamHarness[]; teams: NamedTeam[] }

/** The new-task form's settings a team start sends. */
export interface TeamForm { projectId: string; prompt: string; provider: string; model: string; mode?: string; effort?: string; imageIds?: string[] }
export interface TeamStartParams extends TeamForm { auto?: boolean; profileId?: string; startId?: string }

const MAX_NAME = 200;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** team.roster's reply, keeping only well-formed rows. */
export function parseRoster(reply: unknown): TeamRoster {
  const r = (reply && typeof reply === 'object' ? reply : {}) as { harnesses?: unknown; teams?: unknown };
  const harnesses = (Array.isArray(r.harnesses) ? r.harnesses : [])
    .map((h: any): TeamHarness => ({ id: str(h?.id), name: str(h?.name).slice(0, MAX_NAME) || str(h?.id), models: count(h?.models) }))
    .filter(h => h.id);
  const teams = (Array.isArray(r.teams) ? r.teams : [])
    .map((t: any): NamedTeam => ({ id: str(t?.id), name: str(t?.name).slice(0, MAX_NAME), auto: t?.auto === true, workers: count(t?.workers), lead: { provider: str(t?.lead?.provider), model: str(t?.lead?.model) } }))
    .filter(t => t.id && t.name);
  return { harnesses, teams };
}

/** The team picker: Auto first, then each named team. */
export function teamChoices(roster: TeamRoster | null): { value: string; label: string }[] {
  return [{ value: AUTO_TEAM, label: 'Auto' }, ...(roster?.teams ?? []).map(t => ({ value: t.id, label: t.name }))];
}

/** A picked team that is gone from the computer falls back to Auto. */
export const pickedTeam = (roster: TeamRoster | null, profileId: string): string =>
  profileId !== AUTO_TEAM && roster?.teams.some(t => t.id === profileId) ? profileId : AUTO_TEAM;

/** One line under the Team row: who leads and what the workers may use. */
export function teamSummary(roster: TeamRoster | null, profileId: string): string {
  const team = roster?.teams.find(t => t.id === profileId);
  if (team) return team.auto ? `${team.name} · ${team.workers} models` : `${team.name} · ${team.workers} workers`;
  const harnesses = roster?.harnesses ?? [];
  if (!harnesses.length) return 'Your model leads and picks worker models';
  return `Your model leads · workers from ${harnesses.map(h => h.name).join(', ')}`;
}

/** team.start's params for the form: Auto, or the named team. */
export function teamStartParams(form: TeamForm, profileId: string): TeamStartParams {
  const { mode, effort, imageIds, ...rest } = form;
  const params: TeamStartParams = { ...rest, prompt: form.prompt.trim(), ...(mode && { mode }), ...(effort && { effort }), ...(imageIds?.length && { imageIds }) };
  return profileId === AUTO_TEAM ? { ...params, auto: true } : { ...params, auto: false, profileId };
}

// ---- calls ----

const client = () => import('../client.ts');

export async function teamRoster(deviceId: string): Promise<TeamRoster> {
  const { hostCall } = await client();
  return parseRoster(await hostCall<unknown>(deviceId, 'team.roster', {}));
}

/** The last team draft's start id: a retry of the same draft after a lost reply reuses it. */
let teamDraft: DraftStart | null = null;

/** Starts a team task and refreshes the computer's tasks; throws on failure. */
export async function startTeamTask(deviceId: string, params: TeamStartParams): Promise<StartReply> {
  const { connect, hostCall } = await client();
  const { capabilitiesOf } = await import('./capabilities.ts');
  const { supports } = await import('./hello.ts');
  const { uuid } = await import('../crypto.ts');
  const draft = draftStartId(teamDraft, JSON.stringify([deviceId, params]), uuid);
  teamDraft = draft;
  const startId = draft.id;
  try {
    const reply = await followStart({
      start: () => hostCall<StartReply>(deviceId, 'team.start', { ...params, startId }, { timeoutMs: START_TIMEOUT_MS }),
      status: () => hostCall(deviceId, 'task.startStatus', { startId }),
      canPoll: () => supports(capabilitiesOf(deviceId), 'task.startStatus') !== false,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: Date.now,
      maxMs: START_TIMEOUT_MS,
    });
    teamDraft = null;
    void connect.listTasks(deviceId).catch(() => undefined);
    return reply;
  } catch (e) {
    if (!keepsStartId(e)) teamDraft = null;
    throw e;
  }
}
