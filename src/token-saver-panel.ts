import './token-saver.css';
import { escape, icon } from './dom';
import { hidePopover, showPopover } from './popover-motion';
import { tokenCount } from './model-catalog';
import { LEVELS, PACKS, contextFor, defaults, estimate, setDefaults, suggestion, threadSaver, updateThread, type PackId } from './token-saver';
import type { TaskTokenUsage } from './types';

/* The composer's Saver control and its panel: per-thread token-saving packs. */

type Tools = { rtk: boolean; rtkVersion: string; rtkInstall: string };
export type TokenSaverHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(text: string): void;
  /** The thread's saver changed; the composer redraws its button. */
  changed(sessionId: string): void;
  /** The thread's context reading, when it is the open thread; null otherwise. */
  contextUsage?(sessionId: string): { usedTokens: number; contextWindow?: number | null } | null;
};

/** Rough age for a measured-usage line: one precision step is enough. */
function ago(at: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** The measured totals for a window, as one quiet line. */
function measuredText(changedAt: number, usage: TaskTokenUsage): string {
  const parts = [`${tokenCount(usage.input)} in`, `${tokenCount(usage.output)} out`];
  const cached = usage.input + usage.cacheRead + usage.cacheWrite;
  if (cached > 0) parts.push(`${Math.round(usage.cacheRead / cached * 100)}% cache reads`);
  return `Since the packs changed ${ago(changedAt)}: ${parts.join(' · ')}`;
}

export function createTokenSaver(host: TokenSaverHost) {
  let tools: Tools = { rtk: false, rtkVersion: '', rtkInstall: 'brew install rtk' };
  let loading: Promise<void> | undefined;
  let panel: HTMLElement | undefined, panelSession = '', cleanup: (() => void) | undefined;
  let installing = false;
  /** Usage since the packs changed; undefined while loading, null when the harness keeps no logs. */
  let measured: TaskTokenUsage | null | undefined;
  let measuredToken = 0;

  const available = () => ({ rtk: tools.rtk });
  function loadTools(force = false): Promise<void> {
    if (!loading || force) loading = host.call<Tools>('token_saver_tools').then(value => { tools = value; }).catch(() => { /* Optional tools stay off. */ });
    return loading;
  }

  /** Measured usage since the configuration was sent; harnesses without local logs report nothing. */
  function loadMeasured(sessionId: string): void {
    const saver = threadSaver(sessionId);
    const active = saver.packs.filter(id => id !== 'rtk' || tools.rtk);
    // Only a configuration that has gone out has a meaningful window; a just-toggled one has not.
    if (!saver.changedAt || !active.length || saver.sentKey !== `${active.join(',')}:${saver.level}`) { measured = undefined; return; }
    measured = undefined;
    const token = ++measuredToken;
    void host.call<TaskTokenUsage | null>('task_token_usage', { sessionId, since: saver.changedAt }).then(value => {
      if (token !== measuredToken || panelSession !== sessionId) return;
      measured = value ?? null;
      render(sessionId);
    }).catch(() => {
      if (token === measuredToken && panelSession === sessionId) { measured = null; render(sessionId); }
    });
  }

  /** The composer control: a leaf that glows and counts packs while the thread saves. */
  function button(sessionId: string): string {
    const saver = threadSaver(sessionId), on = saver.packs.filter(id => id !== 'rtk' || tools.rtk);
    const label = on.length ? `Token saver: ${on.length} on, about ${estimate(saver.packs, saver.level, available())}% fewer tokens` : 'Token saver: off';
    return `<button type="button" class="composer-saver-button" data-action="token-saver" aria-haspopup="dialog" aria-expanded="${panel && panelSession === sessionId ? 'true' : 'false'}" aria-pressed="${on.length > 0}" aria-label="${escape(label)}" title="${escape(label)}">${icon('leaf')}<span>Saver</span>${on.length ? `<b>${on.length}</b>` : ''}</button>`;
  }

  /** One quiet list: name, an info mark with what it does, and a switch. */
  function render(sessionId: string): void {
    if (!panel) return;
    const saver = threadSaver(sessionId), saving = estimate(saver.packs, saver.level, available()), on = new Set(saver.packs);
    const active = saver.packs.filter(id => id !== 'rtk' || tools.rtk);
    const sentKey = active.length ? `${active.join(',')}:${saver.level}` : '';
    const preset = defaults();
    const sameAsDefault = Boolean(preset) && preset!.level === saver.level && preset!.packs.join() === saver.packs.join();
    const usage = host.contextUsage?.(sessionId) ?? null, fill = usage?.contextWindow ? Math.round(usage.usedTokens / usage.contextWindow * 100) : 0;
    const tighten = suggestion(saver.packs, saver.level, usage);
    const tightenLabel = tighten ? [tighten.level === 'ultra' ? 'Ultra' : '', ...tighten.addPacks.map(id => PACKS.find(item => item.id === id)!.title)].filter(Boolean).join(' + ') : '';
    const hint = tighten ? `<div class="saver-hint"><span>Context <b>${fill}%</b> full.</span><button type="button" class="saver-tighten" data-tighten aria-label="Tighten the saver: ${escape(tightenLabel)}">Tighten: ${escape(tightenLabel)}</button></div>` : '';
    const row = (id: PackId) => {
      const pack = PACKS.find(item => item.id === id)!, missing = pack.needs === 'rtk' && !tools.rtk, active = on.has(id) && !missing;
      const about = `${pack.summary} Saves ${pack.saves}.${missing ? ` Not installed yet: turning it on installs it (${tools.rtkInstall}).` : id === 'rtk' && tools.rtkVersion ? ` rtk ${tools.rtkVersion} installed.` : ''}`;
      const levels = id === 'caveman' && active ? `<div class="saver-levels" role="radiogroup" aria-label="Caveman intensity">${LEVELS.map(level => `<button type="button" role="radio" aria-checked="${saver.level === level.id}" data-level="${level.id}" title="${escape(level.hint)}">${level.label}</button>`).join('')}</div>` : '';
      const install = missing && installing ? '<span class="saver-installing" role="status">Installing…</span>' : '';
      return `<li class="saver-row ${missing ? 'saver-missing' : ''}"><span class="saver-name" id="saver-${id}" data-tip="${escape(about)}">${pack.title}</span><span class="sr-only" id="saver-${id}-about">${escape(about)}</span>${install}<button type="button" role="switch" class="saver-switch" data-pack="${id}" aria-labelledby="saver-${id}" aria-describedby="saver-${id}-about" aria-checked="${active}" ${missing ? 'data-install="rtk"' : ''} ${missing && installing ? 'aria-busy="true" aria-disabled="true"' : ''}></button></li>${levels ? `<li class="saver-levels-row">${levels}</li>` : ''}`;
    };
    panel.innerHTML = `<header class="saver-head"><strong id="saver-title" data-tip="Applies to this thread. Guidance rides along folded with your next message, then every few messages. Savings are estimates from each project's benchmarks.">Token saver</strong><span class="saver-total" aria-label="${saving ? `About ${saving}% fewer tokens` : 'Off'}">${saving ? `−${saving}%` : 'Off'}</span></header>
      ${saver.changedAt !== undefined && measured && saver.sentKey === sentKey ? `<div class="saver-measured">${escape(measuredText(saver.changedAt, measured))}</div>` : ''}
      <ul class="saver-list">${PACKS.map(pack => row(pack.id)).join('')}</ul>${hint}
      <footer class="saver-foot"><label class="saver-default"><input type="checkbox" ${sameAsDefault ? 'checked' : ''} ${saver.packs.length ? '' : 'disabled'}><span>Start new threads like this</span></label><button type="button" class="saver-off" ${saver.packs.length ? '' : 'disabled'}>Turn all off</button></footer>`;
  }

  function place(anchor: HTMLElement): void {
    if (!panel) return;
    const rect = anchor.getBoundingClientRect(), width = Math.min(272, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
    panel.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
    panel.dataset.placement = 'above';
  }

  function close(): void {
    if (!panel) return;
    const closing = panel, session = panelSession;
    panel = undefined; panelSession = ''; cleanup?.(); cleanup = undefined;
    measured = undefined;
    hidePopover(closing);
    host.changed(session);
  }

  function open(anchor: HTMLElement, sessionId: string): void {
    if (panel && panelSession === sessionId) { close(); return; }
    close();
    panel = document.createElement('div');
    panel.className = 'floating-menu saver-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'saver-title');
    panelSession = sessionId;
    document.body.append(panel);
    render(sessionId); place(anchor); showPopover(panel, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    panel.querySelector<HTMLElement>('.saver-switch')?.focus({ preventScroll: true });
    loadMeasured(sessionId);
    // Re-checked on every open, so a fresh `brew install rtk` shows up without a restart.
    void loadTools(true).then(() => { if (panelSession === sessionId) render(sessionId); });

    const update = (patch: Parameters<typeof updateThread>[1]) => {
      const next = updateThread(sessionId, patch);
      // A thread that matched the default keeps doing so while the box stays checked.
      if (panel?.querySelector<HTMLInputElement>('.saver-default input')?.checked) setDefaults(next.packs.length ? next : null);
      render(sessionId); host.changed(sessionId);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest('[data-tighten]')) {
        const now = threadSaver(sessionId), next = suggestion(now.packs, now.level, host.contextUsage?.(sessionId) ?? null);
        if (next) update({ packs: [...now.packs, ...next.addPacks], level: next.level ?? now.level });
        return;
      }
      const toggle = target.closest<HTMLElement>('[data-pack]');
      if (toggle?.dataset.install) { if (!installing) void install(toggle.dataset.pack as PackId); return; }
      if (toggle && toggle.getAttribute('aria-disabled') !== 'true') {
        const id = toggle.dataset.pack as PackId, packs = threadSaver(sessionId).packs;
        update({ packs: packs.includes(id) ? packs.filter(pack => pack !== id) : [...packs, id] });
        panel?.querySelector<HTMLElement>(`[data-pack="${id}"]`)?.focus({ preventScroll: true });
        return;
      }
      const level = target.closest<HTMLElement>('[data-level]');
      if (level) { update({ level: level.dataset.level as typeof LEVELS[number]['id'] }); panel?.querySelector<HTMLElement>(`[data-level="${level.dataset.level}"]`)?.focus(); return; }
      if (target.closest('.saver-off')) update({ packs: [] });
    };
    /** Turning on a pack whose tool is missing installs the tool, then turns the pack on. */
    const install = async (id: PackId) => {
      installing = true; render(sessionId);
      host.notify('Installing RTK with Homebrew…');
      try {
        tools = await host.call<Tools>('token_saver_install', { tool: 'rtk' });
        loading = Promise.resolve();
        installing = false;
        const packs = threadSaver(sessionId).packs;
        if (tools.rtk) update({ packs: packs.includes(id) ? packs : [...packs, id] });
        host.notify(tools.rtk ? `RTK ${tools.rtkVersion} installed and on` : 'RTK is still not available');
      } catch (error) {
        installing = false;
        host.notify(error instanceof Error ? error.message : String(error));
      }
      if (panelSession === sessionId) render(sessionId);
    };
    const onChange = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (!input.closest('.saver-default')) return;
      const saver = threadSaver(sessionId);
      setDefaults(input.checked ? saver : null);
      host.notify(input.checked ? 'New threads start with these savers' : 'New threads start with savers off');
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); anchor.isConnected && anchor.focus(); } };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel && !panel.contains(target) && !target.closest('[data-action="token-saver"]')) close();
    };
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    cleanup = () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onOutside, true); };
  }

  return {
    button, open, close, loadTools,
    /** The folded guidance block for an outgoing message, if one is due. */
    contextFor: (sessionId: string) => contextFor(sessionId, available()),
  };
}
