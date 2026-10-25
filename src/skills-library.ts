/* Settings → Skills & rules (issues #15 and #45): the library, imports, where each item is
 * active per harness and scope, the drift matrix and safety findings. Everything is native
 * (`skills_*` commands in src-tauri/src/skills.rs); this view only draws and asks. Catalogs
 * (#114, #115) index GitHub repositories of skills; importing from one never activates. */
import './skills-library.css';
import { escape } from './dom';
import { t } from './i18n.ts';

export type SkillKind = 'skill' | 'rule';
export type SkillScope = 'user' | 'project';
export type SkillFinding = { rule: 'secret' | 'approvals' | 'pipe-to-shell'; file: string; line: number; excerpt: string };
export type SkillActivation = { harness: string; scope: SkillScope; project: string | null; surface: 'folder' | 'block' | 'prompt'; sha256: string; files: { path: string; sha256: string }[] };
export type SkillItem = {
  id: string; name: string; kind: SkillKind; description: string; sha256: string; importedAt: number;
  source: { kind: 'folder' | 'github'; location: string; gitRef: string | null; commit: string | null };
  acknowledged: string | null; activations: SkillActivation[]; files: string[]; findings: SkillFinding[];
};
export type SkillCell = { id: string; scope: SkillScope; status: 'active' | 'outdated' | 'drifted' | 'missing' | 'prompt' | 'off'; surface: string };
export type SkillMatrix = {
  project: string | null;
  harnesses: { harness: string; installed: boolean; prompt: boolean; cells: SkillCell[]; unmanaged: { scope: SkillScope; kind: SkillKind; path: string; detail: string }[] }[];
};
export type CatalogSkill = { path: string; id: string; name: string; description: string; files: number; bytes: number; imported: string | null; conflicts: string[] };
export type CatalogSource = {
  repo: string; gitRef: string | null; commit: string | null; origin: 'manual' | 'discovered'; state: 'enabled' | 'disabled' | 'ignored';
  private: boolean; pushedAt: string | null; scannedAt: number; skills: CatalogSkill[];
};
export type SkillCatalogs = { sources: CatalogSource[]; discovery: { at: number; checked: number; registered: string[]; failures: string[]; note: string | null } | null };
export type CatalogImport = { items: SkillItem[]; imported: string[]; skipped: { path: string; name: string; reason: string }[] };
export type SkillsLibraryHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Projects offered for project scope. */
  projects?(): { id: string; name: string }[];
};

