// This computer's PandaCode version and its update state, as `host.updateStatus` and
// `host.checkUpdate` answer it (src-tauri/src/remote/methods/host_methods.rs), plus the lines and decisions
// the hub's Version card shares. No React, no network: tests/host-update.test.ts.
//
// The shape both calls answer:
//   { currentVersion, update: null | { version }, installable, restarting, error }
// `installable` is whether the computer can install the release itself (a downloaded, signed one);
// `restarting` is true from the moment it starts installing until it is back, which is when this
// phone's socket to it drops.

/** A release the computer found. */
export interface HostUpdate { version: string }

export interface HostUpdateStatus {
  /** The version that computer runs, or '' when it did not say. */
  currentVersion: string;
  /** The release waiting, or null when it is up to date (or has not looked yet). */
  update: HostUpdate | null;
  installable: boolean;
  restarting: boolean;
  error: string | null;
}

const MAX_VERSION = 64;
const MAX_ERROR = 500;

/** A version as every card shows it: trimmed, without a leading `v`, bounded. */
const versionOf = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/^v/i, '').slice(0, MAX_VERSION) : '');

const updateOf = (value: unknown): HostUpdate | null => {
  if (!value || typeof value !== 'object') return null;
  const version = versionOf((value as { version?: unknown }).version);
  return version ? { version } : null;
};

/** Decodes a status reply. Anything missing or malformed reads as unknown/false, so a card of
 * half a reply (an older host, a truncated one) still draws instead of throwing. */
export function normalizeStatus(raw: unknown): HostUpdateStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const error = typeof r.error === 'string' && r.error.trim() ? r.error.trim().slice(0, MAX_ERROR) : null;
  return { currentVersion: versionOf(r.currentVersion), update: updateOf(r.update), installable: r.installable === true, restarting: r.restarting === true, error };
}

export const CHECKING = 'Checking…';
export const RESTARTING = 'Restarting to update…';
const UP_TO_DATE = 'Up to date';

/**
 * The card's state line: null while the first read runs, then the truth in order of what matters —
 * a restart under way, the computer's error, the release waiting, or the version it is on.
 */
export function updateLine(status: HostUpdateStatus | null): string {
  if (!status) return CHECKING;
  if (status.restarting) return RESTARTING;
  if (status.error) return status.error;
  if (status.update) return `Update to ${status.update.version} available`;
  return status.currentVersion ? `${UP_TO_DATE} (${status.currentVersion})` : UP_TO_DATE;
}

/** The line's tone on the version row: a restart is news, a failure is bad, an update is worth a tap. */
export const updateTone = (status: HostUpdateStatus | null): 'warning' | 'danger' | 'info' | undefined => {
  if (!status) return undefined;
  if (status.restarting) return 'warning';
  if (status.error) return 'danger';
  return status.update ? 'info' : undefined;
};

/** Whether a release the computer can install is waiting (also true while it restarts, when the
 * button stays on screen disabled). */
export const updateReady = (status: HostUpdateStatus | null): boolean => !!status && status.installable && !!status.update;

/** Whether a restart is in flight: the buttons stay off until the card reads the version it restarted into. */
export const restartInFlight = (status: HostUpdateStatus | null): boolean => status?.restarting === true;

/** Whether the card offers Update and restart now: a release to install, and no restart running. */
export const canInstall = (status: HostUpdateStatus | null): boolean => updateReady(status) && !restartInFlight(status);

/** The status right after asking: restarting at once, so the card is calm while the computer
 * drops off and the reply (if any) is no longer what matters. */
export const markRestarting = (status: HostUpdateStatus | null): HostUpdateStatus => ({
  currentVersion: status?.currentVersion ?? '', update: status?.update ?? null, installable: status?.installable ?? false, restarting: true, error: null,
});

/** The confirm's body: what Update and restart does there, and here, in full. */
export const restartWarning = (computer: string): string =>
  `PandaCode restarts on ${computer} to install the update. This phone disconnects until it is back, and agents running there stop until they are resumed.`;

/** The computers that just went offline: online in `before`, and off the list (or offline) in
 * `after`. client.ts fails those hosts' waiting calls at once — the reason this matters here is that
 * Update and restart drops the computer's socket, and a call already on its way is never answered,
 * so without this it would wait out its timeout instead of failing. Pure; tests/host-update.test.ts. */
export function wentOffline(before: ReadonlySet<string>, after: readonly { id: string; online: boolean }[]): string[] {
  const online = new Set(after.filter(d => d.online).map(d => d.id));
  return [...before].filter(id => !online.has(id));
}

/** The version a host announced it is restarting into, and when it said so (the `host.restarting`
 * frame, client.ts). A hint, not a fact: `host.updateStatus`'s own `restarting` is the authority —
 * host_methods.rs `tell_viewers` says the socket close is the real signal and this "only lets a
 * client say why". */
export interface RestartHint { readonly version: string; readonly at: number }

/** How long an announcement is believed. The host sends it BEFORE it installs, so a failed install
 * leaves it online and it never restarts; believing the hint forever would hide that failure's error
 * behind "Restarting…". Past this the card falls back to the plain line, which is honest. */
export const RESTART_HINT_MS = 5 * 60_000;

/** Whether `hint` still describes a restart that is plausibly under way. */
export const restartAnnounced = (hint: RestartHint | undefined, now: number): boolean =>
  !!hint && now - hint.at >= 0 && now - hint.at < RESTART_HINT_MS;
