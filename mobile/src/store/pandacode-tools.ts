// Sentences for PandaCode's own MCP tools (team coordination, title, change tracking, simulator,
// VM, design canvas, preview), as the desktop's pandacodeTrace in src/tool-trace.ts and the team
// lines in src/team-progress.ts word them. Pure (tested in node).
type Fields = Record<string, unknown>;
/** Worker id → display name, from the task's team when the phone has it. */
export type WorkerNames = Readonly<Record<string, string>>;
/** [running verb, finished verb, object] */
type Sentence = [string, string, string];

const MAX = 60;
const clip = (value: string, limit = MAX) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const str = (f: Fields, key: string) => (typeof f[key] === 'string' ? f[key] as string : '');
const num = (f: Fields, key: string) => (typeof f[key] === 'number' && Number.isFinite(f[key]) ? Math.round(f[key] as number) : undefined);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (value: string) => (value ? `“${clip(value)}”` : '');
const point = (f: Fields, x = 'x', y = 'y') => (num(f, x) !== undefined && num(f, y) !== undefined ? `(${num(f, x)}, ${num(f, y)})` : '');
const list = (f: Fields, key: string) => (Array.isArray(f[key]) ? f[key] as unknown[] : []);

/** `mcp__pandacode_architect__pandacode_dispatch_workers`, `pandacode_title` → `dispatch_workers`, `title`; undefined for other tools. */
export function ownTool(name: string): string | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const [server, tool] = mcp ? [mcp[1], mcp[2]] : ['', name];
  if (mcp && !/^pandacode/i.test(server)) return;
  if (!/^pandacode_/i.test(tool) && !mcp) return;
  return tool.replace(/^pandacode_architect_/i, '').replace(/^pandacode_/i, '').toLowerCase();
}

/** A worker's name from the team, else a generic word. */
function worker(id: string, names: WorkerNames, fallback = 'a worker'): string {
  if (id === 'architect') return 'the architect';
  return names[id] || fallback;
}

const SIM_CONTROL: Record<string, [string, string]> = {
  tap: ['Tapping', 'Tapped'], double_tap: ['Double-tapping', 'Double-tapped'], long_press: ['Long-pressing', 'Long-pressed'],
  swipe: ['Swiping', 'Swiped'], type: ['Typing', 'Typed'], key: ['Pressing', 'Pressed'], button: ['Pressing', 'Pressed'], tap_label: ['Tapping', 'Tapped'],
};
const VM_CONTROL: Record<string, [string, string]> = {
  click: ['Clicking', 'Clicked'], double_click: ['Double-clicking', 'Double-clicked'], right_click: ['Right-clicking', 'Right-clicked'],
  middle_click: ['Middle-clicking', 'Middle-clicked'], move: ['Moving to', 'Moved to'], drag: ['Dragging', 'Dragged'],
  scroll: ['Scrolling', 'Scrolled'], type: ['Typing', 'Typed'], key: ['Pressing', 'Pressed'],
};
const MANAGE: Record<string, [string, string]> = {
  boot: ['Booting', 'Booted'], shutdown: ['Shutting down', 'Shut down'], show: ['Showing', 'Showed'], install: ['Installing', 'Installed'],
  launch: ['Launching', 'Launched'], terminate: ['Quitting', 'Quit'], open_url: ['Opening', 'Opened'], appearance: ['Switching', 'Switched'],
  pose: ['Folding', 'Folded'], create: ['Creating', 'Created'], start: ['Starting', 'Started'], stop: ['Stopping', 'Stopped'],
  suspend: ['Suspending', 'Suspended'], delete: ['Deleting', 'Deleted'], install_desktop: ['Installing a desktop on', 'Installed a desktop on'],
};

function control(f: Fields, verbs: Record<string, [string, string]>): Sentence {
  const action = str(f, 'action');
  const [run, done] = verbs[action] ?? ['Using', 'Used'];
  const object = action === 'swipe' || action === 'drag' ? [point(f), point(f, 'endX', 'endY')].filter(Boolean).join(' → ')
    : action === 'type' ? quoted(str(f, 'text'))
    : action === 'key' ? str(f, 'key') || str(f, 'keys')
    : action === 'button' ? str(f, 'button')
    : action === 'tap_label' ? quoted(str(f, 'label'))
    : action === 'scroll' ? [str(f, 'direction'), point(f) && `at ${point(f)}`].filter(Boolean).join(' ')
    : point(f) || action.replace(/_/g, ' ');
  return [run, done, object];
}

function manage(f: Fields, what: string): Sentence {
  const action = str(f, 'action');
  const [run, done] = MANAGE[action] ?? ['Managing', 'Managed'];
  const object = action === 'launch' || action === 'terminate' ? str(f, 'bundleId') || 'the app'
    : action === 'install' ? (str(f, 'path').split('/').pop() || 'the app')
    : action === 'open_url' ? clip(str(f, 'url'))
    : action === 'appearance' ? `to ${str(f, 'appearance') || 'another'} mode`
    : action === 'pose' ? `to ${str(f, 'pose') || 'a new pose'}`
    : str(f, 'name') ? `${what} ${str(f, 'name')}` : `the ${what}`;
  return [run, done, object];
}

