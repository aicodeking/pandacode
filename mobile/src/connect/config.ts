// Build config (docs/remote-access.md, Accounts). Values come from app.config.ts `extra`
// (read when Metro starts or the app is built), or EXPO_PUBLIC_* inlined into the bundle.
import Constants from 'expo-constants';

export interface Build { relay: string; clientId: string }

const extra = (Constants.expoConfig?.extra ?? {}) as { relayUrl?: string; githubClientId?: string };
const relay = (process.env.EXPO_PUBLIC_PANDACODE_RELAY_URL || extra.relayUrl || '').trim().replace(/\/+$/, '');
const clientId = (process.env.EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID || extra.githubClientId || '').trim();

/** Why Connect is off in this build, or '' when it is configured. */
export const configProblem =
  !relay ? 'No relay URL was set (PANDACODE_RELAY_URL).'
  : !/^https:\/\/[^/\s]+$/.test(relay) ? `The relay URL must be https://host with no path (got ${relay}).`
  : !clientId ? 'No GitHub client ID was set (PANDACODE_GITHUB_CLIENT_ID).'
  : '';

export const build: Build | null = configProblem ? null : { relay, clientId };
export const NOT_CONFIGURED = 'PandaCode Connect is not configured in this build.';
