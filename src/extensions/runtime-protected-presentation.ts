// Webview and preview twin of src-tauri/src/extensions/runtime_protected_presentation.rs (runtime phase R10, slice R1003):
// what a trusted package that holds `ui.presentation` may put beside two things the host used to keep to itself.
//
// - Hook notes on tool and approval rows. A `note` returned by a hook is shown with the name of the package that wrote it, and
//   the decision line names the package that decided; both come from the same fold, and the deciding package must agree with the
//   `decidedBy` the host recorded for the call (a disagreement withholds the label, never the note).
// - The extras of eight dialogs that were protected: remove-project, delete-task, delete-bot, delete-cloud, worktree-cleanup,
//   provider-connections, machine-link and skill-add. The band is the one of every eligible dialog (owner-labelled notes and
//   secondary actions after the host content, outside every form), so the host's fields, primary action, confirmation, Escape
//   policy and initial focus are untouched. `github-behind` (the recovery choice) stays built-in and `extension-form` stays the
//   owning package's alone.
//
// Every rule here is for fault isolation and predictability (ADR-0005): a slow or broken extra, a disabled package, a revoked
// grant or safe mode never changes what the host decides or asks; they only remove the extra. The same rules in the same order as
// the native module; the shared fixture is tests/fixtures/extensions/runtime-protected-presentation/cases.json.
import type { Json } from './runtime-hook-payload.ts';

export const PERMISSION = 'ui.presentation';
export const CONTRIBUTE = 'ui.contribute';
/** Notes shown per dialog across packages; the rest is summarized as a count (the same bound as every eligible dialog). */
export const MAX_DIALOG_NOTES = 8;
/** A package's extra gets this long to draw or act before the host stops waiting for it (the dialog never waits at all). */
export const EXTRA_BUDGET_MS = 1_500;
/** The eight dialogs this slice opens: [dialog id, captured target]. */
export const EXTRA_DIALOGS = [
  ['remove-project', 'project'], ['delete-task', 'task'], ['delete-bot', 'none'], ['delete-cloud', 'none'],
  ['worktree-cleanup', 'task'], ['provider-connections', 'none'], ['machine-link', 'none'], ['skill-add', 'none'],
] as const;
/** The recovery choice must work when a package is what is broken. */
export const BUILT_IN_ONLY = ['github-behind'] as const;
/** A package's own form is itself the accessory surface; another package's content is never placed inside it. */
export const OWNER_ONLY = ['extension-form'] as const;

export type Policy = 'extras' | 'built-in' | 'owner-only' | 'ordinary';
/** How the host treats a dialog id; `ordinary` is every other dialog (the band of docs/extensions/core-dialogs.md, no extra permission). */
export function policy(dialog: string): Policy {
  if (EXTRA_DIALOGS.some(([id]) => id === dialog)) return 'extras';
  if ((BUILT_IN_ONLY as readonly string[]).includes(dialog)) return 'built-in';
  if ((OWNER_ONLY as readonly string[]).includes(dialog)) return 'owner-only';
  return 'ordinary';
}
/** The permissions a package must hold for its extra to show in `dialog`. */
export const requiredPermissions = (dialog: string): string[] => policy(dialog) === 'extras' ? [CONTRIBUTE, PERMISSION] : [CONTRIBUTE];

export interface Contribution { owner: string; name: string; id: string; dialog: string; text: string; permissions: readonly string[]; enabled: boolean }
export interface Note { owner: string; name: string; id: string; text: string }
export interface Shown { notes: Note[]; omitted: number }
const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

/**
 * The notes a dialog shows now. Nothing shows in safe mode, for a built-in-only dialog, or from a package that is disabled or
 * lacks a permission (so disabling, revoking or safe mode clears the extras at the next draw and the host dialog stays whole).
 * An owner-only dialog shows only the notes of `formOwner`. `order` is the user's package order (a package outside it follows,
 * by id).
 */
export function visible(contributions: readonly Contribution[], dialog: string, safeMode: boolean, order: readonly string[] = [], formOwner?: string): Shown {
  const kind = policy(dialog);
  if (safeMode || kind === 'built-in') return { notes: [], omitted: 0 };
  const required = requiredPermissions(dialog);
  const rank = (owner: string) => { const index = order.indexOf(owner); return index < 0 ? order.length : index; };
  const shown = contributions
    .filter(item => item.dialog === dialog && item.enabled && required.every(permission => item.permissions.includes(permission)))
    .filter(item => kind !== 'owner-only' || item.owner === formOwner)
    .map((item, position) => ({ item, position }))
    .sort((a, b) => rank(a.item.owner) - rank(b.item.owner) || (a.item.owner < b.item.owner ? -1 : a.item.owner > b.item.owner ? 1 : 0) || a.position - b.position)
    .map(({ item }): Note => ({ owner: item.owner, name: item.name, id: item.id, text: oneLine(item.text) }))
    .filter(note => note.text);
  return { notes: shown.slice(0, MAX_DIALOG_NOTES), omitted: Math.max(0, shown.length - MAX_DIALOG_NOTES) };
}
/** The line a note is drawn as. */
export const noteLine = (note: Note): string => `${note.name}: ${note.text}`;
/** The summary line of notes past the bound, or null. */
export const omittedLine = (shown: Shown): string | null => shown.omitted > 0 ? `${shown.omitted} more extension notes are not shown.` : null;

