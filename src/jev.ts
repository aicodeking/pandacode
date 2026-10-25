import './jev.css';
import { call, preview, subscribe } from './bridge';
import { t } from './i18n.ts';
import { escape, icon } from './dom';
import { hidePopover, showPopover } from './popover-motion';
import type { LocalServer } from './types';
import { errorText } from './error-text';

export interface JevConfiguration {
  enabled: boolean;
  decisionsEnabled: boolean;
  decisionProvider: 'typesafe' | 'openrouter' | 'laya';
  decisionModel: string;
  decisionBaseUrl: string;
  openrouterKeySaved: boolean;
  pythonPath: string;
  chromePath: string;
  textModel: string;
  textBaseUrl: string;
  typesafeKeySaved: boolean;
  textKeySaved: boolean;
}
export interface JevDoctor { ready: boolean; pythonVersion?: string | null; jevVersion?: string | null; chromePath?: string | null; issues: string[]; }
export interface JevReport {
  id: string;
  sessionId: string;
  url: string;
  goal: string;
  viewport: 'desktop' | 'mobile';
  status: 'starting' | 'running' | 'done' | 'blocked' | 'failed' | 'cancelled' | 'limit';
  verification: 'passed' | 'failed' | 'not_checked';
  summary: string;
  createdAt: number;
  durationMs: number;
  steps: number;
  checks: { name: string; passed: boolean; expected: string }[];
  events: { step: number; operation: string; target: string; url: string; elapsedMs: number }[];
  screenshot?: string | null;
  title?: string | null;
}
type TestContext = { sessionId: string; url?: string; attach?(text: string): void; settings?(): void; watch?(runId: string): void; onClose?(): void };
const views = new WeakMap<HTMLDialogElement, () => void>();
const running = (report: JevReport) => report.status === 'starting' || report.status === 'running';
const statuses: Record<JevReport['status'], string> = { starting: t('Starting browser'), running: t('Testing'), done: t('Agent finished'), blocked: t('Blocked'), failed: t('Run failed'), cancelled: t('Cancelled'), limit: t('Limit reached') };
const verificationLabels: Record<JevReport['verification'], string> = { passed: t('Checks passed'), failed: t('Checks failed'), not_checked: t('Not checked') };
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;

type JevView = { host: HTMLElement; close(): void; alive(): boolean; cleanup(callback: () => void): void };

/** Browser-local controls: keep the app usable and the form stable while events arrive. */
export function showJevTestPopover(anchor: HTMLElement, context: TestContext): () => void {
  const panel = document.createElement('section');
  panel.className = 'jev-popover floating-menu';
  panel.id = 'jev-test-popover';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Test with Jev'));
  panel.innerHTML = `<div class="jev-view"><div class="dialog-heading"><div class="jev-heading"><h2>${t('Test with Jev')}</h2>${testInfoButton('jev-test-help', t('About Jev browser tests'))}</div><button type="button" class="icon-button" data-jev-close aria-label="${t('Close Test with Jev')}">${icon('close')}</button></div></div>`;
  const host = panel.firstElementChild as HTMLElement;
  const cleanups: (() => void)[] = [];
  const expanded = anchor.getAttribute('aria-expanded'), controls = anchor.getAttribute('aria-controls');
  let closed = false, frame = 0;
  const view: JevView = { host, close, alive: () => !closed && panel.isConnected,
    cleanup(callback) { if (closed) callback(); else cleanups.push(callback); } };
  function close(restoreFocus = true) {
    if (closed) return;
    closed = true; cancelAnimationFrame(frame); resize.disconnect(); removed.disconnect();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    for (const cleanup of cleanups) cleanup();
    for (const [name, value] of [['aria-expanded', expanded], ['aria-controls', controls]]) {
      if (value === null) anchor.removeAttribute(name!); else anchor.setAttribute(name!, value!);
    }
    hidePopover(panel);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    context.onClose?.();
  }
  function position() {
    frame = 0;
    if (closed) return;
    if (!anchor.isConnected) { close(false); return; }
    const viewport = window.visualViewport, x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const rect = anchor.getBoundingClientRect(), gap = 8, inset = 12;
    panel.style.width = `${Math.min(420, Math.max(0, width - inset * 2))}px`;
    const below = y + height - rect.bottom - gap - inset, above = rect.top - y - gap - inset;
    const opensBelow = below >= Math.min(450, height * .6) || below >= above;
    const available = opensBelow ? below : above;
    // Very short windows need the viewport itself so fixed controls still fit.
    const besideAnchor = available >= Math.min(260, height - inset * 2);
    panel.style.maxHeight = `${Math.max(0, besideAnchor ? available : height - inset * 2)}px`;
    panel.style.left = `${Math.max(x + inset, Math.min(rect.right - panel.offsetWidth, x + width - panel.offsetWidth - inset))}px`;
    panel.style.top = `${besideAnchor ? Math.max(y + inset, Math.min(opensBelow ? rect.bottom + gap : rect.top - panel.offsetHeight - gap, y + height - panel.offsetHeight - inset)) : y + inset}px`;
    panel.dataset.placement = opensBelow ? 'below' : 'above';
  }
  function schedule() { if (!closed && !frame) frame = requestAnimationFrame(position); }
  function outside(event: PointerEvent) { if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(false); }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }
  const resize = new ResizeObserver(schedule);
  const removed = new MutationObserver(() => { if (!anchor.isConnected || !panel.isConnected) close(false); });
  host.querySelector('[data-jev-close]')!.addEventListener('click', () => close());
  panel.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !panel.contains(event.relatedTarget) && !anchor.contains(event.relatedTarget)) close(false);
  });
  document.body.append(panel);
  anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', panel.id);
  // mountTests builds the form synchronously, then loads settings and reports.
  void mountTests(view, context, true);
  position(); showPopover(panel, anchor); resize.observe(host);
  removed.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard, true);
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  host.querySelector<HTMLElement>(context.url ? '#jev-test-goal' : '#jev-test-url')?.focus({ preventScroll: true });
  return close;
}

