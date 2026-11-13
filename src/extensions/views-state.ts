/** Validated data only: no DOM, task, file-session or PTY ownership. */
import { validateContract } from './contracts.ts';
import { isExtensionInspectorView, type ExtensionInspectorView } from '../inspector-tabs.ts';
import type { ExtensionSnapshot } from './manager';

export const INSPECTOR_VIEW_LOCATION = 'panda.inspector.views';
export type ViewTreeItem = { label: string; children?: ViewTreeItem[] };
export type ViewControl =
  | { kind: 'list'; label: string; items: string[] }
  | { kind: 'tree'; label: string; items: ViewTreeItem[] }
  | { kind: 'table'; label: string; columns: string[]; rows: string[][] }
  | { kind: 'tabs'; label: string; items: { label: string; text: string }[] }
  | { kind: 'progress'; label: string; value: number };
export type ViewDefinition = { id: ExtensionInspectorView; title: string; text: string; controls?: ViewControl[]; toolbar?: { command: string }[] };
export type RegisteredView = { owner: string; version: string; view: ViewDefinition };

export function registeredInspectorViews(snapshot: ExtensionSnapshot): RegisteredView[] {
  if (snapshot.safeMode) return [];
  const checked = validateContract('packages', snapshot.packages.filter(item => item.enabled).map(item => item.manifest));
  if (!checked.ok) return [];
  const normalized = checked.value as unknown as { packages: ExtensionSnapshot['packages'][number]['manifest'][] };
  return normalized.packages.flatMap(manifest => (manifest.contributes.views ?? []).filter(view => isExtensionInspectorView(view.id)).map(view => ({ owner: manifest.id, version: manifest.version, view })));
}
