// The transcript list. Stored messages are grouped into turns (src/store/turns.ts) and render once
// each (rows in transcript-rows.tsx); the live run is its own component reading useLive, so streamed
// deltas re-render only it.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { markPaint } from '../connect/perf.ts';
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { connect, useOlderFailed } from '../connect/client.ts';
import { taskKey, useConnect, useHistory, useLoaded, useMessages, useOlder } from '../store/index.ts';
import { useLocal } from '../store/local.ts';
import { reuseRows, turnRows, type TurnRow } from '../store/turns.ts';
import { ThreadContext } from './Attachments.tsx';
import { useColors } from './theme.ts';
import { Button, EmptyState, geometry, Skeleton as Bone, type as textStyle } from './ds/index.ts';
import { ImageViewerHost } from './ImageViewer.tsx';
import { Icon } from './Icon.tsx';
import { FreshContext, IOS_27, LiveRun, Pending, Row, SentBubbles } from './transcript-rows.tsx';

/** How far from the newest message (pt) before the jump-to-latest button shows. */
const AWAY = 240;

/** Placeholders in the shape of a transcript, while a thread with nothing cached loads. */
function Skeleton() {
  return (
    <View accessible accessibilityLabel="Loading messages" style={styles.skeleton}>
      <Bone width="62%" height={44} radius={geometry.innerRadius} style={styles.boneUser} />
      <Bone width="88%" height={14} />
      <Bone width="74%" height={14} />
      <Bone width="48%" height={44} radius={geometry.innerRadius} style={styles.boneUser} />
      <Bone width="80%" height={14} />
      <Bone width="56%" height={14} />
    </View>
  );
}

/** The message copy: a skeleton until anything (cached or fetched) shows, then nothing while it
 * refreshes; a failure with Retry ("Couldn't refresh" over cached or older messages). */
function History({ deviceId, sessionId, empty }: { deviceId: string; sessionId: string; empty: boolean }) {
  const colors = useColors();
  const history = useHistory(deviceId, sessionId);
  const loaded = useLoaded(deviceId, sessionId);
  // A thread that really has nothing, and nothing on the way.
  const outboxed = useLocal(s => s.outbox.some(e => e.deviceId === deviceId && e.sessionId === sessionId));
  const quiet = useConnect(s => {
    const key = taskKey(deviceId, sessionId);
    const liveStatus = s.live[key]?.status;
    return !s.sent[key]?.length && liveStatus !== 'running' && liveStatus !== 'waiting';
  }) && !outboxed;
  if (typeof history !== 'string') {
    if (!empty) return null;
    if (!loaded) return <Skeleton />;
    return quiet ? <EmptyState icon={{ ios: 'bubble.left.and.text.bubble.right', android: 'forum' }} title="No messages yet" body="Send a message and the agent's work shows up here." /> : null;
  }
  return (
    <View style={styles.failed}>
      <Icon ios="exclamationmark.circle" android="error" size={14} color={colors.danger} />
      <Text style={[textStyle.subhead, styles.failedText, { color: colors.danger }]} numberOfLines={3}>{empty ? `Couldn't load this task: ${history}` : `Couldn't refresh: ${history}`}</Text>
      <Button label="Retry" size="small" accessibilityLabel="Retry loading messages" onPress={() => connect.loadMessages(deviceId, sessionId).catch(() => undefined)} />
    </View>
  );
}

/** Above the oldest message: a spinner while an older page loads, or the failure with Retry. */
function Older({ deviceId, sessionId, onRetry }: { deviceId: string; sessionId: string; onRetry: () => void }) {
  const colors = useColors();
  const older = useOlder(deviceId, sessionId);
  const failed = useOlderFailed(s => !!s[taskKey(deviceId, sessionId)]);
  if (failed && older !== 'loading') {
    return (
      <View style={styles.failed}>
        <Icon ios="exclamationmark.circle" android="error" size={14} color={colors.danger} />
        <Text style={[textStyle.subhead, styles.failedText, { color: colors.danger }]}>Couldn&apos;t load older messages</Text>
        <Button label="Retry" size="small" accessibilityLabel="Retry loading older messages" onPress={onRetry} />
      </View>
    );
  }
  if (older !== 'loading') return null;
  return (
    <View style={[styles.activity, styles.older]} accessibilityLabel="Loading older messages">
      <ActivityIndicator size="small" style={styles.small} />
      <Text style={[textStyle.subhead, { color: colors.muted }]}>Loading older messages…</Text>
    </View>
  );
}

