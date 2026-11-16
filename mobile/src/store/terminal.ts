// The phone terminal's pure logic (src/app/terminal.tsx): a small ANSI screen model and the
// polling cadence. The screen keeps scrollback as lines of styled cells and understands what
// shells and line editors print: SGR colours and weight, \r, \b, \t, autowrap, clear line and
// screen, cursor moves and character insert/delete. Every other escape (titles, modes,
// charsets) is stripped. `feed` never mutates the screen it is given: unchanged lines are
// shared, so a virtualized list re-renders only the lines that changed.

/** A palette index (0–255) or a `#rrggbb` truecolor. */
export type TermColor = number | string;

export interface CellStyle {
  readonly fg?: TermColor;
  readonly bg?: TermColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}

export interface Cell { readonly c: string; readonly s: CellStyle }
export type Line = readonly Cell[];

export interface Screen {
  readonly lines: readonly Line[];
  readonly row: number;
  readonly col: number;
  /** The cursor reached the last column: the next printable wraps first (xterm's pending wrap). */
  readonly wrap: boolean;
  readonly style: CellStyle;
  /** An escape sequence split across chunks, finished by the next feed. */
  readonly pending: string;
  readonly cols: number;
  readonly rows: number;
}

/** Scrollback the phone keeps; older lines leave from the top. */
export const MAX_LINES = 3000;
const PLAIN: CellStyle = Object.freeze({});
const BLANK: Cell = Object.freeze({ c: ' ', s: PLAIN });
const TAB = 8;
/** An unterminated escape longer than this is dropped rather than waited on. */
const MAX_PENDING = 512;

export function emptyScreen(cols = 80, rows = 24): Screen {
  return { lines: [[]], row: 0, col: 0, wrap: false, style: PLAIN, pending: '', cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

/** The new size; existing lines keep their contents and the next output wraps at `cols`. */
export const resizeScreen = (screen: Screen, cols: number, rows: number): Screen =>
  ({ ...screen, cols: Math.max(1, cols), rows: Math.max(1, rows), col: Math.min(screen.col, Math.max(1, cols) - 1), wrap: false });

// ---- SGR ----

const sgrColor = (params: number[], i: number): [TermColor | undefined, number] => {
  if (params[i + 1] === 5 && params[i + 2] !== undefined) return [clampByte(params[i + 2]), i + 2];
  if (params[i + 1] === 2 && params[i + 4] !== undefined) {
    const hex = [params[i + 2], params[i + 3], params[i + 4]].map(v => clampByte(v).toString(16).padStart(2, '0')).join('');
    return [`#${hex}`, i + 4];
  }
  return [undefined, i];
};
const clampByte = (n: number) => Math.max(0, Math.min(255, Math.trunc(n) || 0));

/** `style` after an SGR (`ESC [ … m`) with `params`. */
export function applySgr(style: CellStyle, params: number[]): CellStyle {
  let next: { -readonly [K in keyof CellStyle]: CellStyle[K] } = { ...style };
  const list = params.length ? params : [0];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 22) { delete next.bold; delete next.dim; }
    else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p >= 30 && p <= 37) next.fg = p - 30;
    else if (p >= 90 && p <= 97) next.fg = p - 90 + 8;
    else if (p === 39) delete next.fg;
    else if (p >= 40 && p <= 47) next.bg = p - 40;
    else if (p >= 100 && p <= 107) next.bg = p - 100 + 8;
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      const [color, last] = sgrColor(list, i);
      if (color !== undefined) next[p === 38 ? 'fg' : 'bg'] = color;
      i = last;
    }
  }
  const keys = Object.keys(next) as (keyof CellStyle)[];
  if (!keys.length) return PLAIN;
  // Same attributes, same object: spans merge by reference.
  return keys.length === Object.keys(style).length && keys.every(k => style[k] === next[k]) ? style : Object.freeze(next);
}

// ---- the writer ----

