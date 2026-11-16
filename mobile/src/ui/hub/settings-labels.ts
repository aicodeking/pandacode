// What the computer settings screen says about harnesses, routing and the token saver. Pure
// (tests/settings.test.ts); the calls are in ../../connect/api/settings.ts.
import type { Harness, RoutingState, TokenSaverTools } from '../../connect/api/settings.ts';

/** A StatusDot tone, or null for a hollow (faint) dot. */
export type DotTone = 'success' | 'warning' | 'info' | null;

/** The readiness dot and its words for one harness. */
export function readinessLabel(h: Pick<Harness, 'status'>): { tone: DotTone; text: string } {
  switch (h.status) {
    case 'ready': return { tone: 'success', text: 'Ready' };
    case 'needsKey': return { tone: 'warning', text: 'Needs an API key' };
    case 'signedOut': return { tone: 'warning', text: 'Not signed in' };
    case 'missing': return { tone: null, text: 'Not installed' };
    default: return { tone: 'info', text: 'Installed' };
  }
}

/** "1.2.3 · codex · 12 models · Update to 1.3.0 on the computer". */
export function harnessDetail(h: Harness): string {
  if (!h.installed) return 'Install it on the computer to use it';
  const models = h.models === 1 ? '1 model' : `${h.models} models`;
  const parts = [h.version, h.executable, h.models ? models : ''].filter(Boolean);
  if (h.update?.status === 'available') parts.push(h.update.latest ? `Update to ${h.update.latest} on the computer` : 'Update on the computer');
  return parts.join(' · ');
}

/** Installed harnesses first (ready before the rest), then by name. */
export function sortHarnesses(list: readonly Harness[]): Harness[] {
  const rank = (h: Harness) => (h.status === 'ready' ? 0 : h.installed ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The line under the routing switch. */
export function routingNote(r: RoutingState): string {
  if (!r.on) return 'Teams on the computer pick each worker’s model as set up.';
  if (r.failed || r.profiler === 'failed') return 'On, but the computer couldn’t prepare the router. Open Settings there to retry.';
  if (r.profiler === 'unavailable') return 'On, using the rules only: the router’s profiler doesn’t run on this computer.';
  if (r.profiler === 'missing') return 'On. The computer downloads the router’s files when a team first uses it.';
  if (r.profiler === 'downloading') return 'On. The computer is downloading the router’s files.';
  return 'On: teams send each step to the model most likely to succeed for its cost.';
}

/** The token saver's line: the packs are chosen per thread in the composer on the computer. */
export function tokenSaverNote(t: TokenSaverTools): string {
  return t.rtk
    ? `RTK ${t.rtkVersion || ''}`.trim() + ' is installed, so the RTK compression pack is available.'
    : 'RTK isn’t installed on the computer; the other packs work without it.';
}
