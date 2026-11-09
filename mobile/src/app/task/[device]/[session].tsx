// One task: transcript (stored messages + live run + unsent messages), the native header
// (TaskHeader), pending requests and the composer.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Alert, FlatList, ScrollView, StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';
import { GlassView } from 'expo-glass-effect';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { FadeInDown, ReduceMotion, useAnimatedStyle } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { markOpen } from '../../../connect/perf.ts';
import type { PendingRequest } from '../../../connect/types.ts';
import { botOf, elapsedLabel, glanceOf, rowTeam, runClockStart, stalledFor } from '../../../store/inbox.ts';
import { teamBusy, type Team } from '../../../store/team.ts';
import { taskKey, useConnect } from '../../../store/index.ts';
import { sendOrQueue } from '../../../store/local.ts';
import type { TurnRow } from '../../../store/turns.ts';
import { Composer, SpringIn } from '../../../ui/Composer.tsx';
import { Banner, CrossFadeText, crossFadeIn, crossFadeOut, geometry, haptic, PressScale, springs, StatusDot, type as textStyle, type Tone, useMotion } from '../../../ui/ds/index.ts';
import { Glass, hasGlass } from '../../../ui/Glass.tsx';
import { ApprovalCard, InputCard } from '../../../ui/requests.tsx';
import { isActive } from '../../../ui/status.tsx';
import { Icon } from '../../../ui/Icon.tsx';
import { DockFade, HeaderBlur, TaskHeader } from '../../../ui/TaskHeader.tsx';
import { useColors } from '../../../ui/theme.ts';
import { NO_EDGE_EFFECTS, scrollToNewest, Transcript } from '../../../ui/transcript.tsx';
import { useNow } from '../../../ui/Trace.tsx';
import { WorkerNamesContext } from '../../../ui/ToolCards.tsx';
import { useNames, useTeam } from '../../../ui/useTeam.ts';

const NONE: PendingRequest[] = [];
/** The composer's usual height until it has laid out. */
const COMPOSER_ESTIMATE = 120;
/** The Working pill's row above the requests. */
const FLOATER_ROW = 44;
/** Enough for a heading and its buttons on the smallest window. */
const MIN_REQUESTS = 140;
/** Between the composer and the keyboard. */
const KEYBOARD_GAP = 8;
/** How far the fade under the dock reaches behind the composer. */
const DOCK_FADE = 36;

/** Follows the keyboard every frame on the UI thread (react-native-keyboard-controller), a finger dragging it
 * down or back up included: a style lifting the dock and the transcript, and the settled height for what can
 * wait for React. `dockInset`: the dock's own padding under the composer, which the keyboard replaces. */
function useKeyboardLift(dockInset: number) {
  const { height } = useReanimatedKeyboardAnimation();
  const [settled, setSettled] = useState(0);
  useKeyboardHandler({
    onEnd: event => {
      'worklet';
      scheduleOnRN(setSettled, event.height);
    },
  }, []);
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, -height.get() - dockInset + KEYBOARD_GAP) }] }));
  return { lift, settled };
}

const AnimatedGlass = Animated.createAnimatedComponent(GlassView);
/** A card arriving from below with a little life; a fade with Reduce Motion. */
const CARD_IN = FadeInDown.springify().mass(springs.smooth.mass).stiffness(springs.smooth.stiffness).damping(springs.smooth.damping).reduceMotion(ReduceMotion.Never);

/** The pill's surface: glass whose width follows its words with a layout transition. */
function PillSurface({ children }: { children: ReactNode }) {
  const { layout } = useMotion();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  if (hasGlass) return <AnimatedGlass layout={layout} glassEffectStyle="regular" colorScheme={scheme} style={styles.pill} accessible accessibilityLiveRegion="polite">{children}</AnimatedGlass>;
  return <Glass style={styles.pill} accessible accessibilityLiveRegion="polite">{children}</Glass>;
}

