// The rows of a transcript: prompts, folded work, replies, the live run and unsent messages. Rows new
// since the thread opened enter once with a few points of travel; prompts and replies that were
// already on screen as an optimistic bubble or streamed text settle instead. No per-row timers.
// A long press on a prompt offers Copy and Fork from here (a new thread up to just before it, to ask
// again differently) with its time as the sheet's title (the system's action sheet: a context menu's
// preview would come out upside down from the inverted list). A long press on a reply selects its text
// as usual, and the selection menu gains Copy reply and Fork from here (also a VoiceOver action).
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { createContext, memo, use, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Keyframe, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import type { Message } from '../connect/types.ts';
import { taskKey, useConnect, useLive, useSent, type LiveItem } from '../store/index.ts';
import { sentLabel } from '../store/sent.ts';
import { discardSent, removeOutbox, retryOutbox, sendAgain, useLocal } from '../store/local.ts';
import { duration, type TurnRow } from '../store/turns.ts';
import { handoffTitle, type Handoff } from '../store/handoff.ts';
import { HarnessLogo, harnessName } from './harness.tsx';
import { bubbleAttachments } from '../store/attachments.ts';
import { draftKey, setDraft, steeredAt } from '../store/draft.ts';
import { Chips, ImageGrid, LocalImageGrid, ThreadContext } from './Attachments.tsx';
import { useColors } from './theme.ts';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { BLOCKED_TITLE, gatedPress, menuGate } from './menu-gate.ts';
import { useComputerName } from './hub/common.tsx';
import { forkAction } from './TaskHeader.tsx';
import { rewindTo } from '../connect/api/rewind.ts';
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

/** The menu gate (menu-gate.ts) of `method` on this thread's computer: hidden only where the
 * computer lacks it; where this phone's grant or the Full access switch blocks it, the item stays
 * and a tap explains why (BLOCKED_TITLE alert) instead of running. */
function useThreadGate(method: string) {
  const thread = use(ThreadContext);
  const caps = useHostCapabilities(thread?.deviceId ?? '');
  const computer = useComputerName(thread?.deviceId ?? '');
  return menuGate(caps, method, computer);
}

const explainBlocked = (note: string) => Alert.alert(BLOCKED_TITLE, note);

/** Fork from a stored message of this thread, where the computer serves thread.fork (useThreadGate:
 * a tap explains it when this phone's access blocks it); null otherwise. */
function useFork(id: number, before: boolean): (() => void) | null {
  const thread = use(ThreadContext);
  const gate = useThreadGate('thread.fork');
  if (!thread || !gate.shown || id <= 0) return null;
  return gatedPress(gate, () => forkAction(thread.deviceId, thread.sessionId, id, before), explainBlocked);
}

/** Rewind (docs/rewind.md): a new task forked to just before this stored prompt, with the prompt in
 * its composer to fix and send. Null where the computer has no rewind.to; where this phone's access
 * blocks it a tap explains why (useThreadGate). Asks first, and refuses
 * while the agent runs, as the desktop's Edit does. */
function useRewind(id: number): (() => void) | null {
  const thread = use(ThreadContext);
  const gate = useThreadGate('rewind.to');
  // The live run status first (as TaskHeader reads it), else the task list's, which lags a run that just started.
  const running = useConnect(s => {
    if (!thread) return false;
    const live = s.live[taskKey(thread.deviceId, thread.sessionId)]?.status;
    const status = live && live !== 'idle' ? live : s.tasks[thread.deviceId]?.tasks.find(t => t.sessionId === thread.sessionId)?.status;
    return status === 'running' || status === 'waiting';
  });
  if (!thread || !gate.shown || id <= 0) return null;
  const { deviceId, sessionId } = thread;
  const rewind = () => {
    haptic('selection');
    rewindTo(deviceId, sessionId, id).then(rewound => {
      // Attached files and images are not re-attached: only what was typed returns.
      if (rewound.draft) setDraft(draftKey(deviceId, rewound.sessionId), rewound.draft);
      haptic('success');
      AccessibilityInfo.announceForAccessibility('Rewound to before your message. Edit it and send.');
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session: rewound.sessionId } });
    }, (error: Error) => { haptic('error'); Alert.alert('Could not rewind', error.message); });
  };
  return gatedPress(gate, () => {
    if (running) return void Alert.alert('Stop the agent first', 'Rewind is available once this run ends.');
    Alert.alert('Rewind to here?', 'A new task starts from just before this message, with it in the composer to edit and send. This message and everything after it are left out. Files on your computer are not changed, and this task stays as it is.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rewind', style: 'destructive', onPress: rewind },
    ]);
  }, explainBlocked);
}

