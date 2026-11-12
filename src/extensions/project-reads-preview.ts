/** Synthetic exact-resource policy only; native descriptor/reparse checks are not mocked evidence. */
import { contextFailure, type ContextReply } from './context-state.ts';
export type ProjectReadData = { files?: Record<string, Record<string, string>>; heads?: Record<string, { branch: string | null; commit: string | null }> };
export const readCapability = (resource: unknown) => ({ metadata: 'projects.files.metadata', file: 'projects.files.read', git: 'projects.git.read' })[String(resource) as 'metadata' | 'file' | 'git'];
export function readPath(path: unknown, git: boolean): string | undefined {
  if (typeof path !== 'string') return 'InvalidShape';
  if (git) return path === '.' ? undefined : 'PermissionDenied';
  if (!path.length || new TextEncoder().encode(path).length > 1024 || path.split('/').length > 32) return 'LimitExceeded';
  for (const part of path.split('/')) {
    const lower = part.toLowerCase(), stem = lower.split('.')[0];
    if (!part || part.startsWith('.') || /[. ]$/.test(part) || /[\x00-\x1f\x7f\\:*?"<>|]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|credentials?|auth|secrets?|id_rsa|id_ed25519)$/.test(stem) || /\.(pem|key)$/.test(lower)) return 'PermissionDenied';
  }
}
export function previewProjectRead(data: ProjectReadData, project: string, resource: string, path: string, cursor: unknown, expected: unknown): ContextReply {
  const fail = contextFailure, offset = cursor ?? 0;
  if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 131072 || expected != null && (typeof expected !== 'string' || expected.length > 64)) return fail('LimitExceeded');
  if (Number(offset) > 0 && expected == null) return fail('StaleContext');
  const source = resource === 'git' ? data.heads?.[project] : data.files?.[project]?.[path];
  if (source === undefined) return fail('NotFound');
  const text = typeof source === 'string' ? source : JSON.stringify(source), bytes = new TextEncoder().encode(text);
  let hash = 2166136261; for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  const revision = String(hash);
  if (expected != null && expected !== revision) return fail('StaleContext');
  let items: unknown[] = [], content: string | null = null, nextCursor: number | null = null;
  if (resource === 'file') {
    if (bytes.length > 131072) return fail('LimitExceeded');
    if (text.includes('\0')) return fail('UnsupportedCapability');
    if (Number(offset) > bytes.length || Number(offset) < bytes.length && (bytes[Number(offset)] & 0xc0) === 0x80) return fail('InvalidShape');
    let end = Math.min(Number(offset) + 4096, bytes.length); while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    content = new TextDecoder().decode(bytes.slice(Number(offset), end)); if (end < bytes.length) nextCursor = end;
  } else {
    if (Number(offset) !== 0) return fail('InvalidShape');
    items = resource === 'metadata' ? [{ path, bytes: bytes.length, kind: 'file' }] : [{ kind: 'head', ...source as object }];
  }
  return { ok: true, value: { schemaVersion: 1, state: 'Ready', revision, items, content, nextCursor } };
}
