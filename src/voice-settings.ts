import './voice-settings.css';
import { call } from './bridge';
import { isImeKey, morph } from './dom';
import { openChoiceMenu } from './choice-menu';
import { VOICE_PRESETS, type VoiceConfiguration, type VoiceProfile, type VoiceProfileInput, type VoiceProvider } from './voice-types';
import {
  clearValidation, destinationText, keyHintText, markInvalid, presetFor, showFailure, showMessage, showModelChoice, validateEditor,
  voiceInputCardHtml, voiceSettingsElements, voiceSettingsHtml, voiceTranscriptionCardHtml, type VoiceSettingsElements,
} from './voice-settings-form';
import { profilesHtml, readinessText, selectedProfile } from './voice-settings-profiles';
import { LocalModelsView, VoicePreferencesStore } from './voice-local-settings';
import { MicSettingsView } from './voice-mic-settings';

/** Editor and request bookkeeping; versions let late native replies notice that the editor or selection moved on. */
interface VoiceSettingsState {
  disposed: boolean; loading: boolean; saving: boolean; removingKey: boolean;
  configuration?: VoiceConfiguration; editingId?: string; confirmingId?: string;
  provider: VoiceProvider; model: string; keyDestination: string;
  revision: number; editorVersion: number; selectionVersion: number;
  mutations: Promise<unknown>; pending: Set<string>; closeMenu?: () => void;
}

const SERVICES = '<section class="voice-services" aria-labelledby="voice-services-title"><h3 class="voice-card-title" id="voice-services-title">Speech services</h3>'
  + '<p class="voice-services-note">Send audio to a speech service such as OpenAI, Groq, Mistral or your own server instead of a model on this device. Choose a saved service under Send microphone audio to, or Use it here.</p>'
  + '<div data-voice-profiles-host></div></section>';

const SETUP_EVENT = 'voice-focus-setup';
/** Set up dictation: focus the missing step in a mounted Settings → Voice (see `LocalModelsView.focusSetup`). */
export function focusVoiceSetup(host: HTMLElement): void { host.dispatchEvent(new Event(SETUP_EVENT)); }

/** Input, Transcription (local models) and Speech services. Speech credentials stay in native storage; the editor only receives hasKey. */
export function mountVoiceSettings(host: HTMLElement): () => void {
  host.classList.add('voice-settings');
  host.innerHTML = `<div class="voice-cards">${voiceInputCardHtml()}${voiceTranscriptionCardHtml()}${SERVICES}</div>`;
  const profilesHost = host.querySelector<HTMLElement>('[data-voice-profiles-host]')!;
  profilesHost.innerHTML = voiceSettingsHtml();
  const store = new VoicePreferencesStore();
  const view = new VoiceSettingsView(voiceSettingsElements(profilesHost), () => store.value?.destination === 'local');
  const mic = new MicSettingsView(host.querySelector<HTMLElement>('#voice-input-title')!.parentElement!, store);
  const local = new LocalModelsView(host.querySelector<HTMLElement>('#voice-transcription-title')!.parentElement!, store, () => view.reload());
  const focusSetup = () => local.focusSetup(profile => view.editKey(profile));
  host.addEventListener(SETUP_EVENT, focusSetup);
  const cleanups = [view.mount(), mic.mount(), local.mount(), store.onChange(() => view.refresh()), () => host.removeEventListener(SETUP_EVENT, focusSetup)];
  const panel = host.closest<HTMLElement>('[role=tabpanel]');
  const observer = new MutationObserver(() => { if (panel?.hidden) { mic.suspend(); local.suspend(); } });
  if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  return () => { observer.disconnect(); cleanups.forEach(cleanup => cleanup()); };
}

class VoiceSettingsView {
  private ui: VoiceSettingsElements;
  private state: VoiceSettingsState = {
    disposed: false, loading: false, saving: false, removingKey: false,
    provider: VOICE_PRESETS[0].provider, model: VOICE_PRESETS[0].models[0], keyDestination: '',
    revision: 0, editorVersion: 0, selectionVersion: 0, mutations: Promise.resolve(), pending: new Set(),
  };
  constructor(ui: VoiceSettingsElements, private localInUse: () => boolean = () => false) { this.ui = ui; }

