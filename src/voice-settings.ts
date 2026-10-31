import './voice-settings.css';
import { escape, icon } from './dom';
import type { VoiceHost, VoiceModelStatus, VoiceSettings } from './voice';

/* Settings → Voice: turn dictation on, pick the engine and its downloaded
   models, choose tap or hold. Downloads stream progress; nothing is bundled. */

/* Language names are written in their own language, matching the interface
   language picker, so no catalog needs to translate them. */
const LANGUAGE_OPTIONS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Detect automatically' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'de', label: 'Deutsch' },
  { id: 'fr', label: 'Français' },
  { id: 'es', label: 'Español' },
  { id: 'pt', label: 'Português' },
  { id: 'it', label: 'Italiano' },
  { id: 'ru', label: 'Русский' },
  { id: 'pl', label: 'Polski' },
];

const KIND_LABEL: Record<VoiceModelStatus['kind'], string> = {
  final: 'Quality pass',
  live: 'Live streaming',
  punct: 'Punctuation',
};

export type VoiceSettingsHost = VoiceHost;

export function mountVoiceSettings(host: HTMLElement, options: VoiceSettingsHost): () => void {
  let disposed = false;
  let state = { settings: null as VoiceSettings | null, models: [] as VoiceModelStatus[], appleAvailable: false, microphoneAvailable: true };
  let busy = false;

  const draw = (): void => {
    if (!state.settings) {
      host.innerHTML = '<p class="dialog-loading">Loading…</p>';
      return;
    }
    const settings = state.settings;
    const sherpa = settings.engine !== 'apple' || !state.appleAvailable;
    const finalModels = state.models.filter(model => model.kind === 'final');
    const rows = finalModels.map(model => {
      const status = model.downloading
        ? `<span class="voice-download-progress" role="status">${model.id === '' ? '' : `${Math.round(model.progress * 100)}%`}</span>`
        : model.installed
          ? '<span class="voice-installed" role="status">Ready</span>'
          : `<button type="button" class="secondary-button voice-download" data-model="${escape(model.id)}">Download</button>`;
      const pick = model.installed
        ? `<button type="button" class="voice-model-pick${settings.model === model.id ? ' voice-picked' : ''}" data-pick="${escape(model.id)}" aria-pressed="${settings.model === model.id}">${settings.model === model.id ? 'Selected' : 'Use'}</button>`
        : '';
      return `<li class="voice-model"><div><strong>${escape(model.label)}</strong><small>${escape(model.languages)} · ${escape(model.license)} · ${Math.round(model.size / 1e6)} MB · ${KIND_LABEL[model.kind]}</small></div><span class="voice-model-actions">${status}${pick}</span></li>`;
    }).join('');
    const live = state.models.filter(model => model.kind !== 'final').map(model =>
      `<li class="voice-model voice-model-support"><div><strong>${escape(model.label)}</strong><small>${escape(model.languages)} · ${Math.round(model.size / 1e6)} MB · ${KIND_LABEL[model.kind]}</small></div><span class="voice-model-actions">${model.installed ? '<span class="voice-installed">Ready</span>' : model.downloading ? `<span class="voice-download-progress">${Math.round(model.progress * 100)}%</span>` : `<button type="button" class="secondary-button voice-download" data-model="${escape(model.id)}">Download</button>`}</span></li>`,
    ).join('');
    host.innerHTML = `<div class="settings-group">
        <div class="setting-row"><div><strong>Voice dictation</strong><small>Speak into the composer; the transcript lands in the prompt for review before sending. Everything runs on this computer unless you add an online provider later.</small></div><input type="checkbox" class="settings-switch" id="voice-enabled" aria-label="Voice dictation" ${settings.enabled ? 'checked' : ''}></div>
        ${!state.microphoneAvailable ? '<p class="voice-note" role="note">No microphone is available on this computer.</p>' : ''}
      </div>
      ${settings.enabled ? `
      <h3 class="settings-heading">Engine</h3>
      <div class="settings-group" role="radiogroup" aria-label="Voice engine">
        ${state.appleAvailable ? `<div class="setting-row"><div><strong>Apple Speech</strong><small>macOS dictation: no download, live punctuated text. On-device when the language supports it.</small></div><button type="button" class="voice-engine${settings.engine !== 'apple' ? '' : ' voice-picked'}" data-engine="apple" aria-pressed="${settings.engine === 'apple'}">${settings.engine === 'apple' ? 'Selected' : 'Use'}</button></div>` : ''}
        <div class="setting-row"><div><strong>Local models</strong><small>sherpa-onnx on this computer: live streaming text, then a quality model of your choice rewrites the final transcript.</small></div><button type="button" class="voice-engine${settings.engine === 'apple' && state.appleAvailable ? '' : ' voice-picked'}" data-engine="sherpa" aria-pressed="${settings.engine !== 'apple' || !state.appleAvailable}">${settings.engine !== 'apple' || !state.appleAvailable ? 'Selected' : 'Use'}</button></div>
      </div>
      ${sherpa ? `
      <h3 class="settings-heading">Quality model <small class="settings-colors-summary">used for the final transcript</small></h3>
      <ul class="voice-models">${rows}</ul>
      <h3 class="settings-heading">Streaming components</h3>
      <ul class="voice-models">${live}</ul>
      <div class="settings-group">
        <div class="setting-row"><div><strong>Language</strong><small>Picks the streaming model and hints recognition.</small></div><select class="settings-select voice-language" aria-label="Dictation language">${LANGUAGE_OPTIONS.map(option => `<option value="${option.id}" ${settings.language === option.id ? 'selected' : ''}>${option.label}</option>`).join('')}</select></div>
        <div class="setting-row"><div><strong>Fast mode</strong><small>Keep the streaming text as the final transcript — fastest stop-to-text, slightly lower quality.</small></div><input type="checkbox" class="settings-switch" id="voice-fast" aria-label="Fast mode" ${settings.fastMode ? 'checked' : ''}></div>
      </div>` : ''}
      <h3 class="settings-heading">Recording</h3>
      <div class="settings-group" role="radiogroup" aria-label="Recording interaction">
        <div class="setting-row"><div><strong>Tap to talk</strong><small>Click the mic to start, click again or press Done to stop; Esc cancels.</small></div><button type="button" class="voice-engine${settings.interaction !== 'hold' ? ' voice-picked' : ''}" data-interaction="toggle" aria-pressed="${settings.interaction !== 'hold'}">${settings.interaction !== 'hold' ? 'Selected' : 'Use'}</button></div>
        <div class="setting-row"><div><strong>Hold to talk</strong><small>Hold the mic button while speaking; release stops.</small></div><button type="button" class="voice-engine${settings.interaction === 'hold' ? ' voice-picked' : ''}" data-interaction="hold" aria-pressed="${settings.interaction === 'hold'}">${settings.interaction === 'hold' ? 'Selected' : 'Use'}</button></div>
      </div>` : ''}
      <p class="settings-preview-note" data-voice-status role="status" aria-live="polite">${busy ? 'Saving…' : ''}</p>`;
  };

  const save = async (patch: Partial<VoiceSettings>): Promise<void> => {
    if (!state.settings || busy) return;
    busy = true; draw();
    try {
      const settings = await options.call<VoiceSettings>('voice_save_settings', { ...state.settings, ...patch });
      state.settings = settings;
      options.setSettings(settings, state.models);
    } catch (error) {
      options.notify(error instanceof Error ? error.message : String(error));
    }
    busy = false; draw();
  };

  const refresh = async (): Promise<void> => {
    try {
      const [next, models] = await Promise.all([
        options.call<{ settings: VoiceSettings; models: VoiceModelStatus[]; appleAvailable: boolean; microphoneAvailable: boolean }>('voice_state'),
        options.call<VoiceModelStatus[]>('voice_models'),
      ]);
      state = { settings: next.settings, models, appleAvailable: next.appleAvailable, microphoneAvailable: next.microphoneAvailable };
    } catch { state = { ...state, settings: state.settings }; }
    draw();
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const download = target.closest<HTMLElement>('.voice-download');
    if (download?.dataset.model) {
      void options.call('voice_download_model', { id: download.dataset.model }).catch((error: unknown) =>
        options.notify(error instanceof Error ? error.message : String(error)));
      const model = state.models.find(entry => entry.id === download.dataset.model);
      if (model) { model.downloading = true; model.progress = 0; draw(); }
      return;
    }
    const pick = target.closest<HTMLElement>('.voice-model-pick');
    if (pick?.dataset.pick) { void save({ model: pick.dataset.pick }); return; }
    const engine = target.closest<HTMLElement>('[data-engine]');
    if (engine?.dataset.engine) { void save({ engine: engine.dataset.engine }); return; }
    const interaction = target.closest<HTMLElement>('[data-interaction]');
    if (interaction?.dataset.interaction) { void save({ interaction: interaction.dataset.interaction }); return; }
  };
  const onChange = (event: Event): void => {
    const target = event.target as HTMLElement;
    if (target.id === 'voice-enabled') { void save({ enabled: (target as HTMLInputElement).checked }); return; }
    if (target.id === 'voice-fast') { void save({ fastMode: (target as HTMLInputElement).checked }); return; }
    if (target.classList.contains('voice-language')) { void save({ language: (target as HTMLSelectElement).value }); return; }
  };
  const unlistenDownload = options.listen('voice-download', payload => {
    const { id, status, progress } = payload as { id: string; status: string; progress?: number };
    const model = state.models.find(entry => entry.id === id);
    if (!model) return;
    if (status === 'downloading') { model.downloading = true; model.progress = (progress ?? 0) / 100; }
    if (status === 'done') { model.downloading = false; model.installed = true; model.progress = 1; }
    if (status === 'error') { model.downloading = false; }
    draw();
  });
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  void refresh();

  return () => {
    disposed = true;
    unlistenDownload();
    host.removeEventListener('click', onClick);
    host.removeEventListener('change', onChange);
    void disposed;
  };
}
