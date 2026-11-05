import type { Message, TurnChanges } from './types.ts';
import { decodeToolActivity } from './tool-activity.ts';

export interface TranscriptTurn {
  user?: Message;
  coordination?: Message;
  handoff?: Message;
  activity: Message[];
  final?: Message;
  errors: Message[];
  /** PandaCode's own lines (`system` rows): always shown, and never the turn's reply. */
  notes: Message[];
  key: string;
  durationMs: number | null;
  estimated: boolean;
  changes?: TurnChanges;
  /** A merged lead exchange only (mergeLeadTurns): the change sets before `changes`, oldest first. */
  earlierChanges?: TurnChanges[];
  /** A merged lead exchange only: when its workers' slot starts, for a first segment with no start of its own. */
  workerStart?: number;
  /** A merged lead exchange only: `activity` with `final` still at its point in the timeline. */
  timeline?: Message[];
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function makeTurn(messages: Message[]): TranscriptTurn {
  const user = messages[0].role === 'user' ? messages[0] : undefined;
  const coordination = messages[0].role === 'coordination' ? messages[0] : undefined;
  const start = user ?? coordination;
  let toolKey: string | undefined;
  let legacyKey: string | undefined;
  let hasToolCall = false;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    if (message.content !== 'Tool finished') hasToolCall = true;
    const tool = decodeToolActivity(message.content);
    if (tool) toolKey ??= `turn:tool:${tool.id}`;
    else {
      legacyKey ??= `turn:message:${message.id}`;
    }
  }

  // An assistant update followed by tools is commentary at that point in the
  // timeline, not a final answer that belongs after those tools. Old generic
  // completion markers carry no new work and must not displace a final answer.
  const substantive = (message: Message) => message !== start && message.role !== 'error' && message.role !== 'changes' && message.role !== 'system'
    && !(hasToolCall && message.role === 'tool' && message.content === 'Tool finished');
  const lastContent = [...messages].reverse().find(substantive);
  const final = lastContent?.role === 'assistant' ? lastContent : undefined;
  const activity = messages.filter(message => message !== final && substantive(message));
  let durationMs: number | null = null;
  let estimated = false;
  if (start && validTime(start.turnDurationMs)) durationMs = start.turnDurationMs;
  else if (start && (final || messages.some(message => message.role === 'error')) && messages.every((message, index) =>
    validTime(message.createdAt) && (index === 0 || message.createdAt >= messages[index - 1].createdAt))) {
    durationMs = messages[messages.length - 1].createdAt - start.createdAt;
    estimated = true;
  }

  return {
    user, coordination, activity, final,
    errors: messages.filter(message => message.role === 'error'),
    notes: messages.filter(message => message.role === 'system'),
    key: toolKey ?? legacyKey ?? `turn:${start?.role ?? 'message'}:${messages[0].id}`,
    durationMs, estimated,
    changes: messages.find(message => message.role === 'changes' && message.turnChanges)?.turnChanges ?? start?.turnChanges ?? undefined,
  };
}

/** A page may begin mid-turn; keep that history separate without inventing its start time. */
export function groupTurns(messages: Message[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === 'handoff') {
      if (current.length) turns.push(makeTurn(current));
      current = [];
      turns.push({ handoff: message, activity: [], errors: [], notes: [], key: `handoff:${message.id}`, durationMs: null, estimated: false });
      continue;
    }
    if ((message.role === 'user' || message.role === 'coordination') && current.length) {
      turns.push(makeTurn(current));
      current = [];
    }
    current.push(message);
    if (message.role === 'changes') {
      turns.push(makeTurn(current));
      current = [];
    }
  }
  if (current.length) turns.push(makeTurn(current));
  return turns;
}

/** One card's worth of segments. A later segment's coordination label and all but the newest final are timeline rows. */
function joinSegments(segments: TranscriptTurn[]): TranscriptTurn {
  const first = segments[0];
  const final = [...segments].reverse().find(segment => segment.final)?.final;
  const timeline = segments.flatMap((segment, index) => [
    ...(index && segment.coordination ? [segment.coordination] : []),
    ...segment.activity,
    ...(segment.final ? [segment.final] : []),
  ]);
  // A segment that did work with no usable time makes the sum a lower bound; a wake that has done nothing costs nothing.
  const worked = segments.filter(segment => segment.durationMs !== null || segment.activity.length || segment.final || segment.errors.length);
  const timed = worked.filter(segment => segment.durationMs !== null);
  const changes = segments.flatMap(segment => segment.changes ? [segment.changes] : []);
  return {
    user: first.user, coordination: first.coordination, key: first.key, final, timeline,
    activity: timeline.filter(message => message !== final),
    errors: segments.flatMap(segment => segment.errors),
    notes: segments.flatMap(segment => segment.notes),
    durationMs: timed.length ? timed.reduce((total, segment) => total + segment.durationMs!, 0) : null,
    estimated: timed.length > 0 && (timed.length < worked.length || timed.some(segment => segment.estimated)),
    changes: changes.at(-1), earlierChanges: changes.slice(0, -1),
    workerStart: first.user?.createdAt ?? first.coordination?.createdAt ?? segments.find(segment => segment.coordination)?.coordination?.createdAt,
  };
}

/** Everything between one user message and the next is one card when a lead woke in it. For drawing cards only:
 * chat rows, the launcher and worker history read `groupTurns`. A range with no wake (a goal run's turns) is left alone. */
export function mergeLeadTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const merged: TranscriptTurn[] = [];
  let range: TranscriptTurn[] = [];
  const close = () => {
    if (range.length > 1 && range.some(turn => turn.coordination)) merged.push(joinSegments(range));
    else merged.push(...range);
    range = [];
  };
  for (const turn of turns) {
    if (turn.handoff) { close(); merged.push(turn); continue; }
    if (turn.user) close();
    range.push(turn);
  }
  close();
  return merged;
}

/** A wake run is streaming: the exchange it continues leaves the saved turns, to be drawn inside the live card.
 * `earlier` holds its rows with no reply, since the live card's reply belongs to the run; its text reads in the trace. */
export function splitLiveExchange(turns: TranscriptTurn[]): { saved: TranscriptTurn[]; earlier?: TranscriptTurn } {
  const last = turns.at(-1);
  if (!last || last.handoff || !(last.timeline || last.coordination)) return { saved: turns };
  const activity = last.timeline ?? [...last.activity, ...(last.final ? [last.final] : [])];
  return { saved: turns.slice(0, -1), earlier: { ...last, activity, final: undefined } };
}

export function formatDuration(ms: number): string {
  const seconds = validTime(ms) ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours ? `${hours}h` : '', minutes || hours ? `${minutes}m` : '', `${seconds % 60}s`]
    .filter(Boolean).join(' ');
}

export function turnLabel(durationMs: number | null, estimated = false): string {
  return validTime(durationMs)
    ? `Worked for ${estimated ? 'about ' : ''}${formatDuration(durationMs)}`
    : 'Tool activity';
}