function PromptText({ text, at, id }: { text: string; at: number; id: number }) {
  const colors = useColors();
  const { copied, doCopy } = useCopied(text);
  const fork = useFork(id, true);
  const rewind = useRewind(id);
  const menu = () => {
    haptic('selection');
    showActions(clock(at), [
      { label: 'Copy', ios: 'doc.on.doc', android: 'content_copy', onPress: doCopy },
      ...(fork ? [{ label: 'Fork from here', ios: 'arrow.branch', android: 'fork_right', onPress: fork } as const] : []),
      ...(rewind ? [{ label: 'Rewind to here', ios: 'arrow.uturn.backward', android: 'undo', destructive: true, onPress: rewind } as const] : []),
    ]);
  };
  const act = (name: string) => (name === 'fork' ? fork?.() : name === 'rewind' ? rewind?.() : doCopy());
  return (
    <Pressable onLongPress={menu} accessible accessibilityActions={[{ name: 'copy', label: 'Copy' }, ...(fork ? [{ name: 'fork', label: 'Fork from here' }] : []), ...(rewind ? [{ name: 'rewind', label: 'Rewind to here' }] : [])]}
      onAccessibilityAction={e => act(e.nativeEvent.actionName)} accessibilityLabel={`${text}, ${clock(at)}`}>
      <Text style={[textStyle.callout, { color: colors.text }]}>{text}</Text>
      {copied && <CopiedTick align="right" />}
    </Pressable>
  );
}

