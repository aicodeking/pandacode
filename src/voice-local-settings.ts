import { call, subscribe } from './bridge';
import { escape, isImeKey, morph } from './dom';
import { errorText } from './error-text';
import {
  ALL_LANGUAGES, browserTitle, catalogLanguages, destinationOptionsHtml, destinationValue, emptyModelsText, filterModels, languageNote, languageOptionsHtml,
  languagesHtml, parseDestination, setupModel, sortModels, usableModel,
} from './voice-model-browser';
import { modelCardHtml, modelTestAnnouncement, waitReason, type ModelTest } from './voice-model-card';
import { VOICE_CANCELLED } from './voice-types';
import type {
  VoiceConfiguration, VoiceLocalCatalog, VoiceLocalModel, VoiceLocalModelEvent, VoiceLocalTestRequest, VoiceLocalTestResult, VoicePreferences, VoiceProfile,
  VoiceTestEnded,
} from './voice-types';

/** Type-ahead letters typed within this long extend one search. */
const TYPEAHEAD_MS = 600;
/** The most rows PageUp/PageDown move in the Languages list. */
const LANGUAGE_PAGE_MAX = 10;
const message = (cause: unknown) => errorText(cause, 'An unexpected error occurred.');
const testModel = <T = unknown>(request: VoiceLocalTestRequest) => call<T>('voice_local_test_model', request);

/** Voice preferences shared by the Input and Transcription cards. Reloads and saves share one queue, so neither a late
 * save reply nor a reload asked before a save can undo a newer choice. */
export class VoicePreferencesStore {
  value?: VoicePreferences;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  /** Saves queued and not yet running: a reload ahead of them stores its result quietly, since they will publish. */
  private savesWaiting = 0;
  private unpublished = false;

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(next: VoicePreferences): VoicePreferences {
    this.value = next; this.unpublished = false; this.listeners.forEach(listener => listener()); return next;
  }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.catch(() => {});
    return run;
  }
  private async fetch(): Promise<VoicePreferences> {
    const next = await call<VoicePreferences>('voice_preferences');
    if (!this.savesWaiting) return this.publish(next);
    this.value = next; this.unpublished = true;
    return next;
  }
  load(): Promise<VoicePreferences> { return this.enqueue(() => this.fetch()); }
  /** Sends only the fields that differ from the last known preferences; native merges them into its current copy
   * (`voice_update_preferences`), so a native change (such as the model a download selected) is never overwritten by
   * an older local copy. Listeners re-render from the merged value either way. */
  save(patch: Partial<VoicePreferences>): Promise<VoicePreferences> {
    this.savesWaiting++;
    return this.enqueue(async () => {
      this.savesWaiting--;
      const changed = changedPreferences(this.value, patch);
      if (this.value && !Object.keys(changed).length) return this.unpublished ? this.publish(this.value) : this.value;
      try {
        const saved = await call<VoicePreferences | null>('voice_update_preferences', { patch: changed });
        return saved ? this.publish(saved) : this.fetch();
      } catch (cause) { if (this.value) this.publish(this.value); throw cause; }
    });
  }
}

/** The entries of `patch` that differ from `current` (compared by value, so an equal destination object is unchanged). */
export function changedPreferences(current: VoicePreferences | undefined, patch: Partial<VoicePreferences>): Partial<VoicePreferences> {
  const entries = Object.entries(patch).filter(([key, value]) => value !== undefined
    && (!current || JSON.stringify(current[key as keyof VoicePreferences]) !== JSON.stringify(value)));
  return Object.fromEntries(entries) as Partial<VoicePreferences>;
}

interface LocalState {
  disposed: boolean;
  catalog?: VoiceLocalCatalog; profiles: VoiceProfile[];
  selectedLanguages: string[]; languageQuery: string; modelQuery: string;
  /** The language option that is the list's Tab stop (roving tabindex): a code, or `ALL_LANGUAGES`. */
  languageFocus: string;
  pending: Set<string>; confirmingDelete?: string; test?: ModelTest; errors: Map<string, string>;
}

/** Where adding a speech service starts: the Speech services editor's provider picker. */
const ADD_SERVICE = '.voice-services [data-voice-provider]';

/** The Transcription card: destination, language and the local model browser. */
export class LocalModelsView {
  private state: LocalState = { disposed: false, profiles: [], selectedLanguages: [], languageQuery: '', modelQuery: '', languageFocus: ALL_LANGUAGES, pending: new Set(), errors: new Map() };
  private cleanups: (() => void)[] = [];
  private ignoreConfiguration = false;
  /** Downloads the user cancelled, whose pending download call then rejects quietly. */
  private cancelled = new Set<string>();
  constructor(private host: HTMLElement, private store: VoicePreferencesStore, private onDestination: () => void) {}

