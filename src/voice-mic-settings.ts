import { call, subscribe } from './bridge';
import { escape, icon } from './dom';
import type { VoicePreferencesStore } from './voice-local-settings';
import { VOICE_CANCELLED, type VoiceMicDevice, type VoiceMicTestResult, type VoiceShortcutMode, type VoiceTestEnded } from './voice-types';

export const MIC_TEST_MS = 10_000;
const message = (cause: unknown) => String(cause instanceof Error ? cause.message : cause);

const SYSTEM_DEFAULT = 'System default';
/** The saved device when it is not connected now: native then records from the system default. */
export function disconnectedDevice(devices: readonly VoiceMicDevice[], saved: string | null | undefined): string | null {
  return saved && !devices.some(device => device.name === saved) ? saved : null;
}

/** Shown under the select (and joined to its description) while the saved device is not connected. */
export const DISCONNECTED_HINT = `Not connected — using ${SYSTEM_DEFAULT}.`;
/** How long the Refresh result stays visible in the row. */
const REFRESHED_MS = 4_000;
export const refreshedText = (count: number) => `Microphones refreshed: ${count} found`;

/** Device options: System default, each device, and a saved device that is not connected now (kept short; the
 * fallback reads on the hint line under the select). */
export function deviceOptionsHtml(devices: readonly VoiceMicDevice[], saved: string | null): string {
  const options = devices.map(device => `<option value="${escape(device.name)}">${escape(device.name)}${device.isDefault ? ' (default)' : ''}</option>`);
  const absent = disconnectedDevice(devices, saved);
  const missing = absent ? `<option value="${escape(absent)}">${escape(absent)} (not connected)</option>` : '';
  return `<option value="">${SYSTEM_DEFAULT}</option>${options.join('')}${missing}`;
}

const countdownText = (endsAt: number, now: number) => `${Math.max(0, Math.ceil((endsAt - now) / 1000))} s left`;

/** Native's live input level during the mic test (`{ level }`, 0..1, ~10–20 Hz). */
export const MIC_LEVEL_EVENT = 'voice://mic-test-level';
const LEVEL_BARS = 5;
/** Below this the meter says nothing is heard yet; one lit bar starts just above it. */
const HEARD_LEVEL = 0.08;
/** A finite level clamped to 0..1; anything else reads as silence. */
export function micLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
const levelText = (level: number) => level >= HEARD_LEVEL ? 'Hearing you' : 'No sound yet';
const litBars = (level: number) => level < HEARD_LEVEL ? 0 : Math.max(1, Math.round(level * LEVEL_BARS));

/** The live level: a role=meter named for assistive tech, with stepped bars and a short visible word hidden from it. */
function levelHtml(level: number): string {
  const bars = Array.from({ length: LEVEL_BARS }, (_, index) => `<span class="voice-mic-level-bar"${index < litBars(level) ? ' data-on' : ''}></span>`).join('');
  return `<span class="voice-mic-level" data-voice-mic-level role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(level * 100)}" aria-valuetext="${levelText(level)}">`
    + `<span class="voice-mic-level-bars" aria-hidden="true">${bars}</span><span class="voice-mic-level-text" data-voice-mic-level-text aria-hidden="true">${levelText(level)}</span></span>`;
}
/** Updates a rendered meter in place, so the countdown and the start announcement are left alone. */
function updateLevel(meter: HTMLElement, level: number): void {
  const text = levelText(level), lit = litBars(level);
  meter.setAttribute('aria-valuenow', String(Math.round(level * 100)));
  if (meter.getAttribute('aria-valuetext') !== text) meter.setAttribute('aria-valuetext', text);
  meter.querySelectorAll('.voice-mic-level-bar').forEach((bar, index) => bar.toggleAttribute('data-on', index < lit));
  const label = meter.querySelector('[data-voice-mic-level-text]');
  if (label && label.textContent !== text) label.textContent = text;
}

/** Decodes a base64 WAV for Web Audio; the app CSP has no media-src, so data: audio cannot play in an audio element. */
async function decodeWav(context: AudioContext, base64: string): Promise<AudioBuffer> {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  return context.decodeAudioData(bytes.buffer);
}

type MicTest =
  | { phase: 'idle' } | { phase: 'starting' } | { phase: 'recording'; endsAt: number; level: number } | { phase: 'stopping' }
  | { phase: 'ready'; result: VoiceMicTestResult; playing: boolean } | { phase: 'error'; text: string };