function createView(dialog: HTMLDialogElement, title: string, variant: string) {
  views.get(dialog)?.();
  const host = document.createElement('div');
  host.className = 'jev-view';
  host.innerHTML = `<div class="dialog-heading"><div class="jev-heading"><span class="jev-mark">${icon('globe')}</span><h2>${title}</h2><span class="jev-preview-badge">${t('Preview')}</span></div><button type="button" class="icon-button" data-jev-close aria-label="${t`Close ${title}`}">${icon('close')}</button></div>`;
  dialog.className = `settings-dialog jev-dialog ${variant}`;
  dialog.replaceChildren(host);
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true; observer.disconnect(); dialog.removeEventListener('close', dispose);
    for (const cleanup of cleanups) cleanup();
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = '';
    if (views.get(dialog) === dispose) views.delete(dialog);
  };
  const observer = new MutationObserver(() => { if (!dialog.open || !host.isConnected || !dialog.contains(host)) dispose(); });
  observer.observe(dialog, { childList: true, attributes: true, attributeFilter: ['open'] });
  dialog.addEventListener('close', dispose, { once: true });
  views.set(dialog, dispose);
  const close = () => { dispose(); dialog.close(); };
  host.querySelector('[data-jev-close]')!.addEventListener('click', close);
  if (!dialog.open) dialog.showModal();
  return { host, close, alive: () => !disposed && host.isConnected, cleanup: (callback: () => void) => { if (disposed) callback(); else cleanups.push(callback); } };
}

export async function showJevSettings(dialog: HTMLDialogElement): Promise<void> {
  const view = createView(dialog, t('Jev add-on'), 'jev-settings-dialog');
  const { host } = view;
  host.insertAdjacentHTML('beforeend', `<form class="jev-settings-form">
    <fieldset class="jev-fields" disabled>
      <label class="jev-enable-row" for="jev-enabled"><span><strong>${t('Let your agents test their apps')}</strong><small>${t('Available to your architect and workers when enabled.')}</small></span><input class="jev-switch" type="checkbox" id="jev-enabled" role="switch"></label>
      <label class="jev-enable-row" for="jev-decisions-enabled"><span><strong>${t('Decision assistance')}</strong><small>${t('Optional reviews, project rules, context search, and worker suggestions.')}</small></span><input class="jev-switch" type="checkbox" id="jev-decisions-enabled" role="switch"></label>
      <p class="jev-privacy">${t('Browser tests send your goal and visible page text to TypeSafe and your text model provider, using a separate Chrome profile. Decision assistance sends selected task text and diffs to TypeSafe, or to OpenRouter if you choose it below. Reports stay on this device.')}</p>
      <section class="jev-section"><div class="jev-section-heading"><h3>${t('Connections')}</h3><span>${t('Usage is billed by your providers')}</span></div>
        <div class="jev-field-grid">
          <label>${t('Decision provider')}<select id="jev-decision-provider"><option value="typesafe">${t('TypeSafe (default)')}</option><option value="openrouter">${t('OpenRouter')}</option></select></label>
          <div class="jev-model-field"><label for="jev-decision-model">${t('Decision model')}</label><div><select id="jev-decision-model"></select><button type="button" class="jev-text-button" data-jev-models-refresh hidden>${t('Refresh')}</button></div></div>
        </div>
        ${keyField('typesafe', t('TypeSafe API key'))}${keyField('openrouter', t('OpenRouter API key'))}${keyField('text', t('Text model API key'))}
        <p class="jev-hint">${t('PandaCode works without Jev or a TypeSafe key. Optional decision assistance only needs the key for the provider you pick. OpenRouter models are listed only when you open the model menu. Keys are saved privately on this device, outside the keychain. Leave a field empty to keep its saved key.')}</p>