  private el<T extends HTMLElement = HTMLElement>(selector: string): T { return this.host.querySelector<T>(selector)!; }
  private model(id: string | undefined): VoiceLocalModel | undefined { return this.state.catalog?.models.find(model => model.id === id); }
  /** The installed, selected model dictation would use; none after its deletion, matching the composer's setup state. */
  private activeModel(): VoiceLocalModel | undefined {
    return usableModel(this.state.catalog?.models ?? [], this.store.value?.selectedModel);
  }
  /** The model order on screen. Kept while the page is open, so Download or Select never moves a card under the
   * pointer; `resort` asks the next visible render to sort again (a filter, search or language change, or a fresh visit). */
  private order: string[] = [];
  private resort = true;
  /** The card that last held focus, so a re-render that removes the focused control keeps focus on that card. */
  private focusedModel?: string;
  private ready?: Promise<void>;

  mount(): () => void {
    const { host } = this;
    host.addEventListener('click', this.click); host.addEventListener('change', this.change);
    host.addEventListener('input', this.input); host.addEventListener('keydown', this.keydown);
    host.addEventListener('focusin', this.focusin); host.addEventListener('pointerdown', this.pointerdown);
    window.addEventListener('voice-configuration-changed', this.configurationChanged);
    this.cleanups.push(this.store.onChange(() => this.render()));
    void subscribe('voice://local-model', event => this.applyEvent(event)).then(stop => { if (this.state.disposed) stop(); else this.cleanups.push(stop); });
    void subscribe('voice://test-ended', event => this.testEnded(event))
      .then(stop => { if (this.state.disposed) stop(); else this.cleanups.push(stop); })
      .catch(() => { /* Without it, a test the window close stopped ends at its own Stop. */ });
    this.ready = this.load();
    return () => this.dispose();
  }
  /** Settings was hidden: a model test never keeps recording or transcribing out of sight (a start still pending is cancelled once it lands). */
  suspend(): void {
    const test = this.state.test;
    // Native cancels a recording, a pending start and an in-flight test transcription alike.
    if (test?.phase === 'recording' || test?.phase === 'transcribing') this.cancelTest();
    if (test) this.state.test = undefined;
    // The next visit starts sorted: sort now, while hidden, so it shows that way even before anything re-renders.
    this.resort = true; this.render();
  }
  private dispose(): void {
    const { host, state } = this;
    this.suspend(); state.disposed = true; this.cleanups.forEach(cleanup => cleanup());
    host.removeEventListener('click', this.click); host.removeEventListener('change', this.change);
    host.removeEventListener('input', this.input); host.removeEventListener('keydown', this.keydown);
    host.removeEventListener('focusin', this.focusin); host.removeEventListener('pointerdown', this.pointerdown);
    window.removeEventListener('voice-configuration-changed', this.configurationChanged);
  }

  private async load(): Promise<void> {
    try {
      const [catalog, configuration] = await Promise.all([call<VoiceLocalCatalog>('voice_local_catalog'), call<VoiceConfiguration>('voice_configuration'), this.store.load()]);
      if (this.state.disposed) return;
      this.state.catalog = catalog; this.state.profiles = configuration.profiles; this.render();
    } catch (cause) { if (!this.state.disposed) this.showMessage(`Could not load local speech models: ${message(cause)}`, true); }
  }
  private async refreshCatalog(): Promise<void> {
    const catalog = await call<VoiceLocalCatalog>('voice_local_catalog');
    if (!this.state.disposed) { this.state.catalog = catalog; this.render(); }
  }
  /** Native changed the selection (a download auto-selects, a delete clears it): re-read both before showing either. */
  private async reloadSelection(): Promise<void> {
    const [catalog] = await Promise.all([call<VoiceLocalCatalog>('voice_local_catalog'), this.store.load()]);
    if (!this.state.disposed) { this.state.catalog = catalog; this.render(); }
  }

