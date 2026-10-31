// The inspector's "By the way" tab: one side thread beside the main thread (docs/btw.md).
import { escape, icon, markdown } from './dom';
import { TITLE_PREFIX } from './btw';
import type { Message, MessagePage, Session } from './types';

export interface BtwLive { text: string; running: boolean; waiting: boolean }
export interface BtwPanelHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** The side thread shown for the current main thread, if any. */
  side(): { session: Session; hiddenThrough: number } | undefined;
  live(sideId: string): BtwLive;
  mainRunning(): boolean;
  userHtml(content: string): string;
  send(text: string): Promise<void>;
  openFull(sideId: string): void;
  newThread(): void;
  close(): void;
  insertMain(text: string): void;
  report(error: unknown): void;
}

/** The header, log and composer are built once; updates touch only what changed, so typing,
 *  the caret, IME composition and selections survive streaming. */
export class BtwPanel {
  private root?: HTMLElement;
  private messages: Message[] = [];
  private loadedFor = '';
  private draft = '';
  private frame = 0;
  private liveText = '';
  /** The finished reply, shown until the reload after `done` brings its saved copy. */
  private ending = '';
  constructor(private host: BtwPanelHost) {}

  show(target: HTMLElement): void {
    if (!this.root || this.root.parentElement !== target) target.replaceChildren(this.build());
    this.update();
  }
  /** Hidden: the next `show` reloads, so nothing stale comes back. */
  dispose(): void { this.root = undefined; this.loadedFor = ''; this.liveText = ''; this.ending = ''; cancelAnimationFrame(this.frame); this.frame = 0; }
  /** Called for every agent event; redraws once per frame while the tab shows this side thread. */
  event(sessionId: string, kind: string): void {
    if (!this.root?.isConnected || sessionId !== this.loadedFor) return;
    if (kind === 'done') { this.ending = this.liveText; void this.reload(); return; }
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }
  async reload(): Promise<void> {
    const sideId = this.loadedFor;
    if (!sideId) return;
    try {
      const page = await this.host.call<MessagePage>('get_messages', { sessionId: sideId });
      if (sideId !== this.loadedFor) return;
      // A sent message stays on screen until its saved copy arrives; once the run is over (or the
      // send failed) only saved messages remain.
      const running = this.host.live(sideId).running;
      const pending = running ? this.messages.filter(m => m.id < 0 && !page.messages.some(saved => saved.role === 'user' && saved.content === m.content)) : [];
      this.messages = [...page.messages, ...pending];
      // The saved answer replaces the run-end copy even if the session still reads as running.
      if (!running || (this.ending && page.messages.some(saved => saved.role === 'assistant' && saved.content.trim() === this.ending.trim()))) this.ending = '';
      this.update();
    } catch (error) { this.ending = ''; this.update(); this.host.report(error); }
  }
  focus(): void { this.root?.querySelector<HTMLTextAreaElement>('.btw-input')?.focus(); }
  /** Shows a sent message until the saved one arrives. */
  sent(sideId: string, text: string): void {
    if (sideId !== this.loadedFor) return;
    this.messages = [...this.messages, { id: -Date.now(), sessionId: sideId, role: 'user', content: text, createdAt: Date.now() }]; this.update();
  }

