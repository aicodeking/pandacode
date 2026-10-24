// Transcript rows. Stored messages are grouped into turns (src/store/turns.ts) and render once
// each; the live run is its own component reading useLive, so streamed deltas re-render only it.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { memo, useMemo, useState, type Ref } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { Message, ToolActivity } from '../connect/types.ts';
import { connect } from '../connect/client.ts';
import { taskKey, useConnect, useHistory, useLive, useMessages, type LiveItem } from '../store/index.ts';
import { removeOutbox, retryOutbox, useLocal } from '../store/local.ts';
import { attachments, duration, turnRows, type TurnRow } from '../store/turns.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { showActions } from './Menu.tsx';
import { mono, useColors } from './theme.ts';

// Same blocks the desktop folds behind a user message (CONTEXT_BOUNDARY in src/main.ts).
const CONTEXT_BOUNDARY = /\n\n(?=(?:File|Document|Folder|GitHub|Browser element) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Response style \(PandaCode token saver)/;
const MAX_OUTPUT = 6000;
/** How far from the newest message (pt) before the jump-to-latest button shows. */
const AWAY = 240;

const attachmentIcon = (kind: string) =>
  kind.startsWith('Attached') ? ['photo', 'image'] as const : kind === 'Folder context' ? ['folder', 'folder'] as const : ['doc', 'description'] as const;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function parseTool(content: string): ToolActivity {
  try {
    const t = JSON.parse(content);
    return { id: '', name: String(t.name ?? t.title ?? 'Tool'), status: t.status === 'failed' ? 'failed' : t.status === 'running' ? 'running' : 'completed', input: String(t.input ?? ''), output: String(t.output ?? '') };
  } catch {
    return { id: '', name: 'Tool', status: 'completed', input: '', output: content };
  }
}

const TOOL_ICONS: Record<string, [Parameters<typeof Icon>[0]['ios'], Parameters<typeof Icon>[0]['android']]> = {
  read: ['doc.text', 'description'], write: ['square.and.pencil', 'edit_document'], edit: ['pencil', 'edit'],
  bash: ['terminal', 'terminal'], grep: ['magnifyingglass', 'search'], glob: ['folder', 'folder'], web: ['globe', 'public'],
};
const toolIcon = (name: string) => TOOL_ICONS[Object.keys(TOOL_ICONS).find(k => name.toLowerCase().includes(k)) ?? ''] ?? ['wrench.and.screwdriver', 'build'] as const;

export const ToolRow = memo(function ToolRow({ tool }: { tool: ToolActivity }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const summary = tool.input.split('\n', 1)[0].slice(0, 120);
  const color = tool.status === 'failed' ? colors.red : colors.secondary;
  const [ios, android] = tool.status === 'failed' ? ['xmark.circle', 'cancel'] as const : toolIcon(tool.name);
  return (
    <Pressable onPress={() => setOpen(o => !o)} style={styles.tool} accessibilityRole="button" accessibilityLabel={`${tool.name} ${tool.status}`} accessibilityState={{ expanded: open }}>
      <View style={styles.toolHead}>
        {tool.status === 'running' ? <ActivityIndicator size="small" style={styles.small} /> : <Icon ios={ios} android={android} size={13} color={color} />}
        <Text style={[styles.toolName, { color }]} numberOfLines={1}>{tool.name}<Text style={{ color: colors.tertiary }}>{summary ? `  ${summary}` : ''}</Text></Text>
      </View>
      {open && (
        <View style={[styles.toolBody, { backgroundColor: colors.fill }]}>
          {!!tool.input && <Code text={tool.input} />}
          {!!tool.output && <Code text={tool.output} />}
        </View>
      )}
    </Pressable>
  );
});

function Code({ text }: { text: string }) {
  const colors = useColors();
  const shown = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text selectable style={[styles.code, { color: colors.text }]}>{shown}</Text>
    </ScrollView>
  );
}

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
  const files = useMemo(() => (cut < 0 ? [] : attachments(content.slice(cut))), [content, cut]);
  const steeredAt = useLocal(s => s.steers[prompt.trim()]);
  return (
    <View style={styles.userTurn}>
      <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
        <Text selectable style={[styles.userText, { color: colors.text }]}>{prompt}</Text>
        {files.length > 0 && (
          <View style={styles.chips}>
            {files.map((file, i) => {
              const [ios, android] = attachmentIcon(file.kind);
              return (
                <View key={i} style={[styles.chip, { backgroundColor: colors.fill }]} accessible accessibilityLabel={`${file.kind}: ${file.name}`}>
                  <Icon ios={ios} android={android} size={13} color={colors.tint} />
                  <Text style={[styles.chipText, { color: colors.tint }]} numberOfLines={1}>{file.name}</Text>
                </View>
              );
            })}
          </View>
        )}
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
      {open && (
        <View style={[styles.steps, { borderColor: colors.separator }]}>
          {steps.map(s => (s.role === 'tool' ? <ToolRow key={s.id} tool={parseTool(s.content)} />
            : <Text key={s.id} style={[styles.interim, { color: colors.secondary }]} numberOfLines={6}>{s.content}</Text>))}
        </View>
      )}
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

/** The in-flight run: the turn's tools folded, streamed text, and a compact Working row. */
const LiveRun = memo(function LiveRun({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const colors = useColors();
  const live = useLive(deviceId, sessionId);
  const [open, setOpen] = useState(false);
  // A copy made mid-run can already hold the segment still streaming here; show it once.
  const stored = useConnect(s => {
    const last = s.messages[taskKey(deviceId, sessionId)]?.at(-1);
    return last?.role === 'assistant' ? last.content : '';
  });
  if (live.status !== 'running' && live.status !== 'waiting' && !live.limited) return null;
  const lastText = live.items.findLastIndex(i => i.kind === 'text');
  const streamed = lastText >= 0 ? (live.items[lastText] as Extract<LiveItem, { kind: 'text' }>).text : '';
  const text = streamed.trim() && stored.includes(streamed.trim()) ? '' : streamed;
  const earlier = live.items.filter((item, i) => i !== lastText);
  const running = live.items.findLast(i => i.kind === 'tool' && i.tool.status === 'running');
  const current = running?.kind === 'tool' ? `${running.tool.name}  ${running.tool.input.split('\n', 1)[0].slice(0, 60)}` : live.activity;
  return (
    <View>
      {earlier.length > 0 && (
        <View style={styles.work}>
          <Pressable onPress={() => setOpen(o => !o)} style={styles.workHead} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={6}>
            <Text style={[styles.workText, { color: colors.secondary }]}>{plural(earlier.filter(i => i.kind === 'tool').length, 'step')} so far</Text>
            <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={11} color={colors.secondary} />
          </Pressable>
          {open && (
            <View style={[styles.steps, { borderColor: colors.separator }]}>
              {earlier.map((item, i) => item.kind === 'tool' ? <ToolRow key={item.tool.id || i} tool={item.tool} />
                : <Text key={i} style={[styles.interim, { color: item.kind === 'error' ? colors.red : colors.secondary }]} numberOfLines={6}>{item.text}</Text>)}
            </View>
          )}
        </View>
      )}
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

/** The message copy: a spinner while it runs, its error with Retry when it failed. */
function History({ deviceId, sessionId, empty }: { deviceId: string; sessionId: string; empty: boolean }) {
  const colors = useColors();
  const history = useHistory(deviceId, sessionId);
  if (history === undefined) return null;
  if (history === null) {
    return empty ? (
      <View style={styles.activity} accessibilityLabel="Loading messages">
        <ActivityIndicator size="small" style={styles.small} />
        <Text style={[styles.workText, { color: colors.secondary }]}>Loading messages…</Text>
      </View>
    ) : null;
  }
  return (
    <View style={styles.failed}>
      <Icon ios="exclamationmark.circle" android="error" size={14} color={colors.red} />
      <Text style={[styles.failedText, { color: colors.red }]} numberOfLines={3}>{`Couldn't load ${empty ? 'this task' : 'the newest messages'}: ${history}`}</Text>
      <Pressable onPress={() => connect.loadMessages(deviceId, sessionId).catch(() => undefined)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry loading messages">
        <Text style={[styles.retry, { color: colors.tint }]}>Retry</Text>
      </Pressable>
    </View>
  );
}

const key = (row: TurnRow) => row.id;
const render = ({ item }: { item: TurnRow }) => <Row row={item} />;

/** Inverted list: newest at the bottom, the live run and unsent messages below the last stored message.
 * `onAway` hears only when the list crosses AWAY from the newest message. */
export const Transcript = memo(function Transcript({ deviceId, sessionId, top, bottom, listRef, onAway }: {
  deviceId: string; sessionId: string; top: number; bottom: number; listRef?: Ref<FlatList<TurnRow>>; onAway?: (away: boolean) => void;
}) {
  const messages = useMessages(deviceId, sessionId);
  const data = useMemo(() => turnRows(messages).reverse(), [messages]);
  const onScroll = useMemo(() => {
    if (!onAway) return undefined;
    let away = false;
    return (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = e.nativeEvent.contentOffset.y > AWAY;
      if (next !== away) onAway((away = next));
    };
  }, [onAway]);
  return (
    <FlatList
      ref={listRef}
      inverted
      data={data}
      keyExtractor={key}
      renderItem={render}
      ListHeaderComponent={<><History deviceId={deviceId} sessionId={sessionId} empty={!messages.length} /><LiveRun deviceId={deviceId} sessionId={sessionId} /><Pending deviceId={deviceId} sessionId={sessionId} /></>}
      contentContainerStyle={[styles.list, { paddingTop: bottom, paddingBottom: top }]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={100}
      initialNumToRender={12}
      windowSize={11}
    />
  );
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: 18 },
  userTurn: { alignItems: 'flex-end', marginTop: 18, marginBottom: 6 },
  bubble: { maxWidth: '85%', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 11, borderCurve: 'continuous' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 220, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5, borderCurve: 'continuous' },
  chipText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
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
  tool: { marginVertical: 1 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  toolName: { flex: 1, fontSize: 12.5, fontFamily: mono },
  toolBody: { borderRadius: 10, padding: 10, gap: 8, marginBottom: 4 },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 16 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  failedText: { flex: 1, fontSize: 14 },
  retry: { fontSize: 15, fontWeight: '600' },
  current: { flex: 1, fontSize: 12, fontFamily: mono },
  small: { transform: [{ scale: 0.8 }] },
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