function Reply({ message }: { message: Message }) {
  const { copied, doCopy } = useCopied(message.content);
  const fork = useFork(message.id, false);
  const menu = useMemo(() => ({
    text: `Copy reply · ${clock(message.createdAt)}`, icon: 'doc.on.doc', onPress: doCopy,
    more: fork ? [{ text: 'Fork from here', icon: 'arrow.branch', onPress: fork }] : undefined,
  }), [message.createdAt, doCopy, fork]);
  return (
    <MarkdownMenuContext.Provider value={menu}>
      <View style={styles.reply} accessibilityActions={fork ? [{ name: 'fork', label: 'Fork from here' }] : undefined} onAccessibilityAction={fork ? e => e.nativeEvent.actionName === 'fork' && fork() : undefined}>
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
        {!!prompt && <PromptText text={prompt} at={message.createdAt} id={message.id} />}
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

/** What the turn changed, as on the desktop: opens this turn's changes where the computer serves
 * turn.summary, the task's Changes otherwise. */
function ChangesRow({ messageId, files, additions, deletions }: { messageId: number; files: number; additions: number; deletions: number }) {
  const colors = useColors();
  const thread = use(ThreadContext);
  const perTurn = useHostSupports(thread?.deviceId ?? '', 'turn.summary');
  const label = `${files} changed ${files === 1 ? 'file' : 'files'}`;
  const open = () => {
    if (!thread) return;
    const params = { device: thread.deviceId, session: thread.sessionId };
    router.push({ pathname: '/changes', params: perTurn ? { ...params, turn: String(messageId) } : params });
  };
  return (
    <PressScale onPress={open} unstable_pressDelay={ROW_PRESS_DELAY_MS} hitSlop={6}
      style={styles.changes} accessibilityLabel={`${label}, ${additions} added, ${deletions} removed`} accessibilityHint="Opens the changes">
      <Text style={[textStyle.subhead, { color: colors.muted }]}>{label}</Text>
      <Text style={[textStyle.subhead, styles.tabular, { color: colors.success }]}>+{additions}</Text>
      <Text style={[textStyle.subhead, styles.tabular, { color: colors.danger }]}>−{deletions}</Text>
      <Icon ios="chevron.right" android="chevron_right" size={11} color={colors.muted} />
    </PressScale>
  );
}

/** The task switched agents (a 'handoff' message): who took over, and what the new agent was handed. */
function HandoffCard({ handoff }: { handoff: Handoff }) {
  const colors = useColors();
  const title = handoffTitle(handoff, harnessName);
  return (
    <Card style={styles.handoff} accessible accessibilityLabel={`${title}. ${handoff.summary}`}>
      <View style={styles.handoffHead}>
        <HarnessLogo id={handoff.fromProvider} size={16} color={colors.text} />
        <Icon ios="arrow.right" android="arrow_forward" size={12} color={colors.muted} />
        <HarnessLogo id={handoff.toProvider} size={16} color={colors.text} />
        <Text style={[textStyle.subheadMedium, styles.handoffTitle, { color: colors.text }]} numberOfLines={2}>{title}</Text>
      </View>
      {!!handoff.summary && <Text style={[textStyle.footnote, { color: colors.muted }]}>{handoff.summary}</Text>}
    </Card>
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
      case 'changes': return <ChangesRow messageId={row.messageId} files={row.files} additions={row.additions} deletions={row.deletions} />;
      case 'handoff': return <HandoffCard handoff={row.handoff} />;
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

/** Prompts sent from this phone, shown at once until the stored copy replaces them: the ones
 * starting a turn above the live run (`before`), steers and queued ones after it. */
export function SentBubbles({ deviceId, sessionId, before }: { deviceId: string; sessionId: string; before: boolean }) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const sent = useSent(deviceId, sessionId);
  const computer = useConnect(s => s.devices.find(d => d.id === deviceId)?.name ?? 'The computer');
  const shown = sent.filter(e => (e.state === 'sending') === before);
  // A View phone can't send: Not delivered bubbles then offer only Copy and Discard.
  const canSend = useHostAllows(deviceId, 'task.send');
  const fresh = use(FreshContext);
  useEffect(() => { sent.forEach(e => fresh?.entered.add(`sent:${e.text.trim()}`)); }, [sent, fresh]);
  if (!shown.length) return null;
  return (
    <>
      {shown.map(entry => {
        const label = `${entry.text}${entry.images?.length ? `, ${entry.images.length} ${entry.images.length === 1 ? 'image' : 'images'}` : ''}, ${sentLabel(entry)}`;
        const bubble = (
          <View style={[styles.bubble, entry.undelivered ? styles.pending : styles.sending, { backgroundColor: colors.bubble, borderColor: entry.undelivered ? colors.danger : colors.border }]}>
            <LocalImageGrid uris={entry.images} />
            <Text style={[textStyle.callout, { color: colors.text }]}>{entry.text}</Text>
          </View>
        );
        const meta = (
          <View style={[styles.meta, styles.metaRight]}>
            {entry.state === 'steering' && !entry.undelivered && <Icon ios="arrow.uturn.right" android="alt_route" size={11} color={colors.muted} />}
            {entry.state === 'queued' && <Icon ios="clock" android="schedule" size={11} color={colors.muted} />}
            {entry.unconfirmed && <Icon ios="questionmark.circle" android="help" size={11} color={colors.warning} />}
            {entry.undelivered && <Icon ios="exclamationmark.circle" android="error" size={12} color={colors.danger} />}
            <CrossFadeText text={entry.undelivered && canSend ? `${sentLabel(entry)} · tap to send again` : sentLabel(entry)} style={[textStyle.caption, { color: entry.undelivered ? colors.danger : colors.muted }]} />
          </View>
        );
        // The host never got it (no stored copy, the task idle): the user sends it again or drops it.
        if (entry.undelivered) {
          const menu = () => showActions(`${computer} never received this message.`, [
            ...(canSend ? [{ label: 'Send again', ios: 'arrow.up.circle', android: 'send', onPress: () => sendAgain(deviceId, sessionId, entry.id) } as const] : []),
            { label: 'Copy', ios: 'doc.on.doc', android: 'content_copy', onPress: () => copy(entry.text) },
            { label: 'Discard', ios: 'trash', android: 'delete', destructive: true, onPress: () => discardSent(deviceId, sessionId, entry.id) },
          ]);
          return (
            <Animated.View key={entry.id} entering={reduced ? crossFadeIn : RISE} exiting={crossFadeOut}>
              <PressScale onPress={menu} onLongPress={menu} unstable_pressDelay={ROW_PRESS_DELAY_MS} style={styles.userTurn} accessibilityLabel={label} accessibilityHint={canSend ? 'Send again or discard' : 'Copy or discard'}>
                {bubble}
                {meta}
              </PressScale>
            </Animated.View>
          );
        }
        return (
          <Animated.View key={entry.id} entering={reduced ? crossFadeIn : RISE} style={styles.userTurn} accessible accessibilityLabel={label}>
            {bubble}
            {meta}
          </Animated.View>
        );
      })}
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
  handoff: { marginVertical: geometry.cardPadding, padding: geometry.rowInset, gap: geometry.cardPadding },
  handoffHead: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
  handoffTitle: { flex: 1 },
});
