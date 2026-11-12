// `host.hello` (docs/remote-access.md, "App protocol"): what a host serves, decoded and kept per
// device. Pure: no store or network here (tested in node, tests/capabilities.test.ts).
import { METHODS } from '../rpc.ts';

/** A host's limits as it reports them; absent ones fall back to the host's defaults. */
export interface HostLimits { maxText?: number; pageBudget?: number; packedPageMax?: number; maxBatch?: number; maxIds?: number; maxPath?: number; maxFrame?: number; maxImages?: number; maxImageBytes?: number; imageChunk?: number }

/** A device grant on a host, narrowest first (src-tauri/src/remote/grants.rs). */
export type Access = 'view' | 'control' | 'full';
const RANK: Record<Access, number> = { view: 1, control: 2, full: 3 };
const isAccess = (value: unknown): value is Access => value === 'view' || value === 'control' || value === 'full';

/** Methods that also need the host's "Full access for remote tasks" switch, for a host that
 * answers host.hello without listing them (`fullAccessSwitch`). Kept equal to SWITCH_METHODS in
 * src-tauri/src/remote/methods/mod.rs (tests/capabilities.test.ts compares them). */
export const SWITCH_METHODS: ReadonlySet<string> = new Set(['terminal.list', 'terminal.open', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.close', 'runScript.start', 'checks.run', 'files.write', 'skills.activate', 'cloudAgents.start', 'moodboards.add', 'projects.clone', 'runScript.stop', 'team.start']);

/** `hello`: the host answered host.hello. `legacy`: an older host answered 'Unknown method.' and
 * serves only the methods from before host.hello (minus any it refused since, `missing`). */
export type HostCapabilities =
  | {
    kind: 'hello'; protocol: number; appVersion: string; methods: ReadonlySet<string>; limits: HostLimits; features: ReadonlySet<string>; missing: ReadonlySet<string>;
    /** This phone's grant there; undefined from hosts that don't say (then nothing is hidden for it). */
    access?: Access;
    /** The narrowest grant each method needs (absent: unknown, treated as allowed). */
    methodAccess: ReadonlyMap<string, Access>;
    /** Methods gated on the host's Full access switch, and whether it is on (`remoteFullAccess`). */
    switchMethods: ReadonlySet<string>;
    remoteFullAccess: boolean;
  }
  | { kind: 'legacy'; protocol: 1; missing: ReadonlySet<string> };

/** Methods a host from before host.hello may serve (some older ones lack pulls, bots or teams:
 * their 'Unknown method.' still lands in `missing` or the store's `outdated`). */
export const LEGACY_METHODS: ReadonlySet<string> = new Set(METHODS.filter(m => m !== 'host.hello'));

const MAX_METHODS = 1000;
const NAME = /^[\x21-\x7e]{1,64}$/;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.slice(0, MAX_METHODS).filter((v): v is string => typeof v === 'string' && NAME.test(v)) : [];

function limitsOf(value: unknown): HostLimits {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[key] = n;
  return out as HostLimits;
}

/** Decodes a host.hello reply; null when it is not one (the host is then treated as unknown, not legacy). */
export function parseHello(reply: unknown): Extract<HostCapabilities, { kind: 'hello' }> | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as Record<string, unknown>;
  if (typeof r.protocol !== 'number' || !Number.isInteger(r.protocol) || r.protocol < 2 || !Array.isArray(r.methods)) return null;
  const features = new Set(strings(r.features));
  return {
    kind: 'hello',
    protocol: r.protocol,
    appVersion: typeof r.appVersion === 'string' ? r.appVersion.slice(0, 64) : '',
    methods: new Set(strings(r.methods)),
    limits: limitsOf(r.limits),
    features,
    missing: new Set(),
    ...(isAccess(r.access) && { access: r.access }),
    methodAccess: methodAccessOf(r.methodAccess),
    switchMethods: Array.isArray(r.fullAccessSwitch) ? new Set(strings(r.fullAccessSwitch)) : SWITCH_METHODS,
    remoteFullAccess: features.has('remoteFullAccess'),
  };
}

function methodAccessOf(value: unknown): ReadonlyMap<string, Access> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const out = new Map<string, Access>();
  for (const [name, access] of Object.entries(value).slice(0, MAX_METHODS)) if (NAME.test(name) && isAccess(access)) out.set(name, access);
  return out;
}

export const legacy = (): HostCapabilities => ({ kind: 'legacy', protocol: 1, missing: new Set() });

/** Whether the host serves `method`: true or false once known, undefined before host.hello settled. */
export function supports(caps: HostCapabilities | undefined, method: string): boolean | undefined {
  if (!caps) return undefined;
  if (caps.missing.has(method)) return false;
  return caps.kind === 'hello' ? caps.methods.has(method) : LEGACY_METHODS.has(method);
}

/** Why this phone can't use `method` on a host, or null when it can (or it is not known yet):
 * `outdated` (the host lacks it: "Update PandaCode on <computer> to use this."), `access` (its
 * grant here is too narrow: ask for more on the computer) or `switch` (it needs "Full access for
 * remote tasks" turned on on the computer). Pure; capabilities.ts wraps it in hooks. */
export type Blocked = 'outdated' | 'access' | 'switch';
export function blockedBy(caps: HostCapabilities | undefined, method: string): Blocked | null {
  if (supports(caps, method) === false) return 'outdated';
  if (caps?.kind !== 'hello') return null;
  const needed = caps.methodAccess.get(method);
  if (caps.access && needed && RANK[caps.access] < RANK[needed]) return 'access';
  if (needsFullAccessSwitch(caps, method)) return 'switch';
  return null;
}

/** Whether `method` waits on the host's "Full access for remote tasks" switch, which is off. */
export const needsFullAccessSwitch = (caps: HostCapabilities | undefined, method: string): boolean =>
  caps?.kind === 'hello' && !caps.remoteFullAccess && caps.switchMethods.has(method);

/** Whether this phone may use `method` there: false once known blocked, true otherwise (also while unknown). */
export const allows = (caps: HostCapabilities | undefined, method: string): boolean => blockedBy(caps, method) === null;

/** The note a hidden or disabled feature shows for `blockedBy`'s reason. */
export function blockedNote(reason: Blocked, computer: string, access?: Access): string {
  if (reason === 'outdated') return `Update PandaCode on ${computer} to use this.`;
  if (reason === 'switch') return `Turn on Full access for remote tasks on ${computer} to use this.`;
  return access === 'view' ? `This phone can only view tasks on ${computer}. Ask for more access there.` : `This phone needs Full access on ${computer} to do this.`;
}

/** The same capabilities with `method` refused (the host answered 'Unknown method.' to it). */
export const withMissing = (caps: HostCapabilities, method: string): HostCapabilities =>
  caps.missing.has(method) ? caps : { ...caps, missing: new Set([...caps.missing, method]) };

/** A host.hello failure that means "older host": 'Unknown method.', or (older hosts check grants
 * first and kept unknown methods for full access) a view or control device's grant refusal. A newer
 * host serves host.hello to every approved device, so neither happens there. */
export const isLegacyHelloError = (message: string) =>
  message === 'Unknown method.' || /^This device can only view tasks on |^This device is not allowed to do that on /.test(message);
