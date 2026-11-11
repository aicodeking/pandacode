import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { teamActive, type TeamSnapshot, type TeamWorker } from './architect-types';
import { workerQueueReason } from './worker-scheduling';
import { formatScore, seatVerdict } from './council';

/* The Workers panel's list: one dense row per worker (glyph, name, status, elapsed; logo · model · effort), ordered
 * by who needs the reader, with a header tally, roving keyboard focus, rows held still under the reader, and rows that
 * unfold their assignment and summary. A worker that needs the user (a question, or an approval forwarded by an older
 * or unusual host) only says so on
 * its row; its transcript holds the request. ArchitectView owns the panel, the transcripts and the live streams; it
 * answers this list's questions through WorkerListHost. */

/** What the list asks of the panel that owns it. */
export interface WorkerListHost {
  /** A worker waits on the user: a question or an approval. Current hosts auto-answer worker questions and auto-grant
   *  (or clear) their approvals; an older or unusual host can still forward one. */
  needsInput(sessionId: string): boolean;
  /** A worker's approval waits for the user's decision: only from an older or unusual host, which can still forward a
   *  pending worker approval (current hosts auto-grant or clear them). */
  needsApproval(sessionId: string): boolean;
  modelName(worker: TeamWorker): string;
  /** Open a worker's transcript (with any pending request in view and focused). */
  openWorker(workerId: string): void;
}

// Worker rows: a short status word and a 16px glyph (which carries the tone) per state.
/** Short row words (the glyph and tone carry the state); the tally counts the same words. */
const workerVerbs: Record<TeamWorker['status'] | 'paused', [string, string]> = { running: ['Working', 'team'], waiting: ['Waiting', ''], queued: ['Queued', ''], parked: ['Waiting', ''], completed: ['Done', 'success'], failed: ['Failed', 'danger'], stopped: ['Stopped', ''], paused: ['Paused', ''] };
/** Every word a row can show fits the status column (9ch). Working, Done and Failed show none: the glyph says it. */
const workerVerb = (state: string): [string, string] => (workerVerbs as Record<string, [string, string]>)[state] ?? ['Idle', ''];
/** The full status, for titles and screen readers, where the short word drops detail. */
const workerVerbsFull: Record<string, string> = { parked: 'Waiting on sub-workers' };
/** A parked worker has no process of its own, so it only waits on sub-workers while its team runs. Resume recovers it. */
export const workerState = (worker: TeamWorker, team: TeamSnapshot): TeamWorker['status'] | 'paused' => worker.status === 'parked' && !teamActive(team) ? 'paused' : worker.status;
/** A 13px-radius disc as a path, for glyphs with cut-out marks. */
const disc = 'M1 14a13 13 0 1 0 26 0a13 13 0 1 0-26 0Z';
const ring = (dash: string) => `<circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${dash}"/>`;
const workerGlyphs: Record<string, string> = {
  running: `<svg viewBox="0 0 28 28" aria-hidden="true">${ring('2.5 4')}<circle class="architect-glyph-pulse" cx="14" cy="14" r="5" fill="currentColor"/></svg>`,
  pending: `<svg viewBox="0 0 28 28" aria-hidden="true">${ring('2.5 4')}<g fill="currentColor"><circle cx="9" cy="14" r="2"/><circle cx="14" cy="14" r="2"/><circle cx="19" cy="14" r="2"/></g></svg>`,
  // Done and failed are filled discs whose marks are cut out (even-odd holes), so any fill or theme shows through.
  completed: `<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${disc}M7.3 14.9 9.3 13l2.8 2.7 6.4-7 2 1.9-8.4 9.1Z"/></svg>`,
  failed: `<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${disc}M12.6 7.4h2.8v8.8h-2.8ZM14 18.3a1.8 1.8 0 1 0 .001 0Z"/></svg>`,
  idle: `<svg viewBox="0 0 28 28" aria-hidden="true">${ring('2.5 4')}</svg>`,
  // Finished, not passed (a Council reviewer below target): a muted solid disc with a dash cut out, unlike the
  // dashed ring of work not yet started and the green check of done.
  below: `<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${disc}M8 12.6h12v2.8H8Z"/></svg>`,
  // Stopped: a full ring around a small square, unlike the dashed rings of queued, waiting and idle.
  stopped: `<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="10" y="10" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`,
  // A worker that needs the user leads with the same alert mark as the tally's "needs you" and its request.
  alert: icon('alert'),
};
/** Each glyph's design-system tone, on the leading icon. Waiting is muted: only a worker that needs the user is `near`. */
const glyphTones: Record<string, string> = { running: 'team', pending: 'worker-idle', completed: 'ready', failed: 'failed', idle: 'worker-idle', below: 'worker-idle', stopped: 'worker-idle', alert: 'near' };
/** Who needs the reader first: asking, then failed, working, waiting or queued, stopped, and done last. */
const workerRank = (worker: TeamWorker, state: string, asking: boolean): number =>
  worker.abandoned ? 6 : asking ? 0 : ({ failed: 1, running: 2, waiting: 3, parked: 3, queued: 3, paused: 4, stopped: 4, completed: 5 } as Record<string, number>)[state] ?? 4;
/** A reasoning effort as people say it: `xhigh` reads "x-high". */
export const effortLabel = (effort: string): string => effort.replace(/^x(?=high$)/i, 'x-');
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** A compact duration that always fits four characters: <1m, 45m, 1.5h, 12h, 3d. No seconds: the list refreshes
 *  every 15 s, so a seconds count would look stuck. */
