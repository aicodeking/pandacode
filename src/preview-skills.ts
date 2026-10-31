/* Browser preview of the skills library (src-tauri/src/skills.rs): an in-memory library, a
 * pretend Claude Code and Codex install, and the same refusals the native side gives. */
import type { CatalogImport, CatalogSkill, CatalogSource, SkillActivation, SkillCatalogs, SkillCell, SkillFinding, SkillItem, SkillKind, SkillMatrix, SkillScope } from './skills-library';

const PROMPT = new Set(['kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'muse', 'devin', 'zcode', 'hermes']);
const FILES = ['claude', 'codex'];
const PROJECT_ROOT = '/Users/you/Projects/orbit';

function scan(file: string, text: string): SkillFinding[] {
  return text.split('\n').flatMap((line, index) => {
    const found: SkillFinding[] = [];
    if (/\b(ghp_|sk-ant-|AKIA)[A-Za-z0-9_-]{12,}/.test(line)) found.push({ rule: 'secret', file, line: index + 1, excerpt: line.replace(/(ghp_|sk-ant-|AKIA)[A-Za-z0-9_-]+/, '$1…') });
    if (/dangerously-skip-permissions|danger-full-access|--yolo/i.test(line)) found.push({ rule: 'approvals', file, line: index + 1, excerpt: line.trim() });
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/.test(line)) found.push({ rule: 'pipe-to-shell', file, line: index + 1, excerpt: line.trim() });
    return found;
  });
}
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(8);

type Entry = { item: SkillItem; text: string };
type FixtureRepo = { commit: string; private?: boolean; skills: Omit<CatalogSkill, 'imported' | 'conflicts' | 'id' | 'bytes'>[] };
const catalogSkill = (path: string, name: string, files = 2) => ({ path, name, description: `${name} from a repository catalog.`, files });
/** What GitHub would return: repositories the preview user owns, and one public collection. */
const REPOS: Record<string, FixtureRepo> = {
  'you/agent-skills': { commit: '5e6f7a8b9c', private: true, skills: [catalogSkill('skills/release-notes', 'Release notes'), catalogSkill('skills/changelog', 'Changelog'), catalogSkill('skills/triage', 'Triage', 3)] },
  'you/dotfiles': { commit: '0d0d0d0d0d', skills: [] },
  'you/skills-wishlist': { commit: '1a1a1a1a1a', skills: [] },
  'acme/pstack': { commit: 'c0ffee1234', skills: Array.from({ length: 40 }, (_, i) => catalogSkill(`skills/pstack-${String(i + 1).padStart(2, '0')}`, `pstack ${String(i + 1).padStart(2, '0')}`, 4)) },
};
const OWNED = ['you/agent-skills', 'you/dotfiles', 'you/skills-wishlist'];
const at = (repo: string, path: string) => path ? `${repo}/${path}` : repo;

export function createPreviewSkills() {
  const entries = new Map<string, Entry>();
  /** What sits on disk per activation surface: library text, or an edit. */
  const disk = new Map<string, string>();
  const key = (id: string, harness: string, scope: SkillScope) => `${harness}:${scope}:${id}`;
  const view = (entry: Entry): SkillItem => structuredClone(entry.item);
  const list = () => [...entries.values()].sort((a, b) => a.item.id.localeCompare(b.item.id)).map(view);
  const find = (id: unknown) => { const entry = entries.get(String(id)); if (!entry) throw new Error('That skill is not in the library.'); return entry; };

  function add(kind: SkillKind, name: string, text: string, source: SkillItem['source'], files?: string[]): SkillItem {
    const id = slug(name);
    if (!id) throw new Error('Give the skill a name in its frontmatter.');
    const previous = entries.get(id);
    if (previous && previous.item.kind !== kind) throw new Error(`A ${kind === 'skill' ? 'rule' : 'skill'} named ${id} is already in the library.`);
    const main = kind === 'skill' ? 'SKILL.md' : 'RULE.md';
    const sha256 = hash(text);
    const item: SkillItem = {
      id, name, kind, description: text.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')) ?? '', sha256, importedAt: Date.now(), source,
      acknowledged: previous?.item.acknowledged === sha256 ? sha256 : null, activations: previous?.item.activations ?? [], files: files ?? [main], findings: scan(main, text),
    };
    entries.set(id, { item, text });
    return view({ item, text });
  }

  add('skill', 'Release notes', '# Release notes\nWrites release notes from merged pull requests.', { kind: 'github', location: 'anthropics/skills/release-notes', gitRef: null, commit: '9f3c2a1b7e' }, ['SKILL.md', 'templates/short.md']);
  add('rule', 'No force push', 'Never force-push to main or release branches.', { kind: 'folder', location: '/Users/you/rules/no-force-push.md', gitRef: null, commit: null });

  let sources: CatalogSource[] = [];
  let discovery: SkillCatalogs['discovery'] = null;
  let failure: string | null = null;
  const failIfAsked = () => { const next = failure; failure = null; if (next) throw new Error(next); };
  const findSource = (repo: unknown) => {
    const source = sources.find(s => s.repo.toLowerCase() === String(repo).toLowerCase());
    if (!source) throw new Error('That repository is not in your catalogs.');
    return source;
  };
  const scanned = (repo: string, origin: CatalogSource['origin'], gitRef: string | null): CatalogSource => {
    const fixture = REPOS[repo];
    return {
      repo, gitRef, commit: fixture.commit, origin, state: 'enabled', private: !!fixture.private, pushedAt: '2026-10-01T00:00:00Z', scannedAt: Date.now(),
      skills: fixture.skills.map(skill => ({ ...skill, id: slug(skill.name), bytes: skill.files * 400, imported: null, conflicts: [] })),
    };
  };
  const upsert = (source: CatalogSource) => {
    sources = [...sources.filter(s => s.repo !== source.repo), source].sort((a, b) => a.repo.localeCompare(b.repo));
  };
  function catalogs(): SkillCatalogs {
    const holders = new Map<string, string[]>();
    const hold = (id: string, where: string) => holders.set(id, [...(holders.get(id) ?? []), where]);
    for (const entry of entries.values()) hold(entry.item.id, entry.item.source.location);
    for (const source of sources.filter(s => s.state !== 'ignored')) for (const skill of source.skills) hold(skill.id, at(source.repo, skill.path));
    return structuredClone({
      discovery,
      sources: sources.map(source => ({ ...source, skills: source.skills.map(skill => {
        const here = at(source.repo, skill.path);
        const copy = entries.get(skill.id)?.item;
        return { ...skill, conflicts: [...new Set((holders.get(skill.id) ?? []).filter(w => w !== here))], imported: copy?.source.kind === 'github' && copy.source.location === here ? copy.source.commit : null };
      }) })),
    });
  }
  function addCatalog(repo: unknown, gitRef: unknown): SkillCatalogs {
    failIfAsked();
    const name = String(repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Enter the repository as owner/name.');
    if (!REPOS[name]) throw new Error('That repository was not found, or your GitHub login cannot read it.');
    if (!REPOS[name].skills.length) throw new Error(`${name} has no SKILL.md with a name and description in its frontmatter.`);
    const previous = sources.find(s => s.repo === name);
    upsert(scanned(name, previous?.origin ?? 'manual', (gitRef as string) || null));
    return catalogs();
  }
  function discover(): SkillCatalogs {
    failIfAsked();
    const registered: string[] = [];
    for (const repo of OWNED) {
      const known = sources.find(s => s.repo === repo);
      if (known || !REPOS[repo].skills.length) continue;
      upsert(scanned(repo, 'discovered', null));
      registered.push(repo);
    }
    discovery = { at: Date.now(), checked: OWNED.length, registered, failures: [], note: null };
    return catalogs();
  }
  function importCatalog(repo: unknown, paths: unknown): CatalogImport {
    failIfAsked();
    const source = findSource(repo);
    if (source.state !== 'enabled') throw new Error(`${source.repo} is ${source.state}. Enable it to import from it.`);
    const chosen = source.skills.filter(skill => !Array.isArray(paths) || paths.includes(skill.path));
    if (!chosen.length) throw new Error('Choose at least one skill to import.');
    const result: CatalogImport = { items: [], imported: [], skipped: [] };
    for (const skill of chosen) {
      const here = at(source.repo, skill.path);
      const taken = entries.get(skill.id)?.item;
      if (taken && taken.source.location !== here) { result.skipped.push({ path: skill.path, name: skill.name, reason: `${skill.id} is already in the library from ${taken.source.location}.` }); continue; }
      const files = ['SKILL.md', ...Array.from({ length: skill.files - 1 }, (_, i) => `reference-${i + 1}.md`)];
      add('skill', skill.name, `# ${skill.name}\n${skill.description}`, { kind: 'github', location: here, gitRef: source.gitRef, commit: source.commit }, files);
      result.imported.push(skill.name);
    }
    return { ...result, items: list() };
  }

  function cell(entry: Entry, harness: string, scope: SkillScope): SkillCell {
    const activation = entry.item.activations.find(a => a.harness === harness && a.scope === scope);
    const base = scope === 'user' ? '~' : PROJECT_ROOT;
    const surface = PROMPT.has(harness) ? 'prompt' : entry.item.kind === 'skill' ? `${base}/.${harness}/skills/${entry.item.id}` : harness === 'claude' ? `${base}/${scope === 'user' ? '.claude/' : ''}CLAUDE.md` : `${base}/${scope === 'user' ? '.codex/' : ''}AGENTS.md`;
    if (!activation) return { id: entry.item.id, scope, status: 'off', surface };
    if (activation.surface === 'prompt') return { id: entry.item.id, scope, status: 'prompt', surface };
    const onDisk = disk.get(key(entry.item.id, harness, scope));
    const status = onDisk === undefined ? 'missing' : onDisk !== activation.sha256 ? 'drifted' : activation.sha256 !== entry.item.sha256 ? 'outdated' : 'active';
    return { id: entry.item.id, scope, status, surface };
  }

  return {
    PROJECT_ROOT,
    /** Simulate a hand edit of an activated file. */
    edit(id: string, harness: string, scope: SkillScope) { disk.set(key(id, harness, scope), 'edited'); },
    list,
    /** Make the next catalog call fail the way GitHub would (rate limit, signed out). */
    failNext(error: string) { failure = error; },
    importFolder(path: unknown, kind: unknown) {
      const text = String(path ?? '').trim();
      if (!text.startsWith('/')) throw new Error('Choose a folder or Markdown file.');
      const name = text.split('/').filter(Boolean).pop()!.replace(/\.md$/, '');
      const body = name.includes('setup') ? '# Setup\nInstall with `curl -fsSL https://example.com/install.sh | sh`.' : `# ${name}\nImported from ${text}.`;
      return add(kind === 'rule' ? 'rule' : 'skill', name, body, { kind: 'folder', location: text, gitRef: null, commit: null });
    },
    importGithub(repo: unknown, path: unknown, gitRef: unknown, kind: unknown) {
      const name = String(repo ?? '').trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Enter the repository as owner/name.');
      const inner = String(path ?? '').replace(/^\/|\/$/g, '');
      return add(kind === 'rule' ? 'rule' : 'skill', inner.split('/').pop() || name.split('/')[1], `# ${inner || name}\nFrom GitHub.`, { kind: 'github', location: inner ? `${name}/${inner}` : name, gitRef: (gitRef as string) || null, commit: 'a1b2c3d4e5f6' });
    },
    activate(id: unknown, harness: unknown, scope: unknown, projectId: unknown, acknowledge: unknown) {
      const entry = find(id);
      const h = String(harness), s = scope as SkillScope;
      if (!FILES.includes(h) && !PROMPT.has(h)) throw new Error('Unknown harness.');
      if (s === 'project' && !projectId) throw new Error('Choose a project for project scope.');
      if (entry.item.findings.length && entry.item.acknowledged !== entry.item.sha256) {
        if (!acknowledge) throw new Error(`Review the ${entry.item.findings.length} safety finding(s) before activating ${entry.item.name}.`);
        entry.item = { ...entry.item, acknowledged: entry.item.sha256 };
      }
      const k = key(entry.item.id, h, s);
      const previous = entry.item.activations.find(a => a.harness === h && a.scope === s);
      if (previous && previous.surface !== 'prompt' && disk.get(k) !== previous.sha256) throw new Error('That file was edited on disk; PandaCode will not overwrite it.');
      const activation: SkillActivation = { harness: h, scope: s, project: s === 'project' ? PROJECT_ROOT : null, surface: PROMPT.has(h) ? 'prompt' : entry.item.kind === 'skill' ? 'folder' : 'block', sha256: entry.item.sha256, files: [] };
      if (!PROMPT.has(h)) disk.set(k, entry.item.sha256);
      entry.item = { ...entry.item, activations: [...entry.item.activations.filter(a => a !== previous), activation] };
      return { items: list(), kept: [] };
    },
    deactivate(id: unknown, harness: unknown, scope: unknown) {
      const entry = find(id);
      const previous = entry.item.activations.find(a => a.harness === harness && a.scope === scope);
      if (!previous) throw new Error(`${entry.item.name} is not active there.`);
      const k = key(entry.item.id, String(harness), scope as SkillScope);
      const kept = previous.surface !== 'prompt' && disk.has(k) && disk.get(k) !== previous.sha256 ? [cell(entry, String(harness), scope as SkillScope).surface] : [];
      if (!kept.length) disk.delete(k);
      entry.item = { ...entry.item, activations: entry.item.activations.filter(a => a !== previous) };
      return { items: list(), kept };
    },
    scan(id: unknown) { return find(id).item.findings; },
    remove(id: unknown) {
      const entry = find(id);
      if (entry.item.activations.length) throw new Error(`Turn ${entry.item.name} off everywhere before removing it.`);
      entries.delete(entry.item.id);
      return list();
    },
    matrix(projectId: unknown): SkillMatrix {
      const scopes: SkillScope[] = projectId ? ['user', 'project'] : ['user'];
      const all = [...entries.values()];
      const used = new Set(all.flatMap(e => e.item.activations.map(a => a.harness)));
      const harnesses = [...FILES, ...[...PROMPT].filter(h => used.has(h))].map(harness => ({
        harness, installed: FILES.includes(harness), prompt: PROMPT.has(harness),
        cells: scopes.flatMap(scope => all.map(entry => cell(entry, harness, scope))),
        unmanaged: harness === 'claude' ? [{ scope: 'user' as const, kind: 'skill' as const, path: '~/.claude/skills/pdf-tools', detail: 'Not in the library.' }] : [],
      }));
      return { project: projectId ? PROJECT_ROOT : null, harnesses };
    },
    /** One entry point for `invoke` in src/preview.ts. */
    call(command: string, args: Record<string, any>): unknown {
      switch (command) {
        case 'skills_list': return list();
        case 'skills_import_folder': return this.importFolder(args.path, args.kind);
        case 'skills_import_github': return this.importGithub(args.repo, args.path, args.gitRef, args.kind);
        case 'skills_activate': return this.activate(args.id, args.harness, args.scope, args.projectId, args.acknowledge);
        case 'skills_deactivate': return this.deactivate(args.id, args.harness, args.scope);
        case 'skills_matrix': return this.matrix(args.projectId);
        case 'skills_scan': return this.scan(args.id);
        case 'skills_remove': return this.remove(args.id);
        case 'skills_catalogs': return catalogs();
        case 'skills_catalog_add': return addCatalog(args.repo, args.gitRef);
        case 'skills_catalog_refresh': { failIfAsked(); const source = findSource(args.repo); if (source.state === 'ignored') throw new Error(`${source.repo} is ignored. Stop ignoring it to refresh.`); upsert({ ...scanned(source.repo, source.origin, source.gitRef), state: source.state }); return catalogs(); }
        case 'skills_catalog_state': { const source = findSource(args.repo); upsert({ ...source, state: args.state }); return catalogs(); }
        case 'skills_catalog_import': return importCatalog(args.repo, args.paths);
        case 'skills_discover': return discover();
        default: throw new Error(`Unknown preview command: ${command}`);
      }
    },
  };
}
