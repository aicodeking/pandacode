/** R0601 lifecycle model. Native code owns admission and files; this twin is for preview/fixtures only.
 * A lease identity is NOT an authentication credential. No callback transport is implemented here.
 */
export interface RunKey { taskId: string; runId: string }
export interface InstalledCompanionApi { harness: string; version: string | null; apis: readonly string[] }
export interface CompanionProfile {
  id: string;
  harness: string;
  versions: readonly string[];
  api: string;
  protocol: number;
  evidence: 'synthetic' | 'sourceFeasible' | 'installedQualified';
}
export type StopReason = 'runEnded' | 'disabled' | 'revoked' | 'serviceFailure' | 'safeMode' | 'hostShutdown';
export interface CompanionCapability {
  state: 'ready' | 'unsupported' | 'active' | 'ended';
  code: 'UnsupportedCapability' | null;
  reason: string | null;
  harness: string;
  version: string | null;
  profile: string | null;
  evidence: CompanionProfile['evidence'] | 'unsupported';
  ordinaryApprovals: 'unchanged';
}
export interface CompanionManifest extends RunKey { schemaVersion: 1; leaseId: string; profile: string; protocol: number }
/** Host-owned resource, created only after negotiation. close must be idempotent and retryable.
 * It must withdraw the descriptor, cancel handlers and close any future endpoint, then remove owned files.
 * If construction throws, the factory must roll back its own partial resources.
 */
export interface CompanionResources {
  readonly env: Readonly<Record<string, string>>;
  close(): void;
}
export interface CompanionLease extends RunKey { leaseId: string }
export interface CompanionLaunch { lease: CompanionLease; env: Record<string, string>; capability: CompanionCapability }
export class CompanionError extends Error {
  readonly code: 'Conflict' | 'InvalidShape' | 'HostUnavailable' | 'StaleContext' | 'UnsupportedCapability';
  constructor(code: 'Conflict' | 'InvalidShape' | 'HostUnavailable' | 'StaleContext' | 'UnsupportedCapability', message: string) { super(message); this.code = code; }
}

export function negotiateCompanion(installed: InstalledCompanionApi, profile: CompanionProfile | null): CompanionCapability {
  let reason: string | null = null;
  if (!profile || profile.harness !== installed.harness) reason = 'No host companion profile for this harness.';
  else if (profile.protocol !== 1) reason = 'The host does not implement this companion protocol.';
  else if (!installed.version || !profile.versions.includes(installed.version)) reason = 'The installed version has no qualified companion profile.';
  else if (!installed.apis.includes(profile.api)) reason = 'The installed harness does not expose the required per-run API.';
  return {
    state: reason ? 'unsupported' : 'ready', code: reason ? 'UnsupportedCapability' : null, reason,
    harness: installed.harness, version: installed.version, profile: profile?.id ?? null,
    evidence: reason ? 'unsupported' : profile!.evidence, ordinaryApprovals: 'unchanged',
  };
}

interface Entry {
  lease: CompanionLease;
  owners: readonly string[];
  capability: CompanionCapability;
  active: boolean;
  reason: StopReason | null;
  resources: CompanionResources | null;
  cleanupPending: boolean;
}
const validId = (value: string) => value.length > 0 && [...value].length <= 256 && !/\p{Cc}/u.test(value);
const keyOf = (key: RunKey) => JSON.stringify([key.taskId, key.runId]);

/** One instance per host lifetime. Retired run keys are retained so a delayed launch cannot reopen an ended run.
 * Resource factories and close methods must not reenter this registry. No package-supplied profile/factory is accepted.
 */
export class CompanionLifetime {
  private entries = new Map<string, Entry>();
  private capabilities = new Map<string, CompanionCapability>();
  private reserved = new Set<string>();
  private sequence = 0;
  private revision = 0;
  private safeMode = false;
  private shutdown = false;
  private readonly hostInstance: string;
  constructor(hostInstance: string) {
    this.hostInstance = hostInstance;
    if (!validId(hostInstance)) throw new CompanionError('InvalidShape', 'Invalid host instance.');
  }