  /** Set up dictation: with this device chosen but no usable model, land on an installed model's Select (the catalog
   * default, else a recommended one), or with none downloaded on the recommended model's Download (or the models
   * list); with a speech service chosen that still needs its API key, on that key (`editKey`); on a computer that
   * can't run local models and has no saved speech service, on adding a service; otherwise on the destination, the
   * one choice that turns voice input on. */
  focusSetup(editKey?: (profile: VoiceProfile) => void): void {
    const destination = this.el<HTMLSelectElement>('[data-voice-destination]');
    const reveal = (target: HTMLElement) => { target.scrollIntoView({ block: 'nearest', behavior: 'instant' }); target.focus({ preventScroll: true }); };
    reveal(destination);
    void this.ready?.then(() => {
      const { catalog } = this.state, prefs = this.store.value;
      if (this.state.disposed || !catalog) return;
      if (document.activeElement !== destination && document.activeElement !== document.body) return;
      const keyless = this.keylessProfile(prefs?.destination);
      if (keyless && editKey) { editKey(keyless); return; }
      if (!catalog.platformSupported && !this.state.profiles.length) {
        const add = this.host.closest('.voice-settings')?.querySelector<HTMLElement>(ADD_SERVICE);
        if (add) reveal(add);
        return;
      }
      if (prefs?.destination !== 'local' || !catalog.platformSupported || this.activeModel()) return;
      const installed = catalog.models.filter(item => item.state === 'installed');
      const [model, action] = installed.length
        ? [setupModel(installed, catalog.defaultModel), '[data-voice-model-select]']
        : [setupModel(catalog.models, catalog.defaultModel), '[data-voice-model-download]'];
      const card = model && this.cardFor(model.id);
      reveal(card?.querySelector<HTMLElement>(`${action}:not(:disabled)`) ?? card ?? this.el('[data-voice-model-search]'));
    });
  }
  /** The chosen speech service when it needs an API key it doesn't have (a custom server may run without one). */
  private keylessProfile(destination: VoicePreferences['destination'] | undefined): VoiceProfile | undefined {
    if (typeof destination !== 'object') return undefined;
    const profile = this.state.profiles.find(item => item.id === destination.profileId);
    return profile && profile.provider !== 'custom' && !profile.hasKey ? profile : undefined;
  }
  /** Profile edits elsewhere in Settings change the destination list and may change the destination itself. */
  private configurationChanged = (): void => {
    if (this.ignoreConfiguration || this.state.disposed) return;
    void Promise.all([call<VoiceConfiguration>('voice_configuration'), this.store.load()])
      .then(([configuration]) => { if (!this.state.disposed) { this.state.profiles = configuration.profiles; this.render(); } })
      .catch(cause => this.showMessage(`Could not refresh voice settings: ${message(cause)}`, true));
  };

  private showMessage(text = '', failed = false): void {
    const status = this.el('[data-voice-local-status]'), error = this.el('[data-voice-local-error]');
    status.textContent = failed ? '' : text; status.hidden = failed || !text;
    error.textContent = failed ? text : ''; error.hidden = !failed || !text;
  }

