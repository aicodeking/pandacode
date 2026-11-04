import type { Provider } from './types';
import { teamActive, type TeamSnapshot, type TeamWorker } from './architect-types';
import { icon } from './dom';
import { providerLogo } from './provider-logos';
import { fallbackModel } from './model-catalog';

const pending = (worker: TeamWorker): boolean => !worker.abandoned && ['running', 'waiting', 'queued', 'parked'].includes(worker.status);
const workerLabels: Record<TeamWorker['status'], string> = {
  running: 'Working', waiting: 'Needs attention', queued: 'Queued', parked: 'Waiting on sub-workers', completed: 'Completed', failed: 'Failed', stopped: 'Stopped',
};

const signatures = new WeakMap<TeamSnapshot, string>();
/** Everything a snapshot can show (panel, thread lines, sidebar, composer) but its revision and
 *  timestamps, so a snapshot that changed nothing visible repaints nothing. */
export function teamSignature(team: TeamSnapshot): string {
  let signature = signatures.get(team);
  if (signature === undefined) signatures.set(team, signature = JSON.stringify({ ...team, revision: 0, updatedAt: 0, workers: team.workers.map(worker => ({ ...worker, updatedAt: 0 })) }));
  return signature;
}

function text(root: Element, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector)!;
  if (element.textContent !== value) element.textContent = value;
}

/** The workers of lists the reader opened: a redraw, a new worker or the run's end moves a list, and it stays open. */
const openWorkers = new Set<string>();
const listKeys = new WeakMap<HTMLElement, string[]>();
function setOpen(list: HTMLElement, open: boolean): void {
  list.toggleAttribute('data-open', open);
  list.querySelector('.team-progress-toggle')!.setAttribute('aria-expanded', String(open));
}

/** Inline in the thread, one quiet line per spawned worker, like a tool line. Clicking a
 *  line opens that worker in the Architect & workers panel; the rest stay one click away. */
