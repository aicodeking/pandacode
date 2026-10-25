import './voice.css';
import { escape, icon } from './dom';

/* Voice dictation for the composer: tap or hold the mic, talk, and live
   partial text streams into the prompt; stopping settles the final transcript
   for review before sending — never auto-send. All capture and recognition
   happen natively (docs/voice.md); the webview only sees IPC events. */

export type VoiceSettings = {
  enabled: boolean;
  engine: string;
  model: string;
  language: string;
  interaction: string;
  fastMode: boolean;
  /** offline | online | online-fallback */
  mode: string;
  onlineProvider: string;
  onlineModel: string;
  onlineBaseUrl: string;
};

export type VoiceProviderInfo = {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  /** Streams partial text while speaking (WebSocket providers). */
  streaming: boolean;
};

export type VoiceModelStatus = {
  id: string;
  label: string;
  kind: 'final' | 'live' | 'punct';
  languages: string;
  license: string;
  size: number;
  installed: boolean;
  downloading: boolean;
  progress: number;
};

export type VoiceStateInfo = {
  settings: VoiceSettings;
  models: VoiceModelStatus[];
  recording: string | null;
  appleAvailable: boolean;
  microphoneAvailable: boolean;
  keys: string[];
};

export type VoiceHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: string, handler: (payload: unknown) => void): () => void;
  notify(text: string): void;
  /** Settings changed elsewhere (Settings → Voice); the composer button follows. */
  changed(): void;
  /** Settings → Voice saved new settings; the composer instance adopts them. */
  setSettings(settings: VoiceSettings, models?: VoiceModelStatus[]): void;
};

const ENGINE_LABEL: Record<string, string> = {
  apple: 'Apple Speech',
  sherpa: 'Local model',
};

