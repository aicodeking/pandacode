import { extensionsSnapshot, onExtensionsChanged } from './manager';
import { mountExtensionActions } from './header';
import { admitDialogAccessory, dialogActionsLocation, dialogBodyLocation, dialogContext, isEligibleDialog, MAX_DIALOG_BODY_EXTRAS, ownedDialogAccessory, type DialogAccessory, type DialogRequest } from './dialog-accessory';

/** Mounts one owner-labelled band after the host content of an eligible dialog. The host's fields,
 * primary action, confirmation and focus stay where the host put them; the band is outside every form,
 * so Enter or a pending submit never reaches it. Close, replacement, disable and safe mode dispose it.
 * `container` is where the band goes (the dialog itself unless the host draws its own plate inside it);
 * without `notify`, action messages show in the band's own status line. */
export function mountMainDialogExtras(dialog: HTMLDialogElement, accessory: DialogAccessory, notify: ((message: string) => void) | undefined, live: () => DialogAccessory | undefined, container: HTMLElement = dialog): () => void {
  if (!isEligibleDialog(accessory.dialog)) throw new Error('Protected or unsupported dialog.');
  const captured: DialogAccessory = Object.freeze(structuredClone(accessory));
  if (!admitDialogAccessory(captured, live()).ok) throw new Error('Stale dialog accessory.');
  const band = document.createElement('section'), body = document.createElement('div'), actions = document.createElement('div');
  band.className = 'dialog-extension-extras'; band.dataset.dialogAccessory = captured.dialog; band.setAttribute('aria-label', 'Extension additions');
  body.className = 'dialog-extension-notes'; body.dataset.extensionLocation = dialogBodyLocation(captured.dialog);
  actions.className = 'extension-action-slot';
  band.append(body, actions); container.append(band);
  let status: HTMLElement | undefined;
  const show = notify ?? ((message: string) => {
    if (!status) { status = document.createElement('p'); status.className = 'dialog-extension-status'; status.setAttribute('role', 'status'); band.append(status); }
    status.textContent = message;
  });
  let disposed = false;
  const active = () => !disposed && admitDialogAccessory(captured, live()).ok;
  const draw = () => {
    body.replaceChildren(); const snapshot = extensionsSnapshot();
    if (snapshot.safeMode || !active()) return;
    const notes = snapshot.packages.filter(item => item.enabled && item.manifest.permissions?.includes('ui.contribute'))
      .flatMap(item => (item.manifest.contributes.dialogExtras ?? []).filter(extra => extra.dialog === captured.dialog).map(extra => ({ owner: item.manifest.id, extra })));
    for (const { owner, extra } of notes.slice(0, MAX_DIALOG_BODY_EXTRAS)) {
      const note = document.createElement('p'); note.dataset.extensionContribution = extra.id; note.textContent = `${owner}: ${extra.text}`; body.append(note);
    }
    if (notes.length > MAX_DIALOG_BODY_EXTRAS) {
      const more = document.createElement('p'); more.className = 'dialog-extension-omitted';
      more.textContent = `${notes.length - MAX_DIALOG_BODY_EXTRAS} more extension notes are not shown.`; body.append(more);
    }
  };
  const context = dialogContext(captured);
  const unsubscribe = onExtensionsChanged(draw);
  const cleanupActions = mountExtensionActions(actions, dialogActionsLocation(captured.dialog), () => structuredClone(context), message => { if (active()) show(message); }, undefined, active);
  draw();
  // An owner that replaces its loading view (replaceChildren) drops the band; put it back last. A host that
  // replaced the whole dialog with another opening makes the capture stale: then only the band is disposed.
  // Menus and tooltips appended to the open dialog leave it where it is, so a focused band control keeps focus.
  const observer = new MutationObserver(() => {
    if (disposed) return;
    if (!active()) { cleanup(); return; }
    if (band.parentElement !== container) container.append(band);
  });
  observer.observe(container, { childList: true });
  const cleanup = () => { if (disposed) return; disposed = true; observer.disconnect(); unsubscribe(); cleanupActions(); band.remove(); dialog.removeEventListener('close', closed); };
  // The close event is queued; a late one from the previous opening must not dispose this band.
  const closed = () => { if (!dialog.open || !live()) cleanup(); };
  dialog.addEventListener('close', closed);
  return cleanup;
}

/** Accessories of module-owned and direct dialogs that are mounted now (browser fixtures read them). */
const ownedAccessories = new Map<DialogAccessory, () => boolean>();
export function liveOwnedAccessories(): DialogAccessory[] {
  for (const [accessory, live] of ownedAccessories) if (!live()) ownedAccessories.delete(accessory);
  return [...ownedAccessories.keys()];
}
/** Same band for a dialog its module mounted itself: the accessory comes from the module's own request and
 * the given opening, never from the global main modal. `live` says whether that one opening still owns the dialog. */
export function mountOwnedDialogExtras(dialog: HTMLDialogElement, request: DialogRequest, mount: string, opening: number, live: () => boolean, options: { container?: HTMLElement; notify?: (message: string) => void } = {}): () => void {
  const accessory = ownedDialogAccessory(request, mount, opening);
  const current = () => live() ? accessory : undefined;
  const cleanup = mountMainDialogExtras(dialog, accessory, options.notify, current, options.container);
  ownedAccessories.set(accessory, live);
  return () => { ownedAccessories.delete(accessory); cleanup(); };
}
