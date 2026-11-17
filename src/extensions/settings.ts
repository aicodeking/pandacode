import { escape } from '../dom';
import { stageExtensionUpdate, reviewExtensionUpdate, rollbackExtensionUpdate, loadExtensions } from './manager';
import { extensionsManagementSnapshot as extensionsSnapshot, onExtensionsChanged, installExtension, setExtensionProjectScope, extensionProjects, extensionsActiveProject, enableExtension, uninstallExtension, enterExtensionsSafeMode, trustExecutable, selectDevelopmentExtension, reloadDevelopmentExtension, grantExtensionStorage, removeExtensionOwnData } from './manager';
import { EXECUTABLE_WARNING } from './executable';
import { openExtensionDialog } from './dialogs';
import { mountGrantsManager } from './runtime-grants-manager';
import { mountRunningServices } from './runtime-service-status';
import { mountSurfaceExplorer } from './explorer';
import { mountShortcutSettings } from './shortcut-settings';

const projectName = (id: string) => extensionProjects().find(project => project.id === id)?.name;
function scopeSummary(projects: string[] | undefined): string {
  return projects ? `Projects: ${projects.map(id => projectName(id) ?? `unavailable project ${id}`).join(', ')}` : 'Projects: all projects';
}
/** Project scope of enablement: native radios and checkboxes, so keyboard and screen readers work unchanged. */
function scopeControl(id: string, projects: string[] | undefined, disabled: boolean): string {
  const known = extensionProjects(), listed = [...known.map(project => project.id), ...(projects ?? []).filter(project => !known.some(item => item.id === project))];
  const owner = escape(id), off = disabled ? 'disabled' : '';
  const choices = listed.map(project => `<label><input type="checkbox" data-scope-owner="${owner}" data-scope-project="${escape(project)}" ${projects?.includes(project) ? 'checked' : ''} ${off}> ${escape(projectName(project) ?? `Unavailable project ${project}`)}</label>`).join('');
  return `<fieldset class="setting-row" data-extension-scope="${owner}"><legend>Projects for ${owner}</legend>
    <label><input type="radio" name="extension-scope-${owner}" data-scope-owner="${owner}" data-scope-mode="all" ${projects ? '' : 'checked'} ${off}> All projects</label>
    <label><input type="radio" name="extension-scope-${owner}" data-scope-owner="${owner}" data-scope-mode="selected" ${projects ? 'checked' : ''} ${off}> Only selected projects</label>
    ${projects ? `<div role="group" aria-label="Selected projects for ${owner}">${choices}</div>` : ''}</fieldset>`;
}
export function mountExtensionSettings(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '';
  let cleanupGrants: (() => void) | undefined;
  let cleanupRunning: (() => void) | undefined;
  let cleanupExplorer: (() => void) | undefined;
  let cleanupShortcuts: (() => void) | undefined;
  let closeTrust: (() => void) | undefined;
  const draw = () => {
    if (disposed) return;
    const snapshot = extensionsSnapshot();
    cleanupGrants?.();
    cleanupRunning?.();
    cleanupExplorer?.();
    cleanupShortcuts?.();
    host.innerHTML = `<p>Local unsigned packages. Installation and discovery execute no package code or install hooks. Executable packages require separate content/version-bound trust.</p>
      <div class="settings-group"><div class="setting-row"><strong>Local extension</strong><button type="button" class="secondary-button" data-extension-install ${pending || snapshot.safeMode ? 'disabled' : ''}>Install local package</button></div>
      <div class="setting-row"><strong>Recovery</strong><button type="button" class="secondary-button" data-extension-safe ${snapshot.safeMode ? 'disabled' : ''}>Disable extensions for this launch</button></div></div>
      <section aria-label="Extension development"><h3>Trusted extension development</h3><p>Select a built package folder explicitly for this launch. Selection never runs code. Reload affects only the selected extension; changed content requires new executable trust. Raw package output, file paths and credentials are omitted from these bounded host logs.</p><button type="button" class="secondary-button" data-extension-development ${pending || snapshot.safeMode ? 'disabled' : ''}>Select development folder</button>
      ${(snapshot.development ?? []).map(dev => `<div class="setting-row"><strong>${escape(dev.id)}</strong><button type="button" class="secondary-button" data-extension-id="${escape(dev.id)}" data-extension-reload ${pending ? 'disabled' : ''}>Reload ${escape(dev.id)}</button></div><pre role="log" aria-label="Development logs ${escape(dev.id)}">${escape(dev.logs.join('\n'))}</pre>`).join('')}</section>
      ${snapshot.safeMode ? '<p role="status" tabindex="-1">Safe mode: packages are not loaded. Restart without --safe-mode to restore explicit enable preferences.</p>' : ''}
      <p>Uninstall retains private data by default. The separate “Uninstall and remove private data” action requires confirmation for only that extension’s private settings and storage. Projects, drafts and history are never removed. Storage grants constrain the public API, not independent file access by trusted native code.</p>
      ${snapshot.packages.map(item => `<div class="setting-row"><div><strong>${escape(item.manifest.id)}</strong><small>${escape(item.manifest.version)} · Local unsigned · ${item.reason ? 'Failed' : item.enabled ? 'Enabled' : 'Installed — disabled'}</small><small>Owner: ${escape(item.manifest.id)} · ${escape(item.reason ?? (item.enabled ? 'Explicitly enabled' : 'Not enabled by the user'))} · ${escape(scopeSummary(item.projects))}</small></div><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-enabled="${!item.enabled}" ${pending ? 'disabled' : ''}>${item.reason ? 'Retry' : item.enabled ? 'Disable' : 'Enable'} ${escape(item.manifest.id)}</button><button type="button" class="secondary-button" data-extension-id="${escape(item.manifest.id)}" data-extension-uninstall ${pending ? 'disabled' : ''}>Uninstall ${escape(item.manifest.id)}</button></div>${scopeControl(item.manifest.id, item.projects, pending || snapshot.safeMode)}`).join('')}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}${snapshot.diagnostics.map(message => `<p role="status">${escape(message)}</p>`).join('')}<section data-extension-running aria-label="Running extension services"></section><section data-extension-grants aria-label="Extension permissions"></section><section data-extension-shortcuts aria-label="Extension shortcuts"></section><section data-extension-catalog aria-label="Surface explorer"></section>`;
    for (const item of snapshot.packages.filter(item => item.executable)) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary-button'; node.dataset.extensionId = item.manifest.id; node.dataset.extensionTrust = '';
      node.textContent = `${item.executable!.trusted ? 'Revoke executable trust' : 'Review executable trust'} ${item.manifest.id}`; node.disabled = pending;
      [...host.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]')].find(button => button.dataset.extensionId === item.manifest.id)?.after(node);
    }
    for (const item of snapshot.packages.filter(item => item.manifest.permissions?.includes('storage.private'))) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary-button'; node.dataset.extensionId = item.manifest.id; node.dataset.extensionStorage = String(!item.storageGranted);
      node.textContent = `${item.storageGranted ? 'Revoke' : 'Allow'} private storage ${item.manifest.id}`; node.disabled = pending;
      [...host.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]')].find(button => button.dataset.extensionId === item.manifest.id)?.after(node);
    }
    for (const item of snapshot.packages) {
      const anchor = [...host.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]')].find(button => button.dataset.extensionId === item.manifest.id);
      const action = (attribute: string, text: string, disabled = false) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.dataset.extensionId = item.manifest.id; button.setAttribute(attribute, ''); button.textContent = `${text} ${item.manifest.id}`; button.disabled = pending || disabled; anchor?.after(button);
      };
      action('data-extension-update', 'Stage update', !!item.update?.digest || !!item.update?.draining);
      if (item.update) {
        const status = document.createElement('p'); status.setAttribute('role', 'status'); status.tabIndex = -1; status.textContent = `${item.manifest.id}: ${item.update.reason}. Pinned provider runs: ${item.update.pinned}.`;
        anchor?.before(status);
        if (item.update.digest && !item.update.draining) action('data-extension-review-update', 'Review staged update');
        if (item.update.rollback || item.update.digest) action('data-extension-rollback', item.update.digest ? 'Discard staged update' : 'Roll back', item.update.pinned > 0);
      }
      const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary-button'; node.dataset.extensionId = item.manifest.id; node.dataset.extensionRemoveData = '';
      node.textContent = `Uninstall and remove private data ${item.manifest.id}`; node.disabled = pending;
      [...host.querySelectorAll<HTMLButtonElement>('[data-extension-uninstall]')].find(button => button.dataset.extensionId === item.manifest.id)?.after(node);
    }
    cleanupRunning = mountRunningServices(host.querySelector<HTMLElement>('[data-extension-running]')!);
    cleanupGrants = mountGrantsManager(host.querySelector<HTMLElement>('[data-extension-grants]')!);
    cleanupExplorer = mountSurfaceExplorer(host.querySelector<HTMLElement>('[data-extension-catalog]')!);
    cleanupShortcuts = mountShortcutSettings(host.querySelector<HTMLElement>('[data-extension-shortcuts]')!);
  };
  const click = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-extension-install], [data-extension-development], [data-extension-safe], [data-extension-id]') : null;
    if (!target || pending || !host.contains(target)) return;
    pending = true; error = ''; draw();
    try {
      if (target.hasAttribute('data-extension-install')) await installExtension();
      else if (target.hasAttribute('data-extension-development')) await selectDevelopmentExtension();
      else if (target.hasAttribute('data-extension-safe')) await enterExtensionsSafeMode();
      else if (target.dataset.extensionId) {
        if (target.hasAttribute('data-extension-update')) await stageExtensionUpdate(target.dataset.extensionId);
        else if (target.hasAttribute('data-extension-rollback')) await rollbackExtensionUpdate(target.dataset.extensionId);
        else if (target.hasAttribute('data-extension-review-update')) {
          const item = extensionsSnapshot().packages.find(item => item.manifest.id === target.dataset.extensionId);
          const update = item?.update;
          if (!item || !update?.digest) throw new Error('StaleContext');
          const transient = openExtensionDialog({ title: 'Review extension update', fields: [], confirmation: 'Activate this exact reviewed package when active provider runs finish?', confirmLabel: 'Approve reviewed update', successMessage: 'Update approved' }, { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', revision: 1 }, 'panda.core', target);
          closeTrust = transient.close;
          const warning = document.createElement('p'); warning.textContent = `${item.manifest.id}: ${item.manifest.version} → ${update.version} · SHA-256 ${update.digest}. Added API permissions: ${update.addedPermissions.join(', ') || 'none'}. ${update.executable ? EXECUTABLE_WARNING : 'Declarative package; no native executable entrypoint.'}`;
          document.querySelector('#dialog[aria-label="Review extension update — panda.core"] .dialog-heading')?.after(warning);
          const result = await transient.result;
          if (closeTrust === transient.close) closeTrust = undefined;
          if (!disposed && result.kind === 'confirmed') await reviewExtensionUpdate(item.manifest.id, update.digest);
        }
        else if (target.hasAttribute('data-extension-storage')) await grantExtensionStorage(target.dataset.extensionId, target.dataset.extensionStorage === 'true');
        else if (target.hasAttribute('data-extension-reload')) await reloadDevelopmentExtension(target.dataset.extensionId);
        else if (target.hasAttribute('data-extension-trust')) {
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
        else if (target.hasAttribute('data-extension-remove-data')) {
          const id = target.dataset.extensionId;
          const transient = openExtensionDialog({ title: 'Uninstall extension?', fields: [{ id: 'remove-data', kind: 'switch', label: `Also remove only ${id} private settings and storage`, value: false }], confirmLabel: 'Uninstall extension', successMessage: 'Extension uninstalled' }, { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', revision: 1 }, 'panda.core', target);
          closeTrust = transient.close;
          const result = await transient.result;
          if (closeTrust === transient.close) closeTrust = undefined;
          if (disposed || result.kind !== 'confirmed') return;
          await uninstallExtension(id);
          if (result.values['remove-data'] === true) await removeExtensionOwnData(id);
        }
        else await enableExtension(target.dataset.extensionId, target.dataset.extensionEnabled === 'true');
      }
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      pending = false; draw();
      if (!disposed) {
        const replacement = target.dataset.extensionId
          ? [...host.querySelectorAll<HTMLButtonElement>('[data-extension-id]')].find(button => button.dataset.extensionId === target.dataset.extensionId && ['data-extension-update', 'data-extension-review-update', 'data-extension-rollback', 'data-extension-remove-data', 'data-extension-trust', 'data-extension-storage', 'data-extension-uninstall', 'data-extension-reload', 'data-extension-enabled'].every(attribute => button.hasAttribute(attribute) === target.hasAttribute(attribute)))
          : host.querySelector<HTMLButtonElement>(target.hasAttribute('data-extension-install') ? '[data-extension-install]' : target.hasAttribute('data-extension-development') ? '[data-extension-development]' : '[data-extension-safe]');
        (replacement && !replacement.disabled ? replacement : host.querySelector<HTMLElement>('[role="status"]') ?? host.querySelector<HTMLElement>('[data-extension-install]'))?.focus({ preventScroll: true });
      }
    }
  };
  const change = async (event: Event) => {
    const input = event.target instanceof HTMLInputElement && host.contains(event.target) ? event.target : null;
    const owner = input?.dataset.scopeOwner;
    if (!input || !owner || pending) return;
    const current = extensionsSnapshot().packages.find(item => item.manifest.id === owner)?.projects;
    let next: string[] | null | undefined;
    if (input.dataset.scopeMode === 'all') next = null;
    else if (input.dataset.scopeMode === 'selected') {
      const active = extensionsActiveProject(), first = active && extensionProjects().some(project => project.id === active) ? active : extensionProjects()[0]?.id;
      if (current) return;
      if (!first) { error = 'Open a project first, then choose it for this extension.'; draw(); return; }
      next = [first];
    } else if (input.dataset.scopeProject) {
      const project = input.dataset.scopeProject, selected = current ?? [];
      next = input.checked ? [...selected.filter(id => id !== project), project] : selected.filter(id => id !== project);
      if (!next.length) { error = 'Keep at least one project, or choose All projects.'; draw(); refocus(input); return; }
    }
    if (next === undefined) return;
    pending = true; error = ''; draw();
    try { await setExtensionProjectScope(owner, next); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { pending = false; draw(); refocus(input); }
  };
  const refocus = (input: HTMLInputElement) => {
    if (disposed) return;
    const match = [...host.querySelectorAll<HTMLInputElement>('input[data-scope-owner]')].find(candidate => candidate.dataset.scopeOwner === input.dataset.scopeOwner && candidate.dataset.scopeMode === input.dataset.scopeMode && candidate.dataset.scopeProject === input.dataset.scopeProject);
    (match && !match.disabled ? match : host.querySelector<HTMLElement>('[role="alert"]') ?? host.querySelector<HTMLElement>('[data-extension-install]'))?.focus({ preventScroll: true });
  };
  const cleanup = onExtensionsChanged(draw); host.addEventListener('click', click); host.addEventListener('change', change); draw(); void loadExtensions();
  return () => { disposed = true; closeTrust?.(); cleanup(); cleanupGrants?.(); cleanupRunning?.(); cleanupExplorer?.(); cleanupShortcuts?.(); host.removeEventListener('click', click); host.removeEventListener('change', change); host.replaceChildren(); };
}
