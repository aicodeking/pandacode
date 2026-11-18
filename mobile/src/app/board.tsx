// The computer's task board (the desktop's Board view, docs/task-board.md), phone first: Pending,
// In progress, Review and Settled as segmented tabs, or as the desktop's four columns when the pane
// is wide enough (the Duo's split view, a tablet). Grouping is pure in store/board.ts. Tap a card to
// open the task; its menu moves it to another stage (thread.setStage, applied at once and put back
// if the computer refuses). Each card carries the desktop's stage action: Start (or Retry) sends the
// task's details as its prompt (task.send), Settle and Reopen set its stage. Pushed with ?device=
// (and optionally &project=).
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { setThreadStage, threadGoal } from '../connect/api/threads.ts';
import { connect } from '../connect/client.ts';
import type { TaskSummary } from '../connect/types.ts';
import { patchTask } from '../store/thread-model.ts';
import { BOARD_EMPTY, BOARD_LABELS, boardAction, boardLayout, boardProjects, firstStage, groupBoard, STAGES, stageMoves, startPrompt, type BoardAction, type Stage } from '../store/board.ts';
import { useConnect } from '../store/index.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { Choice } from '../ui/Choice.tsx';
import { Banner, Button, EmptyState, geometry, Group, haptic, PressScale, Segmented, Skeleton, StatusDot, type as textStyle, type IconName } from '../ui/ds/index.ts';
import { Menu, type MenuItem } from '../ui/Menu.tsx';
import { BLOCKED_TITLE } from '../ui/menu-gate.ts';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const EMPTY_ICON = { ios: 'square.stack.3d.up', android: 'view_kanban' } as const;
const NO_TASKS: readonly TaskSummary[] = [];
const ALL_PROJECTS = '';
const STATUS: Record<string, string> = { running: 'Working', waiting: 'Needs you', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
/** The phone's tab labels: short enough that four fit a narrow pane with their counts ("In progress 12"
 * would shrink past legibility); the columns and menus keep the desktop's names. */
const TAB_LABELS: Record<Stage, string> = { pending: 'Pending', in_progress: 'Active', review: 'Review', completed: 'Settled' };
const SKELETON_CARDS = 3;
const STAGE_ICON: Record<Stage, MenuItem['ios']> = { pending: 'tray', in_progress: 'hammer', review: 'eye', completed: 'checkmark.circle' };

/** Moves `task` to `stage` at once; the computer's refusal puts it back and says why. */
async function moveTask(deviceId: string, task: TaskSummary, stage: Stage) {
  haptic('selection');
  const before = task.stage;
  useConnect.setState(s => ({ tasks: patchTask(s.tasks, deviceId, task.sessionId, { stage, archived: false }) }));
  try {
    await setThreadStage(deviceId, task.sessionId, stage);
    haptic('success');
  } catch (e) {
    useConnect.setState(s => ({ tasks: patchTask(s.tasks, deviceId, task.sessionId, { stage: before, archived: task.archived }) }));
    haptic('error');
    Alert.alert('Couldn’t move the task', (e as Error).message);
  }
}

/** Starts (or retries) a task as the desktop's Start: its details, else its title, as the prompt. */
async function startTask(deviceId: string, task: TaskSummary, withGoal: boolean) {
  haptic('selection');
  try {
    const goal = withGoal ? await threadGoal(deviceId, task.sessionId).catch(() => null) : null;
    await connect.sendMessage(deviceId, task.sessionId, startPrompt(task.title, goal?.description));
  } catch (e) {
    haptic('error');
    Alert.alert('Couldn’t start the task', (e as Error).message);
  }
}

interface StageGate { shown: boolean; note: string | null }
/** The stage gate, the send gate, and whether the host can tell the task's details. */
interface BoardGates { stage: StageGate; send: StageGate; goal: boolean }

const ACTIONS: Record<BoardAction, { label: string; icon: IconName; primary: boolean }> = {
  start: { label: 'Start', icon: { ios: 'play.fill', android: 'play_arrow' }, primary: true },
  retry: { label: 'Retry', icon: { ios: 'arrow.clockwise', android: 'refresh' }, primary: true },
  settle: { label: 'Settle', icon: { ios: 'checkmark', android: 'check' }, primary: true },
  reopen: { label: 'Reopen', icon: { ios: 'arrow.uturn.backward', android: 'undo' }, primary: false },
};

function CardAction({ deviceId, task, gates }: { deviceId: string; task: TaskSummary; gates: BoardGates }) {
  const [busy, setBusy] = useState(false);
  const action = boardAction(task);
  if (!action) return null;
  const sending = action === 'start' || action === 'retry';
  const gate = sending ? gates.send : gates.stage;
  if (!gate.shown) return null;
  const { label, icon, primary } = ACTIONS[action];
  const press = async () => {
    if (gate.note) { Alert.alert(BLOCKED_TITLE, gate.note); return; }
    setBusy(true);
    try {
      if (sending) await startTask(deviceId, task, gates.goal);
      else await moveTask(deviceId, task, action === 'settle' ? 'completed' : 'review');
    } finally {
      setBusy(false);
    }
  };
  return <Button label={label} size="small" variant={primary ? 'primary' : 'raised'} icon={icon} loading={busy} onPress={() => void press()}
    accessibilityLabel={`${label} task: ${task.title || 'Untitled task'}`} style={styles.action} />;
}

function BoardCard({ deviceId, task, gates }: { deviceId: string; task: TaskSummary; gates: BoardGates }) {
  const gate = gates.stage;
  const colors = useColors();
  const working = task.status === 'running' || task.status === 'waiting';
  const detail = [task.projectName, STATUS[task.status], task.branch].filter(Boolean).join(' · ');
  const moves = gate.shown ? stageMoves(task) : [];
  const items: MenuItem[] = moves.map(stage => ({
    label: `Move to ${BOARD_LABELS[stage]}`, ios: STAGE_ICON[stage], android: 'drive_file_move',
    onPress: () => (gate.note ? Alert.alert(BLOCKED_TITLE, gate.note) : void moveTask(deviceId, task, stage)),
  }));
  const open = () => router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session: task.sessionId } });
  return (
    <View style={[styles.card, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}>
      <View style={styles.cardTop}>
      <PressScale onPress={open} style={styles.cardText} accessibilityLabel={`${task.title || 'Untitled task'}${detail ? `, ${detail}` : ''}`} accessibilityHint="Opens the task">
        <Text numberOfLines={2} style={[textStyle.subheadMedium, { color: colors.text }]}>{task.title || 'Untitled task'}</Text>
        <View style={styles.meta}>
          {working && <StatusDot tone={task.status === 'waiting' ? 'warning' : 'running'} pulse={task.status === 'running'} />}
          {!!detail && <Text numberOfLines={1} style={[textStyle.footnote, styles.metaText, { color: colors.muted }]}>{detail}</Text>}
        </View>
      </PressScale>
      {items.length > 0 && <Menu ios="ellipsis.circle" android="more_vert" color={colors.muted} items={items} label={`Move ${task.title || 'task'}`} />}
      </View>
      <CardAction deviceId={deviceId} task={task} gates={gates} />
    </View>
  );
}

