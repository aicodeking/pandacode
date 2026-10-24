import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { overlayCall, overlayEvents, type OverlayTask, type OverlayThread } from './overlay-client';
import { streamMarkdown } from './streaming-markdown';
import { captureTranscriptAnchor } from './transcript-scroll';
import { groupTurns, turnLabel, type TranscriptTurn } from './turn-activity';
import { decodeToolActivity, groupToolRuns, renderToolGroup, renderToolStatus } from './tool-activity';
import { renderCoordination } from './coordination-message';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import { decodeHandoff, historicalProvider } from './provider-handoff';
import type { Message, ProviderId, Session } from './types';

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
  private initial = true;
  private latest?: OverlayThread;
  private unsubscribe?: () => void;
  private scroll: HTMLElement;
  private history: HTMLElement;
  private notice: HTMLElement;
  constructor(private host: HTMLElement, private back: () => void, private opened?: (task: OverlayTask) => void) {
    host.className = 'launcher-thread'; host.hidden = true;
    host.setAttribute('aria-label', 'Agent conversation');
    host.innerHTML = `<header class="launcher-thread-heading"><button class="launcher-thread-back" aria-label="Back to active agents">${icon('back')}</button><span class="launcher-thread-provider"></span><div><h2></h2><p></p></div></header><div class="launcher-thread-scroll" tabindex="0" aria-label="Conversation"><div class="launcher-thread-history"></div><p class="launcher-thread-empty" role="status">Loading conversation…</p><p class="launcher-thread-notice" role="status" hidden></p><button class="launcher-thread-retry" hidden>Retry loading conversation</button></div><footer class="launcher-thread-footer"><span class="launcher-thread-status" role="status"></span><button class="launcher-thread-app">Open in app ${icon('forward')}</button></footer>`;
    this.scroll = host.querySelector('.launcher-thread-scroll')!;
    this.history = host.querySelector('.launcher-thread-history')!;
    this.notice = host.querySelector('.launcher-thread-notice')!;
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
    const grouped = groupTurns(messages), keys = new Set<string>();
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
    status.textContent = statusLabel(child?.status || thread.status); status.dataset.status = child?.status || thread.status;
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
      activity.innerHTML = groupToolRuns(turn.activity,toolKey).map(run => {
        if (run.kind === 'tools') return renderToolGroup(run.items.map(message => ({key:toolKey(message)!,content:message.content})));
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
    const names: Record<string,string> = {codex:'Codex',claude:'Claude Code',kimi:'Kimi Code',opencode:'OpenCode',glm:'GLM',antigravity:'Antigravity',grok:'Grok Build',mimo:'MiMo Token Plan',pi:'Pi',deepseek:'DeepSeek',commandcode:'Command Code',cline:'Cline',kilo:'Kilo Code',omp:'Oh My Pi','github-copilot':'GitHub Copilot CLI',muse:'Muse Code'};
    const heading = response.querySelector('header')!;
    const author = turn.final ? historicalProvider(turn.final, messages, this.task!.provider as ProviderId) : this.task!.provider;
    if (heading.dataset.provider !== author) {
      heading.innerHTML = `${providerLogo(author as ProviderId)}<span>${escape(names[author] || author)}</span>`;
      heading.dataset.provider = author;
    }
    if (turn.final) { response.dataset.messageId = String(turn.final.id); streamMarkdown(response.querySelector('div')!,turn.final.content,this.scroll); this.paintActions(response, turn.final); }
    node.querySelector('.launcher-thread-errors')!.textContent = turn.errors.map(message => message.content).join('\n');
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
    this.notice.textContent = error instanceof Error ? error.message : String(error); this.notice.hidden = false;
    this.host.querySelector<HTMLElement>('.launcher-thread-empty')!.hidden = true;
    this.host.querySelector<HTMLElement>('.launcher-thread-retry')!.hidden = false;
  }
}
