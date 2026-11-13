/** Synthetic UI recording only; native package transactions are authoritative. */
import type { ExtensionPackage } from './manager';
export function createUpdatePreview() {
  const entries = new Map<string, { pins: number; staged?: ExtensionPackage; previous?: ExtensionPackage; removing?: boolean; approved?: boolean }>();
  const entry = (id: string) => { let value = entries.get(id); if (!value) { value = { pins: 0 }; entries.set(id, value); } return value; };
  const decorate = (packages: ExtensionPackage[]) => {
    for (const item of packages) {
      const value = entries.get(item.manifest.id); if (!value) continue;
      item.update = { version: value.staged?.manifest.version, digest: value.staged ? `preview-update-${value.staged.manifest.version}` : null, addedPermissions: (value.staged?.manifest.permissions ?? []).filter(permission => !item.manifest.permissions?.includes(permission)), executable: !!value.staged?.executable, draining: !!value.removing || !!value.approved, pinned: value.pins, rollback: !!value.previous,
        reason: value.removing ? 'Uninstall pending: active provider version pinned' : value.approved ? 'Reviewed update waiting for provider runs to finish' : value.staged ? 'Staged: explicit permission and executable review required' : 'Prior compatible package/state available for manual rollback' };
    }
    return packages;
  };
  const drain = (packages: ExtensionPackage[], id: string) => {
    const value = entry(id); if (value.pins) return;
    const index = packages.findIndex(item => item.manifest.id === id); if (index < 0) return;
    if (value.removing) { packages.splice(index, 1); entries.delete(id); }
    else if (value.approved && value.staged) {
      value.previous = structuredClone(packages[index]); delete value.previous.update;
      value.staged.enabled = packages[index].enabled;
      packages[index] = value.staged; value.staged = undefined; value.approved = false;
    }
  };
  return {
    decorate,
    stage(packages: ExtensionPackage[], id: string) {
      const item = packages.find(item => item.manifest.id === id); const value = entry(id);
      if (!item || value.staged || value.removing) throw new Error('Conflict');
      value.staged = structuredClone(item); delete value.staged.update;
      value.staged.manifest.version = '1.1.0';
      value.staged.manifest.permissions = [...new Set([...(item.manifest.permissions ?? []), 'tasks.summary'])];
      if (value.staged.executable) value.staged.executable = { digest: 'preview-update-1.1.0', trusted: false };
      decorate(packages);
    },
    review(packages: ExtensionPackage[], id: string, digest: string) {
      const value = entry(id); if (!value.staged || digest !== `preview-update-${value.staged.manifest.version}`) throw new Error('StaleContext');
      if (value.staged.executable) value.staged.executable.trusted = true;
      value.approved = true; drain(packages, id); decorate(packages);
    },
    rollback(packages: ExtensionPackage[], id: string) {
      const value = entry(id); if (value.pins) throw new Error('Conflict: provider version is pinned');
      if (value.staged) { value.staged = undefined; value.approved = false; }
      else {
        const index = packages.findIndex(item => item.manifest.id === id); if (index < 0 || !value.previous) throw new Error('No prior compatible package');
        packages[index] = value.previous; value.previous = undefined;
      }
      decorate(packages);
    },
    pin(packages: ExtensionPackage[], id: string) {
      const value = entry(id); if (value.removing || value.approved) throw new Error('StaleContext'); value.pins++; decorate(packages);
    },
    release(packages: ExtensionPackage[], id: string) { const value = entry(id); value.pins = Math.max(0, value.pins - 1); drain(packages, id); decorate(packages); },
    uninstall(packages: ExtensionPackage[], id: string) { const value = entry(id); value.removing = true; drain(packages, id); decorate(packages); return value.pins > 0; },
  };
}