/** `absent`: the saved device is not connected, so the test (like native) records from the system default. */
function panelHtml(test: MicTest, now: number, absent: string | null): string {
  // The status announces the start once; the visible countdown is hidden from assistive tech and ticks on its own.
  if (test.phase === 'recording') {
    const source = absent ? ` from ${SYSTEM_DEFAULT} because ${escape(absent)} is not connected` : '';
    const lead = absent ? `Testing ${SYSTEM_DEFAULT}…` : 'Recording test…';
    return `<p class="voice-mic-test-status"><span class="voice-sr-only" role="status">Recording a ${MIC_TEST_MS / 1000}-second test${source}. Speak normally.</span>`
      + `<span aria-hidden="true">${lead} <span data-voice-mic-countdown>${countdownText(test.endsAt, now)}</span>. Speak normally.</span>${levelHtml(test.level)}</p>`;
  }
  if (test.phase === 'starting') return `<p class="voice-mic-test-status" role="status">${absent ? `Starting ${SYSTEM_DEFAULT}…` : 'Starting the microphone…'}</p>`;
  if (test.phase === 'stopping') return '<p class="voice-mic-test-status" role="status">Preparing playback…</p>';
  if (test.phase === 'error') return `<p class="voice-error" role="alert">${escape(test.text)}</p>`;
  if (test.phase !== 'ready') return '';
  const seconds = (test.result.durationMs / 1000).toFixed(1);
  const label = test.playing ? 'Stop playback' : 'Play test recording';
  return `<div class="voice-mic-playback" data-voice-mic-playback role="group" aria-label="Microphone test recording">`
    + `<button type="button" class="ds-btn" data-voice-mic-play aria-pressed="${test.playing}">${icon(test.playing ? 'stop' : 'play')}${label}</button>`
    + `<span class="voice-mic-test-status">${seconds} s recorded. Kept only until you leave Settings.</span></div>`;
}

/** The Input card: microphone device, a local record-and-play-back test, and the shortcut mode. */
export class MicSettingsView {
  private devices: VoiceMicDevice[] = [];
  private test: MicTest = { phase: 'idle' };
  private disposed = false;
  private timers: number[] = [];
  private audio?: { context: AudioContext; source?: AudioBufferSourceNode };
  private cleanups: (() => void)[] = [];
  constructor(private host: HTMLElement, private store: VoicePreferencesStore) {}

