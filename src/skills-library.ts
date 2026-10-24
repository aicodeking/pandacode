/* Settings → Skills & rules (issues #15 and #45): the library, imports, where each item is
 * active per harness and scope, the drift matrix and safety findings. Everything is native
 * (`skills_*` commands in src-tauri/src/skills.rs); this view only draws and asks. */
import './skills-library.css';
import { escape } from './dom';

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
export type SkillsLibraryHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Projects offered for project scope. */
  projects?(): { id: string; name: string }[];
};

const HARNESS_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', glm: 'GLM', mimo: 'MiMo', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo', omp: 'OMP', pi: 'Pi', muse: 'Muse Code' };
const harnessName = (id: string) => HARNESS_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const FINDING_LABELS: Record<SkillFinding['rule'], string> = { secret: 'Secret-shaped value', approvals: 'Turns off approvals or the sandbox', 'pipe-to-shell': 'Download piped into a shell' };
const STATUS_LABELS: Record<SkillCell['status'], string> = { active: 'Active', outdated: 'Older version', drifted: 'Edited on disk', missing: 'Missing on disk', prompt: 'Via prompt', off: '—' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountSkillsLibrary(host: HTMLElement, options: SkillsLibraryHost): () => void {
  let items: SkillItem[] = [];
  let matrix: SkillMatrix = { project: null, harnesses: [] };
  let projectId = '';
  let source: 'folder' | 'github' = 'folder';
  let pending: { id: string; harness: string; scope: SkillScope } | null = null;
  let note = '', error = '', busy = false, disposed = false, clearFields = false;
  const projects = () => options.projects?.() ?? [];
  const scopeArgs = (scope: SkillScope) => scope === 'project' ? { projectId } : {};

  async function refresh(): Promise<void> {
    try {
      [items, matrix] = await Promise.all([
        options.call<SkillItem[]>('skills_list'),
        options.call<SkillMatrix>('skills_matrix', projectId ? { projectId } : {}),
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
      const label = `${harnessName(row.harness)} · ${scope === 'user' ? 'User' : 'Project'}`;
      return `<label class="skills-toggle"><input type="checkbox" data-harness="${escape(row.harness)}" data-scope="${scope}" ${active(item, row.harness, scope) ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${escape(`${item.name}: ${label}`)}"><span>${escape(label)}</span></label>`;
    })).join('');
    const findings = item.findings.length ? `<ul class="skills-findings" aria-label="${escape(`Safety findings for ${item.name}`)}">${item.findings.map(f =>
      `<li><strong>${escape(FINDING_LABELS[f.rule])}</strong> <span>${escape(f.file)}:${f.line}</span><code>${escape(f.excerpt)}</code></li>`).join('')}</ul>` : '';
    const confirm = pending?.id === item.id ? `<div class="skills-confirm" role="alert"><span>${escape(`${item.name} has ${item.findings.length} safety finding${item.findings.length === 1 ? '' : 's'}. Activate it for ${harnessName(pending.harness)} anyway?`)}</span><button type="button" class="secondary-button" data-action="acknowledge">Activate anyway</button><button type="button" class="secondary-button" data-action="cancel">Cancel</button></div>` : '';
    return `<li class="skills-item" data-id="${escape(item.id)}">
      <div class="skills-item-head"><div><strong>${escape(item.name)}</strong><span class="skills-kind">${item.kind === 'rule' ? 'Rule' : 'Skill'}</span><small>${escape(item.description)}</small><small class="skills-source">${escape(from)}</small></div>
        <button type="button" class="secondary-button" data-action="remove" aria-label="${escape(`Remove ${item.name}`)}" ${busy ? 'disabled' : ''}>Remove</button></div>
      ${findings}${confirm}<div class="skills-toggles">${toggles}</div></li>`;
  }

  function matrixHtml(): string {
    const rows = matrix.harnesses;
    if (!rows.length || !items.length) return '<p class="skills-empty">No installed harness found yet, or nothing in the library.</p>';
    const columns = rows.flatMap(row => scopes().map(scope => ({ row, scope })));
    const head = columns.map(({ row, scope }) => `<th scope="col">${escape(harnessName(row.harness))}<small>${scope === 'user' ? 'User' : 'Project'}${row.prompt ? ' · prompt' : ''}</small></th>`).join('');
    const body = items.map(item => `<tr><th scope="row">${escape(item.name)}</th>${columns.map(({ row, scope }) => {
      const cell = row.cells.find(c => c.id === item.id && c.scope === scope);
      const status = cell?.status ?? 'off';
      return `<td class="skills-status" data-status="${status}" title="${escape(cell?.surface ?? '')}">${STATUS_LABELS[status]}</td>`;
    }).join('')}</tr>`).join('');
    const unmanaged = rows.flatMap(row => row.unmanaged.map(u => `<li><strong>${escape(harnessName(row.harness))}</strong> <code>${escape(u.path)}</code> <span>${escape(u.detail)}</span></li>`)).join('');
    const prompt = rows.some(row => row.prompt) ? '<p class="skills-note">Harnesses marked “prompt” have no skill files; PandaCode adds these items to their messages.</p>' : '';
    return `<div class="skills-matrix-wrap"><table class="skills-matrix" aria-label="Skills by harness"><thead><tr><th scope="col">Item</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${prompt}
      ${unmanaged ? `<h4 class="skills-subheading">Found on disk, not managed by PandaCode</h4><ul class="skills-unmanaged">${unmanaged}</ul>` : ''}`;
  }

  function draw(): void {
    const list = projects();
    const values = clearFields ? {} : Object.fromEntries([...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.skills-import [name]')].map(field => [field.name, field.value]));
    host.innerHTML = `<div class="settings-group skills-library" aria-label="Skills and rules">
      <form class="skills-import" aria-label="Import a skill or rule" novalidate>
        <div class="skills-import-row">
          <select name="kind" aria-label="Kind"><option value="skill">Skill</option><option value="rule">Rule</option></select>
          <select name="source" aria-label="Source"><option value="folder" ${source === 'folder' ? 'selected' : ''}>Local folder or file</option><option value="github" ${source === 'github' ? 'selected' : ''}>GitHub repository</option></select>
          ${list.length ? `<select name="project" aria-label="Project for project scope"><option value="">User scope only</option>${list.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : ''}
        </div>
        ${source === 'folder'
          ? '<input name="path" aria-label="Folder or file path" placeholder="/path/to/skill-folder or rule.md" spellcheck="false" autocomplete="off">'
          : '<div class="skills-import-row"><input name="repo" aria-label="Repository" placeholder="owner/name" spellcheck="false" autocomplete="off"><input name="repoPath" aria-label="Path in repository" placeholder="skills/pdf" spellcheck="false" autocomplete="off"><input name="ref" aria-label="Branch, tag or commit" placeholder="Default branch" spellcheck="false" autocomplete="off"></div>'}
        <div class="skills-import-row skills-import-actions"><p class="skills-message" role="status">${escape(busy ? 'Working…' : note)}</p><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>Import</button></div>
        <p class="skills-error" role="alert" ${error ? '' : 'hidden'}>${escape(error)}</p>
      </form>
    </div>
    <h3 class="settings-heading">Library</h3>
    ${items.length ? `<ul class="settings-group skills-list" aria-label="Library">${items.map(itemHtml).join('')}</ul>` : '<p class="skills-empty">The library is empty. Import a skill folder (with a SKILL.md) or a rule (one Markdown file).</p>'}
    <h3 class="settings-heading">By harness</h3>${matrixHtml()}`;
    for (const [name, value] of Object.entries(values)) {
      const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`.skills-import [name="${name}"]`);
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
        return change.kept.length ? `Left ${change.kept.length} edited file${change.kept.length === 1 ? '' : 's'} in place: ${change.kept.join(', ')}` : `${item.name} is off for ${harnessName(harness)}.`;
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
      return row?.prompt ? `${harnessName(harness)} has no skill files; PandaCode adds this to its messages.` : `Active for ${harnessName(harness)}.`;
    });
  }
  function importItem(form: HTMLFormElement): void {
    const data = new FormData(form);
    const kind = String(data.get('kind') ?? 'skill') as SkillKind;
    const text = (name: string) => String(data.get(name) ?? '').trim();
    if (source === 'folder' && !text('path')) { error = 'Enter a folder or file path.'; draw(); return; }
    if (source === 'github' && !text('repo')) { error = 'Enter the repository as owner/name.'; draw(); return; }
    void run(async () => {
      const item = source === 'folder'
        ? await options.call<SkillItem>('skills_import_folder', { path: text('path'), kind })
        : await options.call<SkillItem>('skills_import_github', { repo: text('repo'), path: text('repoPath'), gitRef: text('ref') || null, kind });
      clearFields = true;
      return `Imported ${item.name}.${item.findings.length ? ` ${item.findings.length} safety finding${item.findings.length === 1 ? '' : 's'} to review.` : ''}`;
    });
  }

  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const id = button.closest<HTMLElement>('.skills-item')?.dataset.id;
    if (button.dataset.action === 'remove' && id) void run(async () => { await options.call('skills_remove', { id }); return 'Removed.'; });
    if (button.dataset.action === 'acknowledge' && pending) void activate(pending.id, pending.harness, pending.scope, true);
    if (button.dataset.action === 'cancel') { pending = null; draw(); }
  };
  const onChange = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.harness) toggle(target);
    if (target instanceof HTMLSelectElement && target.name === 'source') { source = target.value as typeof source; draw(); }
    if (target instanceof HTMLSelectElement && target.name === 'project') { projectId = target.value; pending = null; void refresh(); }
  };
  const onSubmit = (event: Event) => { event.preventDefault(); importItem(event.target as HTMLFormElement); };
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
