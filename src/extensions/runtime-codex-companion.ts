/** Source-profile Codex adapter. The host supplies a qualified API and a live run lease.
 * No configuration files, version probes or trust-bypass switches are used here.
 */
import { CompanionError, negotiateCompanion } from './runtime-companion-lifetime';
import type { CompanionLifetime, CompanionLease, CompanionProfile, InstalledCompanionApi } from './runtime-companion-lifetime';
export const CODEX_SOURCE = 'aea4c6ee4b652d84b416731b11c2b8299d767209';
export const CODEX_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse'] as const;
export const codexProfile: CompanionProfile = { id: 'codex.command.v1', harness: 'codex', versions: [CODEX_SOURCE], api: 'codex.session-hooks.v1', protocol: 1, evidence: 'sourceFeasible' };
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Unknown/custom shell dialects require a separate profile. Tool text is never a command argument. */
export function codexCommand(node: string, script: string, shell: 'cmd' | 'posix'): string {
  const quote = (path: string) => {
    if (!path || /[\x00-\x1f]/.test(path)) throw new CompanionError('UnsupportedCapability', 'Unsupported command path.');
    if (shell === 'cmd') {
      if (!/^[\p{L}\p{N} _:.\\/\-]+$/u.test(path)) throw new CompanionError('UnsupportedCapability', 'Unsupported Windows command path.');
      return `"${path}"`;
    }
    return `'${path.replaceAll("'", "'\\''")}'`;
  };
  return `${quote(node)} ${quote(script)}`;
}
export class CodexCompanion {
  private readonly host: CompanionLifetime;
  private readonly lease: CompanionLease;
  private readonly cwd: string;
  private readonly command: string;
  private generation = 0;
  private pending = 0;
  private state: Obj | null = null;
  private closed = false;
  constructor(host: CompanionLifetime, lease: CompanionLease, installed: InstalledCompanionApi, cwd: string, command: string) {
    if (negotiateCompanion(installed, codexProfile).code) throw new CompanionError('UnsupportedCapability', 'UnsupportedCapability');
    this.host = host; this.lease = { ...lease }; this.cwd = cwd; this.command = command; this.current();
  }
  private current() { if (this.closed || !this.host.current(this.lease, this.lease)) throw new CompanionError('StaleContext', 'StaleContext'); }
  declarations(): Obj {
    this.current();
    return { 'features.hooks': true, ...Object.fromEntries(CODEX_EVENTS.map(event => [`hooks.${event}`, [{ hooks: [{ type: 'command', command: this.command, commandWindows: this.command, timeout: 2 }] }]])) };
  }
  /** Invoke after initialize/initialized; always repeat before resume, discarding previous hashes first. */
  inventory() {
    this.current(); this.state = null; this.pending = ++this.generation;
    return { id: this.pending, method: 'hooks/list', params: { cwds: [this.cwd] } };
  }
  acceptInventory(id: number, result: unknown): void {
    this.current(); this.state = null;
    if (!id || id !== this.pending) throw new CompanionError('StaleContext', 'StaleContext');
    this.pending = 0;
    if (!object(result) || !Array.isArray(result.data) || result.data.length !== 1) throw new CompanionError('UnsupportedCapability', 'Invalid inventory.');
    const row = result.data[0];
    if (!object(row) || row.cwd !== this.cwd || !Array.isArray(row.hooks) || !Array.isArray(row.errors) || row.errors.length) throw new CompanionError('UnsupportedCapability', 'Invalid inventory.');
    const state: Obj = Object.create(null);
    for (const event of CODEX_EVENTS) {
      const own = row.hooks.filter((h: unknown) => object(h) && h.eventName === event && h.source === 'sessionFlags' && object(h.handler) && h.handler.type === 'command' && h.handler.command === this.command);
      if (own.length !== 1) throw new CompanionError('UnsupportedCapability', 'Missing or ambiguous session hook.');
      const hook = own[0] as Obj;
      if (typeof hook.key !== 'string' || !hook.key || hook.key.length > 4096 || typeof hook.currentHash !== 'string' || !hook.currentHash || hook.currentHash.length > 4096 || Object.hasOwn(state, hook.key)) throw new CompanionError('UnsupportedCapability', 'Invalid hook key/hash.');
      state[hook.key] = { enabled: true, trusted_hash: hook.currentHash };
    }
    this.state = state;
  }
  thread(threadId?: string, config: Obj = {}) {
    this.current(); if (!this.state) throw new CompanionError('UnsupportedCapability', 'Inventory required.');
    const state = this.state; this.state = null;
    // Consume the inventory once; do not cache trust across resume or unrelated threads.
    return { method: threadId ? 'thread/resume' : 'thread/start', params: { cwd: this.cwd, ...(threadId ? { threadId } : {}), config: { ...config, 'hooks.state': state } } };
  }
  close() { this.closed = true; this.pending = 0; this.state = null; }
}
export function codexReply(event: string, answer: Obj): Obj {
  const reason = typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason : 'Declined by an extension.';
  if (event === 'PreToolUse') {
    if (answer.decision === 'deny') return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } };
    if (answer.decision === 'rewrite' && object(answer.input)) return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'allow', updatedInput: answer.input } };
  }
  if (event === 'PermissionRequest' && ['approve', 'deny'].includes(String(answer.decision))) return { hookSpecificOutput: { hookEventName: event, decision: answer.decision === 'deny' ? { behavior: 'deny', message: reason } : { behavior: 'allow' } } };
  // PostToolUse cannot replace tool output in this source profile.
  return {};
}
