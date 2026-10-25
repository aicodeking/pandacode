import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { showPopover, hidePopover } from './popover-motion';
import type { TerminalActivity, TerminalContext, TerminalController } from './terminal';
import './terminal-panel.css';

type Tab = { id: string; title: string; context: TerminalContext; label: string; host: HTMLElement; ready: Promise<void>; controller?: TerminalController; removed: boolean };
type Group = { tabs: Tab[]; active?: string; open: boolean; sequence: number };

/** PTYs belong to tasks, not to the currently visible drawer. Hidden tabs keep output. */
export class TerminalPanel {
  private groups = new Map<string, Group>();
  private key = '';
  private context?: TerminalContext;
  private label = '';
  private epoch = 0;
  private closing = new Set<string>();
  private dismiss?: () => void;
  private tabs: HTMLElement;
  private tabsMarkup = '';
  constructor(private drawer: HTMLElement, private host: HTMLElement, private report: (error: unknown) => void) {
    this.tabs = drawer.querySelector<HTMLElement>('[role="tablist"]')!;
    drawer.addEventListener('click', event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-terminal-action]');
      if (!target) return;
      const action = target.dataset.terminalAction;
      if (action === 'minimize') this.minimize();
      else if (action === 'new') void this.add().catch(report);
      else if (action === 'select') {
        const group = this.group(); if (!group) return;
        this.cancelClose(); group.active = target.dataset.tab; this.paint(); this.focus();
      } else if (action === 'close') void this.requestClose(target, target.dataset.tab).catch(report);
    });
    this.tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target as Element).matches('[role="tab"]')) return;
      const group = this.group(); if (!group?.tabs.length) return;
      const index = group.tabs.findIndex(tab => tab.id === group.active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + group.tabs.length) % group.tabs.length;
      event.preventDefault(); this.cancelClose(); group.active = group.tabs[next].id; this.paint();
      this.tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  }
  get open(): boolean { return Boolean(this.group()?.open && this.group()?.tabs.length); }
  private group(): Group | undefined { return this.groups.get(this.key); }
  private active(): Tab | undefined { const group = this.group(); return group?.tabs.find(tab => tab.id === group.active); }
  select(context: TerminalContext | undefined, label: string): void {
    const key = context ? context.sessionId ?? `project:${context.projectId}` : '';
    this.context = context; this.label = label;
    if (key === this.key) return;
    this.cancelClose(); this.key = key; this.paint();
  }
  async toggle(): Promise<void> {
    if (this.open) { this.minimize(); return; }
    const group = this.group();
    if (group?.tabs.length) { group.open = true; this.paint(); this.focus(); }
    else await this.add();
  }
  minimize(): void {
    this.cancelClose(); const group = this.group(); if (group) group.open = false;
    this.paint(); document.querySelector<HTMLElement>('#terminal-toggle')?.focus({ preventScroll: true });
  }
  async runScript(requestId?: string): Promise<() => boolean> {
    const groupKey = this.key;
    await this.add(undefined, true, requestId);
    const tab = this.groups.get(groupKey)?.tabs.find(tab => tab.context.runScript);
    if (!tab?.controller) throw new Error(t('Run terminal could not be started.'));
    return () => tab.removed || Boolean(tab.controller?.exited);
  }
  async add(harness?: TerminalContext['harness'], runScript = false, requestId?: string): Promise<void> {
    if (!this.context) throw new Error(t('Open a project before starting a terminal.'));
    this.cancelClose();
    const key = this.key;
    let group = this.group();
    if (!group) { group = { tabs: [], open: true, sequence: 0 }; this.groups.set(key, group); }
    // The native harness owns one session. Bring its existing console back instead
    // of spawning a competing CLI attached to the same conversation.
    const existing = runScript ? group.tabs.find(tab => tab.context.runScript) : harness && group.tabs.find(tab => tab.context.harness?.provider === harness.provider);
    if (existing) {
      group.active = existing.id; group.open = true; this.paint();
      await existing.ready;
      if (existing.removed || !existing.controller) return;
      if (existing.controller.exited) {
        if (this.key !== key || group.active !== existing.id || !group.open) return;
        const closing = this.remove(group, existing), epoch = this.epoch;
        await closing;
        if (this.key === key && this.group() === group && epoch === this.epoch) await this.add(harness, runScript, requestId);
        return;
      }
      existing.controller.offerCommand(harness?.command);
      if (this.key === key && group.active === existing.id && group.open) existing.controller.focus();
      return;
    }
    const host = document.createElement('div'); host.className = 'terminal-tab-surface';
    const id = `terminal-tab-${crypto.randomUUID()}`;
    host.id = id; host.setAttribute('role', 'tabpanel'); host.setAttribute('aria-labelledby', `${id}-label`);
    host.textContent = t('Starting terminal…'); this.host.append(host);
    const tab: Tab = { id, title: runScript ? t('Run') : harness ? t`${harness.provider} console` : t`Terminal ${++group.sequence}`, label: this.label,
      context: { ...this.context, ...(harness ? { harness } : {}), ...(runScript ? { runScript: true, runRequestId: requestId } : {}) }, host, removed: false, ready: Promise.resolve() };
    group.tabs.push(tab); group.active = id; group.open = true; this.paint();
    const owner = group;
    tab.ready = (async () => {
      try {
        const { mountTerminal } = await import('./terminal');
        if (tab.removed) return;
        host.replaceChildren();
        const controller = await mountTerminal(host, tab.context, this.report);
        if (tab.removed) { await controller.dispose(); return; }
        tab.controller = controller;
        if (this.key === key) { this.paint(); if (owner.active === id && owner.open) controller.focus(); }
      } catch (error) {
        if (tab.removed) return;
        await this.remove(owner, tab);
        if (runScript) throw error;
        // A delayed startup failure in another task must not replace this pane.
        if (this.key === key) this.report(error);
      }
    })();
    await tab.ready;
  }
  private focus(): void { this.active()?.controller?.focus(); }
  private cancelClose(): void { ++this.epoch; this.dismiss?.(); this.dismiss = undefined; }
  async requestClose(anchor: HTMLElement, id = this.group()?.active): Promise<void> {
    const group = this.group(), tab = group?.tabs.find(tab => tab.id === id), key = this.key;
    if (!group || !tab || this.closing.has(tab.id)) return;
    this.cancelClose(); const epoch = this.epoch; this.closing.add(tab.id); anchor.setAttribute('aria-busy', 'true');
    try {
      await tab.ready;
      if (tab.removed) return;
      const activity = await tab.controller?.activity().catch((): TerminalActivity => ({ running: false, processNames: [], uncertain: true }));
      if (epoch !== this.epoch || key !== this.key || tab.removed || !this.open) return;
      if (!activity || !activity.running && !activity.uncertain) { await this.remove(group, tab); return; }
      const trigger = anchor.isConnected ? anchor : this.tabs.querySelector<HTMLElement>(`[data-terminal-action="close"][data-tab="${CSS.escape(tab.id)}"]`);
      if (!trigger) return;
      this.dismiss = closePopover(trigger, activity, choice => {
        this.dismiss = undefined;
        if (epoch !== this.epoch || key !== this.key || tab.removed) return;
        if (choice === 'minimize') this.minimize();
        else if (choice === 'close') void this.remove(group, tab).catch(this.report);
      });
    } finally { this.closing.delete(tab.id); anchor.removeAttribute('aria-busy'); }
  }
  private async remove(group: Group, tab: Tab): Promise<void> {
    if (tab.removed) return;
    tab.removed = true;
    const index = group.tabs.indexOf(tab); group.tabs = group.tabs.filter(item => item !== tab);
    if (group.active === tab.id) group.active = group.tabs[Math.min(index, group.tabs.length - 1)]?.id;
    if (!group.tabs.length) group.open = false;
    tab.host.remove(); this.paint();
    await tab.controller?.dispose();
  }
  forget(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const group = this.groups.get(id); if (!group) continue;
      for (const tab of [...group.tabs]) void this.remove(group, tab).catch(this.report);
      this.groups.delete(id);
    }
    this.paint();
  }
  private paint(): void {
    const group = this.group(), active = this.active();
    this.drawer.hidden = !this.open;
    for (const owner of this.groups.values()) for (const tab of owner.tabs) tab.host.hidden = owner !== group || tab !== active;
    const label = this.drawer.querySelector<HTMLElement>('#terminal-project')!;
    label.textContent = active?.label ?? this.label;
    label.title = active?.host.dataset.terminalSettings ? t`Appearance from ${active.host.dataset.terminalSettings}` : '';
    const markup = (group?.tabs ?? []).map(tab => `<div class="terminal-tab${tab === active ? ' selected' : ''}"><button role="tab" id="${tab.id}-label" aria-controls="${tab.id}" aria-selected="${tab === active}" tabindex="${tab === active ? 0 : -1}" data-terminal-action="select" data-tab="${tab.id}">${escape(tab.title)}</button><button class="icon-button" aria-label="${t`Close ${escape(tab.title)}`}" data-terminal-action="close" data-tab="${tab.id}">${icon('close')}</button></div>`).join('');
    if (markup !== this.tabsMarkup) { this.cancelClose(); this.tabsMarkup = markup; this.tabs.innerHTML = markup; }
    const toggle = document.querySelector<HTMLElement>('#terminal-toggle');
    toggle?.setAttribute('aria-expanded', String(this.open)); toggle?.classList.toggle('active', this.open);
    toggle?.classList.toggle('has-terminals', Boolean(group?.tabs.length));
  }
}

