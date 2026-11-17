/** Project explorer adapter (upstream sync P6, S0601). The explorer is the inspector Files tab: a tree of rows, a few tools
 * above it and a menu per row. Packages reach it through primitives that already exist: contributed actions in the row
 * menu (`panda.inspector.files.context`) and above the tree (`panda.inspector.files.toolbar`) with a captured project,
 * path, kind and revision, the user's hide/order/restore of the host controls, and the `panda.files` presentation. No
 * core filesystem command is exposed and no package edits a file: Rename, Delete, New File and New Folder run in the
 * host's own dialog, which keeps its unsaved-edit guard. See docs/extensions/upstream-explorer.md. */
import { applyControlOrder, applyControlVisibility } from './layout-host';
import { EXPLORER_CONTEXT_CONTROLS, EXPLORER_CONTEXT_LOCATION, EXPLORER_PINNED_CONTROLS, EXPLORER_TOOLBAR_CONTROLS, EXPLORER_TOOLBAR_LOCATION } from './surfaces';
import type { Json } from './contracts';

export type ExplorerKind = 'file' | 'folder' | 'project';
export type ExplorerContext = { projectId: string; sessionId?: string };
export type ExplorerSurface = { location: typeof EXPLORER_CONTEXT_LOCATION; context: Record<string, Json>; isAlive: () => boolean; pinned: readonly string[] };

/** The tools above the tree, with the node each one binds to (references inside the Files tab, never new actions). */
const TOOLBAR_NODES: Readonly<Record<string, string>> = {
  'new-file': '[data-action="new-workspace-file"]',
  'new-folder': '[data-action="new-workspace-folder"]',
  actions: '[data-action="file-menu"][data-path=""]',
  collapse: '[data-action="collapse-folders"]',
};

/** One entry per member of the explorer, with the operations it supports and the reason for each it does not. */
export type ExplorerRegistryEntry = Readonly<{ member: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; reason?: string; lead?: string }>;
export const EXPLORER_REGISTRY: readonly ExplorerRegistryEntry[] = Object.freeze([
  { member: 'toolbar', locations: [EXPLORER_TOOLBAR_LOCATION], controls: EXPLORER_TOOLBAR_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'project', reason: `Contributed tools join the inspector strip. ${Object.entries(EXPLORER_PINNED_CONTROLS).map(([id, why]) => `${id}: ${why}`).join(' ')}` },
  { member: 'menu', locations: [EXPLORER_CONTEXT_LOCATION], controls: EXPLORER_CONTEXT_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'file | folder | project', reason: 'One menu for the toolbar button, the row button, the right-click and Shift+F10/ContextMenu; contributed rows follow the host rows. Open and Attach apply to files only.' },
  { member: 'dialog', locations: ['panda.dialog.explorer-entry'], controls: ['new-file', 'new-folder', 'rename', 'delete'], order: false, hide: false, actions: false, context: 'none', reason: 'The create, rename and delete dialog is the host confirmation and keeps its unsaved-edit guard; a package never submits it and it is not an extension surface. Deletion stays irreversible, so the dialog is the choice.' },
  { member: 'rows', locations: ['panda.files'], controls: ['open-file', 'toggle-file-folder', 'attach-file', 'view-source', 'file-menu'], order: false, hide: false, actions: false, context: 'file | folder', reason: 'Rows are the project data. The panda.files presentation (docs/extensions/replacement.md) replaces how they are drawn; opening, expanding and attaching run the original handlers.' },
  { member: 'keyboard', locations: [], controls: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'F2', 'Delete', 'Shift+F10', 'ContextMenu'], order: false, hide: false, actions: false, context: 'file | folder', reason: 'The roving keyboard of the tree is host input handling; hiding a control never removes its shortcut.' },
  { member: 'refresh', locations: [], controls: ['poll', 'focus'], order: false, hide: false, actions: false, context: 'project', reason: 'The two-second poll and the refresh on focus reload the tree and any open editor tab from disk; stability behavior, not a surface.' },
].map(entry => Object.freeze(entry)));

/** Capabilities that need a runtime ability that does not exist yet: named handoffs to the runtime phase that owns them
 * (collected by S07C, consumed by R1212), never a refusal. Delivering the adapter does not claim them. */
export const EXPLORER_HANDOFFS = Object.freeze([
  { capability: 'package-supplied tree entries, decorations and virtual folders', owner: 'R0205', reason: 'live contributions: a package pushing entries into a host tree needs the live contribution channel' },
  { capability: 'package-driven selection, expansion and refresh of the host tree', owner: 'R0205', reason: 'live contributions and the duplex channel carry the request; the host tree keeps its own state until then' },
  { capability: 'package-initiated file create, rename, delete and move', owner: 'R0405', reason: 'project grants (projects.files.write) with the host confirmation for irreversible deletion, off per package by the user' },
  { capability: 'package file-type editors opening in place of the host editor', owner: 'R0901-R0903', reason: 'custom editors own the open of a file type; the explorer only names the file' },
].map(item => Object.freeze(item)));

/** What the clicked row stands for: the project root, a folder or a file. */
export function explorerKind(path: string, directory: boolean): ExplorerKind { return !path ? 'project' : directory ? 'folder' : 'file'; }

/** The captured context of one menu: project, task, path, kind and the revision it was drawn at. File content is not sent. */
export function explorerSurface(context: ExplorerContext, path: string, directory: boolean, revision: number, alive: () => boolean): ExplorerSurface {
  const kind = explorerKind(path, directory);
  return {
    location: EXPLORER_CONTEXT_LOCATION,
    context: structuredClone({ projectId: context.projectId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), revision, selection: { kind, ids: [kind === 'project' ? context.projectId : path] } }),
    // A thread or project switch, a redraw of another tree or a removed row is another target: nothing runs for the old one.
    isAlive: alive, pinned: [],
  };
}

/** The host's own menu rows of one object, in the built-in order. Files lead with Open and Attach, as the Files tab did. */
export function explorerMenuIds(kind: ExplorerKind, attachable: boolean): string[] {
  const hostRows = ['new-file', 'new-folder', ...(kind === 'project' ? [] : ['rename', 'delete']), 'copy-path', 'reveal', ...(kind === 'file' ? ['open-external'] : [])];
  return [...(kind === 'file' ? ['open', ...(attachable ? ['attach'] : [])] : []), ...hostRows];
}

/** Bindings of the toolbar controls inside the Files tab; a control that is not drawn yet is skipped. */
export function explorerToolbarBindings(root: ParentNode): [string, HTMLElement | null][] {
  return EXPLORER_TOOLBAR_CONTROLS.map(([id]) => [`${EXPLORER_TOOLBAR_LOCATION}/${id}`, root.querySelector<HTMLElement>(`.file-explorer-tools ${TOOLBAR_NODES[id]}`)] as [string, HTMLElement | null]);
}

/** Order and reversible visibility of the explorer tools on their original nodes (listeners, focus and the tree stay).
 * Safe mode and a disabled package show the built-in tools in the built-in order; a pinned tool never hides. */
export function applyExplorerLayout(root: ParentNode, safe: boolean, fallback: () => HTMLElement | null): void {
  const bindings = explorerToolbarBindings(root);
  applyControlOrder(EXPLORER_TOOLBAR_LOCATION, bindings, safe);
  const hideable = bindings.filter(([id]) => !EXPLORER_PINNED_CONTROLS[id]);
  for (const [id, node] of bindings) if (node && (safe || EXPLORER_PINNED_CONTROLS[id]) && node.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; }
  if (!safe) applyControlVisibility(hideable, fallback);
}
