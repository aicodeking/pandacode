/* Add skill: the one place to add skills. Preview a source with the `skills` CLI (skills.sh): a repository, a
 * GitHub/GitLab URL, a skills.sh link, or a folder on this computer ('Choose folder…'); pick skills, scope and
 * agents, install. Opens in the app's `#dialog` (plate and motion from installDialogMotion). Nothing runs until
 * the user asks. */
import { escape, icon, isImeKey } from './dom';
import { flagHtml } from './skill-manager-view';
import { addedNote, APP_MISSING, BOT_LIBRARY, coversTarget, errorText, flaggedNames, flaggedOutcome, harnessName, installable, installedNames, installNote, installTargets, libraryNote, listText, plural, scopeLabel, type LibraryAdd, type PreviewSkill, type SkillFinding, type SkillHarness, type FlaggedOutcome, type SkillInventory, type SkillPreview } from './skill-manager-model';

export type AddSkillOptions = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** The native folder picker behind 'Choose folder…'; null when cancelled. */
  chooseFolder(): Promise<string | null>;
  harnesses: readonly SkillHarness[];
  /** The page's list, so skills already installed at the chosen target can be marked; null before it loads. */
  inventory?: SkillInventory | null;
  /** A source to prefill and look at right away (a bot library skill's 'Install for agents…' in Rules & library). */
  source?: string;
  /** The project being viewed, offered (and preselected) as the install target. */
  project: { id: string; name: string } | null;
  projects: { id: string; name: string }[];
  onProgress(note: string): void;
  trigger(): HTMLElement | null | undefined;
  /** After a successful install, with a short note for the page ('Installed 2 skills for Claude Code.'). */
  onInstalled(note: string, inventory: SkillInventory): void;
  /** After an add to the bot library (agents' folders unchanged), with a short note for the page. */
  onLibraryAdded?(note: string): void;
};

const checkbox = (name: string, value: string, label: string, checked: boolean, extra = '') =>
  `<label class="skill-add-check"><input type="checkbox" name="${name}" value="${escape(value)}"${checked ? ' checked' : ''}><span>${label}</span>${extra}</label>`;

/** Shown for a found skill whose name can't be switched off; native's longer reason is its tooltip. */
export const UNSWITCHABLE_NAME = 'Its name isn’t supported.';

/** One found skill: its name (and 'Installed', once marked) on the first line, the description under it (two lines
 * before it ellipsizes), or, for a name that can't be switched off, the short reason. */
function skillHtml(skill: PreviewSkill, checked: boolean): string {
  const locked = !installable(skill);
  const note = locked ? `<small class="skill-add-reason"${skill.unswitchableReason ? ` data-tip="${escape(skill.unswitchableReason)}"` : ''}>${UNSWITCHABLE_NAME}</small>`
    : skill.description ? `<small>${escape(skill.description)}</small>` : '';
  return `<label class="skill-add-check"${locked ? ' data-locked' : ''}><input type="checkbox" name="skill" value="${escape(skill.name)}"${checked && !locked ? ' checked' : ''}${locked ? ' disabled data-locked' : ''}><span class="skill-add-skill-text"><span class="skill-add-skill-name"><span>${escape(skill.name)}</span>${locked ? '' : '<span class="skill-add-installed" hidden>Installed</span>'}</span>${note}</span></label>`;
}

/** Each found skill, checked unless a skills.sh link named others; `markInstalled` later marks (and unchecks) the
 * ones already installed at the chosen target. A skill whose name can't be switched off stays listed, disabled. */
function skillsHtml(preview: SkillPreview): string {
  const picked = preview.selected?.length ? new Set(preview.selected) : null;
  const rows = preview.skills.map(s => skillHtml(s, !picked || picked.has(s.name))).join('');
  return `<fieldset class="skill-add-group"><legend><span>${plural(preview.skills.length, 'skill')} found</span> <span class="skill-add-bulk"><button type="button" class="skill-add-link" data-add-all>Select all</button> · <button type="button" class="skill-add-link" data-add-none>Select none</button></span></legend>
    <div class="skill-add-skills">${rows}</div></fieldset>`;
}

