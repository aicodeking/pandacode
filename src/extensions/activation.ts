/** Owner/version/activation-scoped declarative registrations, with no DOM or private service API. */
import { validateContract, evaluateCondition, type Json } from './contracts.ts';
import type { ExtensionSnapshot } from './manager';
export function createDeclarativeActivation(snapshot: ExtensionSnapshot, activationId: number) {
  const packages = snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled);
  const checked = validateContract('packages', packages.map(item => item.manifest));
  if (!checked.ok) throw new Error(`Activation rejected: ${checked.error.code}`);
  const normalized = checked.value as unknown as { packages: typeof packages[number]['manifest'][]; menuOrder: string[] };
  const entries = normalized.packages.flatMap(manifest => (manifest.contributes.menus ?? []).map(menu => {
    const command = manifest.contributes.commands?.find(command => command.id === menu.command)!;
    return { owner: { extensionId: manifest.id, version: manifest.version, activationId }, menu, command, svg: packages.find(item => item.manifest.id === manifest.id)?.icons[menu.icon ?? ''] };
  })).sort((a, b) => normalized.menuOrder.indexOf(a.menu.id) - normalized.menuOrder.indexOf(b.menu.id));
  let disposed = false;
  return {
    entries: structuredClone(entries),
    invoke(id: string, context: Record<string, Json>): string | undefined {
      if (disposed) return;
      const entry = entries.find(entry => entry.menu.id === id);
      if (!entry || entry.command.action.kind !== 'showMessage') return;
      const captured = structuredClone(context);
      const valid = validateContract('context', captured);
      if (!valid.ok || captured.surfaceId !== entry.menu.location || captured.windowId !== 'main') return;
      for (const condition of [entry.menu.visible, entry.menu.enabled]) {
        if (condition === undefined) continue;
        const checked = evaluateCondition(condition, captured);
        if (!checked.ok || checked.value !== true) return;
      }
      return entry.command.action.message;
    },
    dispose() { disposed = true; },
  };
}