function closePopover(anchor: HTMLElement, activity: TerminalActivity, choose: (choice: 'minimize' | 'close') => void): () => void {
  const panel = document.createElement('section'); panel.className = 'floating-menu terminal-close-popover';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t('Close terminal?')); panel.tabIndex = -1;
  const title = activity.uncertain ? t('Keep this terminal running?') : t('Processes are still running');
  panel.innerHTML = `<strong>${title}</strong><p>${t`Closing may stop ${activity.processNames.length ? escape(activity.processNames.slice(0, 3).join(', ')) : t('running processes')}. Minimize to keep them running.`}</p><div><button class="primary-button" data-choice="minimize">${t('Minimize instead')}</button><button class="secondary-button" data-choice="close">${t('Close terminal')}</button></div>`;
  let closed = false;
  const position = () => {
    if (!anchor.isConnected) { close(false); return; }
    const viewport = window.visualViewport, width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0, rect = anchor.getBoundingClientRect();
    panel.style.width = `${Math.min(340, width - 24)}px`;
    panel.style.maxHeight = `${height - 24}px`;
    panel.style.left = `${Math.max(left + 12, Math.min(rect.right - panel.offsetWidth, left + width - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(top + 12, Math.min(rect.top - panel.offsetHeight - 8, top + height - panel.offsetHeight - 12))}px`;
    panel.dataset.placement = 'above';
  };
  const close = (focus = true) => {
    if (closed) return; closed = true;
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', position); window.visualViewport?.removeEventListener('resize', position);
    anchor.setAttribute('aria-expanded', 'false'); hidePopover(panel);
    if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.contains(event.target) && !anchor.contains(event.target)) close(false); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab' && panel.contains(document.activeElement)) {
      const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
    }
  };
  panel.addEventListener('click', event => {
    const choice = (event.target as Element).closest<HTMLElement>('[data-choice]')?.dataset.choice;
    if (choice === 'minimize' || choice === 'close') { close(false); choose(choice); }
  });
  anchor.setAttribute('aria-expanded', 'true'); document.body.append(panel); position();
  if (closed) return () => {};
  showPopover(panel, anchor);
  panel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown, true);
  window.addEventListener('resize', position); window.visualViewport?.addEventListener('resize', position);
  return () => close(false);
}
