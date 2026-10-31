import './github-pull.css';
import { escape, icon, markdownHtml } from './dom';
import { t } from './i18n.ts';
import { trackSegment } from './motion';
import type { DiffViewerController } from './diff-viewer';
import type { Session } from './types';

/* The task's pull request as a view in the inspector: state, checks, reviews,
 * description, files with their diffs, and commits — read through the user's `gh`. */

export type PullCheck = { name: string; state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'; url: string };
export type PullFile = { path: string; additions: number; deletions: number };
export type PullCommit = { oid: string; headline: string; author: string; date: string };
export type PullComment = { kind: 'comment' | 'review'; author: string; body: string; state: string; createdAt: string };
export type PullDetail = {
  number: number; title: string; body: string; bodyTruncated: boolean; state: string; url: string; author: string;
  base: string; head: string; additions: number; deletions: number; changedFiles: number;
  createdAt: string; updatedAt: string; mergedAt: string; mergeable: string; reviewDecision: string;
  labels: string[]; checks: PullCheck[]; files: PullFile[]; commits: PullCommit[]; timeline: PullComment[];
};
export type PullDiff = { patch: string; truncated: boolean };

export type PullHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openUrl(url: string): Promise<void>;
  /** Remove the link from the task; the inspector falls back to Changes. */
  unlink(session: Session): Promise<void>;
  /** The task came back with its link marked merged. */
  merged(session: Session): void;
  notify(message: string): void;
};

type Section = 'overview' | 'files' | 'commits';
type MergeMethod = 'squash' | 'merge' | 'rebase';
const MERGE_LABEL: Record<MergeMethod, string> = { squash: t('Squash and merge'), merge: t('Create a merge commit'), rebase: t('Rebase and merge') };
const FRESH_FOR = 60_000;
const STATE_LABEL: Record<string, string> = { open: t('Open'), draft: t('Draft'), merged: t('Merged'), closed: t('Closed') };
const REVIEW_LABEL: Record<string, string> = { approved: t('Approved'), changes_requested: t('Changes requested'), review_required: t('Review required') };
const VERDICT_LABEL: Record<string, string> = { approved: t('approved'), changes_requested: t('requested changes'), commented: t('reviewed'), dismissed: t('review dismissed') };

