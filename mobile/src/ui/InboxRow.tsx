// One inbox row, two lines: project tile, the title and harness logo, then the status beside what the
// agent is doing or the branch and project (plus the computer when there is more than one). Swipe for
// Snooze / Pin, far enough to snooze outright; long press for those plus Approve, Deny and Stop as the
// system context menu (iOS) or the action sheet. With accessibility text sizes the title wraps and the meta stacks.
import { Link, router } from 'expo-router';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, PlatformColor, StyleSheet, Text, useWindowDimensions, View, type AccessibilityActionEvent, type ColorValue } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { Extrapolation, interpolate, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { connect } from '../connect/client.ts';
import { markOpen } from '../connect/perf.ts';
import { approvalSummary, branchFits, elapsedLabel, pendingApproval, runClockStart, stalledFor, tomorrowMorning, type InboxRow as Row } from '../store/inbox.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { workerActive } from '../store/team.ts';
import { removeOutbox, retryOutbox, snooze, togglePin, unsnooze } from '../store/local.ts';
import { useColors } from './theme.ts';
import { BranchChip, CHROME_FONT_SCALE, Chip, CrossFadeText, haptic, PressScale, springs, StatusDot, type, type Tone } from './ds/index.ts';
import { HarnessLogo } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { ROW_PRESS_DELAY_MS } from './InboxCard.tsx';
import { showActions, type MenuItem } from './Menu.tsx';
import { ProjectTile } from './ProjectTile.tsx';
import { ago } from './status.tsx';
import type { Colors } from './theme.ts';

const HOUR = 3600_000;

/** Pin and snooze are this phone's own: they apply at once, with a tick. */
const tap = (run: () => void) => () => {
  haptic('selection');
  run();
};

function actions(row: Row, snoozed: boolean): MenuItem[] {
  if (row.outboxId) {
    const id = row.outboxId;
    return [
      { label: 'Send now', ios: 'arrow.up.circle', android: 'send', onPress: () => retryOutbox(id) },
      { label: 'Delete message', ios: 'trash', android: 'delete', destructive: true, onPress: () => removeOutbox(id) },
    ];
  }
  const answers: MenuItem[] = row.badge === 'approval' && !seenActive(row)
    ? [
      { label: 'Approve', ios: 'checkmark.circle', android: 'check_circle', onPress: () => answerApproval(row, true) },
      { label: 'Deny', ios: 'xmark.circle', android: 'cancel', destructive: true, onPress: () => answerApproval(row, false) },
    ]
    : [];
  const items: MenuItem[] = snoozed
    ? [{ label: 'Unsnooze', ios: 'bell', android: 'notifications', onPress: tap(() => unsnooze(row.key)) }]
    : [
      { label: 'Snooze 1 hour', ios: 'moon.zzz', android: 'snooze', onPress: tap(() => snooze(row.key, Date.now() + HOUR)) },
      { label: 'Snooze until tomorrow', ios: 'sunrise', android: 'wb_twilight', onPress: tap(() => snooze(row.key, tomorrowMorning(Date.now()))) },
    ];
  items.push({ label: row.pinned ? 'Unpin' : 'Pin', ios: row.pinned ? 'pin.slash' : 'pin', android: 'push_pin', onPress: tap(() => togglePin(row.key)) });
  if (row.badge === 'working' || row.badge === 'approval' || row.badge === 'question') {
    items.push({ label: 'Stop', ios: 'stop.circle', android: 'stop_circle', destructive: true, onPress: () => stop(row) });
  }
  return [...answers, ...items];
}

const openTask = (row: Row) => router.push({ pathname: '/task/[device]/[session]', params: { device: row.deviceId, session: row.task.sessionId } });

/** Approve shows the command first; Deny answers at once. A request not loaded yet opens the thread, which loads it. */
function answerApproval(row: Row, approve: boolean) {
  const request = pendingApproval(useConnect.getState().live[row.key], row.task);
  if (!request) return void openTask(row);
  const send = () => {
    connect.respondApproval(row.deviceId, row.task.sessionId, request.requestId, approve).then(
      () => haptic(approve ? 'success' : 'warning'),
      error => { haptic('error'); Alert.alert('Could not send', (error as Error).message); },
    );
  };
  if (!approve) return send();
  haptic('selection');
  Alert.alert('Approve this?', approvalSummary(request), [{ text: 'Cancel', style: 'cancel' }, { text: 'Approve', onPress: send }]);
  return undefined;
}

function stop(row: Row) {
  haptic('warning');
  connect.stopTask(row.deviceId, row.task.sessionId).catch(error => Alert.alert('Could not stop', (error as Error).message));
}

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A row from the inbox cache that looked active: when it was last seen, never a live spinner. */
const seenActive = (row: Row) => row.task.seenAt !== undefined && (row.badge === 'working' || row.badge === 'approval' || row.badge === 'question');

const lastSeen = (at: number) => { const when = ago(at); return when === 'now' ? 'Last seen just now' : `Last seen ${when} ago`; };

const BADGES: Partial<Record<NonNullable<Row['badge']>, { ios: MenuItem['ios']; android: MenuItem['android']; tone?: Tone; text: string }>> = {
  approval: { ios: 'hand.raised.fill', android: 'front_hand', tone: 'warning', text: 'Approval' },
  question: { ios: 'questionmark.bubble.fill', android: 'help', tone: 'warning', text: 'Question' },
  failed: { ios: 'xmark.octagon.fill', android: 'error', tone: 'danger', text: 'Failed' },
  stopped: { ios: 'stop.circle', android: 'stop_circle', text: 'Stopped' },
  limited: { ios: 'gauge.with.needle', android: 'speed', tone: 'warning', text: 'Limited' },
  unsent: { ios: 'clock.arrow.circlepath', android: 'schedule_send', tone: 'warning', text: 'Sends on reconnect' },
};

const badgeText = (row: Row) => (row.badge === 'limited' && row.run.limitedUntil ? `Limited until ${clockTime(row.run.limitedUntil)}` : BADGES[row.badge!]?.text ?? '');

function clockOf(row: Row, now: number) {
  const live = useConnect.getState().live[row.key];
  const stalled = stalledFor(live?.lastEventAt ?? row.task.lastEventAt, now);
  return { stalled, text: stalled !== null ? `Stalled ${elapsedLabel(stalled)}` : `Working ${elapsedLabel(now - (runClockStart(live, row.task) ?? row.at))}` };
}

/** What VoiceOver says for the row's status. */
function spokenStatus(row: Row): string {
  if (seenActive(row)) return lastSeen(row.task.seenAt!);
  if (row.badge === 'working') return clockOf(row, Date.now()).text;
  return row.badge ? badgeText(row) : `Updated ${ago(row.at)}${ago(row.at) === 'now' ? '' : ' ago'}`;
}

function Status({ row, colors }: { row: Row; colors: Colors }) {
  if (seenActive(row)) return <Label ios="clock" android="schedule" color={colors.muted} text={lastSeen(row.task.seenAt!)} />;
  if (row.badge === 'working') return <RunClock row={row} colors={colors} />;
  const badge = row.badge && BADGES[row.badge];
  if (badge) return <Label ios={badge.ios} android={badge.android} color={badge.tone ? colors[badge.tone] : colors.muted} text={badgeText(row)} />;
  return <CrossFadeText text={ago(row.at)} numberOfLines={1} style={[type.footnote, styles.time, { color: colors.muted }]} />;
}

/** Glyphs beside text follow Dynamic Type, up to double. */
const useGlyphSize = (size: number) => Math.round(size * Math.min(useWindowDimensions().fontScale, 2));

function Label({ ios, android, color, text }: { ios: MenuItem['ios']; android: MenuItem['android']; color: ColorValue; text: string }) {
  const size = useGlyphSize(12);
  return <View style={styles.status}><Icon ios={ios!} android={android!} size={size} color={color} /><CrossFadeText text={text} numberOfLines={1} style={[type.footnoteMedium, { color }]} /></View>;
}

/** Labels that count time re-render on their own, at most this often. */
const TICK_MS = 15_000;

function useTick() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "Working 6m" beside a pulsing dot, or "Stalled 4m" once no event came for STALL_MS. Only this ticks;
 * it reads the run's newest event time when it does, so streamed events never re-render the list. */
function RunClock({ row, colors }: { row: Row; colors: Colors }) {
  const { stalled, text } = clockOf(row, useTick());
  const dot = useGlyphSize(8);
  if (stalled !== null) return <Label ios="hourglass" android="hourglass_empty" color={colors.warning} text={text} />;
  return <View style={styles.status}><StatusDot tone="running" pulse size={dot} /><CrossFadeText text={text} numberOfLines={1} style={[type.footnoteMedium, { color: colors.running }]} /></View>;
}

/** "Waiting 54m": only this text ticks. */
function Elapsed({ prefix, since, color }: { prefix: string; since: number; color: ColorValue }) {
  const now = useTick();
  return <CrossFadeText text={`${prefix} ${elapsedLabel(now - since)}`} numberOfLines={1} style={[type.footnoteMedium, { color }]} />;
}

/** The sidebar's status: waiting time on approvals and questions, otherwise as in the inbox. */
function SidebarStatus({ row, colors }: { row: Row; colors: Colors }) {
  if (!seenActive(row) && (row.badge === 'approval' || row.badge === 'question')) {
    return <View style={styles.status}><Icon ios={row.badge === 'approval' ? 'hand.raised.fill' : 'questionmark.bubble.fill'} android={row.badge === 'approval' ? 'front_hand' : 'help'} size={12} color={colors.warning} /><Elapsed prefix="Waiting" since={row.at} color={colors.warning} /></View>;
  }
  return <Status row={row} colors={colors} />;
}

/** The chip is 20 pt tall: this makes a 44 pt target inside a tappable row. */
const CHIP_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

const showAgents = (row: Row) => router.push({ pathname: '/agents', params: { device: row.deviceId, session: row.task.sessionId } });

/** Beside the status: on a running row what the agent is doing and how many subagents and team
 * workers (once the task's team is known) are working (the count opens the Agents screen); else the
 * branch and project, and the computer once there is more than one to tell apart. */
function Meta({ row, project, agents, showComputer, large, sidebar, colors }: { row: Row; project: string; agents: number; showComputer: boolean; large: boolean; sidebar?: boolean; colors: Colors }) {
  const { width, fontScale } = useWindowDimensions();
  const activity = row.run.activity;
  const grow = large ? undefined : styles.grow;
  if (row.badge === 'working' && (activity || agents)) {
    return (
      <>
        <Text style={[type.footnote, grow, { color: colors.muted }]} numberOfLines={large ? 3 : 1}>{activity}</Text>
        {agents > 0 && (
          <PressScale onPress={() => showAgents(row)} hitSlop={CHIP_HIT_SLOP} accessibilityLabel={`${agents} agent${agents === 1 ? '' : 's'} working. Show agents`}>
            <Chip label={`+${agents} agent${agents === 1 ? '' : 's'}`} style={styles.compactChip} />
          </PressScale>
        )}
      </>
    );
  }
  const branch = row.task.branch;
  const statusText = seenActive(row) ? lastSeen(row.task.seenAt!) : row.badge ? badgeText(row) : ago(row.at);
  const fits = !!branch && !sidebar && (large || branchFits({ status: statusText, statusIcon: seenActive(row) || !!row.badge, branch, project, computer: showComputer ? row.computer : undefined }, width - ROW_CHROME, fontScale));
  return (
    <>
      {fits && <BranchChip branch={branch} style={styles.compactChip} />}
      <Text style={[type.footnote, styles.project, { color: colors.faint }]} numberOfLines={large ? 2 : 1}>{project}</Text>
      {showComputer && <><View style={grow} /><Text style={[type.footnote, styles.computer, { color: colors.faint }]} numberOfLines={large ? 2 : 1} ellipsizeMode="middle">{row.computer}</Text></>}
    </>
  );
}

const sameRun = (a: Row['run'], b: Row['run']) => a === b || (a.activity === b.activity && a.agents === b.agents && a.startedAt === b.startedAt && a.limitedUntil === b.limitedUntil);

/** Swipe actions stay right of the row's edge until all are out, so they never show under a row
 * mid-swipe; the row's release spring carries them. */
function Reveal({ progress, translation, total, children }: { progress: SharedValue<number>; translation: SharedValue<number>; total: number; children: ReactNode }) {
  const style = useAnimatedStyle(() => ({
    opacity: progress.get() > 0 ? 1 : 0,
    transform: [{ translateX: Math.max(0, total + translation.get()) }],
  }));
  return <Animated.View style={[styles.swipeRow, style]}>{children}</Animated.View>;
}

/** Press-in: start reading the thread's cache so it draws in the screen's first frame. */
function warm(deviceId: string, sessionId: string) {
  markOpen(taskKey(deviceId, sessionId));
  void connect.peek(deviceId, sessionId);
}

/** System fills, as in Mail: saturated with white glyphs in both appearances, flush and full height. */
const SWIPE_FILLS = {
  destructive: Platform.select<ColorValue>({ ios: PlatformColor('systemRed'), default: '#d32f2f' }),
  pin: Platform.select<ColorValue>({ ios: PlatformColor('systemOrange'), default: '#ef6c00' }),
  tomorrow: Platform.select<ColorValue>({ ios: PlatformColor('systemPurple'), default: '#7b1fa2' }),
  snooze: Platform.select<ColorValue>({ ios: PlatformColor('systemIndigo'), default: '#3949ab' }),
};
const SWIPE_INK = '#ffffff';

function SwipeAction({ label, ios, android, fill, progress, onPress }: { label: string; ios: MenuItem['ios']; android: MenuItem['android']; fill: ColorValue; progress: SharedValue<number>; onPress: () => void }) {
  const glyph = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(progress.get(), [0.3, 1], [0.7, 1], Extrapolation.CLAMP) }] }));
  return (
    <PressScale scale={1} onPress={onPress} style={[styles.swipe, { backgroundColor: fill }]} accessibilityLabel={label}>
      <Animated.View style={[styles.swipeBody, glyph]}>
        <Icon ios={ios!} android={android!} size={20} color={SWIPE_INK} />
        <Text style={[type.caption, { color: SWIPE_INK }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_SCALE}>{label}</Text>
      </Animated.View>
    </PressScale>
  );
}

