// Transcript rows. Stored messages are grouped into turns (src/store/turns.ts) and render once
// each; the live run is its own component reading useLive, so streamed deltas re-render only it.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { memo, useCallback, useEffect, useMemo, useState, type Ref } from 'react';
import { markPaint } from '../connect/perf.ts';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { Message } from '../connect/types.ts';
import { connect } from '../connect/client.ts';
import { taskKey, useConnect, useHistory, useLive, useLoaded, useMessages, useOlder, useSent, type LiveItem } from '../store/index.ts';
import type { Sent } from '../store/sent.ts';
import { removeOutbox, retryOutbox, useLocal } from '../store/local.ts';
import { duration, turnRows, type TurnRow } from '../store/turns.ts';
import { bubbleAttachments } from '../store/attachments.ts';
import { Chips, ImageGrid, ThreadContext } from './Attachments.tsx';
import { ImageViewerHost } from './ImageViewer.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { showActions } from './Menu.tsx';
import { glanceOf } from '../store/inbox.ts';
import { groupRuns, parseToolMessage } from '../store/trace.ts';
import { PlanCard, SubagentPanel, ThinkingLine, ToolGroup } from './Trace.tsx';
import { mono, useColors } from './theme.ts';

// Same blocks the desktop folds behind a user message (CONTEXT_BOUNDARY in src/main.ts).
const CONTEXT_BOUNDARY = /\n\n(?=(?:File|Document|Folder|GitHub|Browser element) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Response style \(PandaCode token saver)/;
/** How far from the newest message (pt) before the jump-to-latest button shows. */
const AWAY = 240;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function copy(text: string) {
  void Clipboard.setStringAsync(text);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

function Meta({ text, at, align }: { text: string; at: number; align: 'left' | 'right' }) {
  const colors = useColors();
  const copyButton = (
    <Pressable onPress={() => copy(text)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Copy">
      <Icon ios="doc.on.doc" android="content_copy" size={13} color={colors.tertiary} />
    </Pressable>
  );
  const time = <Text style={[styles.time, { color: colors.tertiary }]}>{clock(at)}</Text>;
  return <View style={[styles.meta, align === 'right' && styles.metaRight]}>{align === 'right' ? <>{time}{copyButton}</> : <>{copyButton}{time}</>}</View>;
}

function UserBubble({ message }: { message: Message }) {
  const colors = useColors();
  const [showContext, setShowContext] = useState(false);
  const content = message.content;
  const cut = content.search(CONTEXT_BOUNDARY);
  const prompt = cut < 0 ? content : content.slice(0, cut);
  const files = useMemo(() => bubbleAttachments(message.attachments, cut < 0 ? '' : content.slice(cut)), [message.attachments, content, cut]);
  const steeredAt = useLocal(s => s.steers[prompt.trim()]);
  return (
    <View style={styles.userTurn}>
      <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
        <ImageGrid images={files.images} />
        {!!prompt && <Text selectable style={[styles.userText, { color: colors.text }]}>{prompt}</Text>}
        <Chips chips={files.chips} />
        {cut >= 0 && (
          <Pressable onPress={() => setShowContext(s => !s)} accessibilityRole="button">
            <Text style={[styles.context, { color: colors.secondary }]}>{showContext ? content.slice(cut + 2) : 'Attached context'}</Text>
          </Pressable>
        )}
      </View>
      {steeredAt != null && (
        <View style={[styles.meta, styles.metaRight]}>
          <Icon ios="arrow.uturn.right" android="alt_route" size={11} color={colors.secondary} />
          <Text style={[styles.time, { color: colors.secondary }]}>Steer · {clock(steeredAt)}</Text>
        </View>
      )}
      <Meta text={prompt} at={message.createdAt} align="right" />
    </View>
  );
}

function WorkRow({ steps, durationMs }: { steps: Message[]; durationMs: number | null }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const tools = steps.filter(s => s.role === 'tool').length;
  const label = durationMs != null ? `Worked for ${duration(durationMs)}` : `${tools} step${tools === 1 ? '' : 's'}`;
  return (
    <View style={styles.work}>
      <Pressable onPress={() => setOpen(o => !o)} disabled={!steps.length} style={styles.workHead} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={6}>
        <Text style={[styles.workText, { color: colors.secondary }]}>{label}</Text>
        {steps.length > 0 && <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={11} color={colors.secondary} />}
      </Pressable>
      {open && <Steps steps={steps} />}
    </View>
  );
}

/** A stored turn's steps: tool calls grouped as on the desktop, interim notes between them. Parsed once per open. */
function Steps({ steps }: { steps: Message[] }) {
  const colors = useColors();
  const runs = useMemo(() => groupRuns(steps.map(m => (m.role === 'tool' ? { id: m.id, tool: parseToolMessage(m.content) } : { id: m.id, text: m.content })), e => 'tool' in e), [steps]);
  // One group opens with its turn; several stay folded behind their summaries.
  const single = runs.filter(r => r.kind === 'tools').length === 1;
  return (
    <View style={[styles.steps, { borderColor: colors.separator }]}>
      {runs.map(run => (run.kind === 'tools'
        ? <ToolGroup key={run.items[0].id} items={run.items as { tool: ReturnType<typeof parseToolMessage> }[]} initiallyOpen={single} />
        : <Text key={run.item.id} style={[styles.interim, { color: colors.secondary }]} numberOfLines={6}>{'text' in run.item ? plain(run.item.text) : ''}</Text>))}
    </View>
  );
}

const Row = memo(function Row({ row }: { row: TurnRow }) {
  const colors = useColors();
  switch (row.kind) {
    case 'user': return <UserBubble message={row.message} />;
    case 'work': return <WorkRow steps={row.steps} durationMs={row.durationMs} />;
    case 'reply': return (
      <View style={styles.reply}>
        <Markdown text={row.message.content} />
        <Meta text={row.message.content} at={row.message.createdAt} align="left" />
      </View>
    );
    default: return <Text style={[styles.note, { color: row.message.role === 'error' ? colors.red : colors.secondary }]}>{row.message.content}</Text>;
  }
});

/** Messages waiting in the outbox for this task. */
function Pending({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const colors = useColors();
  const outbox = useLocal(s => s.outbox);
  const entries = useMemo(() => outbox.filter(e => e.deviceId === deviceId && e.sessionId === sessionId), [outbox, deviceId, sessionId]);
  if (!entries.length) return null;
  return (
    <>
      {entries.map(entry => {
        const menu = () => showActions(entry.error ?? 'This message sends when the computer is back.', [
          { label: 'Send now', ios: 'arrow.up.circle', android: 'send', onPress: () => retryOutbox(entry.id) },
          { label: 'Copy', ios: 'doc.on.doc', android: 'content_copy', onPress: () => copy(entry.text) },
          { label: 'Delete', ios: 'trash', android: 'delete', destructive: true, onPress: () => removeOutbox(entry.id) },
        ]);
        return (
          <Pressable key={entry.id} onPress={menu} onLongPress={menu} style={styles.userTurn} accessibilityRole="button" accessibilityHint="Retry or delete">
            <View style={[styles.bubble, styles.pending, { backgroundColor: colors.bubble, borderColor: entry.error ? colors.red : colors.separator }]}>
              <Text style={[styles.userText, { color: colors.text }]}>{entry.text}</Text>
            </View>
            <View style={[styles.meta, styles.metaRight]}>
              <Icon ios={entry.error ? 'exclamationmark.circle' : 'clock.arrow.circlepath'} android={entry.error ? 'error' : 'schedule_send'} size={12} color={entry.error ? colors.red : colors.orange} />
              <Text style={[styles.time, { color: entry.error ? colors.red : colors.orange }]} numberOfLines={1}>{entry.error ? 'Not sent · tap to retry' : 'Sends on reconnect'}</Text>
            </View>
          </Pressable>
        );
      })}
    </>
  );
}

const SENT_LABEL: Record<Sent['state'], string> = { sending: 'Sending…', steering: 'Steer · Sending…', queued: 'Queued' };

/** Prompts sent from this phone, shown at once until the stored copy replaces them: the ones
 * starting a turn above the live run (`before`), steers and queued ones after it. */
function SentBubbles({ deviceId, sessionId, before }: { deviceId: string; sessionId: string; before: boolean }) {
  const colors = useColors();
  const sent = useSent(deviceId, sessionId);
  const shown = sent.filter(e => (e.state === 'sending') === before);
  if (!shown.length) return null;
  return (
    <>
      {shown.map(entry => (
        <View key={entry.id} style={styles.userTurn} accessible accessibilityLabel={`${entry.text}, ${SENT_LABEL[entry.state]}`}>
          <View style={[styles.bubble, styles.sending, { backgroundColor: colors.bubble }]}>
            <Text style={[styles.userText, { color: colors.text }]}>{entry.text}</Text>
          </View>
          <View style={[styles.meta, styles.metaRight]}>
            {entry.state === 'steering' && <Icon ios="arrow.uturn.right" android="alt_route" size={11} color={colors.secondary} />}
            {entry.state === 'queued' && <Icon ios="clock" android="schedule" size={11} color={colors.secondary} />}
            <Text style={[styles.time, { color: colors.secondary }]}>{SENT_LABEL[entry.state]}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

/** The in-flight run: the plan, subagent panels, the turn's tools grouped (the newest group open),
 * streamed text, and a compact Working row. Rows are memoized, so an event re-renders only what it changed. */
const LiveRun = memo(function LiveRun({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const colors = useColors();
  const live = useLive(deviceId, sessionId);
  // A copy made mid-run can already hold the segment still streaming here; show it once.
  const stored = useConnect(s => {
    const last = s.messages[taskKey(deviceId, sessionId)]?.at(-1);
    return last?.role === 'assistant' ? last.content : '';
  });
  const lastText = live.items.findLastIndex(i => i.kind === 'text');
  const earlier = useMemo(() => groupRuns(live.items.filter((_, i) => i !== lastText), i => i.kind === 'tool'), [live.items, lastText]);
  if (live.status !== 'running' && live.status !== 'waiting' && !live.limited) return null;
  const streamed = lastText >= 0 ? (live.items[lastText] as Extract<LiveItem, { kind: 'text' }>).text : '';
  const text = streamed.trim() && stored.includes(streamed.trim()) ? '' : streamed;
  const lastGroup = earlier.findLastIndex(r => r.kind === 'tools');
  const current = glanceOf(live).activity || live.activity;
  return (
    <View>
      {!!live.todos?.length && <PlanCard todos={live.todos} />}
      {live.subagents?.map(agent => <SubagentPanel key={agent.id} agent={agent} />)}
      {earlier.length > 0 && (
        <View style={[styles.steps, { borderColor: colors.separator }]}>
          {earlier.map((run, i) => (run.kind === 'tools'
            ? <ToolGroup key={toolKey(run.items[0], i)} items={run.items as Extract<LiveItem, { kind: 'tool' }>[]} initiallyOpen={i === lastGroup} />
            : <Text key={i} style={[styles.interim, { color: run.item.kind === 'error' ? colors.red : colors.secondary }]} numberOfLines={6}>{'text' in run.item ? plain(run.item.text) : ''}</Text>))}
        </View>
      )}
      {!!live.thinking && !text && <ThinkingLine text={live.thinking} />}
      {!!text && <View style={styles.reply}><Markdown text={text} streaming /></View>}
      {!!live.limited && <Text style={[styles.note, { color: colors.orange }]}>{live.limited.text}</Text>}
      {live.status === 'running' && (
        <View style={styles.activity}>
          <ActivityIndicator size="small" style={styles.small} />
          <Text style={[styles.workText, { color: colors.secondary }]}>Working…</Text>
          {!!current && current !== 'Working…' && <Text style={[styles.current, { color: colors.tertiary }]} numberOfLines={1}>{current}</Text>}
        </View>
      )}
    </View>
  );
});

/** An interim note on one quiet line: Markdown emphasis and code marks dropped. */
const plain = (text = '') => text.replace(/\*\*|__|`/g, '');

const toolKey = (item: LiveItem, i: number) => (item.kind === 'tool' && item.tool.id ? item.tool.id : `g${i}`);

/** Grey bubbles in the shape of a transcript, while a thread with nothing cached loads. */
function Skeleton() {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel="Loading messages" style={styles.skeleton}>
      {SKELETON.map((width, i) => <View key={i} style={[styles.bone, i % 2 ? styles.boneReply : styles.boneUser, { width, backgroundColor: colors.fill }]} />)}
    </View>
  );
}
const SKELETON = ['62%', '88%', '48%', '80%'] as const;

/** The message copy: a skeleton until anything (cached or fetched) shows, then nothing while it
 * refreshes; a failure with Retry ("Couldn't refresh" over cached or older messages). */
function History({ deviceId, sessionId, empty }: { deviceId: string; sessionId: string; empty: boolean }) {
  const colors = useColors();
  const history = useHistory(deviceId, sessionId);
  const loaded = useLoaded(deviceId, sessionId);
  if (typeof history !== 'string') return empty && !loaded ? <Skeleton /> : null;
  return (
    <View style={styles.failed}>
      <Icon ios="exclamationmark.circle" android="error" size={14} color={colors.red} />
      <Text style={[styles.failedText, { color: colors.red }]} numberOfLines={3}>{empty ? `Couldn't load this task: ${history}` : `Couldn't refresh: ${history}`}</Text>
      <Pressable onPress={() => connect.loadMessages(deviceId, sessionId).catch(() => undefined)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry loading messages">
        <Text style={[styles.retry, { color: colors.tint }]}>Retry</Text>
      </Pressable>
    </View>
  );
}

/** Above the oldest message: a spinner while an older page loads. */
function Older({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const colors = useColors();
  if (useOlder(deviceId, sessionId) !== 'loading') return null;
  return (
    <View style={[styles.activity, styles.older]} accessibilityLabel="Loading older messages">
      <ActivityIndicator size="small" style={styles.small} />
      <Text style={[styles.workText, { color: colors.secondary }]}>Loading older messages…</Text>
    </View>
  );
}

const key = (row: TurnRow) => row.id;
const ANCHOR = { minIndexForVisible: 0, autoscrollToTopThreshold: AWAY };
const render = ({ item }: { item: TurnRow }) => <Row row={item} />;

/** Inverted list: newest at the bottom, the live run and unsent messages below the last stored message.
 * `onAway` hears only when the list crosses AWAY from the newest message. */
export const Transcript = memo(function Transcript({ deviceId, sessionId, top, bottom, listRef, onAway }: {
  deviceId: string; sessionId: string; top: number; bottom: number; listRef?: Ref<FlatList<TurnRow>>; onAway?: (away: boolean) => void;
}) {
  const messages = useMessages(deviceId, sessionId);
  const data = useMemo(() => turnRows(messages).reverse(), [messages]);
  useEffect(() => { if (data.length) markPaint(taskKey(deviceId, sessionId), data.length); }, [data.length, deviceId, sessionId]);
  // Inverted: the end is the top, so this asks for older history as the user nears it.
  const onEndReached = useCallback(() => void connect.loadOlder(deviceId, sessionId), [deviceId, sessionId]);
  const onScroll = useMemo(() => {
    if (!onAway) return undefined;
    let away = false;
    return (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = e.nativeEvent.contentOffset.y > AWAY;
      if (next !== away) onAway((away = next));
    };
  }, [onAway]);
  const thread = useMemo(() => ({ deviceId, sessionId }), [deviceId, sessionId]);
  return (
    <ThreadContext.Provider value={thread}>
    <ImageViewerHost />
    <FlatList
      ref={listRef}
      inverted
      data={data}
      keyExtractor={key}
      renderItem={render}
      ListHeaderComponent={<><History deviceId={deviceId} sessionId={sessionId} empty={!messages.length} /><SentBubbles deviceId={deviceId} sessionId={sessionId} before /><LiveRun deviceId={deviceId} sessionId={sessionId} /><SentBubbles deviceId={deviceId} sessionId={sessionId} before={false} /><Pending deviceId={deviceId} sessionId={sessionId} /></>}
      ListFooterComponent={<Older deviceId={deviceId} sessionId={sessionId} />}
      onEndReached={onEndReached}
      onEndReachedThreshold={1}
      // New messages arriving while the user reads further up don't move what they read; near the
      // newest message the list follows it.
      maintainVisibleContentPosition={ANCHOR}
      contentContainerStyle={[styles.list, { paddingTop: bottom, paddingBottom: top }]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={100}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      windowSize={9}
      removeClippedSubviews
    />
    </ThreadContext.Provider>
  );
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: 18 },
  userTurn: { alignItems: 'flex-end', marginTop: 18, marginBottom: 6 },
  bubble: { maxWidth: '85%', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 11, borderCurve: 'continuous' },
  sending: { opacity: 0.6 },
  pending: { borderWidth: 1, borderStyle: 'dashed', opacity: 0.85 },
  userText: { fontSize: 16, lineHeight: 22 },
  context: { fontSize: 13, marginTop: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6, paddingHorizontal: 4 },
  metaRight: { justifyContent: 'flex-end', gap: 6 },
  time: { fontSize: 12 },
  reply: { marginVertical: 4 },
  work: { marginTop: 8, marginBottom: 4 },
  workHead: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingVertical: 4 },
  workText: { fontSize: 14, fontWeight: '500' },
  steps: { borderLeftWidth: 2, paddingLeft: 12, marginLeft: 2, marginTop: 4, gap: 2 },
  interim: { fontSize: 13, lineHeight: 18, marginVertical: 3 },
  note: { fontSize: 14, marginVertical: 6 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failedText: { flex: 1, fontSize: 14 },
  retry: { fontSize: 15, fontWeight: '600' },
  current: { flex: 1, fontSize: 12, fontFamily: mono },
  small: { transform: [{ scale: 0.8 }] },
  older: { justifyContent: 'center' },
  skeleton: { gap: 14, marginVertical: 18 },
  bone: { height: 44, borderRadius: 22, borderCurve: 'continuous' },
  boneUser: { alignSelf: 'flex-end', maxWidth: '75%' },
  boneReply: { alignSelf: 'flex-start', height: 72, borderRadius: 16 },
});