/** Where a target installs: agents' home folders for All projects, the project's own folders, or PandaCode's
 * library for bots only. */
const targetHint = (target: string): string => target === BOT_LIBRARY ? 'For bots; agents won’t see it.'
  : target ? 'Into the project’s folders, like .claude/skills.' : 'Into each agent’s home folder, like ~/.claude/skills.';

/** 'Install to': All projects, each project, and the bot library only for someone with a bot. `selected` is the
 * user's choice so far (kept when the source changes), else the project being viewed. */
function targetHtml(options: AddSkillOptions, selected: string, bots: boolean): string {
  const valid = [...options.projects.map(p => p.id), ...(bots ? [BOT_LIBRARY] : [])];
  const chosen = valid.includes(selected) ? selected : '';
  const option = (value: string, label: string) => `<option value="${escape(value)}"${value === chosen ? ' selected' : ''}>${escape(label)}</option>`;
  return `<div class="skill-add-target"><label class="skill-add-field"><span>Install to</span><select class="settings-select" name="target" aria-describedby="skill-add-target-hint">${option('', 'All projects')}${options.projects.map(p => option(p.id, p.name)).join('')}${bots ? option(BOT_LIBRARY, 'Bot library') : ''}</select></label>
    <p class="skill-add-hint" id="skill-add-target-hint">${escape(targetHint(chosen))}</p></div>`;
}

/** One box per CLI agent id. Agents installed on this computer start checked; the others are listed, unchecked
 * and marked 'app missing', so a skill can still be added for an agent before it is installed. `chosen`: the boxes the user left
 * checked before the source changed, kept instead. */
function agentsHtml(harnesses: readonly SkillHarness[], chosen: ReadonlySet<string> | null): string {
  const targets = installTargets(harnesses);
  const groups = [...new Set(targets.map(h => h.installAs))];
  const rows = groups.map(id => {
    const group = targets.filter(h => h.installAs === id), installed = group.some(h => h.installed);
    return checkbox('agent', id, escape(listText(group.map(h => harnessName(h.id)))), chosen ? chosen.has(id) : installed, installed ? '' : ` <small class="skill-add-missing">${group.length > 1 ? 'apps missing' : APP_MISSING}</small>`);
  }).join('');
  return `<fieldset class="skill-add-group skill-add-inline" data-add-agents><legend>Agents</legend>${rows || '<span class="skill-add-hint">No supported agents found.</span>'}</fieldset>`;
}

function shellHtml(): string {
  return `<form class="skill-add" novalidate>
    <div class="dialog-heading"><div class="dialog-title"><h2 id="skill-add-title">Add skill</h2></div><button type="button" class="icon-button" data-add-close title="Close dialog" aria-label="Close dialog">${icon('close')}</button></div>
    <div class="skill-add-field"><label for="skill-add-source">Source</label><div class="skill-add-source"><input id="skill-add-source" name="source" placeholder="owner/repo, skills.sh link or folder path" autocomplete="off" spellcheck="false" maxlength="1024" required><button type="button" class="ds-btn" data-add-folder>${icon('folder')}Choose folder…</button></div></div>
    <p class="skill-add-hint">Find skills on <a href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a>, GitHub or GitLab, or choose a folder on this computer. Skills may include scripts; use sources you trust.</p>
    <div class="skill-add-found"></div>
    <p class="skill-add-error ds-danger" role="alert"></p>
    <div class="dialog-footer"><span class="skill-add-status" role="status"></span><button type="button" class="ds-btn" data-add-close>Cancel</button><button type="submit" class="ds-btn-primary" data-add-submit>Find skills</button></div>
  </form>`;
}

/** Bumped per dialog: a find or install that finishes after its dialog closed must not touch a newer one. */
let generation = 0;

const failuresHtml = (failures: readonly { skill: string; reason: string }[] = []): string =>
  failures.map(f => `<p class="skill-add-failure" role="alert">${escape(f.skill)}: ${escape(f.reason)}</p>`).join('');

/** One flagged skill in the result: its name (and its one action, when it has one) on a line, one line per finding
 * in the rows' compact format (rule, file:line, redacted excerpt), then what PandaCode did with it, and where. */
