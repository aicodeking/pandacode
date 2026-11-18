// The task screen's native header: the title, a system back button (the sidebar toggle and New task in
// the Duo's split view) and one bar button item so the title keeps its room: a More menu (Changes, Pull
// request and Agents when the task has them, Deploy (a project task: a new task in its project with the
// desktop's deploy brief, as the desktop's header Deploy menu starts), Pause/Resume for a bot, Model & permissions, Task info, Board, a
// Tools submenu (Checks, Progress, Files, Search, By the way, Queue), Rename, Fork, Export, Terminal and a
// bot's settings where the computer serves them; an item this phone's access or the Full access switch
// keeps off stays, disabled with the access note on iOS and explaining itself when tapped elsewhere, as in
// the computer hub (menu-gate.ts)) in sections: Bot, Task, Tools, Work, then Manage
// (Archive and Delete, by `offersSettle`) last. Stop lives in the composer. A bot's conversation shows the bot's avatar and name. They are
// real UIBarButtonItems, so on the iPhone Duo iOS moves them into the side rail with the status bar;
// Android draws the same buttons in its app bar.
// With Liquid Glass the header is transparent and the transcript scrolls under it, over the app's ScrollEdge.
// iOS's own scroll edge effect is hidden by the transcript itself (see NO_EDGE_EFFECTS in transcript.tsx).
// `headerStyle: transparent` on a solid header does not work: a non-translucent
// UINavigationBar always paints an opaque background.
import { Directory, File, Paths } from 'expo-file-system';
import { router, Stack, useNavigation, useNavigationContainerRef } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { Alert, Platform, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { deployTargets } from '../connect/api/admin.ts';
import { useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { archiveThread, deleteThread, exportThread, forkThread, unarchiveThread } from '../connect/api/threads.ts';
import { connect } from '../connect/client.ts';
import { uuid } from '../connect/crypto.ts';
import type { Bot } from '../connect/types.ts';
import { BotAvatar } from './BotRow.tsx';
import { offersSettle, offersUnarchive, reopenTask, settleTask } from '../store/inbox.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { unarchive } from '../store/local.ts';
import { ANDROID_SHARE_CAP, capExport, exportFileName, isTruncatedExport } from '../store/thread-model.ts';
import { haptic, hideToast, PressScale, ScrollEdge, showToast, type as textStyle } from './ds/index.ts';
import { hasGlass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { showActions, type MenuItem } from './Menu.tsx';
import { BLOCKED_TITLE, gatedPress, menuGate, type MenuGate } from './menu-gate.ts';
import { deployChoices, deployConfirm, deployTaskParams, type DeployChoice, type DeployTargetState } from './new-task-projects.ts';
import { openFromSidebar } from './sidebar-open.ts';
import { rootStack, sidebarOpen, sidebarSelection, type StackState } from './sidebar-nav.ts';
import { toggleSidebar, useSidebar, useSplit } from './split.tsx';
import { useColors } from './theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;

function Button({ icon, label, onPress, color }: { icon: IconName; label: string; onPress: () => void; color?: string }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityLabel={label} hitSlop={4} style={styles.icon}>
      <Icon {...icon} size={20} color={color ?? colors.text} />
    </PressScale>
  );
}

/** In the split view New task is the Inbox tab's New thread pane. */
export function openNewThread() {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/inbox');
}

/** Behind the transparent Liquid Glass header: the app's scroll edge. `height` = header height. */
export function HeaderBlur({ height }: { height: number }) {
  return <ScrollEdge bar={height} />;
}

/** How far past the composer's lower edge the dock's fade runs. */
const DOCK_RAMP = 32;

/** Under the composer: rows scrolling past it fade before the home indicator. `height` includes what's behind the composer's lower edge. */
export function DockFade({ height }: { height: number }) {
  return <ScrollEdge edge="bottom" bar={height - DOCK_RAMP} />;
}

/** Pause/Resume shows at once (the client rolls it back if the host refuses). */
export function pauseBot(deviceId: string, bot: Bot) {
  haptic('selection');
  connect.pauseBot(deviceId, bot.id, !bot.paused).catch(error => Alert.alert(bot.paused ? 'Could not resume' : 'Could not pause', (error as Error).message));
}

const failed = (title: string) => (error: unknown) => { haptic('error'); Alert.alert(title, (error as Error).message); };

export const openRename = (deviceId: string, sessionId: string) => router.push({ pathname: '/rename', params: { device: deviceId, session: sessionId } });

const ARCHIVE_ICON = { ios: 'archivebox', android: 'archive' } as const;

/** Archive settles the thread on the computer; once it confirms, the thread moves to Archived, `after`
 * runs (leave the open thread) and a toast offers Undo, which also runs `reopen` once the thread is back
 * (Archive started on the task screen returns to it). A refusal puts it back and says why. */
export function archiveAction(deviceId: string, sessionId: string, after?: () => void, reopen?: () => void) {
  haptic('selection');
  const task = useConnect.getState().tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
  archiveThread(deviceId, sessionId).then(() => {
    // The computer now lists it settled, so it shows under Archived rather than hidden on this phone.
    unarchive(taskKey(deviceId, sessionId));
    if (task) useConnect.setState(s => ({ tasks: settleTask(s.tasks, deviceId, task) as typeof s.tasks }));
    haptic('success');
    after?.();
    showToast({ title: 'Archived', body: task?.title || undefined, icon: ARCHIVE_ICON, action: { label: 'Undo', onPress: () => unarchiveAction(deviceId, sessionId, task?.stage, reopen) } });
  }, failed('Could not archive'));
}

/** Reopens an archived thread for review (the desktop's Reopen), back in the inbox. Archive's Undo
 * passes `previous`, the stage before Archive, so the thread goes back to it (unarchiveThread). */
export function unarchiveAction(deviceId: string, sessionId: string, previous?: string, after?: () => void) {
  haptic('selection');
  unarchiveThread(deviceId, sessionId, previous).then(stage => {
    useConnect.setState(s => ({ tasks: reopenTask(s.tasks, deviceId, sessionId, stage) as typeof s.tasks }));
    haptic('success');
    after?.();
  }, failed('Could not unarchive'));
}

/** Delete asks first: it removes the thread and its history from the computer too. */
export function deleteAction(deviceId: string, sessionId: string, title: string, after?: () => void) {
  haptic('warning');
  Alert.alert('Delete this task?', `“${title || 'Untitled task'}” and its history are removed from the computer too. This can’t be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => deleteThread(deviceId, sessionId).then(() => { haptic('success'); after?.(); }, failed('Could not delete')) },
  ]);
}

/** A new thread with this one's conversation up to `messageId`, opened in its place. */
export function forkAction(deviceId: string, sessionId: string, messageId: number, before = false) {
  haptic('selection');
  forkThread(deviceId, sessionId, messageId, before).then(fork => {
    haptic('success');
    // Replace, not push: the fork takes this task's place, so the stack doesn't grow (and on the Duo
    // sidebar picks keep replacing the task).
    router.replace({ pathname: '/task/[device]/[session]', params: { device: deviceId, session: fork } });
  }, failed('Could not fork'));
}

const EXPORT_ICON = { ios: 'square.and.arrow.up', android: 'share' } as const;

/** iOS shares a Markdown file from the cache (no size limit). Android's share sheet takes only text,
 * through a ~1 MB binder transaction, so the text is capped at ANDROID_SHARE_CAP. Resolves whether
 * what was shared is cut short. */
async function shareExport(title: string, markdown: string): Promise<boolean> {
  const name = title || 'Task';
  if (Platform.OS === 'ios') {
    const dir = new Directory(Paths.cache, 'exports');
    if (!dir.exists) dir.create({ intermediates: true });
    // The async write (it creates or replaces the file) keeps a long transcript off the JS thread.
    const file = new File(dir, exportFileName(name));
    await file.write(markdown);
    try {
      await Share.share({ title: name, url: file.uri });
    } finally {
      // The share sheet has copied or sent it by now; best-effort, so a failed delete never fails the export.
      try { file.delete(); } catch { /* left for sign-out's cache clear */ }
    }
    return isTruncatedExport(markdown);
  }
  const { text, truncated } = capExport(markdown, ANDROID_SHARE_CAP);
  await Share.share({ title: name, message: text });
  return truncated;
}

/** The transcript as Markdown through the share sheet, with a toast while its pages load (sticky: it
 * stays however long they take, and hiding it leaves any newer toast alone) and when what was shared is
 * cut short; any failure (paging, file, share sheet) says so. */
export function exportAction(deviceId: string, sessionId: string, title: string) {
  const preparing = showToast({ title: 'Preparing export…', icon: EXPORT_ICON, sticky: true });
  const hidePreparing = () => { if (preparing !== undefined) hideToast(preparing); };
  exportThread(deviceId, sessionId)
    .then(markdown => { hidePreparing(); return shareExport(title, markdown); })
    .then(truncated => {
      if (truncated) showToast({ title: 'Export truncated', body: 'This thread was too long to share in full; the end was cut.', tone: 'warning', icon: EXPORT_ICON });
    })
    .catch(error => { hidePreparing(); failed('Could not export')(error); });
}

/** Deploy: asks first, then a new task in this task's project, with its harness, model and mode, sent the
 * desktop's deploy brief for `choice`, then opened. The agent deploys with the computer's signed-in cloud CLI. */
export function deployAction(deviceId: string, sessionId: string, choice: DeployChoice) {
  const s = useConnect.getState();
  const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
  const params = deployTaskParams(task, choice.id);
  if (!params) { Alert.alert('Could not deploy', 'Open a project task to deploy it.'); return; }
  haptic('selection');
  const { title, message } = deployConfirm(choice, task?.projectName ?? '', s.devices.find(d => d.id === deviceId)?.name ?? '');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Deploy', onPress: () => connect.startTask(deviceId, { ...params, startId: uuid() }).then(({ sessionId: session }) => {
      haptic('success');
      void connect.listTasks(deviceId).catch(() => undefined);
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
    }, failed('Could not deploy')) },
  ]);
}

/** The Deploy menu's rows: with deploy.targets (newer hosts), targets whose CLI the computer hasn't
 * connected carry its note and are disabled; an older host offers every target, as before. */
function useDeployChoices(deviceId: string, shown: boolean): DeployChoice[] {
  const supported = useHostSupports(deviceId, 'deploy.targets');
  const [states, setStates] = useState<{ device: string; targets: DeployTargetState[] } | null>(null);
  useEffect(() => {
    if (!shown || !supported) return;
    let live = true;
    // A failed check leaves every target offered: the deploy task itself then says what's missing.
    deployTargets(deviceId).then(targets => { if (live) setStates({ device: deviceId, targets }); }, () => undefined);
    return () => { live = false; };
  }, [deviceId, shown, supported]);
  return deployChoices(supported && states?.device === deviceId ? states.targets : null);
}

/** The bot's avatar beside its name, as the header title. */
function BotTitle({ bot }: { bot: Bot }) {
  const colors = useColors();
  return (
    <View style={styles.botTitle} accessible accessibilityRole="header" accessibilityLabel={`${bot.name}${bot.paused ? ', paused' : ''}`}>
      <BotAvatar bot={bot} size={24} />
      <Text style={[textStyle.headline, styles.botName, { color: colors.text }]} numberOfLines={1}>{bot.name}</Text>
    </View>
  );
}

interface Tool { label: string; ios: NonNullable<MenuItem['ios']>; android: NonNullable<MenuItem['android']>; onPress: () => void; gate: MenuGate }

/** A blocked item's tap: the access note in an alert. */
const explain = (note: string) => Alert.alert(BLOCKED_TITLE, note);

/** The gate of each host method's menu item on `deviceId` (menu-gate.ts). */
function useGate(deviceId: string): (method: string) => MenuGate {
  const caps = useHostCapabilities(deviceId);
  const computer = useConnect(s => s.devices.find(d => d.id === deviceId)?.name ?? 'that computer');
  return method => menuGate(caps, method, computer);
}

/** A native menu action's props for a gate: disabled, with the access note as its subtitle. */
const nativeGate = (gate: MenuGate) => ({ disabled: !!gate.note, ...(gate.note ? { subtitle: gate.note } : {}) });

/** The task's tools the computer serves, each with the device, session and the task's project its screen reads. */
function useTools(deviceId: string, sessionId: string): Tool[] {
  const projectId = useConnect(s => { const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId); return task?.chat ? undefined : task?.projectId; });
  const gate = useGate(deviceId);
  const withProject = { device: deviceId, session: sessionId, ...(projectId ? { project: projectId } : {}) };
  const thread = { device: deviceId, session: sessionId };
  const all: (Tool & { project?: true })[] = [
    { label: 'Checks', ios: 'checkmark.seal', android: 'fact_check', gate: gate('checks.plan'), onPress: () => router.push({ pathname: '/checks', params: withProject }) },
    { label: 'Progress', ios: 'photo.on.rectangle', android: 'photo_library', gate: gate('progress.list'), onPress: () => router.push({ pathname: '/progress', params: withProject }) },
    { label: 'Files', ios: 'folder', android: 'folder', gate: gate('files.list'), project: true, onPress: () => router.push({ pathname: '/files', params: withProject }) },
    { label: 'Search', ios: 'magnifyingglass', android: 'search', gate: gate('files.search'), project: true, onPress: () => router.push({ pathname: '/search', params: withProject }) },
    { label: 'By the way', ios: 'bubble.left.and.text.bubble.right', android: 'forum', gate: gate('btw.ask'), onPress: () => router.push({ pathname: '/btw', params: thread }) },
    { label: 'Queue', ios: 'list.number', android: 'queue', gate: gate('queue.list'), onPress: () => router.push({ pathname: '/queue', params: thread }) },
  ];
  return all.filter(t => t.gate.shown && (!t.project || !!projectId)).map(({ project: _project, ...tool }) => tool);
}

const STATUS: Record<string, string> = { running: 'Working', waiting: 'Needs you', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
/** One bar button item (back, More, the Find in thread search button) with its share of the gaps. */
const BAR_ITEM_WIDTH = 44;
/** The bar's margin at each edge. */
const BAR_EDGE = 16;
/** Items on the busier (right) side: Find in thread and More. */
const BAR_SIDE_ITEMS = 2;
/** The title is centred, so it keeps clear of the busier side on both sides. */
const BAR_ITEMS_WIDTH = 2 * (BAR_EDGE + BAR_SIDE_ITEMS * BAR_ITEM_WIDTH);
/** A bar title stays bar-sized at any Dynamic Type size, as the system's does. */
const TITLE_FONT_SCALE = 1.2;

/** The task, then its project and status: a title view, so never in the Duo's rail. */
function TaskTitle({ title, detail }: { title: string; detail: string }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.taskTitle, { maxWidth: width - BAR_ITEMS_WIDTH }]} accessible accessibilityRole="header" accessibilityLabel={detail ? `${title}, ${detail}` : title}>
      <Text numberOfLines={1} maxFontSizeMultiplier={TITLE_FONT_SCALE} style={[textStyle.headline, { color: colors.text }]}>{title}</Text>
      {!!detail && <Text numberOfLines={1} maxFontSizeMultiplier={TITLE_FONT_SCALE} style={[textStyle.caption, { color: colors.muted }]}>{detail}</Text>}
    </View>
  );
}

/** `quiet`: the screen already says the run's state (the pill, a request card), so the subtitle names only the project. */
export function TaskHeader({ deviceId, sessionId, title, pull, agents, bot, quiet }: { deviceId: string; sessionId: string; title: string; pull: boolean; agents: boolean; bot?: Bot; quiet?: boolean }) {
  const split = useSplit();
  const navigation = useNavigation();
  // The root state outlives this screen: Undo runs after Archive has left it.
  const container = useNavigationContainerRef();
  const collapsed = useSidebar(s => s.collapsed);
  const params = { device: deviceId, session: sessionId };
  const settings = () => router.push({ pathname: '/task-settings', params });
  const info = () => router.push({ pathname: '/task-info', params });
  const board = () => router.push({ pathname: '/board', params: { device: deviceId, ...(boardProject ? { project: boardProject } : {}) } });
  const openPull = () => router.push({ pathname: '/pull', params });
  const changes = () => router.push({ pathname: '/changes', params });
  const openAgents = () => router.push({ pathname: '/agents', params });
  const pause = () => bot && pauseBot(deviceId, bot);
  const gate = useGate(deviceId);
  const can = {
    pause: gate('bot.pause'), rename: gate('thread.rename'), fork: gate('thread.fork'), export: gate('thread.export'),
    archive: gate('thread.archive'), delete: gate('thread.delete'), terminal: gate('terminal.list'), botSettings: gate('bot.detail'),
    board: gate('thread.setStage'), deploy: gate('task.start'),
  };
  // The board lists project tasks; it opens on this task's project. Chats and bots have none.
  const boardProject = useConnect(s => { const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId); return task?.chat || task?.botId ? undefined : task?.projectId; });
  /** Android's menu item press: the action, or the access note when it's blocked. */
  const press = (g: MenuGate, run: () => void) => gatedPress(g, run, explain);
  const terminal = () => router.push({ pathname: '/terminal', params });
  const botSettings = () => bot && router.push({ pathname: '/bot-admin', params: { device: deviceId, bot: bot.id } });
  const lastId = useConnect(s => s.messages[taskKey(deviceId, sessionId)]?.at(-1)?.id);
  // The archive answers later: leave only if this task's screen is still the one shown, so a sheet or
  // screen opened over it meanwhile isn't closed instead. A covered task stays (an archived one stays
  // listed; a deleted one closes on its next focus, useLeaveWhenGone).
  const leave = () => {
    if (!navigation.isFocused()) return;
    if (navigation.canGoBack()) navigation.goBack();
    else router.replace('/inbox');
  };
  const rename = () => openRename(deviceId, sessionId);
  const fork = () => lastId !== undefined && forkAction(deviceId, sessionId, lastId);
  const share = () => exportAction(deviceId, sessionId, title);
  // Undo from the toast brings the task screen back, unless it is still (or again) the one shown: in the
  // Duo's split view as a sidebar pick would open it (so the stack never grows), elsewhere a push.
  const reopen = () => {
    const stack = rootStack(container.isReady() ? container.getRootState() as StackState | undefined : undefined);
    if (sidebarSelection(stack) === `${deviceId}/${sessionId}`) return;
    const href = { pathname: '/task/[device]/[session]' as const, params };
    if (split) openFromSidebar(href, sidebarOpen(stack));
    else router.push(href);
  };
  const archive = () => archiveAction(deviceId, sessionId, leave, reopen);
  // No `leave` here: deleteThread marks the task gone and drops it, so the task screen's
  // useLeaveWhenGone already goes back; a second back would pop the screen underneath.
  const remove = () => deleteAction(deviceId, sessionId, title);
  const status = useConnect(s => {
    const live = s.live[taskKey(deviceId, sessionId)]?.status;
    return live && live !== 'idle' ? live : s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.status;
  });
  const manage = !bot;
  const showBoard = manage && !!boardProject && can.board.shown;
  // Deploy ships a project: not a Chat or a bot's conversation (boardProject is set for neither).
  const showDeploy = manage && !!boardProject && can.deploy.shown;
  const deploy = (choice: DeployChoice) => deployAction(deviceId, sessionId, choice);
  const deployRows = useDeployChoices(deviceId, showDeploy);
  // Archive and Delete follow the inbox row's rule (offersSettle): not while the run works or waits on you.
  const settle = manage && offersSettle({ status });
  // A settled or archived task offers Unarchive in Archive's place, by the inbox row's rule (offersUnarchive).
  const settled = useConnect(s => offersUnarchive({ task: s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId), status }));
  const unarchiveTask = () => unarchiveAction(deviceId, sessionId);
  const tools = useTools(deviceId, sessionId);
  const detail = useConnect(s => {
    const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
    const live = s.live[taskKey(deviceId, sessionId)]?.status;
    const status = live && live !== 'idle' ? live : task?.status;
    return [task?.chat ? 'Chat' : task?.projectName, !quiet && status && STATUS[status]].filter(Boolean).join(' · ');
  });
  // A custom title view can't go in the Duo's rail, so the split view keeps the plain title.
  const headerTitle = split ? undefined : bot ? () => <BotTitle bot={bot} /> : () => <TaskTitle title={title} detail={detail} />;
  const options = { headerShown: true, headerTransparent: hasGlass, headerShadowVisible: false, title: bot?.name ?? title, headerTitle, headerBackButtonDisplayMode: 'minimal',
    // The Duo's sidebar toggle and New task are left items, and iOS hides the back button without this.
    headerBackVisible: true } as const;
  if (Platform.OS !== 'ios') {
    // Android's menu card lists the same sections in the same order (`section` titles them on iOS).
    const more: MenuItem[] = [
      ...(bot && can.pause.shown ? [{ label: bot.paused ? 'Resume bot' : 'Pause bot', section: 'Bot', android: bot.paused ? 'play_circle' : 'pause_circle', onPress: press(can.pause, pause) } as const] : []),
      ...(bot && can.botSettings.shown ? [{ label: 'Bot settings', section: 'Bot', android: 'smart_toy', onPress: press(can.botSettings, botSettings) } as const] : []),
      ...(manage && can.rename.shown ? [{ label: 'Rename', section: 'Task', android: 'edit', onPress: press(can.rename, rename) } as const] : []),
      ...(manage && can.fork.shown && lastId !== undefined ? [{ label: 'Fork', section: 'Task', android: 'fork_right', onPress: press(can.fork, fork) } as const] : []),
      ...(manage && can.export.shown ? [{ label: 'Export', section: 'Task', android: 'ios_share', onPress: press(can.export, share) } as const] : []),
      { label: 'Model & permissions', section: 'Task', android: 'tune', onPress: settings },
      { label: 'Task info', section: 'Task', android: 'info', onPress: info },
      ...(showBoard ? [{ label: 'Board', section: 'Task', android: 'view_kanban', ...(can.board.note ? { subtitle: can.board.note } : {}), onPress: press(can.board, board) } as const] : []),
      ...(tools.length ? [{ label: 'Tools', section: 'Tools', android: 'build', onPress: () => showActions('Tools', tools.map(t => ({ label: t.label, android: t.android, ...(t.gate.note ? { subtitle: t.gate.note } : {}), onPress: press(t.gate, t.onPress) }))) } as const] : []),
      { label: 'Changes', section: 'Work', android: 'difference', onPress: changes },
      ...(pull ? [{ label: 'Pull request', section: 'Work', android: 'merge', onPress: openPull } as const] : []),
      ...(agents ? [{ label: 'Agents', section: 'Work', android: 'groups', onPress: openAgents } as const] : []),
      ...(can.terminal.shown ? [{ label: 'Terminal', section: 'Work', android: 'terminal', onPress: press(can.terminal, terminal) } as const] : []),
      ...(showDeploy ? [{ label: 'Deploy', section: 'Work', android: 'upload', onPress: press(can.deploy, () => showActions('Deploy', deployRows.map(t => ({ label: t.label, subtitle: t.note ?? t.description, android: 'upload', onPress: () => (t.note ? explain(t.note) : deploy(t)) })))) } as const] : []),
      ...(settle && settled && can.archive.shown ? [{ label: 'Unarchive', section: 'Manage', android: 'unarchive', onPress: press(can.archive, unarchiveTask) } as const] : []),
      ...(settle && !settled && can.archive.shown ? [{ label: 'Archive', section: 'Manage', android: 'archive', onPress: press(can.archive, archive) } as const] : []),
      ...(settle && can.delete.shown ? [{ label: 'Delete', section: 'Manage', android: 'delete', destructive: true, onPress: press(can.delete, remove) } as const] : []),
    ];
    return <Stack.Screen options={{ ...options, headerRight: () => (
      <View style={styles.row}>
        <Button icon={{ ios: 'ellipsis.circle', android: 'more_vert' }} label="More" onPress={() => showActions(undefined, more)} />
      </View>
    ) }} />;
  }
  // Sections are inline submenus, which UIKit draws as titled groups with dividers between them;
  // Archive and Delete come last, apart from the rest.
  return (
    <>
      <Stack.Screen options={options} />
      {split && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'} onPress={toggleSidebar} />
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New task" onPress={openNewThread} />
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="More">
          <Stack.Toolbar.Menu inline title="Bot" hidden={!bot}>
            <Stack.Toolbar.MenuAction icon={bot?.paused ? 'play.circle' : 'pause.circle'} hidden={!can.pause.shown} {...nativeGate(can.pause)} onPress={pause}>{bot?.paused ? 'Resume bot' : 'Pause bot'}</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="gearshape" hidden={!can.botSettings.shown} {...nativeGate(can.botSettings)} onPress={botSettings}>Bot settings</Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline title="Task">
            <Stack.Toolbar.MenuAction icon="pencil" hidden={!manage || !can.rename.shown} {...nativeGate(can.rename)} onPress={rename}>Rename</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="arrow.branch" hidden={!manage || !can.fork.shown || lastId === undefined} {...nativeGate(can.fork)} onPress={fork}>Fork</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="square.and.arrow.up" hidden={!manage || !can.export.shown} {...nativeGate(can.export)} onPress={share}>Export</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="slider.horizontal.3" onPress={settings}>Model & permissions</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="info.circle" onPress={info}>Task info</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="square.stack.3d.up" hidden={!showBoard} {...nativeGate(can.board)} onPress={board}>Board</Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline hidden={!tools.length}>
            <Stack.Toolbar.Menu icon="wrench.and.screwdriver" title="Tools">
              {tools.map(t => <Stack.Toolbar.MenuAction key={t.label} icon={t.ios} {...nativeGate(t.gate)} onPress={t.onPress}>{t.label}</Stack.Toolbar.MenuAction>)}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline title="Work">
            <Stack.Toolbar.MenuAction icon="arrow.triangle.branch" onPress={changes}>Changes</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="arrow.triangle.pull" hidden={!pull} onPress={openPull}>Pull request</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="person.2" hidden={!agents} onPress={openAgents}>Agents</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="terminal" hidden={!can.terminal.shown} {...nativeGate(can.terminal)} onPress={terminal}>Terminal</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.Menu icon="arrow.up.circle" title="Deploy" hidden={!showDeploy}>
              {deployRows.map(t => <Stack.Toolbar.MenuAction key={t.id} icon="arrow.up.circle" {...(can.deploy.note ? nativeGate(can.deploy) : t.note ? { disabled: true, subtitle: t.note } : { subtitle: t.description })} onPress={() => deploy(t)}>{t.label}</Stack.Toolbar.MenuAction>)}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline title="Manage" hidden={!settle || (!can.archive.shown && !can.delete.shown)}>
            <Stack.Toolbar.MenuAction icon="tray.and.arrow.up" hidden={!settled || !can.archive.shown} {...nativeGate(can.archive)} onPress={unarchiveTask}>Unarchive</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="archivebox" hidden={settled || !can.archive.shown} {...nativeGate(can.archive)} onPress={archive}>Archive</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="trash" destructive hidden={!can.delete.shown} {...nativeGate(can.delete)} onPress={remove}>Delete</Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  taskTitle: { alignItems: 'center' },
  botTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 220 },
  botName: { flexShrink: 1 },
});
