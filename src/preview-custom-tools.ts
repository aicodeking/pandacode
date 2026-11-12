/* Browser preview of agent-made tools (custom_tools.rs): a seeded in-memory store the
 * Settings spec can drag, move, disable and delete. */
import type { CustomTool, CustomToolsList } from './custom-tools-settings';

const DAY = 86_400_000;
const author = { sessionId: 'preview-task-1', harness: 'claude', model: 'claude-opus-5-5' };
function sample(name: string, when: string, script: string, scope: CustomTool['scope'], age: number, stats: Partial<CustomTool['stats']> = {}): CustomTool {
  const created = Date.now() - age * DAY;
  return {
    name, description: `${when}.`, when, script, params: [], timeoutSecs: 50, version: 1,
    createdAt: created, updatedAt: created, createdBy: author, updatedBy: null, disabled: false,
    stats: { uses: 0, failures: 0, lastUsedAt: null, tasks: [], lastExit: null, ...stats }, scope,
  };
}
/** Preview projects (`list_projects` in preview.ts): orbit has no tools, so a global tool can move there. */
const PROJECT_NAMES: Record<string, string> = { 'project-1': 'orbit', 'project-2': 'pandacode' };
function seed(): CustomToolsList {
  return {
    global: [sample('git-recent-branches', 'Find a branch you worked on lately', 'git for-each-ref --sort=-committerdate refs/heads --count=10', 'global', 20, { uses: 7, tasks: ['a', 'b', 'c'], lastUsedAt: Date.now() - DAY, lastExit: 0 })],
    projects: [
      { projectId: 'project-2', projectName: 'pandacode', tools: [
        sample('run-e2e-subset', 'Before finishing a UI change', 'npx playwright test "$PC_FILE" --reporter=line', 'project', 9, { uses: 12, failures: 2, tasks: ['a', 'b', 'c', 'd'], lastUsedAt: Date.now() - 2 * DAY, lastExit: 0 }),
        sample('regen-accents', 'After wallpaper scenes change', 'node scripts/wallpaper-accents.mjs', 'project', 6),
        sample('git-recent-branches', 'Find a branch you worked on lately', 'git branch --sort=-committerdate | head', 'project', 2, { uses: 1, tasks: ['e'], lastUsedAt: Date.now() - 3_600_000, lastExit: 0 }),
      ] },
    ],
  };
}
let store = seed();

type Args = Record<string, any>;
const listOf = (projectId: string | null) => projectId === null ? store.global : store.projects.find(p => p.projectId === projectId)?.tools;
function find(name: string, projectId: string | null): CustomTool {
  const tool = listOf(projectId)?.find(t => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}.`);
  return tool;
}
/** Replaces one list immutably; `null` is Global. A project without tools gets its list here. */
function withList(projectId: string | null, tools: CustomTool[]): CustomToolsList {
  if (projectId === null) return { ...store, global: tools };
  if (!store.projects.some(p => p.projectId === projectId)) {
    if (!PROJECT_NAMES[projectId]) throw new Error('No such project.');
    return { ...store, projects: [...store.projects, { projectId, projectName: PROJECT_NAMES[projectId], tools }] };
  }
  return { ...store, projects: store.projects.map(p => p.projectId === projectId ? { ...p, tools } : p) };
}

/** Handles `custom_tool*` commands; `handled: false` for anything else. */
export function customToolsCommand(command: string, args: Args, emit: (name: string, event: unknown) => void): { handled: boolean; result?: unknown } {
  const change = (next: CustomToolsList) => { store = next; emit('custom-tools-changed', {}); return { handled: true, result: null }; };
  switch (command) {
    case 'custom_tools_list':
      // Tests: `window.__customToolsFail = n` fails the next n reads.
      if ((window as any).__customToolsFail > 0) { (window as any).__customToolsFail--; throw new Error('The tool folder could not be read.'); }
      // Tests: `window.__customToolsEmpty = true` starts with no tools at all.
      if ((window as any).__customToolsEmpty) { (window as any).__customToolsEmpty = false; store = { global: [], projects: [] }; }
      return { handled: true, result: structuredClone(store) };
    case 'custom_tool_move': {
      const { name, fromProjectId = null, toProjectId = null } = args;
      const tool = find(name, fromProjectId);
      if ((listOf(toProjectId) ?? []).some(t => t.name === name)) throw new Error(`A tool named ${name} already exists there.`);
      store = withList(fromProjectId, listOf(fromProjectId)!.filter(t => t !== tool));
      return change(withList(toProjectId, [...listOf(toProjectId) ?? [], { ...tool, scope: toProjectId === null ? 'global' : 'project' }]));
    }
    case 'custom_tool_delete': {
      const tool = find(args.name, args.projectId ?? null);
      return change(withList(args.projectId ?? null, listOf(args.projectId ?? null)!.filter(t => t !== tool)));
    }
    case 'custom_tool_set_disabled': {
      const tool = find(args.name, args.projectId ?? null);
      return change(withList(args.projectId ?? null, listOf(args.projectId ?? null)!.map(t => t === tool ? { ...t, disabled: Boolean(args.disabled) } : t)));
    }
    default: return { handled: false };
  }
}
