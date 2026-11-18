/* Council: independent reviewers score the work out of 10 until every one reaches the user's target.
 * What a snapshot means, with no DOM, plus the remembered defaults. See docs/architect-workers.md. */
import { teamActive, type CouncilConfig, type CouncilState, type CouncilStatus, type TeamSnapshot, type TeamWorker } from './architect-types.ts';

export type { CouncilState, CouncilStatus };
export const COUNCIL_KEY = 'pandacode.council';
export const COUNCIL_TARGETS = [7, 8, 8.5, 9, 9.5, 10] as const;
/** Native allows 1-100 rounds; these are the choices offered. */
export const COUNCIL_ROUNDS = [3, 5, 10, 25] as const;
/** 0 = the lead picks reviewers for the work. */
export const COUNCIL_REVIEWERS = [0, 2, 3, 4, 5] as const;
const DEFAULTS: CouncilConfig = { target: 9, maxRounds: 10, reviewers: 0 };

export type CouncilSeatWorker = TeamWorker & { council: NonNullable<TeamWorker['council']> };
/** A round as shown: its seats and their lowest score. Whether it is done is native's to say (`councilStatus`). */
export interface CouncilRound { number: number; seats: CouncilSeatWorker[]; lowest: number | null }
/** `status` is native's `councilStatus`; the webview derives no state (native also sees edits it cannot, like the lead's own). */
export interface CouncilProgress { council: CouncilConfig; rounds: CouncilRound[]; latest: CouncilRound | undefined; state: CouncilState; status: CouncilStatus }
type CouncilTeam = Pick<TeamSnapshot, 'workers' | 'config' | 'councilSince' | 'councilStatus'>;

export const seatScore = (seat: Pick<CouncilSeatWorker, 'council'>): number | null => {
  const { score } = seat.council;
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
};
/** Every score and target, on screen and read aloud, has one decimal: 9.0, 9.5, 10.0. */
export const formatScore = (score: number): string => (Math.round(score * 10) / 10).toFixed(1);
/** A score against the target, for names and announcements: "9.6 out of 10 (target 9.5)". */
export const outOfTen = (score: number, target: number): string => `${formatScore(score)} out of 10 (target ${formatScore(target)})`;

/** The current cycle's rounds, oldest first. Reviewers from before the cycle are not part of it; an abandoned seat
 *  drops out unless it was scored (native refuses to cancel or replace a scored seat). */
export function councilRounds(team: Pick<TeamSnapshot, 'workers' | 'councilSince'>): CouncilRound[] {
  const since = team.councilSince ?? 0, byRound = new Map<number, CouncilSeatWorker[]>();
  for (const worker of team.workers) {
    if (!worker.council || worker.createdAt < since || (worker.abandoned && seatScore(worker as CouncilSeatWorker) === null)) continue;
    byRound.set(worker.council.round, [...(byRound.get(worker.council.round) ?? []), worker as CouncilSeatWorker]);
  }
  return [...byRound].sort(([a], [b]) => a - b).map(([number, seats]) => {
    const scores = seats.map(seatScore).filter((score): score is number => score !== null);
    return { number, seats, lowest: scores.length ? Math.min(...scores) : null };
  });
}

/** The council's rounds and overall state; null while the team has no council. */
export function councilProgress(team: CouncilTeam): CouncilProgress | null {
  const council = team.config.council;
  if (!council) return null;
  // A host that sends no status yet (an older remote) reads as waiting; its rounds still show.
  const rounds = councilRounds(team), status = team.councilStatus ?? { state: 'waiting', round: 0, lowest: null, target: council.target, stale: false };
  return { council, rounds, latest: rounds.at(-1), state: status.state, status };
}

/** Whether a round's lowest is only so far: native is still reviewing that round. */
export const provisional = ({ status }: CouncilProgress, round: CouncilRound): boolean => (status.state === 'reviewing' || status.state === 'dispatch') && status.round === round.number;

/** The team rests for the user: native's state, nothing else. */
export const councilAsking = (status: CouncilStatus): boolean => status.state === 'asking';

/** What the user reads in place of a Council refusal in `team.error` (written for the lead, never shown raw): native's notice,
 *  set whenever there is one (asking or paused). */
