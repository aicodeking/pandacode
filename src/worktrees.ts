import './worktrees.css';
import { escape, icon } from './dom';
import { githubEnabled } from './github';
import { t } from './i18n.ts';
import type { BranchList, GitStatus, Project, Session, WorktreeMerge, WorktreeStatus, WorktreeRemoval } from './types';

/* One branch control for every task. The chip above the prompt names the checkout
 * and opens the only worktree menu; dialogs convert an unstarted task in place,
 * spawn a sibling task for a started one, and never remove work without consent. */

type ChoiceItem = { id: string; label: string; description?: string; icon?: string; disabled?: boolean };
export type WorktreeHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  modal(title: string, body: string, cls?: string): HTMLDialogElement;
  closeModal(): void;
  notify(text: string): void;
  showChoices(anchor: HTMLElement, options: { title: string; items: ChoiceItem[]; actions?: boolean; width?: number; onSelect: (id: string) => void | Promise<void> }): Promise<void>;
  session(): Session | undefined;
  project(): Project | undefined;
  git(): GitStatus | null;
  gitError(): string;
  draft(): string;
  /** The task has no history, so a worktree can be attached to it in place. */
  attachable(): boolean;
  running(): boolean;
  /** `live` is false when the dialog was dismissed before the request finished;
   *  `current` says whether the source task is still the selected one. */
  afterAttach(session: Session, live: boolean): Promise<void>;
  afterCreate(session: Session, live: boolean, current: boolean): Promise<void>;
  /** The checkout moved to another branch; reload its status. */
  branchChanged(): Promise<void>;
  /** Settle the task (stage completed) without asking about its checkout again. */
  settle(session: Session): Promise<void>;
  /** Extra menu rows from integrations, with their own handler. */
  extraItems(session: Session): ChoiceItem[];
  /** The computer control (PandaCode Connect) for the context bar; empty when there is none. */
  computer(session: Session, fresh: boolean): string;
  onExtra(id: string, session: Session, anchor: HTMLElement): Promise<void> | void;
};
export type CleanupIntent = 'complete' | 'remove';
export type CleanupDecision = { proceed: boolean; remove: boolean };

export function worktreeMissing(session: Session | undefined, gitError: string): boolean {
  return Boolean(session?.worktreePath) && /worktree/i.test(gitError);
}

/** A branch-safe suggestion from a title, draft, or linked issue. */
export function suggestBranch(session: Session | undefined, draft: string): string {
  const source = session?.issue ? `${session.issue.number} ${session.issue.title}` : session && session.title !== 'New conversation' ? session.title : draft;
  // Whole words only, up to 40 characters, so a suggestion never ends mid-word.
  const words = source.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const word of words) { if (slug && slug.length + 1 + word.length > 40) break; slug = slug ? `${slug}-${word}` : word.slice(0, 40); }
  return slug;
}
export function finalBranchName(name: string): string {
  const trimmed = name.trim();
  return /^(pandacode|kingcode|codex)\//.test(trimmed) ? trimmed : trimmed ? `pandacode/${trimmed}` : '';
}
const BRANCH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9_/-]+$/;

