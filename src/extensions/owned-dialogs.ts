/** Host seam for module-owned and directly mounted dialogs (docs/extensions/owned-dialogs.md). Synchronous and
 * light: the band and its extension machinery load lazily, and the dialog stays complete if they never do. */
import type { DialogRequest } from './dialog-accessory';

export type { DialogRequest };
export type OwnedDialogHost = {
  /** The host node this opening put in the dialog; the band lives only while it is there. */
  owner: HTMLElement;
  /** Where the band goes when the host draws its own plate inside the dialog (default: the dialog). */
  container?: HTMLElement;
  /** Extra liveness the host already tracks (a closing animation, a disposed view). */
  alive?: () => boolean;
  notify?: (message: string) => void;
};
const openings = new Map<string, number>();

/** Attaches the extension band to one opening of a dialog its module mounted itself and returns a disposer
 * that works at once. The accessory is captured from `request`, never from the current task or modal. */
export function attachDialogExtras(dialog: HTMLDialogElement, request: DialogRequest, host: OwnedDialogHost): () => void {
  const opening = (openings.get(request.dialog) ?? 0) + 1;
  openings.set(request.dialog, opening);
  const captured = { ...request };
  let disposed = false, cleanup: (() => void) | undefined;
  const live = () => !disposed && dialog.open && host.owner.isConnected && dialog.contains(host.owner) && (host.alive?.() ?? true);
  void import('./dialog-extras').then(({ mountOwnedDialogExtras }) => {
    if (!live()) return;
    cleanup = mountOwnedDialogExtras(dialog, captured, `${captured.dialog}/${opening}`, opening, live, { container: host.container, notify: host.notify });
  }).catch(() => { /* The host dialog stays complete without its extension band. */ });
  return () => { if (disposed) return; disposed = true; cleanup?.(); cleanup = undefined; };
}