export function updateTeamProgress(host: HTMLElement, team: TeamSnapshot | null | undefined, providers: Provider[], only?: TeamWorker[], needsInput: (sessionId: string) => boolean = () => false): boolean {
  const spawned = only ?? team?.workers ?? [];
  const visible = spawned.length > 0;
  host.hidden = !visible;
  if (!team || !visible) { host.replaceChildren(); return false; }
  let list = host.querySelector<HTMLElement>('.team-progress');
  if (!list || list.dataset.sessionId !== team.sessionId) {
    list = document.createElement('section');
    list.className = 'team-progress'; list.setAttribute('aria-label', 'Team progress');
    list.dataset.sessionId = team.sessionId;
    // The source's Lineage head: a muted label, a running count and a … that opens the team panel.
    list.innerHTML = `<div class="team-progress-head"><button type="button" class="team-progress-toggle" aria-expanded="false">${icon('chevron')}<span class="team-progress-label">Workers</span><span class="team-progress-count"></span></button><button type="button" class="icon-button team-progress-menu" data-action="open-team-progress" aria-label="Open team" title="Open team">${icon('more')}</button></div><button type="button" class="team-progress-more" data-action="open-team-progress" hidden></button>`;
    host.replaceChildren(list);
    const toggle = list.querySelector<HTMLButtonElement>('.team-progress-toggle')!, own = list;
    toggle.addEventListener('click', () => {
      const open = !own.hasAttribute('data-open');
      for (const key of listKeys.get(own) ?? []) { if (open) openWorkers.add(key); else openWorkers.delete(key); }
      setOpen(own, open);
    });
  }
  // Collapsed by default.
  const keys = spawned.map(worker => `${team.sessionId}:${worker.id}`), open = list.hasAttribute('data-open') || keys.some(key => openWorkers.has(key));
  if (open) keys.forEach(key => openWorkers.add(key));
  listKeys.set(list, keys);
  setOpen(list, open);
  list.dataset.status = team.status;
  // Active assignments first, then the latest settled ones; the rest are in the panel.
  const active = spawned.filter(worker => pending(worker) && worker.status !== 'queued');
  const queued = spawned.filter(worker => pending(worker) && worker.status === 'queued');
  const settled = spawned.filter(worker => !pending(worker)).slice().reverse();
  const visibleIds = new Set([...active, ...queued, ...settled].slice(0, 6).map(worker => worker.id));
  const workers = spawned.filter(worker => visibleIds.has(worker.id));
  const rows = new Map([...list.querySelectorAll<HTMLButtonElement>('.team-progress-worker')].map(row => [row.dataset.workerId!, row]));
  for (const [id, row] of rows) if (!visibleIds.has(id)) row.remove();
  workers.forEach((worker, index) => {
    let row = rows.get(worker.id);
    if (!row) {
      row = document.createElement('button'); row.type = 'button'; row.className = 'team-progress-worker';
      row.dataset.action = 'open-team-worker'; row.dataset.workerId = worker.id;
      row.innerHTML = `<span class="team-progress-logo"></span><span class="team-progress-description"><span class="team-progress-verb">Spawned</span> <strong></strong> <small></small></span><span class="team-progress-spinner" aria-hidden="true"></span><span class="team-progress-status"></span>${icon('chevron')}`;
    }
    // Child 0 is the head.
    if (row !== list!.children[index + 1]) list!.insertBefore(row, list!.children[index + 1] ?? null);
    const profile = team.config.workers.find(profile => profile.id === worker.profileId);
    const provider = providers.find(provider => provider.id === worker.provider);
    const model = provider?.models.find(model => model.id === worker.model)?.name ?? fallbackModel(worker.provider, worker.model).name;
    // Auto teams name a profile after its model and harness: show each fact once, and leave the
    // harness to the logo.
    const harness = provider?.name ?? worker.provider;
    const detail = [...new Set([profile?.name !== worker.name ? profile?.name ?? '' : '', model].flatMap(part => part.split(' · ')).map(part => part.trim()))]
      .filter(part => part && part !== harness && part !== worker.name);
    // An approval or question waits only in the worker's live stream, not in its saved status.
    const status = worker.abandoned ? 'Skipped' : !teamActive(team) && pending(worker) ? 'Paused' : worker.status === 'running' && needsInput(worker.sessionId) ? 'Needs attention' : workerLabels[worker.status];
    text(row, '.team-progress-description strong', worker.name);
    text(row, '.team-progress-description small', detail.join(' · '));
    text(row, '.team-progress-status', status);
    row.dataset.status = status;
    row.title = worker.assignment;
    if (row.dataset.provider !== worker.provider) {
      row.querySelector('.team-progress-logo')!.innerHTML = providerLogo(worker.provider);
      row.dataset.provider = worker.provider;
    }
  });
  const running = spawned.filter(worker => worker.status === 'running' && !worker.abandoned && teamActive(team)).length;
  // Collapsed, the count is all that shows, so it says first what needs the reader.
  const asking = spawned.filter(worker => !worker.abandoned && (worker.status === 'waiting' || (worker.status === 'running' && needsInput(worker.sessionId)))).length;
  const failed = spawned.filter(worker => worker.status === 'failed' && !worker.abandoned).length;
  text(list, '.team-progress-count', asking ? `${asking} need${asking === 1 ? 's' : ''} attention` : failed ? `${failed} failed` : running ? `${running} running` : `${spawned.length} ${spawned.length === 1 ? 'worker' : 'workers'}`);
  const tone = asking ? 'warn' : failed ? 'danger' : running ? 'team' : '';
  if ((list.dataset.countTone ?? '') !== tone) list.dataset.countTone = tone;
  const more = list.querySelector<HTMLButtonElement>('.team-progress-more')!;
  const remaining = spawned.length - workers.length;
  more.hidden = remaining === 0;
  text(list, '.team-progress-more', remaining ? `${remaining} more ${remaining === 1 ? 'worker' : 'workers'}` : '');
  if (more !== list.lastElementChild) list.append(more);
  return true;
}
