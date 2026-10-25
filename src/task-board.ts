import type { Project, Session, TaskStage } from './types';
import { t } from './i18n.ts';
import { button, escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { linkChip } from './worktrees';
import './task-board.css';

export const stageNames: Record<TaskStage, string> = { pending: t('Pending'), in_progress: t('In progress'), review: t('Review'), completed: t('Settled') };
/** Archived tasks (older data, mirrors) count as settled: there is no archive any more. */
export function taskStage(task: Session): TaskStage {
  if (task.archived) return 'completed';
  return task.taskStage ?? (['running', 'waiting', 'interrupted'].includes(task.status) ? 'in_progress' : task.lastResponseAt ? 'review' : 'pending');
}
function patch(target: HTMLElement, markup: string): void {
  if (target.dataset.markup === markup) return;
  const focused = target.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const selector = focused?.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"][data-action="${CSS.escape(focused.dataset.action ?? '')}"]` : '';
  target.innerHTML = markup; target.dataset.markup = markup;
  if (selector) target.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}
export function renderTaskBoard(host: HTMLElement, tasks: Session[], projects: Project[], selectedId: string, filter: string, running: (id: string) => boolean, importable = false): void {
  if (!host.childElementCount) host.innerHTML = `<header class="board-heading"><div class="board-project-heading"><span class="board-eyebrow">${icon('bamboo')}${t('Project board')}</span><h1><button id="board-project-filter" class="board-project-filter" data-action="filter-projects" aria-label="${t('Filter projects')}" aria-haspopup="dialog" aria-expanded="false"><span></span>${icon('down')}</button></h1></div><div class="board-heading-actions">${button('add-project', t('Open project'), 'folderPlus')}<button class="secondary-button board-import" data-action="board-import" aria-haspopup="dialog" hidden>${icon('download')}${t('Import from GitHub')}</button><button class="primary-button" data-action="board-add">${icon('plus')}${t('Add task')}</button></div></header><div class="board-columns">${Object.entries(stageNames).map(([stage, label]) => `<section class="board-column" data-stage="${stage}" aria-label="${label}"><header><span class="stage-dot"></span><h2>${label}</h2><span class="board-count"></span>${stage === 'pending' ? button('board-add', t('Add pending task'), 'plus') : ''}</header><div class="board-cards"></div></section>`).join('')}</div>`;
  const title = (projects.find(p => p.id === filter)?.name ?? t('All projects'));
  host.querySelector('.board-project-filter>span')!.textContent = title;
  host.querySelector('h1')!.setAttribute('aria-label', title);
  host.querySelector<HTMLElement>('.board-import')!.hidden = !importable;
  const visible = tasks.filter(s => (!filter || s.projectId === filter));
  for (const stage of Object.keys(stageNames) as TaskStage[]) {
    const column = host.querySelector<HTMLElement>(`[data-stage="${stage}"]`)!;
    const cards = visible.filter(s => taskStage(s) === stage).sort((a, b) => b.updatedAt - a.updatedAt);
    column.querySelector('.board-count')!.textContent = String(cards.length);
    patch(column.querySelector('.board-cards')!, cards.map(s => {
      const active = running(s.id);
      const project = projects.find(p => p.id === s.projectId);
      const links = [s.issue, s.pullRequest].filter(Boolean).map(link => linkChip(link!)).join('');
      return `<article class="board-card ${s.id === selectedId ? 'selected' : ''}" data-task-id="${escape(s.id)}"><button class="board-card-open" data-action="board-open" data-id="${escape(s.id)}" aria-label="${t`Open task: ${escape(s.title)}`}" ${s.id === selectedId ? 'aria-current="true"' : ''}><strong>${escape(s.title)}</strong>${s.taskDescription ? `<span class="board-card-description">${escape(s.taskDescription.slice(0, 240))}</span>` : ''}<span class="board-card-meta">${providerLogo(s.provider)}<span>${escape(project?.name ?? t('Project'))}</span>${s.worktreePath ? `<span title="${t`Worktree${s.worktreeBranch ? ` · ${escape(s.worktreeBranch)}` : ''}`}">${icon('worktree')}</span>` : ''}${active ? `<span class="board-running" title="${t('Agent working')}" aria-label="${t('Agent working')}"></span>` : ''}</span></button>${links ? `<div class="board-card-links">${links}</div>` : ''}${(stage === 'pending' || stage === 'in_progress' && !active) ? `<button class="board-card-start" data-action="board-start" data-id="${escape(s.id)}" aria-label="${t`Start task: ${escape(s.title)}`}">${icon('play')}${stage === 'pending' ? t('Start') : t('Retry')}</button>` : ''}</article>`;
    }).join('') || `<div class="board-empty">${({ pending: t('Ideas waiting to begin'), in_progress: t('Work happens here'), review: t('Ready for your feedback'), completed: t('Settled and done') })[stage]}</div>`);
  }
}
export function renderTaskDetails(host: HTMLElement, task: Session | undefined, project: Project | undefined, running: boolean, loading = false): void {
  if (!task) { patch(host, ''); return; }
  const stage = taskStage(task);
  const action = loading ? `<span>${t('Loading task details…')}</span>` : stage === 'completed' ? `<button class="secondary-button" data-action="board-reopen">${t('Reopen task')}</button>` : running ? `<span class="board-detail-working"><span class="board-running"></span>${t('Agent working')}</span>` : stage === 'review' ? '<button class="primary-button" data-action="board-complete">'+icon('check')+t('Settle')+'</button>' : '<button class="primary-button" data-action="board-start" aria-label="'+t('Start task')+'">'+icon('play')+(stage === 'pending' ? t('Start task') : t('Retry task'))+'</button>';
  const links = [task.issue, task.pullRequest].filter(Boolean).map(link => linkChip(link!)).join('');
  patch(host, `<header class="task-detail-toolbar"><span class="task-stage" data-stage="${stage}"><span class="stage-dot"></span>${stageNames[stage]}</span><span class="task-detail-actions">${button('board-edit', t('Edit task details'), 'edit', '', running || loading ? 'disabled' : '')}${button('board-close', t('Close task details'), 'close')}</span></header><div class="task-detail-summary"><h1>${escape(task.title)}</h1><div class="task-detail-project">${icon(task.worktreePath ? 'worktree' : 'folder')}${escape(project?.name ?? t('Project'))}<span>·</span>${providerLogo(task.provider)}<span>${({claude:'Claude Code',codex:'Codex',kimi:'Kimi Code',opencode:'OpenCode',glm:'GLM Coding Plan',antigravity:'Antigravity',grok:'Grok Build',mimo:'MiMo Token Plan',pi:'Pi',deepseek:'DeepSeek',commandcode:'Command Code',cline:'Cline',kilo:'Kilo Code',omp:'Oh My Pi','github-copilot':'GitHub Copilot CLI',muse:'Muse Code',devin:'Devin CLI',zcode:'ZCode',hermes:'Hermes Agent'})[task.provider]}</span>${links}</div>${task.taskDescription ? `<p class="task-description">${escape(task.taskDescription)}</p>` : ''}<div class="task-detail-stage-action">${action}</div></div><div class="task-comments-label">${t('Comments')}</div>`);
}
