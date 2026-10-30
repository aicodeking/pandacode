import './agent-updates.css';
import { call, subscribe } from './bridge';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { hidePopover, showPopover } from './popover-motion';
import { infoMark } from './tooltip';
import type { Provider, ProviderId } from './types';

export interface AgentUpdate {
  provider: ProviderId;
  name: string;
  providers: ProviderId[];
  installedVersion: string | null;
  latestVersion: string | null;
  status: 'available' | 'current' | 'unsupported' | 'error';
  method: string | null;
  canUpdate: boolean;
  message: string | null;
  checkedAt: number;
  docsUrl?: string | null;
}
export interface AgentUpdateProgress { provider: ProviderId; phase: 'updating' | 'verifying' | 'completed' | 'error'; message?: string | null; }
export interface AgentUpdatesHost {
  modal(title: string, body: string, className?: string): HTMLDialogElement;
  closeModal(): void;
  providersChanged(): Promise<void>;
  providers(): Provider[];
  report(error: unknown): void;
}
export interface AgentUpdatesController { show(): Promise<void>; dispose(): void; }

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const DISMISS_KEY = 'pandacode.agent-updates.dismissed';
const errorText = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not complete the request. Try again.';

/** Checks are automatic; installers run only after an explicit Update click. */
export function initializeAgentUpdates(host: AgentUpdatesHost): AgentUpdatesController {
  let disposed = false, lastCheck = 0, checking: Promise<void> | undefined, checkError = '';
  let updates: AgentUpdate[] = [], popup: HTMLElement | undefined, dialogBody: HTMLElement | undefined;
  let allowPopup = false, manualRevision = 0, popupFocus: HTMLElement | undefined;
  let timer = 0, unlisten: (() => void) | undefined;
  const initialCheckAt = Date.now() + 8000;
  const pending = new Map<ProviderId, AgentUpdateProgress>();
  const failures = new Map<ProviderId, string>();
  const popupIds = new Set<ProviderId>();
  let dismissed: Partial<Record<ProviderId, string>> = {};
  try {
    const saved = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      // Initialization can precede provider discovery. Load saved choices without
      // depending on the catalog having arrived yet.
      dismissed = Object.fromEntries(Object.entries(saved).slice(0, 16).filter(([, value]) => typeof value === 'string' && value.length <= 256));
    }
  } catch { /* Dismissal still lasts for this window if local storage is unavailable. */ }

  const installed = (entry: AgentUpdate) => host.providers().some(provider => provider.installed && (provider.id === entry.provider || entry.providers.includes(provider.id)));
  const visibleEntries = () => updates.filter(installed);
  const candidates = () => visibleEntries().filter(entry => entry.status === 'available' && entry.latestVersion && dismissed[entry.provider] !== entry.latestVersion);
  const dialogLive = () => dialogBody?.isConnected && Boolean(dialogBody.closest('dialog[open]'));

  function hidePopup(restoreFocus = false): void {
    if (!popup) return;
    const hadFocus = popup.contains(document.activeElement);
    hidePopover(popup); popup = undefined; popupIds.clear();
    if (restoreFocus && hadFocus && popupFocus?.isConnected) popupFocus.focus({ preventScroll: true });
    popupFocus = undefined;
  }
  function later(): void {
    for (const entry of updates) if (popupIds.has(entry.provider) && entry.latestVersion) dismissed[entry.provider] = entry.latestVersion;
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch { /* Keep the in-memory choice. */ }
    allowPopup = false; hidePopup(true);
  }
  function blockedPopup(): boolean {
    return document.hidden || Boolean(document.querySelector('dialog[open], .floating-menu:not(.agent-updates-popup):not([aria-hidden="true"])'));
  }
  function syncPopup(): void {
    if (disposed) return;
    if (!allowPopup || blockedPopup()) { hidePopup(); return; }
    if (!popup && !candidates().length) return;
    if (!popup) {
      popup = document.createElement('section');
      popup.className = 'agent-updates-popup floating-menu';
      popup.dataset.browserOverlay = 'true'; popup.dataset.placement = 'above';
      popup.setAttribute('role', 'region'); popup.setAttribute('aria-label', 'Agent updates');
      popup.innerHTML = `<header><strong>Agent updates</strong><button type="button" class="agent-update-later">Later</button></header><ul class="agent-updates-list"></ul><button type="button" class="agent-updates-details">View all agents ${icon('forward')}</button>`;
      popupFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      popup.addEventListener('click', onClick);
      popup.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); later(); } });
      for (const entry of candidates()) popupIds.add(entry.provider);
      document.body.append(popup);
      renderRows(popup.querySelector('ul')!, visibleEntries().filter(entry => popupIds.has(entry.provider)));
      showPopover(popup, popup);
    } else {
      for (const entry of candidates()) popupIds.add(entry.provider);
      renderRows(popup.querySelector('ul')!, visibleEntries().filter(entry => popupIds.has(entry.provider)));
    }
  }

  function renderRows(list: HTMLElement, entries: AgentUpdate[]): void {
    const rows = new Map([...list.querySelectorAll<HTMLElement>('.agent-update-row')].map(row => [row.dataset.provider, row]));
    list.querySelector('.agent-updates-empty')?.remove();
    for (const [index, entry] of entries.entries()) {
      let row = rows.get(entry.provider);
      if (!row) {
        row = document.createElement('li'); row.className = 'agent-update-row'; row.dataset.provider = entry.provider;
        row.innerHTML = `<div class="agent-update-main">${providerLogo(entry.provider)}<div class="agent-update-copy"><strong></strong><span class="agent-update-version"></span><span class="agent-update-details"></span></div><span class="agent-update-state"></span><button type="button" class="secondary-button agent-update-button"></button><button type="button" class="agent-update-guide" data-action="open-url">Guide ${icon('forward')}</button></div><p class="agent-update-message" hidden></p>`;
      }
      const progress = pending.get(entry.provider), failure = failures.get(entry.provider);
      row.querySelector('strong')!.textContent = entry.name;
      const version = entry.status === 'available' && entry.latestVersion ? `${entry.installedVersion || 'Unknown'} → ${entry.latestVersion}` : entry.installedVersion || 'Version not reported';
      const versionNode = row.querySelector<HTMLElement>('.agent-update-version')!;
      versionNode.textContent = version; versionNode.title = version;
      const aliases = entry.providers.filter(provider => provider !== entry.provider).map(id => host.providers().find(provider => provider.id === id)?.name ?? id);
      const detail = [entry.message, entry.method ? `Install method: ${entry.method}.` : '', aliases.length ? `Also used by ${aliases.join(', ')}.` : ''].filter(Boolean).join(' ');
      const detailNode = row.querySelector<HTMLElement>('.agent-update-details')!;
      if (detailNode.dataset.text !== detail) { detailNode.dataset.text = detail; detailNode.innerHTML = detail ? `${infoMark(detail, `${entry.name} update details`)}<span class="sr-only">${escape(detail)}</span>` : ''; }
      const button = row.querySelector<HTMLButtonElement>('.agent-update-button')!;
      const canUpdate = entry.status === 'available' && entry.canUpdate;
      button.hidden = !canUpdate && !progress; button.disabled = Boolean(pending.size || checking);
      button.setAttribute('aria-label', `Update ${entry.name}`); button.setAttribute('aria-busy', String(Boolean(progress)));
      button.textContent = progress ? progress.phase === 'verifying' ? 'Verifying…' : 'Updating…' : 'Update';
      const state = row.querySelector<HTMLElement>('.agent-update-state')!;
      state.hidden = Boolean(canUpdate || progress);
      state.textContent = entry.method === 'ChatGPT' ? 'Managed by ChatGPT' : entry.status === 'current' ? 'Up to date' : entry.status === 'error' ? 'Unavailable' : 'Manual update';
      const guide = row.querySelector<HTMLButtonElement>('.agent-update-guide')!;
      const docs = docsUrl(entry.docsUrl);
      guide.hidden = !docs || canUpdate || Boolean(progress); guide.dataset.url = docs || '';
      guide.setAttribute('aria-label', `${entry.name} update guide`);
      const message = row.querySelector<HTMLElement>('.agent-update-message')!;
      const text = failure || progress?.message || (entry.status === 'error' ? entry.message || 'Could not check this agent.' : entry.status === 'unsupported' || entry.status === 'available' && !entry.canUpdate ? entry.message || 'Use this agent’s package manager to update it.' : '');
      message.textContent = text; message.hidden = !text;
      message.classList.toggle('is-error', Boolean(failure || entry.status === 'error' || progress?.phase === 'error'));
      message.setAttribute('role', failure || entry.status === 'error' ? 'alert' : 'status');
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      rows.delete(entry.provider);
    }
    rows.forEach(row => row.remove());
    if (!entries.length) list.innerHTML = `<li class="agent-updates-empty">${checking ? 'Checking installed agents…' : checkError ? 'Agent updates could not be checked.' : 'No installed agents found.'}</li>`;
  }
  function render(): void {
    if (disposed) return;
    if (dialogLive()) {
      renderRows(dialogBody!.querySelector('ul')!, visibleEntries());
      const check = dialogBody!.querySelector<HTMLButtonElement>('.agent-updates-check')!;
      check.disabled = Boolean(checking || pending.size); check.setAttribute('aria-busy', String(Boolean(checking)));
      const status = dialogBody!.querySelector<HTMLElement>('.agent-updates-status')!;
      status.textContent = checkError || (checking ? 'Checking installed agents…' : 'Checks run every 6 hours. Updates start only when you choose Update.');
      status.classList.toggle('is-error', Boolean(checkError)); status.setAttribute('role', checkError ? 'alert' : 'status');
    }
    syncPopup();
  }
  function schedule(): void {
    clearTimeout(timer);
    timer = window.setTimeout(backgroundCheck, Math.max(0, (lastCheck ? lastCheck + CHECK_INTERVAL : initialCheckAt) - Date.now()));
  }
  function backgroundCheck(): void {
    if (disposed || document.hidden) return;
    const next = lastCheck ? lastCheck + CHECK_INTERVAL : initialCheckAt;
    if (Date.now() < next) { schedule(); syncPopup(); return; }
    if (pending.size) return;
    void check(false, true);
  }
  function check(force: boolean, automatic = false): Promise<void> {
    if (disposed || pending.size) return Promise.resolve();
    if (checking) return checking;
    lastCheck = Date.now(); checkError = '';
    const presentation = manualRevision;
    checking = (async () => {
      try {
        const result = await call<AgentUpdate[]>('check_agent_updates', { force });
        if (disposed) return;
        updates = result; failures.clear();
        if (automatic && presentation === manualRevision) allowPopup = true;
      } catch (error) { if (!disposed) checkError = errorText(error); }
      finally { checking = undefined; if (!disposed) { render(); schedule(); } }
    })();
    render();
    return checking;
  }
  async function update(provider: ProviderId): Promise<void> {
    const entry = updates.find(entry => entry.provider === provider);
    if (disposed || checking || pending.size || !entry || !installed(entry) || entry.status !== 'available' || !entry.canUpdate) return;
    pending.set(provider, { provider, phase: 'updating', message: 'Starting update…' }); failures.delete(provider); render();
    try {
      const result = await call<AgentUpdate>('update_agent', { provider });
      if (disposed) return;
      updates = updates.map(entry => entry.provider === provider ? result : entry);
      // Refreshing selectors is separate from the installer result. A discovery
      // failure must never present a successful installation as safe to retry.
      try { await host.providersChanged(); } catch (error) { if (!disposed) host.report(error); }
    } catch (error) { if (!disposed) failures.set(provider, errorText(error)); }
    finally { pending.delete(provider); if (!disposed) { render(); schedule(); } }
  }
  function onClick(event: MouseEvent): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled) return;
    if (button.matches('.agent-update-button')) { const id = button.closest<HTMLElement>('[data-provider]')?.dataset.provider as ProviderId; void update(id); }
    else if (button.matches('.agent-update-later')) later();
    else if (button.matches('.agent-updates-details')) void show();
    else if (button.matches('.agent-updates-check')) void check(true);
    else if (button.matches('.agent-updates-close')) host.closeModal();
  }
  async function show(): Promise<void> {
    if (disposed) return;
    manualRevision++; allowPopup = false; hidePopup();
    const dialog = host.modal('Agent updates', `<section class="agent-updates"><div class="agent-updates-toolbar"><span>Installed agents</span><button type="button" class="secondary-button agent-updates-check">${icon('refresh')}Check updates</button></div><ul class="agent-updates-list"></ul><p class="agent-updates-status" role="status"></p><div class="dialog-footer"><button type="button" class="secondary-button agent-updates-close">Done</button></div></section>`, 'agent-updates-dialog');
    dialogBody = dialog.querySelector<HTMLElement>('.agent-updates')!;
    dialogBody.addEventListener('click', onClick); render();
    dialogBody.querySelector<HTMLButtonElement>('.agent-updates-check')!.focus({ preventScroll: true });
    await check(true);
  }
  const overlayObserver = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' ? record.target instanceof Element && record.target.matches('dialog,.floating-menu') : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && node.matches('dialog,.floating-menu')))) syncPopup();
  });
  overlayObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-hidden'] });
  const visibility = () => { if (document.hidden) hidePopup(); else { backgroundCheck(); syncPopup(); } };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', backgroundCheck);
  void subscribe('agent-update-progress', value => {
    if (disposed || !pending.has(value.provider)) return;
    pending.set(value.provider, value); render();
  }).then(off => { if (disposed) off(); else unlisten = off; }).catch(() => { /* The IPC result still reports success or failure. */ });
  schedule();
  return { show, dispose() {
    disposed = true; clearTimeout(timer); unlisten?.(); overlayObserver.disconnect();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', backgroundCheck);
    hidePopup(); dialogBody?.removeEventListener('click', onClick); dialogBody = undefined;
  } };
}

function docsUrl(value?: string | null): string | undefined {
  try { const url = new URL(value || ''); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* Do not render invalid guidance links. */ }
}
