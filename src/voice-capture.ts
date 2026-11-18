import type { Phase, VoicePillCapture } from './voice-pill.ts';
import type {
  VoiceConfiguration, VoiceDestination, VoiceEvent, VoiceFailure, VoiceLocalCatalog, VoiceLocalModel, VoicePreferences, VoiceProfile,
  VoiceStarted, VoiceTranscript, VoiceClosedTranscript,
} from './voice-types';

export interface VoiceOwner { requestId: string; captureId: string; threadId: string; generation: number }
export interface VoiceAnchor { draft: string; start: number; end: number; before: string; after: string }
export type VoiceCapture = Readonly<VoiceOwner & VoicePillCapture & {
  anchor?: VoiceAnchor; anchorRevision?: number; anchorSend?: number; profileId?: string; uploading?: boolean; detached?: boolean;
  /** Cleared explicitly: always review. `sentAway`: its draft was sent, so only an empty composer takes it at the caret. */
  reviewRequired?: boolean; sentAway?: boolean;
}>;
export interface VoiceNativeHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(callback: (event: VoiceEvent) => void): Promise<() => void>;
  /** `voice://transcript`: closing the window stopped and transcribed a dictation. */
  subscribeTranscript?(callback: (event: VoiceClosedTranscript) => void): Promise<() => void>;
  thread(): string | null;
  settings(): void;
  announce(text: string): void;
}
interface CaptureHost extends VoiceNativeHost {
  snapshot(): { anchor: VoiceAnchor; revision: number; send: number };
  changed(): void;
  received(capture: VoiceCapture): void;
  /** A send on the thread that began after `anchorSend` (the last send started when the anchor was taken). */
  sendPending?(threadId: string, anchorSend?: number): boolean;
  /** Settings changed: re-read preferences (shortcut mode, setup state). */
  configurationChanged?(): void;
}
export function ownsVoiceResult(owner: VoiceOwner, current: VoiceOwner): boolean {
  return owner.requestId === current.requestId && owner.captureId === current.captureId
    && owner.threadId === current.threadId && owner.generation === current.generation;
}
export function transitionVoiceCapture(capture: VoiceCapture, patch: Partial<VoiceCapture>): VoiceCapture {
  return { ...capture, ...patch };
}
export function voiceEventPhase(current: Phase, incoming: VoiceEvent['phase']): Phase {
  if (current === 'review' || incoming === 'cancelled') return current;
  if (incoming === 'recording' && current !== 'starting' && current !== 'recording') return current;
  if (incoming === 'transcribing' && current !== 'transcribing') return current;
  return incoming;
}
type ProfileList = Pick<VoiceConfiguration, 'selectedProfileId' | 'profiles'>;
/** The saved destination. A profile destination follows the selected profile, which Settings may have cleared;
 * without preferences (older native) the selected profile alone decides. */
export function voiceDestination(config: ProfileList, prefs?: Pick<VoicePreferences, 'destination'> | null): VoiceDestination {
  const destination = prefs?.destination;
  if (destination === 'local' || destination === 'off') return destination;
  return config.selectedProfileId ? { profileId: config.selectedProfileId } : 'off';
}
/** A successful refresh cancels a capture with no audio only when voice is off or its own profile is gone. */
export function voiceConfigurationCancels(
  route: string, config: ProfileList, prefs?: Pick<VoicePreferences, 'destination'> | null,
): boolean {
  if (voiceDestination(config, prefs) === 'off') return true;
  return route !== LOCAL_ROUTE && !config.profiles.some(profile => profile.id === route);
}
export const LOCAL_ROUTE = 'local';
export type VoiceRoute =
  | { kind: 'local'; model: Pick<VoiceLocalModel, 'id' | 'name'> }
  | { kind: 'profile'; profile: VoiceProfile }
  | { kind: 'setup'; message: string };
const SETUP = {
  off: 'Voice input is off. Turn it on in Settings → Voice.',
  model: 'Download a speech model in Settings → Voice to dictate on this device.',
  select: 'Select a downloaded model in Settings → Voice to dictate on this device.',
  profile: 'Choose a speech profile in Settings to dictate.',
  key: 'Add the speech profile API key in Settings to dictate.',
};
type RouteCatalog = Pick<VoiceLocalCatalog, 'platformSupported' | 'models' | 'unsupportedReason'>;
/** On-device models can't run here: native's reason when it gives one, then the step left (add a speech service,
 * or choose a saved one). */
function unsupportedSetup(catalog: RouteCatalog | null, hasServices: boolean): string {
  const reason = catalog?.unsupportedReason?.trim();
  const sentence = reason ? ` ${/[.!?]$/.test(reason) ? reason : `${reason}.`}` : '';
  return `On-device speech models are not supported on this computer.${sentence} ${hasServices ? 'Choose' : 'Add'} a speech service in Settings → Voice.`;
}
/** Where dictation would go now, or the Settings → Voice step that is missing. Native resolves the same way.
 * Voice off on a computer that can't run local models, with no saved service, says to add one rather than to turn voice on. */
