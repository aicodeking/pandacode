/* The GitHub view's Actions tab: recent workflow runs with their event, the pull request each
 * belongs to, attempts and duration, filtered by event and pull request (a pull request row's
 * Runs action opens the same filter). A row expands to its jobs and artifacts, read lazily with
 * `github_run_details`: each job's steps and check-run summary, and a re-run's earlier attempts.
 * Runs GitHub couldn't start (`startup_failure`) read "Didn't start". */
import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { age } from './github-hub-prompts';
import { glyph, type HubPull } from './github-hub';

export interface HubRun { id: number; workflow: string; title: string; branch: string; event: string; state: string; createdAt: string; startedAt: string; updatedAt: string; url: string; attempt: number; pulls: number[] }
export interface RunStep { name: string; state: string; startedAt: string; completedAt: string }
/** `summary` is the job's check-run summary as Markdown, bounded natively. */
export interface RunJob { id: number; name: string; state: string; startedAt: string; completedAt: string; url: string; steps: RunStep[]; summary: string }
export interface RunArtifact { name: string; size: number; expired: boolean }
export interface RunAttempt { attempt: number; state: string; startedAt: string; updatedAt: string; url: string; jobs: RunJob[] }
export interface RunDetails { jobs: RunJob[]; artifacts: RunArtifact[]; attempts: RunAttempt[] }
/** `summaries` holds each job summary already rendered to sanitized HTML, by job id. */
export type DetailsLoad = { details?: RunDetails; summaries?: Record<number, string>; error?: string };
/** Event ('' = any), pull request number (0 = any), and whether to keep only each pull request's latest run per workflow. */
export interface RunFilter { event: string; pull: number; latest: boolean }

/** CI states from pull request check rollups, workflow runs and jobs: [tone, label]. */
const STATUS: Record<string, [string, string]> = {
  passing: ['passed', t('Passed')], passed: ['passed', t('Passed')], failing: ['failed', t('Failed')], failed: ['failed', t('Failed')],
  pending: ['running', t('Pending')], in_progress: ['running', t('In progress')], queued: ['queued', t('Queued')], cancelled: ['quiet', t('Cancelled')],
  not_started: ['blocked', t('Didn’t start')],
};
export const statusBadge = (state: string, cls = '', attrs = '') => { const [tone, label] = STATUS[state] ?? ['quiet', state]; return `<span class="gh-status ${cls}" data-status="${tone}" ${attrs}>${escape(label)}</span>`; };
const EVENTS: Record<string, string> = { pull_request: t('Pull request'), pull_request_target: t('Pull request target'), push: t('Push'), schedule: t('Schedule'), workflow_dispatch: t('Manual'), release: t('Release'), merge_group: t('Merge queue') };
const eventLabel = (event: string) => EVENTS[event] ?? event.replace(/_/g, ' ');

/** The pull request a run belongs to: GitHub's link, else an open pull request on the same head branch (forks). */
export function runPull(run: HubRun, pulls: HubPull[] | undefined): number {
  return run.pulls[0] ?? (run.event.startsWith('pull_request') ? pulls?.find(pull => pull.head === run.branch)?.number ?? 0 : 0);
}

