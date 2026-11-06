import './jev-live.css';
import { call, subscribe } from './bridge';
import { t } from './i18n.ts';
import { escape, icon } from './dom';
import type { JevReport } from './jev';

export interface JevFrame {
  sessionId: string; runId: string; sequence: number; dataUrl: string;
  width: number; height: number; elapsedMs: number;
}
export interface JevLiveView {
  watch(runId?: string): Promise<void>;
  url(): string | undefined;
  refresh(): void;
  leave(): void;
  close(): Promise<void>;
}
type Options = { session(): string | undefined; changed(watching: boolean, available: boolean): void; returned(): void };
const active = (report?: JevReport) => report?.status === 'starting' || report?.status === 'running';
const statuses: Record<JevReport['status'], string> = { starting: t('Starting browser'), running: t('Testing'), done: t('Finished'), blocked: t('Blocked'), failed: t('Test failed'), cancelled: t('Cancelled'), limit: t('Limit reached') };
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function validImage(value: unknown, live = false): value is string {
  return typeof value === 'string' && value.length <= (live ? 350_000 : 2_800_000)
    && (live ? /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/ : /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).test(value);
}

/** A read-only view of Jev's isolated Chrome, with one ephemeral frame in memory. */
export async function mountJevLive(host: HTMLElement, options: Options): Promise<JevLiveView> {
  host.className = 'jev-live'; host.hidden = true;
  host.setAttribute('role', 'region'); host.setAttribute('aria-label', t('Jev live browser'));
  host.innerHTML = `<header class="jev-live-heading"><span class="jev-live-mark">${icon('spark')}</span><strong>Jev</strong><span class="jev-live-status" role="status"></span><button type="button" class="jev-live-stop" data-jev-live-stop>${icon('stop')}${t('Stop test')}</button><button type="button" class="browser-tool" data-jev-live-return aria-label="${t('Return to browser')}" title="${t('Return to browser')}">${icon('back')}</button></header>
    <div class="jev-live-run-picker" hidden><select aria-label="${t('Jev run')}"></select>${icon('down')}</div>
    <div class="jev-live-context"><strong class="jev-live-goal"></strong><span class="jev-live-url"></span></div>
    <figure class="jev-live-screen"><img alt="${t('Jev browser live view')}" hidden><div class="jev-live-waiting">${icon('globe')}<span>${t('Waiting for the browser…')}</span></div><figcaption>${t('Live browser · read only')}</figcaption></figure>
    <div class="jev-live-progress"><span class="jev-live-step"></span><p class="jev-live-current"></p></div>
    <p class="jev-live-error" role="status" hidden></p>
    <details class="jev-live-timeline"><summary>${t('Browser actions')} <span class="jev-live-count">0</span>${icon('down')}</summary><ol></ol><p class="jev-live-no-actions">${t('Actions will appear as Jev works.')}</p></details>`;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const image = query<HTMLImageElement>('img'), selector = query<HTMLSelectElement>('select');
  const timeline = query<HTMLDetailsElement>('.jev-live-timeline'), stopButton = query<HTMLButtonElement>('[data-jev-live-stop]');
  const reports = new Map<string, JevReport>(), eventVersions = new Map<string, number>();
  // Dismissing a view must not be undone by the next event from the same test.
  const dismissed = new Set<string>();
  const manualAfter = new Map<string, number>();
  let disposed = false, session: string | undefined, selected: string | undefined, revision = 0, eventVersion = 0;
  let listPending: Promise<void> | undefined, stopping: string | undefined, finalRead: string | undefined;
  let sequence = -1, pendingFrame: JevFrame | undefined, frameTimer = 0, lastPaint = 0, timelineKey = '', optionKey = '';
  let lease: { sessionId: string; runId: string } | undefined, leaseTimer = 0, leaseQueue = Promise.resolve();
  const renewals = new Set<object>();
  const current = () => selected ? reports.get(selected) : undefined;
  const wasDismissed = (report: JevReport) => dismissed.has(report.id) || report.createdAt <= (manualAfter.get(report.sessionId) ?? -Infinity);
  const alive = (ticket: number, task: string | undefined) => !disposed && ticket === revision && task === session && task === options.session();
  function tell(message: string) { query('.jev-live-error').textContent = message; query('.jev-live-error').hidden = !message; }
  function notify() { options.changed(Boolean(selected), reports.size > 0); }
  function resetFrame() {
    clearTimeout(frameTimer); frameTimer = 0; pendingFrame = undefined; sequence = -1; lastPaint = 0;
    image.removeAttribute('src'); image.hidden = true; query('.jev-live-waiting').hidden = false;
  }
  function setImage(dataUrl: string) {
    if (image.getAttribute('src') !== dataUrl) image.src = dataUrl;
    image.hidden = false; query('.jev-live-waiting').hidden = true;
  }
  function commandLease(target: { sessionId: string; runId: string }, watching: boolean) {
    if (watching && renewals.has(target)) return;
    if (watching) renewals.add(target);
    leaseQueue = leaseQueue.then(() => call('jev_watch_run', { ...target, watching })).then(() => {}, error => {
      if (!disposed && watching && lease === target && session === options.session()) tell(errorText(error));
    }).finally(() => { if (watching) renewals.delete(target); });
  }
  function syncLease() {
    const report = current(), wanted = !disposed && !document.hidden && session === options.session() && active(report) ? report : undefined;
    if (lease?.runId === wanted?.id && lease?.sessionId === wanted?.sessionId) return;
    clearInterval(leaseTimer); leaseTimer = 0;
    if (lease) commandLease(lease, false);
    lease = wanted ? { sessionId: wanted.sessionId, runId: wanted.id } : undefined;
    if (lease) {
      commandLease(lease, true);
      leaseTimer = window.setInterval(() => { if (lease) commandLease(lease, true); }, 5000);
    }
  }
  function showTimeline() {
    const events = current()?.events ?? [];
    if (!timeline.open) return;
    const key = JSON.stringify(events);
    if (timelineKey === key) return;
    timelineKey = key;
    query('ol').innerHTML = events.map(event => `<li><span class="jev-live-action-step">${escape(event.step)}</span><div><strong>${escape(event.operation.replaceAll('_', ' '))}</strong>${event.target ? `<span>${escape(event.target)}</span>` : ''}${event.url ? `<small>${escape(event.url)}</small>` : ''}</div><time>${duration(event.elapsedMs)}</time></li>`).join('');
    query('.jev-live-no-actions').hidden = events.length > 0;
  }
  function render() {
    if (disposed) return;
    const report = current(); host.hidden = !report;
    const ordered = [...reports.values()].sort((a, b) => b.createdAt - a.createdAt);
    const optionsKey = JSON.stringify(ordered.map(run => [run.id, run.goal, run.status]));
    if (optionKey !== optionsKey) {
      optionKey = optionsKey;
      selector.replaceChildren(...ordered.map(run => new Option(t`${statuses[run.status]} · ${run.goal || run.url}`, run.id)));
    }
    selector.value = selected ?? ''; query('.jev-live-run-picker').hidden = reports.size < 2;
    if (!report) { syncLease(); notify(); return; }
    const running = active(report), last = report.events.at(-1);
    query('.jev-live-status').textContent = t`${statuses[report.status]} · ${duration(report.durationMs)}`;
    host.dataset.running = String(running);
    query('.jev-live-goal').textContent = report.goal;
    query('.jev-live-url').textContent = last?.url || report.url;
    query('.jev-live-url').title = last?.url || report.url;
    query('.jev-live-step').textContent = report.steps ? t`Step ${report.steps}` : t('Getting ready');
    query('.jev-live-current').textContent = running && last ? `${last.operation.replaceAll('_', ' ')}${last.target ? ` · ${last.target}` : ''}` : report.summary;
    query('.jev-live-count').textContent = String(report.events.length);
    query('figcaption').textContent = running ? t('Live browser · read only') : t('Final browser view · read only');
    query('.jev-live-waiting span').textContent = running ? t('Waiting for the browser…') : t('No browser image available');
    stopButton.hidden = !running; stopButton.disabled = stopping === report.id;
    if (!running && validImage(report.screenshot)) setImage(report.screenshot);
    showTimeline(); syncLease(); notify();
  }
  function choose(runId: string) {
    if (!reports.has(runId) || disposed) return;
    if (selected !== runId) {
      const previous = current(); if (previous?.screenshot) reports.set(previous.id, { ...previous, screenshot: undefined });
      resetFrame(); timelineKey = ''; query('ol').replaceChildren(); timeline.open = false; tell('');
    }
    selected = runId; finalRead = undefined; render();
    void readFinal();
  }
  function autoWatch() {
    if (selected) return;
    const next = [...reports.values()].filter(run => active(run) && !wasDismissed(run)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (next) choose(next.id); else render();
  }
  function retain(report: JevReport) {
    const previous = reports.get(report.id);
    if (previous && (!active(previous) && active(report) || active(previous) && active(report)
      && (report.durationMs < previous.durationMs || report.events.length < previous.events.length || previous.status === 'running' && report.status === 'starting'))) return;
    reports.set(report.id, previous?.screenshot && !report.screenshot ? { ...report, screenshot: previous.screenshot } : report);
    // Native history is bounded too; never retain an unbounded stream of completed reports.
    if (reports.size > 100) for (const old of [...reports.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (old.id !== selected && !active(old)) { reports.delete(old.id); eventVersions.delete(old.id); break; }
    }
  }
  async function readFinal() {
    const report = current();
    if (!report || active(report) || report.screenshot || finalRead === report.id) return;
    finalRead = report.id;
    const ticket = revision, task = session;
    try {
      const result = await call<JevReport>('jev_read_run', { sessionId: task, runId: report.id });
      if (!alive(ticket, task) || selected !== report.id || result.sessionId !== task || result.id !== report.id) return;
      // A late disk read must not roll newer report events back.
      if (validImage(result.screenshot)) { const latest = current(); if (latest && !active(latest)) { latest.screenshot = result.screenshot; render(); } }
    } catch (error) { if (alive(ticket, task) && selected === report.id) tell(errorText(error)); }
  }
  function refresh() {
    if (disposed || session === options.session()) return;
    session = options.session(); ++revision; selected = undefined; stopping = undefined; finalRead = undefined;
    reports.clear(); eventVersions.clear(); resetFrame(); tell(''); render();
    if (!session) { listPending = undefined; return; }
    const task = session, ticket = revision, started = eventVersion;
    listPending = (async () => {
      try {
        const list = await call<JevReport[]>('jev_list_runs', { sessionId: task });
        if (!alive(ticket, task)) return;
        for (const report of list.slice(0, 100)) if (report.sessionId === task && (eventVersions.get(report.id) ?? 0) <= started) retain(report);
        autoWatch();
      } catch (error) { if (alive(ticket, task)) tell(errorText(error)); }
    })();
  }
  function receiveReport(report: JevReport) {
    if (disposed || report.sessionId !== options.session()) return;
    refresh();
    const freshRun = !reports.has(report.id), selectedFinished = selected && !active(current());
    retain(report); eventVersions.set(report.id, ++eventVersion);
    if (selected === report.id && !active(report) && query('.jev-live-error').textContent === t('Stopping the browser test…')) tell('');
    if (freshRun && active(report) && selectedFinished && !wasDismissed(report)) { choose(report.id); return; }
    if (selected) { render(); void readFinal(); } else autoWatch();
  }
  function receiveFrame(frame: JevFrame) {
    if (disposed || document.hidden || session !== options.session() || frame.sessionId !== session || frame.runId !== selected || !active(current())
      || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence || !validImage(frame.dataUrl, true)
      || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) return;
    sequence = frame.sequence; pendingFrame = frame;
    if (!frameTimer) frameTimer = window.setTimeout(() => {
      frameTimer = 0;
      const next = pendingFrame; pendingFrame = undefined;
      if (!next || disposed || document.hidden || session !== options.session() || selected !== next.runId || !active(current())) return;
      setImage(next.dataUrl); lastPaint = performance.now();
    }, Math.max(0, 500 - (performance.now() - lastPaint)));
  }
  function leave() {
    // A pending history read or a delayed first event may describe an existing
    // test we have not seen yet. Manual navigation wins over those late arrivals.
    if (session) { manualAfter.delete(session); manualAfter.set(session, Date.now()); }
    while (manualAfter.size > 100) manualAfter.delete(manualAfter.keys().next().value!);
    for (const report of reports.values()) if (active(report)) dismissed.add(report.id);
    while (dismissed.size > 200) dismissed.delete(dismissed.values().next().value!);
    const previous = current(); if (previous?.screenshot) reports.set(previous.id, { ...previous, screenshot: undefined });
    selected = undefined; finalRead = undefined; resetFrame(); render();
  }
  async function watch(runId?: string) {
    refresh(); const ticket = revision, task = session;
    if (!task || disposed) throw new Error(t('Choose a task to watch its browser tests.'));
    await listPending;
    if (!alive(ticket, task)) return;
    const id = runId ?? [...reports.values()].sort((a, b) => Number(active(b)) - Number(active(a)) || b.createdAt - a.createdAt)[0]?.id;
    if (!id) return;
    if (!reports.has(id)) {
      const report = await call<JevReport>('jev_read_run', { sessionId: task, runId: id });
      if (!alive(ticket, task)) return;
      if (report.sessionId !== task || report.id !== id) throw new Error(t('This browser test belongs to another task.'));
      if (!reports.has(id)) retain(report);
    }
    choose(id);
  }
  async function stop() {
    const report = current(); if (!report || !active(report) || stopping === report.id) return;
    const task = session, ticket = revision; stopping = report.id; tell(''); render();
    try {
      const result = await call<JevReport | undefined>('jev_cancel', { sessionId: task, runId: report.id });
      if (alive(ticket, task) && selected === report.id && active(current())) tell(t('Stopping the browser test…'));
      if (alive(ticket, task) && result && result.sessionId === task && result.id === report.id) receiveReport(result);
    } catch (error) { if (alive(ticket, task) && selected === report.id) tell(errorText(error)); }
    finally { if (alive(ticket, task)) { stopping = undefined; render(); } }
  }
  function visibility() { if (document.hidden) { clearTimeout(frameTimer); frameTimer = 0; pendingFrame = undefined; } syncLease(); }
  selector.addEventListener('change', () => choose(selector.value));
  query('[data-jev-live-return]').addEventListener('click', () => { leave(); options.returned(); });
  stopButton.addEventListener('click', () => { void stop(); });
  timeline.addEventListener('toggle', showTimeline);
  document.addEventListener('visibilitychange', visibility);
  const unlisten = await Promise.all([subscribe('jev-run', receiveReport), subscribe('jev-frame', receiveFrame)]);
  refresh();
  return { watch, refresh, leave, url: () => current()?.events.at(-1)?.url || current()?.url, async close() {
    disposed = true; ++revision; selected = undefined; resetFrame(); syncLease();
    document.removeEventListener('visibilitychange', visibility); unlisten.forEach(stop => stop());
    reports.clear(); eventVersions.clear(); dismissed.clear(); manualAfter.clear(); host.replaceChildren();
    await leaseQueue;
  } };
}
