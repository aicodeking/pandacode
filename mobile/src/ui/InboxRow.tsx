// One inbox row: project tile + name and status, the title, then `branch · computer` and the
// harness logo. Swipe for Snooze / Pin / Stop; long press for the same as a menu.
import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { connect } from '../connect/client.ts';
import { elapsedLabel, tomorrowMorning, type InboxRow as Row } from '../store/inbox.ts';
import { removeOutbox, retryOutbox, snooze, togglePin, unsnooze } from '../store/local.ts';
import { HarnessLogo } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { showActions, type MenuItem } from './Menu.tsx';
import { ago } from './status.tsx';
import { useBackdrop } from './Backdrop.tsx';
import { ProjectTile } from './ProjectTile.tsx';
import { mono, useColors, type Colors } from './theme.ts';

const HOUR = 3600_000;

function actions(row: Row, snoozed: boolean): MenuItem[] {
  if (row.outboxId) {
    const id = row.outboxId;
    return [
      { label: 'Send now', ios: 'arrow.up.circle', android: 'send', onPress: () => retryOutbox(id) },
      { label: 'Delete message', ios: 'trash', android: 'delete', destructive: true, onPress: () => removeOutbox(id) },
    ];
  }
  const items: MenuItem[] = snoozed
    ? [{ label: 'Unsnooze', ios: 'bell', android: 'notifications', onPress: () => unsnooze(row.key) }]
    : [
      { label: 'Snooze 1 hour', ios: 'moon.zzz', android: 'snooze', onPress: () => snooze(row.key, Date.now() + HOUR) },
      { label: 'Snooze until tomorrow', ios: 'sunrise', android: 'wb_twilight', onPress: () => snooze(row.key, tomorrowMorning(Date.now())) },
    ];
  items.push({ label: row.pinned ? 'Unpin' : 'Pin', ios: row.pinned ? 'pin.slash' : 'pin', android: 'push_pin', onPress: () => togglePin(row.key) });
  if (row.badge === 'working' || row.badge === 'approval' || row.badge === 'question') {
    items.push({ label: 'Stop', ios: 'stop.circle', android: 'stop_circle', destructive: true, onPress: () => stop(row) });
  }
  return items;
}

function stop(row: Row) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  connect.stopTask(row.deviceId, row.task.sessionId).catch(error => Alert.alert('Could not stop', (error as Error).message));
}

function Status({ row, colors }: { row: Row; colors: Colors }) {
  switch (row.badge) {
    case 'working': return <View style={styles.status}><ActivityIndicator size="small" color={colors.tint} style={styles.spinner} /><Text style={[styles.statusText, { color: colors.tint }]}>Working</Text></View>;
    case 'approval': return <Text style={[styles.statusText, { color: colors.orange }]}>Approval</Text>;
    case 'question': return <Text style={[styles.statusText, { color: colors.orange }]}>Question</Text>;
    case 'failed': return <Text style={[styles.statusText, { color: colors.red }]}>Failed</Text>;
    case 'unsent': return <View style={styles.status}><Icon ios="clock.arrow.circlepath" android="schedule_send" size={13} color={colors.orange} /><Text style={[styles.statusText, { color: colors.orange }]}>Sends on reconnect</Text></View>;
    default: return <Text style={[styles.time, { color: colors.secondary }]}>{ago(row.at)}</Text>;
  }
}

const ELAPSED_TICK_MS = 30_000;

/** "Working 6m" / "Waiting 54m": only this text ticks, every 30 s. */
function Elapsed({ prefix, since, color }: { prefix: string; since: number; color: ColorValue }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return <Text style={[styles.statusText, { color }]}>{prefix} {elapsedLabel(now - since)}</Text>;
}

/** The sidebar's status: elapsed time while working or waiting, otherwise as in the inbox. */
function SidebarStatus({ row, colors }: { row: Row; colors: Colors }) {
  if (row.badge === 'working') {
    return <View style={styles.status}><ActivityIndicator size="small" color={colors.tint} style={styles.spinner} /><Elapsed prefix="Working" since={row.task.lastPromptAt ?? row.at} color={colors.tint} /></View>;
  }
  if (row.badge === 'approval' || row.badge === 'question') {
    return <View style={styles.status}><Icon ios={row.badge === 'approval' ? 'hand.raised.fill' : 'questionmark.bubble.fill'} android={row.badge === 'approval' ? 'front_hand' : 'help'} size={12} color={colors.orange} /><Elapsed prefix="Waiting" since={row.at} color={colors.orange} /></View>;
  }
  return <Status row={row} colors={colors} />;
}

/** Swipe actions sit behind the row; over the wallpaper the row is see-through, so they appear
 * only once a swipe starts. */
function Reveal({ progress, children }: { progress: SharedValue<number>; children: ReactNode }) {
  const style = useAnimatedStyle(() => ({ opacity: progress.value > 0 ? 1 : 0 }));
  return <Animated.View style={[styles.swipeRow, style]}>{children}</Animated.View>;
}

function SwipeAction({ label, ios, android, color, onPress }: { label: string; ios: MenuItem['ios']; android: MenuItem['android']; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.swipe, { backgroundColor: color }]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon ios={ios!} android={android!} size={20} color="#ffffff" />
      <Text style={styles.swipeText}>{label}</Text>
    </Pressable>
  );
}