function StageColumn({ deviceId, stage, tasks, gates, titled }: { deviceId: string; stage: Stage; tasks: readonly TaskSummary[]; gates: BoardGates; titled: boolean }) {
  const colors = useColors();
  return (
    <Group title={titled ? BOARD_LABELS[stage] : undefined} trailing={titled ? <Text style={[textStyle.footnote, { color: colors.muted }]}>{tasks.length}</Text> : undefined} style={titled ? styles.column : undefined}>
      <View style={styles.cards}>
        {tasks.map(task => <BoardCard key={task.sessionId} deviceId={deviceId} task={task} gates={gates} />)}
        {!tasks.length && <Text style={[textStyle.footnote, styles.empty, { color: colors.faint }]}>{BOARD_EMPTY[stage]}</Text>}
      </View>
    </Group>
  );
}

/** Stand-in cards while the computer's task list hasn't arrived. */
function BoardSkeleton() {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel="Loading the board" style={styles.skeleton}>
      <Skeleton height={36} radius={geometry.controlRadius} />
      <Group>
        <View style={styles.cards}>
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <View key={i} style={[styles.card, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}>
              <Skeleton width="70%" />
              <Skeleton width="45%" height={12} />
            </View>
          ))}
        </View>
      </Group>
    </View>
  );
}

