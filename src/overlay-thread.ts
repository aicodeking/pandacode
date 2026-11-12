import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { journal, overlayCall, overlayEvents, replayedDismissals, type OverlayTask, type OverlayThread } from './overlay-client';
import { streamMarkdown } from './streaming-markdown';
import { captureTranscriptAnchor } from './transcript-scroll';
import { groupTurns, turnLabel, type TranscriptTurn } from './turn-activity';
import { errorText } from './error-text';
import { DISMISS_BATCH, errorSummary, groupErrors } from './thread-errors';
import { decodeToolActivity, groupToolRuns, renderToolGroup, renderToolStatus } from './tool-activity';
import { renderCoordination } from './coordination-message';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import { decodeHandoff, historicalProvider } from './provider-handoff';
import { attachToolImages } from './tool-image-viewer';
import type { ToolImageLoader } from './tool-images';
// The viewer's own styles; under `is-launcher` they also carry the tokens motion.css and design-system.css give the app.
import './tool-images.css';

/** Tool-row images in the launcher come from the same `tool_image` command as the app's transcript. */
const overlayImageLoader: ToolImageLoader = (sessionId, path, maxEdge) =>
  overlayCall<string>('tool_image', maxEdge ? { sessionId, path, maxEdge } : { sessionId, path });
import type { Message, ProviderId, Session } from './types';

/** The overlay is narrow: a row's summary keeps to about two lines; the rest opens below it. */
const OVERLAY_ERROR_SUMMARY = 160;
/** How long Undo stays on offer before the saved rows are deleted: the main window's Undo toast (`hideToastLater` for an
 * undo in src/main.ts) shows for the same 5000 ms. */
const UNDO_MS = 5000;
/** While the Undo line has focus or the pointer, the window is held; this is how often that is looked at again. */
const UNDO_RECHECK_MS = 2000;
/** One error group, like the thread's row: danger icon, clamped summary, `×N`, a chevron button for the rest of the text
 * (a focusable region named by the summary) and a dismiss button described by the summary. No whitespace between tags:
 * the box keeps `white-space: pre-wrap`. */
function errorRowHtml(content: string, count: number, ids: number[], open: boolean): string {
  const { summary, detail: whole } = errorSummary(content, OVERLAY_ERROR_SUMMARY), summaryId = `launcher-error-${String(ids[0]).replace('-', 'n')}`, detailId = `${summaryId}-detail`;
  // A clamped summary comes with the full text as its detail: show only what follows the summary, so no sentence repeats.
  const cut = summary.endsWith('…') && whole !== null && whole.startsWith(summary.slice(0, -1));
  const detail = cut ? `…${whole.slice(summary.length - 1)}` : whole;
  const repeat = count > 1 ? `<span class="launcher-error-count"><span aria-hidden="true"> ×${count}</span><span class="sr-only">Repeated ${count} times</span></span>` : '';
  const toggle = detail === null ? '' : `<button type="button" class="launcher-error-toggle" aria-label="Error details" aria-describedby="${summaryId}" aria-expanded="${open}" aria-controls="${detailId}">${icon('chevron')}</button>`;
  const more = detail === null ? '' : `<div class="launcher-error-detail" id="${detailId}" role="region" aria-labelledby="${summaryId}" tabindex="0"${open ? '' : ' hidden'}>${escape(detail)}</div>`;
  return `<div class="launcher-error-row" data-error-ids="${ids.join(' ')}"><span class="launcher-error-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="launcher-error-summary" id="${summaryId}">${escape(summary)}</span>${repeat}${toggle}<button type="button" class="launcher-error-dismiss" aria-label="Dismiss error" aria-describedby="${summaryId}">${icon('close')}</button>${more}</div>`;
}
/** Like the main window's fold: a turn with no prompt, step, reply, note or changes joins the turn before it (never a
 * handoff), so a run of failures reads as one group. Dismissed ids are dropped first; an emptied errors-only turn goes. */