const HARNESS_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', glm: 'GLM', mimo: 'MiMo', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo', omp: 'OMP', pi: 'Pi', muse: 'Muse Code', zcode: 'ZCode' };
const harnessName = (id: string) => HARNESS_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const FINDING_LABELS: Record<SkillFinding['rule'], string> = { secret: t('Secret-shaped value'), approvals: t('Turns off approvals or the sandbox'), 'pipe-to-shell': t('Download piped into a shell') };
const STATUS_LABELS: Record<SkillCell['status'], string> = { active: t('Active'), outdated: t('Older version'), drifted: t('Edited on disk'), missing: t('Missing on disk'), prompt: t('Via prompt'), off: '—' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const files = (count: number) => count === 1 ? t('1 file') : t`${count} files`;
const skills = (count: number) => count === 1 ? t('1 skill') : t`${count} skills`;

export function mountSkillsLibrary(host: HTMLElement, options: SkillsLibraryHost): () => void {
  let items: SkillItem[] = [];
  let matrix: SkillMatrix = { project: null, harnesses: [] };
  let catalogs: SkillCatalogs = { sources: [], discovery: null };
  /** Catalog skills chosen for import, as `repo\npath`. */
  let selected = new Set<string>();
  let projectId = '';
  let source: 'folder' | 'github' = 'folder';
  let pending: { id: string; harness: string; scope: SkillScope } | null = null;
  let note = '', error = '', busy = false, disposed = false, clearFields = false;
  const projects = () => options.projects?.() ?? [];
  const scopeArgs = (scope: SkillScope) => scope === 'project' ? { projectId } : {};

  async function refresh(): Promise<void> {
    try {
      [items, matrix, catalogs] = await Promise.all([
        options.call<SkillItem[]>('skills_list'),
        options.call<SkillMatrix>('skills_matrix', projectId ? { projectId } : {}),
        options.call<SkillCatalogs>('skills_catalogs'),
      ]);
    } catch (failure) { error = message(failure); }
    if (!disposed) draw();
  }
  async function run(work: () => Promise<string | void>): Promise<void> {
    busy = true; error = ''; note = ''; draw();
    try { note = (await work()) ?? ''; } catch (failure) { error = message(failure); }
    busy = false;
    if (!disposed) await refresh();
  }

  /** Harnesses with toggles: the file-based ones, plus any already used through the prompt. */
  const harnesses = () => {
    const ids = new Set(['claude', 'codex', ...matrix.harnesses.map(row => row.harness)]);
    return [...ids].map(id => matrix.harnesses.find(row => row.harness === id) ?? { harness: id, installed: false, prompt: false, cells: [], unmanaged: [] });
  };
  const scopes = (): SkillScope[] => projectId ? ['user', 'project'] : ['user'];
  const active = (item: SkillItem, harness: string, scope: SkillScope) =>
    item.activations.some(a => a.harness === harness && a.scope === scope && (scope === 'user' || a.project === matrix.project));

  function itemHtml(item: SkillItem): string {
    const from = item.source.kind === 'github' ? `GitHub · ${item.source.location}${item.source.commit ? ` @ ${item.source.commit.slice(0, 7)}` : ''}` : item.source.location;
    const toggles = harnesses().flatMap(row => scopes().map(scope => {
      const label = `${harnessName(row.harness)} · ${scope === 'user' ? t('User') : t('Project')}`;
      return `<label class="skills-toggle"><input type="checkbox" data-harness="${escape(row.harness)}" data-scope="${scope}" ${active(item, row.harness, scope) ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${escape(t`${item.name}: ${label}`)}"><span>${escape(label)}</span></label>`;
    })).join('');
    const findings = item.findings.length ? `<ul class="skills-findings" aria-label="${escape(t`Safety findings for ${item.name}`)}">${item.findings.map(f =>
      `<li><strong>${escape(FINDING_LABELS[f.rule])}</strong> <span>${escape(f.file)}:${f.line}</span><code>${escape(f.excerpt)}</code></li>`).join('')}</ul>` : '';
    const confirm = pending?.id === item.id ? `<div class="skills-confirm" role="alert"><span>${escape(item.findings.length === 1 ? t`${item.name} has 1 safety finding. Activate it for ${harnessName(pending.harness)} anyway?` : t`${item.name} has ${item.findings.length} safety findings. Activate it for ${harnessName(pending.harness)} anyway?`)}</span><button type="button" class="secondary-button" data-action="acknowledge">${t('Activate anyway')}</button><button type="button" class="secondary-button" data-action="cancel">${t('Cancel')}</button></div>` : '';
    return `<li class="skills-item" data-id="${escape(item.id)}">
      <div class="skills-item-head"><div><strong>${escape(item.name)}</strong><span class="skills-kind">${item.kind === 'rule' ? t('Rule') : t('Skill')}</span><small>${escape(item.description)}</small><small class="skills-source">${escape(from)}</small></div>
        <button type="button" class="secondary-button" data-action="remove" aria-label="${escape(t`Remove ${item.name}`)}" ${busy ? 'disabled' : ''}>${t('Remove')}</button></div>
      ${findings}${confirm}<div class="skills-toggles">${toggles}</div></li>`;
  }

  function matrixHtml(): string {
    const rows = matrix.harnesses;
    if (!rows.length || !items.length) return `<p class="skills-empty">${t('No installed harness found yet, or nothing in the library.')}</p>`;
    const columns = rows.flatMap(row => scopes().map(scope => ({ row, scope })));
    const head = columns.map(({ row, scope }) => `<th scope="col">${escape(harnessName(row.harness))}<small>${scope === 'user' ? t('User') : t('Project')}${row.prompt ? t(' · prompt') : ''}</small></th>`).join('');
    const body = items.map(item => `<tr><th scope="row">${escape(item.name)}</th>${columns.map(({ row, scope }) => {
      const cell = row.cells.find(c => c.id === item.id && c.scope === scope);
      const status = cell?.status ?? 'off';
      return `<td class="skills-status" data-status="${status}" title="${escape(cell?.surface ?? '')}">${STATUS_LABELS[status]}</td>`;
    }).join('')}</tr>`).join('');
    const unmanaged = rows.flatMap(row => row.unmanaged.map(u => `<li><strong>${escape(harnessName(row.harness))}</strong> <code>${escape(u.path)}</code> <span>${escape(u.detail)}</span></li>`)).join('');
    const prompt = rows.some(row => row.prompt) ? `<p class="skills-note">${t('Harnesses marked “prompt” have no skill files; PandaCode adds these items to their messages.')}</p>` : '';
    return `<div class="skills-matrix-wrap"><table class="skills-matrix" aria-label="${t('Skills by harness')}"><thead><tr><th scope="col">${t('Item')}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${prompt}
      ${unmanaged ? `<h4 class="skills-subheading">${t('Found on disk, not managed by PandaCode')}</h4><ul class="skills-unmanaged">${unmanaged}</ul>` : ''}`;
  }

  function catalogSkillHtml(source: CatalogSource, skill: CatalogSkill): string {
    const key = `${source.repo}\n${skill.path}`;
    const library = skill.imported ? `<small>${skill.imported === source.commit ? t('In the library') : t`In the library @ ${escape(skill.imported.slice(0, 7))}; a newer version is upstream`}</small>` : '';
    const conflict = skill.conflicts.length ? `<small class="skills-conflict">${t`Same name in ${skill.conflicts.map(escape).join(', ')}`}</small>` : '';
    return `<li class="skills-catalog-skill"><label class="skills-toggle"><input type="checkbox" data-select="${escape(key)}" ${selected.has(key) ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${escape(t`Select ${skill.name} from ${source.repo}`)}"><span><strong>${escape(skill.name)}</strong> <code>${escape(skill.path || 'root')}</code> · ${files(skill.files)}</span></label>
      <small>${escape(skill.description)}</small>${library}${conflict}</li>`;
  }
  function sourceHtml(source: CatalogSource): string {
    const enabled = source.state === 'enabled';
    const repo = escape(source.repo);
    const tags = [source.origin === 'discovered' ? t('Discovered') : t('Added'), source.private ? t('Private') : '', enabled ? '' : t('Disabled')].filter(Boolean).map(tag => `<span class="skills-kind">${tag}</span>`).join('');
    const at = source.commit ? ` @ ${escape(source.commit.slice(0, 7))}${source.gitRef ? ` (${escape(source.gitRef)})` : ''}` : '';
    const button = (action: string, label: string, extra = '', name = t`${label} ${source.repo}`) =>
      `<button type="button" class="secondary-button" data-action="${action}" data-repo="${repo}" ${extra} aria-label="${escape(name)}" ${busy ? 'disabled' : ''}>${label}</button>`;
    const body = enabled ? `<ul class="skills-catalog-skills" aria-label="${escape(t`Skills in ${source.repo}`)}">${source.skills.map(skill => catalogSkillHtml(source, skill)).join('')}</ul>
      <div class="skills-confirm">${button('catalog-import', t('Import selected'), '', t`Import selected from ${source.repo}`)}${button('catalog-import-all', t('Import all'), '', t`Import all from ${source.repo}`)}</div>` : '';
    return `<li class="skills-item skills-catalog" data-repo="${repo}">
      <div class="skills-item-head"><div><strong>${repo}</strong>${tags}<small>${skills(source.skills.length)}${at}</small></div>
        <div class="skills-confirm">${button('catalog-refresh', t('Refresh'))}${enabled ? button('catalog-state', t('Disable'), 'data-state="disabled"') : button('catalog-state', t('Enable'), 'data-state="enabled"')}${button('catalog-state', t('Ignore'), 'data-state="ignored"')}</div></div>
      ${body}</li>`;
  }
  function catalogsHtml(): string {
    const shown = catalogs.sources.filter(s => s.state !== 'ignored');
    const ignored = catalogs.sources.filter(s => s.state === 'ignored');
    const found = catalogs.discovery;
    const summary = found ? `<p class="skills-note">${found.checked === 1 ? t`Checked ${found.checked} repository you own.` : t`Checked ${found.checked} repositories you own.`}${found.failures.length ? t` Could not read ${found.failures.map(escape).join('; ')}.` : ''}${found.note ? ` ${escape(found.note)}` : ''}</p>` : '';
    return `<div class="settings-group">
      <form class="skills-import skills-catalog-add" aria-label="${t('Add a skill catalog')}" novalidate>
        <div class="skills-import-row"><input name="catalogRepo" aria-label="${t('Catalog repository')}" placeholder="owner/name" spellcheck="false" autocomplete="off"><input name="catalogRef" aria-label="${t('Catalog branch, tag or commit')}" placeholder="${t('Default branch')}" spellcheck="false" autocomplete="off"><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>${t('Scan')}</button></div>
        <div class="skills-import-row skills-import-actions"><p class="skills-message">${t('Catalogs list skills; nothing is turned on until you choose a harness.')}</p><button type="button" class="secondary-button" data-action="discover" ${busy ? 'disabled' : ''}>${t('Find my skill repositories')}</button></div>
      </form>
    </div>${summary}
    ${shown.length ? `<ul class="settings-group skills-list" aria-label="${t('Catalog sources')}">${shown.map(sourceHtml).join('')}</ul>` : `<p class="skills-empty">${t('No catalogs yet. Scan a repository, or find the skill repositories in your GitHub account.')}</p>`}
    ${ignored.length ? `<ul class="skills-unmanaged" aria-label="${t('Ignored sources')}">${ignored.map(s => `<li><code>${escape(s.repo)}</code> <button type="button" class="secondary-button" data-action="catalog-state" data-state="enabled" data-repo="${escape(s.repo)}" aria-label="${escape(t`Stop ignoring ${s.repo}`)}" ${busy ? 'disabled' : ''}>${t('Stop ignoring')}</button></li>`).join('')}</ul>` : ''}`;
  }

  function draw(): void {
    const list = projects();
    const values = clearFields ? {} : Object.fromEntries([...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('form [name]')].map(field => [field.name, field.value]));
    host.innerHTML = `<div class="settings-group skills-library" aria-label="${t('Skills and rules')}">
      <form class="skills-import" aria-label="${t('Import a skill or rule')}" novalidate>
        <div class="skills-import-row">
          <select name="kind" aria-label="${t('Kind')}"><option value="skill">${t('Skill')}</option><option value="rule">${t('Rule')}</option></select>
          <select name="source" aria-label="${t('Source')}"><option value="folder" ${source === 'folder' ? 'selected' : ''}>${t('Local folder or file')}</option><option value="github" ${source === 'github' ? 'selected' : ''}>${t('GitHub repository')}</option></select>
          ${list.length ? `<select name="project" aria-label="${t('Project for project scope')}"><option value="">${t('User scope only')}</option>${list.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : ''}
        </div>
        ${source === 'folder'
          ? `<input name="path" aria-label="${t('Folder or file path')}" placeholder="/path/to/skill-folder or rule.md" spellcheck="false" autocomplete="off">`
          : `<div class="skills-import-row"><input name="repo" aria-label="${t('Repository')}" placeholder="owner/name" spellcheck="false" autocomplete="off"><input name="repoPath" aria-label="${t('Path in repository')}" placeholder="skills/pdf" spellcheck="false" autocomplete="off"><input name="ref" aria-label="${t('Branch, tag or commit')}" placeholder="${t('Default branch')}" spellcheck="false" autocomplete="off"></div>`}
        <div class="skills-import-row skills-import-actions"><p class="skills-message" role="status">${escape(busy ? t('Working…') : note)}</p><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>${t('Import')}</button></div>
        <p class="skills-error" role="alert" ${error ? '' : 'hidden'}>${escape(error)}</p>
      </form>
    </div>
    <h3 class="settings-heading">${t('Catalogs')}</h3>${catalogsHtml()}
    <h3 class="settings-heading">${t('Library')}</h3>
    ${items.length ? `<ul class="settings-group skills-list" aria-label="${t('Library')}">${items.map(itemHtml).join('')}</ul>` : `<p class="skills-empty">${t('The library is empty. Import a skill folder (with a SKILL.md) or a rule (one Markdown file).')}</p>`}
    <h3 class="settings-heading">${t('By harness')}</h3>${matrixHtml()}`;
    for (const [name, value] of Object.entries(values)) {
      const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`form [name="${name}"]`);
      if (field && name !== 'source' && name !== 'project') field.value = value;
    }
    clearFields = false;
  }

  function toggle(input: HTMLInputElement): void {
    const id = input.closest<HTMLElement>('.skills-item')!.dataset.id!;
    const { harness, scope } = input.dataset as { harness: string; scope: SkillScope };
    const item = items.find(entry => entry.id === id)!;
    if (!input.checked) {
      void run(async () => {
        const change = await options.call<{ kept: string[] }>('skills_deactivate', { id, harness, scope, ...scopeArgs(scope) });
        return change.kept.length === 1 ? t`Left 1 edited file in place: ${change.kept.join(', ')}` : change.kept.length ? t`Left ${change.kept.length} edited files in place: ${change.kept.join(', ')}` : t`${item.name} is off for ${harnessName(harness)}.`;
      });
      return;
    }
    if (item.findings.length && item.acknowledged !== item.sha256) {
      input.checked = false; pending = { id, harness, scope }; draw(); return;
    }
    void activate(id, harness, scope, false);
  }
  function activate(id: string, harness: string, scope: SkillScope, acknowledge: boolean): Promise<void> {
    pending = null;
    return run(async () => {
      await options.call('skills_activate', { id, harness, scope, ...scopeArgs(scope), acknowledge });
      const row = matrix.harnesses.find(r => r.harness === harness);
      return row?.prompt ? t`${harnessName(harness)} has no skill files; PandaCode adds this to its messages.` : t`Active for ${harnessName(harness)}.`;
    });
  }
  function importItem(form: HTMLFormElement): void {
    const data = new FormData(form);
    const kind = String(data.get('kind') ?? 'skill') as SkillKind;
    const text = (name: string) => String(data.get(name) ?? '').trim();
    if (source === 'folder' && !text('path')) { error = t('Enter a folder or file path.'); draw(); return; }
    if (source === 'github' && !text('repo')) { error = t('Enter the repository as owner/name.'); draw(); return; }
    void run(async () => {
      const item = source === 'folder'
        ? await options.call<SkillItem>('skills_import_folder', { path: text('path'), kind })
        : await options.call<SkillItem>('skills_import_github', { repo: text('repo'), path: text('repoPath'), gitRef: text('ref') || null, kind });
      clearFields = true;
      return item.findings.length === 1 ? t`Imported ${item.name}. 1 safety finding to review.` : item.findings.length ? t`Imported ${item.name}. ${item.findings.length} safety findings to review.` : t`Imported ${item.name}.`;
    });
  }

  function addCatalog(form: HTMLFormElement): void {
    const data = new FormData(form);
    const repo = String(data.get('catalogRepo') ?? '').trim();
    if (!repo) { error = t('Enter the repository as owner/name.'); draw(); return; }
    void run(async () => {
      catalogs = await options.call<SkillCatalogs>('skills_catalog_add', { repo, gitRef: String(data.get('catalogRef') ?? '').trim() || null });
      clearFields = true;
      const source = catalogs.sources.find(s => s.repo.toLowerCase() === repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase());
      return t`Found ${skills(source?.skills.length ?? 0)} in ${source?.repo ?? repo}.`;
    });
  }
  function catalogAction(action: string, repo: string, state?: string): void {
    if (action === 'catalog-refresh') void run(async () => { await options.call('skills_catalog_refresh', { repo }); return t`Refreshed ${repo}. Library copies stay as imported.`; });
    if (action === 'catalog-state' && state) void run(async () => {
      await options.call('skills_catalog_state', { repo, state });
      return state === 'ignored' ? t`Ignoring ${repo}. Discovery will not add it again.` : state === 'disabled' ? t`${repo} is disabled.` : t`${repo} is enabled.`;
    });
    if (action === 'catalog-import' || action === 'catalog-import-all') {
      const prefix = `${repo}\n`;
      const paths = action === 'catalog-import' ? [...selected].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)) : null;
      if (paths && !paths.length) { error = t('Select skills to import, or choose Import all.'); draw(); return; }
      void run(async () => {
        const result = await options.call<CatalogImport>('skills_catalog_import', { repo, paths });
        selected = new Set([...selected].filter(key => !key.startsWith(prefix)));
        const skipped = result.skipped.length ? t` Skipped ${result.skipped.length}: ${result.skipped.map(s => s.reason).join(' ')}` : '';
        return t`Imported ${skills(result.imported.length)}.${skipped} Nothing is active until you turn it on.`;
      });
    }
  }

  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'discover') {
      void run(async () => {
        const found = (await options.call<SkillCatalogs>('skills_discover')).discovery;
        return found?.registered.length ? t`Added ${found.registered.join(', ')}.` : t('No new skill repositories found.');
      });
      return;
    }
    if (button.dataset.repo) { catalogAction(button.dataset.action!, button.dataset.repo, button.dataset.state); return; }
    const id = button.closest<HTMLElement>('.skills-item')?.dataset.id;
    if (button.dataset.action === 'remove' && id) void run(async () => { await options.call('skills_remove', { id }); return t('Removed.'); });
    if (button.dataset.action === 'acknowledge' && pending) void activate(pending.id, pending.harness, pending.scope, true);
    if (button.dataset.action === 'cancel') { pending = null; draw(); }
  };
  const onChange = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.harness) toggle(target);
    if (target instanceof HTMLInputElement && target.dataset.select) {
      const key = target.dataset.select;
      selected = target.checked ? new Set([...selected, key]) : new Set([...selected].filter(k => k !== key));
    }
    if (target instanceof HTMLSelectElement && target.name === 'source') { source = target.value as typeof source; draw(); }
    if (target instanceof HTMLSelectElement && target.name === 'project') { projectId = target.value; pending = null; void refresh(); }
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (form.classList.contains('skills-catalog-add')) addCatalog(form); else importItem(form);
  };
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('submit', onSubmit);
  draw();
  void refresh();
  return () => {
    disposed = true;
    host.removeEventListener('click', onClick);
    host.removeEventListener('change', onChange);
    host.removeEventListener('submit', onSubmit);
  };
}
