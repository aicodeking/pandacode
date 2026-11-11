import { escape } from '../dom';
import { extensionsSnapshot, onExtensionsChanged, installExtension, enableExtension, uninstallExtension, enterExtensionsSafeMode } from './manager';
import { mountSurfaceExplorer } from './explorer';

export function mountExtensionSettings(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '';
  let cleanupExplorer: (() => void) | undefined;
  const draw = () => {
    if (disposed) return;
    const snapshot = extensionsSnapshot();
    cleanupExplorer?.();
    host.innerHTML = `<p>Local unsigned declarative packages. No scripts or install hooks run. Installation does not enable a package.</p>
      <div class="settings-group"><div class="setting-row"><strong>Local extension</strong><button type="button" class="secondary-button" data-extension-install ${pending || snapshot.safeMode ? 'disabled' : ''}>Install local package</button></div>
      <div class="setting-row"><strong>Recovery</strong><button type="button" class="secondary-button" data-extension-safe ${snapshot.safeMode ? 'disabled' : ''}>Disable extensions for this launch</button></div></div>
      ${snapshot.safeMode ? '<p role="status" tabindex="-1">Safe mode: packages are not loaded. Restart without --safe-mode to restore explicit enable preferences.</p>' : ''}
      <p>Uninstall removes only the package registrations and installation. Extension data, projects, drafts and history are retained.</p>
      ${snapshot.packages.map(item => `<div class="setting-row"><div><strong>${escape(item.manifest.id)}</strong><small>${escape(item.manifest.version)} · Local unsigned · ${item.reason ? 'Failed' : item.enabled ? 'Enabled' : 'Installed — disabled'}</small><small>Owner: ${escape(item.manifest.id)} · ${escape(item.reason ?? (item.enabled ? 'Explicitly enabled' : 'Not enabled by the user'))}</small></div><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-enabled="${!item.enabled}" ${pending ? 'disabled' : ''}>${item.reason ? 'Retry' : item.enabled ? 'Disable' : 'Enable'} ${escape(item.manifest.id)}</button><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-uninstall ${pending ? 'disabled' : ''}>Uninstall ${escape(item.manifest.id)}</button></div>`).join('')}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}${snapshot.diagnostics.map(message => `<p role="status">${escape(message)}</p>`).join('')}<section data-extension-catalog aria-label="Surface explorer"></section>`;
    cleanupExplorer = mountSurfaceExplorer(host.querySelector<HTMLElement>('[data-extension-catalog]')!);
  };
  const click = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-extension-install], [data-extension-safe], [data-extension-id]') : null;
    if (!target || pending || !host.contains(target)) return;
    pending = true; error = ''; draw();
    try {
      if (target.hasAttribute('data-extension-install')) await installExtension();
      else if (target.hasAttribute('data-extension-safe')) await enterExtensionsSafeMode();
      else if (target.dataset.extensionId) {
        if (target.hasAttribute('data-extension-uninstall')) await uninstallExtension(target.dataset.extensionId);
        else await enableExtension(target.dataset.extensionId, target.dataset.extensionEnabled === 'true');
      }
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      pending = false; draw();
      if (!disposed) {
        const replacement = target.dataset.extensionId
          ? [...host.querySelectorAll<HTMLButtonElement>('[data-extension-id]')].find(button => button.dataset.extensionId === target.dataset.extensionId)
          : host.querySelector<HTMLButtonElement>(target.hasAttribute('data-extension-install') ? '[data-extension-install]' : '[data-extension-safe]');
        (replacement && !replacement.disabled ? replacement : host.querySelector<HTMLElement>('[role="status"]') ?? host.querySelector<HTMLElement>('[data-extension-install]'))?.focus({ preventScroll: true });
      }
    }
  };
  const cleanup = onExtensionsChanged(draw); host.addEventListener('click', click); draw();
  return () => { disposed = true; cleanup(); cleanupExplorer?.(); host.removeEventListener('click', click); host.replaceChildren(); };
}
