/** Where up to six thread tiles sit inside the thread area. Pure, so it is unit-tested (tests/tile-layout.test.mjs). */
export const MAX_TILES = 6;
export const MIN_TILE_WIDTH = 260;
export const MIN_TILE_HEIGHT = 220;
export const TILE_GAP = 8;
/** Width over height the layout aims for: slightly tall, so two threads sit side by side rather than stacked. */
const TARGET_ASPECT = .8;

export interface TileRect { left: number; top: number; width: number; height: number }

function rowCounts(tiles: number, rows: number): number[] {
  const base = Math.floor(tiles / rows), extra = tiles % rows;
  return Array.from({ length: rows }, (_, row) => base + (row < extra ? 1 : 0));
}

/** The rects for `tiles` tiles in a `width`×`height` area, or null when they cannot all clear the minimum size.
 * Every rect stays inside the area; rounding leaves the gaps exact. */
export function tileRects(tiles: number, width: number, height: number, gap = TILE_GAP): TileRect[] | null {
  if (tiles <= 0) return [];
  let best: number[] | null = null, bestScore = Infinity;
  for (let rows = 1; rows <= Math.min(tiles, 3); rows++) {
    const counts = rowCounts(tiles, rows);
    const tileHeight = (height - gap * (rows - 1)) / rows, tileWidth = (width - gap * (counts[0] - 1)) / counts[0];
    if (tileWidth < MIN_TILE_WIDTH || tileHeight < MIN_TILE_HEIGHT) continue;
    const score = Math.abs(Math.log(tileWidth / tileHeight / TARGET_ASPECT));
    if (score < bestScore) { best = counts; bestScore = score; }
  }
  if (!best) return null;
  const tileHeight = (height - gap * (best.length - 1)) / best.length;
  return best.flatMap((count, row) => {
    const top = Math.round(row * (tileHeight + gap)), bottom = Math.round(row * (tileHeight + gap) + tileHeight);
    return Array.from({ length: count }, (_, column) => {
      const tileWidth = (width - gap * (count - 1)) / count;
      const left = Math.round(column * (tileWidth + gap)), right = Math.round(column * (tileWidth + gap) + tileWidth);
      return { left, top, width: right - left, height: bottom - top };
    });
  });
}

/** How many tiles fit in the area, at most MAX_TILES. */
export function tilesThatFit(width: number, height: number): number {
  for (let tiles = MAX_TILES; tiles > 1; tiles--) if (tileRects(tiles, width, height)) return tiles;
  return 1;
}

/** The tile nearest a point in the area, and whether the point is on its trailing half: right of its centre, or
 * below it when the tile has a row to itself, where a new tile would go under it. */
export function tileAt(rects: TileRect[], x: number, y: number): { index: number; after: boolean } | null {
  let index = -1, nearest = Infinity;
  rects.forEach((rect, i) => {
    const dx = Math.max(rect.left - x, 0, x - rect.left - rect.width), dy = Math.max(rect.top - y, 0, y - rect.top - rect.height);
    const distance = dx * dx + dy * dy;
    if (distance < nearest) { nearest = distance; index = i; }
  });
  if (index < 0) return null;
  const rect = rects[index], alone = rects.filter(other => other.top === rect.top).length === 1 && rects.length > 1;
  return { index, after: alone ? y > rect.top + rect.height / 2 : x > rect.left + rect.width / 2 };
}