  private build(): HTMLElement {
    const root = this.root = document.createElement('div');
    root.className = 'btw-panel';
    root.innerHTML = `<header class="btw-head"><div><strong></strong><small role="status"></small></div><div class="btw-actions"><button class="icon-button" data-btw="new" aria-label="New side thread" title="New side thread">${icon('plus')}</button><button class="icon-button" data-btw="open" aria-label="Open side thread as a full thread" title="Open as full thread">${icon('external')}</button><button class="icon-button" data-btw="close" aria-label="Close side thread panel" title="Close">${icon('close')}</button></div></header><div class="inspector-empty btw-empty">${icon('chat')}<h3>No side thread yet</h3><p>Ask something on the side while this task keeps working. Type <code>/btw</code> and a question in the prompt, or write it here.</p></div><div class="btw-transcript" role="log" aria-label="Side thread conversation"></div><div class="btw-waiting" hidden>${icon('alert')}<span>Needs your input</span><button class="secondary-button" data-btw="open">Open thread</button></div><form class="btw-composer"><textarea class="btw-input" rows="2" aria-label="Message the side thread"></textarea><button class="btw-send" type="submit" aria-label="Send to side thread">${icon('arrow')}</button></form>`;
    const input = root.querySelector<HTMLTextAreaElement>('.btw-input')!;
    input.value = this.draft;
    input.addEventListener('input', () => { this.draft = input.value; });
    const submit = () => {
      const text = input.value.trim();
      if (!text || root.querySelector<HTMLButtonElement>('.btw-send')!.disabled) return;
      input.value = ''; this.draft = '';
      this.host.send(text).catch(error => {
        // Put the text back in whichever composer is showing now, unless something new was typed.
        const current = this.root?.querySelector<HTMLTextAreaElement>('.btw-input');
        if (!this.draft) this.draft = text;
        if (current && !current.value) current.value = this.draft;
        this.host.report(error);
      });
    };
    root.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submit(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
    // Esc leaves the panel for the main prompt; it never reaches the global stop-the-agent key.
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
    });
    // Header and Insert buttons act without taking focus or the text selection.
    root.addEventListener('mousedown', event => { if ((event.target as HTMLElement).closest('button:not(.btw-send)')) event.preventDefault(); });
    root.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      const side = this.host.side();
      if (button.dataset.btw === 'new') this.host.newThread();
      else if (button.dataset.btw === 'open' && side) this.host.openFull(side.session.id);
      else if (button.dataset.btw === 'close') this.host.close();
      else if (button.dataset.btwInsert) {
        const message = this.messages.find(m => String(m.id) === button.dataset.btwInsert);
        if (message) this.host.insertMain(message.content);
      }
    });
    return root;
  }

  private update(): void {
    const root = this.root;
    if (!root?.isConnected) return;
    const side = this.host.side();
    if (!side) { this.loadedFor = ''; this.messages = []; }
    else if (side.session.id !== this.loadedFor) { this.loadedFor = side.session.id; this.messages = []; this.liveText = ''; void this.reload(); }
    const live: BtwLive = side ? this.host.live(side.session.id) : { text: '', running: false, waiting: false };
    root.querySelector<HTMLElement>('.btw-head')!.hidden = !side;
    root.querySelector<HTMLElement>('.btw-empty')!.hidden = Boolean(side);
    const log = root.querySelector<HTMLElement>('.btw-transcript')!;
    log.hidden = !side;
    root.querySelector<HTMLElement>('.btw-waiting')!.hidden = !live.waiting;
    const send = root.querySelector<HTMLButtonElement>('.btw-send')!;
    send.disabled = live.running;
    root.querySelector<HTMLTextAreaElement>('.btw-input')!.placeholder = live.waiting ? 'Waiting for your input…' : live.running ? 'The side thread is answering…' : 'Ask on the side…';
    if (!side) return;
    const title = side.session.title.startsWith(TITLE_PREFIX) ? side.session.title.slice(TITLE_PREFIX.length) : side.session.title;
    const head = root.querySelector<HTMLElement>('.btw-head strong')!;
    if (head.textContent !== title) { head.textContent = title; head.title = title; }
    const state = live.waiting ? 'Needs your input' : live.running ? 'Working' : 'Ready', main = this.host.mainRunning();
    const status = state + (main ? ' · main running' : '');
    const small = root.querySelector<HTMLElement>('.btw-head small')!;
    if (small.textContent !== status) { small.textContent = status; small.title = state + (main ? ' · the main thread is still running' : ''); }
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    this.syncRows(log, side.hiddenThrough, live);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  /** Adds and removes rows by message id; only the live row redraws while the agent streams. */
  private syncRows(log: HTMLElement, hiddenThrough: number, live: BtwLive): void {
    const shown = this.messages.filter(m => (m.id < 0 || m.id > hiddenThrough) && (m.role === 'user' || m.role === 'assistant'));
    const keys = new Set(shown.map(m => String(m.id)));
    const liveText = live.running ? live.text : this.ending, showLive = live.running || Boolean(this.ending);
    if (showLive) keys.add('live');
    log.querySelectorAll<HTMLElement>(':scope > [data-key]').forEach(row => { if (!keys.has(row.dataset.key!)) row.remove(); });
    let previous: Element | null = null;
    for (const message of shown) {
      const key = String(message.id);
      let row = log.querySelector<HTMLElement>(`:scope > [data-key="${key}"]`);
      if (!row) {
        row = document.createElement('article'); row.dataset.key = key;
        if (message.role === 'user') { row.className = 'btw-message btw-user'; row.innerHTML = `<div class="message-content">${this.host.userHtml(message.content)}</div>`; }
        else {
          row.className = 'btw-message btw-agent';
          row.innerHTML = `<div class="markdown"></div><button class="btw-insert" data-btw-insert="${escape(key)}" aria-label="Insert this answer into the main prompt" title="Insert into main prompt">${icon('copy')}Insert into main</button>`;
          void markdown(row.querySelector<HTMLElement>('.markdown')!, message.content, log);
        }
      }
      if (row.parentElement !== log || row.previousElementSibling !== previous) (previous ? previous.after(row) : log.prepend(row));
      previous = row;
    }
    let liveRow = log.querySelector<HTMLElement>(':scope > [data-key="live"]');
    if (showLive) {
      if (!liveRow) {
        liveRow = document.createElement('article'); liveRow.dataset.key = 'live';
        liveRow.className = 'btw-message btw-agent btw-live'; liveRow.setAttribute('aria-busy', 'true');
        liveRow.innerHTML = '<div class="markdown"></div><p class="btw-working" role="status"><span class="support-spinner" aria-hidden="true"></span>Working…</p>';
        this.liveText = '';
      }
      if (liveRow.parentElement !== log || liveRow.previousElementSibling !== previous) (previous ? previous.after(liveRow) : log.prepend(liveRow));
      liveRow.querySelector<HTMLElement>('.btw-working')!.hidden = Boolean(liveText);
      if (liveText !== this.liveText) { this.liveText = liveText; void markdown(liveRow.querySelector<HTMLElement>('.markdown')!, liveText, log); }
    }
    let hint = log.querySelector<HTMLElement>(':scope > .inspector-hint');
    if (!shown.length && !showLive) {
      if (!hint) { hint = document.createElement('p'); hint.className = 'inspector-hint'; hint.textContent = 'No messages yet.'; log.append(hint); }
    } else hint?.remove();
  }
}