  /** The destination changed elsewhere in Voice settings: reload the selected profile. */
  reload(): void { void this.load(); }
  refresh(): void { if (!this.state.disposed) this.renderProfiles(); }
  /** Set up dictation for a service that needs its API key: open it in the editor (unless already there) and land on the key. */
  editKey(profile: VoiceProfile): void {
    if (this.state.disposed) return;
    if (this.state.editingId !== profile.id) this.edit(this.state.configuration?.profiles.find(item => item.id === profile.id) ?? profile, false);
    const key = this.ui.field('key');
    key.scrollIntoView({ block: 'center', behavior: 'instant' });
    key.focus({ preventScroll: true });
  }

  mount(): () => void {
    const { host, form } = this.ui;
    const panel = host.closest<HTMLElement>('[role=tabpanel]');
    const observer = new MutationObserver(() => { if (panel?.hidden) { this.state.selectionVersion++; this.state.closeMenu?.(); } });
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    host.addEventListener('click', this.click); host.addEventListener('keydown', this.keydown);
    form.addEventListener('input', this.input); form.addEventListener('submit', this.submit);
    this.edit(undefined, false); this.renderProfiles(); void this.load();
    return () => {
      this.state.disposed = true; observer.disconnect(); this.state.closeMenu?.(); this.ui.field('key').value = '';
      host.removeEventListener('click', this.click); host.removeEventListener('keydown', this.keydown);
      form.removeEventListener('input', this.input); form.removeEventListener('submit', this.submit);
    };
  }

  private savedProfile() { return this.state.configuration?.profiles.find(profile => profile.id === this.state.editingId); }
  private hidden() { return Boolean(this.ui.host.closest('[hidden]')); }

  private publish(next: VoiceConfiguration | undefined): void {
    if (!next) return;
    this.state.configuration = next;
    window.dispatchEvent(new Event('voice-configuration-changed'));
    if (!this.state.disposed) this.renderProfiles();
  }
  /** Serializes native mutations so late responses cannot restore an older selection or deleted profile. */
  private mutate(command: string, args: Record<string, unknown>, when?: () => boolean): Promise<VoiceConfiguration | undefined> {
    const result = this.state.mutations.then(() => !when || when() ? call<VoiceConfiguration>(command, args) : undefined);
    this.state.mutations = result.then(() => {}, () => {});
    return result;
  }

  private renderProfiles(): void {
    const { configuration, pending, loading, confirmingId, saving } = this.state, { button } = this.ui;
    this.ui.readiness.textContent = readinessText(configuration, loading, this.localInUse());
    button('off').hidden = !selectedProfile(configuration);
    button('off').disabled = pending.has('select:off');
    morph(this.ui.list, profilesHtml(configuration, confirmingId, pending), 5);
    button('save').disabled = button('save-use').disabled = !configuration || saving;
  }
  private editorHints(): void {
    const { field, button } = this.ui, { removingKey, provider } = this.state;
    const hasKey = this.savedProfile()?.hasKey ?? false, endpoint = field('endpoint').value.trim();
    const changedDestination = hasKey && this.savedProfile()?.endpoint !== endpoint;
    this.ui.keyHint.textContent = keyHintText({ removingKey, typedKey: Boolean(field('key').value), changedDestination, hasKey, custom: provider === 'custom' });
    button('remove-key').hidden = !hasKey;
    button('remove-key').textContent = removingKey ? 'Keep saved key' : 'Remove saved key';
    this.ui.destination.textContent = destinationText(endpoint, provider === 'custom');
  }
  private modelChoice(value: string, isCustom = !presetFor(this.state.provider).models.includes(value)): void {
    this.state.model = value; showModelChoice(this.ui, value, isCustom);
  }
  private edit(profile?: VoiceProfile, focus = true): void {
    const { state, ui } = this, { field } = ui;
    state.closeMenu?.(); state.revision++; state.editorVersion++; state.removingKey = false; state.editingId = profile?.id;
    clearValidation(ui);
    state.provider = profile?.provider ?? VOICE_PRESETS[0].provider;
    const preset = presetFor(state.provider);
    ui.heading.textContent = profile ? `Edit ${profile.name}` : 'New speech profile';
    field('name').value = profile?.name ?? preset.name;
    field('endpoint').value = profile?.endpoint ?? preset.endpoint;
    field('language').value = profile?.language ?? ''; field('key').value = '';
    ui.advanced.open = state.provider === 'custom' || field('endpoint').value !== preset.endpoint || Boolean(profile?.language);
    ui.button('provider').querySelector('span')!.textContent = preset.name;
    this.modelChoice(profile?.model ?? preset.models[0]); this.editorHints(); showMessage(ui);
    if (focus) field('name').focus();
  }