export function createVoice(host: VoiceHost) {
  let info: VoiceStateInfo = {
    settings: { enabled: false, engine: '', model: '', language: 'auto', interaction: 'toggle', fastMode: false, mode: 'offline', onlineProvider: '', onlineModel: '', onlineBaseUrl: '' },
    models: [],
    recording: null,
    appleAvailable: false,
    microphoneAvailable: false,
    keys: [],
  };
  let loading: Promise<void> | undefined;
  let recording = false;
  let startedAt = 0, ticker: ReturnType<typeof setInterval> | undefined, bar: HTMLElement | undefined;
  let prefix = '', suffix = '', partial = '';
  let sessionId = '';

  function load(force = false): Promise<void> {
    if (!loading || force) {
      loading = host.call<VoiceStateInfo>('voice_state').then(value => {
        info = value;
        host.changed();
      }).catch(() => { /* Voice stays off when the backend has none. */ });
    }
    return loading;
  }

  const enabled = () => info.settings.enabled && info.microphoneAvailable !== false;
  const interaction = () => (info.settings.interaction === 'hold' ? 'hold' : 'toggle');

  /** The composer control: a mic beside the Saver leaf. Hidden until voice is on. */
  function button(currentSessionId: string): string {
    if (!enabled()) return '';
    const active = recording && sessionId === currentSessionId;
    const label = active ? 'Stop dictation (Esc to cancel)' : 'Dictate a message';
    return `<button type="button" class="composer-voice-button${active ? ' voice-recording' : ''}" data-action="voice" aria-pressed="${active}" aria-label="${escape(label)}" title="${escape(label)}">${icon('mic')}<span>Voice</span></button>`;
  }

  /** Swaps the button in place; renderComposer re-renders call this indirectly. */
  function refresh(currentSessionId: string): void {
    const current = document.querySelector<HTMLElement>('.composer-voice-button');
    const next = button(currentSessionId);
    if (!next) { current?.remove(); return; }
    if (current) current.outerHTML = next;
    else document.querySelector('.composer-tools')?.insertAdjacentHTML('beforeend', next);
  }

  const promptField = () => document.querySelector<HTMLTextAreaElement>('#prompt');

  function startRecording(): void {
    const prompt = promptField();
    if (!prompt) return;
    sessionId = prompt.dataset.sessionId ?? '';
    prefix = prompt.value.slice(0, prompt.selectionStart ?? prompt.value.length);
    suffix = prompt.value.slice(prompt.selectionEnd ?? prompt.value.length);
    partial = '';
    recording = true;
    startedAt = Date.now();
    refresh(sessionId);
    mountBar();
    void host.call('voice_start').catch((error: unknown) => {
      recording = false;
      unmountBar();
      refresh(sessionId);
      host.notify(error instanceof Error ? error.message : String(error));
    });
  }

  function stopRecording(cancel = false): void {
    if (!recording) return;
    void host.call(cancel ? 'voice_cancel' : 'voice_stop').catch(() => { /* the backend cleans up */ });
    if (cancel) finishLocally();
  }

  /** Local teardown for cancels and error paths (results keep the text). */
  function finishLocally(): void {
    recording = false;
    unmountBar();
    refresh(sessionId);
  }

  /** Streams the live text into the prompt, replacing the previous partial. */
  function applyPartial(text: string): void {
    partial = text;
    const prompt = promptField();
    if (!prompt) return;
    prompt.value = `${prefix}${text}${suffix}`;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const caret = prefix.length + text.length;
    prompt.setSelectionRange(caret, caret);
    if (bar) bar.querySelector<HTMLElement>('.voice-label')!.textContent = 'Listening…';
  }

  /** Settles the final transcript: whatever arrived replaces the partial. */
  function applyFinal(text: string, engine: string): void {
    const prompt = promptField();
    recording = false;
    unmountBar();
    if (prompt) {
      prompt.value = `${prefix}${text}${suffix}`;
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      const caret = prefix.length + text.length;
      prompt.focus({ preventScroll: true });
      prompt.setSelectionRange(caret, caret);
    }
    refresh(sessionId);
    host.notify(`Dictated with ${ENGINE_LABEL[engine] ?? engine}. Review the text, then send.`);
  }

  function mountBar(): void {
    unmountBar();
    bar = document.createElement('div');
    bar.className = 'voice-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span class="voice-dot" aria-hidden="true"></span><span class="voice-time">0:00</span>
      <span class="voice-meter" aria-hidden="true"><i></i></span>
      <span class="voice-label">Listening…</span>
      <button type="button" class="voice-stop">${icon('arrow')}Done</button>
      <button type="button" class="voice-cancel">${icon('close')}Cancel</button>`;
    document.body.append(bar);
    bar.querySelector('.voice-stop')!.addEventListener('click', () => stopRecording(false));
    bar.querySelector('.voice-cancel')!.addEventListener('click', () => stopRecording(true));
    const tick = () => {
      if (!bar) return;
      const seconds = Math.floor((Date.now() - startedAt) / 1_000);
      bar.querySelector<HTMLElement>('.voice-time')!.textContent =
        `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      placeBar();
    };
    ticker = setInterval(tick, 250);
    tick();
  }

  function placeBar(): void {
    if (!bar) return;
    const composer = document.querySelector<HTMLElement>('#composer-area');
    const height = bar.offsetHeight || 48;
    if (composer) {
      const rect = composer.getBoundingClientRect();
      bar.style.left = `${Math.max(12, rect.left + rect.width / 2 - bar.offsetWidth / 2)}px`;
      bar.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
    } else {
      bar.style.left = '50%';
      bar.style.bottom = '24px';
      bar.style.transform = 'translateX(-50%)';
    }
    bar.style.minHeight = `${height}px`;
  }

  function unmountBar(): void {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    bar?.remove();
    bar = undefined;
  }

  function onLevel(level: number): void {
    if (!bar) return;
    bar.querySelector<HTMLElement>('.voice-meter i')!.style.width = `${Math.round(Math.min(1, Math.max(0.04, level)) * 100)}%`;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!recording) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopRecording(true);
    }
  }

  /** Composer dispatch: `data-action="voice"` clicks (toggle mode). */
  function handleAction(): void {
    if (!enabled() || interaction() === 'hold') return;
    if (recording) stopRecording(false);
    else startRecording();
  }

  // Hold-to-talk rides pointer events on the mic button, wherever it mounts.
  const onPointer = (event: PointerEvent) => {
    if (!enabled() || interaction() !== 'hold') return;
    const target = event.target as Element;
    const mic = target.closest<HTMLElement>('[data-action="voice"]');
    if (!mic) return;
    if (event.type === 'pointerdown') {
      event.preventDefault();
      if (!recording) startRecording();
    } else if ((event.type === 'pointerup' || event.type === 'pointerleave' || event.type === 'pointercancel') && recording) {
      stopRecording(false);
    }
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('pointerup', onPointer, true);
  document.addEventListener('pointerleave', onPointer, true);
  document.addEventListener('pointercancel', onPointer, true);

  host.listen('voice-partial', payload => {
    const { text } = payload as { text: string };
    applyPartial(text);
  });
  host.listen('voice-result', payload => {
    const { text, engine } = payload as { text: string; engine: string };
    applyFinal(text, engine);
  });
  host.listen('voice-error', payload => {
    const { message } = payload as { message: string };
    finishLocally();
    host.notify(message);
  });
  host.listen('voice-level', payload => onLevel(Number(payload)));
  host.listen('voice-download', payload => {
    const { id, status, error } = payload as { id: string; status: string; error?: string };
    if (status === 'done') {
      host.notify(`Voice model ${id} ready.`);
      void load(true);
    } else if (status === 'error') {
      host.notify(`Voice model download failed: ${error ?? id}`);
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', placeBar);

  return {
    button,
    refresh,
    handleAction,
    load,
    /** The live state for Settings → Voice. */
    state: () => info,
    /** Saved settings (Settings → Voice) refresh the composer button. */
    setSettings: (settings: VoiceSettings, models?: VoiceModelStatus[]) => {
      info = { ...info, settings, ...(models ? { models } : {}) };
      host.changed();
    },
    reload: () => load(true),
    /** True while a recording runs (renderComposer keeps the button state). */
    isRecording: () => recording,
    recordingSession: () => (recording ? sessionId : ''),
  };
}
