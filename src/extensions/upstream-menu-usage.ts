// Application menu, settings reveal and usage presentation after the upstream merge (sync slice S0609, docs/extensions/upstream-menu-usage.md).
//
// One adapter over existing public primitives. It owns no usage store: the rows come from the read model of R0204
// (`runtime-usage-resources.ts`, which mirrors the native `runtime_usage_resources.rs` over the `extension_turn_usage`
// table and the cached readings of `agent_usage.rs`). Nothing here carries a credential value (ADR-0006) and nothing
// is withheld for security (ADR-0005): the protections kept are for fault isolation, predictability and stability.
import { SETTINGS_REGISTRY } from './settings-core';
import { HARNESSES, accountsOf, limitsOf, listRevision, type Json, type World } from './runtime-usage-resources';

/** One member of this slice: where it comes from, how it is covered and the evidence that closes it. */
export type MenuUsageMember = Readonly<{ id: string; source: string; disposition: 'adapter' | 'exception'; by: string; evidence: readonly string[]; reason?: string }>;
const SPEC = 'tests/upstream-menu-usage-extensions.spec.ts';
export const MENU_USAGE_MEMBERS: readonly MenuUsageMember[] = Object.freeze([
  { id: 'settings-sections', source: 'src/settings-sections.ts', disposition: 'adapter', by: 'panda.settings.sections', evidence: [SPEC, 'tests/extensions-settings-coverage.spec.ts'] },
  { id: 'settings-reveal', source: 'src/settings-reveal.ts', disposition: 'adapter', by: 'revealTarget', evidence: [SPEC], reason: 'Opening Settings at one control is host-run; a package asks for a page and the host reveals the original node.' },
  { id: 'usage-fix-link', source: 'src/usage-labels.ts', disposition: 'exception', by: 'revealSetting(providers)', evidence: [SPEC], reason: 'An inline link whose only effect is revealing the Providers page, already a settings-pages member.' },
  { id: 'usage-roster', source: 'src/agent-usage.ts', disposition: 'adapter', by: 'panda.status', evidence: [SPEC, 'tests/extensions-status-coverage.spec.ts'] },
  { id: 'app-quit', source: 'src-tauri/src/app_menu.rs', disposition: 'exception', by: 'system-owned', evidence: [SPEC], reason: 'macOS only: swaps the default Quit item for pandacode-app-quit (CmdOrCtrl+Q) so quitting goes through the exit path; no new menu item.' },
]);

/** Pages of Settings a package may ask the host to reveal, and the reveal ids the fix link uses. Never a credential field. */
export const REVEAL_PAGES: readonly string[] = SETTINGS_REGISTRY.map(entry => entry.page);
export const REVEAL_IDS: readonly string[] = ['claude-cli-refresh'];
export type RevealRequest = Readonly<{ page: string; reveal?: string }>;
export type Failure = Readonly<{ code: 'InvalidArguments' | 'UnsupportedCapability' | 'StaleContext' | 'PermissionDenied' | 'Revoked' | 'AlreadyApplied' }>;
const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && 'code' in value;

/** Validates a reveal request: a core page and, optionally, one of the known reveal ids. The host reveals the original node. */
export function revealTarget(input: unknown): RevealRequest | Failure {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { code: 'InvalidArguments' };
  const { page, reveal, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof page !== 'string') return { code: 'InvalidArguments' };
  if (!REVEAL_PAGES.includes(page)) return { code: 'UnsupportedCapability' };
  if (reveal !== undefined && (typeof reveal !== 'string' || !REVEAL_IDS.includes(reveal))) return { code: 'UnsupportedCapability' };
  return { page, ...(reveal === undefined ? {} : { reveal }) };
}

/** Rows of the usage roster that stay visible whatever a layout says: the sign-in notice and Refresh. */
export const PINNED_USAGE_ROWS: readonly string[] = ['overview', 'refresh'];
export type UsageRow = Readonly<{ id: string; harness: string; account: string; kind: 'limits' | 'account'; row: Json }>;

/** The roster of usage rows, derived from R0204's cached read model (limits then accounts, per harness). One row per
 * harness account. The host's own roster has one more provider than the 21 of the previous baseline (Alibaba): the
 * count is read from `HARNESSES`, never fixed here. */
export function usageRoster(world: World, harness: string | null = null): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const item of limitsOf(world, harness)) { const row = item as { harness: string; account: string }; rows.push({ id: `limits:${row.harness}:${row.account}`, harness: row.harness, account: row.account, kind: 'limits', row: item }); }
  for (const item of accountsOf(world, harness)) { const row = item as { harness: string; id: string }; rows.push({ id: `account:${row.harness}:${row.id}`, harness: row.harness, account: row.id, kind: 'account', row: item }); }
  return rows;
}
export const rosterSize = (): number => HARNESSES.length;