function flaggedHtml(name: string, findings: readonly SkillFinding[], outcome: string, action = ''): string {
  const lines = findings.filter(f => f.skill === name).map(({ rule, file, line, excerpt }) => flagHtml({ rule, file, line, excerpt })).join('');
  return `<section class="skill-add-review" aria-label="${escape(name)}"><div class="skill-add-review-head"><strong>${escape(name)}</strong>${action}</div>
    <ul class="skill-flags" aria-label="${escape(`Why ${name} was flagged`)}">${lines}</ul><p class="skill-add-outcome">${escape(outcome)}</p></section>`;
}
/** The result's warning heading, over the flagged skills; none when nothing was flagged (only failures). */
const flaggedHeadHtml = (count: number): string => count
  ? `<div class="skill-add-result-head"><span class="ds-warn skill-add-result-icon">${icon('alert')}</span><h3 id="skill-add-result-title">Flagged by the safety check</h3></div>` : '';

/** After a bot library add that left something out: the flagged skills (not added), what was added, what failed. */
function libraryReviewHtml(result: LibraryAdd): string {
  const names = [...new Set(result.findings.map(f => f.skill))];
  return `${flaggedHeadHtml(names.length)}${names.map(name => flaggedHtml(name, result.findings, 'Not added: the safety check flagged it.')).join('')}
    <p class="skill-add-summary">${escape(libraryNote(result))}</p>${failuresHtml(result.failures)}`;
}

/** The result after an install that needs reading: the flagged skills, each with its findings and what PandaCode did
 * (a new skill is quarantined; a flagged update is switched off where the add went, `where`: 'all projects' or the
 * project's name), then 'Installed: …' for the skills that installed cleanly, then what failed. */
function reviewHtml(after: SkillInventory, where: string, requested: readonly string[]): string {
  const findings = after.findings ?? [];
  const { quarantined, off } = flaggedNames(findings);
  const outcomes: Record<FlaggedOutcome, (name: string) => string> = {
    quarantined: name => flaggedHtml(name, findings, 'Quarantined until you restore it. Agents can’t load it in any project.', `<button type="button" class="ds-btn" data-add-enable="${escape(name)}" data-add-restore>Restore anyway</button>`),
    unconfirmed: name => flaggedHtml(name, findings, 'Review these findings. PandaCode could not confirm this skill was turned off.'),
    // Only names native says this add switched off get a button: it undoes that switch and nothing else.
    switched: name => flaggedHtml(name, findings, `Off in ${where} until you review it.`, `<button type="button" class="ds-btn" data-add-enable="${escape(name)}">Turn on anyway</button>`),
    stayed: name => flaggedHtml(name, findings, `Stays off in ${where}, as it was before.`),
  };
  const flagged = [...quarantined, ...off].map(name => outcomes[flaggedOutcome(after, name)](name)).join('');
  const failed = new Set([...quarantined, ...off, ...(after.failures ?? []).map(f => f.skill)]);
  const clean = after.error ? [] : requested.filter(name => !failed.has(name));
  const installed = clean.length ? `<p class="skill-add-installed-line">${escape(`Installed: ${listText(clean)}.`)}</p>` : '';
  return `${flaggedHeadHtml(quarantined.length + off.length)}${flagged}${installed}${failuresHtml(after.failures)}`;
}

/** Whether the user has a bot, so 'Install to' offers the bot library; a failed read hides it. */
const hasBots = (options: AddSkillOptions): Promise<boolean> =>
  options.call<unknown[]>('bots_list').then(bots => Array.isArray(bots) && bots.length > 0, () => false);

const checkedValues = (form: HTMLFormElement, name: string) => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map(input => input.value);

