// Downloads attachments and workspace images (task.attachment / task.workspaceImage) in chunks,
// one at a time for the whole app: each chunk waits for the thread's own message calls, and
// background prefetch holds while any download waits. Bytes go to the disk cache
// (src/store/attachment-files.ts) and come back as a file:// URI for expo-image.
import { acceptChunk, attachmentKey, workspaceId, type Progress, type Variant } from '../store/attachments.ts';
import { cachedBlob, finishBlob, loadBlobs, partial } from '../store/attachment-files.ts';
import { UNKNOWN_METHOD, type Method } from './rpc.ts';

/** Chunks per download at most (the host sends up to 120 KiB per chunk, 8 MiB per image). */
const MAX_CHUNKS = 400;

export interface AttachmentDeps {
  call: (deviceId: string, method: Method, params: object) => Promise<unknown>;
  /** Resolves when the thread's own message calls ahead of this chunk are done. */
  after: (deviceId: string, sessionId: string) => Promise<unknown>;
  hold: () => void;
  release: () => void;
  /** Demo mode: a bundled image for this id, if any. */
  demo: (id: string) => Promise<string | undefined> | undefined;
}

/** What the UI asks for: a message attachment by id, or a workspace image by path. */
export type Source = { id: string } | { path: string };

/** Hosts that answered 'Unknown method.' to a method this launch: shown as chips or links. */
const unsupported = new Set<string>();
const inflight = new Map<string, Promise<string>>();
let line: Promise<unknown> = Promise.resolve();
let waiting = 0;

const sourceId = (source: Source) => ('id' in source ? source.id : workspaceId(source.path));

/** A URI already on disk, without a call (first paint of a cached image). */
export function cachedAttachment(deviceId: string, sessionId: string, source: Source, variant: Variant): string | undefined {
  return cachedBlob(attachmentKey(deviceId, sessionId, sourceId(source), variant));
}

export const attachmentsUnsupported = (deviceId: string, source: Source) => unsupported.has(`${deviceId}:${'id' in source ? 'a' : 'w'}`);

/** The attachment's file:// URI, downloading it if needed. Concurrent asks share one download. */
export function fetchAttachment(deps: AttachmentDeps, deviceId: string, sessionId: string, source: Source, variant: Variant): Promise<string> {
  const id = sourceId(source);
  const key = attachmentKey(deviceId, sessionId, id, variant);
  const running = inflight.get(key);
  if (running) return running;
  const demo = deps.demo(id);
  const run = demo
    ? demo.then(uri => uri ?? Promise.reject(new Error('Not in the demo.')))
    // A cached file doesn't wait in line behind other downloads.
    : loadBlobs().then(() => cachedBlob(key) ?? enqueue(deps, () => download(deps, deviceId, sessionId, source, variant, key)));
  inflight.set(key, run);
  const done = () => inflight.delete(key);
  run.then(done, done);
  return run;
}

/** One download at a time; prefetch holds from the first queued download until the line is empty. */
function enqueue<T>(deps: AttachmentDeps, task: () => Promise<T>): Promise<T> {
  if (waiting++ === 0) deps.hold();
  const next = line.catch(() => undefined).then(task);
  line = next;
  const settle = () => { if (--waiting === 0) deps.release(); };
  next.then(settle, settle);
  return next;
}

async function download(deps: AttachmentDeps, deviceId: string, sessionId: string, source: Source, variant: Variant, key: string): Promise<string> {
  const kind = 'id' in source ? 'a' : 'w';
  if (unsupported.has(`${deviceId}:${kind}`)) throw new Error(UNKNOWN_METHOD);
  const method: Method = 'id' in source ? 'task.attachment' : 'task.workspaceImage';
  const file = partial(key);
  // Resume after a partial download: the type and total come back with the next chunk.
  let at: Progress = { offset: file.size };
  for (let n = 0; n < MAX_CHUNKS; n++) {
    await deps.after(deviceId, sessionId);
    let reply: unknown;
    try {
      reply = await deps.call(deviceId, method, { sessionId, ...source, variant, ...(at.offset ? { offset: at.offset } : {}) });
    } catch (error) {
      if ((error as Error).message === UNKNOWN_METHOD) unsupported.add(`${deviceId}:${kind}`);
      throw error;
    }
    let next;
    try {
      next = acceptChunk(at, reply);
    } catch (error) {
      // A resumed file that no longer matches starts over next time.
      file.reset();
      throw error;
    }
    if (next.data) file.append(next.data);
    at = { offset: next.offset, total: next.total, mime: next.mime };
    if (next.done) return finishBlob(key, next.mime!, next.offset);
  }
  file.reset();
  throw new Error('That attachment is too large to show here.');
}