  // ---- Rendering ----
  private render(): void {
    if (this.state.disposed) return;
    this.renderDestination(); this.renderLanguage(); this.renderLanguages(); this.renderModels();
  }
  private renderDestination(): void {
    const prefs = this.store.value, select = this.el<HTMLSelectElement>('[data-voice-destination]');
    if (!prefs) return;
    select.innerHTML = destinationOptionsHtml(this.state.profiles, this.state.catalog?.platformSupported ?? true, prefs.destination);
    select.value = destinationValue(prefs.destination);
  }
  private renderLanguage(): void {
    const prefs = this.store.value, model = this.activeModel();
    if (!prefs) return;
    const select = this.el<HTMLSelectElement>('[data-voice-language-select]');
    select.innerHTML = languageOptionsHtml(model, prefs.language); select.value = prefs.language;
    select.disabled = !model;
    this.el('[data-voice-language-row]').hidden = prefs.destination !== 'local';
    this.el('#voice-language-pick-description').textContent = languageNote(model, prefs.language);
  }
  private renderLanguages(): void {
    const codes = catalogLanguages(this.state.catalog?.models ?? []);
    const { selectedLanguages, languageQuery, languageFocus } = this.state;
    morph(this.el('[data-voice-languages]'), languagesHtml(codes, selectedLanguages, languageQuery, languageFocus), 3);
    this.el('[data-voice-models-title]').textContent = browserTitle(this.state.selectedLanguages);
  }
  private renderModels(): void {
    const { catalog, selectedLanguages, modelQuery, pending, confirmingDelete, test, errors } = this.state;
    const list = this.el('[data-voice-models]');
    if (!catalog) { list.innerHTML = '<p class="voice-browser-empty" role="listitem">Loading models…</p>'; return; }
    const models = this.ordered(filterModels(catalog.models, selectedLanguages, modelQuery), catalog.defaultModel);
    const view = { selectedLanguages, pending, confirmingDelete, test, errors, unsupported: !catalog.platformSupported, busyWith: this.busyWith() };
    const reason = catalog.unsupportedReason?.trim();
    const notice = catalog.platformSupported ? ''
      : `<div role="listitem"><p class="voice-browser-empty" role="note">Local speech models are not supported on this computer.${reason ? ` ${escape(reason)}` : ''}</p></div>`;
    // Everything in the role=list is a listitem, the empty state included.
    const empty = `<p class="voice-browser-empty" role="listitem">${escape(emptyModelsText(selectedLanguages, modelQuery))}</p>`;
    morph(list, notice + (models.map(model => modelCardHtml(model, view)).join('') || empty), 6);
    this.keepCardFocus();
    this.announceTest();
  }
  /** `models` in the order on screen: sorted afresh while `resort` is set (it stays set while the page is hidden, so
   * the first visible render settles the order), otherwise the kept order, with any model not shown before placed by
   * the sort after the kept ones. */
  private ordered(models: readonly VoiceLocalModel[], defaultModel: string | null | undefined): VoiceLocalModel[] {
    const sorted = sortModels(models, defaultModel);
    if (this.resort) {
      if (this.host.getClientRects().length) this.resort = false;
      this.order = sorted.map(model => model.id);
      return sorted;
    }
    const rank = new Map(this.order.map((id, index) => [id, index]));
    const at = (model: VoiceLocalModel) => rank.get(model.id) ?? this.order.length + sorted.indexOf(model);
    return [...sorted].sort((a, b) => at(a) - at(b));
  }
  /** Writes a model test's start and result into the card's persistent live region, once per change. */
  private announceTest(): void {
    const { test, catalog } = this.state;
    const name = catalog?.models.find(model => model.id === test?.modelId)?.name ?? '';
    const text = modelTestAnnouncement(test, name), region = this.host.querySelector('[data-voice-model-announcer]');
    if (region && region.textContent !== text) region.textContent = text;
  }
  /** Native allows one download at a time: the model downloading or verifying now, by name. */
  private busyWith(): string | undefined {
    const models = this.state.catalog?.models ?? [];
    const busy = models.find(model => model.state === 'downloading' || model.state === 'verifying')
      ?? models.find(model => this.state.pending.has(`download:${model.id}`) && model.state !== 'installed');
    return busy?.name;
  }
  private cardFor(modelId: string): HTMLElement | null {
    return this.el('[data-voice-models]').querySelector<HTMLElement>(`[data-model-id="${CSS.escape(modelId)}"]`);
  }
  private focusCard(modelId: string, selector: string): void {
    this.cardFor(modelId)?.querySelector<HTMLElement>(`${selector}:not(:disabled)`)?.focus({ preventScroll: true });
  }
  /** A render removed the focused control (Cancel when verifying starts) or re-sorted the cards: focus goes to the
   * same card's current action, or the card itself while it is downloading or verifying. */
  private keepCardFocus(): void {
    const modelId = this.focusedModel, active = document.activeElement;
    // The card itself stays focused in WebKit after it stops being focusable (verifying ended): move on to its action.
    const staleCard = active?.matches('.voice-model-card:not([tabindex])');
    if (!modelId || (!staleCard && active && active !== document.body && active.closest('.voice-model-card')?.getAttribute('data-model-id') === modelId)) return;
    if (active && active !== document.body && !this.el('[data-voice-models]').contains(active)) return;
    const card = this.cardFor(modelId);
    if (!card) return;
    const action = card.querySelector<HTMLElement>(
      '[data-voice-model-cancel]:not(:disabled),[data-voice-model-select]:not(:disabled),.voice-model-selected,[data-voice-model-download]:not(:disabled),[data-voice-model-keep]:not(:disabled)');
    const target = action ?? (card.hasAttribute('tabindex') ? card : null);
    target?.focus({ preventScroll: true });
  }

  // ---- Catalog updates ----
  private updateModel(id: string, patch: Partial<VoiceLocalModel>): void {
    const catalog = this.state.catalog;
    if (!catalog) return;
    this.state.catalog = { ...catalog, models: catalog.models.map(model => model.id === id ? { ...model, ...patch } : model) };
  }
  private applyEvent(event: VoiceLocalModelEvent): void {
    if (this.state.disposed) return;
    const focusedCancel = document.activeElement?.matches(`[data-voice-model-cancel="${CSS.escape(event.modelId)}"]`);
    this.updateModel(event.modelId, { state: event.state, downloaded: event.downloaded, size: event.size || this.model(event.modelId)?.size });
    if (event.error) this.state.errors.set(event.modelId, event.error);
    this.render();
    if (event.state === 'installed') {
      this.showMessage(`${this.model(event.modelId)?.name ?? 'Model'} downloaded.`);
      void this.reloadSelection().catch(cause => { this.state.errors.set(event.modelId, `Downloaded, but couldn’t refresh voice settings: ${message(cause)}`); this.render(); });
    }
    if (focusedCancel && event.state === 'downloadable') this.focusCard(event.modelId, '[data-voice-model-download]');
  }