export function foldErrorTurns(turns: TranscriptTurn[], hidden: ReadonlySet<number>): TranscriptTurn[] {
  const shown: TranscriptTurn[] = [];
  for (const turn of turns) {
    const errors = hidden.size ? turn.errors.filter(message => !hidden.has(message.id)) : turn.errors;
    const alone = !turn.user && !turn.coordination && !turn.handoff && !turn.activity.length && !turn.final && !turn.notes.length && !turn.changes;
    const previous = shown.at(-1);
    if (alone && !errors.length) continue;
    // An errors-only turn has no prompt, so `groupTurns` gives it no duration of its own: the previous turn's is kept.
    if (alone && previous && !previous.handoff) shown[shown.length - 1] = { ...previous, errors: [...previous.errors, ...errors] };
    else shown.push(errors === turn.errors ? turn : { ...turn, errors });
  }
  return shown;
}
/** A dismissal waiting out its Undo window: the native delete runs at expiry or earlier (see `flushUndo`). */
interface PendingDismissal { ids: number[]; saved: number[]; sessionId: string; generation: number; timer: number; first: string }
const statusLabel = (value: string) => ({ running:'Working', waiting:'Needs attention', coordinating:'Coordinating', idle:'Ready', completed:'Completed', error:'Failed', failed:'Failed', stopped:'Stopped', interrupted:'Paused' }[value] || value);