  begin(key: RunKey, owners: readonly string[], installed: InstalledCompanionApi, profile: CompanionProfile | null,
    create: (manifest: CompanionManifest) => CompanionResources): CompanionLaunch {
    if (!validId(key.taskId) || !validId(key.runId) || !owners.length || owners.some(owner => !validId(owner)))
      throw new CompanionError('InvalidShape', 'A run and at least one admitted hook owner are required.');
    if (this.safeMode || this.shutdown) throw new CompanionError('HostUnavailable', 'Companions are disabled by the host.');
    const keyString = keyOf(key);
    if (this.entries.has(keyString) || this.reserved.has(keyString)) throw new CompanionError('Conflict', 'This run already has a companion or has ended.');
    const capability = negotiateCompanion(installed, profile);
    this.capabilities.set(installed.harness, { ...capability }); this.revision++;
    if (capability.code) throw new CompanionError(capability.code, capability.reason!);
    const lease: CompanionLease = { taskId: key.taskId, runId: key.runId, leaseId: `${this.hostInstance}:${++this.sequence}` };
    const manifest: CompanionManifest = { ...lease, schemaVersion: 1, profile: profile!.id, protocol: profile!.protocol };
    this.reserved.add(keyString);
    let resources: CompanionResources;
    try { resources = create(manifest); }
    catch { throw new CompanionError('HostUnavailable', 'Companion resources could not be prepared; ordinary approvals remain available.'); }
    finally { this.reserved.delete(keyString); }
    const active = { ...capability, state: 'active' as const };
    this.entries.set(keyString, { lease, owners: [...new Set(owners)], capability: active, active: true, reason: null, resources, cleanupPending: false });
    this.capabilities.set(installed.harness, active); this.revision++;
    return { lease: { ...lease }, env: { ...resources.env }, capability: { ...active } };
  }

  /** Checks both host-expected key and presented identity, before admission AND after an awaited handler. */
  current(expected: RunKey, presented: CompanionLease): boolean {
    const entry = this.entries.get(keyOf(expected));
    return !this.safeMode && !this.shutdown && !!entry?.active && presented.taskId === expected.taskId
      && presented.runId === expected.runId && presented.leaseId === entry.lease.leaseId;
  }

  injection(lease: CompanionLease): Record<string, string> {
    if (!this.current(lease, lease)) throw new CompanionError('StaleContext', 'The companion run ended.');
    return { ...this.entries.get(keyOf(lease))!.resources!.env };
  }

  end(key: RunKey, reason: StopReason = 'runEnded'): void {
    const id = keyOf(key); const entry = this.entries.get(id);
    if (!entry) {
      // End-before-start is a tombstone too (e.g. a cancelled launch with a late version probe).
      this.entries.set(id, { lease: { ...key, leaseId: '' }, owners: [], capability: {
        state: 'ended', code: null, reason, harness: '', version: null, profile: null, evidence: 'unsupported', ordinaryApprovals: 'unchanged',
      }, active: false, reason, resources: null, cleanupPending: false });
      this.revision++; return;
    }
    if (entry.active) {
      // Invalidate before touching files or cancelling handlers: no late result may authorize this run.
      entry.active = false; entry.reason = reason;
      entry.capability = { ...entry.capability, state: 'ended', reason };
      this.revision++;
    }
    this.cleanup(entry);
    const harness = entry.capability.harness;
    if (this.capabilities.get(harness)?.state === 'active'
      && ![...this.entries.values()].some(item => item.active && item.capability.harness === harness)) {
      this.capabilities.set(harness, { ...entry.capability });
    }
  }
  private cleanup(entry: Entry): void {
    if (!entry.resources) return;
    try { entry.resources.close(); entry.resources = null; entry.cleanupPending = false; }
    catch { entry.cleanupPending = true; }
    this.revision++;
  }
  retryCleanup(): void { for (const entry of this.entries.values()) if (!entry.active && entry.cleanupPending) this.cleanup(entry); }
  endOwner(owner: string, reason: 'disabled' | 'revoked' | 'serviceFailure'): void {
    for (const entry of this.entries.values()) if (entry.active && entry.owners.includes(owner)) this.end(entry.lease, reason);
  }
  setSafeMode(enabled: boolean): void {
    if (enabled === this.safeMode) return;
    this.safeMode = enabled; this.revision++;
    if (enabled) for (const entry of this.entries.values()) if (entry.active) this.end(entry.lease, 'safeMode');
  }
  stop(): void {
    if (this.shutdown) return;
    this.shutdown = true; this.revision++;
    for (const entry of this.entries.values()) if (entry.active) this.end(entry.lease, 'hostShutdown');
  }
  capability(harness: string): CompanionCapability | null {
    const observed = this.capabilities.get(harness);
    if (!observed) return null;
    const active = [...this.entries.values()].some(entry => entry.active && entry.capability.harness === harness);
    return { ...observed, state: observed.code ? 'unsupported' : active ? 'active' : observed.state === 'active' ? 'ended' : observed.state };
  }
  /** Public projection contains no env, paths, lease IDs, credentials or package data. */
  report() {
    return { schemaVersion: 1, revision: this.revision, safeMode: this.safeMode, shutdown: this.shutdown,
      harnesses: [...this.capabilities.keys()].sort().map(id => ({ ...this.capability(id)! })),
      activeRuns: [...this.entries.values()].filter(entry => entry.active).length,
      cleanupPending: [...this.entries.values()].filter(entry => entry.cleanupPending).length };
  }
}