/** Why a run isn't running: it failed, was stopped or hit a limit. Stays until the next run starts. */
function RunNotice({ deviceId, sessionId, status, bot }: { deviceId: string; sessionId: string; status: string; bot: boolean }) {
  const colors = useColors();
  const key = taskKey(deviceId, sessionId);
  const limited = useConnect(s => s.live[key]?.limited);
  const now = useNow(!!limited?.resetsAt);
  const reason = useConnect(s => { const last = s.messages[key]?.at(-1); return last?.role === 'error' ? last.content : ''; });
  const lastPrompt = useConnect(s => s.messages[key]?.findLast(m => m.role === 'user')?.content ?? '');
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    haptic('light');
    try {
      await sendOrQueue(deviceId, sessionId, lastPrompt);
    } catch (error) {
      Alert.alert('Could not send', (error as Error).message);
    } finally {
      setRetrying(false);
    }
  };
  const action = lastPrompt && !bot ? { label: 'Retry', onPress: () => void retry(), loading: retrying } : undefined;
  const until = limited?.resetsAt ? `Resets at ${new Date(limited.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  const active = isActive(status);
  const notice = limited && (!limited.resetsAt || limited.resetsAt > now)
    ? { title: limited.text, body: until, tone: 'warning', action: undefined }
    : status === 'failed' && !active ? { title: 'This run failed', body: reason || 'The agent stopped with an error.', tone: 'danger', action }
    : status === 'stopped' && !active ? { title: 'Stopped', body: 'This run was stopped before it finished.', tone: 'warning', action }
    : null;
  return <Banner visible={!!notice} title={notice?.title ?? ''} body={notice?.body} tone={(notice?.tone ?? 'warning') as Tone} action={notice?.action} style={[styles.notice, { backgroundColor: colors.raised }]} />;
}

/** The run's one status, from the same state as the inbox's badge and clock; only this text ticks. */
function RunStatus({ deviceId, sessionId, since, waiting, activity }: { deviceId: string; sessionId: string; since: number; waiting: boolean; activity: string }) {
  const colors = useColors();
  const now = useNow(!waiting);
  const live = useConnect.getState().live[taskKey(deviceId, sessionId)];
  const stalled = waiting ? null : stalledFor(live?.lastEventAt ?? useConnect.getState().tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.lastEventAt, now);
  const needsLook = waiting || stalled !== null;
  const label = waiting ? 'Waiting on you' : stalled !== null ? `Stalled ${elapsedLabel(stalled)}` : `Working ${elapsedLabel(now - since)}`;
  return (
    <>
      <StatusDot tone={needsLook ? 'warning' : 'running'} pulse={!needsLook} />
      <CrossFadeText text={label} style={[textStyle.subheadMedium, styles.pillText, { color: needsLook ? colors.warning : colors.text }]} />
      {!waiting && !!activity && <View style={styles.pillActivity}><CrossFadeText text={activity} numberOfLines={1} style={[textStyle.footnote, { color: colors.muted }]} /></View>}
    </>
  );
}

/** The floating row above the composer: the run's status while running, and a jump to the newest message. */
const Floaters = memo(function Floaters({ deviceId, sessionId, running, waiting, team, away, onLatest }: { deviceId: string; sessionId: string; running: boolean; waiting: boolean; team: Team | null | 'outdated' | undefined; away: boolean; onLatest: () => void }) {
  const colors = useColors();
  // As the inbox: the run's start (a steer doesn't move it), else the newest prompt on hosts that don't send one.
  const since = useConnect(s => {
    const key = taskKey(deviceId, sessionId);
    return runClockStart(s.live[key], s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)) || s.messages[key]?.findLast(m => m.role === 'user')?.createdAt || 0;
  });
  const activity = useConnect(s => {
    const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
    return glanceOf(s.live[taskKey(deviceId, sessionId)], task, rowTeam(task, team)).activity;
  });
  if (!running && !away) return null;
  return (
    <View style={styles.floaters} pointerEvents="box-none">
      {running && (!!since || waiting) && (
        <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={styles.pillFrame}>
          <PillSurface>
            <RunStatus deviceId={deviceId} sessionId={sessionId} since={since} waiting={waiting} activity={activity} />
          </PillSurface>
        </Animated.View>
      )}
      {away && (
        <SpringIn>
          <Glass style={styles.latest} interactive>
            <PressScale onPress={onLatest} accessibilityLabel="Scroll to the newest message" hitSlop={6} style={styles.latestInner}>
              <Icon ios="chevron.down" android="expand_more" size={16} color={colors.text} />
            </PressScale>
          </Glass>
        </SpringIn>
      )}
    </View>
  );
});

/** A run ending on this screen: a haptic and a word for VoiceOver. A task that was already idle says nothing. */
function useRunEnded(running: boolean, status: string) {
  const was = useRef(running);
  useEffect(() => {
    if (was.current === running) return;
    was.current = running;
    if (running) return;
    if (status === 'failed') haptic('error');
    else if (status !== 'stopped') haptic('success');
    AccessibilityInfo.announceForAccessibility(status === 'failed' ? 'The run failed' : status === 'stopped' ? 'The run stopped' : 'The run finished');
  }, [running, status]);
}

export default function TaskScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
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
  const [dockHeight, setDockHeight] = useState(0);
  const [contentTop, setContentTop] = useState(0);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_ESTIMATE);
  const dockInset = Math.max(insets.bottom, 10);
  const { lift, settled: keyboard } = useKeyboardLift(dockInset);
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const { layout, reduced } = useMotion();
  const cardIn = reduced ? crossFadeIn : CARD_IN;
  const list = useRef<FlatList<TurnRow>>(null);
  const [away, setAway] = useState(false);
  const [latest] = useState(() => () => scrollToNewest(list.current));

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
  const waiting = requests || status === 'waiting';
  useRunEnded(running, status);
  // A gentle tap when a request arrives while the thread is open; one already waiting at open is just there.
  const requestCount = approvals.length + inputs.length;
  const seenRequests = useRef(requestCount);
  useEffect(() => {
    if (requestCount > seenRequests.current) haptic('light');
    seenRequests.current = requestCount;
  }, [requestCount]);
  const settledStatus = useConnect(s => (liveStatus !== 'idle' ? liveStatus : s.tasks[device]?.tasks.find(t => t.sessionId === session)?.status ?? 'idle'));
  // What the transcript keeps clear: from the top of the highest thing in the dock to the screen's bottom.
  const bottom = dockHeight && dockHeight - contentTop;
  // Request cards scroll in whatever the window leaves between the header and the composer.
  const requestsMax = Math.max(MIN_REQUESTS, windowHeight - keyboard - header - composerHeight - FLOATER_ROW * Math.max(1, fontScale));
  return (
    <WorkerNamesContext.Provider value={names}>
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {/* Both this and the marker in Transcript: which one reaches the list depends on the screen's first child, and the other side's default would turn the effect back on. */}
      <Stack.Screen options={{ scrollEdgeEffects: NO_EDGE_EFFECTS }} />
      <TaskHeader deviceId={device} sessionId={session} title={task?.title || 'Task'} pull={pull} agents={agents} bot={bot} quiet={running || requests} />
      {/* Side insets: the iPhone Duo's rail, or a landscape notch. */}
      <View style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        {/* The list moves with the keyboard as one; only its far end needs the extra room, so that can wait for React. */}
        <Animated.View style={[styles.screen, lift]}>
          <Transcript key={key} deviceId={device} sessionId={session} top={(hasGlass ? header : 0) + 12 + keyboard} bottom={bottom + 12} listRef={list} onAway={setAway} />
        </Animated.View>
        <HeaderBlur height={header} />
        <DockFade height={dockInset + DOCK_FADE} />
        {/* Bottom-anchored in a full-height frame, so anything growing below moves what's above with a layout transition. */}
        <Animated.View style={[styles.dock, { left: insets.left, right: insets.right }, lift]} onLayout={e => setDockHeight(e.nativeEvent.layout.height)} pointerEvents="box-none">
          <Animated.View layout={layout} onLayout={e => setContentTop(e.nativeEvent.layout.y)} pointerEvents="box-none">
            <Floaters deviceId={device} sessionId={session} running={running && !requests} waiting={waiting} team={team} away={away} onLatest={latest} />
          </Animated.View>
          <Animated.View layout={layout}>
            <RunNotice deviceId={device} sessionId={session} status={running ? 'running' : settledStatus} bot={!!bot} />
          </Animated.View>
          {requests && (
            <Animated.View layout={layout} entering={cardIn} exiting={crossFadeOut}>
              <ScrollView style={[styles.requests, { maxHeight: requestsMax }]} contentContainerStyle={styles.requestList} keyboardShouldPersistTaps="handled">
                {approvals.map(r => <Animated.View key={r.requestId} layout={layout} entering={cardIn} exiting={crossFadeOut}><ApprovalCard deviceId={device} sessionId={session} request={r} /></Animated.View>)}
                {inputs.map(r => <Animated.View key={r.requestId} layout={layout} entering={cardIn} exiting={crossFadeOut}><InputCard deviceId={device} sessionId={session} request={r} /></Animated.View>)}
              </ScrollView>
            </Animated.View>
          )}
          <Animated.View layout={layout} style={{ paddingBottom: dockInset }} onLayout={e => setComposerHeight(e.nativeEvent.layout.height)}>
            <Composer key={key} deviceId={device} sessionId={session} running={running} waiting={waiting} bot={bot} />
          </Animated.View>
        </Animated.View>
      </View>
    </View>
    </WorkerNamesContext.Provider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dock: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'flex-end' },
  requests: { flexGrow: 0 },
  notice: { marginHorizontal: geometry.screenMargin, marginBottom: 8 },
  requestList: { gap: 8, paddingBottom: 8 },
  floaters: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingBottom: 8, paddingHorizontal: geometry.screenMargin },
  pillFrame: { flexShrink: 1 },
  // A minimum, not a height: the words grow with Dynamic Type.
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6, borderCurve: 'continuous' },
  pillText: { fontVariant: ['tabular-nums'] },
  pillActivity: { flexShrink: 1 },
  latest: { width: 36, height: 36, borderRadius: 18 },
  latestInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
