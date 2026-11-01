// The inspector's "By the way" tab: one side thread beside the main thread (docs/btw.md).
// It draws the side thread with the main transcript's own renderers and composer pieces,
// supplied by main.ts through the host, so both read and behave alike.
import { escape, icon } from './dom';
import { TITLE_PREFIX, parseBtw } from './btw';
import type { Message, MessagePage, Session } from './types';

export interface BtwPanelHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** The side thread shown for the current main thread, if any. */
  side(): { session: Session; hiddenThrough: number } | undefined;
  running(sideId: string): boolean;
  /** A live or just-finished turn is on screen for the side thread. */
  streaming(sideId: string): boolean;
  waiting(sideId: string): boolean;
  mainRunning(): boolean;
  draft(sideId: string): string;
  setDraft(sideId: string, text: string): void;
  /** The saved rows that show while `messages` stream (the main transcript's slice). */
  visible(sideId: string, messages: Message[]): Message[];
  /** Replaces every row of `log` before `region` with the saved turns, as the main transcript draws them. */
  renderRows(log: HTMLElement, region: HTMLElement, side: Session, visible: Message[], all: Message[], follow: () => void): void;
  paintStream(region: HTMLElement, sideId: string, log: HTMLElement): void;
  /** The approval bar and queue above the prompt. */
  aboveHtml(side: Session): string;
  /** The composer toolbar: model, effort and permissions, then Steer and Send or Stop. */
  toolsHtml(side: Session | undefined): string;
  /** A menu is open or opening from an element inside `root`, so it must not be replaced. */
  menuBusy(root: HTMLElement): boolean;
  /** Slash commands and @ mentions on the side prompt; returns their cleanup. */
  mountPickers(textarea: HTMLTextAreaElement, side: Session): () => void;
  bindActions(root: HTMLElement): void;
  /** Sends as a /btw message (with main-thread context), creating the side thread if needed. */
  send(text: string): Promise<void>;
  queue(side: Session, text: string): Promise<void>;
  steer(side: Session, text: string): Promise<void>;
  /** Runs an app slash command on the side thread: false when `text` is not one, a string to send instead, else true. */
  command(side: Session, text: string): Promise<boolean | string>;
  openFull(sideId: string): void;
  newThread(): void;
  close(): void;
  insertMain(text: string): void;
  report(error: unknown): void;
}

/** The header, log and composer are built once; updates touch only what changed, so typing,
 *  the caret, IME composition, open menus and folded tools survive streaming. */
export class BtwPanel {
  private root?: HTMLElement;
  private messages: Message[] = [];
  private loadedFor = '';
  private rowsKey = '';
  private frame = 0;
  private retry = 0;
  /** Edit was pressed on a queued message here: the editor the next redraw adds takes focus. */
  private editing = false;
  private tick = 0;
  /** The run ended and its saved copy has not loaded yet: the live turn stays on screen until then. */
  private awaiting = false;
  private stick = true;
  private pickers?: { sideId: string; dispose: () => void };
  constructor(private host: BtwPanelHost) {}

