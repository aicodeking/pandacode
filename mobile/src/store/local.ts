// This phone's own inbox state: snoozes, phone-only pins, archived threads and the outbox. Kept in SecureStore
// (the app's only persistent store), separate from the Connect state client.ts owns.
import { Directory, Paths } from 'expo-file-system';
import { useEffect } from 'react';
import { Alert } from 'react-native';
import { create } from 'zustand';
import { connect } from '../connect/client.ts';
import { uuid } from '../connect/crypto.ts';
import { useShallow } from 'zustand/react/shallow';
import { get, remove, set } from '../connect/secrets.ts';
import { withoutArchived } from './thread-model.ts';
import { withDeleted } from './gone.ts';
import { steerKey } from './draft.ts';
import { storedImages, type SendImage } from './attach.ts';
import { activeSnoozes } from './inbox.ts';
import { useConnect } from './index.ts';
import { applyFlush, flush, isUnsent, parseOutbox, type OutboxEntry } from './outbox.ts';

const KEY = 'inbox.local';
const OUTBOX_KEY = 'inbox.outbox';

interface LocalState {
  loaded: boolean;
  snoozed: Record<string, number>;
  pins: Record<string, boolean>;
  /** Threads archived from this phone (taskKey → when): hidden from the lists until a newer prompt. */
  archived: Record<string, number>;
  outbox: OutboxEntry[];
  /** Prompts this phone steered (steerKey → when), to label their bubbles. Memory only:
   * stored messages don't mark steers. */
  steers: Record<string, number>;
  /** Threads deleted from this phone, or reported missing by their host's subscribe reply (deleted on
   * the desktop) (taskKey → true), so an open one closes (store/gone.ts). Memory only:
   * a deleted thread never lists again. */
  deleted: Readonly<Record<string, true>>;
}

const empty = (): LocalState => ({ loaded: false, snoozed: {}, pins: {}, archived: {}, outbox: [], steers: {}, deleted: {} });
export const useLocal = create<LocalState>(empty);

/** Demo mode's seeded snoozes and outbox are never saved or sent. */
const demo = () => useConnect.getState().demo;

const save = () => {
  if (demo()) return;
  const { snoozed, pins, archived, outbox } = useLocal.getState();
  set(KEY, JSON.stringify({ snoozed, pins, archived })).catch(() => undefined);
  set(OUTBOX_KEY, JSON.stringify(outbox)).catch(() => undefined);
};
const patch = (update: (s: LocalState) => Partial<LocalState>) => { useLocal.setState(update); save(); };

/** Only finite timestamps survive a stored record. */
const numbers = (v: object): Record<string, number> => Object.fromEntries(Object.entries(v).filter(([, at]) => Number.isFinite(at)));

export async function loadLocal() {
  const [raw, outbox] = await Promise.all([get(KEY), get(OUTBOX_KEY)]);
  if (demo()) return; // demo mode started while reading
  let stored: Partial<LocalState> = {};
  try { stored = JSON.parse(raw ?? '{}') ?? {}; } catch { /* unreadable: start empty */ }
  const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  useLocal.setState(s => ({
    loaded: true,
    snoozed: { ...activeSnoozes(record(stored.snoozed) as Record<string, number>, Date.now()), ...s.snoozed },
    pins: { ...(record(stored.pins) as Record<string, boolean>), ...s.pins },
    archived: { ...numbers(record(stored.archived)), ...s.archived },
    outbox: [...parseOutbox(outbox), ...s.outbox],
  }));
}

