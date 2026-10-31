// One task: transcript (stored messages + live run + unsent messages), the native header
// (TaskHeader), pending requests and the composer.
import { useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { memo, useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { markOpen } from '../../../connect/perf.ts';
import type { PendingRequest } from '../../../connect/types.ts';
import { botOf, rowTeam } from '../../../store/inbox.ts';
import { teamBusy } from '../../../store/team.ts';
import { taskKey, useConnect } from '../../../store/index.ts';
import { duration, type TurnRow } from '../../../store/turns.ts';
import { Composer } from '../../../ui/Composer.tsx';
import { Glass, hasGlass } from '../../../ui/Glass.tsx';
import { ApprovalCard, InputCard } from '../../../ui/requests.tsx';
import { isActive } from '../../../ui/status.tsx';
import { Icon } from '../../../ui/Icon.tsx';
import { HeaderBlur, TaskHeader } from '../../../ui/TaskHeader.tsx';
import { useColors } from '../../../ui/theme.ts';
import { useBackdrop } from '../../../ui/Backdrop.tsx';
import { Transcript } from '../../../ui/transcript.tsx';
import { WorkerNamesContext } from '../../../ui/ToolCards.tsx';
import { useNames, useTeam } from '../../../ui/useTeam.ts';

const NONE: PendingRequest[] = [];

/** The keyboard's height over the screen (0 while hidden), animated like the keyboard on iOS. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const move = (next: number, duration?: number) => {
      if (ios && duration) LayoutAnimation.configureNext({ duration, update: { type: 'keyboard' } });
      setHeight(next);
    };
    const subs = [
      Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', e => move(e.endCoordinates.height, e.duration)),
      Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', e => move(0, e.duration)),
    ];
    return () => subs.forEach(sub => sub.remove());
  }, []);
  return height;
}

/** "Working 42s" since the last prompt; only this text re-renders each second. */
function Elapsed({ since }: { since: number }) {
  const colors = useColors();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text style={[styles.pillText, { color: colors.text }]}>Working {duration(Math.max(0, now - since))}</Text>;
}

/** The floating row above the composer: the Working pill while running, and a jump to the newest message. */
const Floaters = memo(function Floaters({ deviceId, sessionId, running, away, onLatest }: { deviceId: string; sessionId: string; running: boolean; away: boolean; onLatest: () => void }) {
  const colors = useColors();
  // The newest prompt, stored or listed (whichever the phone has seen last), marks the run's start.
  const since = useConnect(s => Math.max(s.messages[taskKey(deviceId, sessionId)]?.findLast(m => m.role === 'user')?.createdAt ?? 0,
    s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.lastPromptAt ?? 0));
  const phone = useConnect(s => /^(ios|android)$/.test(s.devices.find(d => d.id === deviceId)?.platform ?? ''));
  if (!running && !away) return null;
  return (
    <View style={styles.floaters} pointerEvents="box-none">
      {running && !!since && (
        <Glass style={styles.pill} accessible accessibilityRole="text">
          <Elapsed since={since} />
          <View style={[styles.divider, { backgroundColor: colors.separator }]} />
          <Icon ios={phone ? 'iphone' : 'desktopcomputer'} android={phone ? 'smartphone' : 'computer'} size={14} color={colors.secondary} />
        </Glass>
      )}
      {away && (
        <Glass style={styles.latest} interactive>
          <Pressable onPress={onLatest} accessibilityRole="button" accessibilityLabel="Scroll to the newest message" hitSlop={6} style={styles.latestInner}>
            <Icon ios="chevron.down" android="expand_more" size={16} color={colors.text} />
          </Pressable>
        </Glass>
      )}
    </View>
  );
});

export default function TaskScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const backdrop = useBackdrop();
  const insets = useSafeAreaInsets();
  // With Liquid Glass the header is transparent (TaskHeader): the transcript runs under it, inset
  // by its height, with HeaderBlur behind the bar.
  const header = useHeaderHeight();
  const task = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session));
  // Narrow selectors: a streamed text delta changes none of these, so this screen, the
  // composer and the list stay put while only the live row re-renders.
  const key = taskKey(device, session);
  const pull = useConnect(s => !!s.pulls[key]);
  const bot = useConnect(s => botOf(s.bots[device], task, session));
  const liveStatus = useConnect(s => s.live[key]?.status ?? 'idle');
  const approvals = useConnect(s => s.live[key]?.approvals ?? NONE);
  const inputs = useConnect(s => s.live[key]?.inputs ?? NONE);
  // Asked once (not polled here): names workers in tool sentences and shows the Agents item.
  const team = useTeam(device, session, false);
  const names = useNames(team);
  const agents = useConnect(s => !!s.live[key]?.subagents?.length) || (!!team && team !== 'outdated' && team.workers.length > 0);
  const status = liveStatus === 'idle' && task && isActive(task.status) ? task.status : liveStatus;
  const [bottom, setBottom] = useState(80);
  const keyboard = useKeyboardHeight();
  const list = useRef<FlatList<TurnRow>>(null);
  const [away, setAway] = useState(false);
  const [latest] = useState(() => () => list.current?.scrollToOffset({ offset: 0, animated: true }));

  useEffect(() => {
    markOpen(taskKey(device, session));
    connect.watch(device, [session]);
    connect.loadMessages(device, session).catch(() => undefined);
    connect.loadPull(device, session).catch(() => undefined); // shows the header's pull request item
    return () => connect.unwatch(device, [session]);
  }, [device, session]);

  const requests = approvals.length + inputs.length > 0;
  // A team still working keeps Stop (which pauses it on the host) and queued sends.
  const running = isActive(status) || teamBusy(rowTeam(task, team));
  return (
    <WorkerNamesContext.Provider value={names}>
    <View style={[styles.screen, { backgroundColor: backdrop.background }]}>
      <TaskHeader deviceId={device} sessionId={session} running={running} title={task?.title || 'Task'} pull={pull} agents={agents} bot={bot} />
      {/* Side insets: the iPhone Duo's rail, or a landscape notch. */}
      <View style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        <Transcript deviceId={device} sessionId={session} top={(hasGlass ? header : 0) + 12} bottom={bottom + keyboard + 12} listRef={list} onAway={setAway} />
        <HeaderBlur height={header} />
        <View style={[styles.dock, { left: insets.left, right: insets.right, bottom: keyboard, paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 10) }]} onLayout={e => setBottom(e.nativeEvent.layout.height)} pointerEvents="box-none">
          <Floaters deviceId={device} sessionId={session} running={running} away={away} onLatest={latest} />
          {requests && (
            <ScrollView style={styles.requests} contentContainerStyle={styles.requestList} keyboardShouldPersistTaps="handled">
              {approvals.map(r => <ApprovalCard key={r.requestId} deviceId={device} sessionId={session} request={r} />)}
              {inputs.map(r => <InputCard key={r.requestId} deviceId={device} sessionId={session} request={r} />)}
            </ScrollView>
          )}
          <Composer deviceId={device} sessionId={session} running={running} bot={bot} />
        </View>
      </View>
    </View>
    </WorkerNamesContext.Provider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dock: { position: 'absolute', bottom: 0 },
  requests: { maxHeight: 380, flexGrow: 0 },
  requestList: { gap: 8, paddingBottom: 8 },
  floaters: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingBottom: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 9, height: 36, borderRadius: 18, paddingHorizontal: 14 },
  pillText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 14 },
  latest: { width: 36, height: 36, borderRadius: 18 },
  latestInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