/** iOS's scroll edge effect, sized from the flipped list, blurs and dims the transcript as soon as it can
 * scroll (always with the keyboard up, which adds room). Off from both ends: this marker, and the Stack option
 * in the task screen. Either one's default would turn it back on if the other were the only one set. */
type Marker = typeof import('react-native-screens/src/components/gamma/scroll-view-marker/ScrollViewMarker').ScrollViewMarker;
/** A private path in react-native-screens 4.30.0 (pinned), loaded on iOS only. If an upgrade moves it, the
 * list just goes without the marker (the Stack option in the task screen still covers the usual case). */
const ScrollViewMarker: Marker | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('react-native-screens/src/components/gamma/scroll-view-marker/ScrollViewMarker') as { ScrollViewMarker?: Marker }).ScrollViewMarker ?? null;
  } catch {
    return null;
  }
})();
export const NO_EDGE_EFFECTS = { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' } as const;

const key = (row: TurnRow) => row.id;
/** Enough of the chronological list drawn at once that following to its end takes few passes. */
const CHRONOLOGICAL_FIRST_RENDER = 30;
const ANCHOR = { minIndexForVisible: 0, autoscrollToTopThreshold: AWAY };
// autoscrollToTopThreshold scrolls to offset 0, the oldest row in the chronological list; following
// the newest is done by hand there (Transcript). minIndexForVisible skips the Older header by itself.
const CHRONOLOGICAL_ANCHOR = { minIndexForVisible: 0 };
const render = ({ item }: { item: TurnRow }) => <Row row={item} />;

/** Jumps to the newest message: offset 0 in the inverted list, the end of the chronological one.
 * The scroll view's own scrollToEnd, because FlatList's leaves out the padding that clears the composer. */
export function scrollToNewest(list: FlatList<TurnRow> | null, animated = true) {
  if (IOS_27) list?.getNativeScrollRef()?.scrollToEnd({ animated });
  else list?.scrollToOffset({ offset: 0, animated });
}

/** Newest at the bottom, the live run and unsent messages below the last stored message: an inverted
 * list, or on iOS 27 a chronological one (IOS_27). `onAway` hears only when the list crosses AWAY from the newest message. */
export const Transcript = memo(function Transcript({ deviceId, sessionId, top, bottom, listRef, onAway }: {
  deviceId: string; sessionId: string; top: number; bottom: number; listRef?: RefObject<FlatList<TurnRow> | null>; onAway?: (away: boolean) => void;
}) {
  const messages = useMessages(deviceId, sessionId);
  const ownRef = useRef<FlatList<TurnRow>>(null);
  const list = listRef ?? ownRef;
  // What an inverted list gets for free, on iOS 27's chronological one: it opens at the newest message
  // and stays there as rows, the live run or the composer inset change, until the reader scrolls away.
  const following = useRef(true);
  const held = useRef(false); // A finger or momentum owns the scroll: don't pull it back.
  const wasAway = useRef(false);
  // iOS 27 only: the list starts at offset 0, its oldest row, on the way to the newest. Until the first
  // drag that position means nothing: it must not ask for older pages or count as reading away.
  const dragged = useRef(false);
  // Unchanged rows keep their objects across refetches, so memo(Row) holds.
  const [turns, setTurns] = useState<{ messages: typeof messages | null; rows: TurnRow[] }>({ messages: null, rows: [] });
  let rows = turns.rows;
  if (turns.messages !== messages) {
    rows = reuseRows(turns.rows, turnRows(messages));
    setTurns({ messages, rows });
  }
  // The failed banner over the composer carries the last error, so it isn't drawn twice.
  const failed = useConnect(s => s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.status === 'failed' && (s.live[taskKey(deviceId, sessionId)]?.status ?? 'idle') === 'idle');
  const data = useMemo(() => {
    const last = rows.at(-1);
    const shown = failed && last?.kind === 'note' && last.message.role === 'error' ? rows.slice(0, -1) : rows;
    return IOS_27 ? shown : [...shown].reverse();
  }, [rows, failed]);
  useEffect(() => { if (data.length) markPaint(taskKey(deviceId, sessionId), data.length); }, [data.length, deviceId, sessionId]);
  // Asks for older history as the user nears the top: the inverted list's end, the other's start.
  const onOlder = useCallback(() => void connect.loadOlder(deviceId, sessionId), [deviceId, sessionId]);
  const onStartReached = useCallback(() => { if (dragged.current) onOlder(); }, [onOlder]);
  // New since the thread drew: fixed by the first non-empty page, so older pages and the first draw never animate.
  const [drawnTo, setDrawnTo] = useState<number | null>(null);
  if (drawnTo === null && messages.length) setDrawnTo(messages[messages.length - 1].id);
  const [entered] = useState(() => new Set<string>());
  const fresh = useMemo(() => (drawnTo === null ? null : { newest: drawnTo, entered }), [drawnTo, entered]);
  const onScroll = useCallback(({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (IOS_27 && !dragged.current) return;
    const away = IOS_27 ? contentOffset.y < contentSize.height - layoutMeasurement.height - AWAY : contentOffset.y > AWAY;
    following.current = !away;
    if (away === wasAway.current) return;
    wasAway.current = away;
    onAway?.(away);
  }, [onAway]);
  const thread = useMemo(() => ({ deviceId, sessionId }), [deviceId, sessionId]);
  const older = <Older deviceId={deviceId} sessionId={sessionId} onRetry={onOlder} />;
  const newest = <><History deviceId={deviceId} sessionId={sessionId} empty={!messages.length} /><SentBubbles deviceId={deviceId} sessionId={sessionId} before /><LiveRun deviceId={deviceId} sessionId={sessionId} /><SentBubbles deviceId={deviceId} sessionId={sessionId} before={false} /><Pending deviceId={deviceId} sessionId={sessionId} /></>;
  const direction = IOS_27 ? {
    ListHeaderComponent: older,
    ListFooterComponent: newest,
    onStartReached,
    onStartReachedThreshold: 1,
    maintainVisibleContentPosition: CHRONOLOGICAL_ANCHOR,
    contentContainerStyle: [styles.list, { paddingTop: top, paddingBottom: bottom }],
    onContentSizeChange: () => { if (following.current && !held.current) scrollToNewest(list.current, false); },
    onScrollBeginDrag: () => { held.current = true; dragged.current = true; },
    onScrollEndDrag: () => { held.current = false; },
    onMomentumScrollBegin: () => { held.current = true; },
    onMomentumScrollEnd: () => { held.current = false; },
  } : {
    inverted: true,
    ListHeaderComponent: newest,
    ListFooterComponent: older,
    onEndReached: onOlder,
    onEndReachedThreshold: 1,
    // New messages arriving while the user reads further up don't move what they read; near the
    // newest message the list follows it.
    maintainVisibleContentPosition: ANCHOR,
    contentContainerStyle: [styles.list, { paddingTop: bottom, paddingBottom: top }],
  };
  const listView = (
    <FlatList
      ref={list}
      data={data}
      keyExtractor={key}
      renderItem={render}
      {...direction}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={100}
      initialNumToRender={IOS_27 ? CHRONOLOGICAL_FIRST_RENDER : 10}
      maxToRenderPerBatch={8}
      windowSize={9}
      // Off on Android, where clipping an inverted list leaves blank rows; off on iOS 27's chronological one too.
      removeClippedSubviews={Platform.OS === 'ios' && !IOS_27}
    />
  );
  return (
    <ThreadContext.Provider value={thread}>
    <FreshContext.Provider value={fresh}>
    <ImageViewerHost />
    {ScrollViewMarker ? <ScrollViewMarker scrollEdgeEffects={NO_EDGE_EFFECTS} style={styles.fill}>{listView}</ScrollViewMarker> : listView}
    </FreshContext.Provider>
    </ThreadContext.Provider>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: geometry.screenMargin },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failedText: { flex: 1 },
  small: { transform: [{ scale: 0.8 }] },
  older: { justifyContent: 'center' },
  skeleton: { gap: 12, marginVertical: 18 },
  boneUser: { alignSelf: 'flex-end' },
});