function ago(iso: string): string {
  const at = Date.parse(iso); if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t`${minutes}m ago`;
  if (minutes < 60 * 24) return t`${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 30) return t`${Math.round(minutes / 1440)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One file's section of a multi-file unified diff. */
export function fileSection(patch: string, path: string): string {
  const sections = patch.split(/^(?=diff --git )/m);
  return sections.find(section => { const header = section.slice(0, section.indexOf('\n')); return header.endsWith(` b/${path}`) || header.endsWith(` "b/${path}"`); }) ?? '';
}

function checksSummary(checks: PullCheck[]): { tone: string; text: string } {
  const count = (state: PullCheck['state']) => checks.filter(check => check.state === state).length;
  const failing = count('failure'), pending = count('pending');
  if (failing) return { tone: 'failure', text: checks.length === 1 ? t`${failing} failing of 1 check` : t`${failing} failing of ${checks.length} checks` };
  if (pending) return { tone: 'pending', text: checks.length === 1 ? t`${pending} running of 1 check` : t`${pending} running of ${checks.length} checks` };
  return { tone: 'success', text: checks.length === 1 ? t`1 check passed` : t`${checks.length} checks passed` };
}

export function createPullView(host: PullHost) {
  const details = new Map<string, { at: number; detail: PullDetail }>();
  const diffs = new Map<string, Promise<PullDiff>>();
  let mounted: { key: string; session: Session; root: HTMLElement; section: Section; viewers: Map<string, DiffViewerController>; request: number; merge: 'idle' | 'confirm' | 'merging'; method: MergeMethod } | undefined;
  let requests = 0;

  function dispose(): void {
    mounted?.viewers.forEach(viewer => viewer.dispose());
    mounted = undefined;
  }

  /** Show the task's PR in `target`; a repeat call for the same PR keeps the view as it is. */
  function show(target: HTMLElement, session: Session): void {
    const link = session.pullRequest;
    if (!link) { dispose(); target.innerHTML = `<div class="inspector-empty">${icon('pull')}<h3>${t('No pull request')}</h3><p>${t('Link one from the branch menu.')}</p></div>`; return; }
    const key = `${session.id}:${link.number}`;
    if (mounted?.key === key && mounted.root.parentElement === target) { mounted.session = session; return; }
    dispose();
    const root = document.createElement('div');
    root.className = 'pull-view';
    root.addEventListener('click', event => void onClick(event));
    target.replaceChildren(root);
    mounted = { key, session, root, section: 'overview', viewers: new Map(), request: 0, merge: 'idle', method: 'squash' };
    void load(false);
  }

  async function load(force: boolean): Promise<void> {
    const view = mounted; if (!view) return;
    const hit = details.get(view.key);
    if (hit && !force && Date.now() - hit.at < FRESH_FOR) { await render(view, hit.detail); return; }
    const request = view.request = ++requests;
    if (hit) { await render(view, hit.detail); view.root.setAttribute('aria-busy', 'true'); }
    else view.root.innerHTML = `<div class="inspector-empty" role="status">${icon('pull')}<p>${t`Loading pull request #${view.session.pullRequest?.number ?? ''}…`}</p></div>`;
    try {
      const detail = await host.call<PullDetail>('github_pull_request', { sessionId: view.session.id });
      details.set(view.key, { at: Date.now(), detail });
      if (force) diffs.delete(view.key);
      if (mounted === view && view.request === request) await render(view, detail);
    } catch (error) {
      if (mounted !== view || view.request !== request) return;
      const url = view.session.pullRequest?.url ?? '';
      view.root.innerHTML = `<div class="inspector-empty" role="alert">${icon('alert')}<h3>${t('Unable to load the pull request')}</h3><p class="pull-error">${escape(error instanceof Error ? error.message : String(error))}</p><div class="pull-error-actions"><button class="secondary-button" data-pull-action="refresh">${icon('refresh')}${t('Retry')}</button>${url ? `<button class="secondary-button" data-pull-action="open" data-url="${escape(url)}">${icon('globe')}${t('Open on GitHub')}</button>` : ''}</div></div>`;
    } finally { if (mounted === view && view.request === request) view.root.removeAttribute('aria-busy'); }
  }

  /** Open PRs offer Merge; it asks once for the method before anything reaches GitHub. */
  function mergeControls(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    if (detail.state !== 'open') return '';
    if (detail.mergeable === 'conflicting') return `<div class="pull-merge"><button class="primary-button" disabled title="${t('Resolve the merge conflicts first')}">${icon('pull')}${t('Merge')}</button><small>${t('Resolve the conflicts before merging.')}</small></div>`;
    if (view.merge === 'idle') return `<div class="pull-merge"><button class="primary-button" data-pull-action="merge-start">${icon('pull')}${t('Merge')}</button></div>`;
    const busy = view.merge === 'merging';
    const options = (Object.keys(MERGE_LABEL) as MergeMethod[]).map(method => `<option value="${method}" ${method === view.method ? 'selected' : ''}>${MERGE_LABEL[method]}</option>`).join('');
    return `<div class="pull-merge pull-merge-confirm" role="group" aria-label="${t`Merge pull request #${detail.number}`}">
      <select data-pull-merge-method aria-label="${t('Merge method')}" ${busy ? 'disabled' : ''}>${options}</select>
      <button class="primary-button" data-pull-action="merge-confirm" ${busy ? 'disabled' : ''}>${busy ? t('Merging…') : t('Confirm merge')}</button>
      <button class="secondary-button" data-pull-action="merge-cancel" ${busy ? 'disabled' : ''}>${t('Cancel')}</button>
    </div>`;
  }

  async function merge(view: NonNullable<typeof mounted>): Promise<void> {
    const detail = details.get(view.key)?.detail; if (!detail || view.merge === 'merging') return;
    view.method = (view.root.querySelector<HTMLSelectElement>('[data-pull-merge-method]')?.value as MergeMethod | undefined) ?? view.method;
    view.merge = 'merging'; await render(view, detail);
    try {
      const saved = await host.call<Session>('github_merge_pull_request', { sessionId: view.session.id, method: view.method });
      if (mounted === view) { view.session = saved; view.merge = 'idle'; }
      host.notify(t`Merged pull request #${detail.number}`);
      host.merged(saved);
      if (mounted === view) await load(true);
    } catch (error) {
      if (mounted !== view) return;
      view.merge = 'confirm'; await render(view, detail);
      host.notify(t`Couldn’t merge #${detail.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function header(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    const state = detail.state || 'open';
    const review = REVIEW_LABEL[detail.reviewDecision];
    const checks = detail.checks.length ? checksSummary(detail.checks) : null;
    const conflict = detail.mergeable === 'conflicting' && state === 'open';
    const badges = [
      review ? `<span class="pull-badge pull-review-${escape(detail.reviewDecision)}">${icon(detail.reviewDecision === 'approved' ? 'check' : 'info')}${review}</span>` : '',
      checks ? `<span class="pull-badge pull-tone-${checks.tone}">${icon(checks.tone === 'success' ? 'check' : checks.tone === 'failure' ? 'close' : 'refresh')}${checks.text}</span>` : '',
      conflict ? `<span class="pull-badge pull-tone-failure">${icon('alert')}${t('Merge conflicts')}</span>` : '',
    ].join('');
    return `<header class="pull-header">
      <div class="pull-topline"><span class="pull-state pull-state-${escape(state)}">${icon('pull')}${STATE_LABEL[state] ?? escape(state)}</span><span class="pull-number">#${detail.number}</span>
        <span class="pull-actions"><button class="icon-button" data-pull-action="refresh" aria-label="${t('Refresh pull request')}" title="${t('Refresh')}">${icon('refresh')}</button><button class="icon-button" data-pull-action="open" data-url="${escape(detail.url)}" aria-label="${t('Open on GitHub')}" title="${t('Open on GitHub')}">${icon('globe')}</button><button class="icon-button" data-pull-action="unlink" aria-label="${t('Unlink pull request')}" title="${t('Unlink from this task')}">${icon('close')}</button></span></div>
      <h3 class="pull-title">${escape(detail.title)}</h3>
      <p class="pull-meta">${detail.author ? `<strong>${escape(detail.author)}</strong> · ` : ''}<code title="${escape(detail.head)}">${escape(detail.head)}</code><span class="pull-into" aria-label="${t('into')}">→</span><code>${escape(detail.base)}</code></p>
      <p class="pull-stats"><span class="pull-added">+${detail.additions}</span><span class="pull-removed">−${detail.deletions}</span><span>${detail.changedFiles === 1 ? t`1 file` : t`${detail.changedFiles} files`}</span><span>${detail.commits.length === 1 ? t`1 commit` : t`${detail.commits.length} commits`}</span><span>${escape(state === 'merged' ? t`merged ${ago(detail.mergedAt)}` : t`updated ${ago(detail.updatedAt)}`)}</span></p>
      ${badges ? `<div class="pull-badges">${badges}</div>` : ''}
      ${detail.labels.length ? `<div class="pull-labels">${detail.labels.map(label => `<span>${escape(label)}</span>`).join('')}</div>` : ''}
      ${mergeControls(detail, view)}
    </header>`;
  }

  async function overview(detail: PullDetail): Promise<string> {
    const body = detail.body.trim() ? await markdownHtml(detail.body + (detail.bodyTruncated ? `\n\n*${t('Description shortened; the rest is on GitHub.')}*` : '')) : `<p class="pull-muted">${t('No description provided.')}</p>`;
    const checks = detail.checks.length ? `<section class="pull-section"><h4>${t('Checks')}</h4><ul class="pull-checks">${detail.checks.map(check => `<li class="pull-tone-${escape(check.state)}">${icon(check.state === 'success' ? 'check' : check.state === 'failure' ? 'close' : check.state === 'pending' ? 'refresh' : 'minimize')}${check.url ? `<button data-pull-action="open" data-url="${escape(check.url)}" title="${t('Open details')}">${escape(check.name)}</button>` : `<span>${escape(check.name)}</span>`}</li>`).join('')}</ul></section>` : '';
    const entries = await Promise.all(detail.timeline.map(async entry => {
      const verdict = entry.kind === 'review' ? VERDICT_LABEL[entry.state] ?? t('reviewed') : t('commented');
      const text = entry.body.trim() ? `<div class="pull-comment-body markdown">${await markdownHtml(entry.body)}</div>` : '';
      return `<li class="pull-comment pull-verdict-${escape(entry.state || 'comment')}"><p class="pull-comment-meta"><strong>${escape(entry.author || t('Someone'))}</strong> ${verdict} · ${escape(ago(entry.createdAt))}</p>${text}</li>`;
    }));
    const conversation = entries.length ? `<section class="pull-section"><h4>${t('Conversation')} <small>${entries.length}</small></h4><ol class="pull-timeline">${entries.join('')}</ol></section>` : '';
    return `<section class="pull-section"><h4>${t('Description')}</h4><div class="pull-body markdown">${body}</div></section>${checks}${conversation}`;
  }

  function files(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    if (!detail.files.length) return `<p class="pull-muted pull-pad">${t('No files changed.')}</p>`;
    return `<ul class="pull-files">${detail.files.map(file => {
      const open = view.viewers.has(file.path);
      const name = file.path.split('/').pop() ?? file.path, folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      return `<li><button class="pull-file" data-pull-action="file" data-path="${escape(file.path)}" aria-expanded="${open}">${icon('chevron')}<span class="pull-file-name"><strong>${escape(name)}</strong>${folder ? `<small>${escape(folder)}</small>` : ''}</span><span class="pull-added">+${file.additions}</span><span class="pull-removed">−${file.deletions}</span></button><div class="pull-file-diff" data-diff-path="${escape(file.path)}" ${open ? '' : 'hidden'}></div></li>`;
    }).join('')}</ul>`;
  }

  function commits(detail: PullDetail): string {
    if (!detail.commits.length) return `<p class="pull-muted pull-pad">${t('No commits.')}</p>`;
    return `<ol class="pull-commits">${[...detail.commits].reverse().map(commit => `<li><span class="pull-commit-headline">${escape(commit.headline)}</span><span class="pull-commit-meta"><code>${escape(commit.oid)}</code>${commit.author ? ` · ${escape(commit.author)}` : ''} · ${escape(ago(commit.date))}</span></li>`).join('')}</ol>`;
  }

  async function render(view: NonNullable<typeof mounted>, detail: PullDetail): Promise<void> {
    const content = view.section === 'overview' ? await overview(detail) : view.section === 'files' ? files(detail, view) : commits(detail);
    if (mounted !== view) return;
    view.viewers.forEach(viewer => viewer.dispose()); view.viewers.clear();
    const tab = (id: Section, label: string) => `<button role="tab" data-pull-action="section" data-section="${id}" aria-selected="${view.section === id}">${label}</button>`;
    view.root.innerHTML = `${header(detail, view)}<div class="pull-tabs" role="tablist" aria-label="${t('Pull request sections')}">${tab('overview', t('Overview'))}${tab('files', `${t('Files')} <small>${detail.files.length}</small>`)}${tab('commits', `${t('Commits')} <small>${detail.commits.length}</small>`)}</div><div class="pull-content" role="tabpanel">${content}</div>`;
    const tabs = view.root.querySelector<HTMLElement>('.pull-tabs')!;
    trackSegment(tabs, tabs.querySelector<HTMLElement>('[aria-selected="true"]'));
  }

  async function toggleFile(view: NonNullable<typeof mounted>, button: HTMLButtonElement): Promise<void> {
    const path = button.dataset.path!, diffHost = view.root.querySelector<HTMLElement>(`.pull-file-diff[data-diff-path="${CSS.escape(path)}"]`);
    if (!diffHost) return;
    const viewer = view.viewers.get(path);
    if (viewer) { viewer.dispose(); view.viewers.delete(path); diffHost.hidden = true; diffHost.replaceChildren(); button.setAttribute('aria-expanded', 'false'); return; }
    button.setAttribute('aria-expanded', 'true');
    diffHost.hidden = false; diffHost.innerHTML = `<p class="pull-muted pull-pad" role="status">${t('Loading diff…')}</p>`;
    try {
      let pending = diffs.get(view.key);
      if (!pending) { pending = host.call<PullDiff>('github_pull_request_diff', { sessionId: view.session.id }); diffs.set(view.key, pending); pending.catch(() => diffs.delete(view.key)); }
      const [{ patch, truncated }, { mountDiffViewer }] = await Promise.all([pending, import('./diff-viewer')]);
      if (mounted !== view || !diffHost.isConnected || button.getAttribute('aria-expanded') !== 'true') return;
      const section = fileSection(patch, path);
      if (!section) { diffHost.innerHTML = `<p class="pull-muted pull-pad">${truncated ? t('This diff is too large to show here; open it on GitHub.') : t('No textual changes (binary or renamed file).')}</p>`; return; }
      diffHost.replaceChildren();
      view.viewers.set(path, mountDiffViewer(diffHost, { patch: section, path, layout: 'unified', truncated: false }));
    } catch (error) { if (diffHost.isConnected) diffHost.innerHTML = `<p class="pull-error pull-pad" role="alert">${escape(error instanceof Error ? error.message : String(error))}</p>`; }
  }

  async function onClick(event: MouseEvent): Promise<void> {
    const view = mounted; if (!view) return;
    const target = (event.target as Element).closest<HTMLButtonElement>('[data-pull-action]'); if (!target) return;
    const detail = details.get(view.key)?.detail;
    switch (target.dataset.pullAction) {
      case 'refresh': await load(true); break;
      case 'open': if (target.dataset.url) await host.openUrl(target.dataset.url); break;
      case 'unlink': await host.unlink(view.session); break;
      case 'merge-start': if (detail) { view.merge = 'confirm'; await render(view, detail); view.root.querySelector<HTMLElement>('[data-pull-action="merge-confirm"]')?.focus(); } break;
      case 'merge-cancel': if (detail) { view.merge = 'idle'; await render(view, detail); } break;
      case 'merge-confirm': await merge(view); break;
      case 'section': if (detail) { view.section = target.dataset.section as Section; await render(view, detail); view.root.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); } break;
      case 'file': await toggleFile(view, target); break;
    }
  }

  /** Forget a task's cached PR, e.g. after relinking. */
  function forget(sessionId: string): void {
    for (const key of [...details.keys()]) if (key.startsWith(`${sessionId}:`)) details.delete(key);
    for (const key of [...diffs.keys()]) if (key.startsWith(`${sessionId}:`)) diffs.delete(key);
    if (mounted?.key.startsWith(`${sessionId}:`)) dispose();
  }

  return { show, dispose, forget };
}
