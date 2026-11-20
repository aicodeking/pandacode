/* Each project's own app icon (its favicon or app icon, found natively by `project_icon`),
 * loaded once per project and cached for the session. Rows render the default icon until
 * it arrives, then the sidebar redraws. */
import { escape } from './dom';

const icons = new Map<string, string | null>();
const pending = new Set<string>();

/** The project's icon markup: its own image when it has one, else a quiet default tile. */
export function projectIconHtml(projectId: string, name: string, load: (projectId: string) => Promise<string | null>, loaded: () => void): string {
  const known = icons.get(projectId);
  if (known === undefined && !pending.has(projectId)) {
    pending.add(projectId);
    load(projectId)
      .then(icon => (icon && icon.startsWith('data:image/') ? trimIcon(icon) : null))
      .then(icon => { icons.set(projectId, icon); })
      .catch(() => { icons.set(projectId, null); })
      .finally(() => { pending.delete(projectId); loaded(); });
  }
  if (known) return `<img class="task-app-icon" src="${escape(known)}" alt="" aria-hidden="true" draggable="false" decoding="sync">`;
  const initial = (name.trim()[0] ?? '·').toUpperCase();
  return `<span class="task-app-icon task-app-default" data-initial="${escape(initial)}" aria-hidden="true"></span>`;
}

/** Forget a project's icon so it is looked up again (after it changes on disk). */
export function forgetProjectIcon(projectId: string): void { icons.delete(projectId); }

/** Below this share of transparent margin on every side, an icon is left as it is. */
const MIN_MARGIN = 0.04;

/** Crops a raster icon's transparent margin (macOS app icons keep ~10% on each side), so
 * every project's icon fills its tile at the same visual size. The crop stays square and
 * centred on the artwork. SVGs, opaque icons and anything that fails to decode are
 * returned unchanged. */
async function trimIcon(url: string): Promise<string> {
  if (url.startsWith('data:image/svg')) return url;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const w = image.naturalWidth, h = image.naturalHeight;
    if (!w || !h) return url;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return url;
    context.drawImage(image, 0, 0);
    const alpha = context.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[(y * w + x) * 4 + 3] > 24) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return url;
    const side = Math.max(maxX - minX + 1, maxY - minY + 1);
    if (side > Math.max(w, h) * (1 - 2 * MIN_MARGIN)) return url;
    const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2;
    const out = document.createElement('canvas');
    out.width = side;
    out.height = side;
    out.getContext('2d')?.drawImage(canvas, Math.round(cx - side / 2), Math.round(cy - side / 2), side, side, 0, 0, side, side);
    return out.toDataURL('image/png');
  } catch {
    return url;
  }
}
