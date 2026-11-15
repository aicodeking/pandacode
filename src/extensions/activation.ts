/** Owner/version/activation-scoped declarative registrations, with no DOM or private service API. */
import { validateContract, evaluateCondition, type Json } from './contracts.ts';
import type { ExtensionSnapshot, ExtensionMenuItem, ExtensionAction } from './manager';
import { surfaceWindow } from './window-surfaces.ts';
// Every mounted surface activates the same enabled batch after each lifecycle change. Validation is
// pure and its result is only read here, so the last batch's result is shared instead of being
// recomputed per surface (1,000 contributions × dozens of surfaces otherwise blocks for seconds).
let lastValidation: { key: string; result: ReturnType<typeof validateContract> } | undefined;
function validatePackages(manifests: unknown[]): ReturnType<typeof validateContract> {
  const key = JSON.stringify(manifests);
  if (lastValidation?.key !== key) lastValidation = { key, result: validateContract('packages', manifests) };
  return lastValidation.result;
}
export function createDeclarativeActivation(snapshot: ExtensionSnapshot, activationId: number, states = new Map<string, boolean>()) {
  let packages = snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled);
  let checked = validatePackages(packages.map(item => item.manifest));
  if (!checked.ok && (['DependencyCycle', 'IncompatibleDependency'].includes(checked.error.code) || checked.error.path.includes('/dependencies'))) {
    // A disabled/missing/incompatible/cyclic dependency blocks its dependent closure, not
    // independent UI owners. Other schema/ownership/ordering conflicts still fail atomically.
    packages = packages.filter(candidate => {
      const pending = [candidate.manifest.id], seen = new Set<string>(), closure = [];
      while (pending.length) {
        const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
        const pkg = packages.find(pkg => pkg.manifest.id === id); if (!pkg) return false;
        closure.push(pkg.manifest); pending.push(...Object.keys(pkg.manifest.dependencies ?? {}));
      }
      return validateContract('packages', closure).ok;
    });
    checked = validatePackages(packages.map(item => item.manifest));
  }
  if (!checked.ok) throw new Error(`Activation rejected: ${checked.error.code}`);
  const normalized = checked.value as unknown as { packages: typeof packages[number]['manifest'][]; menuOrder: string[] };
  const position = new Map(normalized.menuOrder.map((id, index) => [id, index]));
  const entries = normalized.packages.flatMap(manifest => (manifest.contributes.menus ?? []).map(menu => {
    const command = manifest.contributes.commands?.find(command => command.id === menu.command)!;
    const icons = packages.find(item => item.manifest.id === manifest.id)?.icons ?? {};
    return { owner: { extensionId: manifest.id, version: manifest.version, activationId }, menu, command, icons, svg: icons[menu.icon ?? ''] };
  })).sort((a, b) => position.get(a.menu.id)! - position.get(b.menu.id)!);
  let disposed = false;
  const conditionAllows = (condition: Json | undefined, context: Record<string, Json>) => {
    if (condition === undefined) return true;
    const result = evaluateCondition(condition, context);
    return result.ok && result.value === true;
  };
  const allows = (item: { visible?: Json; enabled?: Json }, context: Record<string, Json>) => [item.visible, item.enabled].every(condition => conditionAllows(condition, context));
  function filtered(items: ExtensionMenuItem[], context: Record<string, Json>, commands: NonNullable<typeof packages[number]['manifest']['contributes']['commands']>): ExtensionMenuItem[] {
    const result: ExtensionMenuItem[] = [];
    for (const item of items) {
      if (!conditionAllows(item.visible, context)) continue;
      const children = item.items ? filtered(item.items, context, commands) : undefined;
      if (children && !children.length) continue;
      if (item.kind === 'separator' && (!result.length || result.at(-1)?.kind === 'separator')) continue;
      const command = item.command ? commands.find(command => command.id === item.command) : undefined;
      result.push({ ...item, ...(command ? { enabled: conditionAllows(item.enabled, context) && conditionAllows(command.enabled, context) } : {}), checked: states.get(item.id) ?? item.checked, ...(children ? { items: children } : {}) });
    }
    if (result.at(-1)?.kind === 'separator') result.pop();
    return result;
  }
  return {
    entries: structuredClone(entries),
    commands: structuredClone(normalized.packages.flatMap(manifest => (manifest.contributes.commands ?? []).map(command => ({ owner: { extensionId: manifest.id, version: manifest.version, activationId }, command })))),
    commandAction(id: string, context: Record<string, Json>): ExtensionAction | undefined {
      if (disposed || !['panda.commands', 'panda.shortcuts'].includes(String(context.surfaceId)) || context.windowId !== 'main' || !validateContract('context', context).ok) return;
      const command = normalized.packages.flatMap(manifest => manifest.contributes.commands ?? []).find(command => command.id === id);
      if (!command || !conditionAllows(command.enabled, context)) return;
      return structuredClone(command.action);
    },
    viewAction(id: string, context: Record<string, Json>): ExtensionAction | undefined {
      if (disposed || context.windowId !== 'main' || !validateContract('context', context).ok) return;
      const manifest = normalized.packages.find(manifest => manifest.contributes.views?.some(view => view.id === context.surfaceId && view.toolbar?.some(item => item.command === id)));
      const command = manifest?.contributes.commands?.find(command => command.id === id);
      if (command && conditionAllows(command.enabled, context)) return structuredClone(command.action);
    },
    itemsFor(id: string, context: Record<string, Json>): ExtensionMenuItem[] {
      if (disposed) return [];
      const entry = entries.find(entry => entry.menu.id === id);
      const commands = normalized.packages.find(manifest => manifest.id === entry?.owner.extensionId)?.contributes.commands ?? [];
      return entry && allows(entry.menu, context) ? structuredClone(filtered(entry.menu.items ?? [], context, commands)) : [];
    },
    actionFor(id: string, context: Record<string, Json>): ExtensionAction | undefined {
      if (disposed) return;
      let path: ExtensionMenuItem[] = [];
      function find(items: ExtensionMenuItem[], parents: ExtensionMenuItem[] = []): boolean {
        for (const item of items) {
          if (item.id === id) { path = [...parents, item]; return true; }
          if (item.items && find(item.items, [...parents, item])) return true;
        }
        return false;
      }
      const entry = entries.find(entry => entry.menu.id === id || find(entry.menu.items ?? []));
      if (!entry || !path.length && entry.menu.items || entry.menu.presentation === 'status' || entry.menu.presentation === 'badge') return;
      const leaf = path.at(-1);
      const command = leaf ? normalized.packages.find(manifest => manifest.id === entry.owner.extensionId)?.contributes.commands?.find(command => command.id === leaf.command) : entry.command;
      if (!command || !conditionAllows(command.enabled, context) || !['showMessage', 'showDialog', 'showProjectContext', 'runCommand', 'openView'].includes(command.action.kind)) return;
      const captured = structuredClone(context);
      const valid = validateContract('context', captured);
      if (!valid.ok || captured.surfaceId !== entry.menu.location || captured.windowId !== surfaceWindow(entry.menu.location)) return;
      if (![entry.menu, ...path].every(item => allows(item, captured))) return;
      if (leaf?.kind === 'checkbox') states.set(id, !(states.get(id) ?? leaf.checked));
      if (leaf?.kind === 'radio') {
        const siblings = path.length > 1 ? path.at(-2)!.items : entry.menu.items;
        for (const item of siblings ?? []) if (item.kind === 'radio' && item.group === leaf.group) states.set(item.id, item.id === id);
      }
      return structuredClone(command.action);
    },
    invoke(id: string, context: Record<string, Json>): string | undefined {
      const action = this.actionFor(id, context);
      return action?.kind === 'showMessage' ? action.message : undefined;
    },
    dispose() { disposed = true; },
  };
}