/** A working copy for one feed: lines are copied on first write, the rest stay shared. */
class Writer {
  lines: Line[];
  copied = new Set<number>();
  row: number;
  col: number;
  wrap: boolean;
  style: CellStyle;
  readonly cols: number;
  readonly rows: number;

  constructor(screen: Screen) {
    this.lines = screen.lines.slice();
    this.row = screen.row;
    this.col = screen.col;
    this.wrap = screen.wrap;
    this.style = screen.style;
    this.cols = screen.cols;
    this.rows = screen.rows;
  }

  line(row: number): Cell[] {
    while (this.lines.length <= row) this.lines.push([]);
    if (!this.copied.has(row)) {
      this.lines[row] = this.lines[row].slice();
      this.copied.add(row);
    }
    return this.lines[row] as Cell[];
  }

  put(c: string) {
    if (this.wrap) {
      this.wrap = false;
      this.col = 0;
      this.down();
    }
    const line = this.line(this.row);
    while (line.length < this.col) line.push(BLANK);
    line[this.col] = { c, s: this.style };
    if (this.col >= this.cols - 1) this.wrap = true;
    else this.col++;
  }

  down() {
    this.row++;
    this.line(this.row);
  }

  /** The first row of the visible screen, for absolute cursor moves and clears. */
  top() {
    return Math.max(0, this.lines.length - this.rows);
  }

  eraseLine(mode: number) {
    const line = this.line(this.row);
    if (mode === 0) line.splice(this.col);
    else if (mode === 1) for (let i = 0; i <= this.col && i < line.length; i++) line[i] = BLANK;
    else line.splice(0);
  }

  eraseScreen(mode: number) {
    if (mode === 0) {
      this.eraseLine(0);
      this.lines.splice(this.row + 1);
    } else if (mode === 2 || mode === 3) {
      // Scrollback holds what was there before; the phone shows a fresh screen.
      this.lines = [[]];
      this.copied = new Set([0]);
      this.row = 0;
      this.col = 0;
    }
  }

  csi(params: number[], final: string, priv: boolean) {
    if (priv) return; // modes (?25l, ?2004h, ?1049h …)
    const n = Math.max(1, params[0] || 0);
    this.wrap = false;
    switch (final) {
      case 'm': this.style = applySgr(this.style, params); return;
      case 'K': this.eraseLine(params[0] ?? 0); return;
      case 'J': this.eraseScreen(params[0] ?? 0); return;
      case 'A': this.row = Math.max(this.top(), this.row - n); return;
      case 'B': this.row += n; this.line(this.row); return;
      case 'C': this.col = Math.min(this.cols - 1, this.col + n); return;
      case 'D': this.col = Math.max(0, this.col - n); return;
      case 'G': this.col = Math.min(this.cols - 1, n - 1); return;
      case 'H': case 'f': {
        this.row = this.top() + Math.max(1, params[0] || 0) - 1;
        this.line(this.row);
        this.col = Math.min(this.cols - 1, Math.max(1, params[1] || 0) - 1);
        return;
      }
      case 'P': this.line(this.row).splice(this.col, n); return;
      case '@': {
        const line = this.line(this.row);
        if (this.col < line.length) line.splice(this.col, 0, ...Array<Cell>(n).fill(BLANK));
        return;
      }
      case 'X': {
        const line = this.line(this.row);
        for (let i = this.col; i < this.col + n && i < line.length; i++) line[i] = BLANK;
        return;
      }
      default: // scroll regions, reports, tabs stops: not needed for a scrollback view
    }
  }

  control(c: string) {
    switch (c) {
      case '\n': this.wrap = false; this.down(); return;
      case '\r': this.wrap = false; this.col = 0; return;
      case '\b': this.wrap = false; this.col = Math.max(0, this.col - 1); return;
      case '\t': this.col = Math.min(this.cols - 1, (Math.floor(this.col / TAB) + 1) * TAB); return;
      default: // bell and the other C0 controls
    }
  }

