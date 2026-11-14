/** JSON-only dialog accessory admission (docs/extensions/core-dialogs.md, docs/extensions/owned-dialogs.md).
 * Grants nothing and renders nothing. */
import { validateContract, type Json } from './contracts.ts';
import { DIALOG_EXTRAS, MAIN_DIALOG_PROTECTED, OWNED_DIALOG_PROTECTED, type DialogTarget, type MainDialogId } from './surfaces.ts';

/** Captured once when an eligible main-window dialog opens. `mount` names that one opening and its host
 * (`main/<n>` for the shared modal, `<dialog id>/<n>` for a directly mounted dialog element);
 * `project`/`task` are opaque handles, empty when none. */
export type DialogAccessory = Readonly<{ contractVersion: 1; window: 'main'; dialog: MainDialogId; mount: string; revision: number; project: string; task: string; target: DialogTarget }>;
export type DialogAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' };
/** Body extras shown per dialog across all packages; the rest is summarized, never rendered. */
export const MAX_DIALOG_BODY_EXTRAS = 8;
const ELIGIBLE = new Set<string>(DIALOG_EXTRAS.map(([id]) => id));
const PROTECTED = new Set<string>([...MAIN_DIALOG_PROTECTED, ...OWNED_DIALOG_PROTECTED].map(([id]) => id));
const CAPTURED = ['window', 'dialog', 'mount', 'revision', 'project', 'task', 'target'] as const;

export const dialogActionsLocation = (id: MainDialogId) => `panda.dialog.${id}.actions` as const;
export const dialogBodyLocation = (id: MainDialogId) => `panda.dialog.${id}.bodyExtras` as const;
export const isEligibleDialog = (id: string): id is MainDialogId => ELIGIBLE.has(id) && !PROTECTED.has(id);

/** Admits a captured accessory against the dialog that is open now. A replaced, closed or protected dialog
 * never receives package content; nothing is retargeted to whatever dialog or task is current. */
export function admitDialogAccessory(input: unknown, live: DialogAccessory | undefined): DialogAdmission {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
  if (record && Object.getOwnPropertyDescriptor(record, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
  if (record && typeof record.dialog === 'string' && PROTECTED.has(record.dialog)) return { ok: false, reason: 'UnsupportedCapability' };
  if (!validateContract('dialogAccessory', input as Json).ok) return { ok: false, reason: 'InvalidArguments' };
  if (!live) return { ok: false, reason: 'Revoked' };
  const accessory = input as DialogAccessory;
  if (CAPTURED.some(key => accessory[key] !== live[key])) return { ok: false, reason: 'StaleContext' };
  return { ok: true };
}

/** The public invocation context an action receives: the captured dialog, never the current selection. */
export function dialogContext(accessory: DialogAccessory): Record<string, Json> {
  return {
    dialog: accessory.dialog, revision: accessory.revision,
    ...(accessory.project ? { projectId: accessory.project } : {}),
    ...(accessory.task ? { sessionId: accessory.task } : {}),
    ...(accessory.target === 'task' && accessory.task ? { selection: { kind: 'task', ids: [accessory.task] } } : {}),
    ...(accessory.target === 'project' && accessory.project ? { selection: { kind: 'project', ids: [accessory.project] } } : {}),
  };
}

/** What a module or direct host passes for one opening: its own dialog ID and target, never the global one. */
export type DialogRequest = { dialog: MainDialogId; task?: string; project?: string; revision?: number };
/** Builds the accessory a module or direct host captures from its own request. The target falls back to the
 * project (or nothing) when the opener has no task, exactly like the main modal helper. */
export function ownedDialogAccessory(request: DialogRequest, mount: string, revision: number): DialogAccessory {
  const target = DIALOG_EXTRAS.find(([id]) => id === request.dialog)?.[2] ?? 'none';
  const task = request.task ?? '', project = request.project ?? '';
  return Object.freeze({ contractVersion: 1, window: 'main', dialog: request.dialog, mount, revision: request.revision ?? revision, project, task,
    target: target === 'task' && !task ? project ? 'project' : 'none' : target === 'project' && !project ? 'none' : target });
}
