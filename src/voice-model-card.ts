import { escape, icon } from './dom.ts';
import { languageName } from './voice-model-browser.ts';
import type { VoiceLocalModel } from './voice-types.ts';

/** A model test in progress or finished; only ever shown on its own card, never written to a draft. */
export interface ModelTest { modelId: string; phase: 'recording' | 'transcribing' | 'done' | 'error'; text?: string }

export interface ModelCardView {
  selectedLanguages: readonly string[];
  /** In-flight actions keyed `download:<id>`, `cancel:<id>`, `select:<id>`, `delete:<id>`. */
  pending: ReadonlySet<string>;
  confirmingDelete?: string;
  test?: ModelTest;
  errors: ReadonlyMap<string, string>;
  /** Local models cannot run on this computer: downloads stay disabled. */
  unsupported?: boolean;
  /** The name of the model downloading or verifying now; other downloads wait for it. */
  busyWith?: string;
}

const STAR = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1L3.2 9.4l6.1-.8Z"/></svg>';

/** Decimal units, as download sizes are usually quoted: 705 MB, 1.6 GB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1e6;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1).replace(/\.0$/, '')} GB`;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Seconds to transcribe 30 s of audio; null (or any non-number) when the benchmark did not measure speed. */
export function formatSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** A measured accuracy score; catalog entries missing a grade or error rate count as not benchmarked. */
function validScore(score: unknown): score is { grade: string; errorPercent: number } {
  const value = score as { grade?: unknown; errorPercent?: unknown } | null | undefined;
  return typeof value?.grade === 'string' && typeof value.errorPercent === 'number' && Number.isFinite(value.errorPercent);
}

/** Fraction downloaded, 0..1. */
export function downloadFraction(model: VoiceLocalModel): number {
  if (model.state === 'verifying' || model.state === 'installed') return 1;
  return model.size > 0 ? Math.min(1, Math.max(0, (model.downloaded ?? 0) / model.size)) : 0;
}

/** The language a card leads with when browsing all languages: English when the model has it (so a multilingual
 * model doesn't open with, say, Italian), else the language whose benchmark error is lowest, if any were measured. */
function bestLanguage(model: VoiceLocalModel): string | undefined {
  if (Array.isArray(model.languages) && model.languages.includes('en')) return 'en';
  const entries = Object.entries(model.benchmark?.accuracy ?? {}).filter(([, score]) => validScore(score));
  return entries.sort(([, a], [, b]) => a.errorPercent - b.errorPercent)[0]?.[0];
}

function accuracyFact(model: VoiceLocalModel, code: string): string {
  const score = model.benchmark?.accuracy?.[code];
  if (!validScore(score)) return `${escape(languageName(code))}: not benchmarked`;
  return `${escape(languageName(code))}: <strong>${escape(score.grade)}</strong> (${score.errorPercent.toFixed(2)}% error)`;
}

function speedFact(model: VoiceLocalModel): string {
  if (!model.benchmark) return 'Not benchmarked yet';
  const speed = formatSeconds(model.benchmark.secondsPer30s);
  return speed ? `Speed: <strong>${speed}</strong> / 30 s` : 'Speed not measured';
}

/** Accuracy for each selected language (or the best one), speed, language count, size and licence. Every fact
 * carries its leading separator; the list is shifted left by one separator and clipped there, so the separator of
 * whichever fact starts a line (the first, or one that wrapped, like the licence on a wide card) is never shown. */
export function modelFactsHtml(model: VoiceLocalModel, selected: readonly string[]): string {
  const best = bestLanguage(model);
  const languages = selected.length ? selected : best ? [best] : [];
  const count = Array.isArray(model.languages) ? model.languages.length : 0;
  const facts = [
    ...languages.map(code => accuracyFact(model, code)), speedFact(model),
    `${count} ${count === 1 ? 'language' : 'languages'}`, formatSize(model.size), licenseHtml(model),
  ];
  const groups = facts.map(fact => `<span class="voice-model-fact"><span class="voice-model-dot" aria-hidden="true">·</span>${fact}</span>`);
  return `<div class="voice-model-facts-clip"><p class="voice-model-facts">${groups.join('')}</p></div>`;
}

/** Canonical SPDX casing for the licence ids the catalog carries in lowercase (Hugging Face's style). */
const LICENSE_LABELS: Readonly<Record<string, string>> = {
  'apache-2.0': 'Apache-2.0', mit: 'MIT', 'bsd-2-clause': 'BSD-2-Clause', 'bsd-3-clause': 'BSD-3-Clause', 'mpl-2.0': 'MPL-2.0',
  'gpl-3.0': 'GPL-3.0', 'lgpl-3.0': 'LGPL-3.0', 'cc0-1.0': 'CC0-1.0', 'cc-by-4.0': 'CC-BY-4.0', 'cc-by-sa-4.0': 'CC-BY-SA-4.0',
  'cc-by-nc-4.0': 'CC-BY-NC-4.0', 'cc-by-nc-sa-4.0': 'CC-BY-NC-SA-4.0', 'cc-by-nc-nd-4.0': 'CC-BY-NC-ND-4.0', 'openmdw-1.1': 'OpenMDW-1.1',
};
/** A licence id as shown on a card: its canonical SPDX casing when known, else the catalog's text unchanged. */
export function licenseLabel(id: string): string {
  return Object.hasOwn(LICENSE_LABELS, id.toLowerCase()) ? LICENSE_LABELS[id.toLowerCase()] : id;
}

