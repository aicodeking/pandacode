import type { TurnChangeDiff, TurnChangeFile, TurnChanges } from './types.ts';
import type { CombinedChanges } from './turn-activity.ts';
import { escape, fileIcon, icon } from './dom.ts';
import { infoMark } from './tooltip.ts';

/** A merged card's summary of several runs (combineChanges), as opposed to one run's snapshot. */
export const isCombined = (changes: TurnChanges): changes is CombinedChanges => Array.isArray((changes as Partial<CombinedChanges>).runs);

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
  return [changes.concurrent ? 'Shared checkout: only files reported by this task are listed; detected conflicts were omitted.' : '', changes.truncated ? 'Change tracking is limited; some files or details were not captured.' : '', changes.error ?? '', isCombined(changes) ? changes.note : ''].filter(Boolean).join(' ');
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
  // A merged card's one footer covers every run of the exchange and says so.
  const runs = isCombined(changes) ? `<span class="turn-card-foot-runs">across ${changes.runs.length} runs</span>` : '';
  return `<section class="turn-changes turn-card-foot" aria-label="Files changed during this turn" data-session-id="${escape(sessionId)}" data-changes="${escape(JSON.stringify(changes))}"><button type="button" class="turn-card-foot-open" data-action="open-turn-diff" aria-description="Opens the diff">${icon('branch')}<strong>${label}</strong>${runs}<span class="change-counts">${changeCounts(changes.additions, changes.deletions)}${changeDots(changes.additions, changes.deletions)}</span><span class="turn-card-foot-chevron" aria-hidden="true">${icon('chevron')}</span></button>${notice ? `${infoMark(notice, 'Change tracking details')}<span class="turn-change-notice sr-only">${escape(notice)}</span>` : ''}<button type="button" class="turn-changes-run" data-action="run-project" data-session-id="${escape(sessionId)}" aria-label="Run project" title="Run pandacode-run.sh" ${runnable ? '' : 'hidden'}>${icon('play')}<span>Run</span></button></section>`;
}

/** The diff viewer for a merged card's footer: every file once, and for the chosen file one tab per run that changed it,
 * in order, each showing that run's saved diff (there is no net diff across runs). `review` acts on the run in view. */
export function mountCombinedReview(host: HTMLElement, sessionId: string, changes: CombinedChanges, load: (changeId: string, path: string) => Promise<TurnChangeDiff>, initialPath?: string, review?: (run: TurnChanges) => void): () => void {
  let disposed = false, request = 0, shown: { path: string; run: number } | undefined;
  let controller: { dispose(): void; ready: Promise<void> } | undefined;
  const notice = changeNotice(changes), order = new Map(changes.runs.map((run, index) => [run.id, index]));
  const runsOf = (path: string) => (changes.touched[path] ?? []).map((id, index) => ({ run: changes.runs[order.get(id)!], path: changes.paths[path]?.[index] ?? path }));
  host.innerHTML = `<div class="change-review-summary"><span>${changes.files.length} changed ${changes.files.length === 1 ? 'file' : 'files'}</span><span class="change-counts">${changeCounts(changes.additions, changes.deletions)}</span><small>Across ${changes.runs.length} runs, saved as each ended</small></div>${notice ? `<p class="change-review-notice">${escape(notice)}</p>` : ''}<div class="change-review-workspace"><nav class="change-review-files" aria-label="Changed files">${changes.files.map(file => {
    const times = changes.touched[file.path]?.length ?? 1;
    return `<button type="button" data-path="${escape(file.path)}" aria-label="View diff for ${escape(file.path)}" title="${escape(file.oldPath ? file.oldPath + ' → ' + file.path : file.path)}" aria-pressed="false">${icon('file')}<span class="change-review-path">${escape(file.path)}</span><span class="change-counts">${file.binary ? '<span class="change-count-unknown">Binary</span>' : changeCounts(file.additions, file.deletions)}${times > 1 ? `<span class="change-review-times">${times} runs, summed</span>` : ''}</span></button>`;
  }).join('')}</nav><section class="change-review-content" aria-label="Saved file diff"><div class="change-review-filename"></div><div class="change-review-runs" role="group" aria-label="Runs that changed this file"></div><div class="change-review-viewer"></div></section></div>`;
  const viewer = host.querySelector<HTMLElement>('.change-review-viewer')!, tabs = host.querySelector<HTMLElement>('.change-review-runs')!;
  if (review) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button change-review-assist';
    button.innerHTML = `${icon('spark')}Review this run with Jev`;
    button.addEventListener('click', () => { const run = shown && runsOf(shown.path)[shown.run]?.run; if (run) review(run); });
    host.querySelector('.change-review-summary')!.append(button);
  }
  async function select(path: string, index = 0): Promise<void> {
    const file = changes.files.find(entry => entry.path === path), runs = runsOf(path), chosen = runs[index];
    if (disposed || !file || !chosen) return;
    const current = ++request;
    shown = { path, run: index };
    controller?.dispose(); controller = undefined;
    host.querySelectorAll<HTMLButtonElement>('.change-review-files button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.path === path)));
    host.querySelector<HTMLElement>('.change-review-filename')!.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    tabs.innerHTML = runs.map(({ run }, at) => `<button type="button" data-run="${at}" aria-pressed="${at === index}">Run ${(order.get(run.id) ?? 0) + 1} of ${changes.runs.length}</button>`).join('');
    viewer.innerHTML = '<p class="change-review-loading" role="status">Loading saved diff…</p>';
    try {
      const [diff, { mountDiffViewer }] = await Promise.all([load(chosen.run.id, chosen.path), import('./diff-viewer.ts')]);
      if (disposed || current !== request) return;
      controller = mountDiffViewer(viewer, { ...diff, error: diff.error ?? undefined, layout: 'unified' });
      await controller.ready;
    } catch (error) {
      if (disposed || current !== request) return;
      viewer.innerHTML = `<div class="change-review-error" role="alert"><p>${escape(error instanceof Error ? error.message : String(error))}</p><button type="button" class="secondary-button">Retry</button></div>`;
      viewer.querySelector('button')!.addEventListener('click', () => { void select(path, index); });
    }
  }
  const click = (event: Event) => {
    const target = event.target as Element;
    const run = target.closest<HTMLButtonElement>('.change-review-runs button');
    if (run && shown) { void select(shown.path, Number(run.dataset.run)); return; }
    const button = target.closest<HTMLButtonElement>('.change-review-files button');
    if (button?.dataset.path) void select(button.dataset.path);
  };
  host.addEventListener('click', click);
  const first = changes.files.find(file => file.path === initialPath) ?? changes.files[0];
  if (first) void select(first.path);
  return () => { disposed = true; request++; controller?.dispose(); host.removeEventListener('click', click); };
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
