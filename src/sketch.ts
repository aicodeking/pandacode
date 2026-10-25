import { t } from './i18n.ts';
import './sketch.css';
import { escape, icon } from './dom';
import type { PromptImage } from './attachments';

/** A quick wireframe editor. Shapes live in scene coordinates; the canvas scales to fit.
 * Export renders the scene alone (no grid, no selection) to a PNG the message can carry. */
type ShapeType = 'rect' | 'ellipse' | 'line' | 'arrow' | 'pen' | 'text' | 'stencil';
type Stencil = 'button' | 'input' | 'checkbox' | 'toggle' | 'image' | 'card' | 'navbar' | 'avatar' | 'tabs' | 'list' | 'heading';
type Fill = 'none' | 'tint' | 'white';
export type Shape = { id: string; type: ShapeType; x: number; y: number; w: number; h: number; stroke: string; fill: Fill; weight: number; fontSize: number; text?: string; points?: number[]; stencil?: Stencil };
export type Scene = { width: number; height: number; shapes: Shape[] };
type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text';
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';

export type SketchOptions = {
  taskId: string;
  existing?: PromptImage;
  modal(title: string, body: string, cls?: string): HTMLDialogElement;
  close(): void;
  attach(dataUrl: string, name: string, sketchId: string, replace?: string): Promise<PromptImage>;
};

const PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: 'desktop', label: t('Desktop'), width: 1280, height: 800 },
  { id: 'tablet', label: t('Tablet'), width: 834, height: 1112 },
  { id: 'phone', label: t('Phone'), width: 390, height: 844 },
  { id: 'square', label: t('Square'), width: 800, height: 800 },
];
const COLORS = [['#1d1d1b', t('Ink')], ['#8a8a85', t('Gray')], ['#c99a00', t('Yellow')], ['#2f6fdd', t('Blue')], ['#d0453a', t('Red')], ['#2e8b57', t('Green')]] as const;
const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: t('Select'), key: 'V', icon: 'select' }, { id: 'pen', label: t('Pen'), key: 'P', icon: 'edit' }, { id: 'rect', label: t('Rectangle'), key: 'R', icon: 'square' },
  { id: 'ellipse', label: t('Ellipse'), key: 'O', icon: 'circle' }, { id: 'line', label: t('Line'), key: 'L', icon: 'line' }, { id: 'arrow', label: t('Arrow'), key: 'A', icon: 'arrow-right' }, { id: 'text', label: t('Text'), key: 'T', icon: 'text' },
];
const STENCILS: { id: Stencil; label: string; w: number; h: number; text?: string }[] = [
  { id: 'heading', label: t('Heading'), w: 320, h: 44, text: 'Heading' }, { id: 'button', label: t('Button'), w: 140, h: 40, text: 'Button' }, { id: 'input', label: t('Input'), w: 260, h: 40, text: 'Placeholder' },
  { id: 'checkbox', label: t('Checkbox'), w: 180, h: 28, text: 'Option' }, { id: 'toggle', label: t('Toggle'), w: 180, h: 28, text: 'Setting' }, { id: 'image', label: t('Image'), w: 220, h: 150 },
  { id: 'card', label: t('Card'), w: 260, h: 160, text: 'Card title' }, { id: 'navbar', label: t('Nav bar'), w: 720, h: 56, text: 'Logo' }, { id: 'avatar', label: t('Avatar'), w: 48, h: 48 },
  { id: 'tabs', label: t('Tabs'), w: 320, h: 40, text: 'Overview, Activity, Settings' }, { id: 'list', label: t('List'), w: 280, h: 120, text: 'First item\nSecond item\nThird item' },
];
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const HISTORY_LIMIT = 100;
const MAX_EXPORT_EDGE = 2048;

const scenes = new Map<string, Scene>();
const drafts = new Map<string, Scene>();
let mockupCount = 0;