export function councilNotice(team: Pick<TeamSnapshot, 'councilStatus'>): string | null {
  const status = team.councilStatus;
  return status?.notice || (status && councilAsking(status) ? 'The lead is asking how to continue.' : null);
}

/** How a team that is not running reads: Failed, Stopped, Paused or Interrupted. */
export const runWord = (run: Pick<TeamSnapshot, 'status' | 'error'>): string =>
  run.status === 'failed' ? 'Failed' : run.status === 'paused' ? (/^Team stopped/.test(run.error ?? '') ? 'Stopped' : 'Paused') : run.status === 'interrupted' ? 'Interrupted' : 'Stopped';

/** The team finished (nothing running, nothing asked) with the work still below target. */
export function finishedBelow({ status }: CouncilProgress, run: Pick<TeamSnapshot, 'status'>): boolean {
  return !teamActive(run as TeamSnapshot) && (run.status === 'completed' || run.status === 'ready') && (status.state === 'fixing' || status.state === 'reviewing' || status.state === 'dispatch')
    && status.lowest !== null && status.lowest < status.target;
}

/** The state in words. With the team's run, a council whose team is not running never claims to wait, review or fix. */
/** `lowered`: the target was lowered during this cycle, so a pass says so. */
export function councilStateText({ council, status, rounds: cycle }: CouncilProgress, run?: Pick<TeamSnapshot, 'status' | 'error'>, lowered = false): string {
  const target = formatScore(status.target), lowest = status.lowest === null ? null : formatScore(status.lowest);
  const rounds = ` of ${council.maxRounds}`;
  // Native's `stale`: something changed after the latest round started. Only a passing round is undone by it;
  // a stale round below target is the ordinary fixing loop.
  const changedAfterPass = status.stale && status.lowest !== null && status.lowest >= status.target;
  const idle = run && !teamActive(run as TeamSnapshot);
  if (idle && status.state === 'waiting') return run.status === 'completed' || run.status === 'ready' ? 'No changes to review yet' : `${runWord(run)} before the first round`;
  if (idle && (status.state === 'reviewing' || status.state === 'dispatch' || status.state === 'fixing')) {
    // The footer carries the numbers.
    if (run.status === 'completed' || run.status === 'ready') return changedAfterPass ? `Finished with changes since passing at ${lowest}` : lowest ? 'Finished below target' : 'Finished before any score';
    // An open round's lowest is only the lowest so far.
    return [runWord(run), `round ${status.round}${rounds}`, lowest && `lowest ${status.state === 'fixing' ? '' : 'so far '}${lowest}`, lowest && `target ${target}`].filter(Boolean).join(' · ');
  }
  switch (status.state) {
    case 'waiting': return 'Waiting for reviewers';
    case 'reviewing': return `Round ${status.round}${rounds} · reviewing`;
    case 'dispatch': return `Round ${status.round}${rounds} · waiting for the lead`;
    // The score is in native's notice, shown with the card's actions.
    case 'asking': return 'Needs you';
    // The card's footer (round history, target) carries the scores.
    case 'fixing': return changedAfterPass ? `Changed after passing at ${lowest}: fixing` : `Round ${status.round}${rounds} · fixing`;
    case 'passed': return `Passed at ${lowest}${lowered ? ` (target lowered to ${target})` : ''}`;
    // Accepted while the latest round has no score: the last complete round's lowest, else just "Accepted".
    case 'accepted': { const last = status.lowest ?? [...cycle].reverse().find(round => round.lowest !== null)?.lowest; return last === undefined || last === null ? 'Accepted' : `Accepted at ${formatScore(last)}`; }
    case 'limit': return `${changedAfterPass ? `Stopped at round limit: changed after passing at ${lowest}` : 'Stopped at round limit'} (${status.round}${rounds})`;
  }
}

/** A reviewer's score against the target, in words and a tone ('at', 'below', or none when no target is known). */
export const scoreVerdict = (score: number, target: number | undefined): { text: string; tone: '' | 'at' | 'below' } =>
  target === undefined ? { text: `Scored ${formatScore(score)}`, tone: '' }
    : score >= target ? { text: `Scored ${formatScore(score)} · at target`, tone: 'at' } : { text: `Scored ${formatScore(score)} · below ${formatScore(target)}`, tone: 'below' };


