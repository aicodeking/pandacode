// App state for the UI. Only src/connect/client.ts writes it; screens read it with the hooks below.
import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { build } from '../connect/config.ts';
import type { Account, Bot, Device, Message, Provider, ProviderModel, PullDetail, TasksList } from '../connect/types.ts';
import { idleLive, type Live } from './reduce.ts';
import { unmatched, type Sent } from './sent.ts';
import type { Team } from './team.ts';

export type { Live, LiveItem } from './reduce.ts';

/** `${deviceId}/${sessionId}` */
export const taskKey = (deviceId: string, sessionId: string) => `${deviceId}/${sessionId}`;

export interface ConnectState {
  configured: boolean;
  /** Secrets have been read; until then signedIn is unknown. */
  ready: boolean;
  signedIn: boolean;
  connected: boolean;
  account: Account | null;
  deviceId: string;
  devices: Device[];
  /** tasks.list per host. `cachedAt`: restored from the inbox cache (src/store/inbox-cache.ts), not yet listed live. */
  tasks: Record<string, TasksList & { loadedAt: number; cachedAt?: number }>;
  /** Messages per taskKey, oldest first: the newest window (tail page or disk cache), grown by afterId and beforeId pages. Absent until first loaded. */
  messages: Record<string, Message[]>;
  /** Per taskKey: the host has messages before the first one held ('more'), or they are loading. */
  older: Record<string, 'more' | 'loading'>;
  /** A message copy in flight (null) or the error of the last one, per taskKey; absent once copied. */
  history: Record<string, string | null>;
  /** Prompts sent from this phone per taskKey, until their stored copy arrives (src/store/sent.ts). */
  sent: Record<string, Sent[]>;
  /** Live run per taskKey. */
  live: Record<string, Live>;
  providers: Record<string, Provider[]>;
  models: Record<string, ProviderModel[]>;
  /** bots.list per host ([] for a host too old to have bots). */
  bots: Record<string, Bot[]>;
  /** The linked pull request per taskKey once checked (null: none). */
  pulls: Record<string, PullDetail | null>;
  /** An architect task's team per taskKey once asked (null: none; 'outdated': the host lacks task.team). */
  teams: Record<string, Team | null | 'outdated'>;
  /** Hosts that answered 'Unknown method.' to the pull request, changes or bot methods. */
  outdated: Record<string, boolean>;
  /** The last user-facing connection error (sign-out, relay). */
  error: string | null;
  /** Demo mode (src/demo.ts): fake data, no network. */
  demo: boolean;
}

export const initialState = (): ConnectState => ({
  configured: !!build, ready: false, signedIn: false, connected: false, account: null, deviceId: '',
  devices: [], tasks: {}, messages: {}, older: {}, history: {}, sent: {}, live: {}, providers: {}, models: {}, bots: {}, pulls: {}, teams: {}, outdated: {}, error: null, demo: false,
});

export const useConnect = create<ConnectState>(() => initialState());

export interface DeviceRow extends Device { current: boolean }

function useRows(): DeviceRow[] {
  const { devices, deviceId } = useConnect(useShallow(s => ({ devices: s.devices, deviceId: s.deviceId })));
  return useMemo(() => devices.map(d => ({ ...d, current: d.id === deviceId })), [devices, deviceId]);
}

const EMPTY: never[] = [];

export const useStatus = () => useConnect(useShallow(s => ({ configured: s.configured, ready: s.ready, signedIn: s.signedIn, connected: s.connected, account: s.account, error: s.error, demo: s.demo })));
/** Every device signed in to the account. */
export const useDevices = useRows;
/** Other computers with remote access on: the ones the phone can open. */
export function useHosts(): DeviceRow[] {
  const all = useRows();
  return useMemo(() => all.filter(d => !d.current && d.host), [all]);
}
export const useTasks = (deviceId: string) => useConnect(s => s.tasks[deviceId]);
/** null while copying, the last copy's error, or undefined. */
export const useHistory = (deviceId: string, sessionId: string) => useConnect(s => s.history[taskKey(deviceId, sessionId)]);
/** The thread has been drawn from the cache or the host at least once (an empty one too). */
export const useLoaded = (deviceId: string, sessionId: string) => useConnect(s => taskKey(deviceId, sessionId) in s.messages);
export const useOlder = (deviceId: string, sessionId: string) => useConnect(s => s.older[taskKey(deviceId, sessionId)]);
export const useMessages = (deviceId: string, sessionId: string) => useConnect(s => s.messages[taskKey(deviceId, sessionId)] ?? EMPTY);
/** This phone's sent prompts the transcript doesn't hold yet. */
export const useSent = (deviceId: string, sessionId: string) => {
  const key = taskKey(deviceId, sessionId);
  const { sent, messages } = useConnect(useShallow(s => ({ sent: s.sent[key] ?? EMPTY, messages: s.messages[key] ?? EMPTY })));
  return useMemo(() => unmatched(sent, messages), [sent, messages]);
};
const IDLE = idleLive();
export const useLive = (deviceId: string, sessionId: string) => useConnect(s => s.live[taskKey(deviceId, sessionId)] ?? IDLE);
export const useProviders = (deviceId: string) => useConnect(s => s.providers[deviceId]);
export const useModels = (deviceId: string, provider: string) => useConnect(s => s.models[`${deviceId}/${provider}`]);
