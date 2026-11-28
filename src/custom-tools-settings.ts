/* Settings → Tools & add-ons → Agent-made tools (docs/custom-tools.md): scripts agents saved with
 * `pandacode_tool_save`, a Global list and one list per project. Only the user makes a tool global:
 * drag a project row onto Global, or use its … menu (the keyboard path). Native side: custom_tools.rs. */
import './custom-tools-settings.css';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import { openChoiceMenu } from './choice-menu';
import { isChatProject } from './chats';
import type { Project } from './types';

export type ToolAuthor = { sessionId: string; harness: string; model: string };
export type CustomTool = {
  name: string; description: string; when: string; script: string;
  params: { name: string; description: string; required: boolean }[];
  timeoutSecs: number; version: number; createdAt: number; updatedAt: number;
  createdBy: ToolAuthor; updatedBy?: ToolAuthor | null; disabled: boolean;
  stats: { uses: number; failures: number; lastUsedAt: number | null; tasks: string[]; lastExit: number | null };
  scope: 'global' | 'project';
};
export type CustomToolsList = { global: CustomTool[]; projects: { projectId: string; projectName: string; tools: CustomTool[] }[] };
type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (name: string, callback: () => void) => Promise<() => void>;

export const CUSTOM_TOOLS_CHANGED = 'custom-tools-changed';
const DAY = 86_400_000;
/** A tool nobody ran this long after it was made reads "Never used". */
const UNUSED_AFTER = 3 * DAY;

