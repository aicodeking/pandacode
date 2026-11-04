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