  private onFailure(text: string): void {
    const error = this.el('[data-voice-input-error]');
    error.textContent = text; error.hidden = !text;
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T { return this.host.querySelector<T>(selector)!; }

  mount(): () => void {
    this.host.addEventListener('click', this.click); this.host.addEventListener('change', this.change);
    this.cleanups.push(this.store.onChange(() => this.renderSelects()));
    void subscribe('voice://test-ended', event => this.testEnded(event))
      .then(stop => { if (this.disposed) stop(); else this.cleanups.push(stop); })
      .catch(() => { /* Without it, a test the window close stopped ends at its own Stop. */ });
    void this.loadDevices();
    return () => this.dispose();
  }
  /** Settings was hidden: stop recording and playback, and forget the test audio. A start still pending is
   * cancelled as soon as it lands. */
  suspend(): void {
    this.clearTimers(); this.stopLevel(); this.stopPlayback();
    if (this.test.phase === 'recording' || this.pendingStart) void call('voice_mic_test_cancel').catch(() => {});
    if (this.pendingStart) this.pendingStart.cancelled = true;
    this.test = { phase: 'idle' }; this.renderTest();
  }
  /** Native stopped the mic test itself (closing the window): idle, no error, no more levels, nothing left to cancel. */
  private testEnded(event: VoiceTestEnded): void {
    if (this.disposed || event?.kind !== 'mic' || this.test.phase === 'idle' || this.test.phase === 'ready' || this.test.phase === 'error') return;
    this.clearTimers(); this.stopLevel();
    if (this.pendingStart) this.pendingStart.cancelled = true;
    this.test = { phase: 'idle' }; this.renderTest();
  }
  private dispose(): void {
    this.suspend(); this.showRefreshed(''); this.disposed = true;
    void this.audio?.context.close().catch(() => {});
    this.cleanups.forEach(cleanup => cleanup());
    this.host.removeEventListener('click', this.click); this.host.removeEventListener('change', this.change);
  }
  private clearTimers(): void { this.timers.forEach(timer => window.clearTimeout(timer)); this.timers = []; }

  /** The live level subscription: `stop` once it has landed, `ended` when the test ended first. */
  private level?: { stop?: () => void; ended: boolean };
  /** Listens for native's input level for this test only; `stopLevel` ends it on stop, cancel, failure or suspend. */
  private listenLevel(): void {
    this.stopLevel();
    const level: { stop?: () => void; ended: boolean } = { ended: false };
    this.level = level;
    // micLevel still checks the payload: native data is untrusted at this boundary.
    subscribe(MIC_LEVEL_EVENT, event => { if (!level.ended) this.showLevel(micLevel(event?.level)); })
      .then(stop => { if (level.ended) stop(); else level.stop = stop; })
      .catch(() => { /* No live level: the countdown and playback still work. */ });
  }
  private stopLevel(): void {
    const level = this.level;
    if (!level) return;
    this.level = undefined; level.ended = true; level.stop?.();
  }
  private showLevel(level: number): void {
    if (this.disposed || this.test.phase !== 'recording') return;
    this.test = { ...this.test, level };
    const meter = this.host.querySelector<HTMLElement>('[data-voice-mic-level]');
    if (meter) updateLevel(meter, level);
  }

  /** `announce`: a Refresh press, which says what it found even when the list did not change. */
  private async loadDevices(announce = false): Promise<void> {
    const refresh = this.el<HTMLButtonElement>('[data-voice-device-refresh]');
    refresh.disabled = true; this.showRefreshed('');
    let listed = false;
    try { this.devices = await call<VoiceMicDevice[]>('voice_mic_devices'); listed = true; }
    catch (cause) { if (!this.disposed) this.onFailure(`Could not list microphones: ${message(cause)}`); }
    finally { if (!this.disposed) { refresh.disabled = false; this.renderSelects(); } }
    if (announce && listed && !this.disposed) this.showRefreshed(refreshedText(this.devices.length));
  }
  private refreshedTimer?: number;
  /** Writes the polite status in the row, then clears it after a moment. */
  private showRefreshed(text: string): void {
    window.clearTimeout(this.refreshedTimer); this.refreshedTimer = undefined;
    const status = this.host.querySelector('[data-voice-device-status]');
    if (!status) return;
    status.textContent = text;
    if (text) this.refreshedTimer = window.setTimeout(() => this.showRefreshed(''), REFRESHED_MS);
  }
  private renderSelects(): void {
    if (this.disposed) return;
    const prefs = this.store.value, device = this.el<HTMLSelectElement>('[data-voice-device]');
    device.innerHTML = deviceOptionsHtml(this.devices, prefs?.deviceName ?? null);
    device.value = prefs?.deviceName ?? '';
    device.title = device.selectedOptions[0]?.text ?? SYSTEM_DEFAULT;
    this.renderHint(device, disconnectedDevice(this.devices, prefs?.deviceName) !== null);
    if (prefs) this.el<HTMLSelectElement>('[data-voice-shortcut-mode]').value = prefs.shortcutMode;
  }
  /** Shows the fallback hint under the select and joins it to the select's description only while shown. */
  private renderHint(device: HTMLSelectElement, shown: boolean): void {
    const hint = this.el('[data-voice-device-hint]');
    hint.textContent = shown ? DISCONNECTED_HINT : ''; hint.hidden = !shown;
    const ids = (device.getAttribute('aria-describedby') ?? '').split(' ').filter(id => id && id !== hint.id);
    device.setAttribute('aria-describedby', (shown ? [...ids, hint.id] : ids).join(' '));
  }
  private renderTest(): void {
    if (this.disposed) return;
    const panel = this.el('[data-voice-mic-panel]'), button = this.el<HTMLButtonElement>('[data-voice-mic-test]');
    const focusedPlay = document.activeElement?.matches('[data-voice-mic-play]');
    panel.innerHTML = panelHtml(this.test, Date.now(), disconnectedDevice(this.devices, this.store.value?.deviceName)); panel.hidden = this.test.phase === 'idle';
    const active = this.test.phase === 'recording' || this.test.phase === 'starting';
    button.querySelectorAll<HTMLElement>('[data-voice-mic-test-label]').forEach(label => {
      label.setAttribute('aria-hidden', String((label.dataset.voiceMicTestLabel === 'active') !== active));
    });
    button.disabled = this.test.phase === 'stopping';
    if (focusedPlay) panel.querySelector<HTMLElement>('[data-voice-mic-play]')?.focus({ preventScroll: true });
  }

  /** The start awaiting native; `cancelled` once Stop or leaving Settings gave it up. */
  private pendingStart?: { cancelled: boolean };
  private async startTest(): Promise<void> {
    if (this.pendingStart) return;
    this.stopPlayback();
    const start = { cancelled: false };
    this.pendingStart = start; this.test = { phase: 'starting' }; this.renderTest();
    // Listen before native starts, so the first levels are not missed; they show once recording.
    this.listenLevel();
    try {
      await call('voice_mic_test_start');
      // Given up while native was still starting and the start won the race: stop the recording it began, stay idle.
      if (start.cancelled || this.disposed) { this.stopLevel(); void call('voice_mic_test_cancel').catch(() => {}); return; }
      const endsAt = Date.now() + MIC_TEST_MS;
      this.test = { phase: 'recording', endsAt, level: 0 }; this.renderTest();
      for (let second = 1; second < MIC_TEST_MS / 1000; second++) this.timers.push(window.setTimeout(() => this.tick(endsAt), second * 1000));
      this.timers.push(window.setTimeout(() => void this.stopTest(), MIC_TEST_MS));
    } catch (cause) {
      // Native ends a pending start with VOICE_CANCELLED (our Cancel, or a newer start): idle, not a failure.
      if (start.cancelled || this.disposed) return;
      this.stopLevel();
      if (message(cause) === VOICE_CANCELLED) { this.test = { phase: 'idle' }; this.renderTest(); }
      else this.fail(`Could not start the microphone test: ${message(cause)}`);
    } finally { if (this.pendingStart === start) this.pendingStart = undefined; }
  }
  /** Stop before native started: back to idle now and cancel the pending start (native aborts it). */
  private abandonStart(): void {
    this.stopLevel();
    if (this.pendingStart) { this.pendingStart.cancelled = true; void call('voice_mic_test_cancel').catch(() => {}); }
    this.test = { phase: 'idle' }; this.renderTest();
    this.el('[data-voice-mic-test]').focus({ preventScroll: true });
  }
  /** Updates only the hidden-from-AT countdown, so the status region is not re-announced every second. */
  private tick(endsAt: number): void {
    const countdown = this.disposed ? null : this.host.querySelector('[data-voice-mic-countdown]');
    if (countdown) countdown.textContent = countdownText(endsAt, Date.now());
  }
  private async stopTest(): Promise<void> {
    if (this.test.phase !== 'recording') return;
    this.clearTimers(); this.stopLevel(); this.test = { phase: 'stopping' }; this.renderTest();
    try {
      const result = await call<VoiceMicTestResult>('voice_mic_test_stop');
      // Ended meanwhile (Settings hidden, or native closed the test): nothing to show.
      if (this.disposed || this.test.phase !== 'stopping') return;
      // The Stop ended a start that was still pending in native: nothing to play back.
      if (result?.cancelled) { this.test = { phase: 'idle' }; this.renderTest(); return; }
      this.test = { phase: 'ready', result, playing: false }; this.renderTest();
      this.el('[data-voice-mic-play]').focus({ preventScroll: true });
    } catch (cause) { if (this.test.phase === 'stopping') this.fail(`Microphone test failed: ${message(cause)}`); }
  }
  private fail(text: string): void {
    if (this.disposed) return;
    this.clearTimers(); this.stopLevel(); this.test = { phase: 'error', text }; this.renderTest();
  }

  private stopPlayback(): void {
    const source = this.audio?.source;
    if (!source) return;
    this.audio!.source = undefined; source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
  }
  private async togglePlayback(): Promise<void> {
    const test = this.test;
    if (test.phase !== 'ready') return;
    if (test.playing) { this.stopPlayback(); this.test = { ...test, playing: false }; this.renderTest(); return; }
    try {
      const context = (this.audio ??= { context: new AudioContext() }).context;
      await context.resume();
      const source = context.createBufferSource();
      source.buffer = await decodeWav(context, test.result.wavBase64); source.connect(context.destination);
      source.onended = () => { if (this.audio?.source === source) { this.audio.source = undefined; this.setPlaying(false); } };
      this.audio.source = source; source.start(); this.setPlaying(true);
    } catch (cause) { this.fail(`Could not play the test recording: ${message(cause)}`); }
  }
  private setPlaying(playing: boolean): void {
    if (this.test.phase === 'ready') { this.test = { ...this.test, playing }; this.renderTest(); }
  }

  private async savePreference(patch: { deviceName?: string | null; shortcutMode?: VoiceShortcutMode }): Promise<void> {
    this.onFailure('');
    try { await this.store.save(patch); } catch (cause) { if (!this.disposed) this.onFailure(`Could not save voice settings: ${message(cause)}`); }
  }
  private change = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.matches('[data-voice-device]')) void this.savePreference({ deviceName: target.value || null });
    else if (target.matches('[data-voice-shortcut-mode]')) void this.savePreference({ shortcutMode: target.value as VoiceShortcutMode });
  };
  private click = (event: MouseEvent): void => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    if (target.matches('[data-voice-mic-test]')) {
      if (this.test.phase === 'starting') this.abandonStart();
      else void (this.test.phase === 'recording' ? this.stopTest() : this.startTest());
    }
    else if (target.matches('[data-voice-device-refresh]')) void this.loadDevices(true);
    else if (target.matches('[data-voice-mic-play]')) void this.togglePlayback();
  };
}
