import type { VoicePillCapture } from './voice-pill.ts';

const QUIET_INPUT_MS = 3000;
const RECORD_AGAIN = /record again/i;
const PERMISSION_HINT_SECONDS = 3;
const STILL_TRANSCRIBING_SECONDS = 10;
/** Review puts the source on its own line rather than joining it to the instruction. */
const SOURCE_LINE = '\n';
const SOURCE_PART = ' · ';
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export interface VoiceCopyElements {
  pill: HTMLElement; label: HTMLElement; context: HTMLElement; transcript: HTMLElement;
  clock: HTMLElement; meter: HTMLMeterElement;
}

export function recoveryPhase(c: VoicePillCapture) { return c.phase === 'error' || c.phase === 'review'; }

export function statusText(c: VoicePillCapture, waiting: number, quiet: boolean) {
    switch (c.phase) {
      case 'starting':
        if (waiting >= PERMISSION_HINT_SECONDS) return 'Check microphone permission';
        return 'Starting microphone…';
      case 'recording':
        if (quiet) return 'No input · Check microphone';
        return 'Listening';
      case 'transcribing':
        // A first local use loads the model, so the same slow reminder covers it.
        if (waiting >= STILL_TRANSCRIBING_SECONDS) return `Still transcribing · ${duration(waiting)}`;
        return c.local ? 'Transcribing on this device…' : 'Transcribing…';
      case 'review': return c.message || 'Draft changed. Transcript ready to insert.';
      case 'error': return c.message || 'Dictation failed.';
    }
  }

export function sourceText(c: VoicePillCapture, waiting: number) {
    const source = c.source ?? '';
    if (c.phase === 'starting') {
      if (waiting >= PERMISSION_HINT_SECONDS) return 'Check the microphone permission prompt from your operating system.';
      return 'Checking speech profile and microphone permission…';
    }
    if (c.phase === 'recording' || c.phase === 'transcribing') {
      return c.local ? `Audio stays on this device · ${source}` : `Audio goes to ${source}`;
    }
    if (c.phase === 'error') {
      // Said once: native's message often already explains Record again, and then the context doesn't repeat it.
      const told = RECORD_AGAIN.test(c.message ?? '');
      if (!c.captureId || c.retryable === false) return told ? 'Recording again uses your current Settings.' : 'Record again uses your current Settings.';
      const settings = told ? '' : ' Changed Settings? Record again.';
      if (c.local) {
        const action = c.attempted ? 'Retry transcribes it again' : 'Transcribe recording transcribes it';
        return `${action} on this device with ${source}.${settings}`;
      }
      let action = 'Transcribe recording sends';
      if (c.attempted) action = 'Retry resends';
      return `${action} to ${source}.${settings}`;
    }
    if (c.transcript?.trim()) {
      return `Place the cursor or select text in your draft, then choose Insert at cursor.${SOURCE_LINE}${source}`;
    }
    return `Record again when you are ready.${SOURCE_LINE}${source}`;
  }

export function captureView(c: VoicePillCapture, phaseStartedAt: number, hintUntil: number, hintText: string) {
    const waiting = Math.floor((Date.now() - phaseStartedAt) / 1000);
    const quiet = c.zeroSince !== undefined && c.elapsedMs - c.zeroSince >= QUIET_INPUT_MS;
    const text = Date.now() < hintUntil ? hintText : statusText(c, waiting, quiet);
    return { waiting, quiet, text, source: sourceText(c, waiting) };
  }

/**
 * The context line, with the source's parts (profile, model, host) each kept whole so a name like `whisper-1`
 * never breaks inside; a source after a line break gets its own line. Text content is unchanged.
 */
function paintContext(context: HTMLElement, text: string, source: string) {
  context.title = text; context.textContent = text;
  const at = source ? text.lastIndexOf(source) : -1;
  if (at < 0) return;
  const wrap = document.createElement('span');
  wrap.className = 'voice-source';
  wrap.toggleAttribute('data-own-line', text.slice(0, at).endsWith(SOURCE_LINE));
  source.split(SOURCE_PART).forEach((part, index) => {
    if (index) wrap.append(SOURCE_PART);
    const piece = document.createElement('span'); piece.className = 'voice-source-part'; piece.textContent = part;
    wrap.append(piece);
  });
  context.replaceChildren(text.slice(0, at), wrap, text.slice(at + source.length));
}

export function paintCopy(elements: VoiceCopyElements, c: VoicePillCapture, view: CaptureView) {
    const { pill, label, context, transcript } = elements;
    label.textContent = view.text;
    if (context.title !== view.source || !context.firstChild) paintContext(context, view.source, c.source ?? '');
    transcript.hidden = c.phase !== 'review' || !c.transcript?.trim();
    transcript.textContent = c.transcript ?? '';
    const description = [view.text, view.source];
    if (c.phase === 'transcribing') {
      description.push(`Recorded ${duration(c.elapsedMs / 1000)}. Waiting ${duration(view.waiting)}.`);
      description.push('You can keep typing; Cancel discards this recording.');
    }
    if (c.phase === 'recording' && view.quiet) {
      description.push(`No microphone input for ${QUIET_INPUT_MS / 1000} seconds. Check your microphone.`);
    }
    if (c.phase === 'recording' && c.maxSeconds) description.push(`Recording limit ${c.maxSeconds} seconds.`);
    pill.setAttribute('aria-description', description.join(' '));
  }

export function paintTime(elements: VoiceCopyElements, c: VoicePillCapture, waiting: number) {
    const { meter, clock } = elements;
    meter.hidden = c.phase !== 'recording';
    if (c.phase === 'recording') {
      const level = Math.max(0, Math.min(1, c.level));
      meter.value = level;
      meter.setAttribute('aria-valuetext', `${Math.round(level * 100)} percent RMS input`);
    }
    clock.hidden = recoveryPhase(c);
    let text = duration(waiting), description = `Waiting ${text} for microphone.`;
    if (c.phase === 'recording' || c.phase === 'transcribing') {
      text = duration(c.elapsedMs / 1000);
      description = `Recorded ${text}`;
      if (c.phase === 'transcribing') description += `. Waiting ${duration(waiting)} for transcription`;
      else if (c.maxSeconds) description += `. Limit ${duration(c.maxSeconds)}`;
      description += '.';
      // The limit matters only while it can still stop the recording.
      if (c.phase === 'recording' && c.maxSeconds) text += ` / ${duration(c.maxSeconds)}`;
    }
    clock.textContent = text; clock.setAttribute('aria-label', description);
  }

export type CaptureView = ReturnType<typeof captureView>;

export function voiceAnnouncement(c: VoicePillCapture, view: CaptureView) {
    let status = view.text;
    if (recoveryPhase(c)) {
      status += ` ${view.source}`;
      if (c.phase === 'review' && c.transcript?.trim()) status += ' Transcript available below.';
    } else if (c.phase === 'transcribing') {
      status = 'Transcribing…';
      if (view.waiting >= STILL_TRANSCRIBING_SECONDS) {
        status = 'Still transcribing. You can keep typing; Cancel discards this recording.';
      }
    } else if (c.phase === 'recording' && view.quiet) status = 'No input';
    return status;
  }
