// What each host serves, per device id: filled by client.ts's host.hello on every presence and
// connect, and by 'Unknown method.' answers. Kept apart from the main store so feature screens
// can read it without re-rendering on task traffic. Forgotten when the computer goes offline.
//
// Screens gate a feature with one of these (all true / null while the host is still unknown,
// so nothing flickers off before host.hello settles):
//   useHostAllows(deviceId, method): boolean   — the host serves it, this phone's grant there
//     (view/control/full) covers it, and, for terminal.*, runScript.start, checks.run and
//     files.write, the host's "Full access for remote tasks" switch is on. Hide or disable on false.
//   useHostBlock(deviceId, method): Blocked | null — why not: 'outdated' | 'access' | 'switch';
//     show blockedNote(reason, computerName, access) from hello.ts as the explanation.
//   useNeedsFullAccessSwitch(deviceId, method): boolean — only the switch is in the way
//     ("Turn on Full access for remote tasks on <computer> to use this.").
//   useHostAccess(deviceId): Access | undefined — this phone's grant ('view' | 'control' | 'full').
//   useHostSupports(deviceId, method): boolean — served at all (ignores grant and switch).
// Pure equivalents for tests and non-React code: allows, blockedBy, needsFullAccessSwitch,
// supports (hello.ts), over capabilitiesOf(deviceId).
//
// The socket may stay open for hours, so client.ts asks host.hello again when the app returns to the
// foreground and when a refusal shows the cached grant or switch is stale (`refusalMeansStale`).
import { create } from 'zustand';
import { blockedBy, legacy, supports, withMissing, type Access, type Blocked, type HostCapabilities } from './hello.ts';

export const useCapabilities = create<Record<string, HostCapabilities>>(() => ({}));

export const capabilitiesOf = (deviceId: string): HostCapabilities | undefined => useCapabilities.getState()[deviceId];

export function setCapabilities(deviceId: string, caps: HostCapabilities) {
  useCapabilities.setState({ [deviceId]: caps });
}

/** The host's refusals when its "Full access for remote tasks" switch is off (host.rs full_access_off,
 * and terminal.rs require_full_access_to / NEEDS_FULL_ACCESS), and its grant refusals (grants.rs). */
const SWITCH_OFF = /^Full access is off for remote tasks on |^Turn on Full access for remote tasks on this computer to /;
const GRANT_REFUSED = /^This device can only view tasks on |^This device is not allowed to do that on /;

/**
 * Whether a host's refusal of `method` contradicts what this phone has cached about it: the
 * cached host.hello said the call was allowed (served, granted, switch on), yet the host answered
 * with the Full access switch or a grant refusal. Then the grant or switch changed on the computer
 * while the socket stayed open, and host.hello should be asked again. Legacy or unknown hosts: false
 * (a legacy host's grant refusal is expected, and an unknown one is being asked anyway).
 */
export function refusalMeansStale(caps: HostCapabilities | undefined, method: string, message: string): boolean {
  if (caps?.kind !== 'hello' || blockedBy(caps, method) !== null) return false;
  return SWITCH_OFF.test(message) || GRANT_REFUSED.test(message);
}

/** A method the host refused as unknown: a host that never answered host.hello is legacy. */
export function markMissing(deviceId: string, method: string) {
  const caps = capabilitiesOf(deviceId) ?? legacy();
  setCapabilities(deviceId, withMissing(caps, method));
}

/** Forgets one host (it went offline: it may come back updated) or, without an id, all of them (sign-out, demo). */
export function forgetCapabilities(deviceId?: string) {
  if (deviceId === undefined) return useCapabilities.setState(() => ({}), true);
  if (!(deviceId in useCapabilities.getState())) return;
  const { [deviceId]: _gone, ...rest } = useCapabilities.getState();
  useCapabilities.setState(() => rest, true);
}

/** The host's capabilities, or undefined until host.hello settled. */
export const useHostCapabilities = (deviceId: string) => useCapabilities(s => s[deviceId]);

/**
 * Whether `device` serves `method`, for hiding a feature up front: false once the host is known
 * to lack it (show `outdated(computer)` from rpc.ts, "Update PandaCode on <computer> to use
 * this."), true when it serves it, and true while still unknown (the call itself then turns an
 * 'Unknown method.' into that note). Use `useHostCapabilities` to tell "unknown" apart.
 */
export const useHostSupports = (deviceId: string, method: string): boolean =>
  useCapabilities(s => supports(s[deviceId], method) ?? true);

/** Whether this phone may use `method` on `device` (served, granted, and not waiting on the
 * Full access switch); true while unknown. See the top of this file. */
export const useHostAllows = (deviceId: string, method: string): boolean =>
  useCapabilities(s => blockedBy(s[deviceId], method) === null);

/** Why this phone can't use `method` there, or null (also while unknown). */
export const useHostBlock = (deviceId: string, method: string): Blocked | null =>
  useCapabilities(s => blockedBy(s[deviceId], method));

/** Whether only the host's "Full access for remote tasks" switch keeps `method` off. */
export const useNeedsFullAccessSwitch = (deviceId: string, method: string): boolean =>
  useCapabilities(s => blockedBy(s[deviceId], method) === 'switch');

/** This phone's grant on `device`, once its host.hello said. */
export const useHostAccess = (deviceId: string): Access | undefined =>
  useCapabilities(s => { const caps = s[deviceId]; return caps?.kind === 'hello' ? caps.access : undefined; });