  show(target: HTMLElement): void {
    if (!this.root || this.root.parentElement !== target) target.replaceChildren(this.build());
    this.update();
  }
  /** Hidden: the next `show` reloads, so nothing stale comes back. */
  dispose(): void {
    this.pickers?.dispose(); this.pickers = undefined;
    this.root = undefined; this.loadedFor = ''; this.rowsKey = ''; this.awaiting = false;
    cancelAnimationFrame(this.frame); this.frame = 0; clearTimeout(this.retry);
  }
  /** The id of the side thread on screen, if the panel shows one. */
  shownId(): string | undefined { return this.root?.isConnected ? this.loadedFor || undefined : undefined; }
  /** Called for agent events and the side thread's queue, steer and approval changes; redraws once per frame. */
  event(sessionId: string, kind: string): void {
    if (!this.root?.isConnected || sessionId !== this.loadedFor) return;
    if (kind === 'steer') this.tick++;
    if (kind === 'done') { this.awaiting = true; void this.reload(); return; }
    if (kind === 'turn_changes') void this.reload();
    this.refresh();
  }
  refresh(): void {
    if (this.root?.isConnected && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }
  /** The side thread's harness changed: its saved rows are re-read under the new one. */
  harnessChanged(): void { this.rowsKey = ''; void this.reload(); }
  /** A shown side-thread message, for its attachment chips and Copy. */
  message(id: number): Message | undefined { return this.messages.find(m => m.id === id); }
  async reload(): Promise<void> {
    const sideId = this.loadedFor;
    if (!sideId) return;
    try {
      const page = await this.host.call<MessagePage>('get_messages', { sessionId: sideId });
      if (sideId !== this.loadedFor) return;
      // A sent message stays on screen until its saved copy arrives; once the run is over (or the
      // send failed) only saved messages remain.
      const running = this.host.running(sideId);
      const pending = running ? this.messages.filter(m => m.id < 0 && m.role === 'user' && !page.messages.some(saved => saved.role === 'user' && saved.content === m.content)) : [];
      this.messages = [...page.messages, ...pending];
      this.awaiting = false;
      this.update();
    } catch (error) { this.awaiting = false; this.update(); this.host.report(error); }
  }
  focus(): void { this.root?.querySelector<HTMLTextAreaElement>('.btw-input')?.focus(); }
  /** Shows a sent message until the saved one arrives. */
  sent(sideId: string, message: Message): void {
    if (sideId !== this.loadedFor || this.messages.includes(message)) return;
    this.messages = [...this.messages, message]; this.stick = true; this.update();
  }
  unsent(sideId: string, message: Message): void {
    if (sideId !== this.loadedFor) return;
    this.messages = this.messages.filter(m => m !== message); this.update();
  }

  private build(): HTMLElement {
    this.pickers?.dispose(); this.pickers = undefined; this.rowsKey = '';
    const root = this.root = document.createElement('div');
    root.className = 'btw-panel';
    root.innerHTML = `<header class="btw-head"><div><strong></strong><small role="status"></small></div><div class="btw-actions"><button class="icon-button" data-btw="new" aria-label="New side thread" title="New side thread">${icon('plus')}</button><button class="icon-button" data-btw="open" aria-label="Open side thread as a full thread" title="Open as full thread">${icon('external')}</button><button class="icon-button" data-btw="close" aria-label="Close side thread panel" title="Close">${icon('close')}</button></div></header><div class="inspector-empty btw-empty">${icon('chat')}<h3>No side thread yet</h3><p>Ask something on the side while this task keeps working. Type <code>/btw</code> and a question in the prompt, or write it here.</p></div><div class="transcript btw-transcript" role="log" aria-label="Side thread conversation" aria-live="off" tabindex="0"><div class="btw-stream-region"></div></div><div class="btw-composer-area"><div class="btw-above"></div><form class="composer btw-composer"><textarea class="btw-input" rows="2" aria-label="Message the side thread"></textarea><div class="composer-toolbar btw-toolbar"></div></form></div>`;
    const input = root.querySelector<HTMLTextAreaElement>('.btw-input')!, log = root.querySelector<HTMLElement>('.btw-transcript')!;
    const resize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden'; };
    input.addEventListener('input', () => { if (this.loadedFor) this.host.setDraft(this.loadedFor, input.value); resize(); });
    log.addEventListener('scroll', () => { this.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 48; }, { passive: true });
    root.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); this.submit(false); });
    // Listening on the form lets the slash and @ pickers (on the textarea) take Enter first.
    root.querySelector('form')!.addEventListener('keydown', event => {
      if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); this.submit(event.metaKey || event.ctrlKey);
    });
    // Esc leaves the panel for the main prompt; it never reaches the global stop-the-agent key.
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
    });
    // Header and Insert buttons act without taking focus or the text selection.
    root.addEventListener('mousedown', event => { if ((event.target as HTMLElement).closest('.btw-head button, [data-btw-insert]')) event.preventDefault(); });
    root.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('[data-action="queue-edit"]')) this.editing = true;
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-btw], [data-btw-insert]');
      if (!button || button.disabled) return;
      const side = this.host.side();
      if (button.dataset.btw === 'new') this.host.newThread();
      else if (button.dataset.btw === 'open' && side) this.host.openFull(side.session.id);
      else if (button.dataset.btw === 'close') this.host.close();
      else if (button.dataset.btw === 'steer') this.submit(true);
      else if (button.dataset.btwInsert) {
        const message = this.messages.find(m => String(m.id) === button.dataset.btwInsert);
        if (message) this.host.insertMain(message.content);
      }
    });
    this.host.bindActions(root);
    return root;
  }

  /** Enter sends (a new turn) while idle and queues while the side agent works; ⌘/Ctrl Enter or Steer steers. */
  private submit(steer: boolean): void {
    const input = this.root?.querySelector<HTMLTextAreaElement>('.btw-input');
    if (!input) return;
    const typed = input.value.trim();
    // `/btw` here just means this side thread.
    const text = parseBtw(typed) ?? typed;
    if (!text) { input.value = ''; return; }
    const side = this.host.side()?.session, sideId = side?.id ?? '';
    const running = side ? this.host.running(side.id) : false;
    input.value = ''; if (sideId) this.host.setDraft(sideId, '');
    const work = !side ? this.host.send(text)
      : running ? (steer ? this.host.steer(side, text) : this.host.queue(side, text))
      : this.host.command(side, text).then(done => done === true ? undefined : this.host.send(done || text));
    this.stick = true;
    work.catch(error => {
      // Put the text back in whichever composer is showing now, unless something new was typed.
      const current = this.root?.querySelector<HTMLTextAreaElement>('.btw-input');
      if (sideId && !this.host.draft(sideId)) this.host.setDraft(sideId, typed);
      if (current && !current.value && (!sideId || sideId === this.loadedFor)) current.value = typed;
      this.host.report(error);
    }).finally(() => this.refresh());
  }

  private update(): void {
    const root = this.root;
    if (!root?.isConnected) return;
    const side = this.host.side(), input = root.querySelector<HTMLTextAreaElement>('.btw-input')!;
    if (!side) { this.loadedFor = ''; this.messages = []; this.awaiting = false; this.pickers?.dispose(); this.pickers = undefined; }
    else if (side.session.id !== this.loadedFor) {
      this.loadedFor = side.session.id; this.messages = []; this.rowsKey = ''; this.awaiting = false; this.stick = true;
      const draft = this.host.draft(side.session.id);
      if (draft && !input.value) input.value = draft;
      void this.reload();
    }
    const log = root.querySelector<HTMLElement>('.btw-transcript')!;
    root.querySelector<HTMLElement>('.btw-head')!.hidden = !side;
    root.querySelector<HTMLElement>('.btw-empty')!.hidden = Boolean(side);
    log.hidden = !side;
    this.paintComposer(root, side?.session);
    if (!side) return;
    const id = side.session.id, running = this.host.running(id), waiting = this.host.waiting(id);
    const title = side.session.title.startsWith(TITLE_PREFIX) ? side.session.title.slice(TITLE_PREFIX.length) : side.session.title;
    const head = root.querySelector<HTMLElement>('.btw-head strong')!;
    if (head.textContent !== title) { head.textContent = title; head.title = title; }
    const state = waiting ? 'Needs your input' : running ? 'Working' : 'Ready', main = this.host.mainRunning();
    const status = state + (main ? ' · main running' : '');
    const small = root.querySelector<HTMLElement>('.btw-head small')!;
    if (small.textContent !== status) { small.textContent = status; small.title = state + (main ? ' · the main thread is still running' : ''); }
    if (!input.value && this.host.draft(id)) input.value = this.host.draft(id);
    if (this.pickers?.sideId !== id) {
      this.pickers?.dispose();
      this.pickers = { sideId: id, dispose: this.host.mountPickers(input, side.session) };
    }
    this.paintThread(log, side.session, side.hiddenThrough);
    if (this.stick) log.scrollTop = log.scrollHeight;
  }

  private paintThread(log: HTMLElement, side: Session, hiddenThrough: number): void {
    const region = log.querySelector<HTMLElement>('.btw-stream-region')!;
    // Messages a worktree fork copied from the main thread stay hidden.
    const own = this.messages.filter(m => m.id < 0 || m.id > hiddenThrough);
    const visible = this.host.visible(side.id, own);
    const key = `${side.id}:${side.provider}:${this.tick}:` + visible.map(m => `${m.id}.${m.content.length}`).join(',');
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.host.renderRows(log, region, side, visible, own, () => { if (this.stick) log.scrollTop = log.scrollHeight; });
      // Each final answer can go into the main prompt.
      for (const actions of log.querySelectorAll<HTMLElement>('.message.agent-message[data-message-id] > .message-actions')) {
        const messageId = actions.parentElement!.dataset.messageId!;
        actions.insertAdjacentHTML('beforeend', `<button type="button" class="btw-insert" data-btw-insert="${escape(messageId)}" aria-label="Insert this answer into the main prompt" title="Insert into main prompt">${icon('forward')}</button>`);
      }
      if (!visible.length && !this.host.streaming(side.id)) region.insertAdjacentHTML('beforebegin', '<p class="inspector-hint">No messages yet.</p>');
    }
    if (this.host.streaming(side.id)) this.host.paintStream(region, side.id, log);
    // The live turn stays until the saved copy that replaces it has loaded.
    else if (!this.awaiting && region.firstChild) { region.replaceChildren(); delete region.dataset.sessionId; }
  }

  private paintComposer(root: HTMLElement, side: Session | undefined): void {
    const above = root.querySelector<HTMLElement>('.btw-above')!, toolbar = root.querySelector<HTMLElement>('.btw-toolbar')!;
    const aboveHtml = side ? this.host.aboveHtml(side) : '', toolsHtml = this.host.toolsHtml(side);
    // A control with its menu open is redrawn once the menu has closed.
    const held = (above.dataset.html !== aboveHtml && this.host.menuBusy(above)) || (toolbar.dataset.html !== toolsHtml && this.host.menuBusy(toolbar));
    if (held) { clearTimeout(this.retry); this.retry = window.setTimeout(() => this.refresh(), 150); }
    if (above.dataset.html !== aboveHtml && !this.host.menuBusy(above)) {
      const editing = above.querySelector('.queue-edit');
      above.innerHTML = aboveHtml; above.dataset.html = aboveHtml;
      // Edit on a queued message moves focus into the editor this redraw adds.
      if (!editing && this.editing) above.querySelector<HTMLTextAreaElement>('.queue-edit')?.focus();
      this.editing = false;
    }
    if (toolbar.dataset.html !== toolsHtml && !this.host.menuBusy(toolbar)) {
      // Keep keyboard focus on the same control when it is redrawn.
      const focused = toolbar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action ?? (document.activeElement as HTMLElement).dataset.btw : undefined;
      toolbar.innerHTML = toolsHtml; toolbar.dataset.html = toolsHtml;
      if (focused) toolbar.querySelector<HTMLElement>(`[data-action="${focused}"], [data-btw="${focused}"]`)?.focus({ preventScroll: true });
    }
    const input = root.querySelector<HTMLTextAreaElement>('.btw-input')!;
    const running = side ? this.host.running(side.id) : false;
    const placeholder = running ? 'Queue a follow-up · ⌘↩ steers now' : 'Ask on the side…';
    if (input.placeholder !== placeholder) {
      input.placeholder = placeholder;
      input.setAttribute('aria-description', running ? 'Enter to queue for when the side agent finishes. Command Enter to steer its running turn.' : 'Enter to send. Shift Enter for a new line. Type / for commands or @ to mention a project file.');
    }
  }
}
