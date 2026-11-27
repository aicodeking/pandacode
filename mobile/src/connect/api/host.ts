// Host calls for the built-in `host.*` methods about the computer's own app: the version it runs and
// the update it can install (src-tauri/src/remote/methods/host_methods.rs). host.updateStatus is View;
// host.checkUpdate and host.updateAndRestart are Full and also wait on the computer's "Full access for
// remote tasks" switch, because installing restarts it and stops whatever runs there.
//
// The computer replies to host.updateAndRestart before it restarts. Its socket then drops, presence
// lists it offline, and client.ts fails this phone's calls to it at once (LOST, as for any closed
// socket) instead of hanging; when it is back, presence asks it host.hello again and the card reads
// the version it restarted into.
import type { HostCallOptions } from '../client.ts';
import { registerMethods, type Method } from '../rpc.ts';
import { normalizeStatus, type HostUpdateStatus } from '../../store/host-update.ts';

// client.ts loads on first call (as in admin.ts), so the Node tests can import this file and the
// store's pure helpers without React Native.
const hostCall = async <T>(deviceId: string, method: Method, params: unknown, options?: HostCallOptions): Promise<T> =>
  (await import('../client.ts')).hostCall<T>(deviceId, method, params, options);

export const HOST_METHODS = registerMethods(['host.updateStatus', 'host.checkUpdate', 'host.updateAndRestart'] as const);

/** Checking asks the release feed, which can take a few seconds on a slow link. */
const CHECK_TIMEOUT_MS = 30_000;

/** The computer's version and update state, as last checked (no network round trip to a release feed). */
export const hostUpdateStatus = (deviceId: string): Promise<HostUpdateStatus> =>
  hostCall<unknown>(deviceId, 'host.updateStatus', {}).then(normalizeStatus);

/** Asks the computer to look for a release now and answers the same shape. */
export const checkHostUpdate = (deviceId: string): Promise<HostUpdateStatus> =>
  hostCall<unknown>(deviceId, 'host.checkUpdate', {}, { timeoutMs: CHECK_TIMEOUT_MS }).then(normalizeStatus);

/** Installs the waiting release on the computer and restarts it; the reply comes before it does. */
export const installHostUpdate = (deviceId: string): Promise<{ restarting?: unknown }> =>
  hostCall<{ restarting?: unknown }>(deviceId, 'host.updateAndRestart', {});
