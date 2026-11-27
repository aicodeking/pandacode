// An architect task's team, as `task.team` sends it ({ team: null | { mode, rounds: { used },
// workers } }, the desktop's TeamSnapshot trimmed), and the `team` live event's changed worker
// row ({ removed: true } drops it). Tolerant of the full TeamSnapshot too. Pure (tested in node).
import type { WorkerNames } from './pandacode-tools.ts';

export type WorkerStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
export interface Checkpoint { summary: string; nextSteps: string; blocker: string | null; updatedAt: number }
/** A Council reviewer's seat: which round and lens it sits in, and its score once it has one
 * (native's `council` block on a worker). Its presence is what makes a worker a reviewer. */
export interface CouncilSeat { round: number; lens: string; score: number | null; startedAt: number }
export interface TeamWorker {
  id: string; name: string; provider: string; model: string; sessionId: string; status: WorkerStatus;
  assignment: string; summary: string; error: string | null; files: string[]; dependsOn: string[]; readOnly: boolean;
  abandoned: boolean; attempt: number; checkpoint: Checkpoint | null; createdAt: number; updatedAt: number;
  /** The host's `parked`: its run ended while its sub-workers work. `status` is then `waiting`. */
  parked?: true;
  /** A Council reviewer's seat; absent on an ordinary worker. */
  council?: CouncilSeat;
}
/** The task's Council setting (native `CouncilConfig`), or nothing when it is off. */
export interface CouncilConfig { target: number; maxRounds: number; reviewers: number }
/** Where Council stands, from native (`councilStatus`), which is authoritative: the webview derives no state. */
export type CouncilState = 'accepted' | 'waiting' | 'reviewing' | 'dispatch' | 'asking' | 'fixing' | 'passed' | 'limit';
export interface CouncilStatus {
  state: CouncilState; round: number; lowest: number | null; target: number; stale: boolean;
  /** A plain sentence for the user while Council holds the team on a refusal (asking or paused). */
  notice?: string;
}
export interface Team { mode: string; status: string; rounds: { used: number }; workers: TeamWorker[]; summary: string; updatedAt: number;
  /** The host cut text, files or rows of this reply to fit. */
  cut?: true;
  /** Why the team paused or failed, or why its lead is quiet. */
  error?: string;
  /** Council's setting, null/absent when it is off or the host predates Council over Connect. */
  council?: CouncilConfig | null;
  /** Native's Council state while Council is on. */
  councilStatus?: CouncilStatus | null;
  /** This cycle's scores were accepted (Accept and finish), so nothing more is offered. */
  councilAccepted?: boolean;
}

const STATUSES: readonly string[] = ['queued', 'running', 'waiting', 'parked', 'completed', 'failed', 'stopped'];
/** The Council states native sends; anything else is treated as unknown rather than printed raw. */
const COUNCIL_STATES: readonly string[] = ['accepted', 'waiting', 'reviewing', 'dispatch', 'asking', 'fixing', 'passed', 'limit'];
const MAX_TEXT = 262_144;
const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : 0);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 512)) : []);
/** A score as native sends it: a finite number, or null (never NaN, never a string). */
const score = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A non-negative whole number, or null when the value is not one. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** A worker's Council seat, or undefined when it is not a reviewer (or the block is malformed). */
function seat(v: unknown): CouncilSeat | undefined {
  if (!v || typeof v !== 'object') return;
  const s = v as Record<string, unknown>;
  const round = count(s.round);
  if (round === null) return;
  return { round, lens: str(s.lens, 256), score: score(s.score), startedAt: time(s.startedAt) };
}

/** Council's setting; null when it is off, undefined when the host sent nothing usable. */
function councilConfig(v: unknown): CouncilConfig | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return;
  const c = v as Record<string, unknown>;
  const target = score(c.target);
  if (target === null) return;
  return { target, maxRounds: count(c.maxRounds) ?? 0, reviewers: count(c.reviewers) ?? 0 };
}