const ACTION_WIDTH = 74;
/** Past the revealed actions, a full swipe commits: this far more, or this share of the row on a narrow screen. */
const FULL_SWIPE_EXTRA = 56;
const FULL_SWIPE_SHARE = 0.82;
const ROW_INSET = 44;
/** Screen margins, card insets, tile and gaps around a row's text. */
const ROW_CHROME = 122;

/** The action a full swipe runs: reversible only, so never Delete. Stop stays in the context menu. */
const fullSwipeLabel = (row: Row, snoozed: boolean) => (row.outboxId ? undefined : snoozed ? 'Unsnooze' : 'Snooze 1');

function SwipeActions({ row, snoozed, sidebar, menu, progress, translation, swipe, onArm }: { row: Row; snoozed: boolean; sidebar?: boolean; menu: MenuItem[]; progress: SharedValue<number>; translation: SharedValue<number>; swipe: SwipeableMethods; onArm: (armed: boolean) => void }) {
  const { width } = useWindowDimensions();
  const armed = useSharedValue(0);
  const run = (item?: MenuItem) => () => { swipe.close(); item?.onPress(); };
  const find = (label: string) => menu.find(m => m.label.startsWith(label));
  const buttons = row.outboxId
    ? [<SwipeAction key="delete" label="Delete" ios="trash.fill" android="delete" fill={SWIPE_FILLS.destructive} progress={progress} onPress={run(find('Delete'))} />]
    : [
      <SwipeAction key="pin" label={row.pinned ? 'Unpin' : 'Pin'} ios={row.pinned ? 'pin.slash.fill' : 'pin.fill'} android="push_pin" fill={SWIPE_FILLS.pin} progress={progress} onPress={run(find(row.pinned ? 'Unpin' : 'Pin'))} />,
      ...(snoozed ? [] : [<SwipeAction key="tomorrow" label="Tomorrow" ios="sunrise.fill" android="wb_twilight" fill={SWIPE_FILLS.tomorrow} progress={progress} onPress={run(find('Snooze until'))} />]),
    ];
  const primary = !row.outboxId && (snoozed
    ? <SwipeAction label="Wake" ios="bell.fill" android="notifications" fill={SWIPE_FILLS.snooze} progress={progress} onPress={run(find('Unsnooze'))} />
    : <SwipeAction label="1 h" ios="moon.zzz.fill" android="snooze" fill={SWIPE_FILLS.snooze} progress={progress} onPress={run(find('Snooze 1'))} />);
  const total = (buttons.length + (primary ? 1 : 0)) * ACTION_WIDTH;
  const threshold = Math.min(total + FULL_SWIPE_EXTRA, (width - ROW_INSET) * FULL_SWIPE_SHARE);
  // Armed, the primary action leaves its slot and rides the row's edge, as Mail's does.
  const ride = useAnimatedStyle(() => ({ transform: [{ translateX: armed.get() * Math.min(0, translation.get() + total) }] }));
  return (
    <Reveal progress={progress} translation={translation} total={total}>
      {buttons}
      {!!primary && !sidebar && <FullSwipeFill translation={translation} total={total} threshold={threshold} width={width} fill={SWIPE_FILLS.snooze} armed={armed} onArm={onArm} />}
      {!!primary && <Animated.View style={[styles.swipeRow, ride]}>{primary}</Animated.View>}
    </Reveal>
  );
}