  screen(pending: string): Screen {
    let lines = this.lines;
    let row = this.row;
    if (lines.length > MAX_LINES) {
      const cut = lines.length - MAX_LINES;
      lines = lines.slice(cut);
      row = Math.max(0, row - cut);
    }
    return { lines, row, col: this.col, wrap: this.wrap, style: this.style, pending, cols: this.cols, rows: this.rows };
  }
}

/**
 * Where the escape sequence at `text[0]` (an ESC) ends: the index after it, or -1 when it
 * continues past the end of `text`.
 */
function escapeEnd(text: string): number {
  const kind = text[1];
  if (kind === undefined) return -1;
  if (kind === '[') {
    for (let i = 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return -1;
  }
  if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
    // OSC and other strings end with BEL or ST (ESC \).
    for (let i = 2; i < text.length; i++) {
      if (text[i] === '\x07') return i + 1;
      if (text[i] === '\x1b') return text[i + 1] === undefined ? -1 : i + 2;
    }
    return -1;
  }
  if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#' || kind === '%') return text.length > 2 ? 3 : -1;
  return 2;
}

function runEscape(writer: Writer, sequence: string) {
  if (sequence[1] !== '[') return;
  const body = sequence.slice(2, -1);
  const final = sequence[sequence.length - 1];
  const priv = /^[?<=>]/.test(body);
  const params = body.replace(/^[?<=>]/, '').split(/[;:]/).filter((p, i, all) => p !== '' || all.length > 1).map(p => (p === '' ? 0 : Number.parseInt(p, 10) || 0));
  writer.csi(params, final, priv);
}

/** `screen` after `data`, the next piece of the terminal's output. */
export function feed(screen: Screen, data: string): Screen {
  if (!data && !screen.pending) return screen;
  const text = screen.pending + data;
  const writer = new Writer(screen);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\x1b') {
      const end = escapeEnd(text.slice(i, i + MAX_PENDING + 1));
      if (end < 0) {
        const rest = text.slice(i);
        return writer.screen(rest.length > MAX_PENDING ? '' : rest);
      }
      runEscape(writer, text.slice(i, i + end));
      i += end;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      writer.control(c);
      i++;
      continue;
    }
    // One cell per code point; surrogate pairs stay together.
    const point = String.fromCodePoint(text.codePointAt(i) ?? code);
    writer.put(point);
    i += point.length;
  }
  return writer.screen('');
}

// ---- rendering ----

export interface Span { readonly text: string; readonly style: CellStyle }

/** A line as runs of one style, trailing spaces dropped. */
export function lineSpans(line: Line): Span[] {
  let end = line.length;
  while (end > 0 && line[end - 1].c === ' ' && line[end - 1].s.bg === undefined && !line[end - 1].s.inverse) end--;
  const spans: Span[] = [];
  for (let i = 0; i < end; i++) {
    const cell = line[i];
    const last = spans[spans.length - 1];
    if (last && last.style === cell.s) spans[spans.length - 1] = { text: last.text + cell.c, style: last.style };
    else spans.push({ text: cell.c, style: cell.s });
  }
  return spans;
}

export const lineText = (line: Line) => lineSpans(line).map(s => s.text).join('');

/** The screen's text, for copying and tests. */
export const screenText = (screen: Screen) => screen.lines.map(lineText).join('\n').replace(/\n+$/, '');