export function resolveVoiceRoute(
  config: VoiceConfiguration, prefs: VoicePreferences | null, catalog: RouteCatalog | null,
): VoiceRoute {
  const destination = voiceDestination(config, prefs);
  if (destination === 'off') {
    const addService = catalog?.platformSupported === false && !config.profiles.length;
    return { kind: 'setup', message: addService ? unsupportedSetup(catalog, false) : SETUP.off };
  }
  if (destination === 'local') {
    if (!catalog?.platformSupported) return { kind: 'setup', message: unsupportedSetup(catalog, config.profiles.length > 0) };
    const model = catalog.models.find(item => item.state === 'installed' && (item.active || item.id === prefs?.selectedModel));
    if (model) return { kind: 'local', model };
    // Downloaded but none chosen (the selected one was deleted): the step left is Select, not another download.
    return { kind: 'setup', message: catalog.models.some(item => item.state === 'installed') ? SETUP.select : SETUP.model };
  }
  const profile = config.profiles.find(item => item.id === destination.profileId);
  if (!profile) return { kind: 'setup', message: SETUP.profile };
  if (profile.provider !== 'custom' && profile.hasKey === false) return { kind: 'setup', message: SETUP.key };
  return { kind: 'profile', profile };
}
/** Stands in for a speech service list that could not be read. */
const UNKNOWN_SERVICE: VoiceProfile = { id: '', name: '', provider: 'custom', endpoint: '', model: '', language: null, hasKey: false };
/** The Settings → Voice step missing before the saved destination can dictate: voice off, this device without
 * support or an installed model, or a saved speech service that is gone or still needs its API key. An unreadable
 * service list never reads as a missing step there; Start reports it instead. */
export async function readVoiceSetup(host: Pick<VoiceNativeHost, 'call'>) {
  const prefs = await host.call<VoicePreferences | null>('voice_preferences').catch(() => null);
  let setup: string | null = null;
  if (prefs && typeof prefs.destination === 'object') {
    const config = await host.call<VoiceConfiguration>('voice_configuration').catch(() => null);
    const route = config?.profiles ? resolveVoiceRoute(config, prefs, null) : null;
    if (route?.kind === 'setup') setup = route.message;
  } else if (prefs?.destination === 'off' || prefs?.destination === 'local') {
    // Whether a service is saved only changes the wording; an unreadable list counts as one so voice off reads as off.
    const [catalog, config] = await Promise.all([
      host.call<VoiceLocalCatalog>('voice_local_catalog').catch(() => null),
      host.call<VoiceConfiguration>('voice_configuration').catch(() => null),
    ]);
    const profiles = config?.profiles ?? (prefs.destination === 'off' ? [UNKNOWN_SERVICE] : []);
    const route = resolveVoiceRoute({ selectedProfileId: null, profiles, limits: { maxSeconds: 0, maxAudioBytes: 0 } }, prefs, catalog);
    if (route.kind === 'setup') setup = route.message;
  }
  return { prefs, setup };
}
/** Reads configuration, preferences and (for the local route) the model catalog. Preferences may be missing. */
export async function readVoiceRoute(host: Pick<VoiceNativeHost, 'call'>) {
  const [config, prefs] = await Promise.all([
    host.call<VoiceConfiguration>('voice_configuration'),
    host.call<VoicePreferences | null>('voice_preferences').catch(() => null),
  ]);
  // This device, or off (which reads differently on a computer that can't run local models).
  const catalog = typeof voiceDestination(config, prefs) === 'string'
    ?await host.call<VoiceLocalCatalog>('voice_local_catalog').catch(() => null) : null;
  return { config, prefs: prefs ?? null, route: resolveVoiceRoute(config, prefs ?? null, catalog) };
}
export function voiceCancelArgs(owner: Pick<VoiceOwner, 'requestId' | 'captureId'>) {
  return owner.captureId ? { requestId: owner.requestId, captureId: owner.captureId } : { requestId: owner.requestId };
}