// ---- Tool and approval rows -------------------------------------------------------------------------------------------------

export type Kind = 'approve' | 'deny' | 'ask' | 'none';
export interface Decider { owner: string; name: string; reason: string | null; failed: boolean }
/** The resolution of one call, as `runtime_hook_decisions` folds it. */
export interface Resolution { kind: Kind; by?: Decider; input?: Json | null }
export interface Row { kind: Kind; decider: Decider | null; rewritten: boolean; notes: [string, string][] }

/** The row of one call: its notes (each with the name of the package that wrote it) and the package that decided. */
export function row(resolution: Resolution, notes: readonly (readonly [string, string])[]): Row {
  const decider = resolution.kind === 'none' || !resolution.by ? null : resolution.by;
  return { kind: decider ? resolution.kind : 'none', decider, rewritten: resolution.input !== undefined && resolution.input !== null, notes: notes.map(([name, text]) => [name, oneLine(text)] as [string, string]).filter(([, text]) => text) };
}
/** The deciding package must be the one the host recorded for the call (`tool.after`'s `decidedBy`); otherwise the decision label is withheld. */
export function reconcile(source: Row, decidedBy: string | null): Row {
  if (!source.decider) return source;
  if (decidedBy !== null && decidedBy !== source.decider.owner) return { ...source, kind: 'none', decider: null, rewritten: false };
  return source;
}
/** An approve or a deny names `decidedBy`; an ask records none (the user decides); no decider means none recorded. */
export const agrees = (source: Row, decidedBy: string | null): boolean =>
  source.decider === null ? decidedBy === null : source.kind === 'ask' ? decidedBy === null || decidedBy === source.decider.owner : decidedBy === source.decider.owner;
/** The lines of a tool or approval row: the notes first, each named, then what the deciding package did, named. */
export function lines(source: Row, tool: string): string[] {
  const out = source.notes.map(([name, text]) => `${name}: ${text}`);
  const by = source.decider;
  if (!by) return out;
  const reason = by.reason ? ` ${by.reason}` : '';
  if (source.kind === 'approve') out.push(`${tool} approved by ${by.name}${source.rewritten ? ' with rewritten arguments' : ''}.${reason}`);
  else if (source.kind === 'deny') out.push(`${tool} denied by ${by.name}.${reason}`);
  else if (source.kind === 'ask') out.push(by.reason && !by.failed ? `${by.name} asks you to decide: ${by.reason}` : by.reason ? `${by.reason} Decide yourself.` : `${by.name} asks you to decide.`);
  return out;
}

// ---- A slow or broken extra -------------------------------------------------------------------------------------------------

export type Isolated<T> = { ok: true; value: T } | { ok: false; code: 'Timeout' | 'Failed' };
/** Runs one package's extra apart from the host: a rejection or a timeout becomes a code, never an exception, and the caller keeps its own decision. */
export async function isolate<T>(work: () => Promise<T> | T, budgetMs: number = EXTRA_BUDGET_MS): Promise<Isolated<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'Timeout'>(resolve => { timer = setTimeout(() => resolve('Timeout'), budgetMs); });
  try {
    const first = await Promise.race([Promise.resolve().then(work).then(value => ({ value }), () => 'Failed' as const), late]);
    if (first === 'Timeout' || first === 'Failed') return { ok: false, code: first };
    return { ok: true, value: first.value };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// ---- The drawing (DOM) --------------------------------------------------------------------------------------------------------

/**
 * Draws the notes of one tool or approval row into `container` (the lines are plain text, one paragraph each, labelled for assistive
 * technology as the extension's). Returns a function that removes them; calling it twice is harmless. No animation, no accent colour
 * of its own: the class `extension-row-notes` is styled from the always-loaded extensions stylesheet with `--ds-*` tokens.
 */
export function drawRowNotes(container: HTMLElement, source: Row, tool: string): () => void {
  const wrap = document.createElement('div');
  wrap.className = 'extension-row-notes'; wrap.setAttribute('role', 'note'); wrap.setAttribute('aria-label', 'Extension notes');
  for (const text of lines(source, tool)) { const line = document.createElement('p'); line.textContent = text; wrap.append(line); }
  if (!wrap.childElementCount) return () => {};
  container.append(wrap);
  return () => wrap.remove();
}
