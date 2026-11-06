/* The GitHub view: the account's repositories on the left; for the chosen one, its threads,
 * open pull requests and open issues as tabs. Pull requests and issues open as threads
 * (tasks linked to them), or start one-click work: review, fix checks, address feedback,
 * merge, solve. The Actions tab (github-actions.ts) lists recent workflow runs by event and pull
 * request, and a failed or unstarted one can be handed to an agent to fix. A repository without a local checkout can be browsed and cloned. */
import './github-hub.css';
import { escape, icon, markdownHtml, morph } from './dom';
import { t } from './i18n.ts';
import { runsBody, statusBadge, type DetailsLoad, type HubRun, type RunDetails, type RunFilter } from './github-actions';
import { cascade, trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import { taskStage } from './task-board';
import { age, connectAdvice, isRecent, issuePrompt, PULL_ACTIONS, pullPrompt, runPrompt, runTitle, threadTitle, WORKFLOW_CHECK_TITLE, workflowCheckPrompt, type IssueAction, type PullAction } from './github-hub-prompts';
import type { Project, Session, TaskLink } from './types';

export interface HubRepo { nameWithOwner: string; description: string; private: boolean; fork: boolean; archived: boolean; pushedAt: string; url: string; defaultBranch: string; openIssues: number; language: string }
export interface HubPull { number: number; title: string; author: string; state: string; head: string; base: string; updatedAt: string; url: string; review: string; checks: string; additions: number; deletions: number; labels: string[] }
export interface HubIssue { number: number; title: string; author: string; updatedAt: string; url: string; comments: number; labels: string[]; assignees: string[] }
export type { HubRun } from './github-actions';
interface ProjectRepo { projectId: string; repo: string }
type Tab = 'threads' | 'pulls' | 'issues' | 'actions';
type Load<T> = { items?: T[]; error?: string; loading: boolean; at: number };

export interface HubHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  projects(): Project[];
  sessions(): Session[];
  running(sessionId: string): boolean;
  openTask(sessionId: string): void;
  /** Creates a task in the project, linked when given, and opens it; `send` starts it with the prompt. */
  startTask(input: { projectId: string; prompt: string; title?: string; link?: TaskLink; send: boolean }): Promise<void>;
  showChoices(anchor: HTMLElement, options: { title: string; items: { id: string; label: string; icon?: string }[]; onSelect: (id: string) => void | Promise<void> }): Promise<void>;
  chooseFolder(title: string): Promise<string | null>;
  projectsChanged(): Promise<void>;
  notify(text: string): void;
}
export interface HubView { render(): void; refresh(): void; dispose(): void }

const STALE = 60_000;
const TABS: { id: Tab; label: string }[] = [{ id: 'threads', label: t('Threads') }, { id: 'pulls', label: t('Pull requests') }, { id: 'issues', label: t('Issues') }, { id: 'actions', label: t('Actions') }];
const stored = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* A per-device preference only. */ } };

/** Small GitHub-style state glyphs, drawn in the item's state color. */
const GLYPHS = {
  pull: '<path d="M5 3.5v9M11 12.5V7.2a2 2 0 0 0-2-2H7m1.6-1.7L7 5.2l1.6 1.7"/><circle cx="5" cy="3" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/>',
  issue: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>',
  repo: '<path d="M4 2.8h7.5a.7.7 0 0 1 .7.7v9.2H4.8a1.2 1.2 0 0 0 0 2.4H12M4 2.8a1.2 1.2 0 0 0-1.2 1.2v9.6"/>',
  lock: '<rect x="4" y="7.2" width="8" height="6" rx="1.4"/><path d="M5.8 7.2V5.4a2.2 2.2 0 0 1 4.4 0v1.8"/>',
};
export const glyph = (name: keyof typeof GLYPHS, cls = '') => `<svg class="gh-glyph ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`;

