/** The pure half of desktop notifications: which events may notify given the settings and focus,
 * and how a batch of requests becomes one notice. src/notifications.ts owns the DOM side
 * (localStorage, focus, the native call); the settings section reads and writes through here. */

export type NotificationEventKind = 'approval' | 'input' | 'done' | 'failed';

/** macOS system sounds every Mac ships (NSSound names, played by name, nothing bundled). */
export const SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'] as const;
/** The picker's silent choice; nothing plays. */
export const SOUND_NONE = 'None';

export interface NotificationSettings {
  /** Master switch: show banners while PandaCode is not the focused app. */
  enabled: boolean;
  approval: boolean;
  input: boolean;
  finished: boolean;
  failed: boolean;
  /** While focused, approval and question events still play the chosen sound (never a banner). */
  soundWhenFocused: boolean;
  sound: string;
  /** A generic notice without the task's name. */
  hideDetails: boolean;
}

export const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true, approval: true, input: true, finished: false, failed: false,
  soundWhenFocused: false, sound: 'Glass', hideDetails: false,
};

const PREFIX = 'pandacode.notifications.';
const BOOLS = ['enabled', 'approval', 'input', 'finished', 'failed', 'soundWhenFocused', 'hideDetails'] as const;

/** Reads the stored choices; anything missing or malformed keeps its default. */
export function readSettings(storage: Pick<Storage, 'getItem'>): NotificationSettings {
  const next = { ...DEFAULT_SETTINGS };
  for (const key of BOOLS) {
    const raw = storage.getItem(PREFIX + key);
    if (raw === 'true' || raw === 'false') next[key] = raw === 'true';
  }
  const sound = storage.getItem(PREFIX + 'sound');
  if (sound !== null && (sound === SOUND_NONE || (SOUNDS as readonly string[]).includes(sound))) next.sound = sound;
  return next;
}

export function saveSetting(storage: Pick<Storage, 'setItem'>, key: (typeof BOOLS)[number] | 'sound', value: boolean | string): void {
  storage.setItem(PREFIX + key, String(value));
}

/** What one event may do: a banner (unfocused), or only its sound (focused). */
export type GateAction = 'banner' | 'sound';

export function gate(kind: NotificationEventKind, on: NotificationSettings, focused: boolean): GateAction | null {
  const wanted = kind === 'approval' ? on.approval : kind === 'input' ? on.input : kind === 'done' ? on.finished : on.failed;
  if (!wanted) return null;
  if (!focused) return on.enabled ? 'banner' : null;
  // Focused: no banner for anything; approvals and questions may still chime.
  return kind === 'approval' || kind === 'input' ? (on.soundWhenFocused ? 'sound' : null) : null;
}

/** The NSSound name to hand native, or undefined for silence. */
export function soundOf(on: Pick<NotificationSettings, 'sound'>): string | undefined {
  return on.sound && on.sound !== SOUND_NONE ? on.sound : undefined;
}

/** The batch is re-gated when its window ends: the app may have been focused (or the
 * notifications turned off) since the requests arrived. A focused flush downgrades to the
 * chosen sound alone; a batch nothing wants is dropped. */
export function flushGate(batch: PendingRequest[], on: NotificationSettings, focused: boolean): GateAction | null {
  if (!batch.some(item => gate(item.kind, on, focused))) return null;
  return focused ? 'sound' : 'banner';
}

export interface Notice { title: string; body: string; sessionId?: string }

/** The notice for one event. `hideDetails` keeps the task's name out of both lines. */
export function notice(kind: NotificationEventKind, title: string, hideDetails: boolean): Notice {
  if (hideDetails) return { title: 'PandaCode needs you', body: 'Open PandaCode to respond.' };
  switch (kind) {
    case 'approval': return { title: `${title} needs approval`, body: 'Review it in PandaCode.' };
    case 'input': return { title: `${title} needs your answer`, body: 'Reply in PandaCode.' };
    case 'done': return { title: `${title} finished`, body: 'Task finished.' };
    case 'failed': return { title: `${title} failed`, body: 'See PandaCode for the error.' };
  }
}

/** A request waiting to be batched into the one notice the window sends. */
export interface PendingRequest { kind: 'approval' | 'input'; sessionId: string; title: string; requestId?: string; at: number }

/** Approvals and questions inside this window coalesce into one notification. */
export const COALESCE_MS = 5000;

/** One notice for a whole batch; finished and failed tasks never reach it (they notify at once). */
export function batchNotice(batch: PendingRequest[], hideDetails: boolean): Notice {
  const first = batch[0];
  if (!first) return { title: '', body: '' };
  const same = batch.every(item => item.sessionId === first.sessionId);
  // The privacy toggle hides the task's name from the shown text, not from the click payload,
  // so a notice for one task still opens that task; a batch across tasks has none to open.
  const withTask = (text: { title: string; body: string }): Notice => same ? { ...text, sessionId: first.sessionId } : text;
  if (batch.length === 1) return withTask(notice(first.kind, first.title, hideDetails));
  if (hideDetails) return withTask({ title: 'PandaCode needs you', body: `${batch.length} requests waiting` });
  if (!same) return { title: 'Tasks need your attention', body: `${batch.length} requests waiting` };
  const label = batch.every(item => item.kind === 'approval') ? 'approvals'
    : batch.every(item => item.kind === 'input') ? 'answers' : 'requests';
  return withTask({ title: `${first.title} needs you`, body: `${batch.length} ${label} waiting` });
}

export interface CoalescerHost {
  now(): number;
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  flush(batch: PendingRequest[]): void;
}

export interface Coalescer {
  add(kind: 'approval' | 'input', sessionId: string, title: string, requestId?: string): void;
  /** Takes a cancelled request back out, so the batch never counts what no longer waits. */
  cancel(kind: 'approval' | 'input', sessionId: string, requestId?: string): void;
  /** Sends what is pending at once (nothing arrives later for a closed task). */
  flushNow(): void;
}

/** Collects requests for the first one's window, then flushes them as one batch. */
export function createCoalescer(host: CoalescerHost, windowMs = COALESCE_MS): Coalescer {
  let batch: PendingRequest[] = [], handle: unknown;
  const run = () => {
    handle = undefined;
    if (!batch.length) return;
    const due = batch;
    batch = [];
    host.flush(due);
  };
  return {
    add(kind, sessionId, title, requestId) {
      batch.push({ kind, sessionId, title, requestId, at: host.now() });
      if (handle === undefined) handle = host.schedule(run, windowMs);
    },
    cancel(kind, sessionId, requestId) {
      batch = batch.filter(item => !(item.kind === kind && item.sessionId === sessionId
        && (item.requestId ?? null) === (requestId ?? null)));
    },
    flushNow() {
      if (handle !== undefined) host.cancel(handle);
      run();
    },
  };
}