  // ---- Actions ----
  private async run(key: string, modelId: string, action: () => Promise<void>): Promise<void> {
    const { state } = this;
    if (state.pending.has(key)) return;
    state.pending.add(key); state.errors.delete(modelId); this.showMessage(); this.render();
    try { await action(); } catch (cause) { if (!state.disposed) state.errors.set(modelId, message(cause)); }
    finally { state.pending.delete(key); this.render(); }
  }
  /** Native resolves once the model is installed; progress arrives as `voice://local-model` events meanwhile. */
  private download(modelId: string): Promise<void> {
    return this.run(`download:${modelId}`, modelId, async () => {
      this.cancelled.delete(modelId);
      this.updateModel(modelId, { state: 'downloading', downloaded: this.model(modelId)?.downloaded ?? 0 }); this.render();
      this.focusCard(modelId, '[data-voice-model-cancel]');
      try { await call('voice_local_download', { modelId }); } catch (cause) {
        if (this.model(modelId)?.state !== 'installed') this.updateModel(modelId, { state: 'downloadable' });
        if (!this.cancelled.delete(modelId)) throw cause;
        return;
      }
      // Resolves once installed and, for a first download, selected: show native's selection, not a stale copy.
      await this.reloadSelection();
      if (this.model(modelId)?.active) this.showMessage(`${this.model(modelId)?.name ?? 'Model'} downloaded and selected.`);
    });
  }
  /** A cancel can land just after the download finished: native then has nothing to cancel, so the refreshed
   * catalog decides what to announce and where focus goes. */
  private cancelDownload(modelId: string): Promise<void> {
    let installed = false;
    return this.run(`cancel:${modelId}`, modelId, async () => {
      this.cancelled.add(modelId);
      await call('voice_local_cancel_download', { modelId });
      const catalog = await call<VoiceLocalCatalog>('voice_local_catalog').catch(() => undefined);
      if (this.state.disposed) return;
      installed = catalog?.models.find(model => model.id === modelId)?.state === 'installed' || this.model(modelId)?.state === 'installed';
      if (installed) {
        this.cancelled.delete(modelId);
        if (catalog) this.state.catalog = catalog;
        this.showMessage(`${this.model(modelId)?.name ?? 'Model'} downloaded.`);
        return;
      }
      this.updateModel(modelId, { state: 'downloadable' });
      this.showMessage('Download cancelled.');
    }).then(() => this.focusCard(modelId, installed ? ':is([data-voice-model-select],[data-voice-model-test])' : '[data-voice-model-download]'));
  }
  private select(modelId: string): Promise<void> {
    return this.run(`select:${modelId}`, modelId, async () => {
      await call('voice_local_select', { modelId });
      const catalog = this.state.catalog!;
      this.state.catalog = { ...catalog, models: catalog.models.map(model => ({ ...model, active: model.id === modelId })) };
      await this.store.load();
      this.showMessage(`${this.model(modelId)?.name ?? 'Model'} selected.`);
    }).then(() => this.focusCard(modelId, '[data-voice-model-test]'));
  }
  private confirmDelete(modelId: string | undefined): void {
    const previous = this.state.confirmingDelete;
    this.state.confirmingDelete = modelId; this.render();
    if (modelId) this.focusCard(modelId, '[data-voice-model-keep]');
    else if (previous) this.focusCard(previous, '[data-voice-model-delete]');
  }
  private remove(modelId: string): Promise<void> {
    // Native refuses to delete a model under test, so its Delete stays disabled until the test is stopped and
    // transcribed; a confirm that arrives anyway leaves the test running rather than racing a cancel.
    const test = this.state.test;
    if (test?.modelId === modelId && (test.phase === 'recording' || test.phase === 'transcribing')) return Promise.resolve();
    return this.run(`delete:${modelId}`, modelId, async () => {
      await call('voice_local_delete', { modelId });
      this.state.confirmingDelete = undefined;
      if (this.state.test?.modelId === modelId) this.state.test = undefined;
      this.updateModel(modelId, { state: 'downloadable', downloaded: 0, active: false });
      this.showMessage(`${this.model(modelId)?.name ?? 'Model'} deleted.`);
      // Deleting the selected model clears native's selection: Language and the composer's setup state follow it.
      // The delete already happened: a failed refresh is shown on this model's card, not as a failed delete.
      await this.reloadSelection().catch(cause => { this.state.errors.set(modelId, `Deleted, but couldn’t refresh voice settings: ${message(cause)}`); });
    }).then(() => this.focusCard(modelId, '[data-voice-model-download]'));
  }

