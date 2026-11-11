// Demo answers for the `settings` feature group (src/connect/api/settings.ts): a few harnesses in
// each readiness state, a routing switch that remembers its position for the session, RTK found,
// and one moodboard drawn as SVG; photos added from the phone (moodboards.add) join it for the
// session as a plain swatch. See ./index.ts.
import type { DemoHandlers } from './index.ts';

const DAY = 86_400_000;

const HARNESSES = [
  { id: 'claude', name: 'Claude Code', installed: true, executable: 'claude', version: '2.1.4', models: 4, status: 'ready', update: { status: 'current', latest: '2.1.4', canUpdate: false } },
  { id: 'codex', name: 'Codex', installed: true, executable: 'codex', version: '0.48.0', models: 6, status: 'installed', update: { status: 'available', latest: '0.50.0', canUpdate: true } },
  { id: 'glm', name: 'GLM Coding Plan', installed: true, executable: 'claude', version: '2.1.4', models: 2, status: 'needsKey', update: null },
  { id: 'opencode', name: 'OpenCode', installed: false, executable: null, version: '', models: 0, status: 'missing', update: null },
] as const;

const SWATCHES = [
  { id: 'm1', name: 'Warm paper', caption: 'Background tone for the account page', colors: ['#faf3e6', '#e9dcc4', '#c9b79c'] },
  { id: 'm2', name: 'Calm blue', caption: 'Primary buttons and links', colors: ['#e6f0fa', '#3a7bd5', '#1d3f73'] },
  { id: 'm3', name: 'Ink', caption: '', colors: ['#2b2b2b', '#555555', '#9a9a9a'] },
] as const;

/** Photos added this session (moodboards.add); replaced, never edited in place. */
let added: readonly { id: string; name: string; createdAt: number }[] = [];
const ADDED_COLORS = ['#d9d4cc', '#b8b1a6', '#8f887d'] as const;

/** The routing switch's demo position; the demo host's state has no settings of its own. */
let routingOn = false;

const routing = () => ({ on: routingOn, mode: 'balanced', profiler: routingOn ? 'missing' : 'ready', failed: false });

function swatch(id: string) {
  const extra = added.find(a => a.id === id);
  const found = extra ? { colors: ADDED_COLORS } : SWATCHES.find(s => s.id === id);
  if (!found) throw new Error('Image is unavailable in this project\'s moodboard.');
  const bands = found.colors.map((c, i) => `<rect x="${i * 100}" width="100" height="300" fill="${c}"/>`).join('');
  const data = btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">${bands}</svg>`);
  return { mime: 'image/svg+xml', total: data.length, offset: 0, data, done: true };
}

export const handlers: DemoHandlers = {
  'settings.providers': () => ({ providers: HARNESSES.map(h => ({ ...h })) }),
  'settings.routing': () => routing(),
  'settings.setRouting': (_ctx, p) => {
    if (typeof p?.on !== 'boolean') throw new Error('Missing on.');
    routingOn = p.on;
    return routing();
  },
  'settings.tokenSaver': () => ({ rtk: true, rtkVersion: '0.37.1' }),
  'settings.jj': () => ({ isRepo: false, colocated: false, change: null, files: [], truncated: false }),
  'moodboards.list': ({ host }) => ({
    boards: [{
      id: 'b1', projectId: 'demo', name: 'Account page', imageCount: SWATCHES.length + added.length, updatedAt: added.at(-1)?.createdAt ?? host.now() - DAY,
      images: [
        ...SWATCHES.map((s, i) => ({ id: s.id, name: s.name, caption: s.caption, width: 300, height: 300, createdAt: host.now() - (i + 1) * DAY })),
        ...added.map(a => ({ id: a.id, name: a.name, caption: '', width: 300, height: 300, createdAt: a.createdAt })),
      ],
    }],
    truncated: false,
  }),
  'moodboards.add': ({ host }, p) => {
    if (typeof p?.projectId !== 'string' || !p.projectId) throw new Error('Missing projectId.');
    if (p.board !== 'b1') throw new Error('That moodboard no longer exists.');
    if (typeof p.imageId !== 'string' || !p.imageId) throw new Error('Missing imageId.');
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 120) : 'Photo';
    const image = { id: `added-${added.length + 1}`, name, createdAt: host.now() };
    added = [...added, image];
    return { image: { ...image, caption: '', width: 300, height: 300 } };
  },
  'moodboards.image': (_ctx, p) => swatch(String(p?.imageId)),
};
