import { advanceVoiceWaveform, createVoiceWaveform, staticVoiceWaveform, voiceWaveBars } from './voice-waveform.ts';

const BASELINE_HEIGHT = 2;
const STATIC_UPDATE_MS = 1000;
const LEFT_EDGE_FADE_PX = 24;
export interface VoiceWaveCanvas {
  readonly available: boolean;
  bind(prompt: HTMLTextAreaElement | null): void;
  start(): void;
  stop(): void;
  clear(): void;
  destroy(): void;
}
class WaveCanvas implements VoiceWaveCanvas {
  private canvas = document.createElement('canvas');
  private drawing: CanvasRenderingContext2D | null;
  private prompt: HTMLTextAreaElement | null = null;
  private active = false;
  private wave = createVoiceWaveform();
  private frame: number | undefined;
  private sizeFrame: number | undefined;
  private sizeDirty = false;
  private lastFrameAt: number | undefined;
  private lastStaticAt = -Infinity;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private ink = '';
  private padding = { left: 0, right: 0, top: 0, bottom: 0 };
  private resolution: MediaQueryList | undefined;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private forcedColors = window.matchMedia('(forced-colors: active)');
  private resize = new ResizeObserver(() => this.requestSize());
  private theme = new MutationObserver(() => this.readColor());
  private level: () => number;
  constructor(level: () => number) {
    this.level = level;
    this.canvas.className = 'voice-wave-canvas'; this.canvas.setAttribute('aria-hidden', 'true');
    this.drawing = this.canvas.getContext('2d');
    this.canvas.addEventListener('pointerdown', this.preventSelection);
    this.canvas.addEventListener('mousedown', this.preventSelection);
    this.theme.observe(document.documentElement, {
      attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-vsix'],
    });
    this.reducedMotion.addEventListener('change', this.motionChanged);
    this.forcedColors.addEventListener('change', this.readColor);
    document.addEventListener('visibilitychange', this.sync);
    window.addEventListener('resize', this.requestSize);
    this.watchPixelRatio();
  }
  get available() { return Boolean(this.drawing); }
  private preventSelection = (event: Event) => {
    event.preventDefault(); this.prompt?.focus({ preventScroll: true });
  };
  private draw() {
    const drawing = this.drawing, { width, height, pixelRatio, padding, ink } = this;
    if (!drawing || !width || !height || document.hidden || !this.active) return;
    drawing.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); drawing.clearRect(0, 0, width, height);
    const fade = drawing.createLinearGradient(padding.left, 0, padding.left + LEFT_EDGE_FADE_PX, 0);
    fade.addColorStop(0, 'transparent'); fade.addColorStop(1, ink); drawing.fillStyle = fade;
    const contentWidth = Math.max(0, width - padding.left - padding.right);
    const contentHeight = Math.max(0, height - padding.top - padding.bottom);
    const baseline = Math.min(BASELINE_HEIGHT, contentHeight);
    drawing.fillRect(padding.left, padding.top + (contentHeight - baseline) / 2, contentWidth, baseline);
    drawing.beginPath();
    for (const bar of voiceWaveBars(this.wave, width, height, pixelRatio, padding)) {
      if (typeof drawing.roundRect === 'function') {
        drawing.roundRect(bar.x, bar.y, bar.width, bar.height, Math.min(bar.width, bar.height) / 2);
      } else drawing.rect(bar.x, bar.y, bar.width, bar.height);
    }
    drawing.fill();
  }
  /** Colour is read only while drawing: idle theme changes and redraws cost no style reads, and start() refreshes it. */
  private readColor = () => {
    if (!this.active) return;
    this.refreshInk(); this.draw();
  };
  private refreshInk() { if (this.canvas.isConnected) this.ink = getComputedStyle(this.canvas).color; }
  private size() {
    const prompt = this.prompt, canvas = this.canvas;
    if (!prompt || !canvas.parentElement) return;
    const style = getComputedStyle(prompt);
    this.padding = {
      left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0,
      top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0,
    };
    this.width = prompt.offsetWidth; this.height = prompt.offsetHeight;
    this.pixelRatio = window.devicePixelRatio || 1;
    const left = `${prompt.offsetLeft}px`, top = `${prompt.offsetTop}px`;
    const width = `${this.width}px`, height = `${this.height}px`;
    if (canvas.style.left !== left) canvas.style.left = left;
    if (canvas.style.top !== top) canvas.style.top = top;
    if (canvas.style.width !== width) canvas.style.width = width;
    if (canvas.style.height !== height) canvas.style.height = height;
    const px = Math.ceil(this.width * this.pixelRatio), py = Math.ceil(this.height * this.pixelRatio);
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== py) canvas.height = py;
    this.sizeDirty = false; this.readColor();
  }
  private requestSize = () => {
    this.sizeDirty = true;
    if (!this.active || document.hidden || this.sizeFrame !== undefined) return;
    // Keep observed-size writes out of the ResizeObserver callback.
    this.sizeFrame = window.requestAnimationFrame(() => { this.sizeFrame = undefined; this.size(); });
  };
  private watchPixelRatio() {
    this.resolution?.removeEventListener('change', this.densityChanged);
    this.resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.resolution.addEventListener('change', this.densityChanged);
  }
  private densityChanged = () => { this.size(); this.watchPixelRatio(); };
  private pause() {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    if (this.sizeFrame !== undefined) window.cancelAnimationFrame(this.sizeFrame);
    this.frame = undefined; this.sizeFrame = undefined; this.lastFrameAt = undefined;
  }
  private waveTick = (now: number) => {
    this.frame = undefined;
    if (!this.active || document.hidden || this.reducedMotion.matches) { this.lastFrameAt = undefined; return; }
    if (this.pixelRatio !== (window.devicePixelRatio || 1)) this.densityChanged();
    if (this.sizeDirty) this.size();
    this.wave = advanceVoiceWaveform(this.wave, this.level(), this.lastFrameAt === undefined ? 0 : now - this.lastFrameAt);
    this.lastFrameAt = now; this.draw(); this.frame = window.requestAnimationFrame(this.waveTick);
  };
  private sync = () => {
    if (!this.active || document.hidden || !this.canvas.parentElement) { this.pause(); return; }
    if (this.sizeDirty) this.size();
    if (this.reducedMotion.matches) {
      this.pause();
      const now = performance.now();
      if (now - this.lastStaticAt >= STATIC_UPDATE_MS) {
        this.lastStaticAt = now; this.wave = staticVoiceWaveform(this.wave, this.level()); this.draw();
      }
    } else if (this.frame === undefined) this.frame = window.requestAnimationFrame(this.waveTick);
  };
  private motionChanged = () => { this.lastStaticAt = -Infinity; this.sync(); };
  start() {
    const starting = !this.active; this.active = this.available;
    if (starting && this.active) this.refreshInk();
    this.sync();
  }
  stop() { this.active = false; this.pause(); }
  clear() {
    this.wave = createVoiceWaveform(); this.lastStaticAt = -Infinity; this.lastFrameAt = undefined;
    this.drawing?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  bind(next: HTMLTextAreaElement | null) {
    if (next !== this.prompt) { this.pause(); this.resize.disconnect(); this.canvas.remove(); this.prompt = next; }
    const input = next?.closest('.composer-input');
    if (input && this.canvas.parentElement !== input) {
      // Measured on start (sync sizes a dirty canvas), so an idle composer redraw does no layout reads.
      this.resize.disconnect(); input.append(this.canvas);
      this.resize.observe(next!); this.resize.observe(input); this.sizeDirty = true;
    }
    if (this.active) this.sync();
  }
  destroy() {
    this.stop(); this.resize.disconnect(); this.theme.disconnect(); this.canvas.remove(); this.prompt = null;
    this.resolution?.removeEventListener('change', this.densityChanged);
    this.reducedMotion.removeEventListener('change', this.motionChanged);
    this.forcedColors.removeEventListener('change', this.readColor);
    document.removeEventListener('visibilitychange', this.sync); window.removeEventListener('resize', this.requestSize);
    this.canvas.removeEventListener('pointerdown', this.preventSelection);
    this.canvas.removeEventListener('mousedown', this.preventSelection);
  }
}
export function createVoiceWaveCanvas(level: () => number): VoiceWaveCanvas { return new WaveCanvas(level); }
