// This phone's own inbox state: snoozes, phone-only pins and the outbox. Kept in SecureStore
// (the app's only persistent store), separate from the Connect state client.ts owns.
import { useEffect } from 'react';
import { create } from 'zustand';
import { connect } from '../connect/client.ts';
import { uuid } from '../connect/crypto.ts';
import { useShallow } from 'zustand/react/shallow';
import { get, remove, set } from '../connect/secrets.ts';
import { activeSnoozes, type OutboxEntry } from './inbox.ts';
import { useConnect } from './index.ts';
import { applyFlush, flush, isUnsent, parseOutbox } from './outbox.ts';

const KEY = 'inbox.local';
const OUTBOX_KEY = 'inbox.outbox';

interface LocalState {
  loaded: boolean;
  snoozed: Record<string, number>;
  pins: Record<string, boolean>;
  outbox: OutboxEntry[];
  /** Prompts this phone steered (trimmed text → when), to label their bubbles. Memory only:
   * stored messages don't mark steers. */
  steers: Record<string, number>;
}

const empty = (): LocalState => ({ loaded: false, snoozed: {}, pins: {}, outbox: [], steers: {} });
export const useLocal = create<LocalState>(empty);

/** Demo mode's seeded snoozes and outbox are never saved or sent. */
const demo = () => useConnect.getState().demo;

const save = () => {
  if (demo()) return;
  const { snoozed, pins, outbox } = useLocal.getState();
  set(KEY, JSON.stringify({ snoozed, pins })).catch(() => undefined);
  set(OUTBOX_KEY, JSON.stringify(outbox)).catch(() => undefined);
};
const patch = (update: (s: LocalState) => Partial<LocalState>) => { useLocal.setState(update); save(); };

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
    outbox: [...parseOutbox(outbox), ...s.outbox],
  }));
}

export const snooze = (key: string, until: number) => patch(s => ({ snoozed: { ...activeSnoozes(s.snoozed, Date.now()), [key]: until } }));
export const unsnooze = (key: string) => patch(s => ({ snoozed: Object.fromEntries(Object.entries(s.snoozed).filter(([k]) => k !== key)) }));
export const togglePin = (key: string) => patch(s => {
  const { [key]: on, ...rest } = s.pins;
  return { pins: on ? rest : { ...rest, [key]: true } };
});
export const markSteered = (text: string) => useLocal.setState(s => ({ steers: { ...s.steers, [text.trim()]: Date.now() } }));
export const removeOutbox = (id: string) => patch(s => ({ outbox: s.outbox.filter(e => e.id !== id) }));

/** Sends a message, then copies it back: the host saves a sent prompt before it answers, but
 * otherwise the phone copies messages only at the run's end. A queued one isn't saved yet. */
async function deliver(deviceId: string, sessionId: string, text: string): Promise<{ queued: boolean }> {
  const result = await connect.sendMessage(deviceId, sessionId, text);
  if (!result.queued) void connect.loadMessages(deviceId, sessionId).catch(() => undefined);
  return result;
}

/** Sends a message; if the computer can't be reached it waits in the outbox instead. */
export async function sendOrQueue(deviceId: string, sessionId: string, text: string): Promise<{ queued: boolean; outbox: boolean }> {
  // Earlier unsent messages for this task go first, so this one waits behind them.
  if (useLocal.getState().outbox.some(e => e.deviceId === deviceId && e.sessionId === sessionId)) {
    enqueue(deviceId, sessionId, text);
    return { queued: false, outbox: true };
  }
  try {
    return { ...(await deliver(deviceId, sessionId, text)), outbox: false };
  } catch (error) {
    if (!isUnsent(error)) throw error;
    enqueue(deviceId, sessionId, text);
    return { queued: false, outbox: true };
  }
}

function enqueue(deviceId: string, sessionId: string, text: string) {
  patch(s => ({ outbox: [...s.outbox, { id: uuid(), deviceId, sessionId, text, createdAt: Date.now() }] }));
}

/** Account deletion: snoozes, pins and the outbox, in memory and stored. */
export async function clearLocal(): Promise<void> {
  useLocal.setState({ ...empty(), loaded: true });
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
      send: entry => deliver(entry.deviceId, entry.sessionId, entry.text),
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

/** Clears an entry's error and tries the outbox again. */
export function retryOutbox(id: string) {
  patch(s => ({ outbox: s.outbox.map(e => (e.id === id ? { ...e, error: undefined } : e)) }));
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