export const snooze = (key: string, until: number) => patch(s => ({ snoozed: { ...activeSnoozes(s.snoozed, Date.now()), [key]: until } }));
export const unsnooze = (key: string) => patch(s => ({ snoozed: Object.fromEntries(Object.entries(s.snoozed).filter(([k]) => k !== key)) }));
export const togglePin = (key: string) => patch(s => {
  const { [key]: on, ...rest } = s.pins;
  return { pins: on ? rest : { ...rest, [key]: true } };
});
/** Sets this phone's own pin (a host too old for thread.pin); `on` follows the synced pin. */
export const setPin = (key: string, on: boolean) => patch(s => {
  const { [key]: _was, ...rest } = s.pins;
  return { pins: on ? { ...rest, [key]: true } : rest };
});
/** Hides an archived thread from the lists until it gets a newer prompt; `unarchive` shows it again. */
export const archive = (key: string, at: number) => patch(s => ({ archived: { ...s.archived, [key]: at } }));
export const unarchive = (key: string) => patch(s => {
  const { [key]: _was, ...rest } = s.archived;
  return { archived: rest };
});

/** Records deleted threads (keys from taskKey), from this phone or the desktop: their open screens close. */
export const markDeleted = (keys: readonly string[]) => useLocal.setState(s => {
  const deleted = withDeleted(s.deleted, keys);
  return deleted === s.deleted ? {} : { deleted };
});

/** The host lists settled threads too, so every list (and each archive) drops the ones archived here. */
function hideArchived() {
  const { archived } = useLocal.getState();
  if (!Object.keys(archived).length) return;
  const { tasks } = useConnect.getState();
  const next = withoutArchived(tasks, archived);
  if (next !== tasks) useConnect.setState({ tasks: next });
}
useConnect.subscribe((s, before) => { if (s.tasks !== before.tasks) hideArchived(); });
useLocal.subscribe((s, before) => { if (s.archived !== before.archived) hideArchived(); });

/** `at`: taken before the steer went out, so the host's copy is created after it. */
export const markSteered = (taskKey: string, text: string, at: number) => useLocal.setState(s => ({ steers: { ...s.steers, [steerKey(taskKey, text)]: at } }));
export const removeOutbox = (id: string) => patch(s => ({ outbox: s.outbox.filter(e => e.id !== id) }));

/** Sends a message, then copies it back: the host saves a sent prompt before it answers, but
 * otherwise the phone copies messages only at the run's end. A queued one isn't saved yet. */
async function deliver(deviceId: string, sessionId: string, text: string, sendId?: string, images?: readonly SendImage[]): Promise<{ queued: boolean }> {
  const result = await connect.sendMessage(deviceId, sessionId, text, sendId, images);
  if (!result.queued) void connect.loadMessages(deviceId, sessionId).catch(() => undefined);
  return result;
}

/** Sends a message (with `images`, uploaded first); if the computer can't be reached it waits in
 * the outbox instead, keeping each image's file uri to upload again when it sends. */
export async function sendOrQueue(deviceId: string, sessionId: string, text: string, images: readonly SendImage[] = []): Promise<{ queued: boolean; outbox: boolean }> {
  // Earlier unsent messages for this task go first, so this one waits behind them.
  if (useLocal.getState().outbox.some(e => e.deviceId === deviceId && e.sessionId === sessionId)) {
    enqueue(deviceId, sessionId, text, images);
    return { queued: false, outbox: true };
  }
  try {
    return { ...(await deliver(deviceId, sessionId, text, undefined, images)), outbox: false };
  } catch (error) {
    if (!isUnsent(error)) throw error;
    enqueue(deviceId, sessionId, text, images);
    return { queued: false, outbox: true };
  }
}

function enqueue(deviceId: string, sessionId: string, text: string, images: readonly SendImage[]) {
  const entry: OutboxEntry = { id: uuid(), deviceId, sessionId, text, createdAt: Date.now(), ...(images.length && { images: storedImages(images) }) };
  patch(s => ({ outbox: [...s.outbox, entry] }));
}

/** An unconfirmed send the host never stored goes back to the outbox under its own `sendId`
 * (client.ts's decideUnconfirmed, only for hosts that dedupe by it): a copy that did run
 * answers from memory, so this never sends it twice. */