const SENTENCES: Record<string, (f: Fields, names: WorkerNames) => Sentence> = {
  dispatch_workers: f => {
    const n = list(f, 'assignments').length || list(f, 'workers').length || list(f, 'tasks').length;
    return ['Dispatching', 'Dispatched', n ? count(n, 'worker') : 'workers'];
  },
  followup_worker: (f, names) => ['Asking', 'Asked', `${worker(str(f, 'workerId'), names)} for a follow-up`],
  cancel_worker: (f, names) => ['Cancelling', 'Cancelled', worker(str(f, 'workerId'), names)],
  read_worker: (f, names) => ['Checking on', 'Checked on', worker(str(f, 'workerId'), names)],
  list_workers: () => ['Checking', 'Checked', 'the workers'],
  finish_team: () => ['Finishing', 'Finished', 'the team'],
  send_team_message: (f, names) => ['Messaging', 'Messaged', worker(str(f, 'recipient'), names, str(f, 'recipient') ? clip(str(f, 'recipient'), 30) : 'a teammate')],
  read_team_mailbox: () => ['Reading', 'Read', 'the team mailbox'],
  team_directory: () => ['Looking up', 'Looked up', 'the team'],
  checkpoint_worker: f => ['Saving', 'Saved', str(f, 'blocker') ? 'a checkpoint with a blocker' : 'a checkpoint'],
  title: f => ['Renaming', 'Renamed', str(f, 'title') ? `thread to ${quoted(str(f, 'title'))}` : 'the thread'],
  track_files: f => {
    const n = list(f, 'paths').length;
    return str(f, 'action') === 'complete' ? ['Recording', 'Recorded', n ? count(n, 'changed file') : 'changed files'] : ['Tracking', 'Tracked', n ? count(n, 'file') : 'files'];
  },
  simulator_screenshot: () => ['Taking', 'Took', 'a simulator screenshot'],
  simulator_describe: f => ['Reading', 'Read', point(f) ? `the simulator element at ${point(f)}` : 'the simulator screen'],
  simulator_devices: () => ['Listing', 'Listed', 'simulators'],
  simulator_control: f => control(f, SIM_CONTROL),
  simulator_manage: f => manage(f, 'simulator'),
  vm_screenshot: () => ['Taking', 'Took', 'a VM screenshot'],
  vm_list: () => ['Listing', 'Listed', 'VMs'],
  vm_control: f => control(f, VM_CONTROL),
  vm_manage: f => manage(f, 'VM'),
  design_write: f => ['Drawing', 'Drew', str(f, 'name') || str(f, 'title') ? `artboard ${quoted(str(f, 'name') || str(f, 'title'))}` : 'an artboard'],
  design_list: () => ['Listing', 'Listed', 'artboards'],
  design_comments: () => ['Reading', 'Read', 'design comments'],
  design_resolve: () => ['Resolving', 'Resolved', 'a design comment'],
  preview_file: f => ['Previewing', 'Previewed', str(f, 'path').split('/').pop() || 'a file'],
  run_project: () => ['Running', 'Ran', 'the project'],
  cloud_cli: f => ['Running', 'Ran', clip(str(f, 'cli') || str(f, 'tool') || 'a deploy command', 40)],
};

/** `Dispatched 3 workers`, `Tapped (200, 618)`: the sentence for one of PandaCode's own tools, or undefined. */
export function ownSentence(tool: string, fields: Fields, running: boolean, names: WorkerNames = {}): { verb: string; object: string } | undefined {
  const sentence = SENTENCES[tool]?.(fields, names);
  return sentence && { verb: sentence[running ? 0 : 1], object: sentence[2] };
}

export interface Assignment { key: string; name: string; prompt: string; provider: string; model: string; profileId: string; files: string[]; readOnly: boolean; dependsOn: string[] }

/** dispatch_workers' assignments, for the expanded card per worker. */
export function assignmentsOf(fields: Fields): Assignment[] {
  return list(fields, 'assignments').filter((a): a is Fields => !!a && typeof a === 'object').slice(0, 12).map(a => ({
    key: str(a, 'key'), name: str(a, 'name') || str(a, 'key') || 'Worker', prompt: str(a, 'prompt'), provider: str(a, 'provider'), model: str(a, 'model'),
    profileId: str(a, 'profileId'), readOnly: a.readOnly === true,
    files: list(a, 'files').filter((x): x is string => typeof x === 'string'), dependsOn: list(a, 'dependsOn').filter((x): x is string => typeof x === 'string'),
  }));
}

/** A screenshot a tool result carries as a data: URL or bare base64 PNG/JPEG; undefined when the host dropped the bytes. */
export function imageOf(output: string): string | undefined {
  const data = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]{100,}/.exec(output.slice(0, 4_000_000));
  if (data) return data[0];
  const bare = /"(?:data|base64)"\s*:\s*"((?:iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/=]{100,})"/.exec(output.slice(0, 4_000_000));
  return bare ? `data:image/${bare[1].startsWith('/9j/') ? 'jpeg' : 'png'};base64,${bare[1]}` : undefined;
}
