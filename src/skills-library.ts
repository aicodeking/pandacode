/* Settings → Tools → Rules & library (issues #15 and #45): rules — import, where each is active per harness
 * and scope — plus the bot library's skills, the drift matrix and safety findings. Everything is native
 * (`skills_*` commands in src-tauri/src/skills.rs); this view only draws and asks. Skills are added in one place,
 * Skills → Add skill (which takes owner/repo, GitHub and GitLab URLs and folders): a bot library skill's 'Install for
 * agents…' opens it on the library's copy as a local folder. Bot library skills are read-only here; copies activated by
 * older builds stay where they are and show in Skills as installed skills. */
import './skills-library.css';
import { escape, icon } from './dom';
import { errorText } from './error-text';
import { infoMark } from './tooltip';
import { harnessName, requestAddSkill, SKILLS_CHANGED_EVENT, type SkillInventory } from './skill-manager-model';

export type SkillKind = 'skill' | 'rule';
export type SkillScope = 'user' | 'project';
export type SkillFinding = { rule: 'secret' | 'approvals' | 'pipe-to-shell'; file: string; line: number; excerpt: string };
export type SkillActivation = { harness: string; scope: SkillScope; project: string | null; surface: 'folder' | 'block' | 'prompt'; sha256: string; files: { path: string; sha256: string }[] };
/** `folder`: the library's own copy, an absolute path (skills only; 'Install for agents…' hands it to Add skill). */
export type SkillItem = {
  id: string; name: string; kind: SkillKind; description: string; sha256: string; importedAt: number; folder?: string;
  /** `skills`: added through Skills → Add skill → Bot library from a non-folder source (location: that source). */
  source: { kind: 'folder' | 'github' | 'skills'; location: string; gitRef: string | null; commit: string | null };
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

export const FINDING_LABELS: Record<SkillFinding['rule'], string> = { secret: 'Secret-shaped value', approvals: 'Turns off approvals or the sandbox', 'pipe-to-shell': 'Download piped into a shell' };
const STATUS_LABELS: Record<SkillCell['status'], string> = { active: 'Active', outdated: 'Older version', drifted: 'Edited on disk', missing: 'Missing on disk', prompt: 'Via prompt', off: '—' };
const listText = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const message = (error: unknown) => errorText(error);
/** The page's one line about what is on it (rules; the bot library, read-only, when it has skills) and where skills
 * are added and switched: Skills, the one place for both. */
const introText = (hasLibrary: boolean) =>
  `Import rules and turn them on per agent.${hasLibrary ? ' The bot library holds skills for bots only.' : ''} To add or switch skills, use`;
const BOT_LIBRARY_HELP = 'Skills bots can use; agents don’t see them. Add more with Skills → Add skill → Install to: Bot library. Install for agents… adds one to your agents too.';

/** Skills switched off on the Skills page (skill_manager_list), by name, with where they are off. Read for the
 * library's project (or all projects) so the two pages never contradict each other. */
export function switchedOff(inventory: SkillInventory | null, projectName: string): ReadonlyMap<string, string> {
  const off = (inventory?.skills ?? []).flatMap(skill =>
    skill.offInPandaCode ? [[skill.name, 'all projects'] as const] : inventory?.projectId && skill.offInProject ? [[skill.name, projectName || 'this project'] as const] : []);
  return new Map(off);
}
/** The 'Off in Skills' tooltip. Off doesn't mean the same for every agent: some won't load the skill, others can only
 * be asked not to use it (the Skills page's details say which). */
export const offTagTip = (where: string): string => `Off in ${where} in Settings → Tools → Skills: blocked or asked, per agent.`;
const offTagHtml = (name: string, where: string) =>
  `<button type="button" class="skills-kind skills-off" data-section="skills" title="${escape(offTagTip(where))}" aria-label="${escape(`${name} is off in ${where} in Settings → Tools → Skills`)}">Off in Skills</button>`;

export function mountSkillsLibrary(host: HTMLElement, options: SkillsLibraryHost): () => void {
  let items: SkillItem[] = [];
  let matrix: SkillMatrix = { project: null, harnesses: [] };
  let projectId = '';
  let source: 'folder' | 'github' = 'folder';
  let pending: { id: string; harness: string; scope: SkillScope } | null = null;
  /** A legacy library skill whose 'Turn off everywhere' is asking for confirmation. */
  let turningOff: string | null = null;
  let note = '', error = '', busy = false, disposed = false, clearFields = false;
  /** Names switched off on the Skills page; empty when that page's inventory can't be read. */
  let managerOff: ReadonlyMap<string, string> = new Map();
  const projects = () => options.projects?.() ?? [];
  const scopeArgs = (scope: SkillScope) => scope === 'project' ? { projectId } : {};

  /** The Skills page's switches, for the 'Off in Skills' tags. A failed read only drops the tags. */
  async function readManager(): Promise<ReadonlyMap<string, string>> {
    const name = projects().find(p => p.id === projectId)?.name ?? '';
    try {
      return switchedOff(await options.call<SkillInventory>('skill_manager_list', projectId ? { projectId } : {}), name);
    } catch {
      return new Map();
    }
  }
  async function refresh(): Promise<void> {
    try {
      [items, matrix, managerOff] = await Promise.all([
        options.call<SkillItem[]>('skills_list'),
        options.call<SkillMatrix>('skills_matrix', projectId ? { projectId } : {}),
        readManager(),
      ]);
    } catch (failure) { error = message(failure); }
    if (!disposed) draw();
  }
  const onManagerChange = () => { void readManager().then(next => { if (disposed) return; managerOff = next; draw(); }); };
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

  /** The Skills page knows a skill by its folder name; the library by its display name and slug id. */
  const offWhere = (item: SkillItem) => item.kind === 'skill' ? managerOff.get(item.name) ?? managerOff.get(item.id) : undefined;
  const offTag = (item: SkillItem): string => {
    const where = offWhere(item);
    return where ? offTagHtml(item.name, where) : '';
  };
  /** Where a library skill was activated by an older build, for its read-only line. */
  const inUse = (item: SkillItem) => listText([...new Set(item.activations.map(a => harnessName(a.harness)))]);
  /** A source path or 'GitHub · owner/repo/skill @ commit' that breaks only at its separators, never mid-name (not
   * even after a hyphen): one unbreakable part per slash, plus '@ commit' as a part of its own after a plain space; a
   * part wider than the line ellipsizes (whole in the title). */
  const wrapPath = (from: string): string => from.split(' @ ').map((piece, i) => (i ? `@ ${piece}` : piece).split(/(?<=[/\\])/)
    .map(part => `<span class="skills-source-part">${escape(part)}</span>`).join('')).join(' ');
  function itemHtml(item: SkillItem): string {
    const from = item.source.kind === 'github' ? `GitHub · ${item.source.location}${item.source.commit ? ` @ ${item.source.commit.slice(0, 7)}` : ''}` : item.source.location;
    const findings = item.findings.length ? `<ul class="skills-findings" aria-label="${escape(`Safety findings for ${item.name}`)}">${item.findings.map(f =>
      `<li><strong>${escape(FINDING_LABELS[f.rule])}</strong> <span>${escape(f.file)}:${f.line}</span><code>${escape(f.excerpt)}</code></li>`).join('')}</ul>` : '';
    return `<li class="skills-item" data-id="${escape(item.id)}"${item.kind === 'skill' ? ' data-kind="skill"' : ''}>
      <div class="skills-item-head"><div><strong>${escape(item.name)}</strong><span class="skills-kind">${item.kind === 'rule' ? 'Rule' : 'Skill'}</span>${offTag(item)}<small>${escape(item.description)}</small><small class="skills-source" title="${escape(from)}">${wrapPath(from)}</small></div>
        <div class="skills-confirm">${item.kind === 'skill' ? skillActions(item) : removeButton(item)}</div></div>
      ${findings}${item.kind === 'rule' ? ruleControls(item) : skillNote(item)}</li>`;
  }
  const removeButton = (item: SkillItem) =>
    `<button type="button" class="secondary-button" data-action="remove" aria-label="${escape(`Remove ${item.name}`)}" ${busy ? 'disabled' : ''}>Remove</button>`;
  /** A library skill: 'Install for agents…' opens Add skill on the library's copy. One still active from an older build can't be
   * removed until it is turned off everywhere (native undoes every activation it recorded), then Remove appears. */
  function skillActions(item: SkillItem): string {
    const install = item.folder ? `<button type="button" class="secondary-button" data-section="skills" data-add-skill="${escape(item.folder)}" aria-label="${escape(`Install ${item.name} for agents…`)}" ${busy ? 'disabled' : ''}>Install for agents…</button>` : '';
    const off = `<button type="button" class="secondary-button" data-action="turn-off" aria-label="${escape(`Turn ${item.name} off everywhere…`)}" ${busy || turningOff === item.id ? 'disabled' : ''}>Turn off everywhere…</button>`;
    return `${install}${item.activations.length ? off : removeButton(item)}`;
  }
  const turnOffConfirm = (item: SkillItem) => turningOff === item.id
    ? `<div class="skills-confirm" role="group" aria-label="${escape(`Turn ${item.name} off everywhere`)}"><span>${escape(`Turn ${item.name} off for ${inUse(item)} in every scope? PandaCode removes the copies it put there; files edited since stay in place.`)}</span><button type="button" class="secondary-button" data-action="turn-off-cancel">Cancel</button><button type="button" class="secondary-button" data-action="turn-off-confirm">Turn off</button></div>` : '';
  const skillNote = (item: SkillItem) => item.activations.length
    ? `<p class="skills-note">In use by ${escape(inUse(item))}. Switch it in <button type="button" class="skills-link" data-section="skills">Skills</button>, or turn it off everywhere to remove it.</p>${turnOffConfirm(item)}` : '';
  function ruleControls(item: SkillItem): string {
    const toggles = harnesses().flatMap(row => scopes().map(scope => {
      const label = `${harnessName(row.harness)} · ${scope === 'user' ? 'User' : 'Project'}`;
      return `<label class="skills-toggle"><input type="checkbox" data-harness="${escape(row.harness)}" data-scope="${scope}" ${active(item, row.harness, scope) ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${escape(`${item.name}: ${label}`)}"><span>${escape(label)}</span></label>`;
    })).join('');
    const confirm = pending?.id === item.id ? `<div class="skills-confirm" role="alert"><span>${escape(`${item.name} has ${item.findings.length} safety finding${item.findings.length === 1 ? '' : 's'}. Activate it for ${harnessName(pending.harness)} anyway?`)}</span><button type="button" class="secondary-button" data-action="acknowledge">Activate anyway</button><button type="button" class="secondary-button" data-action="cancel">Cancel</button></div>` : '';
    return `${confirm}<div class="skills-toggles">${toggles}</div>`;
  }

  /** Rules only: installed skills are listed (and switched) in Settings → Tools → Skills, never a second time here. */
  function matrixHtml(): string {
    const rows = matrix.harnesses, rules = items.filter(item => item.kind === 'rule');
    if (!rows.length || !rules.length) return '<p class="skills-empty">No installed harness found yet, or no rules in the library.</p>';
    const columns = rows.flatMap(row => scopes().map(scope => ({ row, scope })));
    const head = columns.map(({ row, scope }) => `<th scope="col">${escape(harnessName(row.harness))}<small>${scope === 'user' ? 'User' : 'Project'}${row.prompt ? ' · prompt' : ''}</small></th>`).join('');
    const body = rules.map(item => `<tr><th scope="row">${escape(item.name)}</th>${columns.map(({ row, scope }) => {
      const cell = row.cells.find(c => c.id === item.id && c.scope === scope);
      const status = cell?.status ?? 'off';
      return `<td class="skills-status" data-status="${status}" title="${escape(cell?.surface ?? '')}">${STATUS_LABELS[status]}</td>`;
    }).join('')}</tr>`).join('');
    const unmanaged = rows.flatMap(row => row.unmanaged.filter(u => u.kind === 'rule').map(u => `<li><strong>${escape(harnessName(row.harness))}</strong> <code>${escape(u.path)}</code> <span>${escape(u.detail)}</span></li>`)).join('');
    const prompt = rows.some(row => row.prompt) ? '<p class="skills-note">Harnesses marked “prompt” have no skill files; PandaCode adds these rules to their messages.</p>' : '';
    return `<div class="skills-matrix-wrap"><table class="skills-matrix" aria-label="Rules by harness"><thead><tr><th scope="col">Rule</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${prompt}
      ${unmanaged ? `<h4 class="skills-subheading">Rules found on disk, not managed by PandaCode</h4><ul class="ds-card skills-unmanaged" aria-label="Rules found on disk">${unmanaged}</ul>` : ''}`;
  }

  function draw(): void {
    const list = projects();
    const values = clearFields ? {} : Object.fromEntries([...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('form [name]')].map(field => [field.name, field.value]));
    const rules = items.filter(item => item.kind === 'rule'), library = items.filter(item => item.kind === 'skill');
    host.innerHTML = `<p class="skills-note skills-crosslink">${escape(introText(library.length > 0))} <button type="button" class="skills-link" data-section="skills">Skills</button>.</p><h3 class="settings-heading">Import a rule</h3><div class="settings-group skills-library" aria-label="Skills and rules">
      <form class="skills-import" aria-label="Import a rule" novalidate>
        <div class="skills-import-row">
          <label class="skills-field"><span>Source</span><select name="source"><option value="folder" ${source === 'folder' ? 'selected' : ''}>Local file</option><option value="github" ${source === 'github' ? 'selected' : ''}>GitHub repository</option></select></label>
          ${list.length ? `<label class="skills-field"><span>Project scope</span><select name="project"><option value="">User scope only</option>${list.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        ${source === 'folder'
          ? '<input name="path" aria-label="File path" placeholder="/path/to/rule.md" spellcheck="false" autocomplete="off">'
          : '<div class="skills-import-row"><input name="repo" aria-label="Repository" placeholder="owner/name" spellcheck="false" autocomplete="off"><input name="repoPath" aria-label="Path in repository" placeholder="rules/no-force-push.md" spellcheck="false" autocomplete="off"><input name="ref" aria-label="Branch, tag or commit" placeholder="Default branch" spellcheck="false" autocomplete="off"></div>'}
        <div class="skills-import-row skills-import-actions"><p class="skills-message" role="status">${escape(busy ? 'Working…' : note)}</p><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>Import</button></div>
        ${error ? `<div class="message-error error-row skills-error-row"><div class="error-row-head"><span class="error-row-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="error-row-summary skills-error" role="alert">${escape(error)}</span><button type="button" class="error-row-button error-row-dismiss" data-dismiss-error aria-label="Dismiss error">${icon('close')}</button></div></div>` : ''}
      </form>
    </div>
    <h3 class="settings-heading">Rules</h3>
    ${rules.length ? `<ul class="settings-group skills-list" aria-label="Rules">${rules.map(itemHtml).join('')}</ul>` : '<p class="skills-empty">No rules yet. Import one above: a single Markdown file.</p>'}
    ${library.length ? `<div class="settings-heading"><h3>Bot library</h3>${infoMark(BOT_LIBRARY_HELP, 'About the bot library')}<span class="sr-only">${BOT_LIBRARY_HELP}</span></div>
    <ul class="settings-group skills-list" aria-label="Bot library">${library.map(itemHtml).join('')}</ul>` : ''}
    <h3 class="settings-heading">By harness</h3>${matrixHtml()}`;
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
    // Skills come in through Skills → Add skill; this form imports rules only.
    const kind: SkillKind = 'rule';
    const text = (name: string) => String(data.get(name) ?? '').trim();
    if (source === 'folder' && !text('path')) { error = 'Enter the rule file’s path.'; draw(); return; }
    if (source === 'github' && !text('repo')) { error = 'Enter the repository as owner/name.'; draw(); return; }
    void run(async () => {
      const item = source === 'folder'
        ? await options.call<SkillItem>('skills_import_folder', { path: text('path'), kind })
        : await options.call<SkillItem>('skills_import_github', { repo: text('repo'), path: text('repoPath'), gitRef: text('ref') || null, kind });
      clearFields = true;
      return `Imported ${item.name}.${item.findings.length ? ` ${item.findings.length} safety finding${item.findings.length === 1 ? '' : 's'} to review.` : ''}`;
    });
  }

  /** Legacy activations (made by older builds): native undoes each where it recorded it; Remove then appears. */
  function turnOffEverywhere(id: string): void {
    const item = items.find(entry => entry.id === id);
    turningOff = null;
    void run(async () => {
      const change = await options.call<{ kept?: string[] }>('skills_deactivate_all', { id });
      const kept = change.kept ?? [];
      return kept.length
        ? `${item?.name ?? 'The skill'} is off everywhere. Left ${kept.length} edited file${kept.length === 1 ? '' : 's'} in place: ${kept.join(', ')}`
        : `${item?.name ?? 'The skill'} is off everywhere. You can remove it now.`;
    });
  }
  const onClick = (event: Event) => {
    // Settings' own handler then opens the Skills page (data-section), which opens Add skill on the source given.
    const add = (event.target as HTMLElement).closest<HTMLElement>('[data-add-skill]');
    if (add) { requestAddSkill(add.dataset.addSkill ?? ''); return; }
    if ((event.target as HTMLElement).closest('[data-dismiss-error]')) { error = ''; draw(); host.querySelector<HTMLElement>('.skills-import [type=submit]')?.focus(); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const id = button.closest<HTMLElement>('.skills-item')?.dataset.id;
    if (button.dataset.action === 'remove' && id) void run(async () => { await options.call('skills_remove', { id }); return 'Removed.'; });
    if (button.dataset.action === 'acknowledge' && pending) void activate(pending.id, pending.harness, pending.scope, true);
    if (button.dataset.action === 'cancel') { pending = null; draw(); }
    if (button.dataset.action === 'turn-off' && id) { turningOff = id; draw(); host.querySelector<HTMLButtonElement>('[data-action="turn-off-confirm"]')?.focus(); }
    if (button.dataset.action === 'turn-off-cancel') { turningOff = null; draw(); }
    if (button.dataset.action === 'turn-off-confirm' && turningOff) turnOffEverywhere(turningOff);
  };
  const onChange = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.harness) toggle(target);
    if (target instanceof HTMLSelectElement && target.name === 'source') { source = target.value as typeof source; draw(); }
    if (target instanceof HTMLSelectElement && target.name === 'project') { projectId = target.value; pending = null; void refresh(); }
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    importItem(event.target as HTMLFormElement);
  };
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('submit', onSubmit);
  window.addEventListener(SKILLS_CHANGED_EVENT, onManagerChange);
  draw();
  void refresh();
  return () => {
    disposed = true;
    host.removeEventListener('click', onClick);
    host.removeEventListener('change', onChange);
    host.removeEventListener('submit', onSubmit);
    window.removeEventListener(SKILLS_CHANGED_EVENT, onManagerChange);
  };
}
