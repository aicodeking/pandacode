import './github-pull.css';
import { escape, icon, markdownHtml } from './dom';
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
const MERGE_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const FRESH_FOR = 60_000;
/* Status marks are circled glyphs, as in the reference's checks card. */
const MARK: Record<string, string> = { check: 'm8.5 12.2 2.4 2.3 4.6-5', close: 'm9.5 9.5 5 5m0-5-5 5', pending: 'M12 8v4l2.5 1.5', info: 'M12 11v5M12 8v.01', alert: 'M12 7.5v5M12 16v.01' };
const circled = (glyph: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="${MARK[glyph] ?? MARK.info}"/></svg>`;
const METHOD_WORD: Record<MergeMethod, string> = { squash: 'squash', merge: 'merge commit', rebase: 'rebase' };
const STATE_LABEL: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const REVIEW_LABEL: Record<string, string> = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required' };
const VERDICT_LABEL: Record<string, string> = { approved: 'approved', changes_requested: 'requested changes', commented: 'reviewed', dismissed: 'review dismissed' };

function ago(iso: string): string {
  const at = Date.parse(iso); if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 30) return `${Math.round(minutes / 1440)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One file's section of a multi-file unified diff. */
export function fileSection(patch: string, path: string): string {
  const sections = patch.split(/^(?=diff --git )/m);
  return sections.find(section => { const header = section.slice(0, section.indexOf('\n')); return header.endsWith(` b/${path}`) || header.endsWith(` "b/${path}"`); }) ?? '';
}

function checksSummary(checks: PullCheck[]): { tone: string; text: string } {
  const count = (state: PullCheck['state']) => checks.filter(check => check.state === state).length;
  const failing = count('failure'), pending = count('pending');
  if (failing) return { tone: 'failure', text: `${failing} failing of ${plural(checks.length, 'check')}` };
  if (pending) return { tone: 'pending', text: `${pending} running of ${plural(checks.length, 'check')}` };
  return { tone: 'success', text: `${plural(checks.length, 'check')} passed` };
}

export function createPullView(host: PullHost) {
  const details = new Map<string, { at: number; detail: PullDetail }>();
  const diffs = new Map<string, Promise<PullDiff>>();
  let mounted: { key: string; session: Session; root: HTMLElement; section: Section; viewers: Map<string, DiffViewerController>; request: number; merge: 'idle' | 'confirm' | 'merging'; method: MergeMethod; checks: boolean } | undefined;
  let requests = 0;

  function dispose(): void {
    mounted?.viewers.forEach(viewer => viewer.dispose());
    mounted = undefined;
  }

  /** Show the task's PR in `target`; a repeat call for the same PR keeps the view as it is. */
  function show(target: HTMLElement, session: Session): void {
    const link = session.pullRequest;
    if (!link) { dispose(); target.innerHTML = `<div class="inspector-empty">${icon('pull')}<h3>No pull request</h3><p>Link one from the branch menu.</p></div>`; return; }
    const key = `${session.id}:${link.number}`;
    if (mounted?.key === key && mounted.root.parentElement === target) { mounted.session = session; return; }
    dispose();
    const root = document.createElement('div');
    root.className = 'pull-view';
    root.addEventListener('click', event => void onClick(event));
    target.replaceChildren(root);
    mounted = { key, session, root, section: 'overview', viewers: new Map(), request: 0, merge: 'idle', method: 'squash', checks: false };
    void load(false);
  }

  async function load(force: boolean): Promise<void> {
    const view = mounted; if (!view) return;
    const hit = details.get(view.key);
    if (hit && !force && Date.now() - hit.at < FRESH_FOR) { await render(view, hit.detail); return; }
    const request = view.request = ++requests;
    if (hit) { await render(view, hit.detail); view.root.setAttribute('aria-busy', 'true'); }
    else view.root.innerHTML = `<div class="inspector-empty" role="status">${icon('pull')}<p>Loading pull request #${view.session.pullRequest?.number ?? ''}…</p></div>`;
    try {
      const detail = await host.call<PullDetail>('github_pull_request', { sessionId: view.session.id });
      details.set(view.key, { at: Date.now(), detail });
      if (force) diffs.delete(view.key);
      if (mounted === view && view.request === request) await render(view, detail);
    } catch (error) {
      if (mounted !== view || view.request !== request) return;
      const url = view.session.pullRequest?.url ?? '';
      view.root.innerHTML = `<div class="inspector-empty" role="alert">${icon('alert')}<h3>Unable to load the pull request</h3><p class="pull-error">${escape(error instanceof Error ? error.message : String(error))}</p><div class="pull-error-actions"><button class="secondary-button" data-pull-action="refresh">${icon('refresh')}Retry</button>${url ? `<button class="secondary-button" data-pull-action="open" data-url="${escape(url)}">${icon('globe')}Open on GitHub</button>` : ''}</div></div>`;
    } finally { if (mounted === view && view.request === request) view.root.removeAttribute('aria-busy'); }
  }

  /** Open PRs offer Merge; it asks once for the method before anything reaches GitHub. */
  function mergeControls(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    if (detail.state !== 'open') return '';
    if (detail.mergeable === 'conflicting') return `<div class="pull-merge"><button class="ds-btn-primary pull-merge-main" disabled aria-label="Merge: ${MERGE_LABEL[view.method]}" title="Resolve the merge conflicts first">${icon('merge')}${MERGE_LABEL[view.method]}</button><small>Resolve the conflicts before merging.</small></div>`;
    if (view.merge === 'idle') return `<div class="pull-merge"><div class="ds-btn-split"><button class="ds-btn-primary pull-merge-main" data-pull-action="merge-start" aria-label="Merge: ${MERGE_LABEL[view.method]}" title="${escape(MERGE_LABEL[view.method])}">${icon('merge')}${MERGE_LABEL[view.method]}</button><button class="ds-btn-primary" data-pull-action="merge-method" aria-label="Choose merge method" aria-haspopup="menu" aria-expanded="false">${icon('down')}</button></div></div>`;
    const busy = view.merge === 'merging';
    const options = (Object.keys(MERGE_LABEL) as MergeMethod[]).map(method => `<option value="${method}" ${method === view.method ? 'selected' : ''}>${MERGE_LABEL[method]}</option>`).join('');
    return `<div class="pull-merge pull-merge-confirm" role="group" aria-label="Merge pull request #${detail.number}">
      <select data-pull-merge-method aria-label="Merge method" ${busy ? 'disabled' : ''}>${options}</select>
      <div class="ds-btn-split"><button class="ds-btn-primary pull-merge-main" data-pull-action="merge-confirm" ${busy ? 'disabled' : ''}>${icon('merge')}${busy ? 'Merging…' : `Confirm merge`}</button>
      <button class="ds-btn" data-pull-action="merge-cancel" ${busy ? 'disabled' : ''}>Cancel</button></div>
    </div>`;
  }

  async function merge(view: NonNullable<typeof mounted>): Promise<void> {
    const detail = details.get(view.key)?.detail; if (!detail || view.merge === 'merging') return;
    view.method = (view.root.querySelector<HTMLSelectElement>('[data-pull-merge-method]')?.value as MergeMethod | undefined) ?? view.method;
    view.merge = 'merging'; await render(view, detail);
    try {
      const saved = await host.call<Session>('github_merge_pull_request', { sessionId: view.session.id, method: view.method });
      if (mounted === view) { view.session = saved; view.merge = 'idle'; }
      host.notify(`Merged pull request #${detail.number}`);
      host.merged(saved);
      if (mounted === view) await load(true);
    } catch (error) {
      if (mounted !== view) return;
      view.merge = 'confirm'; await render(view, detail);
      host.notify(`Couldn’t merge #${detail.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function header(detail: PullDetail): string {
    const state = detail.state || 'open';
    const age = ago(state === 'merged' ? detail.mergedAt : detail.createdAt);
    const avatar = detail.author ? `<span class="ds-avatar pull-avatar" aria-hidden="true">${escape(detail.author.slice(0, 1).toUpperCase())}</span><strong>${escape(detail.author)}</strong>` : '';
    return `<header class="pull-header">
      <div class="pull-topline"><span class="pull-state pull-state-${escape(state)}"><span class="ds-dot"></span>${STATE_LABEL[state] ?? escape(state)}</span><span class="pull-number">#${detail.number}</span>
        <span class="pull-actions"><button class="icon-button" data-pull-action="refresh" aria-label="Refresh pull request" title="Refresh">${icon('refresh')}</button><button class="icon-button" data-pull-action="open" data-url="${escape(detail.url)}" aria-label="Open on GitHub" title="Open on GitHub">${icon('external')}</button><button class="icon-button" data-pull-action="unlink" aria-label="Unlink pull request" title="Unlink from this task">${icon('close')}</button></span></div>
      <h3 class="pull-title ds-title">${escape(detail.title)}</h3>
      <div class="pull-meta"><span class="pull-author">${avatar}${age ? `<span>${escape(state === 'merged' ? `merged ${age}` : age)}</span>` : ''}</span><span class="pull-refs"><code class="ds-chip" title="${escape(detail.base)}">${escape(detail.base)}</code><span class="pull-into">${icon('back')}<span class="sr-only">from</span></span><code class="ds-chip" title="${escape(detail.head)}">${escape(detail.head)}</code></span></div>
      ${detail.labels.length ? `<div class="pull-labels">${detail.labels.map(label => `<span class="ds-chip ds-chip-text pull-label">${escape(label)}</span>`).join('')}</div>` : ''}
    </header>`;
  }

  /** The status card: checks, review and mergeability as rows, the merge action nested below. */
  function statusCard(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    const rows: string[] = [];
    const mark = (tone: string, glyph: string) => `<span class="ds-row-icon pull-tone-${tone}">${circled(glyph)}</span>`;
    const chevron = `<span class="ds-row-trail pull-chevron">${icon('chevron')}</span>`;
    if (detail.checks.length) {
      const summary = checksSummary(detail.checks), passed = detail.checks.filter(check => check.state === 'success').length;
      const glyph = summary.tone === 'success' ? 'check' : summary.tone === 'failure' ? 'close' : 'pending';
      rows.push(`<button class="ds-row pull-checks-toggle" data-pull-action="checks" aria-expanded="${view.checks}">${mark(summary.tone, glyph)}<span class="ds-row-main"><span class="ds-row-title">${summary.tone === 'success' ? 'All checks passed' : summary.tone === 'failure' ? 'Checks failing' : 'Checks running'}</span>${summary.tone === 'success' ? '' : `<span class="ds-row-sub pull-tone-${summary.tone}">${summary.text}</span>`}</span>${summary.tone === 'success' ? `<span class="ds-row-meta">${passed} of ${detail.checks.length}</span>` : ''}${chevron}</button>`);
      if (view.checks) rows.push(`<ul class="pull-checks">${detail.checks.map(check => {
        const glyph = check.state === 'success' ? 'check' : check.state === 'failure' ? 'close' : check.state === 'pending' ? 'refresh' : 'minimize';
        const inner = `<span class="pull-check-icon pull-tone-${escape(check.state)}">${icon(glyph)}</span><span class="ds-row-title">${escape(check.name)}</span>${check.url ? `<span class="ds-row-trail">${icon('external')}</span>` : ''}`;
        return `<li>${check.url ? `<button class="ds-row" data-pull-action="open" data-url="${escape(check.url)}" title="Open details">${inner}</button>` : `<span class="ds-row">${inner}</span>`}</li>`;
      }).join('')}</ul>`);
    }
    const review = REVIEW_LABEL[detail.reviewDecision];
    if (review) {
      const approver = [...detail.timeline].reverse().find(entry => entry.kind === 'review' && entry.state === detail.reviewDecision)?.author;
      const tone = detail.reviewDecision === 'approved' ? 'success' : detail.reviewDecision === 'changes_requested' ? 'failure' : 'pending';
      const title = approver && detail.reviewDecision !== 'review_required' ? `${review} by ${approver}` : review;
      rows.push(`<button class="ds-row pull-review-${escape(detail.reviewDecision)}" data-pull-action="open" data-url="${escape(detail.url)}" title="Reviews on GitHub">${mark(tone, tone === 'success' ? 'check' : tone === 'failure' ? 'close' : 'info')}<span class="ds-row-main"><span class="ds-row-title">${escape(title)}</span></span>${chevron}</button>`);
    }
    if (detail.state === 'open') {
      const conflict = detail.mergeable === 'conflicting', known = detail.mergeable === 'mergeable';
      rows.push(`<button class="ds-row" data-pull-action="section" data-section="commits" title="Show commits">${mark(conflict ? 'failure' : known ? 'success' : 'pending', conflict ? 'alert' : known ? 'check' : 'pending')}<span class="ds-row-main"><span class="ds-row-title">${conflict ? 'Merge conflicts' : known ? `No conflicts with ${escape(detail.base)}` : 'Checking for conflicts'}</span></span><span class="ds-row-meta pull-merge-meta">${METHOD_WORD[view.method]} · ${plural(detail.commits.length, 'commit')}</span>${chevron}</button>`);
    }
    const merge = mergeControls(detail, view);
    return rows.length || merge ? `<div class="pull-status ds-card">${rows.join('')}${merge}</div>` : '';
  }

  async function overview(detail: PullDetail, view: NonNullable<typeof mounted>): Promise<string> {
    const body = detail.body.trim() ? await markdownHtml(detail.body + (detail.bodyTruncated ? '\n\n*Description shortened; the rest is on GitHub.*' : '')) : '<p class="pull-muted">No description provided.</p>';
    const entries = await Promise.all(detail.timeline.map(async entry => {
      const verdict = entry.kind === 'review' ? VERDICT_LABEL[entry.state] ?? 'reviewed' : 'commented';
      const text = entry.body.trim() ? `<div class="pull-comment-body markdown">${await markdownHtml(entry.body)}</div>` : '';
      return `<li class="pull-comment pull-verdict-${escape(entry.state || 'comment')}"><p class="pull-comment-meta"><span class="pull-avatar" aria-hidden="true">${escape((entry.author || '?').slice(0, 1).toUpperCase())}</span><span><strong>${escape(entry.author || 'Someone')}</strong> ${verdict} · ${escape(ago(entry.createdAt))}</span></p>${text}</li>`;
    }));
    const stats = `<span class="pull-added">+${detail.additions}</span> <span class="pull-removed">−${detail.deletions}</span> · ${plural(detail.changedFiles, 'file')}`;
    const conversation = entries.length ? `<section class="pull-section"><div class="pull-section-head"><h4>Conversation <span class="pull-count">${entries.length}</span></h4></div><ol class="pull-timeline ds-card">${entries.join('')}</ol></section>` : '';
    return `${statusCard(detail, view)}<section class="pull-section"><div class="pull-section-head"><h4>Description</h4>${icon('chevron')}<span class="ds-row-meta pull-stats">${stats}</span><button class="icon-button" data-pull-action="open" data-url="${escape(detail.url)}" aria-label="Edit description on GitHub" title="Edit on GitHub">${icon('edit')}</button></div><div class="pull-body markdown">${body}</div></section>${conversation}`;
  }

  function files(detail: PullDetail, view: NonNullable<typeof mounted>): string {
    if (!detail.files.length) return '<p class="pull-muted pull-pad">No files changed.</p>';
    return `<ul class="pull-files ds-card">${detail.files.map(file => {
      const open = view.viewers.has(file.path);
      const name = file.path.split('/').pop() ?? file.path, folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      return `<li><button class="pull-file ds-row" data-pull-action="file" data-path="${escape(file.path)}" aria-expanded="${open}">${icon('chevron')}<span class="pull-file-name ds-row-main"><strong class="ds-row-title">${escape(name)}</strong>${folder ? `<small class="ds-row-sub">${escape(folder)}</small>` : ''}</span><span class="pull-added">+${file.additions}</span><span class="pull-removed">−${file.deletions}</span></button><div class="pull-file-diff" data-diff-path="${escape(file.path)}" ${open ? '' : 'hidden'}></div></li>`;
    }).join('')}</ul>`;
  }

  function commits(detail: PullDetail): string {
    if (!detail.commits.length) return '<p class="pull-muted pull-pad">No commits.</p>';
    return `<ol class="pull-commits ds-card">${[...detail.commits].reverse().map(commit => `<li class="ds-row"><span class="ds-row-icon">${icon('circle')}</span><span class="ds-row-main"><span class="pull-commit-headline ds-row-title">${escape(commit.headline)}</span><span class="pull-commit-meta ds-row-sub"><code>${escape(commit.oid)}</code>${commit.author ? ` · ${escape(commit.author)}` : ''} · ${escape(ago(commit.date))}</span></span></li>`).join('')}</ol>`;
  }

  const sectionHtml = async (view: NonNullable<typeof mounted>, detail: PullDetail): Promise<string> =>
    view.section === 'overview' ? overview(detail, view) : view.section === 'files' ? files(detail, view) : commits(detail);

  /** A section change keeps the header and tablist, so the segment thumb slides; only the panel is replaced. */
  async function showSection(view: NonNullable<typeof mounted>, detail: PullDetail): Promise<void> {
    const tabs = view.root.querySelector<HTMLElement>('.pull-tabs'), panel = view.root.querySelector<HTMLElement>('.pull-content');
    if (!tabs || !panel) { await render(view, detail); return; }
    const section = view.section;
    tabs.querySelectorAll<HTMLElement>('[role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.section === section)));
    trackSegment(tabs, tabs.querySelector<HTMLElement>('[aria-selected="true"]'));
    const content = await sectionHtml(view, detail);
    if (mounted !== view || view.section !== section) return;
    view.viewers.forEach(viewer => viewer.dispose()); view.viewers.clear();
    panel.innerHTML = content;
  }

  async function render(view: NonNullable<typeof mounted>, detail: PullDetail): Promise<void> {
    const content = await sectionHtml(view, detail);
    if (mounted !== view) return;
    view.viewers.forEach(viewer => viewer.dispose()); view.viewers.clear();
    const tab = (id: Section, label: string, count?: number) => `<button role="tab" data-pull-action="section" data-section="${id}" aria-selected="${view.section === id}"${count === undefined ? '' : ` title="${escape(`${label}: ${count}`)}"`}>${label}</button>`;
    view.root.innerHTML = `${header(detail)}<div class="pull-tabs ds-seg" role="tablist" aria-label="Pull request sections">${tab('overview', 'Summary')}${tab('commits', 'Commits', detail.commits.length)}${tab('files', 'Files', detail.files.length)}</div><div class="pull-content" role="tabpanel">${content}</div>`;
    const tabs = view.root.querySelector<HTMLElement>('.pull-tabs')!;
    trackSegment(tabs, tabs.querySelector<HTMLElement>('[aria-selected="true"]'));
  }

  async function toggleFile(view: NonNullable<typeof mounted>, button: HTMLButtonElement): Promise<void> {
    const path = button.dataset.path!, diffHost = view.root.querySelector<HTMLElement>(`.pull-file-diff[data-diff-path="${CSS.escape(path)}"]`);
    if (!diffHost) return;
    const viewer = view.viewers.get(path);
    if (viewer) { viewer.dispose(); view.viewers.delete(path); diffHost.hidden = true; diffHost.replaceChildren(); button.setAttribute('aria-expanded', 'false'); return; }
    button.setAttribute('aria-expanded', 'true');
    diffHost.hidden = false; diffHost.innerHTML = '<p class="pull-muted pull-pad" role="status">Loading diff…</p>';
    try {
      let pending = diffs.get(view.key);
      if (!pending) { pending = host.call<PullDiff>('github_pull_request_diff', { sessionId: view.session.id }); diffs.set(view.key, pending); pending.catch(() => diffs.delete(view.key)); }
      const [{ patch, truncated }, { mountDiffViewer }] = await Promise.all([pending, import('./diff-viewer')]);
      if (mounted !== view || !diffHost.isConnected || button.getAttribute('aria-expanded') !== 'true') return;
      const section = fileSection(patch, path);
      if (!section) { diffHost.innerHTML = `<p class="pull-muted pull-pad">${truncated ? 'This diff is too large to show here; open it on GitHub.' : 'No textual changes (binary or renamed file).'}</p>`; return; }
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
      case 'merge-start': if (detail) { view.merge = 'confirm'; await render(view, detail); view.root.querySelector<HTMLElement>('[data-pull-action="merge-cancel"]')?.focus(); } break;
      case 'merge-method': { const { openChoiceMenu } = await import('./choice-menu'); if (mounted !== view || !target.isConnected) break; openChoiceMenu({ anchor: target, title: 'Merge method', items: (Object.keys(MERGE_LABEL) as MergeMethod[]).map(method => ({ id: method, label: MERGE_LABEL[method], icon: 'merge', selected: method === view.method })), onSelect: async id => { view.method = id as MergeMethod; if (detail && mounted === view) { await render(view, detail); view.root.querySelector<HTMLElement>('[data-pull-action="merge-method"]')?.focus(); } }, onClose: () => { if (target.isConnected) target.focus(); } }); break; }
      case 'merge-cancel': if (detail) { view.merge = 'idle'; await render(view, detail); view.root.querySelector<HTMLElement>('[data-pull-action="merge-start"]')?.focus(); } break;
      case 'merge-confirm': await merge(view); break;
      case 'section': if (detail && target.dataset.section !== view.section) { view.section = target.dataset.section as Section; await showSection(view, detail); } break;
      case 'file': await toggleFile(view, target); break;
      case 'checks': if (detail) { view.checks = !view.checks; await showSection(view, detail); view.root.querySelector<HTMLElement>('[data-pull-action="checks"]')?.focus(); } break;
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
