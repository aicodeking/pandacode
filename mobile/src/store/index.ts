// App state for the UI. Only src/connect/client.ts writes it; screens read it with the hooks below.
import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { build } from '../connect/config.ts';
import type { Account, Device, Message, Provider, ProviderModel, TasksList } from '../connect/types.ts';
import { idleLive, type Live } from './reduce.ts';

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
  /** tasks.list per host. */
  tasks: Record<string, TasksList & { loadedAt: number }>;
  /** Messages per taskKey, oldest first, incremental by afterId. */
  messages: Record<string, Message[]>;
  /** A message copy in flight (null) or the error of the last one, per taskKey; absent once copied. */
  history: Record<string, string | null>;
  /** Live run per taskKey. */
  live: Record<string, Live>;
  providers: Record<string, Provider[]>;
  models: Record<string, ProviderModel[]>;
  /** The last user-facing connection error (sign-out, relay). */
  error: string | null;
}

export const initialState = (): ConnectState => ({
  configured: !!build, ready: false, signedIn: false, connected: false, account: null, deviceId: '',
  devices: [], tasks: {}, messages: {}, history: {}, live: {}, providers: {}, models: {}, error: null,
});

export const useConnect = create<ConnectState>(() => initialState());

export interface DeviceRow extends Device { current: boolean }

function useRows(): DeviceRow[] {
  const { devices, deviceId } = useConnect(useShallow(s => ({ devices: s.devices, deviceId: s.deviceId })));
  return useMemo(() => devices.map(d => ({ ...d, current: d.id === deviceId })), [devices, deviceId]);
}

const EMPTY: never[] = [];

export const useStatus = () => useConnect(useShallow(s => ({ configured: s.configured, ready: s.ready, signedIn: s.signedIn, connected: s.connected, account: s.account, error: s.error })));
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
export const useMessages = (deviceId: string, sessionId: string) => useConnect(s => s.messages[taskKey(deviceId, sessionId)] ?? EMPTY);
const IDLE = idleLive();
export const useLive = (deviceId: string, sessionId: string) => useConnect(s => s.live[taskKey(deviceId, sessionId)] ?? IDLE);
export const useProviders = (deviceId: string) => useConnect(s => s.providers[deviceId]);
export const useModels = (deviceId: string, provider: string) => useConnect(s => s.models[`${deviceId}/${provider}`]);