connect.onRequeue(({ id, deviceId, sessionId, text, images }) => {
  if (demo() || useLocal.getState().outbox.some(e => e.id === id)) return;
  const entry: OutboxEntry = { id, deviceId, sessionId, text, createdAt: Date.now(), ...(images.length && { images: storedImages(images) }) };
  patch(s => ({ outbox: [...s.outbox, entry] }));
  void flushOutbox();
});

/** "Send again" on a "Not delivered" bubble; says why when it fails (the bubble is gone then). */
export function sendAgain(deviceId: string, sessionId: string, id: string) {
  connect.sendAgain(deviceId, sessionId, id).catch((error: unknown) => {
    Alert.alert('Not sent', error instanceof Error ? error.message : 'Could not send this message.');
  });
}

/** "Discard" on a "Not delivered" bubble. */
export const discardSent = (deviceId: string, sessionId: string, id: string) => connect.discardSent(deviceId, sessionId, id);

/** Task exports the share sheet left behind (TaskHeader deletes each after sharing; best-effort). */
function clearExports(): void {
  try {
    const dir = new Directory(Paths.cache, 'exports');
    if (dir.exists) dir.delete();
  } catch { /* nothing to delete */ }
}

/** Sign-out and account deletion: snoozes, pins, archived threads and the outbox, in memory and stored,
 * and any task export left in cache/exports. */
export async function clearLocal(): Promise<void> {
  useLocal.setState({ ...empty(), loaded: true });
  clearExports();
  await Promise.all([remove(KEY), remove(OUTBOX_KEY)]);
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || demo()) return;
  flushing = true;
  try {
    const { connected, devices } = useConnect.getState();
    const entries = useLocal.getState().outbox;
    if (!connected || !entries.length) return;
    const result = await flush(entries, {
      online: id => !!devices.find(d => d.id === id)?.online,
      send: entry => deliver(entry.deviceId, entry.sessionId, entry.text, entry.id, entry.images),
      idempotent: connect.dedupesSends,
    });
    if (result.sent.length || Object.keys(result.failed).length) {
      patch(s => ({ outbox: applyFlush(s.outbox, result) }));
      for (const key of new Set(entries.filter(e => result.sent.includes(e.id)).map(e => `${e.deviceId}\n${e.sessionId}`))) {
        const [deviceId, sessionId] = key.split('\n');
        void connect.loadMessages(deviceId, sessionId).catch(() => undefined);
      }
    }
  } finally {
    flushing = false;
  }
}

/** Clears an entry's error and tries the outbox again; says so when the computer can't be reached,
 * since a flush then sends nothing and shows nothing. */
export function retryOutbox(id: string) {
  const entry = useLocal.getState().outbox.find(e => e.id === id);
  patch(s => ({ outbox: s.outbox.map(e => (e.id === id ? { ...e, error: undefined } : e)) }));
  const { connected, devices } = useConnect.getState();
  const device = devices.find(d => d.id === entry?.deviceId);
  if (entry && (!connected || !device?.online)) Alert.alert('Still offline', `${device?.name ?? 'The computer'} can't be reached right now. This message sends when it's back.`);
  void flushOutbox();
}

/** Loads local state (again after leaving demo mode), then flushes whenever the relay reconnects or a computer comes online. */
export function useOutboxFlusher() {
  const loaded = useLocal(s => s.loaded);
  const { ready, demoOn } = useConnect(useShallow(s => ({ ready: s.ready, demoOn: s.demo })));
  const signal = useConnect(s => (s.connected ? s.devices.filter(d => d.online).map(d => d.id).sort().join(',') : ''));
  useEffect(() => {
    if (!ready || demoOn) return;
    useLocal.setState(empty());
    void loadLocal();
  }, [ready, demoOn]);
  useEffect(() => { if (loaded && signal) void flushOutbox(); }, [loaded, signal]);
}
