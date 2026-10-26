import './chat-usage.css';
import { call } from './bridge';
import type { AgentUsage } from './agent-usage';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import type { Provider, ProviderId } from './types';

type Entry = { provider: Provider; value?: AgentUsage; loading: boolean; requested: boolean };
let nextTooltipId = 0;

/** Small composer view. Provider snapshots and request state belong to this instance so
 * mounting another conversation cannot dispose or overwrite its cache. */
export function createChatUsage(): { update(host: HTMLElement | null, providers: Provider[]): void; invalidate(): void; dismiss(): void; dispose(): void } {
  const entries = new Map<ProviderId, Entry>();
  let mounted: HTMLElement | null = null;
  let observed: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let generation = 0, providerKey = '', renderKey = '';
  let expanded = false, collapsed = false, refreshing = false, disposed = false, ignoreNextFocusExpansion = false;
  let activeRequests = 0;
  const requestWaiters: { generation: number; resolve: (acquired: boolean) => void }[] = [];
  const tooltipId = `chat-usage-tip-${++nextTooltipId}`;
  let tooltipFor: HTMLElement | null = null;
  let tooltipProviderId: string | null = null;

  function acquireRequest(mine: number): Promise<boolean> {
    if (mine !== generation || disposed) return Promise.resolve(false);
    if (activeRequests < 3) { activeRequests++; return Promise.resolve(true); }
    return new Promise(resolve => requestWaiters.push({ generation: mine, resolve }));
  }

  function releaseRequest(): void {
    activeRequests--;
    while (requestWaiters.length) {
      const waiter = requestWaiters.shift()!;
      if (waiter.generation !== generation || disposed) { waiter.resolve(false); continue; }
      activeRequests++;
      waiter.resolve(true);
      break;
    }
  }

  function relativeReset(value?: string | null): string {
    if (!value) return 'reset time not reported';
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return 'reset time not reported';
    const delta = time - Date.now();
    const local = new Date(time).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    if (delta <= 0) return `reset due - refresh to check (${local})`;
    const mins = Math.ceil(delta / 60_000);
    const rel = mins < 60 ? `in ${mins}m` : mins < 1440 ? `in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}` : `in ${Math.floor(mins / 1440)}d`;
    return `resets ${rel} (${local})`;
  }

  function peak(value?: AgentUsage): number | null {
    if (!value || value.status !== 'ready') return null;
    const usable = value.windows.map(window => window.usedPercent).filter((n): n is number => Number.isFinite(n));
    return usable.length ? Math.round(Math.min(100, Math.max(0, ...usable))) : null;
  }

  function details(entry: Entry): string {
    const value = entry.value;
    if (entry.loading) return `${entry.provider.name} - Default setup: checking account usage`;
    if (!value || value.status !== 'ready' || !value.windows.length) {
      const state = value?.message ? `: ${value.message}` : ': usage unavailable';
      return `${entry.provider.name} - Default setup${state}`;
    }
    const freshness = value.stale ? `\nLast successful read: ${new Date(value.checkedAt).toLocaleString()}` : '';
    return `${entry.provider.name} - Default setup${freshness}\n${value.windows.map(window => `${window.label}: ${Number.isFinite(window.usedPercent) ? `${Math.round(Math.min(100, Math.max(0, window.usedPercent)))}% used` : 'usage unavailable'}; ${relativeReset(window.resetsAt)}`).join('\n')}`;
  }

  function bind(host: HTMLElement): void {
    if (mounted === host) return;
    unbind();
    mounted = host;
    window.addEventListener('resize', measure);
    host.addEventListener('click', onClick);
    host.addEventListener('pointerenter', onPointerEnter);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('pointerover', onPointerOver);
    host.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    const nextObserved = host.parentElement;
    if (nextObserved !== observed) {
      resizeObserver?.disconnect(); resizeObserver = null; observed = nextObserved;
      if (observed && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => measure());
        resizeObserver.observe(observed);
      }
    }
  }

  function unbind(): void {
    expanded = false;
    hideTip();
    mounted?.removeEventListener('click', onClick);
    mounted?.removeEventListener('pointerenter', onPointerEnter);
    mounted?.removeEventListener('pointerleave', onPointerLeave);
    mounted?.removeEventListener('focusin', onFocusIn);
    mounted?.removeEventListener('focusout', onFocusOut);
    mounted?.removeEventListener('keydown', onKeyDown);
    mounted?.removeEventListener('pointerover', onPointerOver);
    mounted?.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    window.removeEventListener('resize', measure);
    resizeObserver?.disconnect(); resizeObserver = null; observed = null;
    mounted = null;
  }

  function onClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const refresh = target?.closest<HTMLButtonElement>('.chat-usage-refresh');
    if (refresh) { refresh.focus({ preventScroll: true }); void load(true); return; }
    const stackIcon = target?.closest<HTMLElement>('.chat-usage-icon');
    if (stackIcon) {
      expanded = true; syncExpanded();
      const id = stackIcon.dataset.usageProvider;
      const detailButton = mounted?.querySelector<HTMLElement>(`.chat-usage-full [data-usage-provider="${CSS.escape(id ?? '')}"]`);
      if (detailButton) showTip(detailButton);
      return;
    }
    const provider = target?.closest<HTMLElement>('.chat-usage-provider');
    if (provider) tooltipFor === provider ? hideTip() : showTip(provider);
  }

  function onPointerOver(event: PointerEvent): void {
    const provider = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-usage-provider]') : null;
    if (provider) showTip(provider); else hideTip();
  }
  function onScroll(): void { if (tooltipFor?.isConnected) placeTip(tooltipFor); }
  function showTip(button: HTMLElement): void {
    const tip = mounted?.querySelector<HTMLElement>('.chat-usage-tip-panel');
    if (!tip) return;
    tooltipFor = button;
    tooltipProviderId = button.dataset.usageProvider ?? null;
    tip.textContent = button.dataset.usageTip ?? '';
    tip.hidden = !tip.textContent;
    tip.classList.toggle('is-visible', !tip.hidden);
    placeTip(button);
  }
  function hideTip(): void {
    tooltipFor = null;
    tooltipProviderId = null;
    const tip = mounted?.querySelector<HTMLElement>('.chat-usage-tip-panel');
    if (tip) { tip.hidden = true; tip.classList.remove('is-visible'); }
  }
  function placeTip(button: HTMLElement): void {
    const host = mounted, tip = host?.querySelector<HTMLElement>('.chat-usage-tip-panel');
    if (!host || !tip || !button.isConnected || tip.hidden) return;
    const anchor = button.getBoundingClientRect(), hostRect = host.getBoundingClientRect();
    const width = tip.offsetWidth, height = tip.offsetHeight, gap = 8, margin = 12;
    const left = Math.max(margin, Math.min(anchor.left, innerWidth - width - margin));
    const above = anchor.top - height - gap >= margin;
    const top = above ? anchor.top - height - gap : Math.min(innerHeight - height - margin, anchor.bottom + gap);
    tip.style.left = `${Math.round(left - hostRect.left)}px`;
    tip.style.top = `${Math.round(top - hostRect.top)}px`;
  }

  function onPointerEnter(): void { expanded = true; syncExpanded(); }
  function onPointerLeave(): void {
    hideTip();
    if (!mounted?.contains(document.activeElement)) { expanded = false; syncExpanded(); }
  }
  function onFocusIn(event: FocusEvent): void {
    if (ignoreNextFocusExpansion) { ignoreNextFocusExpansion = false; return; }
    expanded = true; syncExpanded();
    const iconButton = event.target instanceof Element ? event.target.closest<HTMLElement>('.chat-usage-icon') : null;
    if (iconButton) {
      const id = iconButton.dataset.usageProvider;
      mounted?.querySelector<HTMLElement>(`.chat-usage-full [data-usage-provider="${CSS.escape(id ?? '')}"]`)?.focus({ preventScroll: true });
    }
    const providerButton = event.target instanceof Element ? event.target.closest<HTMLElement>('.chat-usage-provider') : null;
    if (providerButton) showTip(providerButton);
  }
  function onFocusOut(): void {
    queueMicrotask(() => {
      if (!mounted?.contains(document.activeElement) && !mounted?.matches(':hover')) { expanded = false; syncExpanded(); }
      if (!mounted?.contains(document.activeElement) && !mounted?.matches(':hover')) hideTip();
    });
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !mounted?.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    dismissFromEscape(event.target);
  }

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !expanded) return;
    // Pointer hover must not take Escape away from the composer or another overlay.
    if (event.target instanceof Node && mounted?.contains(event.target)) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    }
    dismissFromEscape(event.target);
  }

  function dismissFromEscape(target: EventTarget | null): void {
    const current = target instanceof Element ? target.closest<HTMLElement>('[data-usage-provider]') : null;
    const id = current?.dataset.usageProvider;
    expanded = false; syncExpanded();
    if (id && collapsed) {
      const anchor = mounted?.querySelector<HTMLElement>(`.chat-usage-stack [data-usage-provider="${CSS.escape(id)}"]`) ?? mounted?.querySelector<HTMLElement>('.chat-usage-icon');
      if (anchor) {
        ignoreNextFocusExpansion = true;
        anchor.focus({ preventScroll: true });
      }
    } else current?.classList.remove('tip-open');
    hideTip();
  }

  function syncExpanded(): void {
    mounted?.querySelector('.chat-usage-strip')?.classList.toggle('is-expanded', expanded);
  }

  function measure(): void {
    const host = mounted, strip = host?.querySelector<HTMLElement>('.chat-usage-strip');
    if (!host || !strip || !host.isConnected) return;
    const previous = { position: strip.style.position, width: strip.style.width, maxWidth: strip.style.maxWidth, visibility: strip.style.visibility };
    strip.classList.remove('is-collapsed', 'is-expanded');
    strip.style.position = 'absolute'; strip.style.width = 'max-content'; strip.style.maxWidth = 'none'; strip.style.visibility = 'hidden';
    const fullWidth = strip.scrollWidth;
    strip.classList.add('is-collapsed');
    const collapsedWidth = strip.scrollWidth;
    strip.style.position = previous.position; strip.style.width = previous.width; strip.style.maxWidth = previous.maxWidth; strip.style.visibility = previous.visibility;
    const rowWidth = host.parentElement?.clientWidth ?? host.clientWidth;
    host.style.setProperty('--chat-usage-row-width', `${Math.max(0, rowWidth - 12)}px`);
    const nextCollapsed = fullWidth > rowWidth / 2;
    if (collapsed !== nextCollapsed) collapsed = nextCollapsed;
    strip.classList.toggle('is-collapsed', collapsed);
    strip.classList.toggle('is-expanded', expanded);
    if (collapsed && host.contains(document.activeElement) && document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('chat-usage-provider')) {
      expanded = true; strip.classList.add('is-expanded');
    }
    const slotWidth = collapsed ? collapsedWidth : fullWidth;
    host.style.width = `${Math.ceil(slotWidth)}px`;
    if (tooltipFor?.isConnected) placeTip(tooltipFor);
  }

  function render(): void {
    const host = mounted;
    if (!host?.isConnected) return;
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
      ? document.activeElement.dataset.usageProvider ?? (document.activeElement.classList.contains('chat-usage-refresh') ? 'refresh' : '') : '';
    if (tooltipFor?.dataset.usageProvider) tooltipProviderId = tooltipFor.dataset.usageProvider;
    const values = [...entries.values()].filter(entry => peak(entry.value) !== null);
    if (!values.length) {
      host.replaceChildren(); host.style.width = '0'; hideTip();
      if (active) {
        const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
        const fallback = prompt && !prompt.disabled ? prompt
          : host.parentElement?.querySelector<HTMLElement>('button:not(:disabled), a, input:not(:disabled), textarea:not(:disabled), [tabindex]:not([aria-disabled="true"])')
          ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        fallback?.focus({ preventScroll: true });
      }
      return;
    }
    const icons = values.slice(0, 4).map((entry, index) => {
      const used = peak(entry.value);
      return `<button type="button" class="chat-usage-icon" data-usage-provider="${entry.provider.id}" data-usage-tip="${escape(details(entry))}" aria-label="${escape(entry.provider.name)} usage: ${used === null ? 'unavailable' : `${used}% used`}" aria-describedby="${tooltipId}" style="--usage-stack:${index}">${providerLogo(entry.provider.id)}</button>`;
    }).join('');
    const providers = values.map(entry => {
      const used = peak(entry.value);
      return `<button type="button" class="chat-usage-provider" data-usage-provider="${entry.provider.id}" data-usage-tip="${escape(details(entry))}" aria-label="${escape(entry.provider.name)} usage: ${used === null ? 'unavailable' : `${used}% used`}" aria-describedby="${tooltipId}">${providerLogo(entry.provider.id)}<span>${used === null ? '&#8212;' : `${used}%`}</span></button>`;
    }).join('');
    host.innerHTML = `<div class="chat-usage-strip${collapsed ? ' is-collapsed' : ''}${expanded ? ' is-expanded' : ''}"><span class="chat-usage-used">Used</span><div class="chat-usage-stack">${icons}${values.length > 4 ? `<span class="chat-usage-more">+${values.length - 4}</span>` : ''}</div><div class="chat-usage-scroll"><div class="chat-usage-full">${providers}</div></div><button type="button" class="chat-usage-refresh icon-button" aria-label="Refresh account usage" title="Refresh account usage"${refreshing || [...entries.values()].some(entry => entry.loading) ? ' disabled' : ''}>${icon('refresh')}</button></div><span class="chat-usage-tip-panel" id="${tooltipId}" role="tooltip" hidden></span>`;
    measure();
    if (active === 'refresh') {
      const refresh = host.querySelector<HTMLButtonElement>('.chat-usage-refresh');
      const group = collapsed && !expanded ? '.chat-usage-stack' : '.chat-usage-full';
      if (refresh && !refresh.disabled) refresh.focus({ preventScroll: true });
      else host.querySelector<HTMLElement>(`${group} [data-usage-provider]`)?.focus({ preventScroll: true });
    }
    else if (active) {
      const group = collapsed && !expanded ? '.chat-usage-stack' : '.chat-usage-full';
      const replacement = host.querySelector<HTMLElement>(`${group} [data-usage-provider="${CSS.escape(active)}"]`)
        ?? host.querySelector<HTMLElement>(`${group} [data-usage-provider]`)
        ?? host.querySelector<HTMLElement>('.chat-usage-refresh');
      replacement?.focus({ preventScroll: true });
    }
    if (tooltipProviderId) {
      const group = collapsed && !expanded ? '.chat-usage-stack' : '.chat-usage-full';
      const replacement = host.querySelector<HTMLElement>(`${group} [data-usage-provider="${CSS.escape(tooltipProviderId)}"]`);
      if (replacement) showTip(replacement);
      else hideTip();
    }
  }

  async function load(refresh: boolean): Promise<void> {
    if (disposed || (refresh && (refreshing || [...entries.values()].some(entry => entry.loading)))) return;
    const mine = generation;
    if (refresh) refreshing = true;
    const work = [...entries.values()].filter(entry => refresh || !entry.requested);
    if (!work.length) { refreshing = false; return; }
    work.forEach(entry => { entry.loading = true; entry.requested = true; });
    render();
    let next = 0;
    const worker = async () => {
      while (mine === generation && !disposed) {
        const entry = work[next++];
        if (!entry) return;
        if (!await acquireRequest(mine)) return;
        try {
          const result = await call<AgentUsage>('agent_usage', { provider: entry.provider.id, refresh });
          if (mine === generation && entries.get(entry.provider.id) === entry && result?.provider === entry.provider.id && Array.isArray(result.windows)) entry.value = result;
          else if (mine === generation && entries.get(entry.provider.id) === entry) entry.value = undefined;
        } catch {
          if (mine === generation && entries.get(entry.provider.id) === entry) entry.value = undefined;
        } finally {
          releaseRequest();
          if (mine === generation && entries.get(entry.provider.id) === entry) {
            entry.loading = false;
            render();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, work.length) }, worker));
    if (mine === generation) { refreshing = false; render(); }
  }

  return {
    update(host, providers) {
      if (disposed) return;
      const installed = providers.filter(provider => provider.installed);
      const key = installed.map(provider => provider.id).join('|');
      const nextRenderKey = installed.map(provider => `${provider.id}:${provider.name}`).join('|');
      if (host && mounted === host && key === providerKey && nextRenderKey === renderKey) return;
      if (key !== providerKey) {
        providerKey = key; generation++; entries.clear(); expanded = false; collapsed = false; refreshing = false;
        installed.forEach(provider => entries.set(provider.id, { provider, loading: false, requested: false }));
      } else {
        installed.forEach(provider => { const old = entries.get(provider.id); if (old) old.provider = provider; });
      }
      renderKey = nextRenderKey;
      if (host) bind(host);
      else unbind();
      render();
      if (host) void load(false);
    },
    invalidate() {
      if (disposed) return;
      generation++; refreshing = false; expanded = false; collapsed = false; renderKey = '';
      hideTip();
      for (const entry of entries.values()) { entry.value = undefined; entry.loading = false; entry.requested = false; }
      render();
    },
    dismiss() { expanded = false; syncExpanded(); hideTip(); },
    dispose() {
      disposed = true; generation++; unbind(); entries.clear();
    },
  };
}