  /** The model test start still awaiting native; `cancelled` once Stop or leaving Settings gave it up. */
  private testStart?: { modelId: string; cancelled: boolean };
  private async startTest(modelId: string): Promise<void> {
    const { state } = this;
    if (state.test && state.test.phase !== 'done' && state.test.phase !== 'error') return;
    if (this.testStart) return;
    state.test = { modelId, phase: 'recording' }; state.errors.delete(modelId); this.render();
    this.focusCard(modelId, '[data-voice-model-test-stop]');
    const start = { modelId, cancelled: false };
    this.testStart = start;
    try {
      await testModel({ action: 'start', modelId });
      // Given up while native was still starting and the start won the race: stop the recording it just began.
      if (start.cancelled) void testModel({ action: 'cancel' }).catch(() => {});
    } catch (cause) {
      // Native ends a pending start with VOICE_CANCELLED (our Cancel, or a newer start): that is idle, not a failure.
      if (start.cancelled) return;
      if (message(cause) === VOICE_CANCELLED) this.idleTest(modelId); else this.failTest(modelId, cause);
    } finally { if (this.testStart === start) this.testStart = undefined; }
  }
  /** Cancels the model test: native aborts a pending start too (it then rejects with VOICE_CANCELLED). */
  private cancelTest(): void {
    if (this.testStart) this.testStart.cancelled = true;
    void testModel({ action: 'cancel' }).catch(() => {});
  }
  /** Back to idle for `modelId` (nothing recorded), keeping focus on the card's Test button. */
  private idleTest(modelId: string): void {
    if (this.state.disposed || this.state.test?.modelId !== modelId) return;
    this.state.test = undefined; this.render();
    this.focusCard(modelId, '[data-voice-model-test]');
  }
  private async stopTest(modelId: string): Promise<void> {
    const { state } = this;
    if (state.test?.modelId !== modelId || state.test.phase !== 'recording') return;
    if (this.testStart) {
      // Native hasn't started yet: nothing to transcribe, so cancel the pending start and go back to idle.
      this.cancelTest(); this.idleTest(modelId);
      return;
    }
    state.test = { modelId, phase: 'transcribing' }; this.render();
    try {
      const result = await testModel<VoiceLocalTestResult>({ action: 'stop' });
      if (state.disposed || state.test?.modelId !== modelId) return;
      // The Stop ended a start that was still pending in native: nothing was recorded, so back to idle.
      if (result?.cancelled) { this.idleTest(modelId); return; }
      state.test = { modelId, phase: 'done', text: result?.text ?? '' }; this.render();
      this.focusCard(modelId, '[data-voice-model-test]');
    } catch (cause) {
      // Cancelled (Settings closed, or the model was deleted): this test is over, not failed.
      if (state.test?.modelId !== modelId || state.test.phase !== 'transcribing') return;
      if (message(cause) === VOICE_CANCELLED) this.idleTest(modelId); else this.failTest(modelId, cause);
    }
  }
  /** Native stopped the model test itself (closing the window): idle without an error; a start still pending is given up. */
  private testEnded(event: VoiceTestEnded): void {
    const test = this.state.test;
    if (this.state.disposed || event?.kind !== 'model' || !test || (test.phase !== 'recording' && test.phase !== 'transcribing')) return;
    if (this.testStart) this.testStart.cancelled = true;
    this.state.errors.delete(test.modelId);
    this.idleTest(test.modelId);
  }
  private failTest(modelId: string, cause: unknown): void {
    if (this.state.disposed) return;
    this.state.test = { modelId, phase: 'error' }; this.state.errors.set(modelId, `Test failed: ${message(cause)}`); this.render();
    this.focusCard(modelId, '[data-voice-model-test]');
  }

  // ---- Preferences ----
  private async savePreference(patch: Partial<VoicePreferences>, done: string): Promise<void> {
    try {
      await this.store.save(patch); this.showMessage(done);
      if ('destination' in patch) this.announceDestination();
    } catch (cause) { if (!this.state.disposed) this.showMessage(`Could not save voice settings: ${message(cause)}`, true); }
  }
  /** Lets dictation and the speech services list follow a destination change without reloading this card. */
  private announceDestination(): void {
    this.ignoreConfiguration = true;
    try { window.dispatchEvent(new Event('voice-configuration-changed')); } finally { this.ignoreConfiguration = false; }
    this.onDestination();
  }
  private destinationMessage(value: string): string {
    if (value === 'off') return 'Voice input is off on this device.';
    if (value === 'local') return 'Audio is transcribed on this device.';
    const profile = this.state.profiles.find(item => `profile:${item.id}` === value);
    return `Audio is sent to ${profile?.name ?? 'the speech service'}.`;
  }