export const shortDuration = (ms: number): string => {
  if (ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) { const hours = Math.floor(ms / HOUR * 2) / 2; return `${hours < 10 ? hours : Math.floor(hours)}h`; }
  return `${Math.min(999, Math.floor(ms / DAY))}d`;
};
/** The same duration in words, for titles and screen readers: "1 hour 15 minutes", "less than a minute". */
export const longDuration = (ms: number): string => {
  if (ms < MINUTE) return 'less than a minute';
  const unit = (count: number, name: string) => count ? `${count} ${name}${count === 1 ? '' : 's'}` : '';
  const days = Math.floor(ms / DAY), hours = Math.floor(ms % DAY / HOUR), minutes = Math.floor(ms % HOUR / MINUTE);
  return [unit(days, 'day'), unit(hours, 'hour'), days ? '' : unit(minutes, 'minute')].filter(Boolean).join(' ');
};
/** How long a worker's current run has run (still running) or ran (settled: to `settledAt`), in ms, from the run's
 *  `startedAt` (a follow-up starts a new run) or, on older hosts, from when the worker was created; null before it starts. */
const workerElapsedMs = (worker: TeamWorker, state: string, now: number, settledAt: number): number | null =>
  state === 'queued' || worker.abandoned ? null : Math.max(0, (['running', 'waiting', 'parked'].includes(state) ? now : settledAt) - (worker.startedAt ?? worker.createdAt));
/** One vocabulary for a worker's state: the row's short word, its full label (title and screen readers), the
 *  word's tone and the tally bucket, which is the same word. */
type WorkerWord = { verb: string; full: string; tone: string; bucket: string };
export function workerWord(worker: TeamWorker, state: string, approval: boolean, asking: boolean): WorkerWord {
  if (worker.abandoned) return { verb: 'Skipped', full: 'Skipped', tone: '', bucket: 'skipped' };
  if (approval) return { verb: 'Approve?', full: 'Needs you: approval', tone: 'warn', bucket: 'needs you' };
  if (asking) return { verb: 'Input?', full: 'Needs you: input', tone: 'warn', bucket: 'needs you' };
  const [verb, tone] = workerVerb(state);
  // Working, Done and Failed need no word: the glyph (Failed in the danger tone) says it, and the name gets the room
  // (the full status stays for screen readers and the title).
  return { verb: ['running', 'completed', 'failed'].includes(state) ? '' : verb, full: workerVerbsFull[state] ?? verb, tone, bucket: verb.toLowerCase() };
}
/** A Council reviewer's row (one from an earlier cycle, or not yet in the Council summary): it is named by its lens and
 *  reads its verdict against the target, never "Done" in success green below it. Null for other workers. */
type ReviewerRow = { name: string; verb: string; full: string; tone: string; below: boolean; meta: string };
export function reviewerRow(worker: TeamWorker, team: TeamSnapshot): ReviewerRow | null {
  const council = worker.council; if (!council) return null;
  const verdict = seatVerdict(team, worker as TeamWorker & { council: NonNullable<TeamWorker['council']> });
  const below = verdict?.tone === 'below';
  const meta = [`Round ${council.round}`, typeof council.score === 'number' ? `scored ${formatScore(council.score)}` : '', worker.createdAt < (team.councilSince ?? 0) ? 'earlier council' : ''].filter(Boolean).join(' · ');
  return { name: council.lens.trim() || worker.name, verb: verdict ? verdict.tone === 'at' ? 'At target' : below ? 'Below' : 'Scored' : '', full: verdict?.text ?? '', tone: below ? 'warn' : '', below, meta };
}
/** The rows' own order: needs you, failed, working, waiting or queued, paused or stopped, done, skipped. */
const TALLY_ORDER = ['needs you', 'failed', 'working', 'waiting', 'queued', 'paused', 'stopped', 'done', 'skipped', 'idle'];
/** Buckets that leave the line for its title when the panel is narrow. */
const TALLY_MINOR = new Set(['queued', 'stopped', 'skipped', 'idle']);
/** Each bucket's glyph and tone in the tally: the same marks the rows lead with. */
const TALLY_GLYPHS: Record<string, [string, string]> = { working: ['running', 'team'], failed: ['failed', 'failed'], done: ['completed', 'ready'], waiting: ['pending', 'worker-idle'], queued: ['pending', 'worker-idle'], paused: ['idle', 'worker-idle'], stopped: ['stopped', 'worker-idle'], skipped: ['idle', 'worker-idle'], idle: ['idle', 'worker-idle'] };
/** Then these, last-first, when the line still does not fit. */
const TALLY_DROP = ['done', 'paused', 'waiting', 'working', 'failed'];
/** The header's tally, such as "1 needs you · 2 working · 3 done · 1 failed", counted in the rows' words: the
 *  full line, a short one without the minor buckets, and the share of settled workers. Empty buckets are left out. */
