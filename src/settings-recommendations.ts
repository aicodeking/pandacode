/** What Settings → Recommended suggests. Pure, so it is unit-tested (tests/settings-recommendations.test.mjs). Recommending
 * never changes anything: each row says whether the setting is on and opens the page that owns it. */
import type { SettingsPage } from './settings-sections';

/** What the page knows. null: it could not be read, so the row says nothing rather than something untrue. */
export interface RecommendationFacts {
  agentInstalled: boolean;
  /** null when this build has no self-update (a package, or the browser preview): the row is dropped. */
  updateMode: string | null;
  telemetryOff: boolean | null;
  routingOn: boolean | null;
  turnChecks: boolean;
  connectSignedIn: boolean | null;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  page: SettingsPage;
  /** A closed fold on that page which holds the setting. */
  fold?: string;
  /** null: no status to show. */
  done: boolean | null;
  /** Worth having for some work, not everyone: it never counts as unfinished. */
  optional?: boolean;
}

export function recommendations(facts: RecommendationFacts): Recommendation[] {
  return [
    { id: 'agent', title: 'Install an agent', why: 'PandaCode runs the coding agents on this computer.', page: 'agents', done: facts.agentInstalled },
    ...(facts.updateMode === null ? [] : [{ id: 'updates', title: 'Update automatically', why: 'Installs only while no agent is working and you are idle.', page: 'about' as const, done: facts.updateMode === 'automatic' }]),
    { id: 'telemetry', title: 'Turn off agent telemetry', why: 'Uses each agent’s own opt-outs for analytics and error reports.', page: 'agents', fold: 'Advanced', done: facts.telemetryOff },
    { id: 'routing', title: 'Route team workers by task', why: 'Picks a model that fits each job. Downloads a small model once.', page: 'routing', done: facts.routingOn },
    { id: 'checks', title: 'Check the work after each turn', why: 'Runs the project’s own checks with your credentials. For projects you trust.', page: 'agents', done: facts.turnChecks, optional: true },
    { id: 'connect', title: 'Control tasks from your phone', why: 'End-to-end encrypted, and off until you sign in with GitHub.', page: 'remote', done: facts.connectSignedIn, optional: true },
    { id: 'github', title: 'Work with GitHub', why: 'Pull requests and issues, using your own gh sign-in.', page: 'github', done: null, optional: true },
  ];
}

/** The line at the top of the page, counting only what could be read and is recommended to everyone. */
export function recommendationSummary(list: Recommendation[]): string {
  const known = list.filter(item => !item.optional && item.done !== null);
  const done = known.filter(item => item.done).length;
  return known.length && done === known.length ? 'All set' : `${done} of ${known.length} set`;
}
