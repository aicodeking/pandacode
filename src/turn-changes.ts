import type { TurnChangeFile, TurnChanges } from './types.ts';
import { escape, fileIcon, icon } from './dom.ts';
import { infoMark } from './tooltip.ts';

export function changeCounts(additions: number | null, deletions: number | null): string {
  if (additions === null || deletions === null) return '<span class="change-count-unknown">—</span>';
  return `<span class="change-additions">+${additions.toLocaleString()}</span><span class="change-deletions">−${deletions.toLocaleString()}</span>`;
}

/** The turn summary's 5-segment meter: green for additions, red for deletions, grey for the rest
 * (each side floored, at least one segment when it has any lines). */
export function changeDots(additions: number | null, deletions: number | null): string {
  const add = additions ?? 0, del = deletions ?? 0, total = add + del;
  if (!total) return '';
  const share = (n: number): number => n ? Math.max(1, Math.floor(n / total * 5)) : 0;
  const green = Math.min(share(add), 5 - (del ? 1 : 0)), red = Math.min(share(del), 5 - green);
  const cells = Array.from({ length: 5 }, (_, i) => i < green ? 'ds-success' : i < green + red ? 'ds-danger' : '');
  return `<span class="ds-dots change-dots" aria-hidden="true">${cells.map(c => c ? `<span class="${c}"></span>` : '<span></span>').join('')}</span>`;
}

export function changeNotice(changes: TurnChanges): string {
  return [changes.concurrent ? 'Shared checkout: only files reported by this task are listed; detected conflicts were omitted.' : '', changes.truncated ? 'Change tracking is limited; some files or details were not captured.' : '', changes.error ?? ''].filter(Boolean).join(' ');
}

type Folder = { name: string; path: string; folders: Map<string, Folder>; files: TurnChangeFile[]; additions: number; deletions: number };
function fileTree(changes: TurnChanges): string {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], additions: 0, deletions: 0 };
  for (const file of changes.files) {
    let folder = root;
    const parts = file.path.split('/');
    for (const name of parts.slice(0, -1)) {
      if (!folder.folders.has(name)) folder.folders.set(name, { name, path: folder.path + name + '/', folders: new Map(), files: [], additions: 0, deletions: 0 });
      folder = folder.folders.get(name)!;
      folder.additions += file.additions ?? 0; folder.deletions += file.deletions ?? 0;
    }
    folder.files.push(file);
  }
  function render(folder: Folder): string {
    return [...folder.folders.values()].map(child => `<details class="turn-change-folder" data-change-key="${escape(changes.id + ':' + child.path)}"><summary>${icon('chevron')}${fileIcon(child.name, true)}<span class="change-path">${escape(child.name)}</span><span class="change-counts">${changeCounts(child.additions, child.deletions)}</span></summary><div class="turn-change-children">${render(child)}</div></details>`).join('')
      + folder.files.map(file => `<button type="button" class="turn-change-file" data-action="open-turn-diff" data-path="${escape(file.path)}" title="${escape(file.oldPath ? file.oldPath + ' → ' + file.path : file.path)}" aria-label="View diff for ${escape(file.path)}">${fileIcon(file.path.split('/').pop() ?? file.path, false)}<span class="change-path">${escape(file.path.split('/').pop())}</span><span class="change-file-status" title="${file.status}">${file.status === 'renamed' ? 'R' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span><span class="change-counts">${file.binary ? '<span class="change-count-unknown">Binary</span>' : changeCounts(file.additions, file.deletions)}</span></button>`).join('');
  }
  return render(root);
}

/** The card contains only a small summary; patch bodies are requested on open.
 * Show observed changes, without turning a tracking limitation into a warning on
 * an otherwise successful reply. Empty partial captures do not claim zero changes;
 * their diagnostics remain in the stored summary. */
export function renderTurnChanges(sessionId: string, changes: TurnChanges, runnable = false): string {
  const count = changes.files.length;
  // Older whole-checkout snapshots have no reliable task ownership.
  if (!count || !changes.attributed) return '';
  const label = `${count} changed ${count === 1 ? 'file' : 'files'}`;
  const notice = changeNotice(changes);
  return `<section class="turn-changes" aria-label="Files changed during this turn" data-session-id="${escape(sessionId)}" data-changes="${escape(JSON.stringify(changes))}"><div class="turn-changes-actions"><button type="button" class="turn-changes-run" data-action="run-project" data-session-id="${escape(sessionId)}" aria-label="Run project" title="Run pandacode-run.sh" ${runnable ? '' : 'hidden'}>${icon('play')}<span>Run</span></button><button type="button" class="turn-changes-open" data-action="open-turn-diff">${icon('edit')}Open diff</button></div><details class="turn-change-list" data-change-key="${escape(changes.id)}" open><summary>${icon('chevron')}<strong>${label}</strong><span class="change-counts">${changeCounts(changes.additions, changes.deletions)}${changeDots(changes.additions, changes.deletions)}</span>${notice ? `${infoMark(notice, 'Change tracking details', true)}<span class="turn-change-notice sr-only">${escape(notice)}</span>` : ''}</summary><div class="turn-change-tree">${fileTree(changes)}</div></details></section>`;
}

/** A turn card's footer: one row that opens the turn's diff (`N changed files`, counts and the meter),
 * then Run. The same ownership rules as the card above; nothing when the turn changed nothing. */
export function turnChangesFoot(sessionId: string, changes: TurnChanges, runnable = false): string {
  const count = changes.files.length;
  if (!count || !changes.attributed) return '';
  const label = `${count} changed ${count === 1 ? 'file' : 'files'}`, notice = changeNotice(changes);
  return `<section class="turn-changes turn-card-foot" aria-label="Files changed during this turn" data-session-id="${escape(sessionId)}" data-changes="${escape(JSON.stringify(changes))}"><button type="button" class="turn-card-foot-open" data-action="open-turn-diff" aria-description="Opens the diff">${icon('branch')}<strong>${label}</strong><span class="change-counts">${changeCounts(changes.additions, changes.deletions)}${changeDots(changes.additions, changes.deletions)}</span><span class="turn-card-foot-chevron" aria-hidden="true">${icon('chevron')}</span></button>${notice ? `${infoMark(notice, 'Change tracking details')}<span class="turn-change-notice sr-only">${escape(notice)}</span>` : ''}<button type="button" class="turn-changes-run" data-action="run-project" data-session-id="${escape(sessionId)}" aria-label="Run project" title="Run pandacode-run.sh" ${runnable ? '' : 'hidden'}>${icon('play')}<span>Run</span></button></section>`;
}

export function changeRequest(element: HTMLElement): { sessionId: string; changes: TurnChanges; path?: string } | undefined {
  const card = element.closest<HTMLElement>('.turn-changes');
  if (!card?.dataset.sessionId || !card.dataset.changes) return;
  return { sessionId: card.dataset.sessionId, changes: JSON.parse(card.dataset.changes) as TurnChanges, path: element.dataset.path };
}

export function captureChangeCards(root: ParentNode): Map<string, boolean> {
  return new Map([...root.querySelectorAll<HTMLDetailsElement>('details[data-change-key]')].map(el => [el.dataset.changeKey!, el.open]));
}
export function restoreChangeCards(root: ParentNode, state: Map<string, boolean>): void {
  root.querySelectorAll<HTMLDetailsElement>('details[data-change-key]').forEach(el => { const open = state.get(el.dataset.changeKey!); if (open !== undefined) el.open = open; });
}
