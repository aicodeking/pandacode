import { extensionsSnapshot, onExtensionsChanged } from './manager';
import { mountExtensionActions } from './header';
import { admitDialogAccessory, dialogActionsLocation, dialogBodyLocation, dialogContext, isEligibleDialog, MAX_DIALOG_BODY_EXTRAS, type DialogAccessory } from './dialog-accessory';

/** Mounts one owner-labelled band after the host content of an eligible main modal. The host's fields,
 * primary action, confirmation and focus stay where the host put them; the band is outside every form,
 * so Enter or a pending submit never reaches it. Close, replacement, disable and safe mode dispose it. */
export function mountMainDialogExtras(dialog: HTMLDialogElement, accessory: DialogAccessory, notify: (message: string) => void, live: () => DialogAccessory | undefined): () => void {
  if (!isEligibleDialog(accessory.dialog)) throw new Error('Protected or unsupported dialog.');
  const captured: DialogAccessory = Object.freeze(structuredClone(accessory));
  if (!admitDialogAccessory(captured, live()).ok) throw new Error('Stale dialog accessory.');
  const band = document.createElement('section'), body = document.createElement('div'), actions = document.createElement('div');
  band.className = 'dialog-extension-extras'; band.dataset.dialogAccessory = captured.dialog; band.setAttribute('aria-label', 'Extension additions');
  body.className = 'dialog-extension-notes'; body.dataset.extensionLocation = dialogBodyLocation(captured.dialog);
  actions.className = 'extension-action-slot';
  band.append(body, actions); dialog.append(band);
  let disposed = false;
  const active = () => admitDialogAccessory(captured, live()).ok;
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
  const cleanupActions = mountExtensionActions(actions, dialogActionsLocation(captured.dialog), () => structuredClone(context), notify, undefined, active);
  draw();
  // An owner that replaces its loading view (dialog.replaceChildren) drops the band; put it back last.
  // Menus and tooltips appended to the open dialog leave it where it is, so a focused band control keeps focus.
  const observer = new MutationObserver(() => { if (!disposed && dialog.open && active() && band.parentElement !== dialog) dialog.append(band); });
  observer.observe(dialog, { childList: true });
  const cleanup = () => { if (disposed) return; disposed = true; observer.disconnect(); unsubscribe(); cleanupActions(); band.remove(); dialog.removeEventListener('close', closed); };
  // The close event is queued; a late one from the previous opening must not dispose this band.
  const closed = () => { if (!dialog.open) cleanup(); };
  dialog.addEventListener('close', closed);
  return cleanup;
}