/** A native timestamp (epoch ms), or null when unset. */
function ms(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}
/** `Used 12× by 4 tasks · last 2 d ago`, `Never used` (muted) or `Not used yet`. */
export function usageText(tool: CustomTool, now = Date.now()): { text: string; never: boolean } {
  const { uses, tasks, lastUsedAt } = tool.stats;
  if (uses > 0) {
    const last = ms(lastUsedAt);
    return { text: `Used ${uses}× by ${tasks.length} task${tasks.length === 1 ? '' : 's'}${last ? ` · last ${ago(last, now)}` : ''}`, never: false };
  }
  const created = ms(tool.createdAt);
  return created !== null && now - created > UNUSED_AFTER ? { text: 'Never used', never: true } : { text: 'Not used yet', never: false };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const key = (projectId: string | null, name: string) => `${projectId ?? ''}\u0000${name}`;
/** Which row asks to confirm a delete and which shows its script (`key`s, or ''). */
type View = { confirming: string; viewing: string };

function rowHtml(tool: CustomTool, projectId: string | null, view: View): string {
  const k = key(projectId, tool.name), usage = usageText(tool);
  const controls = view.confirming === k
    ? `<span class="custom-tool-confirm">Delete?</span><button type="button" class="secondary-button custom-tool-delete-yes" data-delete-yes aria-label="Delete ${escape(tool.name)}">Delete</button><button type="button" class="secondary-button" data-delete-no aria-label="Keep ${escape(tool.name)}">Keep</button>`
    : `<button type="button" class="icon-button" data-more aria-haspopup="menu" aria-label="More for ${escape(tool.name)}" title="More">${icon('more')}</button>`;
  const script = view.viewing === k ? `<pre class="custom-tool-script" aria-label="Script of ${escape(tool.name)}" tabindex="0">${escape(tool.script)}</pre>` : '';
  return `<li class="custom-tool" data-name="${escape(tool.name)}" data-project="${escape(projectId ?? '')}" data-disabled="${tool.disabled}">
    <div class="custom-tool-row"${projectId !== null ? ' draggable="true"' : ''}>
      <div class="custom-tool-main">
        <span class="custom-tool-title"><strong>${escape(tool.name)}</strong>${tool.disabled ? '<span class="custom-tool-badge">Disabled</span>' : ''}${tool.description ? infoMark(tool.description, `About ${tool.name}`) : ''}</span>
        <span class="custom-tool-meta"><span class="custom-tool-when">${escape(tool.when)}</span><span class="custom-tool-usage"${usage.never ? ' data-never' : ''}>${escape(usage.text)}</span></span>
      </div>${controls}
    </div>${script}
  </li>`;
}

function listHtml(label: string, sub: string, tools: CustomTool[], projectId: string | null, view: View): string {
  const drop = projectId === null ? ' data-drop="global"' : '';
  const empty = projectId === null ? '<li class="custom-tools-none">Drag a project tool here to use it in every project.</li>' : '';
  return `<section class="custom-tools-group" tabindex="-1" data-list="${escape(projectId ?? '')}" aria-label="${escape(label)}"${drop}>
    <div class="custom-tools-head"><strong>${escape(label)}</strong><small>${escape(sub)}</small></div>
    <ul class="custom-tools-list settings-group">${tools.map(tool => rowHtml(tool, projectId, view)).join('') || empty}</ul>
  </section>`;
}

/** Drag a project row onto Global; only the user promotes a tool. Returns the host listeners.
 * No `setData`: the drop reads `dragged`, and Chrome and WebKit start the drag of a
 * `draggable` row without any data (`tests/custom-tools.spec.ts` drags in both). */
function dragHandlers(host: HTMLElement, projectOf: (target: Element) => { name: string; projectId: string } | null, promote: (name: string, projectId: string) => void): [string, EventListener][] {
  let dragged: { name: string; projectId: string } | null = null;
  const globalZone = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-drop="global"]') : null;
  const start = (event: DragEvent) => {
    dragged = event.target instanceof Element ? projectOf(event.target) : null;
    if (!dragged || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    host.classList.add('is-dragging');
  };
  const over = (event: DragEvent) => {
    const zone = globalZone(event.target);
    if (!zone || !dragged) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    zone.dataset.over = '';
  };
  const leave = (event: DragEvent) => {
    const zone = globalZone(event.target);
    if (zone && !zone.contains(event.relatedTarget as Node | null)) delete zone.dataset.over;
  };
  const end = () => {
    dragged = null; host.classList.remove('is-dragging');
    host.querySelectorAll<HTMLElement>('[data-over]').forEach(zone => delete zone.dataset.over);
  };
  const drop = (event: DragEvent) => {
    const from = dragged;
    if (!globalZone(event.target) || !from) return;
    event.preventDefault(); end();
    promote(from.name, from.projectId);
  };
  return [['dragstart', start as EventListener], ['dragover', over as EventListener], ['dragleave', leave as EventListener], ['drop', drop as EventListener], ['dragend', end]];
}

/** One mounted panel's state, shared by the module-level handlers below. */
type Ctx = {
  host: HTMLElement; call: Call;
  data: CustomToolsList | null;
  /** Every user project, so a global tool can move to a project that has no tools yet. */
  projects: { id: string; name: string }[];
  error: string; loadFailed: string; disposed: boolean;
  view: View; menu?: () => void;
};

function draw(ctx: Ctx): void {
  const { host, data, error, loadFailed, view } = ctx;
  if (ctx.disposed) return;
  const alert = error ? `<p class="custom-tools-error" role="alert">${escape(error)}</p>` : '';
  const head = `<h3 class="settings-heading">Agent-made tools</h3>${alert}`;
  if (!data && loadFailed) {
    host.innerHTML = `${head}<p class="custom-tools-error" role="alert">Couldn’t read agent-made tools. ${escape(loadFailed)}</p><button type="button" class="secondary-button" data-retry>Retry</button>`;
    return;
  }
  if (!data) { host.innerHTML = `${head}<p class="dialog-loading">Loading…</p>`; return; }
  if (!data.global.length && !data.projects.some(p => p.tools.length)) {
    host.innerHTML = `${head}<p class="custom-tools-empty" tabindex="-1">No tools yet. Turn on Agent-made tools above so agents can save repeated work here for reuse.</p>`;
    return;
  }
  host.innerHTML = head + listHtml('Global', 'Every project', data.global, null, view)
    + data.projects.filter(p => p.tools.length).map(p => listHtml(p.projectName, 'This project', p.tools, p.projectId, view)).join('');
}

/** User projects as Settings → Projects lists them: bot workspaces and chats left out. */
async function loadProjects(ctx: Ctx): Promise<void> {
  const [all, bots] = await Promise.all([
    ctx.call<Project[]>('list_projects').catch(() => [] as Project[]),
    ctx.call<{ projectId: string }[]>('bots_list').catch(() => []),
  ]);
  const botIds = new Set(bots.map(bot => bot.projectId));
  ctx.projects = all.filter(project => !botIds.has(project.id) && !isChatProject(project)).map(({ id, name }) => ({ id, name }));
}

async function load(ctx: Ctx): Promise<void> {
  try { [ctx.data] = await Promise.all([ctx.call<CustomToolsList>('custom_tools_list'), loadProjects(ctx)]); ctx.loadFailed = ''; }
  catch (failure) { if (ctx.data) ctx.error = `Couldn’t read agent-made tools. ${message(failure)}`; else ctx.loadFailed = message(failure); }
  draw(ctx);
}

/** Runs one change, redraws, then puts focus where `focus` says (the list was redrawn under it). */
async function act(ctx: Ctx, command: string, args: Record<string, unknown>, focus: (ok: boolean) => void): Promise<void> {
  ctx.error = '';
  let ok = true;
  try { await ctx.call(command, args); } catch (failure) { ctx.error = message(failure); ok = false; }
  if (ctx.disposed) return;
  await load(ctx);
  if (!ctx.disposed) focus(ok);
}

const moreButton = (ctx: Ctx, projectId: string | null, name: string) =>
  ctx.host.querySelector<HTMLElement>(`.custom-tool[data-project="${CSS.escape(projectId ?? '')}"][data-name="${CSS.escape(name)}"] [data-more]`);
const focusMore = (ctx: Ctx, projectId: string | null, name: string) => moreButton(ctx, projectId, name)?.focus();
/** After a failed move the tool is still where it was. */
const move = (ctx: Ctx, name: string, fromProjectId: string | null, toProjectId: string | null) =>
  act(ctx, 'custom_tool_move', { name, fromProjectId, toProjectId }, ok => moreButton(ctx, ok ? toProjectId : fromProjectId, name)?.focus());

/** After a delete: the next row's … button, else the previous one, else the section (or the empty state). */
function remove(ctx: Ctx, name: string, projectId: string | null): void {
  const { host } = ctx;
  const names = [...host.querySelectorAll<HTMLElement>(`[data-list="${CSS.escape(projectId ?? '')}"] .custom-tool`)].map(row => row.dataset.name!);
  const at = names.indexOf(name), neighbours = [names[at + 1], names[at - 1]].filter(Boolean);
  void act(ctx, 'custom_tool_delete', { name, projectId }, () => {
    const next = neighbours.map(other => moreButton(ctx, projectId, other)).find(Boolean);
    (next ?? host.querySelector<HTMLElement>(`[data-list="${CSS.escape(projectId ?? '')}"]`) ?? host.querySelector<HTMLElement>('[data-list=""], .custom-tools-empty, [data-retry]'))?.focus();
  });
}

function openMenu(ctx: Ctx, anchor: HTMLElement, tool: CustomTool, projectId: string | null): void {
  if (ctx.menu) { ctx.menu(); return; }
  const { view } = ctx, k = key(projectId, tool.name);
  const moves = projectId === null
    ? ctx.projects.map(p => ({ id: `move:${p.id}`, label: `Move to ${p.name}`, icon: 'folder' }))
    : [{ id: 'global', label: 'Make global', icon: 'globe' }];
  ctx.menu = openChoiceMenu({ anchor, title: `Actions for ${tool.name}`, actions: true, items: [
    ...moves,
    { id: 'script', label: view.viewing === k ? 'Hide script' : 'View script', icon: 'command', separator: true },
    { id: 'disable', label: tool.disabled ? 'Enable' : 'Disable', icon: tool.disabled ? 'play' : 'pause' },
    { id: 'delete', label: 'Delete…', icon: 'trash', danger: true, separator: true },
  ], onSelect: async id => {
    if (id === 'global') await move(ctx, tool.name, projectId, null);
    else if (id.startsWith('move:')) await move(ctx, tool.name, null, id.slice(5));
    else if (id === 'disable') await act(ctx, 'custom_tool_set_disabled', { name: tool.name, projectId, disabled: !tool.disabled }, () => focusMore(ctx, projectId, tool.name));
    else if (id === 'script') setTimeout(() => { view.viewing = view.viewing === k ? '' : k; draw(ctx); focusMore(ctx, projectId, tool.name); });
    else setTimeout(() => { view.confirming = k; draw(ctx); ctx.host.querySelector<HTMLElement>('[data-delete-no]')?.focus(); });
  }, onClose: () => { ctx.menu = undefined; } });
}

/** The tool a row inside `target` shows, and its project (null for Global). */
function located(ctx: Ctx, target: Element | null): { tool: CustomTool; projectId: string | null } | null {
  const row = target?.closest<HTMLElement>('.custom-tool');
  if (!row || !ctx.data) return null;
  const projectId = row.dataset.project || null, name = row.dataset.name!;
  const tools = projectId === null ? ctx.data.global : ctx.data.projects.find(p => p.projectId === projectId)?.tools ?? [];
  const tool = tools.find(t => t.name === name);
  return tool ? { tool, projectId } : null;
}

function onClick(ctx: Ctx, event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-retry]')) { ctx.loadFailed = ''; draw(ctx); void load(ctx); return; }
  const found = located(ctx, target);
  if (!target || !found) return;
  const { tool, projectId } = found;
  if (target.closest('[data-delete-no]')) { ctx.view.confirming = ''; draw(ctx); focusMore(ctx, projectId, tool.name); return; }
  if (target.closest('[data-delete-yes]')) { ctx.view.confirming = ''; remove(ctx, tool.name, projectId); return; }
  const more = target.closest<HTMLElement>('[data-more]');
  if (more) openMenu(ctx, more, tool, projectId);
}

export function mountCustomTools(host: HTMLElement, call: Call, listen: Listen): () => void {
  const ctx: Ctx = { host, call, data: null, projects: [], error: '', loadFailed: '', disposed: false, view: { confirming: '', viewing: '' } };
  let stop: (() => void) | undefined;
  const projectRow = (target: Element) => {
    if (!target.closest('.custom-tool-row[draggable="true"]')) return null;
    const found = located(ctx, target);
    return found?.projectId ? { name: found.tool.name, projectId: found.projectId } : null;
  };
  const events: [string, EventListener][] = [
    ['click', (event => onClick(ctx, event as MouseEvent)) as EventListener],
    ...dragHandlers(host, projectRow, (name, projectId) => void move(ctx, name, projectId, null)),
  ];
  events.forEach(([name, fn]) => host.addEventListener(name, fn));
  void listen(CUSTOM_TOOLS_CHANGED, () => { if (!ctx.disposed) void load(ctx); }).then(off => { if (ctx.disposed) off(); else stop = off; });
  draw(ctx);
  void load(ctx);
  return () => {
    ctx.disposed = true; ctx.menu?.(); stop?.();
    events.forEach(([name, fn]) => host.removeEventListener(name, fn));
  };
}
