// An architect task's team, as `task.team` sends it ({ team: null | { mode, rounds: { used, max },
// workers } }, the desktop's TeamSnapshot trimmed), and the `team` live event's changed worker
// row ({ removed: true } drops it). Tolerant of the full TeamSnapshot too. Pure (tested in node).
import type { WorkerNames } from './pandacode-tools.ts';

export type WorkerStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
export interface Checkpoint { summary: string; nextSteps: string; blocker: string | null; updatedAt: number }
export interface TeamWorker {
  id: string; name: string; provider: string; model: string; sessionId: string; status: WorkerStatus;
  assignment: string; summary: string; error: string | null; files: string[]; dependsOn: string[]; readOnly: boolean;
  abandoned: boolean; attempt: number; checkpoint: Checkpoint | null; createdAt: number; updatedAt: number;
}
export interface TeamMessage { id: number; sender: string; recipient: string; message: string; createdAt: number }
/** `messages`: the newest messages between teammates (the host sends up to 30). */
export interface Team { mode: string; status: string; rounds: { used: number; max: number }; workers: TeamWorker[]; messages: TeamMessage[]; summary: string; updatedAt: number }

const STATUSES: readonly string[] = ['queued', 'running', 'waiting', 'completed', 'failed', 'stopped'];
const MAX_WORKERS = 64;
const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : 0);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 64).map(x => x.slice(0, 512)) : []);

function checkpoint(v: unknown): Checkpoint | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const summary = str(c.summary, 4096);
  return summary || c.nextSteps ? { summary, nextSteps: str(c.nextSteps, 4096), blocker: str(c.blocker, 2048) || null, updatedAt: time(c.updatedAt) } : null;
}

function worker(v: unknown): TeamWorker | undefined {
  if (!v || typeof v !== 'object') return;
  const w = v as Record<string, unknown>;
  if (typeof w.id !== 'string' || !w.id || !STATUSES.includes(w.status as string)) return;
  return {
    id: w.id.slice(0, 128), name: str(w.name, 120) || 'Worker', provider: str(w.provider, 40), model: str(w.model, 200), sessionId: str(w.sessionId, 128),
    status: w.status as WorkerStatus, assignment: str(w.assignment, 16_384), summary: str(w.summary, 16_384), error: str(w.error, 4096) || null,
    files: strings(w.files), dependsOn: strings(w.dependsOn), readOnly: w.readOnly === true, abandoned: w.abandoned === true,
    attempt: Number(w.attempt) || 1, checkpoint: checkpoint(w.checkpoint), createdAt: time(w.startedAt) || time(w.createdAt), updatedAt: time(w.updatedAt),
  };
}

const status = (workers: readonly TeamWorker[]) => (workers.some(workerActive) ? 'running' : workers.some(w => w.status === 'failed') ? 'failed' : 'completed');

/** A team from a reply (`{ team }` or the bare snapshot); null for none or a malformed one. */
export function decodeTeam(value: unknown): Team | null {
  const raw = value && typeof value === 'object' && 'team' in value ? (value as { team: unknown }).team : value;
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!Array.isArray(t.workers)) return null;
  const workers = t.workers.slice(0, MAX_WORKERS).map(worker).filter((w): w is TeamWorker => !!w);
  const rounds = (t.rounds && typeof t.rounds === 'object' ? t.rounds : {}) as Record<string, unknown>;
  return {
    mode: str(t.mode, 20) || ((t.config as { auto?: boolean } | undefined)?.auto === false ? 'classic' : 'auto'),
    status: str(t.status, 40) || status(workers),
    rounds: { used: Number(rounds.used ?? t.round) || 0, max: Number(rounds.max) || 0 },
    workers, messages: messages(t.messages), summary: str(t.summary, 16_384), updatedAt: time(t.updatedAt) || Math.max(0, ...workers.map(w => w.updatedAt)),
  };
}

function messages(v: unknown): TeamMessage[] {
  return (Array.isArray(v) ? v : []).slice(-50).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof m.id === 'number')
    .map(m => ({ id: m.id as number, sender: str(m.sender, 128), recipient: str(m.recipient, 128), message: str(m.message, 4096), createdAt: time(m.createdAt) }));
}