export default function BoardScreen() {
  const { device = '', project } = useLocalSearchParams<{ device: string; project?: string }>();
  const scroll = usePushedScroll();
  const colors = useColors();
  const tasks = useConnect(s => s.tasks[device]?.tasks ?? NO_TASKS);
  const loaded = useConnect(s => !!s.tasks[device]);
  const [filter, setFilter] = useState(project ?? ALL_PROJECTS);
  const [width, setWidth] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const canStage = useHostAllows(device, 'thread.setStage');
  const stageNote = useAccessNote(device, ['thread.setStage']);
  const canSend = useHostAllows(device, 'task.send');
  const sendNote = useAccessNote(device, ['task.send']);
  const gates: BoardGates = {
    stage: { shown: useHostSupports(device, 'thread.setStage'), note: canStage ? null : stageNote ?? 'This phone can’t change stages there.' },
    send: { shown: true, note: canSend ? null : sendNote ?? 'This phone can’t start tasks there.' },
    goal: useHostSupports(device, 'thread.goal'),
  };
  const groups = useMemo(() => groupBoard(tasks, filter || undefined), [tasks, filter]);
  const projects = useMemo(() => boardProjects(tasks), [tasks]);
  const [tab, setTab] = useState<Stage | null>(null);
  const stage = tab ?? firstStage(groups);
  const layout = boardLayout(width);
  const total = STAGES.reduce((sum, s) => sum + groups[s].length, 0);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await connect.listTasks(device);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
    setRefreshing(false);
  };
  useReloadOnReconnect(device, refresh);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const options = STAGES.map(s => ({ value: s, label: groups[s].length ? `${TAB_LABELS[s]} ${groups[s].length}` : TAB_LABELS[s] }));
  return (
    <View style={styles.screen} onLayout={onLayout}>
      <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Board' }} />
        <HeaderActions />
        <Banner visible={!!error} tone="danger" title="Couldn’t refresh the board" body={error} action={{ label: 'Retry', onPress: refresh }} />
        {projects.length > 1 && (
          <Group>
            <View style={styles.filter}>
              <Text style={[textStyle.subhead, styles.filterLabel, { color: colors.text }]}>Project</Text>
              <Choice label="Project" value={filter} options={[{ value: ALL_PROJECTS, label: 'All projects' }, ...projects.map(p => ({ value: p.id, label: p.name }))]} onChange={setFilter} />
            </View>
          </Group>
        )}
        {!loaded && <BoardSkeleton />}
        {loaded && !total && <EmptyState icon={EMPTY_ICON} title="No tasks on the board" body="Tasks you start on this computer show here by stage." style={styles.emptyState} />}
        {!!total && layout === 'tabs' && (
          <>
            <Segmented options={options} value={stage} onChange={next => setTab(next)} accessibilityLabel="Stage" />
            <StageColumn deviceId={device} stage={stage} tasks={groups[stage]} gates={gates} titled={false} />
          </>
        )}
        {!!total && layout === 'columns' && (
          <View style={styles.columns}>
            {STAGES.map(s => <StageColumn key={s} deviceId={device} stage={s} tasks={groups[s]} gates={gates} titled />)}
          </View>
        )}
      </PushedScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: geometry.sectionGap },
  column: { flex: 1, minWidth: 0 },
  cards: { padding: geometry.cardPadding, gap: geometry.cardPadding },
  card: { gap: geometry.cardPadding, paddingVertical: geometry.screenMargin, paddingHorizontal: geometry.rowInset, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
  cardText: { flex: 1, gap: geometry.cardPadding / 2 },
  action: { alignSelf: 'flex-start' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
  metaText: { flexShrink: 1 },
  empty: { textAlign: 'center', paddingVertical: geometry.rowInset + geometry.cardPadding },
  emptyState: { marginTop: geometry.emptyTop },
  filter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding, gap: geometry.rowInset },
  filterLabel: { flexShrink: 1 },
  skeleton: { gap: geometry.sectionGap },
});
