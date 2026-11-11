// Pure geometry and ordering for the Design viewer (src/app/design.tsx): the preview is a PNG the
// computer rendered at `scale` pixels per CSS pixel and the phone shows at `shownWidth` points, so
// a tap maps to the artboard's CSS pixels (what a comment stores) and a comment's box maps back to
// a pin. No React Native here, so tests/design.test.ts runs it in node.
import type { Bbox, DesignComment } from '../../connect/api/design.ts';

export interface PreviewSize { width: number; height: number; scale: number }
export interface Point { x: number; y: number }

/** CSS pixels per shown point. */
const cssPerPoint = (size: PreviewSize, shownWidth: number) => size.width / shownWidth / size.scale;

/** A tap on the shown preview → the artboard's CSS pixels, rounded and kept on the artboard. */
export function tapToArtboard(tap: Point, size: PreviewSize, shownWidth: number): Point {
  if (!(shownWidth > 0) || !(size.width > 0) || !(size.scale > 0)) return { x: 0, y: 0 };
  const ratio = cssPerPoint(size, shownWidth);
  const clamp = (n: number, max: number) => Math.round(Math.min(Math.max(n, 0), max));
  return { x: clamp(tap.x * ratio, size.width / size.scale), y: clamp(tap.y * ratio, size.height / size.scale) };
}

/** Where a comment's pin sits on the shown preview (its box's centre), or null when the preview doesn't reach it. */
export function pinPoint(bbox: Bbox, size: PreviewSize, shownWidth: number): Point | null {
  if (!(shownWidth > 0) || !(size.width > 0) || !(size.scale > 0)) return null;
  const ratio = cssPerPoint(size, shownWidth);
  const x = (bbox.x + bbox.width / 2) / ratio;
  const y = (bbox.y + bbox.height / 2) / ratio;
  const shownHeight = (size.height / size.width) * shownWidth;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > shownWidth || y > shownHeight) return null;
  return { x, y };
}

/** One artboard's comments as the viewer lists them: open first, then oldest first, numbered. */
export function threadOrder(comments: readonly DesignComment[], artboard: string): (DesignComment & { number: number })[] {
  return comments
    .filter(c => c.artboard === artboard)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || a.createdAt - b.createdAt)
    .map((c, i) => ({ ...c, number: i + 1 }));
}

/** "home.html" → "home". */
export const artboardTitle = (name: string) => name.replace(/\.html$/, '');

/** The artboard row's subtitle: open comments, else its size. */
export function artboardSubtitle(open: number, size: number): string {
  if (open > 0) return open === 1 ? '1 open comment' : `${open} open comments`;
  return size < 1024 ? `${size} bytes` : `${Math.round(size / 1024)} KB`;
}

/** What a phone pin names to the agent, said plainly in the thread list. */
export function whereLabel(comment: DesignComment): string {
  const at = `x ${Math.round(comment.bbox.x + comment.bbox.width / 2)}, y ${Math.round(comment.bbox.y + comment.bbox.height / 2)}`;
  return comment.selector === 'body' ? at : `${comment.selector} · ${at}`;
}