/** The licence, linked when the catalog has an https URL for it (external-links.ts opens it in the system browser). */
function licenseHtml(model: VoiceLocalModel): string {
  let url: URL | undefined;
  try { url = model.licenseUrl ? new URL(model.licenseUrl) : undefined; } catch { url = undefined; }
  const license = escape(typeof model.license === 'string' && model.license ? licenseLabel(model.license) : 'Unknown licence');
  if (url?.protocol !== 'https:') return license;
  return `<a class="voice-model-license" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${license}</a>`;
}

/** Bytes kept from a cancelled or interrupted download, which the next download resumes. */
export function partialPercent(model: VoiceLocalModel): number {
  if (model.state !== 'downloadable' || !(model.size > 0) || !((model.downloaded ?? 0) > 0)) return 0;
  return Math.min(99, Math.max(1, Math.round((model.downloaded! / model.size) * 100)));
}

function badgesHtml(model: VoiceLocalModel): string {
  const badges = [
    model.recommended ? `<li class="voice-model-badge" data-badge="recommended">${STAR}Recommended</li>` : '',
    model.supportsStreaming ? '<li class="voice-model-badge">Live preview</li>' : '',
    model.supportsTranslation ? '<li class="voice-model-badge">Translate</li>' : '',
  ].join('');
  // A list (role kept explicitly: WebKit drops it from unstyled lists), so each badge is read on its own.
  return badges ? `<ul class="voice-model-badges" role="list" aria-label="Model features">${badges}</ul>` : '';
}

function progressHtml(model: VoiceLocalModel): string {
  const fraction = downloadFraction(model), percent = Math.round(fraction * 100), name = escape(model.name);
  const label = model.state === 'verifying' ? 'Verifying…' : `Downloading ${percent}% of ${formatSize(model.size)}`;
  const value = model.state === 'verifying' ? '' : ` aria-valuenow="${percent}"`;
  return `<div class="voice-model-progress"><span class="voice-model-progress-track" role="progressbar" aria-label="Download ${name}" aria-valuemin="0" aria-valuemax="100"${value} aria-valuetext="${label}">`
    + `<span class="voice-model-progress-fill" style="--voice-progress:${fraction.toFixed(4)}"></span></span>`
    + `<span class="voice-model-progress-label">${label}</span></div>`;
}

function deleteConfirmHtml(model: VoiceLocalModel, busy: boolean): string {
  const id = escape(model.id), name = escape(model.name), disabled = busy ? ' disabled' : '';
  return `<span class="voice-model-confirm" role="status">Delete ${name}? This frees ${formatSize(model.size)}.</span>`
    + `<button type="button" class="ds-btn" data-voice-model-keep="${id}" aria-label="Keep ${name}"${disabled}>Cancel</button>`
    + `<button type="button" class="ds-btn voice-model-danger" data-voice-model-confirm-delete="${id}" aria-label="Confirm deleting ${name}"${disabled}>${busy ? 'Deleting…' : 'Delete'}</button>`;
}

function testButtonHtml(model: VoiceLocalModel, test: ModelTest | undefined): string {
  const mine = test?.modelId === model.id ? test : undefined, id = escape(model.id), name = escape(model.name);
  if (mine?.phase === 'recording') return `<button type="button" class="ds-btn" data-voice-model-test-stop="${id}" aria-label="Stop testing ${name}">${icon('stop')}Stop and transcribe</button>`;
  if (mine?.phase === 'transcribing') return `<button type="button" class="ds-btn" disabled aria-label="Transcribing test of ${name}">Transcribing…</button>`;
  return `<button type="button" class="ds-btn" data-voice-model-test="${id}" aria-label="Test ${name}"${test && !mine ? ' disabled' : ''}>Test model</button>`;
}

function installedActions(model: VoiceLocalModel, view: ModelCardView): string {
  const id = escape(model.id), name = escape(model.name);
  const select = model.active
    ? `<button type="button" class="ds-btn voice-model-selected" aria-disabled="true" aria-label="${name} selected">${icon('check')}Selected</button>${testButtonHtml(model, view.test)}`
    : `<button type="button" class="ds-btn-primary" data-voice-model-select="${id}" aria-label="Select ${name}"${view.pending.has(`select:${model.id}`) ? ' disabled' : ''}>Select</button>`;
  // Native refuses to delete a model under test, so its Delete waits until the test is stopped and transcribed.
  const testing = view.test?.modelId === model.id && (view.test.phase === 'recording' || view.test.phase === 'transcribing');
  const tip = testing ? 'Stop the model test first' : 'Delete';
  const remove = `<button type="button" class="ds-btn ds-btn-icon" data-voice-model-delete="${id}" aria-label="Delete ${name}" data-tip="${tip}"${testing ? ' disabled' : ''}>${icon('trash')}</button>`;
  return select + remove;
}

