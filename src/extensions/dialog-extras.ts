import { extensionsSnapshot, onExtensionsChanged } from './manager';
import { mountExtensionActions } from './header';
import type { Json } from './contracts';

/** Only these two low-risk hosts opt in. Permission, privacy and recovery never call this adapter. */
export const DIALOG_CONTRACTS = {
  colors: { body: 'panda.dialog.colors.bodyExtras', actions: 'panda.dialog.colors.actions' },
  wallpapers: { body: 'panda.dialog.wallpapers.bodyExtras', actions: 'panda.dialog.wallpapers.actions' },
} as const;
export function mountNamedDialogExtras(dialog: HTMLDialogElement, name: keyof typeof DIALOG_CONTRACTS, context: Record<string, Json>, notify: (message: string) => void): () => void {
  const contract = DIALOG_CONTRACTS[name];
  if (!contract) throw new Error('Protected or unsupported dialog.');
  const body = document.createElement('section'), actions = document.createElement('div');
  body.dataset.extensionLocation = contract.body; body.setAttribute('aria-label', 'Extension notes');
  actions.className = 'extension-action-slot'; dialog.querySelector('.dialog-footer')?.before(body, actions);
  const draw = () => {
    body.replaceChildren(); const snapshot = extensionsSnapshot();
    if (snapshot.safeMode) return;
    for (const item of snapshot.packages.filter(item => item.enabled)) for (const extra of item.manifest.contributes.dialogExtras ?? []) {
      if (extra.dialog !== name) continue;
      const note = document.createElement('p'); note.dataset.extensionContribution = extra.id; note.textContent = `${item.manifest.id}: ${extra.text}`; body.append(note);
    }
  };
  const captured = structuredClone(context), unsubscribe = onExtensionsChanged(draw);
  const cleanupActions = mountExtensionActions(actions, contract.actions, () => captured, notify); draw();
  let disposed = false;
  const cleanup = () => { if (disposed) return; disposed = true; unsubscribe(); cleanupActions(); body.remove(); actions.remove(); dialog.removeEventListener('close', cleanup); };
  dialog.addEventListener('close', cleanup, { once: true });
  return cleanup;
}
