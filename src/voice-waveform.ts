const SAMPLE_MS = 80;
const BAR_WIDTH = 3;
const BAR_GAP = 3;
const BAR_SPACING = BAR_WIDTH + BAR_GAP;
const MAX_BAR_HEIGHT = 96;
const VERTICAL_MARGIN = 12;
const MIN_BAR_HEIGHT = 1;
const ATTACK_MS = 55;
const RELEASE_MS = 180;
const MAX_FRAME_MS = 1000;
export const HISTORY_SIZE = 1024;

export interface VoiceWaveform {
  readonly amplitude: number; readonly remainderMs: number; readonly samples: readonly number[];
}
interface WavePadding { left: number; right: number; top: number; bottom: number }
interface WaveBar { x: number; y: number; width: number; height: number }
export function createVoiceWaveform(): VoiceWaveform {
  return { amplitude: 0, remainderMs: 0, samples: [] };
}
export function voiceAmplitude(level: number): number {
  return Number.isFinite(level) ? Math.sqrt(Math.max(0, Math.min(1, level))) : 0;
}
/** Exponential attack/release has the same response at every display refresh rate. */
export function smoothVoiceAmplitude(value: number, target: number, elapsedMs: number): number {
  return target + (value - target) * Math.exp(-Math.max(0, elapsedMs) / (target > value ? ATTACK_MS : RELEASE_MS));
}
export function advanceVoiceWaveform(state: Readonly<VoiceWaveform>, level: number, elapsedMs: number): VoiceWaveform {
  const target = voiceAmplitude(level), start = state.amplitude;
  const elapsed = Math.max(0, Math.min(MAX_FRAME_MS, elapsedMs));
  const firstAt = SAMPLE_MS - state.remainderMs;
  const count = Math.max(0, Math.floor((elapsed - firstAt) / SAMPLE_MS) + 1);
  const samples = count ? [...state.samples, ...Array.from({ length: count }, (_, index) =>
    smoothVoiceAmplitude(start, target, firstAt + index * SAMPLE_MS))].slice(-HISTORY_SIZE) : state.samples;
  return {
    amplitude: smoothVoiceAmplitude(start, target, elapsed),
    remainderMs: (state.remainderMs + elapsed) % SAMPLE_MS,
    samples,
  };
}
export function staticVoiceWaveform(state: Readonly<VoiceWaveform>, level: number): VoiceWaveform {
  const amplitude = voiceAmplitude(level);
  return { amplitude, remainderMs: 0, samples: [...state.samples.slice(-(HISTORY_SIZE - 1)), amplitude] };
}
export function voiceWaveBars(
  state: VoiceWaveform, width: number, height: number, pixelRatio = 1,
  padding: WavePadding = { left: 0, right: 0, top: 0, bottom: 0 },
): WaveBar[] {
  width = Math.max(0, width - padding.left - padding.right);
  height = Math.max(0, height - padding.top - padding.bottom);
  const bars = [], maximum = Math.max(0, Math.min(MAX_BAR_HEIGHT, height - VERTICAL_MARGIN));
  for (let i = 0; i <= Math.ceil(width / BAR_SPACING); i++) {
    const position = padding.left + width - BAR_WIDTH - (i + state.remainderMs / SAMPLE_MS) * BAR_SPACING;
    const x = Math.round(position * pixelRatio) / pixelRatio;
    if (x < padding.left || x + BAR_WIDTH > padding.left + width) continue;
    const amplitude = i === 0 ? state.amplitude : state.samples[state.samples.length - i] ?? 0;
    const barHeight = Math.min(height, MIN_BAR_HEIGHT + amplitude * maximum);
    bars.push({ x, y: padding.top + (height - barHeight) / 2, width: BAR_WIDTH, height: barHeight });
  }
  return bars;
}
