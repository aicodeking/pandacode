// An architect task's team, as `task.team` sends it ({ team: null | { mode, rounds: { used },
// workers } }, the desktop's TeamSnapshot trimmed), and the `team` live event's changed worker
// row ({ removed: true } drops it). Tolerant of the full TeamSnapshot too. Pure (tested in node).
import type { WorkerNames } from './pandacode-tools.ts';

export type WorkerStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
export interface Checkpoint { summary: string; nextSteps: string; blocker: string | null; updatedAt: number }
export interface TeamWorker {
  id: string; name: string; provider: string; model: string; sessionId: string; status: WorkerStatus;
  assignment: string; summary: string; error: string | null; files: string[]; dependsOn: string[]; readOnly: boolean;
  abandoned: boolean; attempt: number; checkpoint: Checkpoint | null; createdAt: number; updatedAt: number;
  /** The host's `parked`: its run ended while its sub-workers work. `status` is then `waiting`. */
  parked?: true;
}
export interface Team { mode: string; status: string; rounds: { used: number }; workers: TeamWorker[]; summary: string; updatedAt: number;
  /** The host cut text, files or rows of this reply to fit. */
  cut?: true;
  /** Why the team paused or failed, or why its lead is quiet. */
  error?: string;
}

const STATUSES: readonly string[] = ['queued', 'running', 'waiting', 'parked', 'completed', 'failed', 'stopped'];
const MAX_TEXT = 262_144;
const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : 0);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 512)) : []);

function checkpoint(v: unknown): Checkpoint | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const summary = str(c.summary, MAX_TEXT);
  return summary || c.nextSteps ? { summary, nextSteps: str(c.nextSteps, MAX_TEXT), blocker: str(c.blocker, MAX_TEXT) || null, updatedAt: time(c.updatedAt) } : null;
}

function worker(v: unknown): TeamWorker | undefined {
  if (!v || typeof v !== 'object') return;
  const w = v as Record<string, unknown>;
  if (typeof w.id !== 'string' || !w.id || !STATUSES.includes(w.status as string)) return;
  return {
    id: w.id.slice(0, 128), name: str(w.name, 120) || 'Worker', provider: str(w.provider, 40), model: str(w.model, 200), sessionId: str(w.sessionId, 128),
    status: w.status === 'parked' ? 'waiting' : w.status as WorkerStatus, ...(w.status === 'parked' ? { parked: true as const } : {}), assignment: str(w.assignment, MAX_TEXT), summary: str(w.summary, MAX_TEXT), error: str(w.error, 4096) || null,
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
  const workers = t.workers.map(worker).filter((w): w is TeamWorker => !!w);
  const rounds = (t.rounds && typeof t.rounds === 'object' ? t.rounds : {}) as Record<string, unknown>;
  const error = str(t.error, 4096);
  const cut = t.truncated === true || t.workersTruncated === true || t.workers.some(w => (w as { filesTruncated?: unknown } | null)?.filesTruncated === true);
  return {
    mode: str(t.mode, 20) || ((t.config as { auto?: boolean } | undefined)?.auto === false ? 'classic' : 'auto'),
    status: str(t.status, 40) || status(workers),
    // Rounds have no maximum any more, whatever an older host still sends.
    rounds: { used: Number(rounds.used ?? t.round) || 0 },
    workers, summary: str(t.summary, MAX_TEXT), updatedAt: time(t.updatedAt) || Math.max(0, ...workers.map(w => w.updatedAt)),
    ...(cut ? { cut: true as const } : {}),
    ...(error ? { error } : {}),
  };
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
  const base: Team = team ?? { mode: 'auto', status: 'running', rounds: { used: 0 }, workers: [], summary: '', updatedAt: 0 };
  const known = base.workers.some(w => w.id === row.id);
  return withWorkers(base, known ? base.workers.map(w => (w.id === row.id ? row : w)) : [...base.workers, row]);
}

const withWorkers = (team: Team, workers: TeamWorker[]): Team =>
  // A parked worker has no process, so it never restarts a failed or paused team.
  ({ ...team, workers, status: workers.some(w => workerActive(w) && !w.parked) ? 'running' : team.status, updatedAt: Math.max(team.updatedAt, ...workers.map(w => w.updatedAt)) });

/** Resume applies (`can_resume` in architect.rs). */
export const teamResumable = (team: Team | null | undefined) => team?.status === 'paused' || team?.status === 'failed' || team?.status === 'interrupted';
export const teamActive = (team: Team | null | undefined) => team?.status === 'running' || team?.status === 'waiting';
export const workerActive = (w: TeamWorker) => !w.abandoned && (w.status === 'running' || w.status === 'waiting' || w.status === 'queued');

/** The worker is working now: active itself, in an active team (else it reads as Paused). */
export const workerRunning = (w: TeamWorker, team: Team | null | undefined) => teamActive(team) && workerActive(w);
/** When the worker's elapsed time ends: now while it runs, else its last update. */
export const workerClockEnd = (w: TeamWorker, team: Team | null | undefined, now: number) => (workerRunning(w, team) ? now : w.updatedAt || now);

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

/** The Agents screen's title for its workers: the round used, never a maximum. */
export const workersTitle = (team: Team) => `Team workers${team.rounds.used ? ` · round ${team.rounds.used}` : ''}`;

/** The Agents screen's note when a host left something out of what it shows. */
export function cutNote(team: Team | null | 'outdated' | undefined, subagentsCut: boolean | undefined): string | undefined {
  const cut = (team && team !== 'outdated' && team.cut) || subagentsCut;
  return cut ? 'Some agent details were left out to fit. Open this task on the computer to see them.' : undefined;
}

/** Worker id → name, for tool sentences (`Asked GPT-6 for a follow-up`). */
export const workerNames = (team: Team | null | undefined): WorkerNames =>
  Object.fromEntries((team?.workers ?? []).map(w => [w.id, w.name]));

const LABELS: Record<WorkerStatus, string> = { running: 'Working', waiting: 'Needs attention', queued: 'Queued', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };

/** The worker's status word as the desktop's team progress line: Skipped, Paused (team idle) or its own. */
export function workerLabel(w: TeamWorker, team: Team | null | undefined): string {
  if (w.abandoned) return 'Skipped';
  if (!teamActive(team) && workerActive(w)) return 'Paused';
  return w.parked ? 'Waiting on sub-workers' : LABELS[w.status];
}