function uid(): string { return crypto.randomUUID().slice(0, 8); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function tint(color: string, alpha: number): string { const n = parseInt(color.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`; }
function bounds(shape: Shape): { x: number; y: number; w: number; h: number } {
  if (shape.type === 'pen' && shape.points?.length) {
    const xs = shape.points.filter((_, i) => i % 2 === 0), ys = shape.points.filter((_, i) => i % 2 === 1);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: Math.min(shape.x, shape.x + shape.w), y: Math.min(shape.y, shape.y + shape.h), w: Math.abs(shape.w), h: Math.abs(shape.h) };
}

/** Draw the scene. `decorate` adds the grid and selection for the editor view only. */
function paint(context: CanvasRenderingContext2D, scene: Scene, decorate?: { grid: boolean; selected?: Shape; draft?: Shape }): void {
  context.save();
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, scene.width, scene.height);
  if (decorate?.grid) {
    context.fillStyle = 'rgba(29, 29, 27, 0.12)';
    for (let x = 20; x < scene.width; x += 20) for (let y = 20; y < scene.height; y += 20) context.fillRect(x - 0.5, y - 0.5, 1.2, 1.2);
  }
  for (const shape of scene.shapes) drawShape(context, shape);
  if (decorate?.draft) drawShape(context, decorate.draft);
  if (decorate?.selected) drawSelection(context, decorate.selected);
  context.restore();
}

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? line + ' ' + word : word;
      if (line && context.measureText(candidate).width > width) { lines.push(line); line = word; } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 600): void {
  context.save();
  context.fillStyle = color; context.font = `${weight} ${size}px ${FONT}`; context.textBaseline = 'middle'; context.textAlign = align;
  const tx = align === 'center' ? x + w / 2 : align === 'left' ? x : x + w;
  context.beginPath(); context.rect(x - 2, y - 2, w + 4, h + 4); context.clip();
  context.fillText(text, tx, y + h / 2);
  context.restore();
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  context.beginPath(); context.roundRect(x, y, w, h, radius);
}

function fillFor(shape: Shape): string | null {
  return shape.fill === 'tint' ? tint(shape.stroke, 0.12) : shape.fill === 'white' ? '#ffffff' : null;
}

function drawShape(context: CanvasRenderingContext2D, shape: Shape): void {
  const b = bounds(shape);
  context.save();
  context.strokeStyle = shape.stroke; context.lineWidth = shape.weight; context.lineCap = 'round'; context.lineJoin = 'round';
  const fill = fillFor(shape);
  switch (shape.type) {
    case 'rect': roundRect(context, b.x, b.y, b.w, b.h, 6); if (fill) { context.fillStyle = fill; context.fill(); } context.stroke(); break;
    case 'ellipse': context.beginPath(); context.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(1, b.w / 2), Math.max(1, b.h / 2), 0, 0, Math.PI * 2); if (fill) { context.fillStyle = fill; context.fill(); } context.stroke(); break;
    case 'line': case 'arrow': {
      const x2 = shape.x + shape.w, y2 = shape.y + shape.h;
      context.beginPath(); context.moveTo(shape.x, shape.y); context.lineTo(x2, y2); context.stroke();
      if (shape.type === 'arrow') {
        const angle = Math.atan2(shape.h, shape.w), size = 6 + shape.weight * 3;
        context.beginPath(); context.moveTo(x2, y2);
        context.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
        context.moveTo(x2, y2); context.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
        context.stroke();
      }
      break;
    }
    case 'pen': {
      const p = shape.points ?? [];
      if (p.length < 4) { context.beginPath(); context.arc(p[0] ?? shape.x, p[1] ?? shape.y, shape.weight / 2, 0, Math.PI * 2); context.fillStyle = shape.stroke; context.fill(); break; }
      context.beginPath(); context.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length - 2; i += 2) context.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
      context.lineTo(p[p.length - 2], p[p.length - 1]); context.stroke();
      break;
    }
    case 'text': {
      context.fillStyle = shape.stroke; context.font = `500 ${shape.fontSize}px ${FONT}`; context.textBaseline = 'top';
      const lines = wrapText(context, shape.text || 'Text', Math.max(20, b.w));
      lines.forEach((line, index) => context.fillText(line, b.x, b.y + index * shape.fontSize * 1.3));
      break;
    }
    case 'stencil': drawStencil(context, shape, b, fill); break;
  }
  context.restore();
}

function drawStencil(context: CanvasRenderingContext2D, shape: Shape, b: { x: number; y: number; w: number; h: number }, fill: string | null): void {
  const muted = tint(shape.stroke, 0.55), size = shape.fontSize, text = shape.text ?? '';
  const box = (r: number, f: string | null = fill) => { roundRect(context, b.x, b.y, b.w, b.h, r); if (f) { context.fillStyle = f; context.fill(); } context.stroke(); };
  const line = (x1: number, y1: number, x2: number, y2: number) => { context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); };
  switch (shape.stencil) {
    case 'heading': label(context, text || 'Heading', b.x, b.y, b.w, b.h, Math.max(size, Math.min(b.h * 0.7, 40)), shape.stroke, 'left', 700); break;
    case 'button': box(8, fill ?? tint(shape.stroke, 0.12)); label(context, text || 'Button', b.x, b.y, b.w, b.h, size, shape.stroke); break;
    case 'input': box(7, fill ?? '#ffffff'); label(context, text || 'Placeholder', b.x + 12, b.y, b.w - 24, b.h, size, muted, 'left', 500); break;
    case 'checkbox': { const s = Math.min(20, b.h); roundRect(context, b.x, b.y + (b.h - s) / 2, s, s, 4); context.stroke(); context.beginPath(); context.moveTo(b.x + s * 0.25, b.y + b.h / 2); context.lineTo(b.x + s * 0.45, b.y + b.h / 2 + s * 0.2); context.lineTo(b.x + s * 0.78, b.y + b.h / 2 - s * 0.25); context.stroke(); label(context, text || 'Option', b.x + s + 10, b.y, b.w - s - 10, b.h, size, shape.stroke, 'left', 500); break; }
    case 'toggle': { const h = Math.min(24, b.h), w = h * 1.8; roundRect(context, b.x, b.y + (b.h - h) / 2, w, h, h / 2); context.fillStyle = tint(shape.stroke, 0.18); context.fill(); context.stroke(); context.beginPath(); context.arc(b.x + w - h / 2, b.y + b.h / 2, h / 2 - 3, 0, Math.PI * 2); context.fillStyle = shape.stroke; context.fill(); label(context, text || 'Setting', b.x + w + 10, b.y, b.w - w - 10, b.h, size, shape.stroke, 'left', 500); break; }
    case 'image': box(6, fill ?? tint(shape.stroke, 0.06)); context.save(); context.beginPath(); context.rect(b.x, b.y, b.w, b.h); context.clip(); line(b.x, b.y, b.x + b.w, b.y + b.h); line(b.x + b.w, b.y, b.x, b.y + b.h); context.restore(); break;
    case 'card': {
      box(10, fill ?? '#ffffff');
      label(context, text || 'Card title', b.x + 16, b.y + 12, b.w - 32, size * 1.6, size, shape.stroke, 'left', 650);
      const top = b.y + 16 + size * 1.8; context.strokeStyle = muted;
      for (let i = 0; i < 3 && top + i * 14 + 6 < b.y + b.h - 8; i++) line(b.x + 16, top + i * 14, b.x + b.w - 16 - (i === 2 ? b.w * 0.3 : 0), top + i * 14);
      break;
    }
    case 'navbar': {
      box(0, fill ?? '#ffffff');
      const pad = 16, logoW = Math.min(90, b.w * 0.2); roundRect(context, b.x + pad, b.y + b.h / 2 - 12, logoW, 24, 5); context.fillStyle = tint(shape.stroke, 0.16); context.fill(); context.stroke();
      label(context, text || 'Logo', b.x + pad, b.y + b.h / 2 - 12, logoW, 24, Math.min(size, 14), shape.stroke, 'center', 700);
      const items = ['Home', 'Features', 'Pricing']; let x = b.x + b.w - pad;
      for (const item of items.reverse()) { const w = context.measureText(item).width + 34; x -= w; if (x < b.x + pad + logoW) break; label(context, item, x, b.y, w, b.h, Math.min(size, 14), muted, 'center', 500); }
      break;
    }
    case 'avatar': { const r = Math.min(b.w, b.h) / 2, cx = b.x + b.w / 2, cy = b.y + b.h / 2; context.beginPath(); context.arc(cx, cy, r, 0, Math.PI * 2); context.fillStyle = fill ?? tint(shape.stroke, 0.1); context.fill(); context.stroke(); context.save(); context.beginPath(); context.arc(cx, cy, r - 1, 0, Math.PI * 2); context.clip(); context.beginPath(); context.arc(cx, cy - r * 0.2, r * 0.34, 0, Math.PI * 2); context.fillStyle = shape.stroke; context.fill(); context.beginPath(); context.arc(cx, cy + r * 1.05, r * 0.7, 0, Math.PI * 2); context.fill(); context.restore(); break; }
    case 'tabs': {
      const names = (text || 'One, Two, Three').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
      const w = b.w / Math.max(1, names.length);
      context.strokeStyle = muted; line(b.x, b.y + b.h, b.x + b.w, b.y + b.h);
      names.forEach((name, i) => { label(context, name, b.x + i * w, b.y, w, b.h, size, i === 0 ? shape.stroke : muted, 'center', i === 0 ? 650 : 500); if (i === 0) { context.strokeStyle = shape.stroke; context.lineWidth = shape.weight + 1; line(b.x + i * w + 8, b.y + b.h, b.x + (i + 1) * w - 8, b.y + b.h); } });
      break;
    }
    case 'list': {
      const rows = (text || 'Item').split('\n').filter(Boolean).slice(0, 8), rowH = Math.min(36, b.h / Math.max(1, rows.length));
      rows.forEach((row, i) => { const y = b.y + i * rowH; context.beginPath(); context.arc(b.x + 8, y + rowH / 2, 3, 0, Math.PI * 2); context.fillStyle = shape.stroke; context.fill(); label(context, row, b.x + 22, y, b.w - 22, rowH, size, shape.stroke, 'left', 500); if (i) { context.strokeStyle = tint(shape.stroke, 0.18); line(b.x, y, b.x + b.w, y); } });
      break;
    }
  }
}

function drawSelection(context: CanvasRenderingContext2D, shape: Shape): void {
  context.save();
  context.strokeStyle = '#2f6fdd'; context.lineWidth = 1; context.setLineDash([5, 4]);
  if (shape.type === 'line' || shape.type === 'arrow') {
    context.setLineDash([]); context.fillStyle = '#ffffff';
    for (const [x, y] of [[shape.x, shape.y], [shape.x + shape.w, shape.y + shape.h]]) { context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.fill(); context.stroke(); }
  } else {
    const b = bounds(shape); context.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    if (shape.type !== 'pen') { context.setLineDash([]); context.fillStyle = '#ffffff'; for (const [x, y] of handlePoints(b)) { context.beginPath(); context.rect(x - 4, y - 4, 8, 8); context.fill(); context.stroke(); } }
  }
  context.restore();
}

function handlePoints(b: { x: number; y: number; w: number; h: number }): [number, number, Handle][] {
  const { x, y, w, h } = b;
  return [[x - 4, y - 4, 'nw'], [x + w / 2, y - 4, 'n'], [x + w + 4, y - 4, 'ne'], [x + w + 4, y + h / 2, 'e'], [x + w + 4, y + h + 4, 'se'], [x + w / 2, y + h + 4, 's'], [x - 4, y + h + 4, 'sw'], [x - 4, y + h / 2, 'w']];
}

function hit(shape: Shape, x: number, y: number): boolean {
  const b = bounds(shape), pad = 6;
  if (shape.type === 'line' || shape.type === 'arrow') {
    const len = Math.hypot(shape.w, shape.h) || 1, at = Math.max(0, Math.min(1, ((x - shape.x) * shape.w + (y - shape.y) * shape.h) / (len * len)));
    return Math.hypot(x - (shape.x + at * shape.w), y - (shape.y + at * shape.h)) <= pad + shape.weight;
  }
  if (shape.type === 'pen') {
    const p = shape.points ?? [];
    for (let i = 0; i < p.length; i += 2) if (Math.hypot(x - p[i], y - p[i + 1]) <= pad + shape.weight) return true;
    return false;
  }
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

export function sceneFor(sketchId: string): Scene | undefined { return scenes.get(sketchId); }

export function showSketch(options: SketchOptions): void {
  const sketchId = options.existing?.sketchId ?? uid();
  const saved = options.existing?.sketchId ? scenes.get(options.existing.sketchId) : drafts.get(options.taskId);
  const scene: Scene = saved ? clone(saved) : { width: PRESETS[0].width, height: PRESETS[0].height, shapes: [] };
  let tool: Tool = 'select', stroke: string = COLORS[0][0], fill: Fill = 'none', weight = 2, fontSize = 16, grid = true;
  let selected = '', draft: Shape | undefined, history: Scene[] = [], future: Scene[] = [], dirty = false, busy = false;
  let drag: { mode: 'move' | 'resize' | 'draw'; handle?: Handle; startX: number; startY: number; origin: Shape } | undefined;

  const dialog = options.modal(options.existing ? t('Edit mockup') : t('Sketch a mockup'), `
    <div class="sketch-editor" data-tool="select">
      <div class="sketch-toolbar" role="toolbar" aria-label="${t('Drawing tools')}">
        <div class="sketch-group" role="group" aria-label="${t('Tools')}">${TOOLS.map(t => `<button type="button" class="sketch-tool" data-tool="${t.id}" aria-label="${t.label} (${t.key})" title="${t.label} · ${t.key}" aria-pressed="${t.id === 'select'}">${icon(t.icon)}</button>`).join('')}</div>
        <div class="sketch-group" role="group" aria-label="${t('Color')}">${COLORS.map(([value, name]) => `<button type="button" class="sketch-swatch" data-color="${value}" style="--swatch:${value}" aria-label="${name}" title="${name}" aria-pressed="${value === COLORS[0][0]}"></button>`).join('')}</div>
        <div class="sketch-group" role="group" aria-label="${t('Fill')}"><button type="button" class="sketch-option" data-fill="none" aria-pressed="true" title="${t('No fill')}">${t('Outline')}</button><button type="button" class="sketch-option" data-fill="tint" aria-pressed="false" title="${t('Tinted fill')}">${t('Tint')}</button><button type="button" class="sketch-option" data-fill="white" aria-pressed="false" title="${t('White fill')}">${t('Solid')}</button></div>
        <div class="sketch-group" role="group" aria-label="${t('Line weight')}"><button type="button" class="sketch-option" data-weight="1.5" aria-pressed="false" title="${t('Thin')}">${t('Thin')}</button><button type="button" class="sketch-option" data-weight="2" aria-pressed="true" title="${t('Regular')}">${t('Regular')}</button><button type="button" class="sketch-option" data-weight="3.5" aria-pressed="false" title="${t('Bold')}">${t('Bold')}</button></div>
        <div class="sketch-group sketch-group-end" role="group" aria-label="${t('History')}"><button type="button" class="icon-button" data-history="undo" aria-label="${t('Undo (⌘Z)')}" title="${t('Undo · ⌘Z')}" disabled>${icon('undo')}</button><button type="button" class="icon-button" data-history="redo" aria-label="${t('Redo (⇧⌘Z)')}" title="${t('Redo · ⇧⌘Z')}" disabled>${icon('redo')}</button><button type="button" class="icon-button" data-edit="duplicate" aria-label="${t('Duplicate (⌘D)')}" title="${t('Duplicate · ⌘D')}" disabled>${icon('copy')}</button><button type="button" class="icon-button" data-edit="delete" aria-label="${t('Delete selection')}" title="${t('Delete')}" disabled>${icon('trash')}</button></div>
      </div>
      <div class="sketch-toolbar sketch-toolbar-secondary">
        <div class="sketch-group" role="group" aria-label="${t('Add a component')}"><span class="sketch-group-label">${icon('widget')}${t('Add')}</span>${STENCILS.map(s => `<button type="button" class="sketch-option sketch-stencil" data-stencil="${s.id}" aria-label="${t`Add ${s.label.toLowerCase()}`}" title="${t`Add ${s.label.toLowerCase()}`}">${s.label}</button>`).join('')}</div>
        <div class="sketch-group sketch-group-end" role="group" aria-label="${t('Canvas')}"><label class="sketch-select">${t('Canvas')}<select aria-label="${t('Canvas size')}">${PRESETS.map(p => `<option value="${p.id}">${p.label} · ${p.width} × ${p.height}</option>`).join('')}</select></label><button type="button" class="sketch-option" data-grid aria-pressed="true" title="${t('Toggle grid')}">${icon('grid')}${t('Grid')}</button><button type="button" class="sketch-option" data-edit="clear" title="${t('Clear the canvas')}">${t('Clear')}</button></div>
      </div>
      <div class="sketch-stage"><div class="sketch-paper"><canvas role="img" aria-label="${t('Mockup canvas')}"></canvas></div></div>
      <div class="dialog-footer sketch-footer"><span class="sketch-hint" role="status">${t('Drag to draw. Double-click a component or text to edit its label.')}</span><button type="button" class="secondary-button" data-action="close-dialog">${t('Cancel')}</button><button type="button" class="primary-button sketch-attach">${options.existing ? t('Update mockup') : t('Attach to message')}</button></div>
    </div>`, 'sketch-dialog');
  const editor = dialog.querySelector<HTMLElement>('.sketch-editor')!;
  const paper = editor.querySelector<HTMLElement>('.sketch-paper')!;
  const canvas = editor.querySelector<HTMLCanvasElement>('canvas')!;
  const hint = editor.querySelector<HTMLElement>('.sketch-hint')!;
  const select = editor.querySelector<HTMLSelectElement>('select')!;
  const context = canvas.getContext('2d')!;
  select.value = PRESETS.find(p => p.width === scene.width && p.height === scene.height)?.id ?? 'desktop';
  const current = () => scene.shapes.find(s => s.id === selected);

  function fit(): void {
    const stage = editor.querySelector<HTMLElement>('.sketch-stage')!;
    const available = { w: Math.max(200, stage.clientWidth - 24), h: Math.max(160, stage.clientHeight - 24) };
    const scale = Math.min(available.w / scene.width, available.h / scene.height, 1.25);
    paper.style.width = `${Math.round(scene.width * scale)}px`; paper.style.height = `${Math.round(scene.height * scale)}px`;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(scene.width * scale * ratio); canvas.height = Math.round(scene.height * scale * ratio);
    canvas.style.width = paper.style.width; canvas.style.height = paper.style.height;
    context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
    render();
  }
  function render(): void {
    paint(context, scene, { grid, selected: current(), draft });
    const shape = current();
    editor.querySelector<HTMLButtonElement>('[data-history=undo]')!.disabled = !history.length;
    editor.querySelector<HTMLButtonElement>('[data-history=redo]')!.disabled = !future.length;
    for (const button of editor.querySelectorAll<HTMLButtonElement>('[data-edit=duplicate],[data-edit=delete]')) button.disabled = !shape;
    canvas.setAttribute('aria-label', `${t('Mockup canvas')}, ${scene.shapes.length === 1 ? t`${scene.shapes.length} shape` : t`${scene.shapes.length} shapes`}${shape ? t`, ${shape.type === 'stencil' ? shape.stencil : shape.type} selected` : ''}`);
    editor.dataset.tool = tool; editor.dataset.selection = shape ? 'true' : 'false';
    drafts.set(options.taskId, clone(scene));
  }
  // `committed` is the last settled state, so undo restores what preceded a change.
  let committed: Scene = clone(scene);
  function commit(): void {
    history.push(committed); committed = clone(scene); if (history.length > HISTORY_LIMIT) history.shift();
    future = []; dirty = true; render();
  }
  function point(event: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * scene.width, y = (event.clientY - rect.top) / rect.height * scene.height;
    const snap = (v: number) => grid && tool !== 'pen' && !event.altKey ? Math.round(v / 10) * 10 : v;
    return { x: Math.max(0, Math.min(scene.width, snap(x))), y: Math.max(0, Math.min(scene.height, snap(y))) };
  }
  function setTool(next: Tool): void {
    tool = next;
    for (const button of editor.querySelectorAll<HTMLButtonElement>('.sketch-tool')) button.setAttribute('aria-pressed', String(button.dataset.tool === next));
    hint.textContent = next === 'select' ? t('Drag to move. Drag a handle to resize. Double-click a component or text to edit its label.') : next === 'text' ? t('Click where the text should start, then type. Enter adds a line; Escape finishes.') : next === 'pen' ? t('Draw freely. Hold Alt to ignore the grid with other tools.') : t`Drag to draw ${next === 'ellipse' ? 'an' : 'a'} ${next}. Hold Alt to ignore the grid.`;
    render();
  }
  function applyStyle(patch: Partial<Pick<Shape, 'stroke' | 'fill' | 'weight' | 'fontSize'>>): void {
    const shape = current();
    if (shape) { Object.assign(shape, patch); commit(); }
  }
  function pressed(selector: string, attribute: string, value: string): void {
    for (const button of editor.querySelectorAll<HTMLButtonElement>(selector)) button.setAttribute('aria-pressed', String(button.dataset[attribute] === value));
  }
  function place(stencil: typeof STENCILS[number]): void {
    const w = Math.min(stencil.w, scene.width - 40), h = Math.min(stencil.h, scene.height - 40);
    // Each new component lands a step down-right from the last so nothing hides under another.
    const count = scene.shapes.filter(s => s.type === 'stencil').length % 8;
    const shape: Shape = { id: uid(), type: 'stencil', stencil: stencil.id, text: stencil.text, x: Math.round((scene.width - w) / 2 / 10) * 10 + count * 30, y: Math.round((scene.height - h) / 2 / 10) * 10 + count * 30, w, h, stroke, fill: 'none', weight, fontSize: stencil.id === 'heading' ? 28 : fontSize };
    shape.x = Math.max(0, Math.min(shape.x, scene.width - w)); shape.y = Math.max(0, Math.min(shape.y, scene.height - h));
    scene.shapes.push(shape); selected = shape.id; setTool('select'); commit();
  }
  function edit(shape: Shape): void {
    if (shape.type !== 'text' && shape.type !== 'stencil') return;
    if (shape.type === 'stencil' && (shape.stencil === 'image' || shape.stencil === 'avatar')) return;
    const b = bounds(shape), rect = canvas.getBoundingClientRect(), scale = rect.width / scene.width;
    const area = document.createElement('textarea');
    area.className = 'sketch-text-editor'; area.setAttribute('aria-label', shape.type === 'text' ? t('Text') : t('Label')); area.value = shape.text ?? '';
    area.style.left = `${b.x * scale}px`; area.style.top = `${b.y * scale}px`; area.style.width = `${Math.max(120, b.w * scale)}px`; area.style.height = `${Math.max(32, Math.min(b.h, 200) * scale)}px`; area.style.fontSize = `${Math.max(12, shape.fontSize * scale)}px`;
    let done = false;
    const finish = (cancel: boolean) => {
      if (done) return; done = true; editing = undefined;
      const value = area.value.replace(/\r/g, '');
      area.remove(); canvas.focus();
      // Like shapes, a finished caption hands back to Select.
      if (shape.type === 'text' && tool === 'text') setTool('select');
      if (cancel) { if (shape.type === 'text' && !shape.text) { scene.shapes = scene.shapes.filter(s => s !== shape); selected = ''; } render(); return; }
      if (shape.type === 'text' && !value.trim()) { scene.shapes = scene.shapes.filter(s => s !== shape); selected = ''; commit(); return; }
      if (value !== shape.text) { shape.text = value; if (shape.type === 'text') { context.font = `500 ${shape.fontSize}px ${FONT}`; const lines = wrapText(context, value || 'Text', Math.max(20, bounds(shape).w)); shape.h = Math.max(shape.fontSize * 1.3, lines.length * shape.fontSize * 1.3); } commit(); } else render();
    };
    area.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        // Chrome reports Escape as a dialog close request after this event; WebKit does not
        // once the key is handled. Either way the edit ends and the sketch stays open.
        event.preventDefault(); event.stopPropagation();
        window.setTimeout(() => { if (editing?.finish === finish) finish(false); }, 80);
      }
      else if (event.key === 'Enter' && (shape.type === 'stencil' && shape.stencil !== 'list' && shape.stencil !== 'card' || event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(false); }
      event.stopPropagation();
    });
    area.addEventListener('blur', () => finish(false));
    editing = { finish };
    paper.append(area); area.focus(); area.select();
  }
  let editing: { finish(cancel: boolean): void } | undefined;
  const onCancel = (event: Event) => { if (editing) { event.preventDefault(); editing.finish(false); } };
  dialog.addEventListener('cancel', onCancel);
  function handleAt(shape: Shape, x: number, y: number): Handle | undefined {
    if (shape.type === 'line' || shape.type === 'arrow') {
      if (Math.hypot(x - shape.x, y - shape.y) <= 8) return 'start';
      if (Math.hypot(x - shape.x - shape.w, y - shape.y - shape.h) <= 8) return 'end';
      return;
    }
    if (shape.type === 'pen') return;
    return handlePoints(bounds(shape)).find(([hx, hy]) => Math.abs(x - hx) <= 7 && Math.abs(y - hy) <= 7)?.[2];
  }
  function resize(shape: Shape, origin: Shape, handle: Handle, dx: number, dy: number): void {
    if (handle === 'start') { shape.x = origin.x + dx; shape.y = origin.y + dy; shape.w = origin.w - dx; shape.h = origin.h - dy; return; }
    if (handle === 'end') { shape.w = origin.w + dx; shape.h = origin.h + dy; return; }
    const b = bounds(origin);
    let { x, y, w, h } = b;
    if (handle.includes('w')) { x += dx; w -= dx; }
    if (handle.includes('e')) w += dx;
    if (handle.includes('n')) { y += dy; h -= dy; }
    if (handle.includes('s')) h += dy;
    if (w < 8) { w = 8; if (handle.includes('w')) x = b.x + b.w - 8; }
    if (h < 8) { h = 8; if (handle.includes('n')) y = b.y + b.h - 8; }
    Object.assign(shape, { x, y, w, h });
  }
  function undo(): void { const previous = history.pop(); if (!previous) return; future.push(committed); Object.assign(scene, clone(previous)); committed = clone(scene); if (!current()) selected = ''; dirty = true; render(); }
  function redo(): void { const next = future.pop(); if (!next) return; history.push(committed); Object.assign(scene, clone(next)); committed = clone(scene); if (!current()) selected = ''; dirty = true; render(); }
  function remove(): void { if (!current()) return; scene.shapes = scene.shapes.filter(s => s.id !== selected); selected = ''; commit(); }
  function duplicate(): void { const shape = current(); if (!shape) return; const copy = { ...clone(shape), id: uid(), x: shape.x + 20, y: shape.y + 20 }; if (copy.points) copy.points = copy.points.map(v => v + 20); scene.shapes.push(copy); selected = copy.id; commit(); }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || busy) return;
    canvas.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    if (tool === 'select') {
      const shape = current();
      const handle = shape ? handleAt(shape, x, y) : undefined;
      if (shape && handle) { drag = { mode: 'resize', handle, startX: x, startY: y, origin: clone(shape) }; return; }
      const target = [...scene.shapes].reverse().find(s => hit(s, x, y));
      selected = target?.id ?? '';
      if (target) drag = { mode: 'move', startX: x, startY: y, origin: clone(target) };
      render();
      return;
    }
    if (tool === 'text') {
      // The press must not move focus to the canvas, or it would blur the editor it opens.
      event.preventDefault();
      const shape: Shape = { id: uid(), type: 'text', x, y, w: Math.min(280, scene.width - x), h: fontSize * 1.3, stroke, fill: 'none', weight, fontSize, text: '' };
      scene.shapes.push(shape); selected = shape.id; render(); edit(shape);
      return;
    }
    const raw = tool === 'pen' ? { x: (event.clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width * scene.width, y: (event.clientY - canvas.getBoundingClientRect().top) / canvas.getBoundingClientRect().height * scene.height } : { x, y };
    draft = { id: uid(), type: tool, x: raw.x, y: raw.y, w: 0, h: 0, stroke, fill, weight, fontSize, points: tool === 'pen' ? [raw.x, raw.y] : undefined };
    drag = { mode: 'draw', startX: raw.x, startY: raw.y, origin: clone(draft) };
    selected = '';
    render();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) {
      if (tool === 'select') { const shape = current(); const { x, y } = point(event); const handle = shape ? handleAt(shape, x, y) : undefined; canvas.style.cursor = handle ? (handle === 'n' || handle === 's' ? 'ns-resize' : handle === 'e' || handle === 'w' ? 'ew-resize' : handle === 'nw' || handle === 'se' ? 'nwse-resize' : handle === 'ne' || handle === 'sw' ? 'nesw-resize' : 'move') : [...scene.shapes].some(s => hit(s, x, y)) ? 'move' : 'default'; }
      return;
    }
    const { x, y } = point(event);
    if (drag.mode === 'draw' && draft) {
      if (draft.type === 'pen') { const rect = canvas.getBoundingClientRect(); draft.points!.push((event.clientX - rect.left) / rect.width * scene.width, (event.clientY - rect.top) / rect.height * scene.height); }
      else { draft.w = x - drag.startX; draft.h = y - drag.startY; if (event.shiftKey && (draft.type === 'rect' || draft.type === 'ellipse')) { const side = Math.max(Math.abs(draft.w), Math.abs(draft.h)); draft.w = Math.sign(draft.w || 1) * side; draft.h = Math.sign(draft.h || 1) * side; } }
      render(); return;
    }
    const shape = current(); if (!shape) return;
    const dx = x - drag.startX, dy = y - drag.startY;
    if (drag.mode === 'move') {
      shape.x = drag.origin.x + dx; shape.y = drag.origin.y + dy;
      if (shape.points && drag.origin.points) shape.points = drag.origin.points.map((v, i) => v + (i % 2 === 0 ? dx : dy));
    } else if (drag.handle) resize(shape, drag.origin, drag.handle, dx, dy);
    render();
  });
  const finishDrag = (event: PointerEvent) => {
    if (!drag) return;
    const active = drag; drag = undefined;
    if (active.mode === 'draw' && draft) {
      const shape = draft; draft = undefined;
      const size = shape.type === 'pen' ? (shape.points!.length > 2 ? 10 : 0) : Math.hypot(shape.w, shape.h);
      if (size < 4) { render(); return; }
      if (shape.type === 'pen') { const b = bounds(shape); Object.assign(shape, { x: b.x, y: b.y, w: b.w, h: b.h }); }
      scene.shapes.push(shape); selected = shape.id; commit();
      // Shapes hand back to Select for immediate adjustment; the pen keeps drawing.
      if (shape.type !== 'pen' && !event.shiftKey) setTool('select');
      return;
    }
    const shape = current();
    if (shape && JSON.stringify(shape) !== JSON.stringify(active.origin)) commit(); else render();
  };
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.addEventListener('dblclick', event => { const { x, y } = point(event as unknown as PointerEvent); const target = [...scene.shapes].reverse().find(s => hit(s, x, y)); if (target) { selected = target.id; render(); edit(target); } });

  editor.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    if (target.dataset.tool) setTool(target.dataset.tool as Tool);
    else if (target.dataset.color) { stroke = target.dataset.color; pressed('.sketch-swatch', 'color', stroke); applyStyle({ stroke }); }
    else if (target.dataset.fill) { fill = target.dataset.fill as Fill; pressed('[data-fill]', 'fill', fill); applyStyle({ fill }); }
    else if (target.dataset.weight) { weight = Number(target.dataset.weight); pressed('[data-weight]', 'weight', target.dataset.weight); applyStyle({ weight }); }
    else if (target.dataset.stencil) place(STENCILS.find(s => s.id === target.dataset.stencil)!);
    else if (target.dataset.history === 'undo') undo();
    else if (target.dataset.history === 'redo') redo();
    else if (target.dataset.edit === 'delete') remove();
    else if (target.dataset.edit === 'duplicate') duplicate();
    else if (target.dataset.edit === 'clear') { if (scene.shapes.length) { selected = ''; scene.shapes = []; commit(); } }
    else if ('grid' in target.dataset) { grid = !grid; target.setAttribute('aria-pressed', String(grid)); render(); }
    else if (target.classList.contains('sketch-attach')) void attach();
  });
  select.addEventListener('change', () => {
    const preset = PRESETS.find(p => p.id === select.value)!;
    scene.width = preset.width; scene.height = preset.height;
    for (const shape of scene.shapes) { const b = bounds(shape); const dx = Math.min(0, scene.width - (b.x + b.w)), dy = Math.min(0, scene.height - (b.y + b.h)); shape.x += dx; shape.y += dy; if (shape.points) shape.points = shape.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)); }
    commit(); fit();
  });
  editor.addEventListener('keydown', event => {
    if ((event.target as HTMLElement).matches('textarea, select, input')) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redo(); else undo(); return; }
    if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); event.stopPropagation(); duplicate(); return; }
    if (command) return;
    if (event.key === 'Backspace' || event.key === 'Delete') { if (current()) { event.preventDefault(); event.stopPropagation(); remove(); } return; }
    if (event.key === 'Enter' && current()) { event.preventDefault(); event.stopPropagation(); edit(current()!); return; }
    if (event.key.startsWith('Arrow') && current()) {
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1, shape = current()!, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      shape.x += dx; shape.y += dy; if (shape.points) shape.points = shape.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)); commit(); return;
    }
    const shortcut = TOOLS.find(t => t.key.toLowerCase() === event.key.toLowerCase());
    if (shortcut && !event.altKey) { event.preventDefault(); event.stopPropagation(); setTool(shortcut.id); }
  });
  canvas.tabIndex = 0;

  async function attach(): Promise<void> {
    if (busy) return;
    if (!scene.shapes.length) { hint.textContent = t('Draw something first.'); return; }
    busy = true; editor.classList.add('sketch-busy');
    try {
      const scale = Math.min(2, MAX_EXPORT_EDGE / Math.max(scene.width, scene.height));
      const output = document.createElement('canvas');
      output.width = Math.round(scene.width * scale); output.height = Math.round(scene.height * scale);
      const out = output.getContext('2d')!; out.setTransform(scale, 0, 0, scale, 0, 0);
      paint(out, scene);
      const dataUrl = output.toDataURL('image/png');
      const name = options.existing?.name ?? `Mockup${++mockupCount > 1 ? ` ${mockupCount}` : ''}.png`;
      scenes.set(sketchId, clone(scene)); drafts.delete(options.taskId);
      await options.attach(dataUrl, name, sketchId, options.existing?.id);
      dirty = false;
      options.close();
    } finally { busy = false; editor.classList.remove('sketch-busy'); }
  }

  const observer = new ResizeObserver(() => fit());
  observer.observe(editor.querySelector('.sketch-stage')!);
  dialog.addEventListener('close', () => { observer.disconnect(); dialog.removeEventListener('cancel', onCancel); if (!dirty && !scene.shapes.length) drafts.delete(options.taskId); }, { once: true });
  fit();
  setTool(scene.shapes.length ? 'select' : 'rect');
  canvas.focus();
}
