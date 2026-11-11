// Host calls for the `design` feature group (src-tauri/src/remote/methods/design.rs): the Design
// canvas's artboards in a project's or a task's checkout, a rendered preview of one, and comments
// pinned on it. See docs/remote-access.md, "Adding a method".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { assembleData, type DataPage } from '../../store/files.ts';
import type { FileTarget } from './files.ts';

export const DESIGN_METHODS = registerMethods(['design.list', 'design.read', 'design.preview', 'design.comments', 'design.comment', 'design.resolve'] as const);

export interface Artboard { name: string; size: number; modified: number }
export interface DesignList {
  artboards: Artboard[];
  /** Open comments per artboard name. */
  open: Record<string, number>;
  /** Whether the computer can render previews (a Mac). */
  preview: boolean;
}
export interface Bbox { x: number; y: number; width: number; height: number }
export interface DesignComment {
  id: string; artboard: string; selector: string; bbox: Bbox; text: string;
  status: 'open' | 'resolved'; createdAt: number; note?: string;
}
/** A rendered artboard: a `data:` PNG and its pixels per CSS pixel. */
export interface DesignPreview { uri: string; scale: number }
type PreviewPage = DataPage & { scale?: number };

const target = (t: FileTarget) => (t.sessionId ? { sessionId: t.sessionId } : { projectId: t.projectId });

export const listDesigns = (deviceId: string, t: FileTarget) => hostCall<DesignList>(deviceId, 'design.list', target(t));

export const listComments = (deviceId: string, t: FileTarget, artboard?: string) =>
  hostCall<{ comments: DesignComment[]; truncated: boolean }>(deviceId, 'design.comments', { ...target(t), ...(artboard ? { artboard } : {}) });

/** The artboard rendered on the computer, fetched in pages. */
export async function previewArtboard(deviceId: string, t: FileTarget, name: string): Promise<DesignPreview> {
  let scale = 1;
  const uri = await assembleData(async offset => {
    const page = await hostCall<PreviewPage>(deviceId, 'design.preview', { ...target(t), name, offset }, { background: true, timeoutMs: 40_000 });
    if (offset === 0 && typeof page.scale === 'number' && page.scale > 0) scale = page.scale;
    return page;
  });
  return { uri, scale };
}

/** A pin at (`x`, `y`) in the artboard's CSS pixels. */
export const addComment = (deviceId: string, t: FileTarget, artboard: string, x: number, y: number, text: string) =>
  hostCall<{ comment: DesignComment }>(deviceId, 'design.comment', { ...target(t), artboard, x, y, text }).then(r => r.comment);

export const setCommentStatus = (deviceId: string, t: FileTarget, commentId: string, status: 'open' | 'resolved') =>
  hostCall<{ comment: DesignComment }>(deviceId, 'design.resolve', { ...target(t), commentId, status }).then(r => r.comment);
