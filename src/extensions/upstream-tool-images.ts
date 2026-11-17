/** Extension band of the tool image viewer (docs/extensions/upstream-tool-images.md). The viewer
 * (src/tool-image-viewer.ts) opens an image the agent viewed; this adapter gives it the shared owned-dialog band
 * (owner-labelled notes and secondary actions) through the existing `attachDialogExtras` seam.
 *
 * Each image shown is its own opening: stepping to another image disposes the band and attaches a new one, so an
 * action captured for the previous image is rejected as stale (`StaleContext`, a new mount and revision) and can
 * never act on the image now shown. The captured target is the thread the image belongs to (an opaque handle);
 * the image bytes and the path never enter the contract. Image loading, authorization (`tool_image`), Copy path
 * and Reveal stay the viewer's own and run exactly as upstream; a package gets no way around them. With no
 * package, a disabled one, a faulted one or safe mode, the band stays empty and hidden and the viewer is upstream's. */
import { attachDialogExtras } from './owned-dialogs';

export const TOOL_IMAGE_VIEWER_DIALOG = 'tool-image-viewer' as const;

export type ToolImageExtras = {
  /** Called when the viewer shows another image (or the first one once it is open): a fresh capture for that image. */
  rebind(session: string): void;
  /** Called when the viewer closes; the band is gone at once and a late reply from it is dropped. */
  dispose(): void;
};

/** `plate` is the viewer's own plate node (the band lives in it while it is in the open dialog); `isLive` is the
 * viewer's own liveness (false once it started closing). */
export function attachToolImageExtras(dialog: HTMLDialogElement, plate: HTMLElement, isLive: () => boolean): ToolImageExtras {
  let detach: (() => void) | undefined, disposed = false;
  const drop = () => { detach?.(); detach = undefined; };
  return {
    rebind(session) {
      drop();
      if (disposed) return;
      detach = attachDialogExtras(dialog, { dialog: TOOL_IMAGE_VIEWER_DIALOG, ...(session ? { task: session } : {}) }, { owner: plate, container: plate, alive: () => !disposed && isLive() });
    },
    dispose() { disposed = true; drop(); },
  };
}