function actionsHtml(model: VoiceLocalModel, view: ModelCardView): string {
  const id = escape(model.id), name = escape(model.name);
  if (view.confirmingDelete === model.id) return deleteConfirmHtml(model, view.pending.has(`delete:${model.id}`));
  if (model.state === 'installed') return installedActions(model, view);
  if (model.state === 'verifying') return progressHtml(model);
  if (model.state === 'downloading') {
    return progressHtml(model) + `<button type="button" class="ds-btn" data-voice-model-cancel="${id}" aria-label="Cancel downloading ${name}"${view.pending.has(`cancel:${model.id}`) ? ' disabled' : ''}>Cancel</button>`;
  }
  return downloadButtonHtml(model, view);
}

/** The id of a card's hidden "wait" reason, which a waiting Download button is described by. */
export function waitReasonId(model: Pick<VoiceLocalModel, 'id'>): string {
  return `voice-model-wait-${model.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
export function waitReason(busyWith: string): string { return `Wait for ${busyWith} to finish or cancel it`; }

/** Download, or Resume for a partial file; while another model downloads it stays focusable but waits (aria-disabled),
 * described by the reason, which Settings also shows in its status line when the button is pressed. */
function downloadButtonHtml(model: VoiceLocalModel, view: ModelCardView): string {
  const id = escape(model.id), name = escape(model.name), partial = partialPercent(model);
  const disabled = view.unsupported || view.pending.has(`download:${model.id}`) ? ' disabled' : '';
  const reason = !disabled && view.busyWith ? escape(waitReason(view.busyWith)) : '';
  const waiting = reason ? ` aria-disabled="true" aria-describedby="${waitReasonId(model)}" data-tip="${reason}"` : '';
  const label = partial ? `Resume downloading ${name}` : `Download ${name}`;
  return `<button type="button" class="ds-btn" data-voice-model-download="${id}" aria-label="${label}"${disabled}${waiting}>${icon('download')}${partial ? `Resume (${partial}%)` : 'Download'}</button>`
    + (reason ? `<span id="${waitReasonId(model)}" hidden>${reason}</span>` : '');
}

/** What a finished test heard, as shown on the card and announced (`modelTestAnnouncement`). */
function transcriptText(test: ModelTest): string {
  return test.text?.trim() || 'No speech recognized. Try again.';
}
/** The polite announcement for a model test, written into the Transcription card's persistent live region (a
 * region created together with its text is not reliably announced). Empty when there is nothing new to say. */
export function modelTestAnnouncement(test: ModelTest | undefined, name: string): string {
  if (test?.phase === 'recording') return `Testing ${name}. Say a sentence, then stop.`;
  if (test?.phase === 'done') return `${name} heard: ${transcriptText(test)}`;
  return '';
}

function noticeHtml(model: VoiceLocalModel, view: ModelCardView): string {
  const error = view.errors.get(model.id);
  const test = view.test?.modelId === model.id ? view.test : undefined;
  const transcript = test?.phase === 'done'
    ? `<p class="voice-model-transcript">${escape(transcriptText(test))}</p>`
    : test?.phase === 'recording' ? '<p class="voice-model-transcript">Recording… say a sentence, then stop.</p>' : '';
  const partial = partialPercent(model) && view.confirmingDelete !== model.id ? '<p class="voice-model-partial">Partly downloaded</p>' : '';
  return partial + (error ? `<p class="voice-model-error" role="alert">${escape(error)}</p>` : '') + transcript;
}

/** One model in the browser: name and badges, a one-line description, facts and its actions. */
export function modelCardHtml(model: VoiceLocalModel, view: ModelCardView): string {
  // While downloading or verifying the card itself can hold focus, so it stays put when Cancel goes away.
  const focusable = model.state === 'downloading' || model.state === 'verifying' ? ' tabindex="-1"' : '';
  return `<div role="listitem" class="ds-card-inner voice-model-card" data-model-id="${escape(model.id)}" data-state="${model.state}"${model.active ? ' data-active' : ''}${focusable} aria-label="${escape(model.name)}">`
    + `<div class="voice-model-head"><h5 class="voice-model-name">${escape(model.name)}</h5>${badgesHtml(model)}</div>`
    + `<p class="voice-model-description">${escape(model.description ?? '')}</p>${modelFactsHtml(model, view.selectedLanguages)}`
    + `<div class="voice-model-actions">${actionsHtml(model, view)}</div>${noticeHtml(model, view)}</div>`;
}