/** Each lens's first score this cycle and its latest, for the settled card's first-vs-final table; lenses in first-seen order. */
export function firstAndFinal(rounds: readonly CouncilRound[]): { lens: string; first: number; final: number }[] {
  const byLens = new Map<string, { lens: string; first: number; final: number }>();
  for (const round of rounds) for (const seat of round.seats) {
    const score = seatScore(seat), lens = seat.council.lens.trim() || seat.name;
    if (score === null) continue;
    const known = byLens.get(lens);
    byLens.set(lens, known ? { ...known, final: score } : { lens, first: score, final: score });
  }
  return [...byLens.values()];
}

/** The seats the scorecard shows instead of plain worker rows. */
export const councilSeatIds = (progress: CouncilProgress | null): Set<string> => new Set(progress?.rounds.flatMap(round => round.seats.map(seat => seat.id)) ?? []);

const pick = <T extends number>(value: unknown, options: readonly T[], fallback: T): T => options.includes(value as T) ? value as T : fallback;

/** The settings a new council starts with; council itself is off on each new thread. A value no longer offered
 *  (an old 0, "no limit", for rounds) reads as the default. */
export function councilDefaults(): CouncilConfig {
  let saved: Partial<Record<keyof CouncilConfig, unknown>> | null = null;
  try { saved = JSON.parse(localStorage.getItem(COUNCIL_KEY) ?? 'null'); } catch { /* Unreadable or malformed storage falls back. */ }
  return {
    target: pick(saved?.target, COUNCIL_TARGETS, DEFAULTS.target),
    maxRounds: pick(saved?.maxRounds, COUNCIL_ROUNDS, DEFAULTS.maxRounds),
    reviewers: pick(saved?.reviewers, COUNCIL_REVIEWERS, DEFAULTS.reviewers),
  };
}
function savedDefaults(): Record<string, unknown> {
  try { const saved = JSON.parse(localStorage.getItem(COUNCIL_KEY) ?? 'null'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
}
export function saveCouncilDefaults(council: CouncilConfig): void {
  try { localStorage.setItem(COUNCIL_KEY, JSON.stringify({ ...savedDefaults(), ...council })); } catch { /* Kept for this window only. */ }
}
/** Whether a new thread starts with Council on (when its team starts, or on its first send). Stored with the defaults. */
export const councilForNewThreads = (): boolean => savedDefaults().newThreads === true;
export function setCouncilForNewThreads(on: boolean): void {
  try { localStorage.setItem(COUNCIL_KEY, JSON.stringify({ ...savedDefaults(), newThreads: on })); } catch { /* Kept for this window only. */ }
}

/** A reviewer row's verdict, one vocabulary for the card, the thread's rows and the Workers list: at target in the success
 *  tone; below it, the warning only on its round's lowest seat once that round is complete (others, and an open round's
 *  lowest, stay neutral). The target is native's (`councilStatus.target`) when it has one. */
export function seatVerdict(team: Pick<TeamSnapshot, 'workers' | 'config' | 'councilSince' | 'councilStatus'>, seat: Pick<CouncilSeatWorker, 'council' | 'createdAt'>): { text: string; tone: '' | 'at' | 'below' } | null {
  const score = seatScore(seat), target = team.councilStatus?.target ?? team.config.council?.target;
  if (score === null) return null;
  const verdict = scoreVerdict(score, target);
  if (verdict.tone !== 'below') return verdict;
  const since = team.councilSince ?? 0, current = seat.createdAt >= since;
  const peers = team.workers.filter(worker => worker.council?.round === seat.council.round && (worker.createdAt >= since) === current);
  const lowest = Math.min(...peers.map(worker => seatScore(worker as CouncilSeatWorker)).filter((value): value is number => value !== null));
  const status = team.councilStatus, open = current && (status?.state === 'reviewing' || status?.state === 'dispatch') && status.round === seat.council.round;
  return { ...verdict, tone: score === lowest && !open ? 'below' : '' };
}
