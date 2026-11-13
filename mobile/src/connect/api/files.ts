// Host calls for the `files` feature group (src-tauri/src/remote/methods/files.rs): the computer's
// projects, a browser over a project's or a task's checkout, and saving one text file (files.write, Full). See docs/remote-access.md,
// "Adding a method".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { assembleData, type DataPage, type FilePage, type GrepFile } from '../../store/files.ts';

export const FILES_METHODS = registerMethods(['projects.list', 'files.list', 'files.read', 'files.image', 'files.search', 'files.grep', 'files.write'] as const);

/** Where a call reads: a task's own checkout wins over the project's main one. */
export interface FileTarget { projectId?: string; sessionId?: string }

export interface HostProject { id: string; name: string; path: string; repo: string | null; chat: boolean; addedOrder: number }
export interface FileEntry { name: string; path: string; dir: boolean }
export interface FolderListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface GrepResult { files: GrepFile[]; truncated: boolean }
export interface WriteResult { path: string; hash: string; total: number }
export interface GrepOptions { matchCase?: boolean; wholeWord?: boolean; regex?: boolean }

/** A text search walks the whole checkout (the host stops it at 5 s). */
const SEARCH_TIMEOUT_MS = 20_000;

const target = (t: FileTarget) => (t.sessionId ? { sessionId: t.sessionId } : { projectId: t.projectId });

export const listProjects = (deviceId: string) => hostCall<{ projects: HostProject[] }>(deviceId, 'projects.list').then(r => r.projects ?? []);

export const listFiles = (deviceId: string, t: FileTarget, path: string) =>
  hostCall<FolderListing>(deviceId, 'files.list', { ...target(t), ...(path ? { path } : {}) });

export const readFile = (deviceId: string, t: FileTarget, path: string, offset = 0) =>
  hostCall<FilePage>(deviceId, 'files.read', { ...target(t), path, offset });

/** A workspace image as a `data:` URL, fetched in pages. */
export const readImage = (deviceId: string, t: FileTarget, path: string) =>
  assembleData(offset => hostCall<DataPage>(deviceId, 'files.image', { ...target(t), path, offset }, { background: true }));

export const searchFiles = (deviceId: string, t: FileTarget, query: string) =>
  hostCall<{ entries: FileEntry[] }>(deviceId, 'files.search', { ...target(t), query }).then(r => r.entries ?? []);

export const grepFiles = (deviceId: string, t: FileTarget, query: string, options: GrepOptions = {}) =>
  hostCall<GrepResult>(deviceId, 'files.grep', { ...target(t), query, ...options }, { timeoutMs: SEARCH_TIMEOUT_MS });

/** Saves `text` over the file when it is still at `baseHash` (from files.read); a stale base
 * rejects with an error `isWriteConflict` recognises. */
export const writeFile = (deviceId: string, t: FileTarget, path: string, text: string, baseHash: string) =>
  hostCall<WriteResult>(deviceId, 'files.write', { ...target(t), path, text, baseHash });