/** Native's Council state; null when Council is off, undefined when the block is malformed. */
function councilStatus(v: unknown): CouncilStatus | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return;
  const s = v as Record<string, unknown>;
  // An unknown state is worse than no state: the card would otherwise print a word it cannot act on.
  if (typeof s.state !== 'string' || !COUNCIL_STATES.includes(s.state)) return;
  const notice = str(s.notice, 1024);
  return {
    state: s.state as CouncilState, round: count(s.round) ?? 0, lowest: score(s.lowest), target: score(s.target) ?? 0,
    stale: s.stale === true, ...(notice ? { notice } : {}),
  };
}

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
  const reviewer = seat(w.council);
  return {
    id: w.id.slice(0, 128), name: str(w.name, 120) || 'Worker', provider: str(w.provider, 40), model: str(w.model, 200), sessionId: str(w.sessionId, 128),
    status: w.status === 'parked' ? 'waiting' : w.status as WorkerStatus, ...(w.status === 'parked' ? { parked: true as const } : {}), assignment: str(w.assignment, MAX_TEXT), summary: str(w.summary, MAX_TEXT), error: str(w.error, 4096) || null,
    files: strings(w.files), dependsOn: strings(w.dependsOn), readOnly: w.readOnly === true, abandoned: w.abandoned === true,
    attempt: Number(w.attempt) || 1, checkpoint: checkpoint(w.checkpoint), createdAt: time(w.startedAt) || time(w.createdAt), updatedAt: time(w.updatedAt),
    ...(reviewer && { council: reviewer }),
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
  const council = councilConfig(t.council), councilState = councilStatus(t.councilStatus);
  return {
    mode: str(t.mode, 20) || ((t.config as { auto?: boolean } | undefined)?.auto === false ? 'classic' : 'auto'),
    status: str(t.status, 40) || status(workers),
    // Rounds have no maximum any more, whatever an older host still sends.
    rounds: { used: Number(rounds.used ?? t.round) || 0 },
    workers, summary: str(t.summary, MAX_TEXT), updatedAt: time(t.updatedAt) || Math.max(0, ...workers.map(w => w.updatedAt)),
    ...(cut ? { cut: true as const } : {}),
    ...(error ? { error } : {}),
    // Absent on an older host, explicit null when Council is off: both read as "no Council here".
    ...(council !== undefined && { council }),
    ...(councilState !== undefined && { councilStatus: councilState }),
    ...(t.councilAccepted === true && { councilAccepted: true as const }),
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

// ---- Council ----
//
// Native's `councilStatus` is authoritative (the desktop derives no state of its own), so these
// helpers only read it. Mirrors src/council.ts, whose wording and one-decimal scores the desktop
// has used since Council shipped.

/** Every score and target shows one decimal: 9.0, 9.5, 10.0. */
export const formatScore = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);

/** A score against the target, for labels: "9.6 of 10 (target 9.5)". */
export const outOfTen = (value: number, target: number): string => `${formatScore(value)} of 10 (target ${formatScore(target)})`;

/** The settings a phone offers, as the desktop's panel does. */
export const COUNCIL_TARGETS = [7, 8, 8.5, 9, 9.5, 10] as const;
export const COUNCIL_ROUNDS = [3, 5, 10, 25] as const;
/** 0 = the lead picks reviewers for the work. */
export const COUNCIL_REVIEWERS = [0, 2, 3, 4, 5] as const;
export const COUNCIL_DEFAULTS: CouncilConfig = { target: 9, maxRounds: 10, reviewers: 0 };

/** Whether this team has Council on (and the host told us about it at all). */
export const councilOn = (team: Team | null | 'outdated' | undefined): boolean =>
  !!team && team !== 'outdated' && !!team.council;

/** Council as the card shows it, or null when it is off (or the host predates Council). */
export interface CouncilView {
  config: CouncilConfig;
  /** Native's state; the card prints this and offers exactly its actions. */
  status: CouncilStatus;
  /** The state in words, e.g. "Round 2 of 10 · reviewing". */
  line: string;
  lowest: number | null;
  target: number;
  /** This cycle's scores were accepted, so nothing more is offered. */
  accepted: boolean;
}

/** The state in words, for the card and the tray. Mirrors the desktop's `councilStateText`. */
export function councilStateText(status: CouncilStatus, maxRounds: number): string {
  const target = formatScore(status.target);
  switch (status.state) {
    case 'asking': return `Needs you · lowest ${status.lowest === null ? '—' : formatScore(status.lowest)} of 10 (target ${target})`;
    case 'passed': return `Passed at ${target}`;
    case 'accepted': return `Accepted${status.lowest === null ? '' : ` at ${formatScore(status.lowest)}`}`;
    case 'limit': return `Stopped at round limit (${status.round} of ${maxRounds})`;
    case 'fixing': return `Round ${status.round}${maxRounds ? ` of ${maxRounds}` : ''} · fixing`;
    case 'reviewing': return `Round ${status.round}${maxRounds ? ` of ${maxRounds}` : ''} · reviewing`;
    case 'dispatch': return `Round ${status.round}${maxRounds ? ` of ${maxRounds}` : ''} · waiting for reviewers`;
    default: return 'On, no round yet';
  }
}

/** Council on `team`, ready for the card; null when it is off, accepted-and-idle, or not known. */
export function councilView(team: Team | null | 'outdated' | undefined): CouncilView | null {
  if (!team || team === 'outdated' || !team.council || !team.councilStatus) return null;
  const { council: config, councilStatus: status } = team;
  return {
    config, status, accepted: team.councilAccepted === true,
    line: councilStateText(status, config.maxRounds),
    lowest: status.lowest, target: status.target,
  };
}

/** Whether the card has anything to say: a round ran, or the lead is asking. */
export function councilCardShown(team: Team | null | 'outdated' | undefined): boolean {
  const view = councilView(team);
  if (!view) return false;
  // A fresh cycle that has not reviewed anything yet says nothing (the tray still shows it is on).
  return view.status.round > 0 || view.status.state === 'asking' || view.status.state === 'accepted';
}

/** What the user can do in this state: exactly the desktop strip's buttons
 * (src/council-panel.ts `stripHtml`), never a wider set. */
export interface CouncilActions {
  /** Keep fixing: a follow-up to the lead (only while the lead is asking). */
  keep: boolean;
  /** Accept and finish: this cycle's scores stand. */
  accept: boolean;
  /** Lower the target: only where a lower step exists. */
  lower: boolean;
  /** Raise the round limit: at the limit, and only where a higher step exists. */
  raise: boolean;
}

export function councilActions(team: Team | null | 'outdated' | undefined): CouncilActions {
  const view = councilView(team);
  const none = { keep: false, accept: false, lower: false, raise: false };
  if (!view || view.accepted) return none;
  const { state, round } = view.status;
  // A lead that asked is answered three ways; everything else is the desktop's hint, not a button.
  if (state !== 'asking') return { ...none, raise: state === 'limit' && COUNCIL_ROUNDS.some(rounds => rounds > round) };
  return {
    keep: true,
    accept: true,
    lower: COUNCIL_TARGETS.some(target => target < view.config.target),
    raise: false,
  };
}

/** The reviewers of the latest round, in seat order, with their scores (one decimal on screen). */
export function councilSeats(team: Team | null | 'outdated' | undefined): (TeamWorker & { council: CouncilSeat })[] {
  if (!team || team === 'outdated') return [];
  const seats = team.workers.filter((w): w is TeamWorker & { council: CouncilSeat } => !!w.council && !w.abandoned);
  const latest = Math.max(0, ...seats.map(w => w.council.round));
  return seats.filter(w => w.council.round === latest).sort((a, b) => a.council.lens.localeCompare(b.council.lens));
}

/** The workers that are not Council reviewers (the Agents screen's ordinary rows). */
export const teamWorkers = (workers: readonly TeamWorker[]): TeamWorker[] => workers.filter(w => !w.council);

/** The reviewers' lowest score in the latest round, or null while it is unscored. */
export function lowestSeat(seats: readonly (TeamWorker & { council: CouncilSeat })[]): number | null {
  const scores = seats.map(w => w.council.score).filter((n): n is number => n !== null);
  return scores.length ? Math.min(...scores) : null;
}

/** A reviewer's verdict, for its row: at target, below it, or not yet scored. */
export function seatVerdict(seat: CouncilSeat, target: number): { tone: 'at' | 'below' | 'none'; text: string } {
  if (seat.score === null) return { tone: 'none', text: 'Not scored yet' };
  return seat.score >= target
    ? { tone: 'at', text: `${formatScore(seat.score)} of 10 · at target` }
    : { tone: 'below', text: `${formatScore(seat.score)} of 10 · below ${formatScore(target)}` };
}

/** The follow-up Keep fixing sends the lead, as the desktop sends it. */
export const KEEP_FIXING = 'Keep fixing until every reviewer reaches the target.';

/** Council's notice, or a plain line saying the lead is asking (never the lead-facing refusal text). */
export function councilNotice(team: Team | null | 'outdated' | undefined): string | null {
  if (!team || team === 'outdated') return null;
  const status = team.councilStatus;
  if (!status) return null;
  return status.notice || (status.state === 'asking' ? 'The lead is asking how to continue.' : null);
}