/** The selected transcript is loaded on demand; the launcher never mounts the workspace. */
export class OverlayThreadView {
  private task?: OverlayTask;
  private generation = 0;
  private active = true;
  private loading = false;
  private queued = false;
  private timer = 0;
  private lastLoad = 0;
  private olderLoading = false;
  private hasOlder = false;
  private messages = new Map<number, Message>();
  private turns = new Map<string, HTMLElement>();
  private activityMessages = new WeakMap<HTMLElement, Message[]>();
  /** Error rows dismissed here, by saved id: hidden at once, deleted natively (`dismiss_error_messages`), and put
   * back if that fails. Rows without a saved id (live, id <= 0) are hidden in this view only. */
  private dismissedErrors = new Set<number>();
  private errorsHtml = new WeakMap<HTMLElement, string>();
  private openErrors = new Set<string>();
  private undo?: PendingDismissal;
  private undoBox: HTMLElement;
  private undoText: HTMLElement;
  private initial = true;
  private latest?: OverlayThread;
  private unsubscribe?: () => void;
  private scroll: HTMLElement;
  private history: HTMLElement;
  private notice: HTMLElement;
  constructor(private host: HTMLElement, private back: () => void, private opened?: (task: OverlayTask) => void) {
    host.className = 'launcher-thread'; host.hidden = true;
    host.setAttribute('aria-label', 'Agent conversation');
    host.innerHTML = `<header class="launcher-thread-heading"><button class="launcher-thread-back" aria-label="Back to active agents">${icon('back')}</button><span class="launcher-thread-provider"></span><div><h2></h2><p></p></div></header><div class="launcher-thread-scroll" tabindex="0" aria-label="Conversation"><div class="launcher-thread-history"></div><p class="launcher-thread-empty" role="status">Loading conversation…</p><p class="launcher-thread-notice" role="status" hidden></p><button class="launcher-thread-retry" hidden>Retry loading conversation</button></div><div class="launcher-thread-undo" hidden><span role="status"></span><button type="button" aria-keyshortcuts="Meta+Z Control+Z">Undo</button></div><footer class="launcher-thread-footer"><span class="launcher-thread-status" role="status"></span><button class="launcher-thread-app">Open in app ${icon('forward')}</button></footer>`;
    this.scroll = host.querySelector('.launcher-thread-scroll')!;
    this.history = host.querySelector('.launcher-thread-history')!;
    this.notice = host.querySelector('.launcher-thread-notice')!;
    // Thumbnails in tool rows load with the thread shown when they rendered and open the viewer, never toggling the row.
    // The launcher may not reveal files (`reveal_path` is the app's), so its viewer has no Reveal button.
    attachToolImages(this.history, () => this.task?.sessionId ?? '', overlayImageLoader, { launcher: true });
    this.undoBox = host.querySelector('.launcher-thread-undo')!;
    this.undoText = this.undoBox.querySelector('span')!;
    // Cmd/Ctrl+Z undoes the pending dismissal, as in the main window; a text field keeps its own undo.
    document.addEventListener('keydown', event => {
      const field = (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable=false])');
      if (event.defaultPrevented || !this.undo || this.host.hidden || field || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault(); this.undoDismissal();
    });
    for (const id of replayedDismissals) this.dismissedErrors.add(id); // a replay at launch keeps its rows gone
    // The launcher hiding must not lose a pending delete.
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.flushUndo(); });
    window.addEventListener('pagehide', () => void this.flushUndo());
    bindMessageActions(host, {
      content: (sessionId, key) => {
        if (this.task?.sessionId !== sessionId) return undefined;
        const id = Number(key);
        if (this.latest?.subagent) return id === 0 ? this.latest.subagent.prompt : this.latest.subagent.response;
        return id === Number.MAX_SAFE_INTEGER ? this.latest?.liveText : overlayCall<string>('get_message_content', {sessionId, messageId: id});
      },
      onFork: async (sessionId, messageId) => {
        const source = this.task, generation = this.generation;
        if (!source || source.sessionId !== sessionId || source.subagentId || !this.messages.has(messageId)) return;
        const fork = await overlayCall<Session>('fork_session_at_message', {sessionId,messageId});
        // A fork stays in this lightweight panel. Only the explicit footer opens the workspace.
        if (generation !== this.generation || !this.active) return;
        this.open({id:fork.id,sessionId:fork.id,kind:'task',title:fork.title,projectId:fork.projectId,projectName:source.projectName,provider:fork.provider,status:fork.status,updatedAt:fork.updatedAt});
      },
      report: error => this.error(error),
    });
    host.querySelector('.launcher-thread-back')!.addEventListener('click', back);
    host.querySelector('.launcher-thread-app')!.addEventListener('click', () => {
      const task = this.task;
      if (task) void overlayCall('overlay_open_task', {sessionId:task.sessionId, ...(task.subagentId ? {subagentId:task.subagentId} : {})}).catch(error => this.error(error));
    });
    host.querySelector('.launcher-thread-retry')!.addEventListener('click', () => this.refresh());
    host.addEventListener('click', event => {
      const target = event.target as Element, dismiss = target.closest<HTMLElement>('.launcher-error-dismiss'), toggle = target.closest<HTMLElement>('.launcher-error-toggle');
      const all = target.closest<HTMLElement>('.launcher-error-dismiss-all');
      if (all) this.dismissRows([...(all.closest('.launcher-thread-errors')?.querySelectorAll<HTMLElement>('.launcher-error-row') ?? [])]);
      else if (dismiss) this.dismissRows([dismiss.closest<HTMLElement>('.launcher-error-row')!]);
      else if (toggle) this.toggleError(toggle);
      else if (target.closest('.launcher-thread-undo button')) this.undoDismissal();
    });
    this.scroll.addEventListener('scroll', () => {
      if (this.scroll.scrollTop < 40 && !this.initial && this.scroll.scrollHeight > this.scroll.clientHeight + 80) void this.loadOlder();
    });
    this.scroll.addEventListener('wheel', event => { if (event.deltaY < 0 && this.scroll.scrollTop < 40 && !this.initial) void this.loadOlder(); }, { passive: true });
  }
  open(task: OverlayTask): void {
    this.close(); this.task = task; this.host.hidden = false; this.initial = true;
    this.opened?.(task);
    this.host.querySelector('h2')!.textContent = task.title;
    this.host.querySelector('.launcher-thread-heading p')!.textContent = [task.kind === 'worker' ? 'Worker' : task.kind === 'subagent' ? 'Subagent' : '', task.projectName].filter(Boolean).join(' · ');
    this.host.querySelector('.launcher-thread-provider')!.innerHTML = providerLogo(task.provider as ProviderId);
    this.host.querySelector('.launcher-thread-status')!.textContent = statusLabel(task.status);
    const generation = this.generation;
    void overlayEvents(event => {
      if (!this.active || event.sessionId !== this.task?.sessionId) return;
      if (this.task.subagentId && event.kind !== 'subagent' && event.kind !== 'done' && event.kind !== 'error') return;
      if (this.task.subagentId && event.kind === 'subagent') {
        const child = event.data as {id?: string} | undefined;
        if (child?.id && child.id !== this.task.subagentId) return;
      }
      this.refresh();
    }).then(unsubscribe => { if (generation === this.generation) this.unsubscribe = unsubscribe; else unsubscribe(); });
    this.refresh(); this.host.querySelector<HTMLButtonElement>('.launcher-thread-back')!.focus();
  }
  close(): void {
    void this.flushUndo();
    this.generation++; this.task = undefined; clearTimeout(this.timer); this.timer = 0;
    this.unsubscribe?.(); this.unsubscribe = undefined; this.loading = false; this.queued = false; this.olderLoading = false;
    this.messages.clear(); this.turns.clear(); this.history.replaceChildren(); this.host.hidden = true; this.hasOlder = false;
    this.latest = undefined;
    this.notice.hidden = true; this.host.querySelector<HTMLElement>('.launcher-thread-retry')!.hidden = true;
    this.host.querySelector<HTMLElement>('.launcher-thread-empty')!.hidden = false;
    this.host.querySelector('.launcher-thread-empty')!.textContent = 'Loading conversation…';
    this.lastLoad = 0;
  }
  setVisible(value: boolean): void {
    this.active = value;
    if (!value) void this.flushUndo();
    if (value) this.refresh(); else { clearTimeout(this.timer); this.timer = 0; }
  }
  refresh(): void {
    if (!this.task || !this.active) return;
    if (this.loading) { this.queued = true; return; }
    if (this.timer) return;
    // Coalesce provider bursts into exact snapshots: no duplicated/missed deltas
    // when a thread is opened halfway through a response.
    const delay = Math.max(0, 200 - (performance.now() - this.lastLoad));
    this.timer = window.setTimeout(() => { this.timer = 0; void this.load(); }, delay);
  }
  private async load(): Promise<void> {
    const task = this.task, generation = this.generation;
    if (!task || !this.active) return;
    this.loading = true; this.lastLoad = performance.now();
    try {
      const thread = await overlayCall<OverlayThread>('overlay_thread', {sessionId:task.sessionId, ...(task.subagentId ? {subagentId:task.subagentId} : {}), ...(this.latest?.historyVersion !== undefined ? {historyVersion:this.latest.historyVersion} : {})});
      if (generation !== this.generation || !this.active) return;
      const providerChanged = thread.provider !== undefined && thread.provider !== task.provider;
      if (providerChanged) {
        task.provider = thread.provider!;
        this.host.querySelector('.launcher-thread-provider')!.innerHTML = providerLogo(thread.provider!);
      }
      // Native history revisions let idle polls leave the transcript untouched.
      // Recovery must repaint: an error may have hidden the empty-state message.
      const unchanged = !providerChanged && !this.initial && this.notice.hidden && thread.historyUnchanged && !thread.messages.length
        && !task.subagentId && !thread.subagent && !this.latest?.subagent
        && this.latest?.liveText === thread.liveText && this.latest.status === thread.status;
      this.notice.hidden = true; this.host.querySelector<HTMLElement>('.launcher-thread-retry')!.hidden = true;
      const previousLast = this.messages.size ? Math.max(...this.messages.keys()) : undefined;
      let first = thread.messages[0]?.id, hasOlder = thread.hasOlder;
      // Retain scrollback and bridge a burst that persisted more than one page.
      while (previousLast !== undefined && first !== undefined && first > previousLast && hasOlder) {
        const gap = await overlayCall<OverlayThread>('overlay_thread', {sessionId:task.sessionId,beforeId:first});
        if (generation !== this.generation || !this.active) return;
        if (!gap.messages.length || gap.messages[0].id >= first) break;
        thread.messages = [...gap.messages, ...thread.messages]; first = thread.messages[0].id; hasOlder = gap.hasOlder;
      }
      const previousFirst = this.messages.size ? Math.min(...this.messages.keys()) : undefined;
      for (const message of thread.messages) this.messages.set(message.id, message);
      if (!thread.historyUnchanged && (previousFirst === undefined || first !== undefined && first <= previousFirst)) this.hasOlder = hasOlder;
      this.latest = thread;
      if (!unchanged) this.paint(thread);
    } catch (error) { if (generation === this.generation && this.active) this.error(error); }
    finally {
      if (generation === this.generation) {
        this.loading = false;
        if (this.queued) { this.queued = false; this.refresh(); }
      }
    }
  }
  private async loadOlder(): Promise<void> {
    if (!this.task || !this.active || this.olderLoading || !this.hasOlder || this.task.subagentId) return;
    const beforeId = Math.min(...this.messages.keys()), task = this.task, generation = this.generation;
    if (!Number.isFinite(beforeId)) return;
    this.olderLoading = true;
    let loaded = false;
    try {
      const page = await overlayCall<OverlayThread>('overlay_thread', {sessionId:task.sessionId,beforeId});
      if (generation !== this.generation || !this.active) return;
      const restore = captureTranscriptAnchor(this.scroll);
      const previousFirst = Math.min(...this.messages.keys());
      const incoming = page.messages.filter(message => message.id < beforeId);
      const added = incoming.filter(message => !this.messages.has(message.id));
      for (const message of added) this.messages.set(message.id,message);
      if (incoming.length && incoming[0].id <= previousFirst) this.hasOlder = page.hasOlder;
      else if (!incoming.length && previousFirst === beforeId) this.hasOlder = false;
      this.paint(this.latest || page);
      restore();
      loaded = added.length > 0;
    } catch (error) { if (generation === this.generation && this.active) this.error(error); }
    finally { if (generation === this.generation) { this.olderLoading = false; if (loaded) this.fillHistory(); } }
  }
  private fillHistory(): void {
    // A page full of collapsed tools may occupy only a few pixels. Load another
    // bounded page so earlier conversation is reachable without a dead scroll area.
    if (!this.initial && this.scroll.scrollHeight <= this.scroll.clientHeight + 80) void this.loadOlder();
  }
  private paint(thread: OverlayThread): void {
    if (!this.task) return;
    const follow = this.initial || this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 90;
    const restore = follow ? undefined : captureTranscriptAnchor(this.scroll);
    let messages = [...this.messages.values()].sort((a,b) => a.id-b.id);
    const child = thread.subagent;
    if (child) {
      messages = [];
      const add = (id: number, role: string, content: string) => messages.push({id,role,content,sessionId:this.task!.sessionId,createdAt:child.startedAt});
      if (child.prompt) add(0,'user',child.prompt);
      child.tools.forEach((tool,i) => add(i+1,'tool',JSON.stringify({type:'tool_activity',version:1,...tool})));
      if (child.response) add(Number.MAX_SAFE_INTEGER,'assistant',child.response);
    } else if (thread.liveText) messages.push({id:Number.MAX_SAFE_INTEGER,sessionId:this.task.sessionId,role:'assistant',content:thread.liveText,createdAt:Date.now()});
    const grouped = foldErrorTurns(groupTurns(messages), this.dismissedErrors), keys = new Set<string>();
    grouped.forEach((turn,index) => {
      const key = turn.handoff ? `handoff:${turn.handoff.id}` : String(turn.user?.id ?? turn.coordination?.id ?? turn.activity[0]?.id ?? turn.final?.id ?? turn.errors[0]?.id ?? index); keys.add(key);
      let node = this.turns.get(key);
      if (!node) { node = document.createElement('section'); node.className = 'launcher-thread-turn'; this.turns.set(key,node); }
      if (this.history.children[index] !== node) this.history.insertBefore(node,this.history.children[index] || null);
      this.paintTurn(node,turn,index === grouped.length-1,messages);
    });
    for (const [key,node] of this.turns) if (!keys.has(key)) { node.remove(); this.turns.delete(key); }
    this.host.querySelector<HTMLElement>('.launcher-thread-empty')!.hidden = messages.length > 0;
    this.host.querySelector('.launcher-thread-empty')!.textContent = 'The agent is getting started…';
    const status = this.host.querySelector<HTMLElement>('.launcher-thread-status')!;
    status.textContent = statusLabel(child?.status || thread.status); status.dataset.status = child?.status || thread.status; status.dataset.kind = this.task!.kind;
    if (follow) this.scroll.scrollTop = this.scroll.scrollHeight; else restore?.();
    this.initial = false;
    this.fillHistory();
  }
  private paintTurn(node: HTMLElement, turn: TranscriptTurn, last: boolean, messages: Message[]): void {
    if (turn.handoff) {
      if (!node.childElementCount) {
        const handoff = decodeHandoff(turn.handoff);
        if (handoff) node.innerHTML = `<details class="launcher-thread-handoff"><summary>${providerLogo(handoff.fromProvider)}${icon('forward')}${providerLogo(handoff.toProvider)}<span>Conversation carried forward</span>${icon('down')}</summary><p>${escape(handoff.summary)}</p></details>`;
      }
      return;
    }
    if (!node.childElementCount) node.innerHTML = `<article class="launcher-thread-message launcher-thread-user"><header>You</header><div></div></article><div class="launcher-thread-coordination" hidden></div><details class="launcher-thread-activity"><summary></summary><div></div></details><article class="launcher-thread-message launcher-thread-response"><header></header><div></div></article><div class="launcher-thread-errors"></div>`;
    const user = node.querySelector<HTMLElement>('.launcher-thread-user')!; user.hidden = !turn.user;
    if (turn.user) { user.dataset.messageId = String(turn.user.id); streamMarkdown(user.querySelector('div')!,turn.user.content,this.scroll); this.paintActions(user, turn.user); }
    const coordination = node.querySelector<HTMLElement>('.launcher-thread-coordination')!;
    coordination.hidden = !turn.coordination;
    const kind = turn.coordination?.coordinationKind ?? '';
    if (turn.coordination && (!coordination.childElementCount || coordination.dataset.kind !== kind)) {
      coordination.innerHTML = renderCoordination(turn.coordination); coordination.dataset.kind = kind;
    }
    const details = node.querySelector<HTMLDetailsElement>('.launcher-thread-activity')!; details.hidden = !turn.activity.length;
    if (turn.activity.length && !details.dataset.initialized) {
      details.open = last && ['running','waiting','coordinating'].includes(this.latest?.subagent?.status || this.latest?.status || this.task!.status);
      details.dataset.initialized = 'true';
    }
    const toolCount = turn.activity.filter(message => message.role === 'tool' && message.content !== 'Tool finished').length;
    details.querySelector('summary')!.textContent = `${turnLabel(turn.durationMs,turn.estimated)}${toolCount ? ` · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : ''}`;
    const activity = details.querySelector('div')!;
    const previous = this.activityMessages.get(activity);
    if (!previous || previous.length !== turn.activity.length || turn.activity.some((message,index) => message.id !== previous[index].id || message.content !== previous[index].content)) {
      const opened = new Set([...activity.querySelectorAll<HTMLDetailsElement>('details[open]')].map(detail => detail.dataset.toolGroupKey ?? detail.dataset.toolKey));
      const toolKey = (message: Message) => {
        if (message.role !== 'tool' || message.content === 'Tool finished') return;
        const tool = decodeToolActivity(message.content);
        return tool ? `tool:${tool.id}` : `message:${message.id}`;
      };
      const running = last && ['running','waiting','coordinating'].includes(this.latest?.subagent?.status || this.latest?.status || this.task!.status);
      const runs = groupToolRuns(turn.activity,toolKey);
      activity.innerHTML = runs.map((run,index) => {
        if (run.kind === 'tools') return renderToolGroup(run.items.map(message => ({key:toolKey(message)!,content:message.content})), false, running && index === runs.length - 1);
        const message = run.item;
        if (message.role === 'tool') return renderToolStatus(message.content);
        return `<article class="launcher-thread-message"${message.role === 'assistant' ? ` data-commentary="${message.id}" data-message-id="${message.id}"` : ''}><div></div>${message.role === 'assistant' || message.role === 'user' ? messageActionsHtml(message.sessionId, message.id, this.canFork(message)) : ''}</article>`;
      }).join('');
      const narratives = activity.querySelectorAll<HTMLElement>(':scope > .launcher-thread-message');
      turn.activity.filter(message => message.role !== 'tool').forEach((message,index) => streamMarkdown(narratives[index].querySelector('div')!,message.content,this.scroll));
      activity.querySelectorAll<HTMLDetailsElement>('details').forEach(detail => { detail.open = opened.has(detail.dataset.toolGroupKey ?? detail.dataset.toolKey); });
      this.activityMessages.set(activity,turn.activity);
    }
    const response = node.querySelector<HTMLElement>('.launcher-thread-response')!; response.hidden = !turn.final;
    response.classList.toggle('launcher-thread-live', last);
    const names: Record<string,string> = {codex:'Codex',claude:'Claude Code',kimi:'Kimi Code',opencode:'OpenCode',glm:'GLM',antigravity:'Antigravity',grok:'Grok Build',mimo:'MiMo Token Plan',pi:'Pi',deepseek:'DeepSeek',commandcode:'Command Code',cline:'Cline',kilo:'Kilo Code',omp:'Oh My Pi','github-copilot':'GitHub Copilot CLI',muse:'Muse Code',devin:'Devin CLI',zcode:'ZCode',hermes:'Hermes Agent'};
    const heading = response.querySelector('header')!;
    const author = turn.final ? historicalProvider(turn.final, messages, this.task!.provider as ProviderId) : this.task!.provider;
    if (heading.dataset.provider !== author) {
      heading.innerHTML = `${providerLogo(author as ProviderId)}<span>${escape(names[author] || author)}</span>`;
      heading.dataset.provider = author;
    }
    if (turn.final) { response.dataset.messageId = String(turn.final.id); streamMarkdown(response.querySelector('div')!,turn.final.content,this.scroll); this.paintActions(response, turn.final); }
    // Identical errors read once with their count (thread-errors.ts), one compact row each; notes follow as lines.
    const box = node.querySelector<HTMLElement>('.launcher-thread-errors')!;
    const groups = groupErrors(turn.errors.filter(message => !this.dismissedErrors.has(message.id)));
    const all = groups.length > 1 ? '<div class="launcher-error-all"><button type="button" class="launcher-error-dismiss-all">Dismiss all</button></div>' : '';
    const build = (withOpen: boolean) => all + groups.map(group => errorRowHtml(group.content, group.count, group.ids as number[], withOpen && this.openErrors.has(String(group.ids[0])))).join('')
      + turn.notes.map(message => `<p class="launcher-thread-note">${escape(message.content)}</p>`).join('');
    // Compared with every detail closed and rewritten only when that changes, so an opened detail or a focused button
    // survives refreshes; a rewrite restores the opened details from `openErrors`.
    const key = build(false);
    if (this.errorsHtml.get(box) !== key) { box.innerHTML = build(true); this.errorsHtml.set(box, key); }
  }
  private toggleError(button: HTMLElement): void {
    const row = button.closest<HTMLElement>('.launcher-error-row'), detail = row?.querySelector<HTMLElement>('.launcher-error-detail');
    if (!row || !detail) return;
    const open = button.getAttribute('aria-expanded') !== 'true', first = (row.dataset.errorIds ?? '').split(' ')[0];
    button.setAttribute('aria-expanded', String(open)); detail.hidden = !open;
    if (open) this.openErrors.add(first); else this.openErrors.delete(first);
  }
  /** Hides rows at once (one for a row's ×, all of a turn's for Dismiss all) and offers one Undo; the saved rows are deleted
   * natively when the window passes (`flushUndo`). Focus moves to the next row's dismiss, else the conversation. */
  private dismissRows(rows: HTMLElement[]): void {
    const sessionId = this.task?.sessionId;
    if (!rows.length || !sessionId) return;
    void this.flushUndo(); // a second dismissal commits the first
    const ids = rows.flatMap(row => (row.dataset.errorIds ?? '').split(' ').map(Number).filter(id => Number.isInteger(id)));
    for (const id of ids) this.dismissedErrors.add(id);
    const last = rows[rows.length - 1], first = rows[0];
    const next = last.nextElementSibling?.querySelector<HTMLElement>('.launcher-error-dismiss') ?? first.previousElementSibling?.querySelector<HTMLElement>('.launcher-error-dismiss');
    const firstKey = first.dataset.errorIds ?? '';
    for (const row of rows) row.remove();
    (next ?? this.scroll).focus({ preventScroll: true });
    journal(sessionId, ids.filter(id => id > 0), true); // a quit before the delete lands replays it next launch
    this.undo = { ids, saved: ids.filter(id => id > 0), sessionId, generation: this.generation, timer: window.setTimeout(() => this.undoExpired(), UNDO_MS), first: firstKey };
    this.undoText.textContent = rows.length === 1 ? 'Error dismissed' : `${rows.length} errors dismissed`;
    this.undoBox.hidden = false;
  }
  /** The window ran out: held while the Undo line has focus or the pointer (WCAG 2.2.1), looked at again shortly. */
  private undoExpired(): void {
    const pending = this.undo;
    if (!pending) return;
    if (this.undoBox.matches(':focus-within, :hover')) { pending.timer = window.setTimeout(() => this.undoExpired(), UNDO_RECHECK_MS); return; }
    void this.flushUndo();
  }
  /** Empties the Undo line; focus inside it first moves to the first error row's dismiss, else the conversation. */
  private clearUndoBox(): void {
    if (this.undoBox.contains(document.activeElement)) (this.history.querySelector<HTMLElement>('.launcher-error-dismiss') ?? this.scroll).focus({ preventScroll: true });
    this.undoText.textContent = ''; this.undoBox.hidden = true;
  }
  private undoDismissal(): void {
    const pending = this.undo;
    if (!pending) return;
    clearTimeout(pending.timer); this.undo = undefined; this.clearUndoBox();
    journal(pending.sessionId, pending.saved, false);
    this.restore(pending.ids);
    this.host.querySelector<HTMLElement>(`.launcher-error-row[data-error-ids="${pending.first}"] .launcher-error-dismiss`)?.focus({ preventScroll: true });
  }
  private restore(ids: number[]): void {
    for (const id of ids) this.dismissedErrors.delete(id);
    this.errorsHtml = new WeakMap(); // the cached markup lacks the row: force the repaint
    if (this.latest) this.paint(this.latest);
  }
  /** Ends the Undo window now: deletes the saved ids in batches. A failure puts the rest back with the reason. */
  private async flushUndo(): Promise<void> {
    const pending = this.undo;
    if (!pending) return;
    clearTimeout(pending.timer); this.undo = undefined; this.clearUndoBox();
    let done = 0;
    try {
      for (; done < pending.saved.length; done += DISMISS_BATCH) await overlayCall('dismiss_error_messages', { sessionId: pending.sessionId, ids: pending.saved.slice(done, done + DISMISS_BATCH) });
      journal(pending.sessionId, pending.saved, false);
    } catch (error) {
      journal(pending.sessionId, pending.saved, false); // restored below, or nothing more to try
      const deleted = new Set(pending.saved.slice(0, done));
      for (const id of deleted) this.messages.delete(id);
      const left = pending.ids.filter(id => !deleted.has(id));
      if (pending.generation !== this.generation) { for (const id of left) this.dismissedErrors.delete(id); return; }
      this.notice.textContent = `Couldn't dismiss the error. ${errorText(error)}`; this.notice.hidden = false;
      this.restore(left);
    }
  }
  private canFork(message: Message): boolean {
    return !this.task?.subagentId && message.id > 0 && message.id !== Number.MAX_SAFE_INTEGER && this.messages.has(message.id);
  }
  private paintActions(article: HTMLElement, message: Message): void {
    const key = `${message.sessionId}:${message.id}`;
    if (article.dataset.actionKey === key) return;
    article.querySelector('.message-actions')?.remove();
    article.insertAdjacentHTML('beforeend', messageActionsHtml(message.sessionId, message.id, this.canFork(message)));
    article.dataset.actionKey = key;
  }
  private error(error: unknown): void {
    this.notice.textContent = errorText(error); this.notice.hidden = false;
    this.host.querySelector<HTMLElement>('.launcher-thread-empty')!.hidden = true;
    this.host.querySelector<HTMLElement>('.launcher-thread-retry')!.hidden = false;
  }
}