/** `sidebar` is the iPhone Duo's compact list: no separators, a rounded fill on the `selected`
 * row, and `replace` swaps the open task instead of stacking another. */
export const InboxRow = memo(function InboxRow({ row, snoozed, last, sidebar, selected, replace }: { row: Row; snoozed: boolean; last: boolean; minute: number; sidebar?: boolean; selected?: boolean; replace?: boolean }) {
  const colors = useColors();
  const backdrop = useBackdrop();
  const { task } = row;
  const project = task.chat ? 'Chat' : task.projectName || 'Project';
  const menu = actions(row, snoozed);
  const href = { pathname: '/task/[device]/[session]' as const, params: { device: row.deviceId, session: task.sessionId } };
  const body = (
    <Pressable onLongPress={Platform.OS === 'ios' && !replace ? undefined : () => showActions(task.title, menu)}
      style={StyleSheet.flatten(sidebar
        ? [styles.row, styles.sidebarRow, { backgroundColor: selected ? colors.fill : backdrop.grouped }]
        : [styles.row, last && styles.lastRow, { backgroundColor: backdrop.background }])}
      accessibilityState={{ selected: !!selected }}
      accessibilityRole="button" accessibilityHint="Opens the task">
      <View style={styles.line}>
        <ProjectTile deviceId={row.deviceId} projectId={task.chat ? undefined : task.projectId} name={project} />
        <Text style={[styles.project, { color: colors.secondary }]} numberOfLines={1}>{project}</Text>
        {row.pinned && <Icon ios="pin.fill" android="push_pin" size={11} color={colors.tertiary} />}
        {sidebar ? <SidebarStatus row={row} colors={colors} /> : <Status row={row} colors={colors} />}
      </View>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{row.outboxId ? `“${row.text}”` : task.title || 'Untitled task'}</Text>
      <View style={styles.line}>
        <Icon ios="desktopcomputer" android="computer" size={12} color={colors.tertiary} />
        <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>{[task.branch, row.computer].filter(Boolean).join(' · ')}</Text>
        <HarnessLogo id={task.provider} size={15} />
      </View>
      {!last && !sidebar && <View style={[styles.separator, { backgroundColor: colors.separator }]} />}
    </Pressable>
  );
  const swipeActions = (progress: SharedValue<number>, _t: unknown, swipe: SwipeableMethods) => {
    const run = (item?: MenuItem) => () => { swipe.close(); item?.onPress(); };
    const find = (label: string) => menu.find(m => m.label.startsWith(label));
    return (
      <Reveal progress={progress}>
        {row.outboxId ? <SwipeAction label="Delete" ios="trash" android="delete" color="#ff3b30" onPress={run(find('Delete'))} /> : <>
          {find('Stop') && <SwipeAction label="Stop" ios="stop.fill" android="stop" color="#ff3b30" onPress={run(find('Stop'))} />}
          <SwipeAction label={row.pinned ? 'Unpin' : 'Pin'} ios="pin.fill" android="push_pin" color="#ff9f0a" onPress={run(find(row.pinned ? 'Unpin' : 'Pin'))} />
          {snoozed
            ? <SwipeAction label="Wake" ios="bell.fill" android="notifications" color="#5e5ce6" onPress={run(find('Unsnooze'))} />
            : <SwipeAction label="1 h" ios="moon.zzz.fill" android="snooze" color="#5e5ce6" onPress={run(find('Snooze 1'))} />}
          {!snoozed && <SwipeAction label="Tomorrow" ios="sunrise.fill" android="wb_twilight" color="#af52de" onPress={run(find('Snooze until'))} />}
        </>}
      </Reveal>
    );
  };
  return (
    <Swipeable renderRightActions={swipeActions} overshootRight={false} friction={1.6} childrenContainerStyle={{ backgroundColor: sidebar ? backdrop.grouped : backdrop.background }}>
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
  );
}, (a, b) => a.row.task === b.row.task && a.row.badge === b.row.badge && a.row.pinned === b.row.pinned && a.row.at === b.row.at
  && a.row.computer === b.row.computer && a.row.outboxId === b.row.outboxId && a.row.text === b.row.text && a.snoozed === b.snoozed && a.last === b.last && a.minute === b.minute
  && a.sidebar === b.sidebar && a.selected === b.selected && a.replace === b.replace);

const styles = StyleSheet.create({
  row: { paddingLeft: 20, paddingRight: 18, paddingTop: 11, gap: 3 },
  lastRow: { paddingBottom: 11 },
  sidebarRow: { marginHorizontal: 8, paddingLeft: 12, paddingRight: 12, paddingBottom: 10, paddingTop: 10, borderRadius: 14, borderCurve: 'continuous' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  project: { flex: 1, fontSize: 14 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  spinner: { transform: [{ scale: 0.75 }] },
  statusText: { fontSize: 14, fontWeight: '500' },
  time: { fontSize: 14, fontVariant: ['tabular-nums'] },
  title: { fontSize: 16, fontWeight: '600', marginTop: 1 },
  meta: { flex: 1, fontSize: 12.5, fontFamily: mono },
  separator: { height: StyleSheet.hairlineWidth, marginTop: 11 },
  swipeRow: { flexDirection: 'row' },
  swipe: { width: 74, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
});
