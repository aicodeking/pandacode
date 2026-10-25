/* How the Team button behaves, and named agent teams built in Settings. A named team is a
 * saved team profile whose lead may only orchestrate the models it lists (`rosterOnly`). */
import type { ModelSelection, TeamConfig, TeamLibrary, TeamProfile, TeamSetup, WorkerProfile } from './architect-types';
import { t } from './i18n.ts';
import type { ProviderId, ProviderModel } from './types';

const CLASSIC_KEY = 'pandacode.teamClassic';
export const TEAM_MODE_EVENT = 'pandacode:team-mode';
/** Named teams list at most this many models, like the automatic roster. */
export const TEAM_MODELS_MAX = 24;

/** True when the Team button opens the classic Architect & workers setup. */
export function classicTeamSetup(): boolean {
  try { return localStorage.getItem(CLASSIC_KEY) === 'true'; } catch { return false; }
}
export function setClassicTeamSetup(on: boolean): void {
  try { localStorage.setItem(CLASSIC_KEY, String(on)); } catch { /* Kept for this window only. */ }
  window.dispatchEvent(new CustomEvent(TEAM_MODE_EVENT, { detail: on }));
}

export type TeamModel = { provider: ProviderId; harness: string; model: string; name: string; reasoningEffort?: string | null; efforts?: ProviderModel['reasoningEfforts'] };
export const modelKey = (model: Pick<TeamModel, 'provider' | 'model'>): string => `${model.provider}:${model.model}`;

/** A roster entry ID the native validator accepts: ASCII letters, digits, `_` and `-`. */
function rosterId(model: TeamModel, taken: ReadonlySet<string>): string {
  const base = `${model.provider}-${model.model || 'default'}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || model.provider;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The saved setup for a named team: its lead plus every model it may orchestrate. */
export function namedTeamSetup(name: string, lead: TeamModel, models: readonly TeamModel[], limits?: TeamConfig | null): TeamSetup {
  const taken = new Set<string>();
  const workers: WorkerProfile[] = models.map(model => {
    const id = rosterId(model, taken); taken.add(id);
    return { id, name: `${model.name} · ${model.harness}`.slice(0, 80), provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort || null };
  });
  const architect: ModelSelection = { provider: lead.provider, model: lead.model, reasoningEffort: lead.reasoningEffort || null };
  const config: TeamConfig = { auto: true, rosterOnly: true, name: name.trim(), workers, maxParallel: limits?.maxParallel ?? 0, maxRounds: limits?.maxRounds ?? 8, maxAssignments: limits?.maxAssignments ?? 24, workspace: 'shared', summaryLimit: limits?.summaryLimit ?? 3072, ...(limits?.leadGuidance ? { leadGuidance: limits.leadGuidance } : {}) };
  return { architect, config };
}

/** Whether two setups are the same team, so a saved profile still describes the form. */
const selectionKey = (model: ModelSelection) => [model.provider, model.model, model.reasoningEffort ?? null];
export function sameTeamSetup(left: TeamSetup, right: TeamSetup): boolean {
  const key = (setup: TeamSetup) => JSON.stringify([selectionKey(setup.architect),
    setup.config.workers.map(worker => [worker.id, worker.name, ...selectionKey(worker)]),
    setup.config.maxParallel, setup.config.maxRounds, setup.config.maxAssignments, setup.config.workspace, setup.config.summaryLimit, setup.config.leadGuidance?.trim() || null]);
  return key(left) === key(right);
}

export const namedTeams = (library: TeamLibrary): TeamProfile[] => library.profiles.filter(profile => profile.setup.config.rosterOnly);

export function teamDetail(profile: TeamProfile, harnessName: (id: ProviderId) => string): string {
  const { architect, config } = profile.setup;
  const lead = config.workers.find(worker => worker.provider === architect.provider && worker.model === architect.model);
  const count = config.workers.length;
  const ledBy = lead ? lead.name : t`${architect.model || t('Default')} · ${harnessName(architect.provider)}`;
  return count === 1 ? t`${count} model · led by ${ledBy}` : t`${count} models · led by ${ledBy}`;
}

/** Whether a task's team is this named team. */
export function isTeam(config: TeamConfig | undefined, profile: TeamProfile): boolean {
  return Boolean(config?.rosterOnly && config.name === profile.setup.config.name
    && JSON.stringify(config.workers) === JSON.stringify(profile.setup.config.workers));
}