export function createWorktrees(host: WorktreeHost) {
  let cleanup: { resolve: (decision: CleanupDecision) => void; dialog: HTMLDialogElement } | undefined;

  function checkoutLabel(session: Session): string {
    return session.worktreePath ? t('Worktree') : t('Local');
  }

  /** The context bar for the prompt: project, checkout kind, branch chip, and linked work. */
  function contextBar(session: Session, fresh: boolean): string {
    const project = host.project(), git = host.git(), missing = worktreeMissing(session, host.gitError());
    const branch = session.worktreePath && (missing || !git?.branch) ? session.worktreeBranch || '' : git?.branch || '';
    const path = session.worktreePath ?? project?.path ?? '';
    const projectControl = fresh
      ? `<button type="button" id="composer-project" class="composer-project" data-action="change-task-project" aria-label="${t('Change task project')}" aria-haspopup="dialog" aria-expanded="false" title="${escape(project?.path)}" ${session.worktreePath ? 'disabled' : ''}>${icon('folder')}<span>${escape(project?.name)}</span>${icon('down')}</button>`
      : `<span class="composer-project composer-project-fixed" title="${escape(project?.path)}">${icon('folder')}<span>${escape(project?.name)}</span></span>`;
    // A task on another computer has its checkout there: name the branch, offer no local actions.
    const chip = session.remoteDevice
      ? `<span class="branch-chip branch-chip-fixed" title="${t`Branch actions run on ${escape(session.remoteDevice.name)}, not here.`}">${icon(session.worktreePath ? 'worktree' : 'branch')}<span class="branch-chip-name">${escape(session.worktreeBranch || t('Remote checkout'))}</span></span>`
      : git?.isRepo || session.worktreePath
      ? `<button type="button" id="branch-chip" class="branch-chip ${missing ? 'branch-chip-missing' : ''}" data-action="branch-menu" aria-label="${t('Branch and worktree actions')}" aria-haspopup="dialog" aria-expanded="false" title="${escape(path)}">${icon(missing ? 'alert' : 'branch')}<span class="branch-chip-name">${escape(missing ? t('Worktree missing') : branch || t('Detached HEAD'))}</span>${icon('down')}</button>`
      : '';
    const links = [session.issue, session.pullRequest].filter(Boolean).map(link => linkChip(link!, session.id)).join('');
    return `<div class="composer-context ${fresh ? '' : 'composer-context-compact'}">${projectControl}${host.computer(session, fresh)}<span class="composer-local" title="${escape(path)}">${icon(session.worktreePath ? 'worktree' : 'terminal')}${checkoutLabel(session)}</span>${chip}${links}</div>`;
  }

  async function showMenu(anchor: HTMLElement): Promise<void> {
    const session = host.session(); if (!session || session.remoteDevice) return;
    const project = host.project(), git = host.git(), missing = worktreeMissing(session, host.gitError());
    const path = session.worktreePath ?? project?.path ?? '';
    const branch = missing ? session.worktreeBranch || t('unknown branch') : git?.branch || session.worktreeBranch || t('Detached HEAD');
    const items: ChoiceItem[] = [{ id: 'checkout', label: branch, description: `${checkoutLabel(session)} · ${path}`, icon: session.worktreePath ? 'worktree' : 'branch', disabled: true }];
    if (missing) {
      items.push({ id: 'worktree-recreate', label: t('Recreate worktree'), description: t('Check the branch out again at the same path.'), icon: 'refresh' });
      items.push({ id: 'settle-task', label: t('Settle task'), description: t('Keep the history; forget the checkout.'), icon: 'check' });
    } else if (session.worktreePath) {
      const target = (await host.call<BranchList>('git_branches', { projectId: session.projectId, sessionId: session.id }).catch(() => null))?.defaultBranch || 'main';
      items.push({ id: 'worktree-merge', label: t`Merge into ${target}`, description: host.running() ? t('Wait for the agent to finish.') : t('Locally, in the project checkout. Commit first.'), icon: 'merge', disabled: host.running() });
      items.push(...host.extraItems(session));
      items.push({ id: 'worktree-remove', label: t('Remove worktree…'), description: t('Settles the task; refuses when work would be lost.'), icon: 'close', disabled: host.running() });
      items.push({ id: 'copy-path', label: t('Copy worktree path'), icon: 'copy' });
    } else {
      // The project's own checkout can move between branches; worktree tasks keep theirs.
      const list = await host.call<BranchList>('git_branches', { projectId: session.projectId, sessionId: session.id }).catch(() => null);
      if (list) {
        const busy = host.running(), others = list.branches.filter(name => name !== list.current);
        if (list.defaultBranch && list.defaultBranch !== list.current) items.push({ id: 'switch-default', label: t`Switch to ${list.defaultBranch}`, description: busy ? t('Wait for the agent to finish.') : t('Uncommitted changes come along when they don’t conflict.'), icon: 'branch', disabled: busy });
        if (others.length) items.push({ id: 'switch-other', label: t('Other branch…'), description: busy ? t('Wait for the agent to finish.') : others.length === 1 ? t`1 local branch` : t`${others.length} local branches`, icon: 'branch', disabled: busy });
      }
      if (host.attachable()) items.push({ id: 'worktree-attach', label: t('Work in a new worktree…'), description: t('Keeps this draft and task; isolates its changes.'), icon: 'worktree' });
      else items.push({ id: 'worktree-new', label: t('New task in a worktree…'), description: t('Same harness and model, in an isolated checkout.'), icon: 'worktree' });
      items.push(...host.extraItems(session));
      items.push({ id: 'copy-path', label: t('Copy project path'), icon: 'copy' });
    }
    await host.showChoices(anchor, { title: t('Branch and worktree'), width: 320, actions: true, items, onSelect: async id => {
      const current = host.session(); if (!current || current.id !== session.id) return;
      switch (id) {
        case 'worktree-attach': openDialog('attach'); break;
        case 'worktree-new': openDialog('new'); break;
        case 'worktree-remove': await removeInteractive(current); break;
        case 'worktree-merge': await merge(current); break;
        case 'worktree-recreate': await recreate(current); break;
        case 'switch-default': await switchTo(current, ''); break;
        // The picker replaces this menu, so it opens once this one has closed.
        case 'switch-other': window.setTimeout(() => void pickBranch(current, anchor), 0); break;
        case 'settle-task': await host.settle(current); break;
        case 'copy-path': await navigator.clipboard.writeText(path); host.notify(current.worktreePath ? t('Worktree path copied') : t('Project path copied')); break;
        default: await host.onExtra(id, current, anchor);
      }
    } });
  }

  /** Check out `branch` (or the default branch when empty) in the task's own checkout. */
  async function switchTo(session: Session, branch: string): Promise<void> {
    try {
      const target = branch || (await host.call<BranchList>('git_branches', { projectId: session.projectId, sessionId: session.id })).defaultBranch;
      if (!target) { host.notify(t('This repository has no main branch.')); return; }
      const list = await host.call<BranchList>('git_switch_branch', { projectId: session.projectId, sessionId: session.id, branch: target });
      host.notify(t`Switched to ${list.current}`);
      // Refresh once the menu has closed: an open menu keeps the context bar from redrawing its chip.
      window.setTimeout(() => void host.branchChanged(), 0);
    } catch (cause) {
      host.notify(t`Couldn’t switch branches: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function pickBranch(session: Session, anchor: HTMLElement): Promise<void> {
    const list = await host.call<BranchList>('git_branches', { projectId: session.projectId, sessionId: session.id }).catch(() => null);
    const others = list?.branches.filter(name => name !== list.current) ?? [];
    if (!others.length) { host.notify(t('There are no other local branches.')); return; }
    // The context bar may have redrawn its chip meanwhile; anchor to the one on screen.
    const target = anchor.isConnected ? anchor : document.querySelector<HTMLElement>('#branch-chip');
    if (!target) return;
    await host.showChoices(target, { title: t('Switch branch'), width: 320, ...(others.length > 8 ? { searchPlaceholder: t('Search branches…') } : {}), items: others.map(name => ({ id: name, label: name, icon: 'branch', ...(name === list?.defaultBranch ? { description: t('main branch') } : {}) })), onSelect: async name => {
      const current = host.session(); if (current?.id === session.id) await switchTo(current, name);
    } });
  }

  function openDialog(mode: 'attach' | 'new', initialBranch = ''): void {
    const session = host.session(); if (!session) { host.notify(t('Start a task before creating a worktree.')); return; }
    const project = host.project(), git = host.git();
    const suggested = initialBranch || suggestBranch(session, host.draft());
    const description = mode === 'attach'
      ? t`This task keeps its draft, harness, and model, and its changes stay in an isolated checkout beside ${escape(project?.name)}.`
      : t`Start a new task in an isolated checkout of ${escape(project?.name)}. It inherits this task's harness and model.`;
    const dialog = host.modal(mode === 'attach' ? t('Work in a new worktree') : t('New task in a worktree'), `<form id="worktree-form" data-mode="${mode}" data-session-id="${escape(session.id)}"><p class="dialog-description">${description}</p><label class="field-label" for="branch-name">${t('Branch name')}</label><input id="branch-name" name="branch" value="${escape(suggested)}" placeholder="${t('my-feature')}" required pattern="[A-Za-z0-9_\\/\\-]+" maxlength="120" autocomplete="off" spellcheck="false"><p class="field-help worktree-preview" id="branch-preview" data-live></p><label class="field-label" for="branch-base">${t('Start from')}</label><select id="branch-base" name="base" aria-describedby="branch-base-help"><option value="">${escape(git?.branch ? t`Current branch (${git.branch})` : t('Current HEAD'))}</option></select><p class="field-help" id="branch-base-help">${t`Local branches load from the ${session.worktreePath ? t('worktree') : t('project')} checkout.`}</p><label class="worktree-existing" hidden><input type="checkbox" name="existing"><span>${t('Use the existing branch instead of creating one')}</span></label><p class="worktree-error field-help" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">${t('Cancel')}</button><button class="primary-button">${mode === 'attach' ? t('Use a worktree') : t('Create worktree task')}</button></div></form>`, 'compact-dialog worktree-dialog');
    const input = dialog.querySelector<HTMLInputElement>('#branch-name')!, preview = dialog.querySelector<HTMLElement>('#branch-preview')!;
    const update = () => {
      const final = finalBranchName(input.value);
      preview.innerHTML = final ? `${t('Creates ')}<code>${escape(final)}</code>${t(' in ')}<code>${escape((project?.path ?? '').replace(/\/[^/]*$/, ''))}/${escape(project?.name)}-worktrees/${escape(final.replaceAll('/', '-'))}</code>` : t('Names may use letters, numbers, hyphens, underscores, and slashes.');
      preview.classList.toggle('worktree-preview-invalid', Boolean(input.value) && !BRANCH_PATTERN.test(input.value.trim()));
    };
    input.addEventListener('input', update); update();
    input.focus(); input.select();
    const select = dialog.querySelector<HTMLSelectElement>('#branch-base')!;
    void host.call<BranchList>('git_branches', { projectId: session.projectId, sessionId: session.id }).then(list => {
      if (!select.isConnected) return;
      for (const name of list.branches) if (name !== list.current) { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); }
    }).catch(() => { /* The current branch remains the start point. */ });
  }

  async function submit(form: HTMLFormElement, data: FormData): Promise<boolean> {
    if (form.id === 'worktree-cleanup-form') {
      const pending = cleanup; cleanup = undefined;
      if (pending) { pending.resolve({ proceed: true, remove: data.get('remove') === 'on' }); host.closeModal(); }
      return true;
    }
    if (form.id !== 'worktree-form') return false;
    const session = host.session();
    const mode = form.dataset.mode as 'attach' | 'new';
    if (!session || session.id !== form.dataset.sessionId) { host.closeModal(); return true; }
    const branch = String(data.get('branch') ?? '').trim(), base = String(data.get('base') ?? '').trim(), existing = data.get('existing') === 'on';
    const error = form.querySelector<HTMLElement>('.worktree-error')!, existingRow = form.querySelector<HTMLElement>('.worktree-existing')!;
    if (!BRANCH_PATTERN.test(branch)) { error.textContent = t('Use letters, numbers, hyphens, underscores, and slashes.'); error.hidden = false; return true; }
    try {
      const saved = await host.call<Session>(mode === 'attach' ? 'attach_worktree' : 'create_worktree', { sessionId: session.id, branch, ...(base ? { base } : {}), existing });
      // A dialog dismissed meanwhile must not steal navigation or close whatever replaced it.
      const live = form.isConnected && Boolean(form.closest('dialog[open]'));
      if (mode === 'attach') await host.afterAttach(saved, live); else await host.afterCreate(saved, live, host.session()?.id === session.id);
      host.notify(mode === 'attach' ? t`Working in ${saved.worktreeBranch ?? finalBranchName(branch)}` : t('Worktree task created'));
    } catch (cause) {
      if (!form.isConnected) return true;
      const message = cause instanceof Error ? cause.message : String(cause);
      error.textContent = message; error.hidden = false;
      if (/already exists/.test(message) && !existing) { existingRow.hidden = false; existingRow.querySelector('input')!.focus(); }
    }
    return true;
  }

  /** Ask before settling a worktree task or removing its checkout; nothing is removed here. */
  function cleanupOffer(session: Session, intent: CleanupIntent): Promise<CleanupDecision> {
    if (!session.worktreePath) return Promise.resolve({ proceed: true, remove: false });
    return host.call<WorktreeStatus>('worktree_status', { sessionId: session.id }).catch(() => undefined).then(status => new Promise<CleanupDecision>(resolve => {
      if (!status) { resolve({ proceed: true, remove: false }); return; }
      if (!status.exists && intent !== 'remove') { resolve({ proceed: true, remove: false }); return; }
      const verb = intent === 'complete' ? t('Settle task') : t('Remove worktree');
      const branch = status.branch || session.worktreeBranch || t('its branch');
      const unpublished = !status.merged && (!status.hasUpstream || status.ahead > 0);
      let summary: string, control = '';
      if (!status.exists) summary = t`The worktree folder is already gone. ${intent === 'remove' ? t('Its registration is pruned and the task is settled.') : ''}`;
      else if (!status.clean) summary = `${t`Its worktree has ${status.changes} uncommitted change${status.changes === 1 ? '' : 's'}, so the checkout stays at `}<code>${escape(session.worktreePath)}</code>.${intent === 'remove' ? t(' Commit or discard them first.') : ''}`;
      else {
        summary = `${t('Its worktree is clean')}${status.merged ? t(' and its branch is merged') : unpublished ? `${t(', but ')}<strong>${escape(branch)}</strong>${t(' has commits that are not pushed or merged')}` : ''}.`;
        control = `<label class="worktree-cleanup-option"><input type="checkbox" name="remove" ${intent === 'remove' || !unpublished ? 'checked' : ''}><span>${t('Remove the worktree folder')}${status.merged ? `${t(' and delete ')}<code>${escape(branch)}</code>` : `; <code>${escape(branch)}</code>${t(' is kept until it is merged')}`}</span></label>`;
      }
      const canProceed = intent !== 'remove' || (status.exists ? status.clean : true);
      const dialog = host.modal(verb, `<form id="worktree-cleanup-form" data-session-id="${escape(session.id)}"><p class="dialog-description">${summary}</p>${control}<div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">${t('Cancel')}</button><button class="primary-button" ${canProceed ? '' : 'disabled'}>${intent === 'remove' ? t('Remove and settle') : verb}</button></div></form>`, 'compact-dialog worktree-dialog');
      cleanup?.resolve({ proceed: false, remove: false });
      cleanup = { resolve, dialog };
      dialog.addEventListener('close', () => { if (cleanup?.dialog === dialog) { cleanup = undefined; resolve({ proceed: false, remove: false }); } }, { once: true });
    }));
  }

  async function remove(session: Session): Promise<WorktreeRemoval> {
    const removal = await host.call<WorktreeRemoval>('remove_worktree', { sessionId: session.id, deleteBranch: true });
    host.notify(removal.note || (removal.branchDeleted ? t`Removed the worktree and deleted ${removal.branch}` : removal.removed ? t`Removed the worktree; ${removal.branch} is kept` : t('Worktree registration pruned')));
    return removal;
  }

  async function removeInteractive(session: Session): Promise<void> {
    const decision = await cleanupOffer(session, 'remove');
    if (!decision.proceed) return;
    if (decision.remove || !(await host.call<WorktreeStatus>('worktree_status', { sessionId: session.id })).exists) await remove(session);
    await host.settle(session);
  }

  /** Merge the worktree's committed branch into main locally, then offer to clean it up. */
  async function merge(session: Session): Promise<void> {
    let merged: WorktreeMerge;
    try {
      merged = await host.call<WorktreeMerge>('merge_worktree', { sessionId: session.id });
    } catch (cause) {
      host.notify(t`Couldn’t merge: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    const moved = merged.switchedFrom ? t` (the project checkout moved from ${merged.switchedFrom})` : '';
    host.notify(merged.commits ? merged.commits === 1 ? t`Merged 1 commit from ${merged.branch} into ${merged.target}${moved}` : t`Merged ${merged.commits} commits from ${merged.branch} into ${merged.target}${moved}` : t`${merged.target} already has everything from ${merged.branch}`);
    window.setTimeout(() => void host.branchChanged(), 0);
    // The merged branch can go now; the offer explains and asks first.
    await removeInteractive(session);
  }

  async function recreate(session: Session): Promise<void> {
    const restored = await host.call<Session>('recreate_worktree', { sessionId: session.id });
    await host.afterAttach(restored, false);
    host.notify(t`Worktree restored on ${restored.worktreeBranch ?? t('its branch')}`);
  }

  return { contextBar, showMenu, openDialog, submit, cleanupOffer, remove, removeInteractive, recreate };
}

/** A linked issue or pull request. With a task, a pull request opens in the inspector; otherwise on GitHub. Hidden while the integration is off. */
export function linkChip(link: NonNullable<Session['issue']>, sessionId?: string): string {
  if (!githubEnabled()) return '';
  const label = link.kind === 'pull' ? t`PR #${link.number}` : `#${link.number}`;
  const action = link.kind === 'pull' && sessionId ? `data-action="open-pull" data-session-id="${escape(sessionId)}"` : `data-action="open-url" data-url="${escape(link.url)}"`;
  return `<button type="button" class="link-chip link-chip-${escape(link.state || 'open')}" ${action} title="${escape(link.title)}" aria-label="${escape(link.kind === 'pull' ? t`Pull request ${link.number}: ${link.title} (${link.state})` : t`Issue ${link.number}: ${link.title} (${link.state})`)}">${icon(link.kind === 'pull' ? 'pull' : 'issue')}<span>${label}</span><span class="link-chip-state">${escape(link.state || 'open')}</span></button>`;
}