export function teamTally(workers: TeamWorker[], bucket: (worker: TeamWorker) => string): { text: string; readable: string; html: string; variants: { text: string; html: string; hidden: string }[]; settled: number; total: number; needsYou: number; failed: number } {
  const counts = new Map<string, number>();
  for (const worker of workers) { const key = bucket(worker); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const label = (key: string, count: number) => key === 'needs you' ? `${count} ${count === 1 ? 'needs' : 'need'} you` : `${count} ${key}`;
  const parts = [...TALLY_ORDER, ...[...counts.keys()].filter(key => !TALLY_ORDER.includes(key))].filter(key => counts.get(key)).map(key => [key, label(key, counts.get(key)!)] as const);
  const settled = workers.filter(worker => worker.abandoned || ['completed', 'failed', 'stopped'].includes(worker.status)).length;
  // The visible line is hidden from screen readers (a readable copy says it in words), except the "needs you" button,
  // which keeps its words after a warn-toned icon. Every other bucket is the rows' own glyph, its count and its word.
  // A line too wide for the panel drops the minor buckets first and ends with a "+N" button that unfolds the hidden
  // counts on a line of their own (aria-expanded), its title naming them too.
  const html = (list: (readonly [string, string])[], hidden: (readonly [string, string])[]) => {
    const more = hidden.reduce((sum, [key]) => sum + counts.get(key)!, 0), names = hidden.map(([, text]) => text).join(', ');
    return [...list.map(([key, text]) => {
      if (key === 'needs you') return `<button type="button" class="architect-tally-asking" title="Show the first worker that needs you"><span class="architect-tally-icon" data-state-tone="near" aria-hidden="true">${icon('alert')}</span>${escape(text)}</button>`;
      const [glyph, tone] = TALLY_GLYPHS[key] ?? ['idle', 'worker-idle'];
      // Every count says its word on screen ("1 working"), so marks never have to be learned or hovered.
      return `<span class="architect-tally-count" title="${escape(text)}" aria-hidden="true"><span class="architect-tally-glyph" data-state-tone="${tone}">${workerGlyphs[glyph]}</span>${escape(text)}</span>`;
    }), ...more ? [`<button type="button" class="architect-tally-more" aria-expanded="false" aria-controls="architect-tally-hidden" aria-label="${escape(`Show ${more} more: ${names}`)}" title="${escape(names)}">+${more} more</button>`] : []].join('');
  };
  // Ever shorter lines for a narrow panel: the minor buckets go first, then the rest, last-first, "failed" last of
  // all; "needs you" always stays. Each drop is counted in "+N more", which is never cut.
  const variants = [{ text: parts.map(([, text]) => text).join(' · '), html: html(parts, []), hidden: '' }];
  const order = [...TALLY_MINOR, ...TALLY_DROP];
  for (let step = 1; step <= order.length; step++) {
    const gone = new Set(order.slice(0, step));
    if (!parts.some(([key]) => gone.has(key)) || !parts.some(([key]) => key === order[step - 1])) continue;
    const kept = parts.filter(([key]) => !gone.has(key)), hidden = parts.filter(([key]) => gone.has(key));
    const dropped = hidden.reduce((sum, [key]) => sum + counts.get(key)!, 0);
    variants.push({ text: [...kept.map(([, text]) => text), `+${dropped} more`].join(' · '), html: html(kept, hidden), hidden: hidden.map(([, text]) => text).join(' · ') });
  }
  // The readable copy leaves out "needs you": its button, just before, already says it.
  const readable = parts.filter(([key]) => key !== 'needs you').map(([, text]) => text).join(' · ');
  return { text: variants[0].text, readable, html: variants[0].html, variants, settled, total: workers.length,
    needsYou: counts.get('needs you') ?? 0, failed: counts.get('failed') ?? 0 };
}
/** The effort label. An effort note means the effort was changed from what the lead asked: the label says
 *  "· adjusted" (muted), the note is its title and screen readers hear "adjusted". */
const effortChip = (effort: string, note?: string | null): string => `<span class="architect-worker-chip architect-worker-effort"${note ? ' data-adjusted' : ''} title="${escape(note ? `Reasoning effort: ${effort}. ${note}` : `Reasoning effort: ${effort}`)}"><span aria-hidden="true">${escape(effort)}${note ? '<span class="architect-worker-adjusted"> · adjusted</span>' : ''}</span><span class="sr-only">reasoning effort ${escape(effort)}${note ? ', adjusted' : ''}</span></span>`;
/** Sets an attribute only when it changes, so a repaint queues no mutation. */
const setAttr = (element: Element, name: string, value: string): void => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
/** An approval request, shown whole up to twelve lines; longer ones scroll in a labelled region with a hint. */
export const requestHtml = (text: string): string => `<p class="architect-worker-more-label">Request</p><pre class="architect-worker-request" role="region" aria-label="Request">${escape(text)}</pre><p class="architect-worker-request-hint" hidden>Scroll to read the full request</p>`;
/** Marks the capped boxes in `root` (a request, an assignment, a summary) that overflow: each becomes a labelled
 *  region that is a Tab stop, named "… (scroll for more)", with its visible hint shown. A box that fits is plain text
 *  (a request stays a region, as it always is). */
export function markScrollRegions(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLElement>('.architect-worker-request, .architect-worker-more-text[data-scroll-label]')) {
    const overflows = box.scrollHeight > box.clientHeight + 1, label = box.dataset.scrollLabel ?? 'Request';
    const request = box.classList.contains('architect-worker-request');
    if (overflows || request) { setAttr(box, 'role', 'region'); setAttr(box, 'aria-label', overflows ? `${label} (scroll for more)` : label); }
    else { box.removeAttribute('role'); box.removeAttribute('aria-label'); }
    if (overflows) setAttr(box, 'tabindex', '0'); else box.removeAttribute('tabindex');
    // An overflowing box fades at its bottom until it is scrolled to the end.
    box.toggleAttribute('data-overflowing', overflows);
    box.toggleAttribute('data-at-end', overflows && box.scrollTop + box.clientHeight >= box.scrollHeight - 1);
    const hint = box.nextElementSibling as HTMLElement | null;
    if (hint?.matches('.architect-worker-request-hint, .architect-worker-scroll-hint') && hint.hidden === overflows) hint.hidden = !overflows;
  }
}
/** The visible hint under a capped box, shown only while it overflows. */
const scrollHint = '<p class="architect-worker-scroll-hint" hidden>Scroll for more</p>';
/** One definition of a worker still at work (unknown counts as active): only such a worker can need the user. */
export const workerActive = (worker?: TeamWorker | null): boolean => !worker || (!worker.abandoned && ['running', 'waiting', 'parked', 'queued'].includes(worker.status));
/** The name of an approval request's group: what it asks, shortened. */
export const approvalLabel = (text: string): string => `Needs you: approval: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
/** Updates a container's keyed parts in place: unchanged parts (and any control focused in them) are left alone,
 *  changed ones are replaced, and focus on a replaced "Open transcript" returns to the new one. */
function patchParts(host: HTMLElement, parts: [string, string][]): void {
  const keys = new Set(parts.map(([key]) => key));
  for (const child of [...host.children] as HTMLElement[]) if (!keys.has(child.dataset.part ?? '')) child.remove();
  parts.forEach(([key, html], index) => {
    let element = [...host.children].find(child => (child as HTMLElement).dataset.part === key) as HTMLElement | undefined;
    if (!element || element.dataset.html !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild as HTMLElement;
      next.dataset.part = key; next.dataset.html = html;
      const focused = element?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      if (element) element.replaceWith(next); else host.insertBefore(next, host.children[index] ?? null);
      element = next;
      if (focused?.classList.contains('architect-worker-open')) element.querySelector<HTMLElement>('.architect-worker-open')?.focus({ preventScroll: true });
    }
    if (host.children[index] !== element) host.insertBefore(element, host.children[index] ?? null);
  });
}
/** How often an open list refreshes the elapsed times of running workers. */
const ELAPSED_REFRESH_MS = 15_000;

export class WorkerList {
  private readonly list: HTMLElement;
  private readonly tallyHost: HTMLElement;
  private readonly live: HTMLElement;
  private team: TeamSnapshot | null = null;
  private rows = new Map<string, HTMLElement>();
  /** Workers whose assignment and summary the reader unfolded in the list. */
  private expanded = new Set<string>();
  private elapsedTimer = 0;
  /** Each settled worker's finish time, as first seen. */
  private settled = new Map<string, number>();
  /** A new order waits while the reader is on the list. */
  private reorderPending = false;
  private tally?: ReturnType<typeof teamTally>;
  /** The needs-you and failed counts last announced. */
  private announced = '';
  private tallyResize: ResizeObserver;
  /** The counts the narrow tally hides, and whether its "+N" disclosure is open. */
  private hiddenCounts = '';
  private showHidden = false;
  /** The list's one Tab stop (roving tabindex). */
  private currentRow = '';
  /** The last paint's `elsewhere`, kept for repaints the list starts itself. */
  private elsewhere = false;
  constructor(private readonly panel: HTMLElement, private readonly host: WorkerListHost) {
    this.list = panel.querySelector<HTMLElement>('.architect-worker-list')!;
    this.tallyHost = panel.querySelector<HTMLElement>('.architect-panel-tally')!;
    this.live = panel.querySelector<HTMLElement>('.architect-panel-live')!;
    const tallyText = this.tallyHost.querySelector<HTMLElement>('.architect-panel-tally-text')!;
    // A wider panel brings the full tally back; a narrower one shortens it.
    this.tallyResize = new ResizeObserver(() => this.fitTally(tallyText)); this.tallyResize.observe(tallyText);
    tallyText.addEventListener('click', event => {
      const target = event.target as Element;
      if (target.closest('.architect-tally-asking')) this.showNeedsYou();
      if (target.closest('.architect-tally-more')) { this.showHidden = !this.showHidden; this.syncHidden(); }
    });
    // Scrolling a capped box to its end lifts its fade (scroll does not bubble: listen in the capture phase).
    this.list.addEventListener('scroll', event => {
      const box = event.target as HTMLElement;
      if (box.hasAttribute?.('data-overflowing')) box.toggleAttribute('data-at-end', box.scrollTop + box.clientHeight >= box.scrollHeight - 1);
    }, true);
    this.list.addEventListener('pointerleave', () => this.releaseList());
    this.list.addEventListener('focusout', event => { if (!this.list.contains(event.relatedTarget as Node | null)) queueMicrotask(() => this.releaseList()); });
  }
  dispose(): void { this.tallyResize.disconnect(); clearInterval(this.elapsedTimer); this.elapsedTimer = 0; this.rows.clear(); }
  /** Counts the team and, only when what needs the user changes (needs you, failed), says so in the panel's live
   *  region, which stays outside anything that hides (a transcript can be open). Opening the panel says nothing. */
  announce(team: TeamSnapshot): ReturnType<typeof teamTally> {
    const tally = teamTally(team.workers, worker => this.word(worker, team).bucket);
    this.tally = tally;
    const key = `${tally.needsYou}|${tally.failed}`;
    if (!this.announced) this.announced = key;
    else if (this.announced !== key) { this.announced = key; if (this.live.textContent !== tally.text) this.live.textContent = tally.text; }
    return tally;
  }
  /** Makes a worker's row the current one and focuses it (after its request was answered in the transcript, say). */
  focusRow(workerId: string): void {
    const row = this.rows.get(workerId)?.querySelector<HTMLElement>('.architect-worker-row'); if (!row) return;
    this.currentRow = workerId; this.rove(); row.focus({ preventScroll: true });
  }
  /** One dense line per worker, those that need the reader first; each unfolds its assignment and summary. */
  /** `elsewhere`: some of the team's workers are shown outside the list (Council reviewers), so an empty list says nothing. */
  paint(team: TeamSnapshot, unfreeze = false, elsewhere = false): void {
    this.team = team; this.elsewhere = elsewhere;
    const list = this.list, tallyHost = this.tallyHost;
    tallyHost.hidden = !team.workers.length;
    if (!team.workers.length) { this.hiddenCounts = ''; this.showHidden = false; this.syncHidden(); }
    // An empty list is a sentence, not a list: it drops the list role and the list's name and hint with it.
    if (!team.workers.length) { list.removeAttribute('role'); list.removeAttribute('aria-label'); list.removeAttribute('aria-describedby'); }
    else { setAttr(list, 'role', 'list'); setAttr(list, 'aria-label', 'Workers'); setAttr(list, 'aria-describedby', 'architect-workers-hint'); }
    if (!team.workers.length) { this.rows.clear(); list.textContent = elsewhere ? '' : team.status === 'ready' ? 'Send a task to let the architect delegate the work.' : 'The architect is planning its first assignments.'; return; }
    const tally = this.announce(team);
    const tallyText = tallyHost.querySelector<HTMLElement>('.architect-panel-tally-text')!;
    // The full line when it fits, else the minor buckets move to the title. Nothing is written unless it changed,
    // so an unchanged tally is never announced again.
    this.fitTally(tallyText);
    const bar = tallyHost.querySelector<HTMLElement>('.architect-progress')!;
    setAttr(bar, 'aria-valuemax', String(tally.total)); setAttr(bar, 'aria-valuenow', String(tally.settled));
    setAttr(bar, 'aria-valuetext', `${tally.settled} of ${tally.total} finished`);
    const share = String(tally.total ? tally.settled / tally.total : 0);
    if (bar.style.getPropertyValue('--progress') !== share) bar.style.setProperty('--progress', share);
    if (!this.rows.size) list.replaceChildren();
    for (const [id, item] of this.rows) if (!team.workers.some(worker => worker.id === id)) { item.remove(); this.rows.delete(id); }
    const now = Date.now();
    const rank = (worker: TeamWorker) => workerRank(worker, workerState(worker, team), this.host.needsInput(worker.sessionId));
    const byRank = (a: TeamWorker, b: TeamWorker) => rank(a) - rank(b);
    // Sub-workers sit indented under their parent; parents are ordered by who needs the reader first.
    const ordered = team.workers.filter(w => !w.parentWorker).sort(byRank).flatMap(parent => [parent, ...team.workers.filter(w => w.parentWorker === parent.id).sort(byRank)]);
    // Rows never move under the pointer or keyboard focus: new rows join the end until the reader leaves the list.
    const frozen = !unfreeze && this.listHeld() && list.querySelector('.architect-worker-item');
    const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    ordered.forEach((worker, index) => {
      const fresh = !this.rows.has(worker.id);
      const item = this.rows.get(worker.id) ?? this.workerItem(worker);
      if (frozen) { if (fresh) list.insertBefore(item, this.heldSlot(list, worker)); }
      else if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
      this.paintWorkerItem(item, worker, team, now);
    });
    this.reorderPending = Boolean(frozen) && [...list.children].some((item, index) => (item as HTMLElement).dataset.workerId !== ordered[index]?.id);
    if (!this.rows.has(this.currentRow)) this.currentRow = (list.firstElementChild as HTMLElement | null)?.dataset.workerId ?? '';
    this.rove();
    if (focused && document.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
    const running = team.workers.some(worker => ['running', 'waiting', 'parked'].includes(worker.status));
    if (running && !this.elapsedTimer) this.elapsedTimer = window.setInterval(() => this.tickElapsed(), ELAPSED_REFRESH_MS);
    else if (!running && this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = 0; }
    const scroll = this.panel.querySelector<HTMLElement>('.architect-panel-scroll')!;
    scroll.classList.toggle('is-overflowing', scroll.scrollHeight > scroll.clientHeight + 1);
  }
  /** Where a row arriving while the order is held goes: a sub-worker after its parent's group, others at the end. */
  private heldSlot(list: HTMLElement, worker: TeamWorker): Element | null {
    const parent = worker.parentWorker && this.rows.get(worker.parentWorker);
    if (!parent || parent.parentElement !== list) return null;
    let next = parent.nextElementSibling;
    while (next && (next as HTMLElement).dataset.parent === worker.parentWorker) next = next.nextElementSibling;
    return next;
  }
  /** A worker's words, the same in its row and in the tally. */
  private word(worker: TeamWorker, team: TeamSnapshot): WorkerWord {
    return workerWord(worker, workerState(worker, team), this.host.needsApproval(worker.sessionId), this.host.needsInput(worker.sessionId));
  }
  /** The full tally when it fits the panel, else the short one (its minor buckets stay in the title). Re-run on resize. */
  private fitTally(tallyText: HTMLElement): void {
    const tally = this.tally; if (!tally) return;
    const host = tallyText.parentElement!;
    // Always current and read in place (not live): what screen readers find when they reach the tally.
    const readable = host.querySelector<HTMLElement>('.architect-panel-tally-readable')!;
    if (readable.textContent !== tally.readable) readable.textContent = tally.readable;
    const measure = host.querySelector<HTMLElement>('.architect-panel-tally-measure')!;
    setAttr(tallyText, 'title', tally.text);
    // The longest line that fits, measured on an inert hidden copy (button and icon included) only when the tally or
    // the width changed, so a plain repaint writes nothing.
    const width = tallyText.clientWidth, key = `${width}|${tally.html}`;
    if (measure.dataset.key === key) return;
    let chosen = tally.variants[0];
    if (width) {
      const fitting = tally.variants.find(variant => { if (measure.dataset.html !== variant.html) { measure.innerHTML = variant.html; measure.dataset.html = variant.html; } return measure.scrollWidth <= width + 1; });
      chosen = fitting ?? tally.variants[tally.variants.length - 1];
      measure.dataset.key = key;
    }
    if (tallyText.dataset.html !== chosen.html) { tallyText.innerHTML = chosen.html; tallyText.dataset.html = chosen.html; }
    this.hiddenCounts = chosen.hidden;
    if (!chosen.hidden) this.showHidden = false;
    this.syncHidden();
  }
  /** The "+N" disclosure: the counts a narrow tally hides, on a line of their own while it is expanded. */
  private syncHidden(): void {
    const disclosure = this.panel.querySelector<HTMLElement>('.architect-panel-tally-hidden')!;
    if (disclosure.textContent !== this.hiddenCounts) disclosure.textContent = this.hiddenCounts;
    const shown = this.showHidden && Boolean(this.hiddenCounts);
    if (disclosure.hidden === shown) disclosure.hidden = !shown;
    const toggle = this.tallyHost.querySelector('.architect-tally-more');
    if (toggle) setAttr(toggle, 'aria-expanded', String(shown));
  }
  /** The tally's "needs you": bring the first worker that needs the user into view and focus its row. */
  private showNeedsYou(): void {
    const team = this.team; if (!team) return;
    this.reorderPending = false; this.paint(team, true, this.elsewhere);
    const first = [...this.rows.values()].find(item => team.workers.some(worker => worker.id === item.dataset.workerId && this.host.needsInput(worker.sessionId)));
    const row = first?.querySelector<HTMLElement>('.architect-worker-row'); if (!row || !first) return;
    this.currentRow = first.dataset.workerId!; this.rove();
    row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true });
  }
  /** Only the current row is a Tab stop; arrows move between rows. */
  private rove(): void {
    for (const [id, item] of this.rows) { const row = item.querySelector<HTMLElement>('.architect-worker-row')!; const index = id === this.currentRow ? '0' : '-1'; if (row.getAttribute('tabindex') !== index) row.setAttribute('tabindex', index); }
  }
  /** Whether the reader is on the list: the pointer over it or keyboard focus in it. */
  private listHeld(): boolean { return this.list.matches(':hover') || this.list.contains(document.activeElement); }
  /** Applies an order held back while the reader was on the list. */
  private releaseList(): void {
    if (!this.reorderPending || this.listHeld() || !this.team || this.list.hidden) return;
    this.reorderPending = false; this.paint(this.team, false, this.elsewhere);
  }
  /** Moves only the elapsed times of running workers forward; nothing else repaints. */
  private tickElapsed(): void {
    if (!this.team || this.list.hidden) return;
    const now = Date.now();
    for (const worker of this.team.workers) {
      const row = this.rows.get(worker.id)?.querySelector<HTMLElement>('.architect-worker-row');
      if (row) this.paintElapsed(row, worker, workerState(worker, this.team), now);
    }
  }
  /** When a worker settled: its first settled snapshot's time, kept, so later updates to a finished worker (a
   *  summary, a note) never make its run look longer. Back to work, it starts over. */
  private settledAt(worker: TeamWorker, state: string): number {
    if (['running', 'waiting', 'parked', 'queued'].includes(state)) { this.settled.delete(worker.id); return worker.updatedAt; }
    let at = this.settled.get(worker.id);
    if (at === undefined) this.settled.set(worker.id, at = worker.updatedAt);
    return at;
  }
  /** A row's elapsed time, short on screen and in full in its title; and the row's name, which says it too:
   *  "Reviewer, Working, running 3 minutes — open transcript". */
  private paintElapsed(row: HTMLElement, worker: TeamWorker, state: string, now: number): void {
    const element = row.querySelector<HTMLElement>('.architect-worker-elapsed'); if (!element) return;
    const ms = workerElapsedMs(worker, state, now, this.settledAt(worker, state));
    const time = ms === null ? '' : shortDuration(ms), words = ms === null ? '' : `${['running', 'waiting', 'parked'].includes(state) ? 'running' : 'ran'} ${longDuration(ms)}`;
    if (element.textContent !== time) element.textContent = time;
    if (element.title !== words) element.title = words;
    setAttr(row, 'aria-label', `${row.dataset.name ?? worker.name}, ${row.dataset.statusLabel ?? ''}${words ? `, ${words}` : ''} — open transcript`);
  }
  private workerItem(worker: TeamWorker): HTMLElement {
    const item = document.createElement('div'); item.className = 'architect-worker-item'; item.setAttribute('role', 'listitem'); item.dataset.workerId = worker.id;
    if (worker.parentWorker) { item.dataset.sub = ''; item.dataset.parent = worker.parentWorker; }
    const detailsId = `architect-worker-more-${crypto.randomUUID()}`;
    // The row only opens the transcript: its name (an aria-label, which replaces its content) says so. Its description
    // brings back what the label hides: the meta line (model or reason, effort, attempt), then whether the details are
    // shown. The keyboard hint is said once, by the list. The caret is the disclosure (aria-expanded), by pointer or Right / Left.
    item.innerHTML = `<button type="button" class="architect-worker-row" data-worker-id="${escape(worker.id)}" aria-describedby="${detailsId}-meta ${detailsId}-state" aria-keyshortcuts="ArrowRight ArrowLeft Enter" data-details="${detailsId}"></button>`
      + `<button type="button" class="architect-worker-expand" tabindex="-1" aria-expanded="false" aria-controls="${detailsId}" aria-label="${escape(`Details for ${worker.name}`)}">${icon('down')}</button>`
      + `<span class="sr-only" id="${detailsId}-state">Details hidden</span><div class="architect-worker-more" id="${detailsId}" hidden></div>`;
    const row = item.querySelector<HTMLButtonElement>('.architect-worker-row')!, expand = item.querySelector<HTMLButtonElement>('.architect-worker-expand')!;
    const open = () => this.host.openWorker(worker.id);
    row.addEventListener('click', open);
    expand.addEventListener('click', () => this.toggleWorker(worker.id));
    item.addEventListener('click', event => { if ((event.target as Element).closest('.architect-worker-open')) open(); });
    row.addEventListener('focus', () => { if (this.currentRow !== worker.id) { this.currentRow = worker.id; this.rove(); } });
    // Arrow keys walk the rows; right unfolds a row and left folds it.
    item.addEventListener('keydown', event => {
      const target = event.target as HTMLElement;
      if (!target.matches('.architect-worker-row, .architect-worker-expand')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        if (this.expanded.has(worker.id) !== (event.key === 'ArrowRight')) this.toggleWorker(worker.id);
        event.preventDefault(); return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        const rows = [...item.parentElement!.querySelectorAll<HTMLElement>('.architect-worker-row')];
        rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus(); event.preventDefault(); return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const rows = [...item.parentElement!.querySelectorAll<HTMLElement>('.architect-worker-row')];
      const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { event.preventDefault(); next.focus(); }
    });
    this.rows.set(worker.id, item);
    return item;
  }
  private toggleWorker(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    const item = this.rows.get(id); if (!item || !this.team) return;
    const worker = this.team.workers.find(worker => worker.id === id);
    if (worker) this.paintWorkerItem(item, worker, this.team, Date.now());
  }
  private paintWorkerItem(item: HTMLElement, worker: TeamWorker, team: TeamSnapshot, now: number): void {
    const row = item.querySelector<HTMLButtonElement>('.architect-worker-row')!;
    const asking = this.host.needsInput(worker.sessionId), approval = this.host.needsApproval(worker.sessionId);
    const state = workerState(worker, team);
    const status = asking ? 'waiting' : state;
    row.dataset.status = status; item.dataset.status = status;
    const queueReason = workerQueueReason(worker, team.workers, team.config.maxParallel);
    const plain = workerWord(worker, state, approval, asking);
    const reviewer = reviewerRow(worker, team);
    // A scored reviewer reads its verdict (unless it needs the user or was skipped).
    const scored = reviewer?.verb && !asking && !approval && !worker.abandoned ? reviewer : null;
    const { verb: word, tone, full: fullVerb } = scored ? { verb: scored.verb, tone: scored.tone, full: scored.full } : plain;
    const name = reviewer?.name ?? worker.name;
    // A queue reason ("Waiting for a dependency") already says it is queued: no status word beside it.
    const verb = queueReason && !asking ? '' : word;
    // A reviewer that finished below target gets its own finished-not-passed mark, never the green done check.
    const glyph = worker.abandoned ? 'idle' : scored?.below ? 'below' : asking ? 'alert' : ['queued', 'waiting', 'parked'].includes(state) ? 'pending' : workerGlyphs[state] ? state : 'idle';
    const model = this.host.modelName(worker), effort = worker.reasoningEffort ? effortLabel(worker.reasoningEffort) : '';
    // The meta line: the model; a queued row's reason instead; a failed row's error (its first line) instead, without
    // the harness logo (nor beside a queue reason), which beside an error would read like its cause. It is cut on one
    // line (whole in the title and details). The effort and attempt labels follow it and are never cut, except on a
    // failed row, where the reason wins the space: its attempt (and "adjusted") are hidden there on screen (still in its
    // description and title); its effort stays as a muted marker.
    // Open, a failed row's full error is right below, so its meta line shows the facts instead: model · effort · attempt.
    const open = this.expanded.has(worker.id);
    const reason = state === 'failed' && worker.error ? worker.error.split('\n')[0].trim() : '';
    const facts = [model, effort ? `${effort}${worker.note ? ', adjusted' : ''}` : '', worker.attempt > 1 ? `attempt ${worker.attempt}` : ''].filter(Boolean).join(' · ');
    const showFacts = Boolean(reason) && open;
    const meta = showFacts ? facts : reason || queueReason || reviewer?.meta || model;
    const metaTitle = showFacts ? (worker.note ? `${facts}. ${worker.note}` : facts) : reason ? worker.error!.trim() : meta;
    const markup = `<span class="architect-worker-glyph" data-glyph="${glyph}" data-state-tone="${glyphTones[glyph]}">${workerGlyphs[glyph]}</span>`
      + `<span class="architect-worker-copy"><span class="architect-worker-line"><strong title="${escape(name)}">${escape(name)}</strong>`
      + (verb ? `<span class="architect-worker-state${tone === 'warn' ? ' architect-worker-state-attention' : ''}" title="${escape(fullVerb)}"><span aria-hidden="true">${escape(verb)}</span><span class="sr-only">${escape(fullVerb)}</span></span>`
        : `<span class="architect-worker-state sr-only">${escape(fullVerb)}</span>`)
      + `<span class="architect-worker-elapsed" aria-hidden="true"></span></span>`
      + `<span class="architect-worker-line architect-worker-meta-line" id="${row.dataset.details}-meta">${reason || queueReason ? '' : `<span class="architect-worker-logo">${providerLogo(worker.provider)}</span>`}<small title="${escape(metaTitle)}">${escape(meta)}</small>`
      + (effort ? effortChip(effort, worker.note) : '')
      + (worker.attempt > 1 ? `<span class="architect-worker-chip architect-worker-attempt" title="Attempt ${worker.attempt}"><span aria-hidden="true">×${worker.attempt}</span><span class="sr-only">attempt ${worker.attempt}</span></span>` : '')
      + `</span></span>`;
    if (row.dataset.painted !== markup) { row.innerHTML = markup; row.dataset.painted = markup; }
    item.toggleAttribute('data-reason', Boolean(reason));
    row.dataset.statusLabel = fullVerb; row.dataset.name = name;
    this.paintElapsed(row, worker, state, now);
    // The caret is the disclosure; the row's description says whether the details are shown.
    const expand = item.querySelector<HTMLButtonElement>('.architect-worker-expand')!;
    setAttr(expand, 'aria-expanded', String(open));
    const tip = open ? 'Hide details' : 'Show details';
    if (expand.title !== tip) expand.title = tip;
    const stateText = item.querySelector<HTMLElement>(`[id="${row.dataset.details}-state"]`)!, shown = open ? 'Details shown' : 'Details hidden';
    if (stateText.textContent !== shown) stateText.textContent = shown;
    // A queued row's title has its whole reason (the meta line may cut it).
    // A failed row's title also has the effort and attempt its meta line leaves out.
    const extras = [effort ? `Effort: ${effort}${worker.note ? ' (adjusted)' : ''}` : '', worker.attempt > 1 ? `Attempt ${worker.attempt}` : ''].filter(Boolean);
    const rowTitle = queueReason ? `${worker.name} · ${queueReason}` : reason ? [worker.name, reason, ...extras].join(' · ') : '';
    if (row.title !== rowTitle) row.title = rowTitle;
    item.toggleAttribute('data-open', open);
    const more = item.querySelector<HTMLElement>('.architect-worker-more')!;
    more.hidden = !open;
    if (!open) return;
    const scope = worker.readOnly ? 'Read only · no writes' : worker.files.length ? `Write scope: ${worker.files.join(', ')}` : 'Write scope: shared checkout';
    // `error` is a real failure; `note` (an effort the model could not take, say) is only information.
    // The queue reason is cut on the meta line when space is short; here it is whole.
    const parts: [string, string][] = [
      ['error', worker.error ? `<p class="architect-worker-error">${escape(worker.error)}</p>` : ''],
      ['queue', queueReason ? `<p class="architect-worker-more-queue">${escape(queueReason)}</p>` : ''],
      // On a failed row the effort note rides on the facts line's tooltip ("Effort: medium (adjusted)"), keeping it short.
      ['note', worker.note && !reason ? `<p class="architect-worker-more-quiet">${escape(worker.note)}</p>` : ''],
      // Trailing blank lines are trimmed, so a capped box never ends on an empty line.
      ['assignment', `<div><p class="architect-worker-more-label">Assignment</p><p class="architect-worker-more-text" data-scroll-label="Assignment">${escape(worker.assignment.trimEnd())}</p>${scrollHint}</div>`],
      ['summary', worker.summary.trim() ? `<div><p class="architect-worker-more-label">Summary</p><p class="architect-worker-more-text" data-scroll-label="Summary">${escape(worker.summary.trimEnd())}</p>${scrollHint}</div>` : ''],
      // A queued row's meta line shows its reason instead of the model, so the model is here. (An open failed row shows
      // its facts on its own meta line.)
      ['facts', queueReason ? `<p class="architect-worker-more-model">${escape(model)}</p>` : ''],
      ['foot', `<div class="architect-worker-more-foot"><small>${escape(scope)}</small><button type="button" class="architect-worker-open">Open transcript${icon('chevron')}</button></div>`]];
    patchParts(more, parts.filter(([, html]) => html));
    markScrollRegions(more);
  }
}
