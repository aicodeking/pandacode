import { escape } from '../dom';
import { extensionsSnapshot, onExtensionsChanged, installExtension, enableExtension, uninstallExtension, enterExtensionsSafeMode, trustExecutable } from './manager';
import { EXECUTABLE_WARNING } from './executable';
import { openExtensionDialog } from './dialogs';
import { mountSurfaceExplorer } from './explorer';
import { mountShortcutSettings } from './shortcut-settings';

export function mountExtensionSettings(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '';
  let cleanupExplorer: (() => void) | undefined;
  let cleanupShortcuts: (() => void) | undefined;
  let closeTrust: (() => void) | undefined;
  const draw = () => {
    if (disposed) return;
    const snapshot = extensionsSnapshot();
    cleanupExplorer?.();
    cleanupShortcuts?.();
    host.innerHTML = `<p>Local unsigned packages. Installation and discovery execute no package code or install hooks. Executable packages require separate content/version-bound trust.</p>
      <div class="settings-group"><div class="setting-row"><strong>Local extension</strong><button type="button" class="secondary-button" data-extension-install ${pending || snapshot.safeMode ? 'disabled' : ''}>Install local package</button></div>
      <div class="setting-row"><strong>Recovery</strong><button type="button" class="secondary-button" data-extension-safe ${snapshot.safeMode ? 'disabled' : ''}>Disable extensions for this launch</button></div></div>
      ${snapshot.safeMode ? '<p role="status" tabindex="-1">Safe mode: packages are not loaded. Restart without --safe-mode to restore explicit enable preferences.</p>' : ''}
      <p>Uninstall removes only the package registrations and installation. Extension data, projects, drafts and history are retained.</p>
      ${snapshot.packages.map(item => `<div class="setting-row"><div><strong>${escape(item.manifest.id)}</strong><small>${escape(item.manifest.version)} · Local unsigned · ${item.reason ? 'Failed' : item.enabled ? 'Enabled' : 'Installed — disabled'}</small><small>Owner: ${escape(item.manifest.id)} · ${escape(item.reason ?? (item.enabled ? 'Explicitly enabled' : 'Not enabled by the user'))}</small></div><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-enabled="${!item.enabled}" ${pending ? 'disabled' : ''}>${item.reason ? 'Retry' : item.enabled ? 'Disable' : 'Enable'} ${escape(item.manifest.id)}</button><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-uninstall ${pending ? 'disabled' : ''}>Uninstall ${escape(item.manifest.id)}</button></div>`).join('')}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}${snapshot.diagnostics.map(message => `<p role="status">${escape(message)}</p>`).join('')}<section data-extension-shortcuts aria-label="Extension shortcuts"></section><section data-extension-catalog aria-label="Surface explorer"></section>`;
    for (const item of snapshot.packages.filter(item => item.executable)) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary-button'; node.dataset.extensionId = item.manifest.id; node.dataset.extensionTrust = '';
      node.textContent = `${item.executable!.trusted ? 'Revoke executable trust' : 'Review executable trust'} ${item.manifest.id}`; node.disabled = pending;
      [...host.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]')].find(button => button.dataset.extensionId === item.manifest.id)?.after(node);
    }
    cleanupExplorer = mountSurfaceExplorer(host.querySelector<HTMLElement>('[data-extension-catalog]')!);
    cleanupShortcuts = mountShortcutSettings(host.querySelector<HTMLElement>('[data-extension-shortcuts]')!);
  };
  const click = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-extension-install], [data-extension-safe], [data-extension-id]') : null;
    if (!target || pending || !host.contains(target)) return;
    pending = true; error = ''; draw();
    try {
      if (target.hasAttribute('data-extension-install')) await installExtension();
      else if (target.hasAttribute('data-extension-safe')) await enterExtensionsSafeMode();
      else if (target.dataset.extensionId) {
        if (target.hasAttribute('data-extension-trust')) {
          const item = extensionsSnapshot().packages.find(item => item.manifest.id === target.dataset.extensionId);
          if (!item?.executable) throw new Error('StaleContext');
          if (item.executable.trusted) await trustExecutable(item.manifest.id, item.executable.digest, false);
          else {
            const transient = openExtensionDialog({ title: 'Trust executable extension?', fields: [], confirmation: 'Trust this exact version and executable content with your normal account authority?', confirmLabel: 'Review full authority', successMessage: 'Executable trust recorded' }, { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', revision: 1 }, 'panda.core', target);
            closeTrust = transient.close;
            // The warning must be visible before the first confirmation, not hidden behind a tooltip.
            const warning = document.createElement('p'); warning.textContent = `${item.manifest.id} ${item.manifest.version} · SHA-256 ${item.executable.digest}\n${EXECUTABLE_WARNING}`;
            document.querySelector('#dialog[aria-label="Trust executable extension? — panda.core"] .dialog-heading')?.after(warning);
            const result = await transient.result;
            if (closeTrust === transient.close) closeTrust = undefined;
            if (disposed) return;
            await trustExecutable(item.manifest.id, item.executable.digest, result.kind === 'confirmed');
          }
        }
        else if (target.hasAttribute('data-extension-uninstall')) await uninstallExtension(target.dataset.extensionId);
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
  return () => { disposed = true; closeTrust?.(); cleanup(); cleanupExplorer?.(); cleanupShortcuts?.(); host.removeEventListener('click', click); host.replaceChildren(); };
}