/** A `team` live event applied: the changed worker row upserted by id, or the team dropped on `{ removed: true }`. */
export function applyTeamEvent(team: Team | null | undefined, data: unknown): Team | null | undefined {
  if (!data || typeof data !== 'object') return team;
  const d = data as Record<string, unknown>;
  if (d.removed === true) return typeof d.id === 'string' && team ? withWorkers(team, team.workers.filter(w => w.id !== d.id)) : null;
  if (typeof d.teamStatus === 'string') return team ? { ...team, status: str(d.teamStatus, 40) } : team;
  if (Array.isArray(d.workers) || (d.team && typeof d.team === 'object')) return decodeTeam(d);
  const row = worker(d);
  if (!row) return team;
  const base: Team = team ?? { mode: 'auto', status: 'running', rounds: { used: 0, max: 0 }, workers: [], messages: [], summary: '', updatedAt: 0 };
  const known = base.workers.some(w => w.id === row.id);
  return withWorkers(base, known ? base.workers.map(w => (w.id === row.id ? row : w)) : [...base.workers, row]);
}

const withWorkers = (team: Team, workers: TeamWorker[]): Team =>
  ({ ...team, workers, status: workers.some(workerActive) ? 'running' : team.status, updatedAt: Math.max(team.updatedAt, ...workers.map(w => w.updatedAt)) });

export const teamActive = (team: Team | null | undefined) => team?.status === 'running' || team?.status === 'waiting';
export const workerActive = (w: TeamWorker) => !w.abandoned && (w.status === 'running' || w.status === 'waiting' || w.status === 'queued');

/** An architect task's team as newer hosts send it on list rows, subscribe rows and run.finished
 * (`team: { status, activeWorkers }`), or as a `team` event's `{ teamStatus, activeWorkers }`. */
export interface TeamRun { status: string; activeWorkers: number }

export function decodeTeamRun(value: unknown): TeamRun | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  const status = typeof v.status === 'string' ? v.status : typeof v.teamStatus === 'string' ? v.teamStatus : undefined;
  if (status === undefined) return;
  const n = Number(v.activeWorkers);
  return { status: status.slice(0, 40), activeWorkers: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999) : 0 };
}

/** The team keeps its task working (as the desktop does while it is running or waiting). */
export const teamBusy = (run: TeamRun | null | undefined) => run?.status === 'running' || run?.status === 'waiting';

/** A loaded task.team (older hosts send no TeamRun): busy while it is active and a worker still runs.
 * Workers are checked too since an older host's stored status is not updated by worker events. */
export function teamRun(team: Team | null | 'outdated' | undefined): TeamRun | undefined {
  if (!team || team === 'outdated') return;
  const activeWorkers = team.workers.filter(workerActive).length;
  return teamActive(team) && activeWorkers ? { status: team.status, activeWorkers } : { status: teamActive(team) ? 'completed' : team.status, activeWorkers };
}

/** The status line while only workers run: "Waiting on 2 workers". */
export const waitingOn = (n: number) => (n > 0 ? `Waiting on ${n} worker${n === 1 ? '' : 's'}` : 'Waiting on the team');

/** A teammate id as a name: Architect, the worker's name, else Worker. */
export const memberName = (team: Team | null | undefined, id: string) => (id === 'architect' ? 'Architect' : team?.workers.find(w => w.id === id)?.name ?? 'Worker');

/** Worker id → name, for tool sentences (`Asked GPT-6 for a follow-up`). */
export const workerNames = (team: Team | null | undefined): WorkerNames =>
  Object.fromEntries((team?.workers ?? []).map(w => [w.id, w.name]));

const LABELS: Record<WorkerStatus, string> = { running: 'Working', waiting: 'Needs attention', queued: 'Queued', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };

/** The worker's status word as the desktop's team progress line: Skipped, Paused (team idle) or its own. */
export function workerLabel(w: TeamWorker, team: Team | null | undefined): string {
  if (w.abandoned) return 'Skipped';
  if (!teamActive(team) && workerActive(w)) return 'Paused';
  return LABELS[w.status];
}