export function mountGithubHub(root: HTMLElement, host: HubHost): HubView {
  let repos: HubRepo[] | null = null, reposError = '';
  let selected = stored('pandacode.githubRepo');
  let tab = (stored('pandacode.githubTab') as Tab) || 'threads';
  let otherOpen = stored('pandacode.githubOther') === 'open';
  if (!TABS.some(item => item.id === tab)) tab = 'threads';
  let repoFilter = '', query = '', cloning = '', disposed = false;
  let mapping = new Map<string, string>();
  let runFilter: RunFilter = { event: '', pull: 0, latest: false };
  const expanded = new Set<number>(), details = new Map<string, DetailsLoad>();
  const detailsKey = (run: HubRun) => `${selected}#${run.id}#${run.attempt}#${run.state}`;
  const pulls = new Map<string, Load<HubPull>>(), issues = new Map<string, Load<HubIssue>>(), runs = new Map<string, Load<HubRun>>();
  const loads: Record<Exclude<Tab, 'threads'>, Map<string, Load<unknown>>> = { pulls, issues, actions: runs };

  root.classList.add('gh-hub');
  root.innerHTML = `<aside class="gh-repos" aria-label="${t('GitHub repositories')}">
      <div class="gh-repos-head" data-tauri-drag-region>${icon('github')}<span data-tauri-drag-region>GitHub</span><button type="button" class="icon-button" data-gh="refresh" aria-label="${t('Refresh')}" title="${t('Refresh')}">${icon('refresh')}</button></div>
      <label class="gh-filter">${icon('search')}<input type="search" data-gh-filter="repos" placeholder="${t('Filter repositories')}" aria-label="${t('Filter repositories')}" autocomplete="off" spellcheck="false"></label>
      <div class="gh-repo-scroll"><div class="gh-repo-list" role="listbox" aria-label="${t('Repositories')}"></div><div class="gh-repo-other"></div></div>
    </aside>
    <section class="gh-main" aria-live="polite"><header class="gh-head"></header>
      <div class="gh-bar"><div class="gh-tabs" role="tablist" aria-label="${t('Repository')}"></div>
        <label class="gh-filter gh-search">${icon('search')}<input type="search" data-gh-filter="items" placeholder="${t('Search')}" aria-label="${t('Search this tab')}" autocomplete="off" spellcheck="false"></label></div>
      <div class="gh-body"></div></section>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  const repo = () => repos?.find(item => item.nameWithOwner === selected);
  const projectFor = (name: string) => host.projects().find(project => project.id === mapping.get(name));
  const threads = (projectId: string | undefined) => projectId ? host.sessions().filter(task => task.projectId === projectId && !task.archived && !task.draft).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  const matches = (text: string) => !query || text.toLowerCase().includes(query.toLowerCase());

  async function loadRepos(force = false): Promise<void> {
    if (repos && !force) return;
    reposError = '';
    const [list, local] = await Promise.allSettled([host.call<HubRepo[]>('github_repos'), host.call<ProjectRepo[]>('github_project_repos')]);
    if (disposed) return;
    if (local.status === 'fulfilled') mapping = new Map(local.value.map(item => [item.repo, item.projectId]));
    if (list.status === 'fulfilled') {
      repos = list.value;
      if (!repo()) selected = repos.find(item => mapping.has(item.nameWithOwner))?.nameWithOwner ?? repos[0]?.nameWithOwner ?? '';
    } else { repos = repos ?? []; reposError = list.reason instanceof Error ? list.reason.message : String(list.reason); }
    render();
    void loadItems(force);
  }
  async function loadItems(force = false): Promise<void> {
    const name = selected; if (!name) return;
    const fetch = async <T>(cache: Map<string, Load<T>>, command: string) => {
      const current = cache.get(name);
      if (current?.loading || (!force && current && Date.now() - current.at < STALE)) return;
      cache.set(name, { ...current, loading: true, at: current?.at ?? 0 });
      try { cache.set(name, { items: await host.call<T[]>(command, { repo: name }), loading: false, at: Date.now() }); }
      catch (cause) { cache.set(name, { error: cause instanceof Error ? cause.message : String(cause), loading: false, at: Date.now() }); }
      if (!disposed && name === selected) render();
    };
    await Promise.all([fetch(pulls, 'github_repo_pulls'), fetch(issues, 'github_repo_issues'), fetch(runs, 'github_repo_runs')]);
  }

  function renderRepos(): void {
    const list = $('.gh-repo-list'), other = $('.gh-repo-other');
    if (!repos) { list.innerHTML = skeleton(7, 'gh-repo'); other.replaceChildren(); return; }
    const visible = repos.filter(item => !repoFilter || item.nameWithOwner.toLowerCase().includes(repoFilter.toLowerCase()));
    const row = (item: HubRepo) => {
      const [owner, name] = item.nameWithOwner.split('/');
      const local = mapping.has(item.nameWithOwner);
      return `<button type="button" class="gh-repo" role="option" data-gh-repo="${escape(item.nameWithOwner)}" aria-selected="${item.nameWithOwner === selected}" title="${escape(item.nameWithOwner)}${item.description ? ` · ${escape(item.description)}` : ''}">
        ${glyph(item.private ? 'lock' : 'repo')}<span class="gh-repo-name"><b>${escape(name)}</b><small>${escape(owner)}</small></span>
        ${local ? `<span class="gh-local-dot" title="${t('On this computer')}" aria-label="${t('On this computer')}"></span>` : ''}<time>${escape(age(item.pushedAt))}</time></button>`;
    };
    // Repositories pushed to in the last 30 days lead; the rest wait under Other. A search covers both.
    const recent = visible.filter(item => isRecent(item.pushedAt)), older = visible.filter(item => !isRecent(item.pushedAt));
    const open = otherOpen || Boolean(repoFilter);
    list.innerHTML = recent.map(row).join('') || (older.length ? '' : `<p class="gh-note">${repos.length ? t('No matches.') : reposError ? '' : t('No repositories yet.')}</p>`);
    other.innerHTML = older.length ? `<button type="button" class="gh-other-toggle" data-gh="other" aria-expanded="${open}" aria-controls="gh-other-list">${icon('chevron')}<span>${t('Other')}</span><small>${older.length}</small></button>
      <div id="gh-other-list" class="gh-repo-list" role="listbox" aria-label="${t('Other repositories')}" ${open ? '' : 'hidden'}>${older.map(row).join('')}</div>` : '';
  }

  function renderHead(): void {
    const head = $('.gh-head'), item = repo();
    if (!item) { head.innerHTML = ''; return; }
    const project = projectFor(item.nameWithOwner);
    const facts = [item.private ? t('Private') : t('Public'), item.fork ? t('Fork') : '', item.archived ? t('Archived') : '', item.language, item.defaultBranch].filter(Boolean).map(fact => `<span>${escape(fact)}</span>`).join('<i aria-hidden="true">·</i>');
    const where = project
      ? `<span class="gh-where" title="${escape(project.path)}">${icon('folder')}${escape(project.path.split('/').slice(-2).join('/'))}</span>`
      : `<button type="button" class="gh-clone" data-gh="clone" ${cloning ? 'disabled' : ''}>${icon('download')}${cloning === item.nameWithOwner ? t('Cloning…') : t('Clone to this computer')}</button>`;
    head.innerHTML = `<div class="gh-title"><h2>${escape(item.nameWithOwner)}</h2><a class="icon-button" data-gh-open="${escape(item.url)}" href="${escape(item.url)}" aria-label="${t('Open on GitHub')}" title="${t('Open on GitHub')}">${icon('external')}</a></div>
      <p class="gh-meta">${facts}</p>${item.description ? `<p class="gh-desc">${escape(item.description)}</p>` : ''}<div class="gh-where-row">${where}</div>`;
  }

  function renderTabs(): void {
    const name = selected, project = projectFor(name);
    const count = (id: Tab) => id === 'threads' ? (project ? threads(project.id).length : null) : loads[id].get(name)?.items?.length ?? null;
    const group = $('.gh-tabs');
    group.innerHTML = TABS.map(item => { const n = count(item.id); return `<button type="button" role="tab" data-gh-tab="${item.id}" aria-selected="${item.id === tab}">${item.label}${n !== null ? `<span class="gh-count">${n}</span>` : ''}</button>`; }).join('');
    trackSegment(group, group.querySelector<HTMLElement>('[aria-selected="true"]'));
  }

  /** The body is morphed, not rewritten: the main window re-renders the view on every workspace
   * update, and replacing the compose field mid-typing erased what was typed (#47). */
  function renderBody(): void {
    morph($('.gh-body'), bodyHtml(), 6);
    // A control the user changed ignores later attribute changes, so the run filters are set directly.
    const field = <T extends HTMLElement>(key: string) => root.querySelector<T>(`[data-gh-run-filter="${key}"]`);
    const event = field<HTMLSelectElement>('event'), pull = field<HTMLSelectElement>('pull'), latest = field<HTMLInputElement>('latest');
    if (event) event.value = runFilter.event;
    if (pull) pull.value = String(runFilter.pull);
    if (latest) latest.checked = runFilter.latest;
  }
  function bodyHtml(): string {
    const item = repo();
    if (reposError && !repos?.length) return connectState(reposError);
    if (!item) return repos ? emptyState('github', t('Choose a repository'), t('Its threads, pull requests and issues appear here.')) : skeleton(6);
    const project = projectFor(item.nameWithOwner);
    if (tab === 'threads') return threadsBody(project);
    const load = loads[tab].get(item.nameWithOwner);
    const items = load?.items;
    if (!items) return load?.error ? emptyState('alert', t('Couldn’t load from GitHub'), escape(load.error), `<button type="button" class="secondary-button" data-gh="refresh">${t('Try again')}</button>`) : skeleton(6);
    if (tab === 'pulls') return pullsBody(items as HubPull[], project);
    if (tab === 'issues') return issuesBody(items as HubIssue[], project);
    return runsBody(items as HubRun[], pulls.get(item.nameWithOwner)?.items, runFilter, query, expanded, run => details.get(detailsKey(run)));
  }

  function threadsBody(project: Project | undefined): string {
    if (!project) return emptyState('download', t('Not on this computer yet'), t('Clone this repository to start threads, review pull requests and work on issues.'), `<button type="button" class="primary-button" data-gh="clone" ${cloning ? 'disabled' : ''}>${icon('download')}${cloning ? t('Cloning…') : t('Clone repository')}</button>`);
    const list = threads(project.id).filter(task => matches(task.title));
    const compose = `<form class="gh-compose" data-gh-compose><span class="gh-compose-mark">${icon('plus')}</span><input name="prompt" placeholder="${t`Ask an agent to work on ${escape(project.name)}…`}" aria-label="${t('New thread')}" autocomplete="off" required><button type="submit" class="gh-compose-send" aria-label="${t('Start thread')}" title="${t('Start thread (Enter)')}">${icon('arrow')}</button></form>`;
    const stage = (task: Session) => host.running(task.id) ? 'working' : taskStage(task);
    const label: Record<string, string> = { working: t('Working'), pending: t('Pending'), in_progress: t('In progress'), review: t('Review'), completed: t('Done') };
    const row = (task: Session) => {
      const link = task.pullRequest ?? task.issue;
      return `<button type="button" class="gh-row gh-thread" data-gh-task="${escape(task.id)}"><span class="gh-stage" data-stage="${stage(task)}" title="${label[stage(task)]}"></span><span class="gh-logo">${providerLogo(task.provider)}</span><span class="gh-row-title">${escape(task.title)}</span>${link ? `<span class="gh-ref">${glyph(link.kind === 'pull' ? 'pull' : 'issue')}#${link.number}</span>` : ''}<span class="gh-row-meta">${label[stage(task)]}</span><time>${escape(age(task.updatedAt))}</time></button>`;
    };
    return compose + `<div class="gh-list">${list.length ? list.map(row).join('') : `<p class="gh-note">${query ? t('No matching threads.') : t('No threads yet. Describe a task above to start one.')}</p>`}</div>`;
  }

  function existingThread(project: Project | undefined, kind: 'pull' | 'issue', number: number): Session | undefined {
    return threads(project?.id).find(task => (kind === 'pull' ? task.pullRequest : task.issue)?.number === number);
  }
  const labels = (names: string[]) => names.slice(0, 3).map(name => `<span class="gh-label">${escape(name)}</span>`).join('');

  function pullsBody(items: HubPull[], project: Project | undefined): string {
    const list = items.filter(pull => matches(`#${pull.number} ${pull.title} ${pull.author} ${pull.head}`));
    if (!list.length) return `<p class="gh-note">${query ? t('No matching pull requests.') : t('No open pull requests.')}</p>`;
    const review: Record<string, string> = { approved: t('Approved'), changes_requested: t('Changes requested'), review_required: t('Review required') };
    const row = (pull: HubPull) => {
      const thread = existingThread(project, 'pull', pull.number);
      return `<div class="gh-row gh-item" data-gh-number="${pull.number}" tabindex="-1">${glyph('pull', `gh-state-${pull.state}`)}<span class="gh-num">#${pull.number}</span>
        <span class="gh-row-title" title="${escape(pull.title)}">${escape(pull.title)}</span>${labels(pull.labels)}
        <span class="gh-row-meta">${pull.review && review[pull.review] ? `<span class="gh-review" data-review="${escape(pull.review)}">${review[pull.review]}</span>` : ''}${pull.checks !== 'none' ? statusBadge(pull.checks, 'gh-checks', `data-checks="${escape(pull.checks)}" title="${t`Checks ${escape(pull.checks)}`}"`) : ''}<span class="gh-diff"><ins>+${pull.additions}</ins><del>−${pull.deletions}</del></span><span class="gh-author">${escape(pull.author)}</span></span>
        <time>${escape(age(pull.updatedAt))}</time>
        <span class="gh-actions">${thread ? `<button type="button" class="gh-act" data-gh-task="${escape(thread.id)}">${icon('chat')}${t('Thread')}</button>` : ''}<button type="button" class="gh-act" data-gh-pull-runs title="${t`Workflow runs for #${pull.number}`}">${t('Runs')}</button><button type="button" class="gh-act gh-primary" data-gh-pull="review">${t('Review')}</button><button type="button" class="gh-act gh-more" data-gh-pull-menu aria-label="${t`More actions for #${pull.number}`}" aria-haspopup="menu">${icon('more')}</button></span></div>`;
    };
    return `<div class="gh-list">${list.map(row).join('')}</div>`;
  }

  function issuesBody(items: HubIssue[], project: Project | undefined): string {
    const list = items.filter(issue => matches(`#${issue.number} ${issue.title} ${issue.author} ${issue.labels.join(' ')}`));
    if (!list.length) return `<p class="gh-note">${query ? t('No matching issues.') : t('No open issues.')}</p>`;
    const row = (issue: HubIssue) => {
      const thread = existingThread(project, 'issue', issue.number);
      const people = issue.assignees.slice(0, 2).map(name => `<span class="gh-avatar" title="${t`Assigned to ${escape(name)}`}">${escape(name.slice(0, 1).toUpperCase())}</span>`).join('');
      return `<div class="gh-row gh-item" data-gh-number="${issue.number}" tabindex="-1">${glyph('issue', 'gh-state-open')}<span class="gh-num">#${issue.number}</span>
        <span class="gh-row-title" title="${escape(issue.title)}">${escape(issue.title)}</span>${labels(issue.labels)}
        <span class="gh-row-meta">${people}${issue.comments ? `<span class="gh-comments" title="${t`${issue.comments} comments`}">${icon('chat')}${issue.comments}</span>` : ''}<span class="gh-author">${escape(issue.author)}</span></span>
        <time>${escape(age(issue.updatedAt))}</time>
        <span class="gh-actions">${thread ? `<button type="button" class="gh-act" data-gh-task="${escape(thread.id)}">${icon('chat')}${t('Thread')}</button>` : `<button type="button" class="gh-act" data-gh-issue="thread">${t('Open in thread')}</button>`}<button type="button" class="gh-act gh-primary" data-gh-issue="solve">${icon('spark')}${t('Solve')}</button></span></div>`;
    };
    return `<div class="gh-list">${list.map(row).join('')}</div>`;
  }

  function render(): void {
    if (disposed) return;
    renderRepos(); renderHead(); renderTabs(); renderBody();
  }

  /** A local checkout for the repository: the matched project, or a fresh clone. */
  async function ensureLocal(): Promise<Project | undefined> {
    const item = repo(); if (!item) return undefined;
    const existing = projectFor(item.nameWithOwner); if (existing) return existing;
    const parent = await host.chooseFolder(t`Choose where to clone ${item.nameWithOwner}`); if (!parent || disposed) return undefined;
    cloning = item.nameWithOwner; render();
    try {
      const added = await host.call<Project>('github_clone_repo', { repo: item.nameWithOwner, parent });
      mapping.set(item.nameWithOwner, added.id);
      await host.projectsChanged();
      host.notify(t`Cloned ${item.nameWithOwner}`);
      return added;
    } catch (cause) { host.notify(cause instanceof Error ? cause.message : String(cause)); return undefined; }
    finally { cloning = ''; render(); }
  }
  const linkFor = (kind: 'pull' | 'issue', item: { number: number; url: string; title: string }, state: string): TaskLink => ({ kind, number: item.number, url: item.url, title: item.title, state, checkedAt: Date.now() });
  async function pullAction(action: PullAction, pull: HubPull): Promise<void> {
    const project = await ensureLocal(); if (!project) return;
    await host.startTask({ projectId: project.id, prompt: pullPrompt(action, pull), title: threadTitle('pull', action, pull), link: linkFor('pull', pull, pull.state), send: action !== 'thread' });
  }
  async function issueAction(action: IssueAction, issue: HubIssue): Promise<void> {
    const project = await ensureLocal(); if (!project) return;
    await host.startTask({ projectId: project.id, prompt: issuePrompt(action, issue), title: threadTitle('issue', action, issue), link: linkFor('issue', issue, 'open'), send: action === 'solve' });
  }

  async function fixRun(run: HubRun): Promise<void> {
    const project = await ensureLocal(); if (!project) return;
    await host.startTask({ projectId: project.id, prompt: runPrompt(run), title: runTitle(run), send: true });
  }
  async function checkWorkflows(): Promise<void> {
    const name = selected, project = await ensureLocal(); if (!project) return;
    await host.startTask({ projectId: project.id, prompt: workflowCheckPrompt(name), title: WORKFLOW_CHECK_TITLE, send: true });
  }
  function showTab(next: Tab): void {
    tab = next; store('pandacode.githubTab', tab); renderTabs(); renderBody(); cascade(root.querySelectorAll<HTMLElement>('.gh-body .gh-row'), 14, 120);
  }
  function filterRunsBy(pull: number): void { runFilter = { ...runFilter, pull }; showTab('actions'); }
  async function toggleRun(run: HubRun): Promise<void> {
    if (expanded.has(run.id)) expanded.delete(run.id); else expanded.add(run.id);
    const key = detailsKey(run), name = selected;
    renderBody();
    if (!expanded.has(run.id) || details.has(key)) return;
    try {
      const loaded = await host.call<RunDetails>('github_run_details', { repo: name, id: run.id });
      // Summaries are rendered once here, sanitized by markdownHtml, so the synchronous body can hold them.
      const jobs = [...loaded.jobs, ...(loaded.attempts ?? []).flatMap(attempt => attempt.jobs)].filter(job => job.summary);
      const summaries = Object.fromEntries(await Promise.all(jobs.map(async job => [job.id, await markdownHtml(job.summary)] as const)));
      details.set(key, { details: loaded, summaries });
    }
    catch (cause) { details.set(key, { error: cause instanceof Error ? cause.message : String(cause) }); }
    if (!disposed && name === selected) renderBody();
  }

  function select(name: string): void {
    if (name === selected) return;
    selected = name; store('pandacode.githubRepo', name); query = '';
    $<HTMLInputElement>('[data-gh-filter="items"]').value = '';
    render(); cascade(root.querySelectorAll<HTMLElement>('.gh-body .gh-row'), 14, 120);
    void loadItems();
  }

  const click = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[data-gh-open]') : null;
    if (!target || !root.contains(target) || (target as HTMLButtonElement).disabled) return;
    const data = target.dataset, row = target.closest<HTMLElement>('[data-gh-number]'), number = Number(row?.dataset.ghNumber);
    if (data.ghOpen) { event.preventDefault(); void host.call('open_external_url', { url: data.ghOpen }); return; }
    if (data.ghRepo) { select(data.ghRepo); return; }
    if (data.ghTab) { showTab(data.ghTab as Tab); return; }
    if (data.ghRunPull) { filterRunsBy(Number(data.ghRunPull)); return; }
    if ('ghWorkflowCheck' in data) { void checkWorkflows(); return; }
    if ('ghRunClear' in data) { runFilter = { event: '', pull: 0, latest: false }; renderBody(); return; }
    if (data.ghTask) { host.openTask(data.ghTask); return; }
    if (data.gh === 'refresh') { void loadRepos(true); return; }
    if (data.gh === 'other') { otherOpen = target.getAttribute('aria-expanded') !== 'true'; store('pandacode.githubOther', otherOpen ? 'open' : 'closed'); renderRepos(); root.querySelector<HTMLElement>('[data-gh="other"]')?.focus(); return; }
    if (data.gh === 'clone') { void ensureLocal(); return; }
    const pull = pulls.get(selected)?.items?.find(item => item.number === number);
    const issue = issues.get(selected)?.items?.find(item => item.number === number);
    if (data.ghPull && pull) { void pullAction(data.ghPull as PullAction, pull); return; }
    if ('ghPullRuns' in data && pull) { filterRunsBy(pull.number); return; }
    if ('ghPullMenu' in data && pull) {
      void host.showChoices(target, { title: t`Pull request #${pull.number}`, items: [...PULL_ACTIONS, { id: 'github', label: t('Open on GitHub'), icon: 'external' }], onSelect: id => id === 'github' ? void host.call('open_external_url', { url: pull.url }) : pullAction(id as PullAction, pull) });
      return;
    }
    if (data.ghIssue && issue) { void issueAction(data.ghIssue as IssueAction, issue); return; }
    const run = runs.get(selected)?.items?.find(item => item.id === Number(target.closest<HTMLElement>('[data-gh-run]')?.dataset.ghRun));
    if ('ghRunFix' in data && run) void fixRun(run);
    if ('ghRunToggle' in data && run) void toggleRun(run);
  };
  const input = (event: Event) => {
    const field = event.target as HTMLInputElement;
    if (field.dataset.ghFilter === 'repos') { repoFilter = field.value; renderRepos(); }
    else if (field.dataset.ghFilter === 'items') { query = field.value; renderBody(); }
  };
  const change = (event: Event) => {
    const field = event.target as HTMLInputElement | HTMLSelectElement, key = field.dataset.ghRunFilter;
    if (!key) return;
    runFilter = { ...runFilter, [key]: key === 'latest' ? (field as HTMLInputElement).checked : key === 'pull' ? Number(field.value) : field.value };
    renderBody();
  };
  const submit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-gh-compose]')) return;
    event.preventDefault();
    const prompt = String(new FormData(form).get('prompt') ?? '').trim();
    const project = projectFor(selected);
    if (!prompt || !project) return;
    form.reset();
    void host.startTask({ projectId: project.id, prompt, send: true });
  };
  /** Arrow keys move through a list like a native one; Enter activates the row's first action. */
  const keydown = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const current = (event.target as HTMLElement).closest<HTMLElement>('.gh-repo, .gh-row');
    if (!current) return;
    if (event.key === 'Enter') {
      // A button answers Enter on its own; only a row that holds the focus needs one.
      if ((event.target as HTMLElement).closest('button')) return;
      const action = current.querySelector<HTMLElement>('.gh-actions button');
      if (!action) return;
      event.preventDefault();
      action.click();
      return;
    }
    // The rows belong to the list, not to the row's own parent: a run sits in a wrapper.
    const scope = current.closest<HTMLElement>('.gh-list, .gh-repo-list') ?? current.parentElement!;
    const rows = [...scope.querySelectorAll<HTMLElement>(current.classList.contains('gh-repo') ? '.gh-repo' : '.gh-row')];
    const next = rows[rows.indexOf(current) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault(); next.focus();
    if (next.dataset.ghRepo) select(next.dataset.ghRepo);
  };
  root.addEventListener('click', click);
  root.addEventListener('input', input);
  root.addEventListener('change', change);
  root.addEventListener('submit', submit);
  root.addEventListener('keydown', keydown);
  render();
  void loadRepos();
  return {
    render,
    refresh: () => { void loadRepos(true); },
    dispose: () => { disposed = true; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); root.removeEventListener('submit', submit); root.removeEventListener('keydown', keydown); root.replaceChildren(); root.classList.remove('gh-hub'); },
  };
}

function skeleton(rows: number, cls = 'gh-row'): string {
  return `<div class="gh-skeleton" aria-hidden="true">${Array.from({ length: rows }, () => `<span class="${cls} gh-ghost"></span>`).join('')}</div><p class="sr-only" role="status">${t('Loading…')}</p>`;
}
function connectState(error: string): string {
  return emptyState('github', t('Connect GitHub'), `${connectAdvice(error)}<small class="gh-error-detail">${escape(error)}</small>`, `<button type="button" class="secondary-button" data-gh="refresh">${t('Try again')}</button>`);
}
function emptyState(symbol: string, title: string, text: string, action = ''): string {
  return `<div class="gh-empty"><span class="gh-empty-mark">${icon(symbol)}</span><b>${escape(title)}</b><p>${text}</p>${action}</div>`;
}
