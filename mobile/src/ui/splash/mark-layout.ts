// Where the intro's mark sits, from the letters' measured spans: pure, for the tests. The mark's
// coordinates are the header brand's times WORD_SCALE.
import { BASELINE, BOX_HEIGHT, HALF_WIDTH, PANDA_SIZE, REST_GAP } from '../brand/geometry.ts';
import { START_SCALE, WORD_SCALE, type Point } from './timeline.ts';

const K = WORD_SCALE;
/** Keep this far inside the window's edges when placing the mark. */
const MARGIN = 10;
/** The launch panda takes off over the third letter, so the leap runs along most of the word. */
const TAKE_OFF = 2;

export interface Span { left: number; width: number }
export interface Size { width: number; height: number }
/** Where the header brand draws its letters (left edges) and its panda (feet x), in its own coordinates. */
export interface Placement { lefts: readonly number[]; home: number }
export interface MarkLayout { width: number; height: number; home: number; centres: readonly number[] }

/** The mark's size, the panda's home (feet x) and the letters' centres. */
export function markLayout(spans: readonly Span[]): MarkLayout {
  const last = spans[spans.length - 1];
  const home = last.left + last.width + K * (REST_GAP + HALF_WIDTH);
  return { width: home + K * HALF_WIDTH, height: K * BOX_HEIGHT, home, centres: spans.map(s => s.left + s.width / 2) };
}

/**
 * The mark's top left at rest. The launch panda (its START_SCALE box centred in the window) stands on
 * the word's baseline over its take-off letter; the mark is kept inside the window's margins.
 */
export function markRest(window: Size, layout: MarkLayout): Point {
  const x = window.width / 2 - layout.centres[TAKE_OFF];
  const feet = window.height / 2 + (START_SCALE * PANDA_SIZE) / 2;
  return { x: Math.max(MARGIN, Math.min(x, window.width - MARGIN - layout.width)), y: feet - K * BASELINE };
}

/** The launch panda's feet in the mark's coordinates. */
export function launchFeet(window: Size, rest: Point): Point {
  return { x: window.width / 2 - rest.x, y: window.height / 2 - rest.y + (START_SCALE * PANDA_SIZE) / 2 };
}