  // ---- Events ----
  private change = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.matches('[data-voice-destination]')) void this.savePreference({ destination: parseDestination(target.value) }, this.destinationMessage(target.value));
    else if (target.matches('[data-voice-language-select]')) void this.savePreference({ language: target.value }, 'Language saved.');
  };
  private input = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-voice-language-search]')) { this.state.languageQuery = target.value; this.renderLanguages(); }
    else if (target.matches('[data-voice-model-search]')) { this.state.modelQuery = target.value; this.resort = true; this.renderModels(); }
  };
  private toggleLanguage(code: string | undefined): void {
    const { selectedLanguages } = this.state;
    this.state.selectedLanguages = code === undefined ? [] : selectedLanguages.includes(code)
      ? selectedLanguages.filter(item => item !== code) : [...selectedLanguages, code];
    this.resort = true;
    this.renderLanguages(); this.renderModels();
  }
  private click = (event: MouseEvent): void => {
    const option = this.languageOption(event.target);
    if (option) { this.chooseLanguage(option); return; }
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target || target.disabled || !this.host.contains(target)) return;
    if (target.getAttribute('aria-disabled') === 'true') { this.explainWait(target); return; }
    const data = target.dataset;
    if (data.voiceModelDownload) void this.download(data.voiceModelDownload);
    else if (data.voiceModelCancel) void this.cancelDownload(data.voiceModelCancel);
    else if (data.voiceModelSelect) void this.select(data.voiceModelSelect);
    else if (data.voiceModelDelete) this.confirmDelete(data.voiceModelDelete);
    else if (data.voiceModelKeep) this.confirmDelete(undefined);
    else if (data.voiceModelConfirmDelete) void this.remove(data.voiceModelConfirmDelete);
    else if (data.voiceModelTest) void this.startTest(data.voiceModelTest);
    else if (data.voiceModelTestStop) void this.stopTest(data.voiceModelTestStop);
  };
  /** A waiting Download (Enter or a click) says why in the status line, as its description does for screen readers. */
  private explainWait(target: HTMLButtonElement): void {
    const busy = this.busyWith();
    if (target.dataset.voiceModelDownload && busy) this.showMessage(waitReason(busy));
  }
  private focusin = (event: FocusEvent): void => {
    this.focusedModel = (event.target as Element).closest('.voice-model-card')?.getAttribute('data-model-id') ?? undefined;
  };
  /** A click elsewhere means focus left the card on purpose, even when it lands on <body>. */
  private pointerdown = (event: PointerEvent): void => {
    if (!(event.target as Element).closest('.voice-model-card')) this.focusedModel = undefined;
  };
  // ---- Language list (one Tab stop; arrows, Home/End and type-ahead move, Space/Enter toggle) ----
  private languageOption(target: EventTarget | null): HTMLElement | null {
    const option = target instanceof Element ? target.closest<HTMLElement>('[data-voice-languages] [role="option"]') : null;
    return option && this.host.contains(option) ? option : null;
  }
  private languageKey(option: HTMLElement): string { return option.dataset.voiceLanguage ?? ALL_LANGUAGES; }
  private chooseLanguage(option: HTMLElement): void {
    const key = this.languageKey(option);
    this.state.languageFocus = key;
    this.toggleLanguage(key === ALL_LANGUAGES ? undefined : key);
    this.focusLanguage(key);
    this.revealModelsTitle();
  }
  /** A shorter model list can leave the Models header above the page's visible area (the panes sit side by side);
   * bring it back. Each pane fits the window, so the chosen language stays on screen. */
  private revealModelsTitle(): void {
    const title = this.el('[data-voice-models-title]');
    const top = title.closest('.settings-content')?.getBoundingClientRect().top ?? 0;
    if (title.getBoundingClientRect().top < top) title.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  /** Moves the Tab stop to `key` and focuses it, scrolling only within the list. */
  private focusLanguage(key: string): void {
    this.state.languageFocus = key;
    const options = [...this.el('[data-voice-languages]').querySelectorAll<HTMLElement>('[role="option"]')];
    const target = options.find(option => this.languageKey(option) === key);
    if (!target) return;
    options.forEach(option => { option.tabIndex = option === target ? 0 : -1; });
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    target.focus({ preventScroll: true });
  }
  private typeahead = { text: '', at: 0 };
  /** The option after `from` (wrapping) whose name starts with the typed text; the same letter repeated cycles. */
  private matchLanguage(options: HTMLElement[], from: number, char: string): HTMLElement | undefined {
    const now = Date.now(), ahead = this.typeahead;
    ahead.text = now - ahead.at < TYPEAHEAD_MS && ahead.text !== char ? ahead.text + char : char; ahead.at = now;
    const needle = ahead.text.toLocaleLowerCase(), start = ahead.text.length > 1 ? from : from + 1;
    const ordered = [...options.slice(start), ...options.slice(0, start)];
    return ordered.find(option => option.textContent?.trim().toLocaleLowerCase().startsWith(needle));
  }
  /** Rows PageUp/PageDown move: about one visible page of the list (it is uncapped in a short window, so the window
   * bounds it too), at most LANGUAGE_PAGE_MAX and at least one. Read only on the key press. */
  private languagePage(option: HTMLElement): number {
    const list = this.el('[data-voice-languages]'), row = option.getBoundingClientRect().height;
    if (!row) return LANGUAGE_PAGE_MAX;
    const visible = Math.min(list.clientHeight, window.innerHeight);
    return Math.max(1, Math.min(LANGUAGE_PAGE_MAX, Math.floor(visible / row) - 1));
  }
  private languageKeydown(event: KeyboardEvent, option: HTMLElement): void {
    const options = [...this.el('[data-voice-languages]').querySelectorAll<HTMLElement>('[role="option"]')];
    const index = options.indexOf(option);
    let next: HTMLElement | undefined;
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.chooseLanguage(option); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown') next = options[Math.min(options.length - 1, index + 1)];
    else if (event.key === 'ArrowUp' && index === 0) { event.preventDefault(); this.el('[data-voice-language-search]').focus(); return; }
    else if (event.key === 'ArrowUp') next = options[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = options[0];
    else if (event.key === 'End') next = options[options.length - 1];
    else if (event.key === 'PageDown') next = options[Math.min(options.length - 1, index + this.languagePage(option))];
    else if (event.key === 'PageUp') next = options[Math.max(0, index - this.languagePage(option))];
    else if (event.key.length === 1 && event.key.trim()) next = this.matchLanguage(options, index, event.key);
    else return;
    event.preventDefault();
    if (next) this.focusLanguage(this.languageKey(next));
  }

  // ---- Arrows between each search and its list ----
  /** The first card's action that ArrowDown from Search models lands on: its primary action, else its first one. */
  private firstModelAction(): HTMLElement | null {
    const card = this.el('[data-voice-models]').querySelector<HTMLElement>('.voice-model-card');
    if (!card) return null;
    return card.querySelector<HTMLElement>('.voice-model-actions .ds-btn-primary:not(:disabled)')
      ?? card.querySelector<HTMLElement>('.voice-model-actions button:not(:disabled)') ?? (card.hasAttribute('tabindex') ? card : null);
  }
  /** ArrowDown from a search enters its list (the first matching language, or the first card's action); ArrowUp from
   * the first card's actions returns to Search models. Returns whether the key was handled. */
  private searchArrow(event: KeyboardEvent, target: HTMLElement): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    let next: HTMLElement | null | undefined;
    if (event.key === 'ArrowDown' && target.matches('[data-voice-language-search]')) {
      const options = [...this.el('[data-voice-languages]').querySelectorAll<HTMLElement>('[role="option"]')];
      next = (this.state.languageQuery.trim() && options[1]) || options[0];
      if (next) { event.preventDefault(); this.focusLanguage(this.languageKey(next)); return true; }
      return false;
    }
    if (event.key === 'ArrowDown' && target.matches('[data-voice-model-search]')) next = this.firstModelAction();
    else if (event.key === 'ArrowUp' && target.closest('.voice-model-actions')
      && target.closest('.voice-model-card') === this.el('[data-voice-models]').querySelector('.voice-model-card')) {
      next = this.el('[data-voice-model-search]');
    }
    if (!next) return false;
    event.preventDefault(); next.scrollIntoView({ block: 'nearest', behavior: 'instant' }); next.focus({ preventScroll: true });
    return true;
  }

  /** Escape clears a search, then backs out of a delete confirmation, before Settings sees it. */
  private keydown = (event: KeyboardEvent): void => {
    if (isImeKey(event)) return;
    const option = this.languageOption(event.target);
    if (option && event.key !== 'Escape') { this.languageKeydown(event, option); return; }
    if (this.searchArrow(event, event.target as HTMLElement)) return;
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === 'search' && target.value) {
      event.preventDefault(); event.stopPropagation(); target.value = ''; target.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (this.state.confirmingDelete && target.closest('.voice-model-card')?.getAttribute('data-model-id') === this.state.confirmingDelete) {
      event.preventDefault(); event.stopPropagation(); this.confirmDelete(undefined);
    }
  };
}