/** Native work belongs to its origin thread, independently of the currently mounted composer. */
export function logVoiceFailure(context: { operation: string; requestId?: string; captureId?: string }, error: unknown) {
  const { operation, ...owner } = context;
  console.warn(`Voice ${operation} failed.`, owner, error);
}
export class VoiceCaptures {
  value: VoiceCapture | null = null;
  private generation = 0;
  private ready: Promise<() => void> | undefined;
  private configurationPending: Promise<void> = Promise.resolve();
  private cancelling = new Set<Promise<unknown>>();
  private configurationRefresh = 0;
  private host: CaptureHost;
  constructor(host: CaptureHost) {
    this.host = host;
    window.addEventListener('voice-configuration-changed', this.configurationChanged);
  }
  owns(c: VoiceCapture) {
    const current = this.value;
    return Boolean(current && current.requestId === c.requestId && current.threadId === c.threadId
      && current.generation === c.generation && c.generation === this.generation
      && (!c.captureId || current.captureId === c.captureId));
  }
  private patch(c: VoiceCapture, patch: Partial<VoiceCapture>) {
    if (!this.owns(c)) return null;
    this.value = transitionVoiceCapture(this.value!, patch);
    this.host.changed(); return this.value;
  }
  private cancelAudio(owner: Pick<VoiceOwner, 'requestId' | 'captureId'>) {
    const args = voiceCancelArgs(owner);
    const pending = this.host.call('voice_cancel', args).catch(reason => {
      logVoiceFailure({ operation: 'cancellation', ...args }, reason);
    });
    this.cancelling.add(pending);
    void pending.then(() => this.cancelling.delete(pending));
  }
  invalidate(message = 'Dictation cancelled.') {
    const old = this.value; this.generation++; this.value = null;
    if (old) this.cancelAudio(old);
    this.host.changed(); if (old) this.host.announce(message);
  }
  consume(c: VoiceCapture) {
    if (this.owns(c)) { this.value = null; this.host.changed(); }
  }
  forgetAnchor(c: VoiceCapture, sent = false) {
    this.patch(c, sent ? { anchor: undefined, anchorRevision: undefined, sentAway: true }
      : { anchor: undefined, anchorRevision: undefined, reviewRequired: true });
  }
  /** Back in the origin thread: the capture may insert again, and returns the current state. */
  reattach(c: VoiceCapture) { return this.patch(c, { detached: false }); }
  private holdingSpeech() {
    const c = this.value;
    return c?.transcript !== undefined || Boolean(c?.captureId && c.phase !== 'starting' && c.phase !== 'recording');
  }
  review(c: VoiceCapture, message = 'Transcript ready to insert.') {
    return this.patch(c, { phase: 'review', message });
  }
  private error(c: VoiceCapture, reason: unknown, retryable = false) {
    const failure = reason as Partial<VoiceFailure> | null;
    this.patch(c, {
      phase: 'error', message: typeof failure?.message === 'string' ? failure.message : String(reason),
      retryable: retryable && (typeof failure?.retryable === 'boolean' ? failure.retryable : true), uploading: false,
    });
  }
  discardEmptyError() {
    const c = this.value;
    if (c?.phase === 'error' && !c.captureId && !c.transcript?.trim()) this.invalidate('Previous microphone attempt discarded.');
  }
  detach() {
    const c = this.value;
    if (!c || c.detached) return;
    if (c.phase === 'starting' || (c.phase === 'error' && !c.captureId && !c.transcript?.trim())) { this.invalidate(); return; }
    this.patch(c, { detached: true });
    if (c.phase === 'recording') void this.finish();
    else if (c.transcript !== undefined && !this.host.sendPending?.(c.threadId, c.anchorSend)) this.review(c);
  }
  discardThreads(ids: readonly string[]) {
    if (this.value && ids.includes(this.value.threadId)) this.invalidate('Origin thread deleted. Dictation discarded.');
  }
  private async latestConfiguration() {
    let pending;
    do { pending = this.configurationPending; await pending; } while (pending !== this.configurationPending);
  }
  async finish(retry = false) {
    const c = this.value;
    if (!c || c.uploading || !c.captureId || c.retryable === false) return;
    if (retry ? c.phase !== 'error' : c.phase !== 'recording') return;
    const saved = !retry || !c.anchor ? this.host.snapshot() : { anchor: c.anchor, revision: c.anchorRevision, send: c.anchorSend };
    this.patch(c, {
      anchor: saved.anchor, anchorRevision: saved.revision, anchorSend: saved.send, uploading: true, attempted: true,
      retryable: undefined, phase: 'transcribing', message: undefined,
    });
    const command = retry && c.attempted ? 'voice_retry' : 'voice_stop';
    try {
      const result = await this.host.call<VoiceTranscript>(command, { captureId: c.captureId });
      await this.latestConfiguration();
      if (!this.owns(c) || result.captureId !== this.value?.captureId) return;
      const next = this.patch(c, { transcript: result.text, uploading: false });
      if (!next || this.host.sendPending?.(next.threadId, next.anchorSend)) return;
      if (!result.text.trim()) this.review(next, 'No speech detected. Try recording again.');
      else if (next.detached) this.review(next);
      else this.host.received(next);
    } catch (reason) { this.error(c, reason, true); }
  }
  /** Native stopped this recording itself (closing the window does): take the same path as Stop. Its `voice_stop`
   * joins native's transcription and resolves with the same result, so the anchor, send holds and review rules all
   * apply, and only that reply inserts: a `voice://transcript` for the same capture never inserts a second time. */
  private stoppedByNative(c: VoiceCapture) {
    if (c.phase === 'recording' && c.captureId && !c.uploading) void this.finish();
  }
  private closed = (event: VoiceClosedTranscript) => {
    const c = this.value;
    // Only the capture this composer owns; a discarded or foreign one is not ours to insert.
    if (!c || event.requestId !== c.requestId || !c.captureId || event.captureId !== c.captureId) return;
    this.stoppedByNative(c);
  };
  private subscribe() {
    const voice = this.host.subscribe(this.receive);
    // Closing the window is rare and native's "transcribing" event covers it too: a failed subscription is logged, never fatal.
    const closed = this.host.subscribeTranscript?.(this.closed).catch(reason => {
      logVoiceFailure({ operation: 'transcript subscription' }, reason); return undefined;
    });
    return Promise.all([voice, closed]).then(([stopVoice, stopClosed]) => () => { stopVoice(); stopClosed?.(); });
  }
  private receive = (event: VoiceEvent) => {
    const c = this.value;
    if (!c || c.phase === 'review' || event.requestId !== c.requestId) return;
    if (c.captureId && event.captureId !== c.captureId) return;
    // Transcribing while still recording here: native stopped it (the window closed), not our Stop.
    if (event.phase === 'transcribing' && c.phase === 'recording') { this.stoppedByNative(c); return; }
    if (event.phase === 'error' && c.uploading) return;
    if (event.phase === 'cancelled') { this.invalidate(); return; }
    const phase = voiceEventPhase(c.phase, event.phase);
    if (phase !== event.phase) return;
    let zeroSince = c.zeroSince;
    if (phase === 'recording') zeroSince = event.level === 0 ? zeroSince ?? event.elapsedMs : undefined;
    this.patch(c, {
      captureId: event.captureId, elapsedMs: event.elapsedMs, zeroSince, phase, message: event.message,
      level: Number.isFinite(event.level) ? Math.max(0, Math.min(1, event.level)) : 0,
    });
  };
  /** Checks the saved destination before touching the microphone; native Start resolves the same destination. */
  private async configure(c: VoiceCapture) {
    const { config, route } = await readVoiceRoute(this.host);
    if (!this.owns(c)) return false;
    if (route.kind === 'setup') { this.invalidate(route.message); this.host.settings(); return false; }
    const maxSeconds = config.limits?.maxSeconds;
    if (route.kind === 'local') {
      this.patch(c, { profileId: LOCAL_ROUTE, local: true, maxSeconds, source: route.model.name });
      return true;
    }
    const { profile } = route;
    this.patch(c, { profileId: profile.id, maxSeconds, source: `${profile.name} · ${profile.model} · ${new URL(profile.endpoint).host}` });
    return true;
  }
  async start() {
    this.discardEmptyError();
    const threadId = this.host.thread();
    if (this.value || !threadId) return;
    const c: VoiceCapture = {
      requestId: crypto.randomUUID(), captureId: '', threadId, generation: this.generation,
      phase: 'starting', elapsedMs: 0, level: 0,
    };
    this.value = c; this.host.changed();
    try {
      this.ready ??= this.subscribe().catch(reason => { this.ready = undefined; throw reason; });
      await this.ready;
      if (!await this.configure(c)) return;
      while (this.cancelling.size) await Promise.all([...this.cancelling]);
      if (!this.owns(c)) return;
      // No profileId: native starts with the saved destination (a local model, a profile, or an "off" error).
      const result = await this.host.call<VoiceStarted>('voice_start', { requestId: c.requestId });
      if (!this.owns(c)) { this.cancelAudio({ requestId: c.requestId, captureId: result.captureId }); return; }
      this.patch(c, { captureId: result.captureId, phase: this.value?.phase === 'starting' ? 'recording' : this.value!.phase });
    } catch (reason) { this.error(c, reason); }
  }
  private configurationChanged = () => {
    this.host.configurationChanged?.();
    const refreshing = ++this.configurationRefresh, active = this.value;
    this.configurationPending = readVoiceRoute(this.host).then(({ config, prefs }) => {
      if (refreshing !== this.configurationRefresh || !active || !this.owns(active)) return;
      if (this.holdingSpeech()) return;
      const current = this.value!;
      if (current.phase === 'starting' || !current.profileId || voiceConfigurationCancels(current.profileId, config, prefs)) this.invalidate();
    }).catch(reason => {
      // A failed read says nothing about the profile: native work keeps its own snapshot, so nothing is discarded.
      // Only a successful read that turns voice off or removes the profile may cancel.
      logVoiceFailure({ operation: 'configuration refresh', requestId: active?.requestId, captureId: active?.captureId }, reason);
    });
  };
}
