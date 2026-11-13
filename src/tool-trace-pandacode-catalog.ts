import { ROW_TEXT } from './tool-text.ts';
import { escape } from './dom.ts';
import { COMPLETE, basename, clip, field, kvTable, lines, resultCard, excerptCard, text, type Fields } from './tool-trace.ts';
import {
  action, actionCard, artboard, artboardCard, assignments, beyond, bubble, chip, cloudCard, codeCard, commentCard, count, device, deviceCard, simDevice,
  directoryCard, directoryRow, dispatchCard, files, followupRow, host, isLocal, isObj, itemsCard, label, listCard, machine, machineCard, machines, manage,
  manageCard, messages, note, noteCard, noteRow, objects, pageCard, promptCard, prose, readCard, reportCard, rest, routeCard, routeRow, rowOnly,
  scheduleRow, sendRow, serverCard, shortId, shotCard, size, snapshotCard, subWorkersCard, subWorkersRow, summaryLead, task, taskCard, trackCard,
  worker, workerCount,
  reportRow, type Out, type Row, type Spec,
} from './tool-trace-pandacode-parts.ts';

/** Row and card bodies too long for one catalog line. */
type Verbs = [string, string];
const BROWSER_ACTIONS: Record<string, Verbs> = {
  back: ['Going back', 'Went back'], forward: ['Going forward', 'Went forward'],
  reload: ['Reloading page', 'Reloaded page'], stop: ['Stopping page', 'Stopped page'],
};
function sentCard(f: Fields, o: Out): string {
  const meta = o.obj.duplicate === true ? 'already sent' : o.obj.saved === true ? 'delivered' : '';
  return bubble('you', field(f, 'recipient'), field(f, 'message'), meta) + messages({ ...o, obj: isObj(o.obj.mailbox) ? o.obj.mailbox : {} });
}
function checkpointCard(f: Fields): string {
  const blocker = field(f, 'blocker');
  const blocked = blocker ? `<p class="tool-trace-note is-error">${escape(clip(blocker, 300))}</p>` : '';
  return label('Progress', beyond(field(f, 'summary'), 80, 400)) + label('Next', prose(field(f, 'nextSteps'), 300)) + blocked;
}
function listTasksRow(f: Fields, o: Out): Row {
  const tasks = objects(o.obj.tasks).length;
  return { object: [f.archived === true ? 'archived' : '', tasks ? `· ${count(tasks, 'task')}` : ''].filter(Boolean).join(' ') };
}
function port(url: string): string {
  try { return new URL(url).port || '80'; } catch { return ''; }
}
/** `Read open design comments · 2 comments`: the status filter reads before the noun. */
function designCommentsRow(f: Fields, o: Out): Row {
  const status = field(f, 'status').toLowerCase();
  const verbs: Verbs | undefined = status ? [`Reading ${status} design comments`, `Read ${status} design comments`] : undefined;
  return { verbs, object: Array.isArray(o.obj.comments) ? `· ${count(o.obj.comments.length, 'comment')}` : '' };
}
function openBrowserRow(f: Fields): Row {
  const url = field(f, 'url');
  if (!isLocal(url)) return { chip: chip(host(url), 'globe', url) };
  return { verbs: ['Opening preview', 'Opened preview'], chip: chip(`:${port(url)}`, 'globe', url) };
}
function codeSearchRow(f: Fields): Row {
  const symbols = f.symbols === true;
  const query = field(f, 'query');
  const verbs: Verbs | undefined = symbols ? ['Finding symbol', 'Found symbol'] : undefined;
  return { verbs, object: query ? (symbols ? clip(query, ROW_TEXT) : `for “${clip(query, ROW_TEXT)}”`) : '', mono: symbols };
}
function trackRow(f: Fields): Row {
  const n = Array.isArray(f.paths) ? f.paths.length : 0;
  const verbs: Verbs | undefined = field(f, 'action') === 'complete' ? undefined : ['Tracking changes to', 'Tracked changes to'];
  return { verbs, object: count(n, 'file') };
}
function recallRow(_: Fields, o: Out): Row {
  const n = Array.isArray(o.json) ? o.json.length : objects(o.obj.memories).length;
  return { object: n || Array.isArray(o.json) ? `· ${count(n, 'memory', 'memories')}` : '' };
}
function botScheduleCard(f: Fields): string {
  const prompt = field(f, 'title') ? label('Prompt', prose(field(f, 'prompt'), 400)) : beyond(field(f, 'prompt'), 60, 400);
  return prompt + kvTable(rest(f, ['title', 'prompt', 'kind', 'timeOfDay']), 'Timing');
}