  private async load(): Promise<void> {
    const { state, ui } = this;
    if (state.loading || state.disposed) return;
    state.loading = true; ui.button('retry').disabled = true; this.renderProfiles();
    try {
      const next = await call<VoiceConfiguration>('voice_configuration');
      if (state.disposed) return;
      state.configuration = next; this.renderProfiles(); this.editorHints(); showMessage(ui); ui.button('retry').hidden = true;
    } catch (cause) {
      if (state.disposed) return;
      ui.readiness.textContent = 'Voice input unavailable'; showFailure(ui, cause, 'Could not load speech profiles'); ui.button('retry').hidden = false;
    } finally { state.loading = false; if (!state.disposed) ui.button('retry').disabled = false; }
  }
  private async select(profileId: string | null): Promise<void> {
    const { state, ui } = this, action = `select:${profileId ?? 'off'}`;
    if (state.disposed || state.pending.has(action)) return;
    state.pending.add(action); this.renderProfiles(); showMessage(ui);
    state.selectionVersion++;
    try {
      this.publish(await this.mutate('voice_select_profile', { profileId }));
      if (!state.disposed) showMessage(ui, profileId ? 'Speech profile is in use.' : 'Voice input turned off. Saved profiles are kept.');
    } catch (cause) {
      if (!state.disposed) showFailure(ui, cause, profileId ? 'Could not use speech profile' : 'Could not turn off voice input');
    } finally { state.pending.delete(action); if (!state.disposed) this.renderProfiles(); }
  }

  /** The editor as a native save request, or undefined after reporting what is invalid. */
  private profileInput(): VoiceProfileInput | undefined {
    const { ui, state } = this, { field } = ui;
    clearValidation(ui);
    const invalidField = validateEditor(ui);
    if (invalidField) { markInvalid(ui, invalidField, invalidField.validationMessage); ui.form.reportValidity(); return undefined; }
    const input: VoiceProfileInput = {
      ...(state.editingId ? { id: state.editingId } : {}), name: field('name').value.trim(), provider: state.provider,
      endpoint: field('endpoint').value.trim(), model: ui.custom.hidden ? state.model : field('model').value.trim(),
      language: field('language').value.trim() || null,
    };
    if (!input.name || !input.model) { showMessage(ui, 'Enter a profile name and speech model ID before saving.', true); return undefined; }
    const key = field('key').value;
    return key || state.removingKey ? { ...input, key: state.removingKey ? '' : key } : input;
  }
  /** Points the editor at the saved profile, keeping anything typed while the save was in flight. */
  private adoptSaved(saved: VoiceProfile, revision: number, key: string): void {
    if (this.state.revision === revision) { this.edit(saved, false); return; }
    this.state.editingId = saved.id; this.ui.heading.textContent = `Edit ${saved.name}`;
    if (this.ui.field('key').value === key) this.ui.field('key').value = '';
  }
  private async useSaved(saved: VoiceProfile | undefined, selection: number): Promise<boolean> {
    if (!saved) throw new Error('Profile was saved. Choose Use beside the saved profile.');
    const editor = this.state.editorVersion;
    const current = () => !this.state.disposed && editor === this.state.editorVersion && selection === this.state.selectionVersion && !this.hidden();
    const selected = await this.mutate('voice_select_profile', { profileId: saved.id }, current);
    this.publish(selected);
    return Boolean(selected);
  }
  private async save(use: boolean): Promise<void> {
    const { state, ui } = this;
    if (state.disposed || state.saving || !state.configuration) return;
    const input = this.profileInput(); if (!input) return;
    const key = ui.field('key').value, before = new Set(state.configuration.profiles.map(profile => profile.id));
    const revision = state.revision, editor = state.editorVersion, selection = use ? ++state.selectionVersion : state.selectionVersion;
    state.saving = true; this.renderProfiles(); ui.button(use ? 'save-use' : 'save').textContent = 'Saving…'; showMessage(ui);
    let saved: VoiceProfile | undefined;
    try {
      const next = await this.mutate('voice_save_profile', { input });
      if (!next) return;
      saved = next.profiles.find(profile => input.id ? profile.id === input.id : !before.has(profile.id));
      this.publish(next);
      const sameEditor = editor === state.editorVersion;
      if (!state.disposed && sameEditor && saved) this.adoptSaved(saved, revision, key);
      let used = use && sameEditor && !state.disposed && selection === state.selectionVersion && !this.hidden();
      if (used) used = await this.useSaved(saved, selection);
      if (!state.disposed) showMessage(ui, used ? 'Saved. Speech profile is in use.' : 'Speech profile saved. Choose Use when you want to dictate.');
    } catch (cause) {
      if (!state.disposed) showFailure(ui, cause, saved ? 'Profile saved, but could not switch to it' : 'Could not save speech profile', key);
    } finally {
      state.saving = false;
      if (!state.disposed) {
        ui.button('save').textContent = 'Save profile'; ui.button('save-use').textContent = 'Save and use profile';
        this.renderProfiles(); this.editorHints();
      }
    }
  }