/** 45s, 4m 30s, 1h 5m. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
const span = (start: string, end: string, running: boolean, now: number) => {
  const from = Date.parse(start);
  return Number.isFinite(from) ? duration((running ? now : Date.parse(end)) - from) : '';
};
const runDuration = (run: HubRun, now: number) => run.state === 'queued' || run.state === 'not_started' ? '' : span(run.startedAt || run.createdAt, run.updatedAt, run.state === 'in_progress', now);
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Runs matching the filter and search, newest first as GitHub lists them. */
export function filterRuns(runs: HubRun[], pulls: HubPull[] | undefined, filter: RunFilter, query: string): HubRun[] {
  const seen = new Set<string>();
  return runs.filter(run => {
    const pull = runPull(run, pulls);
    if (filter.event && run.event !== filter.event) return false;
    if (filter.pull && pull !== filter.pull) return false;
    if (query && !`${run.id} ${run.workflow} ${run.title} ${run.branch} ${run.state} ${run.event} ${pull ? `#${pull}` : ''}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (!filter.latest) return true;
    const key = `${pull || run.branch}\n${run.workflow}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filters(runs: HubRun[], pulls: HubPull[] | undefined, filter: RunFilter): string {
  const events = [...new Set(runs.map(run => run.event).filter(Boolean))].sort();
  const numbers = [...new Set([...runs.map(run => runPull(run, pulls)).filter(Boolean), ...(filter.pull ? [filter.pull] : [])])].sort((a, b) => b - a);
  const option = (value: string | number, label: string, on: boolean) => `<option value="${escape(String(value))}" ${on ? 'selected' : ''}>${escape(label)}</option>`;
  return `<div class="gh-run-filters">
    <select data-gh-run-filter="event" aria-label="${t('Filter runs by event')}">${option('', t('All events'), !filter.event)}${events.map(event => option(event, eventLabel(event), event === filter.event)).join('')}</select>
    <select data-gh-run-filter="pull" aria-label="${t('Filter runs by pull request')}">${option(0, t('All pull requests'), !filter.pull)}${numbers.map(n => option(n, `#${n}${pulls?.find(pull => pull.number === n) ? ` ${pulls.find(pull => pull.number === n)!.title}` : ''}`, n === filter.pull)).join('')}</select>
    <label class="gh-run-latest"><input type="checkbox" data-gh-run-filter="latest" ${filter.latest ? 'checked' : ''}>${t('Latest per pull request')}</label>
    ${filter.event || filter.pull || filter.latest ? `<button type="button" class="gh-act" data-gh-run-clear>${t('Clear')}</button>` : ''}
    <button type="button" class="gh-act gh-workflow-check" data-gh-workflow-check title="${t('Ask an agent to check .github/workflows for YAML errors, unknown runner labels and missing actions')}">${icon('spark')}${t('Check workflow files')}</button></div>`;
}

function detailsBody(run: HubRun, load: DetailsLoad | undefined, now: number): string {
  const blocked = run.state === 'not_started'
    ? `<p class="gh-note gh-run-blocked">${icon('alert')}${t('GitHub couldn’t start this run. The workflow file is likely invalid (a YAML or schema error), uses an action or reusable workflow that doesn’t exist, or asks for a runner that isn’t available.')}</p>` : '';
  if (!load) return `${blocked}<p class="gh-note" role="status">${t('Loading jobs…')}</p>`;
  if (load.error) return `${blocked}<p class="gh-note">${t`Couldn’t load jobs: ${escape(load.error)}`}</p>`;
  const { jobs, artifacts, attempts = [] } = load.details!;
  const time = (item: { state: string; startedAt: string; completedAt: string }) => escape(item.state === 'queued' ? '' : span(item.startedAt, item.completedAt, item.state === 'in_progress', now));
  const step = (item: RunStep) => `<li class="gh-step">${statusBadge(item.state)}<span class="gh-row-title">${escape(item.name)}</span><span class="gh-duration">${time(item)}</span></li>`;
  const summary = (item: RunJob) => load.summaries?.[item.id] ? `<div class="gh-job-summary md" aria-label="${t`Summary of ${escape(item.name)}`}">${load.summaries[item.id]}</div>` : '';
  const job = (item: RunJob) => `<li class="gh-job"><div class="gh-job-head">${statusBadge(item.state)}<span class="gh-row-title">${escape(item.name)}</span><span class="gh-duration">${time(item)}</span>${item.url ? `<button type="button" class="gh-act" data-gh-open="${escape(item.url)}" aria-label="${t`Open job ${escape(item.name)} on GitHub`}">${icon('external')}</button>` : ''}</div>
    ${item.steps?.length ? `<ol class="gh-steps" aria-label="${t`Steps of ${escape(item.name)}`}">${item.steps.map(step).join('')}</ol>` : ''}${summary(item)}</li>`;
  const attempt = (item: RunAttempt) => `<li class="gh-attempt-item"><div class="gh-job-head">${statusBadge(item.state)}<span class="gh-row-title">${t`Attempt ${item.attempt}`}</span><span class="gh-duration">${escape(span(item.startedAt, item.updatedAt, item.state === 'in_progress', now))}</span>${item.url ? `<button type="button" class="gh-act" data-gh-open="${escape(item.url)}" aria-label="${t`Open attempt ${item.attempt} on GitHub`}">${icon('external')}</button>` : ''}</div>
    ${item.jobs.length ? `<ul>${item.jobs.map(job).join('')}</ul>` : `<p class="gh-note">${t('No jobs ran.')}</p>`}</li>`;
  const artifact = (item: RunArtifact) => `<li class="gh-artifact">${icon('download')}<span class="gh-row-title">${escape(item.name)}</span><span class="gh-duration">${item.expired ? t('Expired') : escape(size(item.size))}</span></li>`;
  return `${blocked}<div class="gh-run-section"><b>${t('Jobs')}${run.attempt > 1 ? t` · attempt ${run.attempt}` : ''}</b>${jobs.length ? `<ul>${jobs.map(job).join('')}</ul>` : `<p class="gh-note">${t('No jobs ran.')}</p>`}</div>
    <div class="gh-run-section"><b>${t('Artifacts')}</b>${artifacts.length ? `<ul>${artifacts.map(artifact).join('')}</ul>` : `<p class="gh-note">${t('No artifacts uploaded.')}</p>`}</div>
    ${attempts.length ? `<div class="gh-run-section gh-attempts"><b>${t('Earlier attempts')}</b><ul>${attempts.map(attempt).join('')}</ul></div>` : ''}`;
}

export function runsBody(runs: HubRun[], pulls: HubPull[] | undefined, filter: RunFilter, query: string, expanded: Set<number>, details: (run: HubRun) => DetailsLoad | undefined, now = Date.now()): string {
  const list = filterRuns(runs, pulls, filter, query);
  const row = (run: HubRun) => {
    const pull = runPull(run, pulls), open = expanded.has(run.id), time = runDuration(run, now);
    const fix = run.state === 'failed' || run.state === 'not_started' ? `<button type="button" class="gh-act gh-primary" data-gh-run-fix>${icon('spark')}${t('Fix')}</button>` : '';
    return `<div class="gh-run-item"><div class="gh-row gh-run" data-gh-run="${run.id}" tabindex="-1">${statusBadge(run.state)}<span class="gh-workflow">${escape(run.workflow)}</span>
        ${pull ? `<button type="button" class="gh-ref gh-run-pull" data-gh-run-pull="${pull}" title="${escape(run.branch)} · ${t`Show runs for #${pull}`}">${glyph('pull')}#${pull}</button>` : ''}<span class="gh-row-title" title="${escape(run.title)}">${escape(run.title)}</span>
        <span class="gh-row-meta"><span class="gh-event" data-event="${escape(run.event)}">${escape(eventLabel(run.event))}</span>${pull ? '' : `<span class="gh-ref" title="${escape(run.branch)}">${glyph('pull')}${escape(run.branch)}</span>`}${run.attempt > 1 ? `<span class="gh-attempt" title="${t`Attempt ${run.attempt}`}">×${run.attempt}</span>` : ''}${time ? `<span class="gh-duration" title="${t('Duration')}">${escape(time)}</span>` : ''}</span>
        <time>${escape(age(run.createdAt))}</time>
        <span class="gh-actions"><button type="button" class="gh-act" data-gh-run-toggle aria-expanded="${open}" aria-controls="gh-run-${run.id}">${icon('chevron')}${t('Details')}</button><button type="button" class="gh-act" data-gh-open="${escape(run.url)}">${icon('external')}${t('Open')}</button>${fix}</span></div>
      ${open ? `<div class="gh-run-details" id="gh-run-${run.id}">${detailsBody(run, details(run), now)}</div>` : ''}</div>`;
  };
  const empty = query || filter.event || filter.pull ? t('No matching runs.') : t('No workflow runs yet.');
  return filters(runs, pulls, filter) + `<div class="gh-list">${list.length ? list.map(row).join('') : `<p class="gh-note">${empty}</p>`}</div>`;
}