/** Layout choices of the user: a stored order of row ids and a set of hidden ids. Restoring clears both. */
export type LayoutState = Readonly<{ order: readonly string[]; hidden: readonly string[] }>;
export const EMPTY_LAYOUT: LayoutState = Object.freeze({ order: [], hidden: [] });

/** Applies order and visibility to row ids. Safe mode, an empty state and an unknown id all fall back to the built-in order. */
export function applyLayout(ids: readonly string[], state: LayoutState, safeMode: boolean): { ids: string[]; hidden: string[] } {
  if (safeMode) return { ids: [...ids], hidden: [] };
  const known = new Set(ids);
  const ordered = [...state.order.filter(id => known.has(id)), ...ids.filter(id => !state.order.includes(id))];
  const hidden = state.hidden.filter(id => known.has(id) && !PINNED_USAGE_ROWS.includes(id));
  return { ids: ordered, hidden };
}
/** Hide one row. A pinned row is refused: it keeps the notice and Refresh reachable. */
export function hideRow(state: LayoutState, id: string): LayoutState {
  return PINNED_USAGE_ROWS.includes(id) || state.hidden.includes(id) ? state : { ...state, hidden: [...state.hidden, id] };
}
export const showRow = (state: LayoutState, id: string): LayoutState => ({ ...state, hidden: state.hidden.filter(item => item !== id) });
/** Move `id` before `target`; unknown ids leave the state unchanged. */
export function moveRow(ids: readonly string[], state: LayoutState, id: string, target: string): LayoutState {
  if (!ids.includes(id) || !ids.includes(target) || id === target) return state;
  const base = applyLayout(ids, state, false).ids.filter(item => item !== id);
  base.splice(base.indexOf(target), 0, id);
  return { ...state, order: base };
}
/** Restore the built-in order and visibility. */
export const restoreLayout = (): LayoutState => EMPTY_LAYOUT;

/** What a presentation captured: the revision of the roster and the opaque context it was shown in. */
export type UsageCapture = Readonly<{ context: string; revision: string; ids: readonly string[]; hidden: readonly string[]; safeMode: boolean }>;
export type UsageAction = Readonly<{ context: string; revision: string; row: string; requestId: string }>;
export type Authority = Readonly<{ active: boolean; granted: boolean; owner: string }>;
export type Admission = { ok: true } | { ok: false; reason: Failure['code'] };

export function captureUsage(context: string, rows: readonly UsageRow[], state: LayoutState, safeMode: boolean): UsageCapture {
  const laid = applyLayout(rows.map(row => row.id), state, safeMode);
  return Object.freeze({ context, revision: listRevision(rows.map(row => row.row)), ids: Object.freeze(laid.ids), hidden: Object.freeze(laid.hidden), safeMode });
}

/** Admits one action against the captured presentation and the live one. A changed revision (a new reading, a switched
 * account, a refresh) or context rejects it; a hidden or unknown row, a revoked grant and a replayed request too. */
export function admitUsageAction(captured: UsageCapture, live: UsageCapture, action: unknown, auth: Authority, owner: string, applied: Set<string>): Admission {
  if (!auth.active) return { ok: false, reason: 'Revoked' };
  if (auth.owner !== owner || !auth.granted) return { ok: false, reason: 'PermissionDenied' };
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return { ok: false, reason: 'InvalidArguments' };
  const input = action as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'context,requestId,revision,row' || [input.context, input.revision, input.row, input.requestId].some(value => typeof value !== 'string' || value.length === 0 || value.length > 128)) return { ok: false, reason: 'InvalidArguments' };
  const request = input as unknown as UsageAction;
  if (request.context !== captured.context || request.context !== live.context || request.revision !== captured.revision || request.revision !== live.revision) return { ok: false, reason: 'StaleContext' };
  if (applied.has(request.requestId)) return { ok: false, reason: 'AlreadyApplied' };
  if (!captured.ids.includes(request.row) || captured.hidden.includes(request.row) || !live.ids.includes(request.row) || live.hidden.includes(request.row)) return { ok: false, reason: 'StaleContext' };
  if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
  applied.add(request.requestId);
  return { ok: true };
}

/** Runs a package presentation; a throw reports once and falls back to the built-in rows, never blocking Settings or usage. */
export function withFallback<T>(render: () => T, builtIn: () => T, report: (message: string) => void): T {
  try { return render(); } catch { report('Menu and usage presentation failed. Built-in rows remain active.'); return builtIn(); }
}
export { isFailure };