/** Every PandaCode tool's family, icon, [running, finished] verbs, row parts and card. */
export const CATALOG: Record<string, Spec> = {
  schedule_wakeup: { family: 'task', icon: 'clock', verbs: ['Scheduling', 'Scheduled'], row: scheduleRow('a wake-up'), card: promptCard('note') },
  schedule_message: { family: 'task', icon: 'clock', verbs: ['Scheduling', 'Scheduled'], row: scheduleRow('a message'), card: promptCard('text') },
  cancel_schedule: { family: 'task', icon: 'clock', verbs: ['Cancelling', 'Cancelled'], row: () => ({ object: 'a schedule' }), card: rowOnly },
  list_schedules: { family: 'task', icon: 'clock', verbs: ['Checking', 'Checked'], row: () => ({ object: 'schedules' }), card: rowOnly },
  dispatch_workers: {
    family: 'team', icon: 'bot', verbs: ['Dispatching', 'Dispatched'],
    row: f => ({ object: assignments(f).length ? count(assignments(f).length, 'worker') : 'workers' }),
    card: dispatchCard,
  },
  list_workers: { family: 'team', icon: 'bot', verbs: ['Checking', 'Checked'], row: (_, o) => ({ object: workerCount(o) }), card: listCard },
  read_worker: { family: 'team', icon: 'bot', verbs: ['Reading', 'Read'], row: (f, o) => reportRow(f, o), card: readCard },
  sub_workers: { family: 'team', icon: 'bot', verbs: ['Checking sub-workers', 'Checked sub-workers'], row: subWorkersRow, card: subWorkersCard },
  route_models: { family: 'team', icon: 'activity', verbs: ['Previewing model routing', 'Previewed model routing'], row: routeRow, card: routeCard },
  progress_snapshot: {
    family: 'design', icon: 'camera', verbs: ['Posting progress snapshot', 'Posted progress snapshot'],
    row: (f, o) => ({ object: clip(field(f, 'title') || (isObj(o.obj.saved) ? field(o.obj.saved, 'title') : ''), ROW_TEXT) }),
    card: snapshotCard,
  },
  followup_worker: {
    family: 'team', icon: 'bot', verbs: ['Following up with', 'Followed up with'],
    row: followupRow,
    card: f => beyond(field(f, 'prompt'), 80) + files(f.files) + (f.readOnly === true ? '<p class="tool-trace-note">Read-only</p>' : ''),
  },
  cancel_worker: {
    family: 'team', icon: 'stop', verbs: ['Cancelling', 'Cancelled'],
    row: (f, o) => ({ chip: worker(f, o), note: clip(field(f, 'reason'), ROW_TEXT) }),
    card: f => beyond(field(f, 'reason'), 80),
  },
  finish_team: {
    family: 'team', icon: 'check', verbs: ['Finishing team', 'Finished team'],
    row: f => ({ note: summaryLead(field(f, 'summary')) }),
    card: f => label('Summary', prose(field(f, 'summary'), 1200)),
  },
  team_notes: { family: 'team', icon: 'pin', verbs: ['Reading team notes', 'Read team notes'], row: noteRow, card: noteCard },
  team_directory: { family: 'team', icon: 'grid', verbs: ['Reading team directory', 'Read team directory'], row: directoryRow, card: directoryCard },
  send_team_message: {
    family: 'team', icon: 'chat', verbs: ['Messaging', 'Messaged'],
    row: sendRow,
    card: sentCard,
  },
  read_team_mailbox: {
    family: 'team', icon: 'chat', verbs: ['Checking mailbox', 'Checked mailbox'],
    row: (_, o) => ({ object: Array.isArray(o.obj.messages) ? `· ${count(o.obj.messages.length, 'message')}` : '' }),
    card: (_, o) => messages(o),
  },
  checkpoint_worker: {
    family: 'team', icon: 'pin', verbs: ['Saving checkpoint', 'Saved checkpoint'],
    row: f => ({ note: clip(field(f, 'summary'), ROW_TEXT) }),
    card: checkpointCard,
  },
  delegate: {
    family: 'team', icon: 'bot', verbs: ['Delegating', 'Delegated'],
    row: f => ({ note: clip(field(f, 'prompt', 'title'), ROW_TEXT) }),
    card: (f, o) => label('Assignment', beyond(field(f, 'prompt', 'title'), 90, 400)) + label('Result', resultCard(o.text)),
  },

  create_task: {
    family: 'task', icon: 'plus', verbs: ['Creating task', 'Created task'],
    row: f => ({ object: field(f, 'title') ? `“${clip(field(f, 'title'), ROW_TEXT)}”` : '' }),
    card: taskCard,
  },
  start_task: { family: 'task', icon: 'play', verbs: ['Starting task', 'Started task'], row: (f, o) => ({ chip: task(f, o) }), card: taskCard },
  open_task: { family: 'task', icon: 'board', verbs: ['Opening task', 'Opened task'], row: (f, o) => ({ chip: task(f, o) }), card: rowOnly },
  list_tasks: {
    family: 'task', icon: 'board', verbs: ['Listing tasks', 'Listed tasks'],
    row: listTasksRow,
    card: taskCard,
  },
  read_task: { family: 'task', icon: 'board', verbs: ['Reading task', 'Read task'], row: (f, o) => ({ chip: task(f, o) ?? chip('this task', 'board') }), card: taskCard },
  search_tasks: {
    family: 'task', icon: 'search', verbs: ['Searching tasks', 'Searched tasks'],
    row: f => ({ object: field(f, 'query') ? `for “${clip(field(f, 'query'), ROW_TEXT)}”` : '' }),
    card: (f, o) => taskCard(f, o) || note('No tasks matched.'),
  },
  rename_task: {
    family: 'task', icon: 'edit', verbs: ['Renaming task', 'Renamed task'],
    row: f => ({ chip: chip(shortId(field(f, 'taskId')), 'board', field(f, 'taskId')), object: `to “${clip(field(f, 'title'), ROW_TEXT)}”` }),
    card: taskCard,
  },
  pin_task: {
    family: 'task', icon: 'pin', verbs: ['Pinning', 'Pinned'],
    row: (f, o) => ({ chip: task(f, o), verbs: f.pinned === false ? ['Unpinning', 'Unpinned'] : undefined }),
    card: rowOnly,
  },
  archive_task: {
    family: 'task', icon: 'archive', verbs: ['Archiving', 'Archived'],
    row: (f, o) => ({ chip: task(f, o), verbs: f.archived === false ? ['Restoring', 'Restored'] : undefined }),
    card: rowOnly,
  },
  set_task_stage: {
    family: 'task', icon: 'move', verbs: ['Moving', 'Moved'],
    row: (f, o) => ({ chip: task(f, o), object: field(f, 'stage') ? `to ${field(f, 'stage')}` : '' }),
    card: rowOnly,
  },
  steer_task: { family: 'task', icon: 'arrow-right', verbs: ['Steering', 'Steered'], row: (f, o) => ({ chip: task(f, o) }), card: promptCard('text') },
  interrupt_task: { family: 'task', icon: 'stop', verbs: ['Interrupting', 'Interrupted'], row: (f, o) => ({ chip: task(f, o) }), card: rowOnly },
  send_message: { family: 'task', icon: 'chat', verbs: ['Messaging', 'Messaged'], row: (f, o) => ({ chip: task(f, o) }), card: promptCard('text') },
  queue_message: {
    family: 'task', icon: 'plan', verbs: ['Queuing message for', 'Queued message for'],
    row: (f, o) => ({ chip: task(f, o) ?? chip('this task', 'board') }),
    card: promptCard('text'),
  },
  list_queue: {
    family: 'task', icon: 'plan', verbs: ['Reading queue', 'Read queue'],
    row: (_, o) => ({ object: Array.isArray(o.json) ? `· ${count(o.json.length, 'message')}` : '' }),
    card: (f, o) => itemsCard('messages', ['text'], ['position'])(f, o) || note('The queue is empty.'),
  },
  remove_queued: {
    family: 'task', icon: 'trash', verbs: ['Removing queued message', 'Removed queued message'],
    row: f => ({ chip: chip(shortId(field(f, 'entryId')), 'plan', field(f, 'entryId')) }),
    card: rowOnly,
  },
  list_subagents: { family: 'task', icon: 'bot', verbs: ['Listing subagents', 'Listed subagents'], card: itemsCard('subagents', ['name'], ['prompt']) },
  create_worktree: { family: 'task', icon: 'worktree', verbs: ['Creating worktree', 'Created worktree'], row: f => ({ chip: chip(field(f, 'branch'), 'branch') }), card: taskCard },
  list_projects: { family: 'task', icon: 'folder', verbs: ['Listing projects', 'Listed projects'], card: itemsCard('projects', ['name'], ['path']) },

  vm_list: {
    family: 'vm', icon: 'monitor', verbs: ['Listing machines', 'Listed machines'],
    row: (_, o) => ({ object: o.json ? `· ${count(machines(o).length, 'machine')}` : '' }),
    card: machineCard,
  },
  vm_screenshot: {
    family: 'vm', icon: 'camera', verbs: ['Taking a screenshot of', 'Took a screenshot of'],
    row: f => ({ chip: chip(machine(f) || 'VM', 'monitor') }),
    card: shotCard,
  },
  vm_control: { family: 'vm', icon: 'monitor', verbs: ['Controlling', 'Controlled'], row: f => ({ ...action(f), chip: chip(machine(f) || 'VM', 'monitor') }), card: actionCard },
  vm_manage: { family: 'vm', icon: 'monitor', verbs: ['Managing', 'Managed'], row: manage('VM', machine, 'monitor'), card: manageCard },

  simulator_devices: {
    family: 'simulator', icon: 'phone', verbs: ['Listing simulators', 'Listed simulators'],
    row: (_, o) => ({ object: objects(o.obj.devices).length ? `· ${count(objects(o.obj.devices).length, 'device')}` : '' }),
    card: deviceCard,
  },
  simulator_screenshot: {
    family: 'simulator', icon: 'camera', verbs: ['Taking a screenshot of', 'Took a screenshot of'],
    row: (f, o) => ({ chip: chip(simDevice(f, o) || 'Simulator', 'phone', field(f, 'udid')) }),
    card: shotCard,
  },
  simulator_describe: {
    family: 'simulator', icon: 'phone', verbs: ['Reading screen of', 'Read screen of'],
    row: (f, o) => ({ chip: chip(simDevice(f, o) || 'Simulator', 'phone', field(f, 'udid')) }),
    card: (_, o) => excerptCard(o.text),
  },
  simulator_control: {
    family: 'simulator', icon: 'phone', verbs: ['Controlling', 'Controlled'],
    row: (f, o) => ({ ...action(f), chip: chip(simDevice(f, o) || 'Simulator', 'phone', field(f, 'udid')) }),
    card: actionCard,
  },
  simulator_manage: { family: 'simulator', icon: 'phone', verbs: ['Managing', 'Managed'], row: manage('Simulator', device, 'phone'), card: manageCard },

  design_list: {
    family: 'design', icon: 'sketch', verbs: ['Listing artboards', 'Listed artboards'],
    row: (_, o) => ({ object: Array.isArray(o.obj.artboards) ? `· ${count(o.obj.artboards.length, 'artboard')}` : '' }),
    card: artboardCard,
  },
  design_write: {
    family: 'design', icon: 'sketch', verbs: ['Writing artboard', 'Wrote artboard'],
    row: f => ({ chip: chip(artboard(field(f, 'name')), 'sketch', field(f, 'name')), object: field(f, 'html') ? `· ${count(lines(field(f, 'html')).length, 'line')}` : '' }),
    card: (f, o) => note([field(o.obj, 'saved'), size(field(f, 'html').length)].filter(Boolean).join(' · ')) || COMPLETE,
  },
  design_comments: {
    family: 'design', icon: 'chat', verbs: ['Reading design comments', 'Read design comments'],
    row: designCommentsRow,
    card: commentCard,
  },
  design_resolve: {
    family: 'design', icon: 'check', verbs: ['Resolving comment', 'Resolved comment'],
    row: f => ({ chip: chip(shortId(field(f, 'id')), 'chat', field(f, 'id')) }),
    card: f => prose(field(f, 'note'), 300),
  },

  preview_file: {
    family: 'browser', icon: 'globe', verbs: ['Opening preview', 'Opened preview'],
    row: f => ({ chip: chip(basename(field(f, 'path')), 'file', field(f, 'path')) }),
    card: rowOnly,
  },
  run_project: {
    family: 'browser', icon: 'play', verbs: ['Running project', 'Ran project'],
    row: (_, o) => ({ object: field(o.obj, 'url', 'preview') ? `· ${host(field(o.obj, 'url', 'preview'))}` : '' }),
    card: (_, o) => resultCard(o.text),
  },
  open_browser: {
    family: 'browser', icon: 'globe', verbs: ['Opening', 'Opened'],
    row: openBrowserRow,
    card: pageCard,
  },
  read_browser: {
    family: 'browser', icon: 'globe', verbs: ['Reading page', 'Read page'],
    row: (_, o) => ({ chip: field(o.obj, 'url') ? chip(host(field(o.obj, 'url')), 'globe', field(o.obj, 'url')) : undefined }),
    card: pageCard,
  },
  browser_action: {
    family: 'browser', icon: 'refresh', verbs: ['Navigating', 'Navigated'],
    row: f => ({ verbs: BROWSER_ACTIONS[field(f, 'action')] }),
    card: rowOnly,
  },
  browser_click: { family: 'browser', icon: 'select', verbs: ['Clicking', 'Clicked'], row: f => ({ object: clip(field(f, 'selector'), ROW_TEXT), mono: true }), card: pageCard },
  browser_type: {
    family: 'browser', icon: 'text', verbs: ['Typing into', 'Typed into'],
    row: f => ({ object: clip(field(f, 'selector'), ROW_TEXT), mono: true }),
    card: f => label('Text', prose(field(f, 'text'), 400)),
  },
  capture_browser: { family: 'browser', icon: 'camera', verbs: ['Capturing browser', 'Captured browser'], card: (_, o) => note(o.text) },
  open_file: {
    family: 'browser', icon: 'file', verbs: ['Opening', 'Opened'],
    row: f => ({ chip: chip(basename(field(f, 'path')), 'file', field(f, 'path')), object: field(f, 'view') === 'raw' ? 'source' : '' }),
    card: rowOnly,
  },
  open_terminal: { family: 'browser', icon: 'terminal', verbs: ['Opening terminal', 'Opened terminal'] , card: rowOnly },
  list_local_servers: {
    family: 'browser', icon: 'server', verbs: ['Listing local servers', 'Listed local servers'],
    row: (_, o) => ({ object: Array.isArray(o.json) ? `· ${count(o.json.length, 'server')}` : '' }),
    card: serverCard,
  },

  cloud_cli: {
    family: 'cloud', icon: 'upload', verbs: ['Running', 'Ran'],
    row: f => ({ chip: chip(field(f, 'tool'), 'terminal'), object: clip(field(f, 'args'), ROW_TEXT), mono: true }),
    card: cloudCard,
  },
  code_search: {
    family: 'code', icon: 'search', verbs: ['Searching code', 'Searched code'],
    row: codeSearchRow,
    card: codeCard,
  },
  track_files: {
    family: 'code', icon: 'edit', verbs: ['Tracking', 'Tracked'],
    row: trackRow,
    card: trackCard,
  },
  title: {
    family: 'meta', icon: 'text', verbs: ['Naming', 'Named'],
    row: f => ({ object: field(f, 'title') ? `the task “${clip(field(f, 'title'), ROW_TEXT)}”` : 'the task' }),
    card: rowOnly,
  },
  coordination: { family: 'team', icon: 'chat', verbs: ['Coordinating', 'Coordinated'] },
  test: { family: 'meta', icon: 'check', verbs: ['Testing tools', 'Tested tools'] },

  list_moodboards: {
    family: 'moodboard', icon: 'images', verbs: ['Listing moodboards', 'Listed moodboards'],
    card: itemsCard('boards', ['name', 'title'], ['imageCount', 'count']),
  },
  read_moodboard: {
    family: 'moodboard', icon: 'images', verbs: ['Reading moodboard', 'Read moodboard'],
    row: (f, o) => ({ chip: chip(field(o.obj, 'name') || shortId(field(f, 'boardId')), 'images', field(f, 'boardId')) }),
    card: itemsCard('images', ['name', 'caption'], ['caption']),
  },
  read_moodboard_image: {
    family: 'moodboard', icon: 'images', verbs: ['Viewing reference', 'Viewed reference'],
    row: f => ({ chip: chip(shortId(field(f, 'imageId')), 'images', field(f, 'imageId')) }),
    card: shotCard,
  },

  bot_remember: {
    family: 'bot', icon: 'spark', verbs: ['Remembering', 'Remembered'],
    row: f => ({ note: clip(field(f, 'content'), ROW_TEXT) }),
    card: f => beyond(field(f, 'content'), 80, 400),
  },
  bot_forget: {
    family: 'bot', icon: 'trash', verbs: ['Forgetting memory', 'Forgot memory'],
    row: f => ({ chip: chip(shortId(field(f, 'memoryId')), 'spark', field(f, 'memoryId')) }),
    card: rowOnly,
  },
  bot_recall: {
    family: 'bot', icon: 'spark', verbs: ['Recalling memories', 'Recalled memories'],
    row: recallRow,
    card: itemsCard('memories', ['content'], []),
  },
  bot_schedule: {
    family: 'bot', icon: 'activity', verbs: ['Scheduling', 'Scheduled'],
    row: f => ({ object: clip(field(f, 'title', 'prompt'), ROW_TEXT) + (field(f, 'kind') ? ` · ${field(f, 'kind')}${field(f, 'timeOfDay') ? ` ${field(f, 'timeOfDay')}` : ''}` : '') }),
    card: botScheduleCard,
  },
  bot_list_schedules: {
    family: 'bot', icon: 'activity', verbs: ['Listing schedules', 'Listed schedules'],
    card: itemsCard('schedules', ['title', 'prompt'], ['kind', 'timeOfDay', 'intervalMinutes']),
  },
  bot_cancel_schedule: {
    family: 'bot', icon: 'stop', verbs: ['Cancelling schedule', 'Cancelled schedule'],
    row: f => ({ chip: chip(shortId(field(f, 'scheduleId')), 'activity', field(f, 'scheduleId')) }),
    card: rowOnly,
  },
  bot_notify: {
    family: 'bot', icon: 'chat', verbs: ['Messaging the user', 'Messaged the user'],
    row: f => ({ note: clip(field(f, 'text'), ROW_TEXT) }),
    card: f => field(f, 'text').length > 80 ? bubble('bot', 'you', field(f, 'text')) : '',
  },
  bot_anything_else: { family: 'bot', icon: 'chat', verbs: ['Checking in', 'Checked in'] },

  jev_test: {
    family: 'jev', icon: 'activity', verbs: ['Starting browser test', 'Started browser test'],
    row: f => ({ chip: field(f, 'url') ? chip(host(field(f, 'url')), 'globe', field(f, 'url')) : undefined, note: clip(field(f, 'goal'), ROW_TEXT) }),
    card: (f, o) => beyond(field(f, 'goal'), 80, 400) + kvTable(rest(f, ['url', 'goal', 'taskId']), 'Checks') + (o.text.trim() ? reportCard(f, o) : ''),
  },
  jev_read: {
    family: 'jev', icon: 'activity', verbs: ['Reading test report', 'Read test report'],
    row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }),
    card: reportCard,
  },
  jev_wait: {
    family: 'jev', icon: 'activity', verbs: ['Waiting for test', 'Waited for test'],
    row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }),
    card: reportCard,
  },
  jev_list: { family: 'jev', icon: 'activity', verbs: ['Listing test reports', 'Listed test reports'], card: itemsCard('reports', ['goal', 'url'], ['url']) },
  jev_screenshot: {
    family: 'jev', icon: 'camera', verbs: ['Viewing test screenshot', 'Viewed test screenshot'],
    row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }),
    card: shotCard,
  },
  jev_cancel: {
    family: 'jev', icon: 'stop', verbs: ['Stopping browser test', 'Stopped browser test'],
    row: f => ({ chip: chip(shortId(field(f, 'runId')), 'activity', field(f, 'runId')) }),
    card: rowOnly,
  },
  jev_review: { family: 'jev', icon: 'check', verbs: ['Reviewing work with Jev', 'Reviewed work with Jev'], card: reportCard },
  jev_check_rules: { family: 'jev', icon: 'check', verbs: ['Checking rules', 'Checked rules'], card: reportCard },
  jev_find_context: { family: 'jev', icon: 'search', verbs: ['Finding context', 'Found context'], row: f => ({ note: clip(field(f, 'query', 'question'), ROW_TEXT) }), card: reportCard },
  jev_choose_worker: { family: 'jev', icon: 'bot', verbs: ['Choosing a worker', 'Chose a worker'], card: reportCard },
  jev_assessments: { family: 'jev', icon: 'activity', verbs: ['Reading assessments', 'Read assessments'], card: reportCard },
};