const BASE_DARK = ['#1e1e1e', '#f47067', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#d1d5da', '#768390', '#ff938a', '#6bc46d', '#daaa3f', '#6cb6ff', '#dcbdfb', '#56d4dd', '#ffffff'];
const BASE_LIGHT = ['#24292f', '#cf222e', '#116329', '#7d4e00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (n: number) => n.toString(16).padStart(2, '0');

/** A palette index or truecolor as a CSS colour; the 16 base colours stay readable on both schemes. */
export function colorOf(color: TermColor, dark: boolean): string {
  if (typeof color === 'string') return color;
  if (color < 16) return (dark ? BASE_DARK : BASE_LIGHT)[color];
  if (color < 232) {
    const n = color - 16;
    return `#${hex(CUBE[Math.floor(n / 36)])}${hex(CUBE[Math.floor(n / 6) % 6])}${hex(CUBE[n % 6])}`;
  }
  const grey = 8 + (color - 232) * 10;
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}

// ---- sizing ----

export const MIN_COLS = 20;
export const MAX_COLS = 300;
export const MIN_ROWS = 4;
export const MAX_ROWS = 200;

/** The columns and rows that fit `width`×`height` points with glyphs `charWidth`×`lineHeight`. */
export function gridFor(width: number, height: number, charWidth: number, lineHeight: number): { cols: number; rows: number } {
  const fit = (size: number, unit: number, min: number, max: number) => (unit > 0 && size > 0 ? Math.max(min, Math.min(max, Math.floor(size / unit))) : min);
  return { cols: fit(width, charWidth, MIN_COLS, MAX_COLS), rows: fit(height, lineHeight, MIN_ROWS, MAX_ROWS) };
}

// ---- polling ----

/** While output is arriving or the user just typed. */
export const ACTIVE_POLL_MS = 250;
/** A quiet terminal. */
export const IDLE_POLL_MS = 1000;
/** How long after the last output or keystroke the terminal still counts as active. */
export const ACTIVE_WINDOW_MS = 5000;
/** The longest wait after repeated failures. */
export const MAX_ERROR_POLL_MS = 8000;
/** A page this full means more is waiting: read again at once. */
export const FULL_PAGE = 32 * 1024;

export interface PollState {
  /** The screen is focused and the app in the foreground. */
  readonly visible: boolean;
  /** The terminal ended and its output has been read to the end. */
  readonly exited: boolean;
  readonly now: number;
  /** When output last arrived or the user last typed. */
  readonly lastActivity: number;
  /** Failed reads in a row. */
  readonly failures: number;
  /** Characters the last read returned. */
  readonly lastRead: number;
}

/** Milliseconds until the next read, or null to stop polling (hidden, or ended and read out). */
export function nextPollDelay(state: PollState): number | null {
  if (!state.visible || state.exited) return null;
  if (state.failures > 0) return Math.min(MAX_ERROR_POLL_MS, IDLE_POLL_MS * 2 ** (state.failures - 1));
  if (state.lastRead >= FULL_PAGE) return 0;
  return state.now - state.lastActivity < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

// ---- keys ----

export interface TerminalKey { readonly label: string; readonly data: string; readonly accessibilityLabel: string }

/** The accessory row above the keyboard. */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { label: 'Esc', data: '\x1b', accessibilityLabel: 'Escape' },
  { label: 'Tab', data: '\t', accessibilityLabel: 'Tab' },
  { label: '^C', data: '\x03', accessibilityLabel: 'Control C' },
  { label: '^D', data: '\x04', accessibilityLabel: 'Control D' },
  { label: '↑', data: '\x1b[A', accessibilityLabel: 'Up arrow' },
  { label: '↓', data: '\x1b[B', accessibilityLabel: 'Down arrow' },
  { label: '←', data: '\x1b[D', accessibilityLabel: 'Left arrow' },
  { label: '→', data: '\x1b[C', accessibilityLabel: 'Right arrow' },
  { label: '|', data: '|', accessibilityLabel: 'Pipe' },
  { label: '~', data: '~', accessibilityLabel: 'Tilde' },
  { label: '/', data: '/', accessibilityLabel: 'Slash' },
];

/** What the host accepts in one write (`terminal.write`). */
export const MAX_INPUT_BYTES = 16 * 1024;

/** A typed line as terminal input: the text and Return. */
export const lineInput = (text: string) => `${text}\r`;

/** A short label for a terminal in the picker. */
export function terminalSubtitle(t: { cwd: string; running: boolean; exitCode?: number; kind: string }): string {
  const folder = t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? t.cwd;
  const state = t.running ? 'Running' : t.exitCode === undefined ? 'Ended' : `Exited ${t.exitCode}`;
  const kind = t.kind === 'script' ? 'Run script · ' : t.kind === 'harness' ? 'Agent console · ' : '';
  return `${kind}${folder} · ${state}`;
}
