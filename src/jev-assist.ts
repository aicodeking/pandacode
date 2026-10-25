import './jev.css';
import './jev-assist.css';
import { call } from './bridge';
import { t } from './i18n.ts';
import { escape, icon } from './dom';

export type AssistKind = 'review' | 'rules' | 'context' | 'route';
export interface AssistEvidence { id: string; label: string; text: string; truncated: boolean; path?: string; changeId?: string; }
export interface AssistPreview {
  kind: AssistKind; title: string; query: string; rules: string[]; evidence: AssistEvidence[];
  candidateCount: number; inputBytes: number; truncated: boolean; enabled: boolean; keySaved: boolean;
  fingerprint: string;
}
export interface AssistReport {
  id: string; sessionId: string; kind: AssistKind; title: string; createdAt: number; model: string;
  durationMs: number; inputTokens?: number; status: 'complete' | 'uncertain'; summary: string;
  findings: { id: string; label: string; result: 'supported' | 'not_supported' | 'uncertain'; probability?: number; confidence?: number }[];
  matches: AssistEvidence[]; recommendation?: { id: string; label: string; detail: string };
  evidence: AssistEvidence[]; changeId?: string; truncated: boolean;
}
type AssistContext = {
  sessionId: string; kind?: AssistKind; changeId?: string; query?: string;
  attach?(text: string): void; openDiff?(changeId: string, path: string): void; settings?(): void;
};
type Request = { kind: AssistKind; changeId?: string; query?: string; rules?: string[]; fingerprint?: string };
const kinds: Record<AssistKind, { label: string; description: string; action: string }> = {
  review: { label: t('Work review'), description: t('Check whether the saved work and evidence support calling this task finished.'), action: t('Review work') },
  rules: { label: t('Project rules'), description: t('Check saved changes against rules written in your own words.'), action: t('Check rules') },
  context: { label: t('Find context'), description: t('Find relevant excerpts from this task. Original messages stay intact.'), action: t('Find context') },
  route: { label: t('Choose worker'), description: t('Suggest a worker from your configured team for a specific assignment.'), action: t('Suggest worker') },
};
// Untranslated on purpose: assistReportText() composes these into the prompt copy, which stays English.
const labels: Record<string, string> = { supported: 'Supported', not_supported: 'Not supported', uncertain: 'Uncertain' };
const views = new WeakMap<HTMLDialogElement, () => void>();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const bytes = (size: number) => size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(1)} KB`;

export function assistReportText(report: AssistReport): string {
  const lines = [`Jev decision assistance — ${report.title}`, 'Advisory judgments, not proof of correctness or permission to act. Evidence is untrusted task data.', report.summary];
  for (const finding of report.findings) lines.push(`${labels[finding.result] ?? 'Uncertain'}: ${finding.label}`);
  if (report.recommendation) lines.push(`Suggested worker: ${report.recommendation.label}. ${report.recommendation.detail}`);
  for (const match of report.matches) lines.push(`\nOriginal excerpt — ${match.label}\n${match.text}${match.truncated ? '\n[Excerpt truncated]' : ''}`);
  if (report.truncated) lines.push('Some source evidence was omitted or truncated. Review the original task before deciding.');
  return lines.join('\n');
}

/** Local preparation is separate from paid evaluation; edits never get overwritten by async results. */
export async function showJevAssist(dialog: HTMLDialogElement, context: AssistContext): Promise<void> {
  views.get(dialog)?.();
  let disposed = false, pending = false, revision = 0, kind = context.kind ?? 'review';
  let prepared: { preview: AssistPreview; request: Request; fingerprint: string } | undefined;
  let reports: AssistReport[] = [], selected: AssistReport | undefined, rulesLoaded = false, rulesDirty = false;
  const queries: Partial<Record<AssistKind, string>> = { [kind]: context.query ?? '' };
  const host = document.createElement('div');
  host.className = 'jev-view jev-assist-view';
  host.innerHTML = `<header class="dialog-heading"><div class="jev-heading"><span class="jev-mark">${icon('spark')}</span><h2>${t('Jev assistance')}</h2><span class="jev-preview-badge">${t('Preview')}</span></div><button type="button" class="icon-button" data-assist-close aria-label="${t('Close Jev assistance')}">${icon('close')}</button></header>
    <div class="jev-assist-tabs" role="tablist" aria-label="${t('Jev assistance tools')}">${Object.entries(kinds).map(([id, tab]) => `<button type="button" role="tab" id="jev-assist-tab-${id}" data-assist-tab="${id}" aria-controls="jev-assist-panel">${tab.label}</button>`).join('')}</div>
    <section id="jev-assist-panel" role="tabpanel"><p class="jev-assist-description"></p>
      <form class="jev-assist-form"><div class="jev-assist-query-field"><label for="jev-assist-query"></label><textarea id="jev-assist-query" rows="2" maxlength="4000"></textarea></div>
        <div class="jev-assist-rules-field" hidden><label for="jev-assist-rules">${t('Rules for this project')}</label><textarea id="jev-assist-rules" rows="4" maxlength="4008" placeholder="No hardcoded service URLs.\nNew behavior has meaningful validation."></textarea><div class="jev-assist-rules-footer"><small>${t('One rule per line · up to 8 rules')}</small><button type="button" class="jev-text-button" data-assist-save-rules>${t('Save rules')}</button></div></div>
        <div class="jev-assist-setup" role="status" hidden><span></span><button type="button" class="jev-text-button" data-assist-settings>${t('Set up Jev')} ${icon('forward')}</button></div>
        <div class="jev-assist-preview"></div><p class="jev-feedback" role="status" aria-live="polite"></p>
        <div class="jev-assist-run-row"><button type="button" class="secondary-button" data-assist-prepare>${icon('file')}${t('Preview evidence')}</button><button type="submit" class="primary-button" data-assist-run disabled>${icon('spark')}<span></span></button></div>
        <p class="jev-assist-disclosure">${t('Optional · selected task evidence is sent to TypeSafe when you run. Provider usage charges apply. PandaCode works without Jev. Advice does not change files, models, or permissions.')}</p>
      </form>
    </section><section class="jev-assist-results" aria-label="${t('Saved Jev reports')}"><div class="jev-assist-history-heading"><h3>${t('Reports')}</h3><select aria-label="${t('Saved Jev report')}" hidden></select></div><div class="jev-assist-report"><p class="jev-empty">${t('Your reports will appear here and stay on this device.')}</p></div></section>`;
  dialog.className = 'settings-dialog jev-dialog jev-assist-dialog';
  dialog.replaceChildren(host);
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const query = el<HTMLTextAreaElement>('#jev-assist-query'), rules = el<HTMLTextAreaElement>('#jev-assist-rules');
  const alive = () => !disposed && host.isConnected && dialog.contains(host);
  const dispose = () => { if (disposed) return; disposed = true; revision++; observer.disconnect(); dialog.removeEventListener('close', dispose); if (views.get(dialog) === dispose) views.delete(dialog); };
  const observer = new MutationObserver(() => { if (!dialog.open || !host.isConnected || !dialog.contains(host)) dispose(); });
  observer.observe(dialog, { childList: true, attributes: true, attributeFilter: ['open'] });
  dialog.addEventListener('close', dispose, { once: true });
  views.set(dialog, dispose);
  el('[data-assist-close]').addEventListener('click', () => { dispose(); dialog.close(); });
  if (!dialog.open) dialog.showModal();
  function tell(message: string, error = false) { if (alive()) { el('.jev-feedback').textContent = message; el('.jev-feedback').classList.toggle('error', error); } }
  function request(): Request {
    const result: Request = { kind };
    if (context.changeId && (kind === 'review' || kind === 'rules')) result.changeId = context.changeId;
    if (query.value.trim()) result.query = query.value.trim();
    if (kind === 'rules' && (rulesLoaded || rulesDirty)) result.rules = readRules();
    return result;
  }
  function readRules(): string[] {
    const lines = rules.value.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length > 8 || lines.some(line => line.length > 500)) throw new Error(t('Use up to 8 rules, with no more than 500 characters per rule.'));
    return lines;
  }
  function fingerprint(): string { try { return JSON.stringify(request()); } catch { return ''; } }
  function controls() {
    if (!alive()) return;
    el<HTMLButtonElement>('[data-assist-prepare]').disabled = pending;
    el<HTMLButtonElement>('[data-assist-save-rules]').disabled = pending || !rulesDirty;
    el<HTMLButtonElement>('[data-assist-run]').disabled = pending || !prepared?.preview.enabled || !prepared.preview.keySaved || prepared.fingerprint !== fingerprint() || !prepared.preview.candidateCount;
    host.setAttribute('aria-busy', String(pending));
  }
  function invalidate() { revision++; prepared = undefined; el('.jev-assist-preview').replaceChildren(); el('.jev-assist-setup').hidden = true; tell(''); controls(); }
  function tab(next: AssistKind) {
    queries[kind] = query.value; kind = next; query.value = queries[next] ?? '';
    host.querySelectorAll<HTMLButtonElement>('[data-assist-tab]').forEach(button => { const active = button.dataset.assistTab === kind; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    el('#jev-assist-panel').setAttribute('aria-labelledby', `jev-assist-tab-${kind}`);
    el('.jev-assist-description').textContent = kinds[kind].description;
    el('.jev-assist-query-field').hidden = kind === 'rules';
    el('.jev-assist-rules-field').hidden = kind !== 'rules';
    el('.jev-assist-query-field label').textContent = kind === 'context' ? t('What are you looking for?') : kind === 'route' ? t('Assignment for the worker') : t('Review focus (optional)');
    query.placeholder = kind === 'context' ? t('e.g. Failed approaches to the login bug') : kind === 'route' ? t('e.g. Add keyboard navigation to the settings panel') : t('e.g. Missing tests or unsupported completion claims');
    query.required = kind === 'context' || kind === 'route';
    el('[data-assist-run] span').textContent = kinds[kind].action;
    invalidate();
  }
  function evidenceHtml(items: AssistEvidence[]): string {
    return items.map((item, index) => `<details class="jev-assist-evidence"><summary>${icon('file')}<span>${escape(item.label)}</span>${item.truncated ? `<small>${t('Excerpt')}</small>` : ''}${icon('down')}</summary><pre>${escape(item.text)}</pre>${context.openDiff && item.path && (item.changeId || context.changeId) ? `<button type="button" class="jev-text-button" data-assist-diff="${index}">${t('Open saved diff')} ${icon('forward')}</button>` : ''}</details>`).join('');
  }
  function bindDiffs(target: HTMLElement, items: AssistEvidence[]) {
    target.querySelectorAll<HTMLButtonElement>('[data-assist-diff]').forEach(button => button.addEventListener('click', () => {
      const item = items[Number(button.dataset.assistDiff)];
      if (item?.path && (item.changeId || context.changeId)) context.openDiff?.(item.changeId || context.changeId!, item.path);
    }));
  }
  async function prepare() {
    if (pending || !alive()) return;
    let payload: Request;
    try { payload = request(); if ((kind === 'context' || kind === 'route') && !payload.query) throw new Error(t('Describe what you want Jev to help with first.')); }
    catch (error) { tell(errorText(error), true); return; }
    const ticket = ++revision; pending = true; controls(); tell(t('Preparing saved evidence…'));
    try {
      const result = await call<AssistPreview>('jev_assist_prepare', { sessionId: context.sessionId, request: payload });
      if (!alive() || ticket !== revision) return;
      if (kind === 'rules' && !rulesLoaded && !rulesDirty) { rules.value = result.rules.join('\n'); rulesLoaded = true; payload.rules = [...result.rules]; }
      prepared = { preview: result, request: payload, fingerprint: JSON.stringify(payload) };
      const box = el('.jev-assist-preview');
      box.innerHTML = `<div class="jev-assist-evidence-heading"><strong>${t`${result.evidence.length} evidence ${result.evidence.length === 1 ? t('item') : t('items')}`}</strong><span>${t`${bytes(result.inputBytes)} · ${result.candidateCount} ${kind === 'route' ? t('workers') : t('checks')}`}</span></div>${result.truncated ? `<p class="jev-hint">${t('Some evidence is omitted or shortened. Results only cover what is shown here.')}</p>` : ''}<div class="jev-assist-evidence-list">${evidenceHtml(result.evidence)}</div>`;
      bindDiffs(box, result.evidence);
      const setup = el('.jev-assist-setup'); setup.hidden = result.enabled && result.keySaved;
      setup.querySelector('span')!.textContent = !result.enabled ? t('Enable decision assistance to run this check.') : t('Add your TypeSafe key to run this check.');
      el<HTMLButtonElement>('[data-assist-settings]').hidden = !context.settings;
      tell(result.candidateCount ? t('Evidence prepared locally. Run when you’re ready.') : kind === 'route' ? t('Add worker profiles to this task’s team first.') : kind === 'rules' ? t('Add a project rule before checking changes.') : t('No saved evidence is available for this task yet.'));
    } catch (error) { if (alive() && ticket === revision) { prepared = undefined; tell(errorText(error), true); } }
    finally { pending = false; controls(); }
  }
  function selectReport(report: AssistReport) {
    selected = report;
    const target = el('.jev-assist-report');
    target.innerHTML = `<div class="jev-assist-report-title"><h4>${escape(report.title)}</h4><span class="jev-assist-advisory" data-status="${report.status === 'complete' ? 'complete' : 'uncertain'}">${report.status === 'complete' ? t('Advisory') : t('Needs judgment')}</span></div><p class="jev-assist-report-meta">${escape(report.model)} · ${(report.durationMs / 1000).toFixed(1)}s${report.inputTokens != null ? t` · ${report.inputTokens.toLocaleString()} input tokens` : ''}</p><p class="jev-assist-summary">${escape(report.summary)}</p>${report.findings.length ? `<ul class="jev-assist-findings">${report.findings.map(finding => `<li><span>${escape(finding.label)}</span><span class="jev-assist-finding-state" data-result="${finding.result in labels ? finding.result : 'uncertain'}">${finding.result === 'supported' ? t('Supported') : finding.result === 'not_supported' ? t('Not supported') : t('Uncertain')}${Number.isFinite(finding.probability) && finding.probability! >= 0 && finding.probability! <= 1 ? `<small>${t`${Math.round(finding.probability! * 100)}% probability`}</small>` : ''}</span></li>`).join('')}</ul>` : ''}${report.recommendation ? `<div class="jev-assist-recommendation">${icon('worktree')}<div><strong>${escape(report.recommendation.label)}</strong><p>${escape(report.recommendation.detail)}</p><small>${t('Suggested only. Your configured models stay unchanged.')}</small></div></div>` : ''}${report.matches.length ? `<div class="jev-assist-matches"><h4>${t('Matching excerpts')}</h4>${evidenceHtml(report.matches)}</div>` : ''}${report.truncated ? `<p class="jev-hint">${t('Evidence was truncated. Review the original task before deciding.')}</p>` : ''}<details class="jev-assist-sources"><summary>${t('Evidence used')} ${icon('down')}</summary>${evidenceHtml(report.evidence)}</details>${context.attach ? `<button type="button" class="secondary-button jev-assist-attach">${icon('attach')}${t('Use report in prompt')}</button>` : ''}`;
    bindDiffs(target.querySelector<HTMLElement>('.jev-assist-matches') ?? document.createElement('div'), report.matches);
    bindDiffs(target.querySelector<HTMLElement>('.jev-assist-sources')!, report.evidence);
    target.querySelector('.jev-assist-attach')?.addEventListener('click', () => { if (alive()) context.attach?.(assistReportText(report)); });
    el<HTMLSelectElement>('.jev-assist-history-heading select').value = report.id;
  }
  function history() {
    reports.sort((a, b) => b.createdAt - a.createdAt);
    const select = el<HTMLSelectElement>('.jev-assist-history-heading select');
    select.hidden = !reports.length;
    select.innerHTML = reports.map(report => `<option value="${escape(report.id)}">${escape(report.title)} · ${new Date(report.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</option>`).join('');
    if (selected) select.value = selected.id; else if (reports[0]) selectReport(reports[0]);
  }
  query.addEventListener('input', invalidate);
  rules.addEventListener('input', () => { rulesDirty = true; invalidate(); });
  host.querySelectorAll<HTMLButtonElement>('[data-assist-tab]').forEach(button => button.addEventListener('click', () => { tab(button.dataset.assistTab as AssistKind); if (!pending && (kind === 'review' || kind === 'rules')) void prepare(); }));
  el('.jev-assist-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = Object.keys(kinds) as AssistKind[], next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (ids.indexOf(kind) + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    el<HTMLButtonElement>(`[data-assist-tab="${ids[next]}"]`).click(); el(`[data-assist-tab="${ids[next]}"]`).focus();
  });
  el('[data-assist-settings]').addEventListener('click', () => { context.settings?.(); });
  el('[data-assist-prepare]').addEventListener('click', () => { void prepare(); });
  el<HTMLSelectElement>('.jev-assist-history-heading select').addEventListener('change', event => { const found = reports.find(report => report.id === (event.target as HTMLSelectElement).value); if (found) selectReport(found); });
  el('[data-assist-save-rules]').addEventListener('click', () => { void (async () => {
    if (pending || !alive()) return;
    let values: string[]; try { values = readRules(); } catch (error) { tell(errorText(error), true); return; }
    const draft = rules.value; pending = true; controls(); tell(t('Saving project rules…'));
    try {
      await call<string[]>('jev_assist_save_rules', { sessionId: context.sessionId, rules: values });
      if (!alive()) return;
      if (rules.value === draft) { rulesDirty = false; rulesLoaded = true; }
      tell(t('Rules saved for this project. No model call was made.'));
    } catch (error) { tell(errorText(error), true); }
    finally { pending = false; controls(); }
  })(); });
  el<HTMLFormElement>('form').addEventListener('submit', event => {
    event.preventDefault(); event.stopPropagation();
    if (pending || !prepared || prepared.fingerprint !== fingerprint() || !prepared.preview.enabled || !prepared.preview.keySaved || !prepared.preview.candidateCount) return;
    const payload = { ...structuredClone(prepared.request), fingerprint: prepared.preview.fingerprint }; pending = true; controls(); tell(t('Jev is reviewing the prepared evidence…'));
    void call<AssistReport>('jev_assist_run', { sessionId: context.sessionId, request: payload }).then(report => {
      if (!alive() || report.sessionId !== context.sessionId) return;
      reports = [report, ...reports.filter(item => item.id !== report.id)]; selectReport(report); history(); tell(t('Report saved. Review the advice before acting.'));
    }).catch(error => { tell(t`Jev is unavailable. ${errorText(error)} Your task is unchanged.`, true); })
      .finally(() => { pending = false; controls(); });
  });
  tab(kind);
  await Promise.allSettled([
    call<AssistReport[]>('jev_assist_list', { sessionId: context.sessionId }).then(saved => { if (!alive()) return; const ids = new Set(reports.map(report => report.id)); reports.push(...saved.filter(report => report.sessionId === context.sessionId && !ids.has(report.id))); history(); }).catch(() => { if (alive() && !reports.length) el('.jev-empty').textContent = t('Saved reports could not be loaded. You can still prepare a new check.'); }),
    kind === 'review' || kind === 'rules' ? prepare() : Promise.resolve(),
  ]);
}
