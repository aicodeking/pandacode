// Host calls for the `settings` feature group (src-tauri/src/remote/methods/settings.rs): the
// computer's harnesses and their readiness, the model routing switch, the token saver's tools, a
// checkout's jj status and the project's moodboards. No keys, tokens or environment values ever
// arrive here; installing or updating harnesses and editing keys stay on the computer. See
// docs/remote-access.md, "Registry methods".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { hostCallBackgroundOnce } from './composer.ts';
import { assembleData, type DataPage } from '../../store/files.ts';
import type { FileTarget } from './files.ts';

export const SETTINGS_METHODS = registerMethods(['settings.providers', 'settings.routing', 'settings.setRouting', 'settings.tokenSaver', 'settings.jj',
  'moodboards.list', 'moodboards.image', 'moodboards.add'] as const);

/** The provider check may run `claude auth status` and read the cached update check. */
const PROVIDERS_TIMEOUT_MS = 30_000;

export type Readiness = 'ready' | 'installed' | 'needsKey' | 'signedOut' | 'missing';
export interface HarnessUpdate { status: 'current' | 'available' | 'unsupported' | 'error'; latest: string | null; canUpdate: boolean }
export interface Harness {
  id: string;
  name: string;
  installed: boolean;
  /** The executable's file name only. */
  executable: string | null;
  version: string;
  models: number;
  status: Readiness;
  update: HarnessUpdate | null;
}
export interface RoutingState { on: boolean; mode: string; profiler: 'ready' | 'missing' | 'downloading' | 'failed' | 'unavailable' | string; failed: boolean }
export interface TokenSaverTools { rtk: boolean; rtkVersion: string }
export interface JjStatus { isRepo: boolean; colocated: boolean; change: { changeId: string; description: string; bookmarks: string[]; conflict: boolean; empty: boolean } | null; files: { status: string; path: string }[]; truncated: boolean }
export interface MoodboardImage { id: string; name: string; caption: string; width: number; height: number; createdAt: number }
export interface Moodboard { id: string; projectId: string; name: string; imageCount: number; updatedAt: number; images: MoodboardImage[] }

const target = (t: FileTarget) => (t.sessionId ? { sessionId: t.sessionId } : { projectId: t.projectId });

export const settingsProviders = (deviceId: string) =>
  hostCall<{ providers: Harness[] }>(deviceId, 'settings.providers', {}, { timeoutMs: PROVIDERS_TIMEOUT_MS }).then(r => r.providers ?? []);
export const settingsRouting = (deviceId: string) => hostCall<RoutingState>(deviceId, 'settings.routing');
export const setRouting = (deviceId: string, on: boolean) => hostCall<RoutingState>(deviceId, 'settings.setRouting', { on });
export const settingsTokenSaver = (deviceId: string) => hostCall<TokenSaverTools>(deviceId, 'settings.tokenSaver');
export const settingsJj = (deviceId: string, t: FileTarget) => hostCall<JjStatus>(deviceId, 'settings.jj', target(t));

export const moodboardsList = (deviceId: string, t: FileTarget) =>
  hostCall<{ boards: Moodboard[]; truncated: boolean }>(deviceId, 'moodboards.list', target(t));
export const moodboardImage = (deviceId: string, t: FileTarget, boardId: string, imageId: string, full: boolean) =>
  assembleData(offset => hostCall<DataPage>(deviceId, 'moodboards.image', { ...target(t), boardId, imageId, full, offset }, { background: !full }));

/** Adds an image already uploaded with image.put (`imageId`) to `board` (Full, and the Full access switch).
 * Once per add: a retry after a lost reply gets the first answer, not "image missing" (the add spent the upload). */
export const addMoodboardImage = (deviceId: string, projectId: string, board: string, imageId: string, name?: string) =>
  hostCallBackgroundOnce<{ image?: MoodboardImage }>(deviceId, 'moodboards.add', { projectId, board, imageId, ...(name ? { name } : {}) });
