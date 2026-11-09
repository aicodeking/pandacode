// The rows of a transcript: prompts, folded work, replies, the live run and unsent messages. Rows new
// since the thread opened enter once with a few points of travel; prompts and replies that were
// already on screen as an optimistic bubble or streamed text settle instead. No per-row timers.
// A long press on a prompt offers Copy with its time as the sheet's title (the system's action sheet: a
// context menu's preview would come out upside down from the inverted list). A long press on a reply
// selects its text as usual, and the selection menu gains Copy reply.
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { createContext, memo, use, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Keyframe, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import type { Message } from '../connect/types.ts';
import { taskKey, useConnect, useLive, useSent, type LiveItem } from '../store/index.ts';
import type { Sent } from '../store/sent.ts';
import { removeOutbox, retryOutbox, useLocal } from '../store/local.ts';
import { duration, type TurnRow } from '../store/turns.ts';
import { bubbleAttachments } from '../store/attachments.ts';
import { steeredAt } from '../store/draft.ts';
import { Chips, ImageGrid, ThreadContext } from './Attachments.tsx';
import { useColors } from './theme.ts';
import { Card, Chevron, Collapse, CrossFadeText, crossFadeIn, crossFadeOut, geometry, haptic, PressScale, type as textStyle } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { MarkdownMenuContext } from './generative/MarkdownText.tsx';
import { Markdown } from './Markdown.tsx';
import { showActions } from './Menu.tsx';
import { groupRuns, parseToolMessage } from '../store/trace.ts';
import { PlanCard, SubagentPanel, ThinkingLine, ToolGroup } from './Trace.tsx';

// Same blocks the desktop folds behind a user message (CONTEXT_BOUNDARY in src/main.ts).
const CONTEXT_BOUNDARY = /\n\n(?=(?:File|Document|Folder|GitHub|Browser element) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Response style \(PandaCode token saver)/;
/** Fabric stops painting an inverted list at rest on iOS 27 (facebook/react-native#59731), so there
 * the transcript runs oldest first, with subview clipping off. Remove once RN fixes the inverted path. */
export const IOS_27 = Platform.OS === 'ios' && parseInt(Platform.Version, 10) >= 27;

const ENTER_MS = 220;
const COPIED_MS = 1400;
/** Touch-down feedback waits this long on list rows, so starting a scroll doesn't flinch them. */
const ROW_PRESS_DELAY_MS = 90;
/** Inverted cells are flipped, so "from below" is negative there. */
const fromBelow = (points: number) => (IOS_27 ? points : -points);
const entrance = (opacity: number, travel: number) => new Keyframe({
  from: { opacity, transform: [{ translateY: fromBelow(travel) }] },
  to: { opacity: 1, transform: [{ translateY: 0 }], easing: Easing.out(Easing.cubic) },
}).duration(ENTER_MS).reduceMotion(ReduceMotion.Never);
/** Something new: fade and a few points of travel. */
const ENTER = entrance(0, 6);
/** A stored copy taking over from what already showed: a stored prompt finishes the optimistic bubble's fade, a reply settles. */
const SENT = entrance(0.6, 0);
const SETTLE = entrance(0.6, 3);
/** A sent prompt rising out of the composer and settling into place. */
const RISE = new Keyframe({
  from: { opacity: 0, transform: [{ translateY: fromBelow(34) }, { scale: 0.96 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: Easing.bezier(0.2, 0.9, 0.3, 1) },
}).duration(320).reduceMotion(ReduceMotion.Never);

/** `newest`: the last message id when the thread drew; `entered`: rows that already played, so scrolling back doesn't replay them. */
export const FreshContext = createContext<{ newest: number; entered: Set<string> } | null>(null);

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function copy(text: string) {
  void Clipboard.setStringAsync(text);
  haptic('success');
  AccessibilityInfo.announceForAccessibility('Copied');
}

/** A copy's visible answer: true for a moment, for the tick. */
function useCopied(text: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return { copied, doCopy: () => { copy(text); setCopied(true); } };
}

function CopiedTick({ align }: { align: 'left' | 'right' }) {
  const colors = useColors();
  return (
    <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={[styles.copied, align === 'right' ? styles.copiedRight : styles.copiedLeft, { backgroundColor: colors.raised, borderColor: colors.border, boxShadow: colors.shadowRaised }]}>
      <Icon ios="checkmark" android="check" size={11} color={colors.success} />
      <Text style={[textStyle.caption, { color: colors.text }]}>Copied</Text>
    </Animated.View>
  );
}

function PromptText({ text, at }: { text: string; at: number }) {
  const colors = useColors();
  const { copied, doCopy } = useCopied(text);
  const menu = () => {
    haptic('selection');
    showActions(clock(at), [{ label: 'Copy', ios: 'doc.on.doc', android: 'content_copy', onPress: doCopy }]);
  };
  return (
    <Pressable onLongPress={menu} accessible accessibilityActions={[{ name: 'copy', label: 'Copy' }]} onAccessibilityAction={doCopy} accessibilityLabel={`${text}, ${clock(at)}`}>
      <Text style={[textStyle.callout, { color: colors.text }]}>{text}</Text>
      {copied && <CopiedTick align="right" />}
    </Pressable>
  );
}

function Reply({ message }: { message: Message }) {
  const { copied, doCopy } = useCopied(message.content);
  const menu = useMemo(() => ({ text: `Copy reply · ${clock(message.createdAt)}`, icon: 'doc.on.doc', onPress: doCopy }), [message.createdAt, doCopy]);
  return (
    <MarkdownMenuContext.Provider value={menu}>
      <View style={styles.reply}>
        <Markdown text={message.content} />
        {copied && <CopiedTick align="left" />}
      </View>
    </MarkdownMenuContext.Provider>
  );
}

function UserBubble({ message }: { message: Message }) {
  const colors = useColors();
  const [showContext, setShowContext] = useState(false);
  const thread = use(ThreadContext);
  const content = message.content;
  const cut = content.search(CONTEXT_BOUNDARY);
  const prompt = cut < 0 ? content : content.slice(0, cut);
  const files = useMemo(() => bubbleAttachments(message.attachments, cut < 0 ? '' : content.slice(cut)), [message.attachments, content, cut]);
  const steered = useLocal(s => (thread ? steeredAt(s.steers, taskKey(thread.deviceId, thread.sessionId), prompt, message.createdAt) : undefined));
  return (
    <View style={styles.userTurn}>
      <View style={[styles.bubble, { backgroundColor: colors.bubble, borderColor: colors.border, boxShadow: colors.shadowRaised }]}>
        <ImageGrid images={files.images} />
        {!!prompt && <PromptText text={prompt} at={message.createdAt} />}
        <Chips chips={files.chips} />
        {cut >= 0 && (
          <PressScale onPress={() => setShowContext(s => !s)} accessibilityState={{ expanded: showContext }}>
            <Text style={[textStyle.footnote, styles.context, { color: colors.muted }]}>{showContext ? content.slice(cut + 2) : 'Attached context'}</Text>
          </PressScale>
        )}
      </View>
      {steered !== undefined && (
        <View style={[styles.meta, styles.metaRight]}>
          <Icon ios="arrow.uturn.right" android="alt_route" size={11} color={colors.muted} />
          <Text style={[textStyle.caption, { color: colors.muted }]}>Steer · {clock(steered)}</Text>
        </View>
      )}
    </View>
  );
}

function WorkRow({ steps, durationMs, fallbackAt }: { steps: Message[]; durationMs: number | null; fallbackAt?: number }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const tools = steps.filter(s => s.role === 'tool').length;
  const label = durationMs != null ? `Worked for ${duration(durationMs)}` : `${tools} step${tools === 1 ? '' : 's'}`;
  // A turn that failed before any step still has its reply's time.
  const at = steps.at(-1)?.createdAt ?? fallbackAt;
  return (
    <View style={styles.work}>
      <PressScale onPress={() => setOpen(o => !o)} disabled={!steps.length} unstable_pressDelay={ROW_PRESS_DELAY_MS} style={styles.workHead} accessibilityLabel={at ? `${label}, ${clock(at)}` : label} accessibilityState={{ expanded: open }} hitSlop={6}>
        <Text style={[textStyle.subhead, { color: colors.muted }]}>{label}</Text>
        {steps.length > 0 && <Chevron expanded={open} size={11} color={colors.muted} />}
        <View style={styles.workGap} />
        {!!at && <Text style={[textStyle.caption, { color: colors.faint }]}>{clock(at)}</Text>}
      </PressScale>
      <Collapse expanded={open}><Steps steps={steps} /></Collapse>
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
    <Card style={styles.steps}>
      {runs.map(run => (run.kind === 'tools'
        ? <ToolGroup key={run.items[0].id} items={run.items as { tool: ReturnType<typeof parseToolMessage> }[]} initiallyOpen={single} />
        : <Text key={run.item.id} style={[textStyle.footnote, styles.interim, { color: colors.muted }]} numberOfLines={6}>{'text' in run.item ? plain(run.item.text) : ''}</Text>))}
    </Card>
  );
}

/** What the turn changed, as on the desktop: opens Changes. */
function ChangesRow({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  const colors = useColors();
  const thread = use(ThreadContext);
  const label = `${files} changed ${files === 1 ? 'file' : 'files'}`;
  return (
    <PressScale onPress={() => thread && router.push({ pathname: '/changes', params: { device: thread.deviceId, session: thread.sessionId } })} unstable_pressDelay={ROW_PRESS_DELAY_MS} hitSlop={6}
      style={styles.changes} accessibilityLabel={`${label}, ${additions} added, ${deletions} removed`} accessibilityHint="Opens the changes">
      <Text style={[textStyle.subhead, { color: colors.muted }]}>{label}</Text>
      <Text style={[textStyle.subhead, styles.tabular, { color: colors.success }]}>+{additions}</Text>
      <Text style={[textStyle.subhead, styles.tabular, { color: colors.danger }]}>−{deletions}</Text>
      <Icon ios="chevron.right" android="chevron_right" size={11} color={colors.muted} />
    </PressScale>
  );
}

const rowEntrance = (row: TurnRow) => (row.kind === 'user' ? SENT : row.kind === 'reply' ? SETTLE : ENTER);

/** This row's entrance if it is new since the thread drew and hasn't played yet; fixed at mount. With Reduce Motion, a cross-fade. */
function useRowEntrance(row: TurnRow) {
  const fresh = use(FreshContext);
  const reduced = useReducedMotion();
  const [entering] = useState(() => {
    if (!fresh || Number(row.id.slice(1)) <= fresh.newest || fresh.entered.has(row.id)) return undefined;
    fresh.entered.add(row.id);
    if (reduced) return crossFadeIn;
    // A prompt nobody saw as an optimistic bubble (the demo, say) rises out of the composer itself.
    if (row.kind === 'user' && !fresh.entered.has(`sent:${row.message.content.trim()}`)) return RISE;
    return rowEntrance(row);
  });
  return entering;
}

export const Row = memo(function Row({ row }: { row: TurnRow }) {
  const colors = useColors();
  const entering = useRowEntrance(row);
  const body = (() => {
    switch (row.kind) {
      case 'user': return <UserBubble message={row.message} />;
      case 'work': return <WorkRow steps={row.steps} durationMs={row.durationMs} fallbackAt={row.at} />;
      case 'reply': return <Reply message={row.message} />;
      case 'changes': return <ChangesRow files={row.files} additions={row.additions} deletions={row.deletions} />;
      default: return <Text style={[textStyle.subhead, styles.note, { color: row.message.role === 'error' ? colors.danger : colors.muted }]}>{row.message.content}</Text>;
    }
  })();
  return entering ? <Animated.View entering={entering}>{body}</Animated.View> : body;
});

/** Messages waiting in the outbox for this task. */
export function Pending({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const colors = useColors();
  const reduced = useReducedMotion();
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
        const tint = entry.error ? colors.danger : colors.warning;
        return (
          <Animated.View key={entry.id} entering={reduced ? crossFadeIn : ENTER} exiting={crossFadeOut}>
            <PressScale onPress={menu} onLongPress={menu} unstable_pressDelay={ROW_PRESS_DELAY_MS} style={styles.userTurn} accessibilityLabel={entry.text} accessibilityHint="Retry or delete">
              <View style={[styles.bubble, styles.pending, { backgroundColor: colors.bubble, borderColor: entry.error ? colors.danger : colors.borderStrong }]}>
                <Text style={[textStyle.callout, { color: colors.text }]}>{entry.text}</Text>
              </View>
              <View style={[styles.meta, styles.metaRight]}>
                <Icon ios={entry.error ? 'exclamationmark.circle' : 'clock.arrow.circlepath'} android={entry.error ? 'error' : 'schedule_send'} size={12} color={tint} />
                <Text style={[textStyle.caption, { color: tint }]} numberOfLines={1}>{entry.error ? 'Not sent · tap to retry' : 'Sends on reconnect'}</Text>
              </View>
            </PressScale>
          </Animated.View>
        );
      })}
    </>
  );
}

const SENT_LABEL: Record<Sent['state'], string> = { sending: 'Sending…', steering: 'Steer · Sending…', queued: 'Queued' };

/** Prompts sent from this phone, shown at once until the stored copy replaces them: the ones
 * starting a turn above the live run (`before`), steers and queued ones after it. */
export function SentBubbles({ deviceId, sessionId, before }: { deviceId: string; sessionId: string; before: boolean }) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const sent = useSent(deviceId, sessionId);
  const shown = sent.filter(e => (e.state === 'sending') === before);
  const fresh = use(FreshContext);
  useEffect(() => { sent.forEach(e => fresh?.entered.add(`sent:${e.text.trim()}`)); }, [sent, fresh]);
  if (!shown.length) return null;
  return (
    <>
      {shown.map(entry => (
        <Animated.View key={entry.id} entering={reduced ? crossFadeIn : RISE} style={styles.userTurn} accessible accessibilityLabel={`${entry.text}, ${SENT_LABEL[entry.state]}`}>
          <View style={[styles.bubble, styles.sending, { backgroundColor: colors.bubble, borderColor: colors.border }]}>
            <Text style={[textStyle.callout, { color: colors.text }]}>{entry.text}</Text>
          </View>
          <View style={[styles.meta, styles.metaRight]}>
            {entry.state === 'steering' && <Icon ios="arrow.uturn.right" android="alt_route" size={11} color={colors.muted} />}
            {entry.state === 'queued' && <Icon ios="clock" android="schedule" size={11} color={colors.muted} />}
            <CrossFadeText text={SENT_LABEL[entry.state]} style={[textStyle.caption, { color: colors.muted }]} />
          </View>
        </Animated.View>
      ))}
    </>
  );
}

/** The in-flight run: the plan, subagent panels, the turn's tools grouped (the newest group open) and
 * streamed text. Its status is the one pill over the composer. Rows are memoized, so an event
 * re-renders only what it changed; it fades as the stored copy takes over. */
export const LiveRun = memo(function LiveRun({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
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
  return (
    <Animated.View exiting={crossFadeOut}>
      {!!live.todos?.length && <PlanCard todos={live.todos} />}
      {live.subagents?.map(agent => <SubagentPanel key={agent.id} agent={agent} />)}
      {earlier.length > 0 && (
        <Card style={styles.steps}>
          {earlier.map((run, i) => (run.kind === 'tools'
            ? <ToolGroup key={toolKey(run.items[0], i)} items={run.items as Extract<LiveItem, { kind: 'tool' }>[]} initiallyOpen={i === lastGroup} />
            : <Text key={i} style={[textStyle.footnote, styles.interim, { color: run.item.kind === 'error' ? colors.danger : colors.muted }]} numberOfLines={6}>{'text' in run.item ? plain(run.item.text) : ''}</Text>))}
        </Card>
      )}
      {!!live.thinking && !text && <ThinkingLine text={live.thinking} />}
      {!!text && <View style={styles.reply}><Markdown text={text} streaming /></View>}
    </Animated.View>
  );
});

/** An interim note on one quiet line: Markdown emphasis and code marks dropped. */
const plain = (text = '') => text.replace(/\*\*|__|`/g, '');

const toolKey = (item: LiveItem, i: number) => (item.kind === 'tool' && item.tool.id ? item.tool.id : `g${i}`);

const styles = StyleSheet.create({
  userTurn: { alignItems: 'flex-end', marginTop: 18, marginBottom: 6 },
  bubble: { maxWidth: '85%', borderRadius: geometry.controlRadius + 4, borderWidth: geometry.hairline, paddingHorizontal: 14, paddingVertical: 10, borderCurve: 'continuous' },
  sending: { opacity: 0.6 },
  pending: { borderStyle: 'dashed', opacity: 0.85 },
  context: { marginTop: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6, paddingHorizontal: 4 },
  metaRight: { justifyContent: 'flex-end', gap: 6 },
  copied: { position: 'absolute', bottom: -6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: geometry.chipRadius, borderWidth: geometry.hairline, borderCurve: 'continuous' },
  copiedRight: { right: 0 },
  copiedLeft: { left: 0 },
  reply: { marginVertical: 4 },
  work: { marginTop: 8, marginBottom: 4 },
  workHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  workGap: { flex: 1 },
  changes: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4, marginBottom: 4 },
  tabular: { fontVariant: ['tabular-nums'] },
  steps: { marginTop: 4, marginBottom: 4, gap: 6 },
  interim: { paddingHorizontal: 10, paddingVertical: 4 },
  note: { marginVertical: 6 },
});
