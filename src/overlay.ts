import { t, tBackend } from './i18n.ts';
import './overlay.css';
import { escape, icon } from './dom';
import { mountExternalLinks } from './external-links';
import { providerLogo } from './provider-logos';
import { nativeOverlay, overlayCall, type OverlaySnapshot, type OverlayTask, type LaunchContext } from './overlay-client';
import type { FileEntry, ProviderId, ProviderModel } from './types';
import { fallbackModel } from './model-catalog';
import type { OverlayThreadView } from './overlay-thread';
import { mountFileMentions } from './file-mentions';
import { CLASSIC, restorePalette } from './palette';
import { accentTokens } from './palette-core';
import { parseHex } from './color';

function refreshTheme(): void {
  try { document.documentElement.dataset.theme = localStorage.getItem('pandacode.theme') === 'light' ? 'light' : 'dark'; } catch { /* Default to dark. */ }
  restorePalette();
  // palette.ts restores last session's accent on import; classic yellow leaves nothing saved, so derive it.
  const root = document.documentElement;
  if (!root.style.getPropertyValue('--accent')) {
    for (const [name, value] of Object.entries(accentTokens(parseHex(CLASSIC)!.rgb, root.dataset.theme as 'light' | 'dark'))) root.style.setProperty(name, value);
  }
}
refreshTheme();
window.addEventListener('storage', event => {
  if (event.key === 'pandacode.theme' || event.key === 'pandacode.palette') refreshTheme();
  // A language change rewrites the launcher's own labels: keep unsent text and start over in the new one.
  else if (event.key === 'pandacode.language') {
    try { sessionStorage.setItem('pandacode.launcher-draft', prompt.value); } catch { /* best effort */ }
    location.reload();
  }
});
const host = document.querySelector<HTMLDivElement>('#app')!;
host.innerHTML = `<main class="launcher" aria-label="${t('PandaCode quick launcher')}"><header class="launcher-heading"><span>${icon('bamboo')}PandaCode</span><button type="button" class="launcher-close" aria-label="${t('Close launcher')}"><kbd>esc</kbd></button></header><div class="launcher-home"><form class="launcher-compose"><label class="sr-only" for="launcher-prompt">${t('New task')}</label><textarea id="launcher-prompt" rows="2" maxlength="32768" placeholder="${t('What should we work on?')}" autofocus></textarea><div class="launcher-compose-footer"><label class="launcher-project">${icon('folder')}<select aria-label="${t('Task project')}"></select></label><button type="button" class="launcher-agent" aria-label="${t('Choose harness and model')}" aria-haspopup="dialog" aria-expanded="false"></button><button class="launcher-start" type="submit" aria-label="${t('Start task')}">${icon('arrow')}</button></div></form><p class="launcher-feedback" role="status" hidden></p><section class="launcher-task-area"><div class="launcher-list-heading"><h2>${t('Active agents')} <span class="launcher-count"></span></h2><label class="launcher-search">${icon('search')}<input type="search" aria-label="${t('Search tasks')}" placeholder="${t('Find a task')}" autocomplete="off"></label></div><div class="launcher-tasks" aria-label="${t('Active agents')}"><p class="launcher-empty">${t('Loading tasks…')}</p></div></section><footer class="launcher-footer"><span><kbd>↵</kbd> ${t('start task')}</span><span><kbd>⇧ ↵</kbd> ${t('new line')}</span><span class="launcher-live">${t('Live status')}</span></footer></div><section class="launcher-thread" hidden></section></main>`;
const prompt = host.querySelector<HTMLTextAreaElement>('textarea')!;
const project = host.querySelector<HTMLSelectElement>('select')!;
const list = host.querySelector<HTMLDivElement>('.launcher-tasks')!;
const search = host.querySelector<HTMLInputElement>('input[type=search]')!;
const feedback = host.querySelector<HTMLElement>('.launcher-feedback')!;
const start = host.querySelector<HTMLButtonElement>('.launcher-start')!;
const agentButton = host.querySelector<HTMLButtonElement>('.launcher-agent')!;
try {
  const restored = sessionStorage.getItem('pandacode.launcher-draft');
  if (restored) prompt.value = restored;
  sessionStorage.removeItem('pandacode.launcher-draft');
} catch { /* best effort */ }
let snapshot: OverlaySnapshot | null = null, visible = true, busy = false, refreshing = false;
let timer: number | undefined, lastProject = '', lastProjectMarkup = '', lastAgentMarkup = '';
const rows = new Map<string, HTMLButtonElement>();
const deletedSessions = new Set<string>();
let pickerCleanup: (() => void) | undefined, pickerRequest = 0, pickerLoading = false, modelSaving = false, modelRevision = 0;
const modelNames = new Map<string,string>();
try {
  const cached = JSON.parse(localStorage.getItem('pandacode.launcher-model-label') || 'null');
  if (cached && typeof cached.provider === 'string' && typeof cached.model === 'string' && typeof cached.name === 'string') modelNames.set(`${cached.provider}:${cached.model}`, cached.name.slice(0,160));
} catch { /* A display-label cache is optional. */ }
function rememberModelNames(provider: ProviderId, models: ProviderModel[]): void {
  for (const model of models) modelNames.set(`${provider}:${model.id}`,model.name);
  render();
}
function closeModelPicker(): void {
  pickerRequest++; const close = pickerCleanup; pickerCleanup = undefined; pickerLoading = false; close?.();
  if (feedback.textContent === t('Loading harnesses…')) showFeedback('');
  render();
}
async function chooseModel(): Promise<void> {
  if (!snapshot || busy || modelSaving || pickerLoading) return;
  if (pickerCleanup) { closeModelPicker(); return; }
  const request = ++pickerRequest; pickerLoading = true; showFeedback(t('Loading harnesses…')); render();
  try {
    const {openOverlayModelPicker} = await import('./overlay-model-picker');
    if (request !== pickerRequest || !visible) return;
    pickerCleanup = await openOverlayModelPicker({anchor:agentButton, current:{...snapshot.context},
      valid:() => request === pickerRequest && visible && !selectedTask,
      catalog:rememberModelNames,
      close:() => { if (request === pickerRequest) { pickerCleanup = undefined; pickerLoading = false; render(); } },
      select:async (provider,model) => {
        const current = snapshot!.context;
        modelSaving = true; modelRevision++; render();
        try {
          const context = await overlayCall<LaunchContext>('overlay_select_model', {provider,model,reasoningEffort:current.provider === provider && current.model === model ? current.reasoningEffort ?? null : null});
          modelRevision++; snapshot!.context = context;
          const name = modelNames.get(`${provider}:${model}`) || fallbackModel(provider,model).name;
          try { localStorage.setItem('pandacode.launcher-model-label',JSON.stringify({provider,model,name})); } catch { /* Selection itself is saved natively. */ }
          showFeedback('');
        } catch (error) { showFeedback(String(error),true); throw error; }
        finally { modelSaving = false; render(); }
      },
    });
  } catch (error) { if (request === pickerRequest) showFeedback(String(error),true); }
  finally { if (request === pickerRequest) { pickerLoading = false; if (feedback.textContent === t('Loading harnesses…')) showFeedback(''); render(); } }
}