  /** Keeps unsaved edits even when their saved profile is removed. */
  private forgetEdited(profileId: string): void {
    const { state } = this;
    if (state.editingId !== profileId) return;
    state.editingId = undefined; state.editorVersion++; state.removingKey = false;
    this.ui.heading.textContent = 'New speech profile'; this.editorHints();
  }
  private refocusAfterDelete(profileId: string, focused: Element | null): void {
    if ((document.activeElement !== focused && document.activeElement !== document.body) || this.hidden()) return;
    const { list, button } = this.ui;
    const target = list.querySelector<HTMLButtonElement>(`[data-voice-keep="${CSS.escape(profileId)}"]`)
      ?? list.querySelector<HTMLButtonElement>('[data-voice-edit]') ?? button('new');
    target.focus({ preventScroll: true });
  }
  private async remove(profileId: string): Promise<void> {
    const { state, ui } = this, action = `delete:${profileId}`;
    if (state.disposed || state.pending.has(action)) return;
    const focused = document.activeElement;
    const restoreFocus = focused?.closest('.voice-profile')?.getAttribute('data-id') === profileId;
    state.pending.add(action); this.renderProfiles(); showMessage(ui);
    try {
      const next = await this.mutate('voice_delete_profile', { profileId });
      if (state.confirmingId === profileId) state.confirmingId = undefined;
      this.publish(next);
      if (!state.disposed) { this.forgetEdited(profileId); showMessage(ui, 'Speech profile deleted.'); }
    } catch (cause) { if (!state.disposed) showFailure(ui, cause, 'Could not delete speech profile'); }
    finally {
      state.pending.delete(action);
      if (!state.disposed) { this.renderProfiles(); if (restoreFocus) this.refocusAfterDelete(profileId, focused); }
    }
  }

