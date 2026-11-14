/** JSON-only main-dialog accessory admission (docs/extensions/core-dialogs.md). Grants nothing and renders nothing. */
import { validateContract, type Json } from './contracts.ts';
import { MAIN_DIALOG_EXTRAS, MAIN_DIALOG_PROTECTED, type MainDialogId } from './surfaces.ts';

/** Captured once when a main-window modal opens. `mount` names that one opening of the shared dialog;
 * `project`/`task` are opaque handles, empty when none. */
export type DialogAccessory = Readonly<{ contractVersion: 1; window: 'main'; dialog: MainDialogId; mount: string; revision: number; project: string; task: string; target: 'none' | 'task' | 'project' }>;
export type DialogAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' };
/** Body extras shown per dialog across all packages; the rest is summarized, never rendered. */
export const MAX_DIALOG_BODY_EXTRAS = 8;
const ELIGIBLE = new Set<string>(MAIN_DIALOG_EXTRAS.map(([id]) => id));
const PROTECTED = new Set<string>(MAIN_DIALOG_PROTECTED.map(([id]) => id));
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
