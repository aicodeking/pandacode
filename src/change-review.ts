import './change-review.css';
import { call } from './bridge';
import { escape, icon } from './dom';
import type { TurnChanges, TurnChangeDiff } from './types';
import { changeCounts, changeNotice } from './turn-changes';
import { mountDiffViewer, type DiffViewerController } from './diff-viewer';
import { t } from './i18n.ts';

export function mountChangeReview(host: HTMLElement, sessionId: string, changes: TurnChanges, initialPath?: string, review?: () => void): () => void {
  let disposed = false, request = 0, controller: DiffViewerController | undefined;
  const notice = changeNotice(changes);
  host.innerHTML = `<div class="change-review-summary"><span>${t`${changes.files.length} changed ${changes.files.length === 1 ? t('file') : t('files')}`}</span><span class="change-counts">${changeCounts(changes.additions, changes.deletions)}</span><small>${t('Saved at turn completion')}</small></div>${notice ? `<p class="change-review-notice">${escape(notice)}</p>` : ''}<div class="change-review-workspace"><nav class="change-review-files" aria-label="${t('Changed files')}">${changes.files.map(file => `<button type="button" data-path="${escape(file.path)}" aria-label="${t`View diff for ${escape(file.path)}`}" title="${escape(file.oldPath ? file.oldPath + ' → ' + file.path : file.path)}" aria-pressed="false">${icon('file')}<span class="change-review-path">${escape(file.path)}</span><span class="change-counts">${file.binary ? `<span class="change-count-unknown">${t('Binary')}</span>` : changeCounts(file.additions, file.deletions)}</span></button>`).join('')}</nav><section class="change-review-content" aria-label="${t('Saved file diff')}"><div class="change-review-filename"></div><div class="change-review-viewer"></div></section></div>`;
  const viewer = host.querySelector<HTMLElement>('.change-review-viewer')!;
  if (review) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button change-review-assist';
    button.innerHTML = `${icon('spark')}${t('Review with Jev')}`;
    button.addEventListener('click', review);
    host.querySelector('.change-review-summary')!.append(button);
  }
  async function select(path: string): Promise<void> {
    if (disposed) return;
    const file = changes.files.find(file => file.path === path); if (!file) return;
    const current = ++request;
    controller?.dispose(); controller = undefined;
    host.querySelectorAll<HTMLButtonElement>('.change-review-files button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.path === path)));
    host.querySelector<HTMLElement>('.change-review-filename')!.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    viewer.innerHTML = `<p class="change-review-loading" role="status">${t('Loading saved diff…')}</p>`;
    try {
      const diff = await call<TurnChangeDiff>('turn_change_diff', { sessionId, changeId: changes.id, path });
      if (disposed || current !== request) return;
      controller = mountDiffViewer(viewer, { ...diff, error: diff.error ?? undefined, layout: 'unified' });
      await controller.ready;
    } catch (error) {
      if (disposed || current !== request) return;
      viewer.innerHTML = `<div class="change-review-error" role="alert"><p>${escape(error instanceof Error ? error.message : String(error))}</p><button type="button" class="secondary-button">${t('Retry')}</button></div>`;
      viewer.querySelector('button')!.addEventListener('click', () => { void select(path); });
    }
  }
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('.change-review-files button');
    if (button?.dataset.path) void select(button.dataset.path);
  };
  host.addEventListener('click', click);
  const first = changes.files.find(file => file.path === initialPath) ?? changes.files[0];
  if (first) void select(first.path);
  return () => { disposed = true; request++; controller?.dispose(); host.removeEventListener('click', click); };
}