  private chooseProvider(id: string): void {
    const { state, ui } = this, { field } = ui;
    if (id === state.provider) return;
    const previous = presetFor(state.provider);
    const replacesEdits = Boolean(field('key').value || !ui.custom.hidden || field('endpoint').value !== previous.endpoint);
    state.provider = presetFor(id as VoiceProvider).provider; state.revision++;
    const preset = presetFor(state.provider);
    clearValidation(ui);
    if (!field('name').value || field('name').value === previous.name) field('name').value = preset.name;
    if (state.provider !== previous.provider) { field('key').value = ''; state.removingKey = false; }
    field('endpoint').value = preset.endpoint; ui.advanced.open = state.provider === 'custom' || Boolean(field('language').value);
    ui.button('provider').querySelector('span')!.textContent = preset.name;
    this.modelChoice(preset.models[0]); this.editorHints();
    if (replacesEdits) {
      showMessage(ui, 'Provider changed. The endpoint and model were reset to its preset, and the typed key was cleared. Corrected settings apply to a new recording.');
    }
  }
  private openProviderMenu(anchor: HTMLButtonElement): void {
    this.state.closeMenu?.();
    const items = VOICE_PRESETS.map(item => ({ id: item.provider, label: item.name, selected: item.provider === this.state.provider }));
    this.state.closeMenu = openChoiceMenu({
      anchor, title: 'Speech provider', items, onClose: () => { this.state.closeMenu = undefined; }, onSelect: id => this.chooseProvider(id),
    });
  }
  private openModelMenu(anchor: HTMLButtonElement): void {
    const { state, ui } = this;
    state.closeMenu?.();
    const presets = presetFor(state.provider).models.map(id => ({ id, label: id, selected: ui.custom.hidden && id === state.model }));
    state.closeMenu = openChoiceMenu({
      anchor, title: 'Speech model', items: [...presets, { id: '__custom__', label: 'Custom model ID…', selected: !ui.custom.hidden }],
      onClose: () => { state.closeMenu = undefined; },
      onSelect: id => {
        state.revision++;
        this.modelChoice(id === '__custom__' ? ui.custom.hidden ? '' : ui.field('model').value : id, id === '__custom__');
        if (!ui.custom.hidden) ui.field('model').focus();
      },
    });
  }
  private toggleKeyRemoval(): void {
    this.state.removingKey = !this.state.removingKey; this.ui.field('key').value = ''; this.state.revision++; this.editorHints();
  }
  private confirmDelete(id: string): void {
    this.state.confirmingId = id; this.renderProfiles();
    this.ui.list.querySelector<HTMLButtonElement>(`[data-voice-keep="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  private cancelDelete(): void {
    const id = this.state.confirmingId;
    if (!id || this.state.pending.has(`delete:${id}`)) return;
    this.state.confirmingId = undefined; this.renderProfiles();
    this.ui.list.querySelector<HTMLButtonElement>(`[data-voice-delete="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  private profileAction(target: HTMLButtonElement): void {
    const { voiceEdit, voiceUse, voiceDelete, voiceKeep, voiceConfirmDelete } = target.dataset;
    if (voiceEdit) this.edit(this.state.configuration?.profiles.find(profile => profile.id === voiceEdit));
    else if (voiceUse) void this.select(voiceUse);
    else if (voiceDelete) this.confirmDelete(voiceDelete);
    else if (voiceKeep) this.cancelDelete();
    else if (voiceConfirmDelete) void this.remove(voiceConfirmDelete);
  }
  private click = (event: MouseEvent): void => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button'), { button } = this.ui;
    if (!target || target.disabled) return;
    if (target === button('provider')) this.openProviderMenu(target);
    else if (target === button('model')) this.openModelMenu(target);
    else if (target === button('new')) this.edit();
    else if (target === button('off')) void this.select(null);
    else if (target === button('retry')) void this.load();
    else if (target === button('save')) void this.save(false);
    else if (target === button('save-use')) void this.save(true);
    else if (target === button('remove-key')) this.toggleKeyRemoval();
    else this.profileAction(target);
  };
  private input = (event: Event): void => {
    const { state, ui } = this, { field } = ui;
    state.revision++;
    if (ui.form.querySelector('[aria-invalid]')) showMessage(ui);
    clearValidation(ui);
    if (event.target === field('key')) { state.removingKey = false; state.keyDestination = field('endpoint').value.trim(); }
    if (event.target === field('endpoint') && field('key').value && state.keyDestination !== field('endpoint').value.trim()) {
      field('key').value = ''; showMessage(ui, 'Destination changed. Enter the API key for this server before saving.');
    }
    this.editorHints();
  };
  private submit = (event: SubmitEvent): void => { event.preventDefault(); void this.save(false); };
  private keydown = (event: KeyboardEvent): void => {
    if (isImeKey(event)) return;
    const target = event.target as Element;
    if (event.key === 'Enter' && target instanceof HTMLInputElement && this.ui.form.contains(target)) { event.preventDefault(); void this.save(false); }
    else if (event.key === 'Escape' && this.state.confirmingId && target.closest('.voice-profile')?.getAttribute('data-id') === this.state.confirmingId) {
      event.preventDefault(); event.stopPropagation(); this.cancelDelete();
    }
  };
}
