/**
 * Upstream workers adapter (S0605, docs/extensions/upstream-workers.md). JSON-only: it maps the workers panel and dock
 * surfaces PandaCode 0.3.128 added to the public primitives that already exist (panda.actionDock, panda.team.*,
 * panda.roster, panda.agentsDock.*) and holds the one captured, revisioned error dismissal of the Running agents
 * window. Worker state, approvals, Stop, effort actually applied and approval state stay in the host.
 */
import { errorKey } from '../thread-errors.ts';

export type WorkersDisposition = 'adapter' | 'protected';
export type WorkersMember = Readonly<{
  member: string; upstream: string; disposition: WorkersDisposition; locations: readonly string[];
  /** The existing public primitive that carries it, or why none does. */
  by: string; reason?: string; handoff?: string;
}>;

/** One entry per upstream member of the Workers panel and the Running agents dock. A capability that needs a new
 * runtime ability names its handoff (owned by the runtime phase), never a permanent refusal. */
export const WORKERS_REGISTRY: readonly WorkersMember[] = Object.freeze(([
  { member: 'worker-identity', upstream: 'team-progress worker row (name, harness logo, model and profile detail)', disposition: 'adapter', locations: ['panda.team.controls', 'panda.team.actions', 'panda.team.context'], by: 'dockCoverage: worker-open handles are opaque and ordered as drawn; a package reorders or hides rows, never renames them' },
  { member: 'worker-status', upstream: 'workerLabels and the attention count (Working, Needs attention, Queued, Waiting on sub-workers, Paused)', disposition: 'adapter', locations: ['panda.actionDock', 'panda.team.actions'], by: 'dockCoverage: DockPresentation.workers status and attention need tasks.summary' },
  { member: 'worker-selection', upstream: 'open-team-worker and open-team-progress', disposition: 'adapter', locations: ['panda.team.controls'], by: 'dockCoverage: captured worker-open / team-open reach the original handlers; a stale revision is refused' },
  { member: 'worker-effort', upstream: 'effortLabel: the effort a worker was asked to run at', disposition: 'protected', locations: ['panda.team.context'], by: 'host-rendered text', reason: 'The effort label is host-rendered detail; the effort actually applied is native state (architect/model_efforts.rs) a package never sets or reads.', handoff: 'R0404B: worker, council and limit controls' },
  { member: 'worker-reviewer', upstream: 'reviewerRow: a Council reviewer named by its lens, scored against the target', disposition: 'protected', locations: ['panda.team.context'], by: 'host-rendered text', reason: 'Scores and verdicts are host council state; the row stays one of the captured worker handles.', handoff: 'R0404B: worker, council and limit controls' },
  { member: 'worker-tally', upstream: 'teamTally: "1 needs you, 2 working, 3 done" with shorter fallbacks', disposition: 'adapter', locations: ['panda.team.actions'], by: 'panda.team.actions status and badge (permissioned counts only)' },
  { member: 'worker-request', upstream: 'requestHtml: the assignment text of a worker', disposition: 'protected', locations: ['panda.team.context'], by: 'host-rendered text', reason: 'The assignment is prompt content; it never crosses the package boundary.' },
  { member: 'worker-approval', upstream: 'approvalLabel and worker_approvals', disposition: 'protected', locations: ['panda.actionDock.protected'], by: 'host authorization', reason: 'Approve and deny stay host authorization; the label is announced by the host only.' },
  { member: 'dock-dismiss-error', upstream: 'dismiss-error in the Running agents window', disposition: 'protected', locations: ['panda.agentsDock.protected'], by: 'captured, revisioned dismissal in this module', reason: 'Dismissing a built-in failure stays host-owned, as in the thread; the dismissal acts only on the failure that was shown.' },
] as WorkersMember[]).map(entry => Object.freeze(entry)));

/** Worker rows a package may see: bounded, opaque, no names, assignments, paths or summaries. */
export type WorkerRowSource = Readonly<{ id: string; status: 'queued' | 'running' | 'waiting' | 'parked' | 'completed' | 'failed' | 'stopped'; abandoned?: boolean; reasoningEffort?: string | null }>;
export type WorkerRowView = Readonly<{ id: string; status: string; attention: boolean; effort: string }>;
export const MAX_WORKER_ROWS = 64;
/** upstream's own label rule (architect-worker-list effortLabel), kept here so this core stays free of DOM imports. */
export const effortWord = (effort: string | null | undefined): string => (effort ?? '').replace(/^x(?=high$)/i, 'x-');
export function projectWorkers(workers: readonly WorkerRowSource[], active: boolean, asking: (id: string) => boolean = () => false): { rows: readonly WorkerRowView[]; truncated: boolean } {
  const rows = workers.slice(0, MAX_WORKER_ROWS).map(worker => Object.freeze({
    id: worker.id,
    status: worker.abandoned ? 'skipped' : !active && ['running', 'waiting', 'queued', 'parked'].includes(worker.status) ? 'paused' : worker.status,
    attention: !worker.abandoned && (worker.status === 'waiting' || (worker.status === 'running' && asking(worker.id))),
    effort: effortWord(worker.reasoningEffort),
  }));
  return { rows: Object.freeze(rows), truncated: workers.length > MAX_WORKER_ROWS };
}

/** The dock's one visible failure: its grouping key is the thread's (`errorKey`), so a repeat of the same failure is the
 * same group and a different one is another. The revision moves on every change of what is shown. */
export type DockError = Readonly<{ key: string; revision: number }>;
export type DockErrorAdmission = { ok: true } | { ok: false; reason: 'StaleContext' | 'AlreadyApplied' | 'InvalidArguments' };
export function createDockErrorState() {
  let shown: { key: string; revision: number; text: string } | null = null, revision = 0;
  const done = new Set<string>();
  return {
    /** The text now shown, or '' to clear. Identical text keeps its capture, as the live region does. */
    show(text: string): DockError | null {
      if (text === (shown?.text ?? '')) return shown ? { key: shown.key, revision: shown.revision } : null;
      revision += 1;
      shown = text ? { key: errorKey(text), revision, text } : null;
      return shown ? { key: shown.key, revision: shown.revision } : null;
    },
    current(): DockError | null { return shown ? { key: shown.key, revision: shown.revision } : null; },
    /** A dismissal names the failure it was shown for; another or a cleared failure is refused. */
    dismiss(request: unknown, clear: () => void): DockErrorAdmission {
      if (!request || typeof request !== 'object') return { ok: false, reason: 'InvalidArguments' };
      const { key, revision: asked, requestId } = request as { key?: unknown; revision?: unknown; requestId?: unknown };
      if (typeof key !== 'string' || typeof asked !== 'number' || typeof requestId !== 'string' || !requestId) return { ok: false, reason: 'InvalidArguments' };
      if (done.has(requestId)) return { ok: false, reason: 'AlreadyApplied' };
      if (!shown || shown.key !== key || shown.revision !== asked) return { ok: false, reason: 'StaleContext' };
      if (done.size >= 4096) return { ok: false, reason: 'StaleContext' };
      done.add(requestId); clear(); return { ok: true };
    },
  };
}
