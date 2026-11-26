/** The left-side thread scroll indicator's model (src/thread-scroll-indicator.ts draws it). Pure: no DOM,
 * so Node tests import it directly. A short thread gets one tick per turn; a long one keeps its first and
 * last turns and folds the middle into even, chronological ranges so the rail never outgrows its slots. */

export type ScrollTurnSummary = {
  id: string;
  label?: string;
  userText?: string;
  assistantText?: string;
  isLive?: boolean;
  hasError?: boolean;
  messageIds: readonly string[];
};

export type ScrollMarker = {
  key: string;
  targetId: string;
  startIndex: number;
  endIndex: number;
  totalTurns: number;
  active: boolean;
  isLive: boolean;
  hasError: boolean;
  title: string;
  preview: string;
};

export type ScrollIndicatorState = {
  visible: boolean;
  showEarlier: boolean;
  showLatest: boolean;
  markers: ScrollMarker[];
  activeMarkerIndex: number;
};

export type ScrollIndicatorInput = {
  turns: readonly ScrollTurnSummary[];
  activeTurnIndex: number;
  hasOlder: boolean;
  atBottom: boolean;
  scrollable: boolean;
  maxSlots?: number;
};

/** Longest preview, ellipsis included. */
export const PREVIEW_MAX = 100;
export const MIN_SLOTS = 4;
export const MAX_SLOTS = 20;
export const DEFAULT_SLOTS = 16;
/** WebKit rounds scrollTop to whole pixels, so a jumped-to turn can land up to ~1px below the reading line. */
export const ACTIVE_TURN_TOLERANCE = 1.5;
const ELLIPSIS = '…';

/** Markdown reduced to the words a reader would see. */
function plainText(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, ' [code] ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary when one is near the limit, so the ellipsis never lands mid-word without need. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - ELLIPSIS.length;
  const cut = text.slice(0, room);
  const space = cut.lastIndexOf(' ');
  const head = space >= room * 0.6 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:!?\-–—]+$/, '')}${ELLIPSIS}`;
}

/** A one-line preview of a turn: the prompt, else the reply, else `fallback`. */
export function extractTurnPreview(userText?: string, assistantText?: string, fallback = ''): string {
  for (const source of [userText, assistantText]) {
    const text = source ? plainText(source) : '';
    if (text) return clip(text, PREVIEW_MAX);
  }
  return clip(plainText(fallback), PREVIEW_MAX);
}

/** The turn at the reading line: the last whose top is at or above it (binary search over sorted tops).
 * The bottom of the thread always reads as the newest turn; a line above every top reads as the first. */
export function findActiveTurnIndex(tops: readonly number[], readingLine: number, atBottom: boolean): number {
  if (!tops.length) return -1;
  if (atBottom) return tops.length - 1;
  let low = 0, high = tops.length - 1, found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (tops[mid] <= readingLine + ACTIVE_TURN_TOLERANCE) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

const clampSlots = (slots: number | undefined): number => {
  const wanted = Number.isFinite(slots) ? Math.floor(slots as number) : DEFAULT_SLOTS;
  return Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, wanted));
};

const turnPreview = (turn: ScrollTurnSummary, index: number): string =>
  extractTurnPreview(turn.userText, turn.assistantText, turn.label || `Turn ${index + 1}`);

function singleMarker(turns: readonly ScrollTurnSummary[], index: number): ScrollMarker {
  const turn = turns[index];
  return {
    key: `turn:${turn.id}`,
    targetId: turn.id,
    startIndex: index,
    endIndex: index,
    totalTurns: turns.length,
    active: false,
    isLive: Boolean(turn.isLive),
    hasError: Boolean(turn.hasError),
    title: turn.isLive ? 'Live response' : `Turn ${index + 1} of ${turns.length}`,
    preview: turnPreview(turn, index),
  };
}

/** The turn a range stands for: a live turn, else one with an error, else the middle one. */
function representative(turns: readonly ScrollTurnSummary[], start: number, end: number): number {
  let error = -1;
  for (let index = start; index <= end; index++) {
    if (turns[index].isLive) return index;
    if (error < 0 && turns[index].hasError) error = index;
  }
  return error >= 0 ? error : Math.floor((start + end) / 2);
}

function rangeMarker(turns: readonly ScrollTurnSummary[], slot: number, start: number, end: number): ScrollMarker {
  const pick = representative(turns, start, end);
  const span = turns.slice(start, end + 1);
  return {
    key: `range:${slot}`,
    targetId: turns[pick].id,
    startIndex: start,
    endIndex: end,
    totalTurns: turns.length,
    active: false,
    isLive: span.some(turn => turn.isLive),
    hasError: span.some(turn => turn.hasError),
    title: start === end ? `Turn ${start + 1} of ${turns.length}` : `Turns ${start + 1}–${end + 1} of ${turns.length}`,
    preview: turnPreview(turns[pick], pick),
  };
}

/** The markers for `turns`: one per turn when they fit, else first + even middle ranges + last. */
export function buildMarkers(turns: readonly ScrollTurnSummary[], maxSlots: number): ScrollMarker[] {
  const count = turns.length;
  if (count <= maxSlots) return turns.map((_, index) => singleMarker(turns, index));
  const middle = count - 2, buckets = maxSlots - 2;
  const ranges = Array.from({ length: buckets }, (_, slot) => {
    const start = 1 + Math.floor((slot * middle) / buckets);
    const end = Math.floor(((slot + 1) * middle) / buckets);
    return rangeMarker(turns, slot, start, end);
  });
  return [singleMarker(turns, 0), ...ranges, singleMarker(turns, count - 1)];
}

function activeIndexOf(markers: readonly ScrollMarker[], activeTurnIndex: number, atBottom: boolean): number {
  if (!markers.length) return -1;
  if (atBottom) return markers.length - 1;
  const last = markers[markers.length - 1].endIndex;
  const turn = Math.max(0, Math.min(last, Number.isFinite(activeTurnIndex) ? Math.floor(activeTurnIndex) : 0));
  const found = markers.findIndex(marker => turn >= marker.startIndex && turn <= marker.endIndex);
  return found >= 0 ? found : 0;
}

export function buildScrollIndicatorModel(input: ScrollIndicatorInput): ScrollIndicatorState {
  const { turns, hasOlder, atBottom, scrollable } = input;
  const maxSlots = clampSlots(input.maxSlots);
  const base = buildMarkers(turns, maxSlots);
  const activeMarkerIndex = activeIndexOf(base, input.activeTurnIndex, atBottom);
  const markers = base.map((marker, index) => (index === activeMarkerIndex ? { ...marker, active: true } : marker));
  return {
    visible: turns.length >= 2 || hasOlder || (turns.length === 1 && scrollable),
    showEarlier: hasOlder,
    showLatest: !atBottom && scrollable && turns.length > 0,
    markers,
    activeMarkerIndex,
  };
}
