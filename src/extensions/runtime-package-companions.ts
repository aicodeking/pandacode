/** Declarative package companions; native code owns trust, grants and code extraction. */
import type { InstalledCompanionApi } from './runtime-companion-lifetime.ts';
import { negotiateCompanion } from './runtime-companion-lifetime.ts';
import { opencodeProfile, opencodeInline } from './runtime-opencode-companion.ts';
import { kiloProfile, kiloInline } from './runtime-kilo-companion.ts';
export const COMPANION_PERMISSION = 'harness.companions';
export const COMPANION_HARNESSES = ['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes', 'cursor'] as const;
export interface PackageCompanion { id: string; title: string; harness: string; file: string }
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export function checkCompanionDeclarations(value: unknown): { ok: true; declarations: PackageCompanion[] } | { ok: false; refusal: { code: string; at: string; ids: string[] } } {
  const manifest = object(value) ? value : {}; const contributes = object(manifest.contributes) ? manifest.contributes : {};
  const declarations = contributes.companions ?? []; const owner = String(manifest.id ?? '');
  const fail = (code: string, id = owner) => ({ ok: false as const, refusal: { code, at: 'contributes/companions', ids: [id] } });
  if (!Array.isArray(declarations)) return fail('InvalidShape');
  if (declarations.length > 16) return fail('LimitExceeded');
  const ids = new Set<string>(); const out: PackageCompanion[] = [];
  const runtime = object(manifest.runtime) ? manifest.runtime : {}; const folders = Array.isArray(runtime.files) ? runtime.files : [];
  for (const declaration of declarations) {
    if (!object(declaration) || Object.keys(declaration).some(k => !['id', 'title', 'harness', 'file'].includes(k))) return fail('InvalidShape');
    const { id, title, harness, file } = declaration;
    if (typeof id !== 'string' || !id.startsWith(`${owner}/`) || !/^[a-zA-Z0-9._/-]+$/.test(id)) return fail('InvalidId');
    if (id.startsWith('panda.')) return fail('ReservedId', id);
    if (ids.has(id)) return fail('DuplicateId', id); ids.add(id);
    if (typeof title !== 'string' || !title.trim() || [...title].length > 200 || typeof harness !== 'string' || !(COMPANION_HARNESSES as readonly string[]).includes(harness)) return fail('InvalidShape', id);
    if (typeof file !== 'string' || file.length > 512 || file.includes('\\') || file.includes(':') || file.split('/').some(p => !p || p === '.' || p === '..' || /[\u0000-\u001f\u007f]/.test(p)) || !folders.includes(file.split('/')[0]) || !file.includes('/')) return fail('UnsafeAsset', id);
    out.push({ id, title, harness, file });
  }
  if (out.length && !(Array.isArray(manifest.permissions) && manifest.permissions.includes(COMPANION_PERMISSION))) return fail('PermissionDenied');
  return { ok: true, declarations: out };
}
/** Source qualification only. Package entry loading is narrower than host callback forwarding. */
export function packageProfile(installed: InstalledCompanionApi) {
  const profile = installed.harness === 'kilo' ? kiloProfile(installed) : opencodeProfile(installed);
  return profile?.id.endsWith('.v1') ? profile : null;
}
export function packageInline(installed: InstalledCompanionApi, fileUrl: string, previous = '{}', pure = false): Record<string, string> {
  if (!packageProfile(installed)) throw Error('UnsupportedCapability');
  return installed.harness === 'kilo' ? kiloInline(installed, fileUrl, pure, previous) : opencodeInline(installed, fileUrl, pure, previous);
}
export interface CompanionListing extends PackageCompanion { owner: string; packageName: string; version: string; code: string | null; qualification: string; modelRequest: 'notReported'; compaction: 'notReported' }
/** Pure fixture/preview projection of the same installed snapshot the native selector reads. */
export function packageCompanions(snapshot: Obj, project: string | null, installed: InstalledCompanionApi, granted: (owner: string, version: string) => boolean): CompanionListing[] {
  if (snapshot.safeMode === true) return [];
  const out: CompanionListing[] = [];
  for (const item of (Array.isArray(snapshot.packages) ? snapshot.packages : [])) {
    if (!object(item) || item.enabled !== true || !object(item.executable) || item.executable.trusted !== true || !object(item.manifest)) continue;
    if (Array.isArray(item.projects) && (project === null || !item.projects.includes(project))) continue;
    const manifest = item.manifest; const owner = String(manifest.id); const version = String(manifest.version);
    const checked = checkCompanionDeclarations(manifest); if (!checked.ok || !granted(owner, version)) continue;
    for (const declaration of checked.declarations.filter(d => d.harness === installed.harness)) {
      const code = negotiateCompanion(installed, packageProfile(installed)).code ?? null;
      out.push({ ...declaration, owner, packageName: String(manifest.name ?? owner), version, code, qualification: code ? 'unsupported' : 'sourceFeasible', modelRequest: 'notReported', compaction: 'notReported' });
    }
  }
  return out;
}
export function companionCoverage(harness: string) {
  const adapter = ['claude', 'glm', 'mimo', 'alibaba'].includes(harness) ? 'runtime_callback_companions (initialize callbacks)' : ['pi', 'omp'].includes(harness) ? 'runtime_callback_companions (existing extension bridge)' : harness === 'codex' ? 'runtime_codex_companion' : harness === 'opencode' ? 'runtime_opencode_companion' : harness === 'kilo' ? 'runtime_kilo_companion' : null;
  const reasons: Record<string, string> = {
    kimi: 'No demonstrated per-run native hook injection API.', antigravity: 'Host permission bridge only; no demonstrated per-run plugin API.',
    grok: 'Hook files require user/project configuration; no per-run loader.', deepseek: 'Sandbox escalation bridge only; no verified hook interception API.',
    commandcode: 'Configuration-file hooks only; Plan skips them.', cline: 'SDK pluginPaths does not establish per-run ACP plugin loading.',
    'github-copilot': 'Hook directories/settings are global or project configuration; ACP loader unverified.', hermes: 'Plugin enablement edits profile configuration; ACP hook execution unverified.',
    zcode: 'Permission bridge exists; no verified native companion API.', devin: 'Permission bridge covers only requested operations; no per-run hook loader.',
    muse: 'Sandbox permission bridge only; no demonstrated companion API.', cursor: 'Configuration-file hooks do not establish a per-run ACP loader.',
  };
  return { harness, adapter, code: 'UnsupportedCapability', reason: adapter ? 'Source adapter exists; installed version/API, launch and platform qualification pending.' : reasons[harness] ?? 'No host adapter for this harness.', source: adapter ? 'sourceFeasible' : 'unsupported', fake: 'written, not run', recorded: 'no live companion capture', installed: 'not authorized or qualified', modelRequest: 'notReported', compaction: 'notReported' };
}