export async function openAddSkill(options: AddSkillOptions): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (!dialog || dialog.open) return;
  const mine = ++generation;
  const current = () => mine === generation && dialog.open && form.isConnected;
  dialog.className = 'skill-add-dialog';
  dialog.setAttribute('aria-labelledby', 'skill-add-title');
  dialog.removeAttribute('aria-label');
  dialog.removeAttribute('aria-describedby');
  dialog.innerHTML = shellHtml();
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const source = form.querySelector<HTMLInputElement>('input[name=source]')!;
  const found = form.querySelector<HTMLElement>('.skill-add-found')!;
  const error = form.querySelector<HTMLElement>('.skill-add-error')!;
  const status = form.querySelector<HTMLElement>('.skill-add-status')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-add-submit]')!;
  let harnesses = options.harnesses;
  let preview: SkillPreview | null = null, busy = false;
  /** Lists read so far (the page's first): each covers some install targets (see coversTarget). */
  let inventories: readonly SkillInventory[] = options.inventory ? [options.inventory] : [];
  /** Skill boxes the user ticked or cleared: marking installed skills never overrides them. */
  let touched: ReadonlySet<string> = new Set();
  /** The user's 'Install to' and agent choices, kept when the source changes and the list is drawn again. */
  let chosenTarget = options.project?.id ?? '';
  let chosenAgents: ReadonlySet<string> | null = null;
  /** Read once per dialog, alongside the first find. */
  const bots = hasBots(options);
  let botsKnown = false;

  const target = () => form.querySelector<HTMLSelectElement>('select[name=target]')?.value ?? '';
  const sync = () => {
    // The bot library needs no agents: its skills reach bots only.
    const count = checkedValues(form, 'skill').length, agents = target() === BOT_LIBRARY ? 1 : checkedValues(form, 'agent').length;
    const label = busy ? (preview ? 'Installing…' : 'Finding…') : preview ? `Install ${plural(count, 'skill')}` : 'Find skills';
    // A source blur fires change during mousedown. Replacing unchanged button text cancels WebKit's click.
    if (submit.textContent !== label) submit.textContent = label;
    submit.disabled = busy || (preview ? !count || !agents : !source.value.trim());
    form.toggleAttribute('aria-busy', busy);
    form.querySelector<HTMLButtonElement>('.dialog-footer [data-add-close]')!.textContent = busy && preview ? 'Close' : 'Cancel';
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, select, [data-add-all], [data-add-none], [data-add-folder]').forEach(control => { control.disabled = busy || control.hasAttribute('data-locked'); });
    // Once the review shows, the source is final.
    form.querySelector<HTMLButtonElement>('[data-add-folder]')!.disabled = busy || source.disabled;
  };
  const setBusy = (on: boolean, text: string) => { busy = on; status.textContent = text; sync(); };
  const showPreview = (next: SkillPreview | null) => {
    preview = next;
    touched = new Set();
    found.innerHTML = next ? `${skillsHtml(next)}${targetHtml(options, chosenTarget, botsKnown)}${agentsHtml(harnesses, chosenAgents)}` : '';
    void markInstalled();
    sync();
  };

  /** Marks the found skills already installed at the chosen target for every chosen agent, and leaves them
   * unchecked unless the user ticked them (they can still reinstall or update). Reads the target's list once
   * when the page's list doesn't cover it. */
  async function markInstalled(): Promise<void> {
    const shown = preview, chosen = target();
    const hint = form.querySelector<HTMLElement>('#skill-add-target-hint');
    if (hint) hint.textContent = targetHint(chosen);
    const library = chosen === BOT_LIBRARY;
    form.querySelector<HTMLElement>('[data-add-agents]')?.toggleAttribute('hidden', library);
    // The bot library has no agent folders to compare; a skill already there comes back as a failure.
    let inventory = library ? undefined : inventories.find(i => coversTarget(i, chosen));
    if (library) { applyInstalled(new Set(), shown); return; }
    if (!inventory) {
      try {
        const read = await options.call<SkillInventory>('skill_manager_list', chosen ? { projectId: chosen } : {});
        inventories = [...inventories, { ...read, projectId: read.projectId ?? (chosen || null) }];
      } catch { return; } // Unmarked is safe: the install itself reports what it changed.
      if (!current() || preview !== shown || target() !== chosen) return;
      inventory = inventories.at(-1);
    }
    applyInstalled(inventory ? installedNames(inventory, chosen, checkedValues(form, 'agent')) : new Set<string>(), shown);
  }

  function applyInstalled(installed: ReadonlySet<string>, shown: SkillPreview | null): void {
    const picked = shown?.selected?.length ? new Set(shown.selected) : null;
    form.querySelectorAll<HTMLInputElement>('input[name=skill]:not([data-locked])').forEach(box => {
      const on = installed.has(box.value);
      box.closest('label')?.querySelector<HTMLElement>('.skill-add-installed')?.toggleAttribute('hidden', !on);
      if (!touched.has(box.value)) box.checked = !on && (!picked || picked.has(box.value));
    });
    sync();
  }

  async function find(): Promise<void> {
    error.textContent = '';
    setBusy(true, 'Fetching skills… the first run can take a minute.');
    try {
      if (!harnesses.length) {
        const inventory = await options.call<SkillInventory>('skill_manager_list');
        if (!current()) return;
        harnesses = inventory.harnesses;
        inventories = [...inventories, inventory];
      }
      const [result, withBots] = await Promise.all([options.call<SkillPreview>('skill_manager_preview', { source: source.value.trim() }), bots]);
      if (!current()) return;
      botsKnown = withBots;
      setBusy(false, '');
      if (!result.skills.length) { error.textContent = 'No skills found at that source.'; return; }
      showPreview(result);
      form.querySelector<HTMLInputElement>('input[name=skill]:not([data-locked])')?.focus();
    } catch (e) {
      if (!current()) return;
      setBusy(false, '');
      error.textContent = errorText(e);
    }
  }

  /** Once a result needs reading, the source is final: the form shows only the result (Source, Choose folder and the
   * hint step aside) and the footer offers only Done, which takes focus (never an 'anyway' button). */
  function showReview(html: string): void {
    source.disabled = true;
    form.querySelector<HTMLButtonElement>('[data-add-folder]')!.disabled = true;
    form.toggleAttribute('data-result', true);
    submit.hidden = true;
    const done = form.querySelector<HTMLButtonElement>('.dialog-footer [data-add-close]')!;
    done.textContent = 'Done';
    found.innerHTML = html;
    done.focus();
  }

  /** Bot library: native installs into a private staging folder, scans, and imports the clean skills into
   * PandaCode's library; agents' folders are never touched. */
  async function installLibrary(chosen: SkillPreview, skills: string[]): Promise<void> {
    const working = `Adding ${plural(skills.length, 'skill')} to the bot library…`;
    error.textContent = '';
    setBusy(true, working);
    options.onProgress(working);
    try {
      const result = await options.call<LibraryAdd>('skill_manager_add_library', { source: chosen.source, skills });
      const note = libraryNote(result);
      (options.onLibraryAdded ?? options.onProgress)(note);
      if (!current()) return;
      if (!result.findings.length && !result.failures.length) { dialog!.close(); return; }
      setBusy(false, '');
      showReview(libraryReviewHtml(result));
    } catch (e) {
      options.onProgress(`Couldn’t add skills to the bot library: ${errorText(e)}`);
      if (!current()) return;
      setBusy(false, '');
      error.textContent = errorText(e);
    }
  }

  async function install(chosen: SkillPreview): Promise<void> {
    const skills = checkedValues(form, 'skill'), targets = checkedValues(form, 'agent');
    if (target() === BOT_LIBRARY) { await installLibrary(chosen, skills); return; }
    const chosenHarnesses = installTargets(harnesses).filter(h => targets.includes(h.installAs)).map(h => h.id);
    const projectId = form.querySelector<HTMLSelectElement>('select[name=target]')?.value ?? '';
    error.textContent = '';
    setBusy(true, `Installing ${plural(skills.length, 'skill')}…`);
    options.onProgress(`Installing ${plural(skills.length, 'skill')}…`);
    const scope = projectId ? { projectId } : {};
    const where = scopeLabel(options.projects.find(p => p.id === projectId)?.name ?? (projectId ? 'this project' : ''));
    // The list already read for this target (the page's, or markInstalled's) words the note; no second scan.
    const before = inventories.find(i => coversTarget(i, projectId));
    try {
      const after = await options.call<SkillInventory>('skill_manager_add', { source: chosen.source, skills, harnesses: chosenHarnesses, ...scope });
      // Never 'Installed N skills' for skills the safety check flagged: they are counted apart ('· 1 skill off for review').
      const flagged = new Set((after.findings ?? []).map(f => f.skill));
      const done = before ? installNote(before, after) : addedNote(skills.filter(name => !flagged.has(name)).length, chosenHarnesses.map(harnessName), after.findings);
      // The page refreshes even when this dialog is gone; only its own dialog closes.
      options.onInstalled(after.error ? `Couldn’t finish installing skills: ${after.error}` : done, after);
      if (!current()) return;
      if (!after.error && !after.findings?.length && !after.failures?.length) { dialog!.close(); return; }
      setBusy(false, '');
      error.textContent = after.error ?? '';
      showReview(reviewHtml(after, where, skills));
      found.querySelectorAll<HTMLButtonElement>('[data-add-enable]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        const name = button.dataset.addEnable!, restore = button.hasAttribute('data-add-restore');
        try {
          // A quarantined skill comes back with restore; a skill only switched off is turned on where the add
          // switched it off (a project add: that project's switch only).
          const next = restore
            ? await options.call<SkillInventory>('skill_manager_restore', { name, ...scope })
            : await options.call<SkillInventory>('skill_manager_set', { name, enabled: true, ...scope });
          options.onInstalled(restore ? `Restored ${name}.` : `Turned ${name} on in ${where}.`, next);
          if (current()) {
            button.textContent = restore ? 'Restored' : 'Turned on';
            const outcome = button.closest('.skill-add-review')?.querySelector('.skill-add-outcome');
            if (outcome) outcome.textContent = restore ? 'Restored. Agents can load it in new tasks.' : `On in ${where}.`;
          }
        } catch (e) { if (current()) { error.textContent = errorText(e); button.disabled = false; } }
      }));
    } catch (e) {
      options.onProgress(`Couldn’t install skills: ${errorText(e)}`);
      if (!current()) return;
      setBusy(false, '');
      error.textContent = errorText(e);
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || submit.disabled) return;
    void (preview ? install(preview) : find());
  });
  // WKWebView sends the Enter that commits an IME composition as keyCode 229; it must not submit.
  form.addEventListener('keydown', event => { if (event.key === 'Enter' && isImeKey(event)) event.preventDefault(); });
  source.addEventListener('input', () => { if (preview) showPreview(null); error.textContent = ''; sync(); });
  form.addEventListener('change', event => {
    const control = event.target as HTMLInputElement;
    if (control.name === 'skill') touched = new Set([...touched, control.value]);
    if (control.name === 'target') chosenTarget = control.value;
    if (control.name === 'agent') chosenAgents = new Set(checkedValues(form, 'agent'));
    if (control.name === 'target' || control.name === 'agent') void markInstalled();
    sync();
  });
  /** 'Choose folder…': the picked folder becomes the source and is looked at right away. */
  async function chooseFolder(): Promise<void> {
    let folder: string | null;
    try { folder = await options.chooseFolder(); } catch (e) { if (current()) error.textContent = errorText(e); return; }
    if (!folder || !current() || busy || source.disabled) return;
    source.value = folder;
    if (preview) showPreview(null);
    void find();
  }

  form.addEventListener('click', event => {
    const target = (event.target as Element).closest('[data-add-close],[data-add-all],[data-add-none],[data-add-folder]');
    if (!target) return;
    if (target.matches('[data-add-close]')) { if (mine === generation) generation++; dialog.close(); return; }
    if (target.matches('[data-add-folder]')) { void chooseFolder(); return; }
    const on = target.matches('[data-add-all]');
    const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name=skill]:not([data-locked])')];
    boxes.forEach(box => { box.checked = on; });
    touched = new Set(boxes.map(box => box.value));
    sync();
  });
  dialog.addEventListener('cancel', () => { if (mine === generation) generation++; }, { once: true });
  dialog.addEventListener('close', () => { if (mine === generation) generation++; if (form.isConnected) options.trigger()?.focus(); }, { once: true });
  sync();
  dialog.showModal();
  source.focus();
  // A source handed over by Rules & library is looked at right away, like a chosen folder.
  if (options.source) { source.value = options.source; void find(); }
}