/** Past the actions the primary one's colour follows the row's edge, and crossing the threshold ticks and arms it. */
function FullSwipeFill({ translation, total, threshold, width, fill, armed, onArm }: { translation: SharedValue<number>; total: number; threshold: number; width: number; fill: ColorValue; armed: SharedValue<number>; onArm: (armed: boolean) => void }) {
  useAnimatedReaction(() => translation.get() < -threshold, (now, before) => {
    if (now === before || (before === null && !now)) return;
    armed.set(withSpring(now ? 1 : 0, springs.snappy));
    scheduleOnRN(onArm, now);
  });
  const style = useAnimatedStyle(() => ({
    opacity: -translation.get() > total ? 1 : 0,
    transform: [{ translateX: width + translation.get() }],
  }));
  return <Animated.View pointerEvents="none" style={[styles.swipeFill, { width, backgroundColor: fill }, style]} />;
}

const SPRING = { mass: springs.momentum.mass, stiffness: springs.momentum.stiffness, damping: springs.momentum.damping };
/** From here on (accessibility sizes) the title wraps and the meta stacks. */
const HIGHLIGHT_IN = { duration: 60 };
const HIGHLIGHT_OUT = { duration: 150 };
const LARGE_TEXT = 1.35;
/** Short titles keep the row dense; a long one takes a second line rather than an ellipsis. */
const TITLE_LINES = 2;