let threadView: OverlayThreadView | undefined, threadLoading: Promise<OverlayThreadView> | undefined;
let selectedTask: OverlayTask | undefined, threadRequest = 0, threadPresented = false;
const fileMentions = mountFileMentions(prompt, {
  contextKey: () => visible && !selectedTask ? project.value : '',
  search: query => overlayCall<FileEntry[]>('search_files', {projectId:project.value, query, limit:30}),
});
function backToAgents(): void {
  const previous = selectedTask; selectedTask = undefined; threadRequest++; threadPresented = false; threadView?.close();
  host.querySelector<HTMLElement>('.launcher-thread')!.hidden = true;
  host.querySelector<HTMLElement>('.launcher-home')!.hidden = false;
  fileMentions.refresh();
  if (previous) rows.get(previous.id)?.focus();
  if (!previous || !rows.has(previous.id)) search.focus();
}
async function openThread(task: OverlayTask): Promise<void> {
  closeModelPicker();
  const request = ++threadRequest; selectedTask = task; threadPresented = false;
  fileMentions.refresh();
  host.querySelector<HTMLElement>('.launcher-home')!.hidden = true;
  const threadHost = host.querySelector<HTMLElement>('.launcher-thread')!;
  threadHost.hidden = false;
  threadLoading ??= import('./overlay-thread').then(({OverlayThreadView}) => threadView = new OverlayThreadView(threadHost,backToAgents, opened => { selectedTask = opened; }));
  try {
    const view = await threadLoading;
    if (request !== threadRequest || !visible) return;
    view.setVisible(true); view.open(task); threadPresented = true;
  } catch (error) { if (request === threadRequest) { threadLoading = undefined; backToAgents(); showFeedback(String(error),true); } }
}
function removeDeletedSessions(sessionIds: string[]): void {
  for (const id of sessionIds) deletedSessions.add(id);
  if (snapshot) { filterDeletedTasks(snapshot); render(); }
  if (selectedTask && (deletedSessions.has(selectedTask.sessionId) || deletedSessions.has(selectedTask.parentSessionId ?? ''))) backToAgents();
}
function filterDeletedTasks(value: OverlaySnapshot): void {
  value.tasks = value.tasks.filter(task => !deletedSessions.has(task.sessionId));
  value.activeCount = value.tasks.filter(task => ['running', 'waiting', 'coordinating'].includes(task.status)).length;
}
const label = (status: string): string => ({running:t('Working'),coordinating:t('Coordinating'),waiting:t('Needs attention'),interrupted:t('Paused'),error:t('Failed'),idle:t('Ready'),stopped:t('Stopped'),completed:t('Completed')}[status] || status);
function showFeedback(text: string, error = false): void { const message = tBackend(text); feedback.hidden = !message; feedback.textContent = message; feedback.classList.toggle('is-error', error); }
function render(): void {
  if (!snapshot) return;
  const previousProject = project.value;
  const markup = snapshot.projects.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
  if (markup !== lastProjectMarkup) { project.innerHTML = markup; lastProjectMarkup = markup; }
  if (!snapshot.projects.some(p => p.id === lastProject)) lastProject = snapshot.context.projectId || snapshot.projects[0]?.id || '';
  project.value = lastProject;
  if (previousProject !== project.value) fileMentions.refresh();
  start.disabled = busy || modelSaving || !snapshot.projects.length || !prompt.value.trim();
  agentButton.disabled = busy || modelSaving || pickerLoading;
  agentButton.setAttribute('aria-busy',String(modelSaving || pickerLoading));
  const name = {codex:'Codex',claude:'Claude Code',kimi:'Kimi Code',opencode:'OpenCode',glm:'GLM',antigravity:'Antigravity',grok:'Grok Build',mimo:'MiMo Token Plan',pi:'Pi',deepseek:'DeepSeek',commandcode:'Command Code',cline:'Cline',kilo:'Kilo Code',omp:'Oh My Pi','github-copilot':'GitHub Copilot CLI',muse:'Muse Code',devin:'Devin CLI',zcode:'ZCode',hermes:'Hermes Agent'}[snapshot.context.provider] || snapshot.context.provider;
  const modelName = modelNames.get(`${snapshot.context.provider}:${snapshot.context.model}`) || fallbackModel(snapshot.context.provider as ProviderId,snapshot.context.model).name;
  const teamCount = snapshot.teamWorkerCount ?? 0;
  const teamLabel = teamCount > 0 ? `+${teamCount} ${teamCount === 1 ? t('model') : t('models')}` : '';
  const agentMarkup = `${providerLogo(snapshot.context.provider as ProviderId)}<span class="launcher-model-name">${escape(modelName === 'Default' ? `${name} · ${t('Default')}` : modelName)}</span>${teamLabel ? `<span class="launcher-team-models">${teamLabel}</span>` : ''}${icon('down')}`;
  agentButton.title = `${name} · ${modelName}${teamLabel ? ` ${teamLabel}` : ''}`;
  if (agentMarkup !== lastAgentMarkup) { host.querySelector('.launcher-agent')!.innerHTML = agentMarkup; lastAgentMarkup = agentMarkup; }
  host.querySelector('.launcher-count')!.textContent = snapshot.activeCount ? t`${snapshot.activeCount} active` : '';
  const tasks = snapshot.tasks.filter(task => ['running','waiting','coordinating'].includes(task.status) && `${task.title} ${task.parentTitle ?? ''} ${task.projectName} ${task.provider}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));
  const ids = new Set(tasks.map(t => t.id));
  for (const [id,row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
  list.querySelector('.launcher-empty')?.remove();
  for (const [index,task] of tasks.entries()) {
    let row = rows.get(task.id);
    if (!row) { row = document.createElement('button'); row.type = 'button'; row.className = 'launcher-task'; row.dataset.task = task.id; rows.set(task.id,row); }
    row.dataset.kind = task.kind;
    const detail = [task.kind === 'worker' ? t('Worker') : task.kind === 'subagent' ? t('Subagent') : '', task.projectName, task.parentTitle].filter(Boolean).join(' · ');
    const content = `<span class="launcher-task-logo">${providerLogo(task.provider as ProviderId)}</span><span class="launcher-task-text"><strong>${escape(task.title)}</strong><small title="${escape(detail)}">${escape(detail)}</small></span><span class="launcher-task-status ${escape(task.status)}"><i></i>${escape(label(task.status))}</span>${icon('chevron')}`;
    if (row.dataset.signature !== content) { row.innerHTML = content; row.dataset.signature = content; }
    if (list.children[index] !== row) list.insertBefore(row,list.children[index] || null);
  }
  if (!tasks.length) list.innerHTML = `<p class="launcher-empty">${snapshot.projects.length ? search.value ? t('No matching active agents.') : t('No agents working right now.') : t('Open a project in PandaCode to get started.')}</p>`;
}
async function refresh(): Promise<void> {
  if (!visible || refreshing) return;
  refreshing = true;
  try {
    const revision = modelRevision, next = await overlayCall<OverlaySnapshot>('overlay_snapshot');
    filterDeletedTasks(next);
    if (revision !== modelRevision && snapshot) next.context = {...next.context,provider:snapshot.context.provider,model:snapshot.context.model,reasoningEffort:snapshot.context.reasoningEffort};
    snapshot = next;
    if (visible) { render(); threadView?.refresh(); }
  }
  catch (error) { if (visible) showFeedback(String(error),true); }
  finally { refreshing = false; if (visible) timer = window.setTimeout(refresh,1500); }
}
function setVisible(value: boolean): void {
  visible = value; clearTimeout(timer); timer = undefined; threadView?.setVisible(value); if (!value) closeModelPicker();
  fileMentions.refresh();
  if (value) { refreshTheme(); if (!prompt.value.trim()) lastProject = ''; delete document.documentElement.dataset.overlayHidden; void refresh(); if (selectedTask && !threadPresented) void openThread(selectedTask); if (!selectedTask) prompt.focus({preventScroll:true}); }
}
async function hide(): Promise<void> { setVisible(false); await overlayCall('overlay_hide'); }
async function submit(event?: Event): Promise<void> {
  event?.preventDefault(); if (busy || modelSaving || !prompt.value.trim() || !project.value) return;
  closeModelPicker();
  busy = true; render(); showFeedback(t('Starting task…'));
  try {
    await overlayCall('overlay_launch',{prompt:prompt.value.trim(),projectId:project.value});
    prompt.value = ''; fileMentions.refresh(); showFeedback(t('Task started. You can keep working.'));
    clearTimeout(timer); void refresh();
  } catch (error) { showFeedback(String(error instanceof Error ? error.message : error),true); }
  finally { busy = false; render(); prompt.focus({preventScroll:true}); }
}
agentButton.addEventListener('click',() => void chooseModel());
host.querySelector('form')!.addEventListener('submit', submit);
host.querySelector('.launcher-close')!.addEventListener('click',() => void hide());
prompt.addEventListener('input',render); search.addEventListener('input',render);
project.addEventListener('change',() => { lastProject = project.value; fileMentions.refresh(); });
list.addEventListener('click', event => {
  const row = (event.target as Element).closest<HTMLButtonElement>('[data-task]');
  const task = snapshot?.tasks.find(task => task.id === row?.dataset.task);
  if (task) void openThread(task);
});
list.addEventListener('keydown', event => {
  if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
  const items = Array.from(list.querySelectorAll<HTMLButtonElement>('[data-task]'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement); if (index < 0) return;
  event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});
window.addEventListener('keydown',event => {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); if (pickerCleanup || pickerLoading) { closeModelPicker(); return; } if (selectedTask) backToAgents(); else void hide(); }
  if (event.key === 'Enter' && event.target === prompt && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
  if (event.key === 'ArrowDown' && event.target === search) { event.preventDefault(); list.querySelector<HTMLButtonElement>('[data-task]')?.focus(); }
});
window.addEventListener('pagehide',() => { setVisible(false); fileMentions.dispose(); });
mountExternalLinks(document, url => overlayCall('open_external_url', { url }), error => showFeedback(error instanceof Error ? error.message : String(error), true));
if (nativeOverlay) {
  void import('@tauri-apps/api/event').then(({listen}) => listen<boolean>('overlay-visibility',event => setVisible(event.payload)));
  void import('@tauri-apps/api/event').then(({listen}) => listen<{sessionIds: string[]}>('sessions-deleted', event => removeDeletedSessions(event.payload.sessionIds)));
} else {
  window.addEventListener('pandacode-overlay-sessions-deleted', event => removeDeletedSessions((event as CustomEvent<{sessionIds: string[]}>).detail.sessionIds));
  window.addEventListener('focus',() => setVisible(true));
  window.addEventListener('blur',() => setVisible(false));
}
void refresh(); prompt.focus();