/** `sidebar` is the iPhone Duo's list: a rounded fill on the `selected` row, and `replace` swaps the
 * open task instead of stacking another. `showComputer`: more than one computer is listed. */
export const InboxRow = memo(function InboxRow({ row, snoozed, showComputer, sidebar, selected, replace }: { row: Row; snoozed: boolean; showComputer: boolean; minute: number; sidebar?: boolean; selected?: boolean; replace?: boolean }) {
  const colors = useColors();
  const large = useWindowDimensions().fontScale >= LARGE_TEXT;
  const glyph = useGlyphSize(15);
  // On the UI thread, so a release fades instead of waiting for (or causing) a re-render of the row.
  const pressed = useSharedValue(0);
  const highlight = useAnimatedStyle(() => ({ opacity: pressed.get() }));
  const armed = useRef(false);
  const swipeRef = useRef<SwipeableMethods>(null);
  const { task } = row;
  const workers = useConnect(s => { const team = s.teams[row.key]; return team && team !== 'outdated' ? team.workers.filter(workerActive).length : 0; });
  const agents = row.run.agents + workers;
  const project = task.chat ? 'Chat' : task.projectName || 'Project';
  const title = row.outboxId ? `“${row.text}”` : task.title || 'Untitled task';
  const menu = actions(row, snoozed);
  const href = { pathname: '/task/[device]/[session]' as const, params: { device: row.deviceId, session: task.sessionId } };
  const body = (
    // The element screen readers see is the wrapper below.
    <PressScale scale={1} unstable_pressDelay={ROW_PRESS_DELAY_MS} accessible={false} focusable={false} onLongPress={Platform.OS === 'ios' && !replace ? undefined : () => showActions(task.title, menu)}
      onPressIn={() => { pressed.set(withTiming(1, HIGHLIGHT_IN)); if (!row.outboxId) warm(row.deviceId, task.sessionId); }} onPressOut={() => pressed.set(withTiming(0, HIGHLIGHT_OUT))}
      style={StyleSheet.flatten([styles.row, large && styles.rowLarge, selected && [styles.selected, { backgroundColor: colors.fill }]])}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.selected, { backgroundColor: colors.fill }, highlight]} />
      <ProjectTile deviceId={row.deviceId} projectId={task.chat ? undefined : task.projectId} name={project} size={sidebar ? 24 : 28} />
      <View style={styles.text}>
        <View style={styles.titleLine}>
          <Text style={[type.calloutMedium, styles.grow, { color: colors.text }]} numberOfLines={large ? 4 : TITLE_LINES}>{title}</Text>
          {row.pinned && <Icon ios="pin.fill" android="push_pin" size={11} color={colors.faint} />}
          <HarnessLogo id={task.provider} size={glyph} />
        </View>
        <View style={large ? styles.stack : styles.line}>
          {sidebar ? <SidebarStatus row={row} colors={colors} /> : <Status row={row} colors={colors} />}
          <Meta row={row} project={project} agents={agents} showComputer={showComputer} large={large} sidebar={sidebar} colors={colors} />
        </View>
      </View>
    </PressScale>
  );
  const fullSwipe = fullSwipeLabel(row, snoozed);
  const arm = (now: boolean) => {
    armed.current = now;
    if (now) haptic('medium');
  };
  const commit = () => {
    if (!armed.current) return;
    armed.current = false;
    swipeRef.current?.close();
    menu.find(item => item.label.startsWith(fullSwipe ?? '\0'))?.onPress();
  };
  const open = () => (replace ? router.replace(href) : router.push(href));
  const act = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (name === 'activate') open();
    else if (name === 'Show agents') showAgents(row);
    else menu.find(item => item.label === name)?.onPress();
  };
  return (
    // One element above the swipe and Link's native context-menu view, the wrappers bot rows don't have
    // and task rows dropped out of the accessibility tree under. Its actions give VoiceOver the swipe actions.
    <View accessible accessibilityRole="button" accessibilityHint="Opens the task" accessibilityState={{ selected: !!selected }}
      accessibilityLabel={[title, project, spokenStatus(row), task.branch, row.computer].filter(Boolean).join(', ')}
      accessibilityActions={[{ name: 'activate' }, ...menu.map(item => ({ name: item.label, label: item.label })), ...(agents ? [{ name: 'Show agents', label: 'Show agents' }] : [])]}
      onAccessibilityAction={act} onAccessibilityTap={open}>
      <Swipeable ref={swipeRef} renderRightActions={(progress, translation, swipe) => <SwipeActions row={row} snoozed={snoozed} sidebar={sidebar} menu={menu} progress={progress} translation={translation} swipe={swipe} onArm={arm} />}
        overshootRight={!sidebar && !!fullSwipe} friction={1} animationOptions={SPRING} onSwipeableWillOpen={commit} childrenContainerStyle={{ backgroundColor: colors.cardInner }}>
        {/* Link's context menu works only for a push, so a replacing row long-presses into the action sheet. */}
        {Platform.OS === 'ios' && !replace ? (
          <Link href={href} asChild>
            <Link.Trigger>{body}</Link.Trigger>
            <Link.Menu>
              {menu.map(item => <Link.MenuAction key={item.label} icon={item.ios} destructive={item.destructive} onPress={item.onPress}>{item.label}</Link.MenuAction>)}
            </Link.Menu>
          </Link>
        ) : <Link href={href} replace={replace} asChild>{body}</Link>}
      </Swipeable>
    </View>
  );
}, (a, b) => a.row.task === b.row.task && a.row.badge === b.row.badge && sameRun(a.row.run, b.row.run) && a.row.pinned === b.row.pinned && a.row.at === b.row.at
  && a.row.computer === b.row.computer && a.row.outboxId === b.row.outboxId && a.row.text === b.row.text && a.snoozed === b.snoozed && a.showComputer === b.showComputer && a.minute === b.minute
  && a.sidebar === b.sidebar && a.selected === b.selected && a.replace === b.replace);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 9 },
  rowLarge: { alignItems: 'flex-start' },
  selected: { borderRadius: 12, borderCurve: 'continuous' },
  text: { flex: 1, minWidth: 0, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  stack: { alignItems: 'flex-start', gap: 3 },
  grow: { flex: 1, minWidth: 0 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 },
  time: { fontVariant: ['tabular-nums'] },
  compactChip: { minHeight: 20, paddingVertical: 0 },
  // The computer gives way first: the project is what tells rows apart.
  project: { flexShrink: 1 },
  computer: { flexShrink: 100, minWidth: 56, textAlign: 'right' },
  titleLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, minWidth: 0 },
  swipeRow: { flexDirection: 'row', alignSelf: 'stretch' },
  swipe: { width: ACTION_WIDTH, alignItems: 'center', justifyContent: 'center' },
  swipeBody: { alignItems: 'center', gap: 3 },
  swipeFill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
