// Agent traces as the desktop draws them (src/tool-activity.ts, src/subagents.ts), in nested cards: one
// sentence per tool call with its kind's icon, status and duration, tapping open to a diff, checklist,
// command output or the raw input/output; subagent panels; the run's checklist; the Thinking line.
// Every row is memoized on its (immutable) tool object, so a live event re-renders only what changed.
// A running icon pulses with SF Symbols' own effect on iOS and the one shared loop elsewhere: no timers per row.
import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import Animated, { Easing, Keyframe, LayoutAnimationConfig, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import type { ToolActivity } from '../connect/types.ts';
import { elapsedLabel } from '../store/inbox.ts';
import { describeTool, DIFF_LINES, diffLines, exitCode, parseFields, shellCommand, subagentActive, subagentName, summarizeTools, todosOf, type Subagent, type Todo, type TraceKind } from '../store/trace.ts';
import { duration } from '../store/turns.ts';
import { Card, CardSection, Chevron, Collapse, CrossFadeText, crossFadeIn, geometry, InnerCard, PressScale, StatusDot, type as textStyle, usePulseStyle } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { McpBody, useWorkerNames } from './ToolCards.tsx';
import { mono, useColors } from './theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;
const MAX_OUTPUT = 6000;
const PREVIEW_LINES = 12;
/** Running subagents' elapsed time ticks this often. */
const TICK_MS = 15_000;
const THINKING_PULSE_MIN = 0.55;
const SYMBOL_PULSE = { effect: { type: 'pulse', wholeSymbol: true }, repeating: true } as const;
/** A plan's tick arriving: a little scale and a fade, skipped with Reduce Motion. */
const TICK_IN = new Keyframe({
  from: { opacity: 0, transform: [{ scale: 0.6 }] },
  to: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.cubic) },
}).duration(220).reduceMotion(ReduceMotion.System);

const KIND_ICONS: Record<TraceKind, IconName> = {
  shell: { ios: 'terminal', android: 'terminal' }, read: { ios: 'doc.text', android: 'description' },
  edit: { ios: 'pencil', android: 'edit' }, write: { ios: 'doc.badge.plus', android: 'note_add' },
  search: { ios: 'magnifyingglass', android: 'search' }, web: { ios: 'globe', android: 'public' },
  fetch: { ios: 'safari', android: 'travel_explore' }, todo: { ios: 'checklist', android: 'checklist' },
  agent: { ios: 'person.2', android: 'group' }, skill: { ios: 'sparkles', android: 'auto_awesome' },
  mcp: { ios: 'server.rack', android: 'dns' }, tool: { ios: 'wrench.and.screwdriver', android: 'build' },
};

// PandaCode's own tools (store/pandacode-tools.ts), by tool.
const OWN_ICONS: Record<string, IconName> = {
  dispatch_workers: { ios: 'person.3', android: 'groups' }, followup_worker: { ios: 'arrowshape.turn.up.right', android: 'reply' },
  cancel_worker: { ios: 'xmark.circle', android: 'cancel' }, read_worker: { ios: 'person.text.rectangle', android: 'badge' },
  list_workers: { ios: 'person.3.sequence', android: 'groups' }, team_directory: { ios: 'person.3.sequence', android: 'groups' },
  finish_team: { ios: 'flag.checkered', android: 'flag' }, send_team_message: { ios: 'paperplane', android: 'send' },
  read_team_mailbox: { ios: 'tray', android: 'inbox' }, checkpoint_worker: { ios: 'bookmark', android: 'bookmark' },
  title: { ios: 'character.cursor.ibeam', android: 'title' }, track_files: { ios: 'doc.on.doc', android: 'file_copy' },
  simulator_screenshot: { ios: 'camera.viewfinder', android: 'screenshot' }, simulator_describe: { ios: 'text.viewfinder', android: 'document_scanner' },
  simulator_devices: { ios: 'iphone', android: 'smartphone' }, simulator_control: { ios: 'hand.tap', android: 'touch_app' },
  simulator_manage: { ios: 'iphone', android: 'smartphone' }, vm_screenshot: { ios: 'camera.viewfinder', android: 'screenshot' },
  vm_list: { ios: 'desktopcomputer', android: 'computer' }, vm_control: { ios: 'cursorarrow.click', android: 'mouse' },
  vm_manage: { ios: 'desktopcomputer', android: 'computer' }, design_write: { ios: 'paintpalette', android: 'palette' },
  design_list: { ios: 'square.grid.2x2', android: 'grid_view' }, design_comments: { ios: 'text.bubble', android: 'comment' },
  design_resolve: { ios: 'checkmark.bubble', android: 'mark_chat_read' }, preview_file: { ios: 'eye', android: 'visibility' },
  run_project: { ios: 'play', android: 'play_arrow' }, cloud_cli: { ios: 'icloud.and.arrow.up', android: 'cloud_upload' },
};
const traceIcon = (kind: TraceKind, own?: string) => (own && OWN_ICONS[own]) || KIND_ICONS[kind];

/** A leading symbol that pulses while its tool runs. */
function PulsingIcon({ icon, running, size, color }: { icon: IconName; running: boolean; size: number; color: ColorValue }) {
  const reduced = useReducedMotion();
  const pulse = usePulseStyle(running && Platform.OS !== 'ios');
  // Keyed: a symbol effect only reliably stops by replacing the view.
  if (Platform.OS === 'ios') return <SymbolView key={running ? 'on' : 'off'} name={{ ios: icon.ios, android: icon.android }} size={size} tintColor={color as string} animationSpec={running && !reduced ? SYMBOL_PULSE : undefined} />;
  return <Animated.View style={pulse}><Icon {...icon} size={size} color={color} /></Animated.View>;
}

function StatusGlyph({ status, color }: { status: ToolActivity['status'] | Subagent['status']; color: ColorValue }) {
  const colors = useColors();
  if (status === 'running') return <StatusDot tone="running" pulse size={7} />;
  if (status === 'waiting') return <Icon ios="hand.raised.fill" android="front_hand" size={12} color={colors.warning} />;
  if (status === 'failed') return <Icon ios="xmark.circle.fill" android="cancel" size={13} color={colors.danger} />;
  if (status === 'stopped') return <Icon ios="stop.circle" android="stop_circle" size={13} color={colors.muted} />;
  return <Icon ios="checkmark" android="check" size={11} color={color} />;
}

/** A pulsing dot while running, a check when done, a red cross when it failed; each change pops in over
 * the last (expo-symbols has no replace effect), and a row drawn already finished just shows it. */
export function StatusMark({ status, color }: { status: ToolActivity['status'] | Subagent['status']; color: ColorValue }) {
  const reduced = useReducedMotion();
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={status} entering={reduced ? crossFadeIn : TICK_IN}>
        <StatusGlyph status={status} color={color} />
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

export const ToolRow = memo(function ToolRow({ tool, startedAt, endedAt }: { tool: ToolActivity; startedAt?: number; endedAt?: number }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const fields = useMemo(() => parseFields(tool.input), [tool.input]);
  const names = useWorkerNames();
  const trace = useMemo(() => describeTool(tool, fields, names), [tool, fields, names]);
  const failed = tool.status === 'failed';
  const took = startedAt && endedAt && endedAt - startedAt >= 1000 ? duration(endedAt - startedAt) : '';
  return (
    <View>
      <PressScale onPress={() => setOpen(o => !o)} style={styles.toolHead} hitSlop={2}
        accessibilityState={{ expanded: open }} accessibilityLabel={`${trace.verb} ${trace.chip} ${trace.object}, ${tool.status}${took ? `, ${took}` : ''}`}>
        <PulsingIcon icon={traceIcon(trace.kind, trace.own)} running={tool.status === 'running'} size={15} color={failed ? colors.danger : colors.muted} />
        <Text style={styles.sentence} numberOfLines={1}>
          <Text style={[textStyle.subhead, { color: failed ? colors.danger : colors.text }]}>{trace.verb}</Text>
          {!!trace.chip && <Text style={[textStyle.code, { color: colors.muted }]}>{`  ${trace.chip}`}</Text>}
          {!!trace.object && <Text style={[trace.kind === 'shell' ? textStyle.code : textStyle.footnote, { color: colors.faint }]}>{`  ${trace.object}`}</Text>}
          {trace.added !== undefined && <Text style={textStyle.code}><Text style={{ color: colors.success }}>{`  +${trace.added}`}</Text><Text style={{ color: colors.danger }}>{` −${trace.removed ?? 0}`}</Text></Text>}
        </Text>
        {!!took && <Text style={[textStyle.caption, styles.tabular, { color: colors.faint }]}>{took}</Text>}
        <StatusMark status={tool.status} color={colors.faint} />
        <Chevron expanded={open} size={10} />
      </PressScale>
      <Collapse expanded={open}>
        {trace.kind === 'mcp'
          ? <View style={[styles.toolBody, { backgroundColor: colors.fill, borderColor: colors.border }]}><McpBody tool={tool} fields={fields} own={trace.own} /></View>
          : <ToolBody tool={tool} kind={trace.kind} fields={fields} />}
      </Collapse>
    </View>
  );
});

function ToolBody({ tool, kind, fields }: { tool: ToolActivity; kind: TraceKind; fields: Record<string, unknown> }) {
  const colors = useColors();
  const card = (() => {
    if (kind === 'edit') return <Diff fields={fields} />;
    if (kind === 'todo') { const todos = todosOf(fields); return todos.length ? <Checklist todos={todos} /> : null; }
    if (kind === 'shell') {
      const command = shellCommand(tool.input, fields);
      const { code, body } = exitCode(tool.output);
      return (
        <>
          {!!command && <Code text={`$ ${command}`} />}
          {code !== undefined && <Text style={[styles.exit, { color: code ? colors.danger : colors.muted }]}>{`exit ${code}`}</Text>}
          {!!body.trim() && <Code text={tail(body)} />}
        </>
      );
    }
    return null;
  })();
  return (
    <View style={[styles.toolBody, { backgroundColor: colors.fill, borderColor: colors.border }]}>
      {card ?? <>
        {!!tool.input && <Code text={tool.input} />}
        {!!tool.output && <Code text={tool.output} />}
      </>}
      {!tool.output.trim() && kind !== 'edit' && kind !== 'todo' && (
        <Text style={[styles.note, { color: colors.muted }]}>{tool.status === 'running' ? 'Waiting for output…' : 'No output was returned.'}</Text>
      )}
    </View>
  );
}

/** The last PREVIEW_LINES lines of a command's output. */
const tail = (text: string) => {
  const lines = text.trimEnd().split('\n');
  return lines.length > PREVIEW_LINES ? `…\n${lines.slice(-PREVIEW_LINES).join('\n')}` : lines.join('\n');
};

export function Code({ text }: { text: string }) {
  const colors = useColors();
  const shown = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Text selectable style={[styles.code, { color: colors.text }]}>{shown}</Text>
    </ScrollView>
  );
}

/** An edit's removed and added lines, red and green, as the desktop's diff card. */
function Diff({ fields }: { fields: Record<string, unknown> }) {
  const colors = useColors();
  const lines = useMemo(() => diffLines(fields), [fields]);
  if (!lines.length) return <Text style={[styles.note, { color: colors.muted }]}>No changes were recorded.</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.diffScroll}>
      <View style={styles.diffLines}>
        {lines.slice(0, DIFF_LINES).map((line, i) => (
          <Text key={i} style={[styles.code, { color: colors.text, backgroundColor: line.kind === 'add' ? colors.successFill : colors.dangerFill }]}>{`${line.kind === 'add' ? '+' : '-'} ${line.text}`}</Text>
        ))}
        {lines.length > DIFF_LINES && <Text style={[styles.note, { color: colors.muted }]}>{`+${lines.length - DIFF_LINES} more line${lines.length - DIFF_LINES === 1 ? '' : 's'}`}</Text>}
      </View>
    </ScrollView>
  );
}

const TODO_ICONS: Record<string, IconName> = {
  completed: { ios: 'checkmark.circle.fill', android: 'check_circle' },
  in_progress: { ios: 'circle.dotted.circle', android: 'radio_button_checked' },
  pending: { ios: 'circle', android: 'radio_button_unchecked' },
};

/** A todo's mark: springs in when its status changes, not when the list first draws. */
function TodoMark({ status }: { status: Todo['status'] }) {
  const colors = useColors();
  const reduced = useReducedMotion();
  const color = status === 'completed' ? colors.success : status === 'in_progress' ? colors.text : colors.faint;
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={status} entering={reduced ? crossFadeIn : TICK_IN}>
        <PulsingIcon icon={TODO_ICONS[status] ?? TODO_ICONS.pending} running={status === 'in_progress'} size={16} color={color} />
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

function Checklist({ todos }: { todos: readonly Todo[] }) {
  const colors = useColors();
  return (
    <View style={styles.todos}>
      {todos.map((todo, i) => {
        const done = todo.status === 'completed';
        const doing = todo.status === 'in_progress';
        return (
          <View key={i} style={styles.todo} accessible accessibilityLabel={`${todo.text}, ${done ? 'done' : doing ? 'in progress' : 'to do'}`}>
            <TodoMark status={todo.status} />
            <Text style={[doing ? textStyle.subheadMedium : textStyle.subhead, styles.flex, { color: done ? colors.muted : colors.text }, done && styles.struck]}>{todo.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** The run's plan, updated in place by each TodoWrite/update_plan call. */
export const PlanCard = memo(function PlanCard({ todos }: { todos: readonly Todo[] }) {
  const colors = useColors();
  const done = todos.filter(t => t.status === 'completed').length;
  return (
    <CardSection title="Plan" style={styles.card} trailing={<CrossFadeText text={`${done} of ${todos.length} done`} style={[textStyle.footnote, styles.tabular, { color: colors.faint }]} />}>
      <Checklist todos={todos} />
    </CardSection>
  );
});

/** A minute-ish clock for running things, ticking every TICK_MS. */
export function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

const SUB_LABEL: Record<Subagent['status'], string> = { running: 'Working', waiting: 'Waiting', completed: 'Done', failed: 'Failed', stopped: 'Stopped' };

/** One subagent: name, live status with its current tool, elapsed time and tool count; open for its tools and reply. */
export const SubagentPanel = memo(function SubagentPanel({ agent }: { agent: Subagent }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const live = subagentActive(agent);
  const now = useNow(live);
  const current = agent.tools.findLast(t => t.status === 'running');
  const trace = current ? describeTool(current) : undefined;
  const elapsed = agent.startedAt ? elapsedLabel((live ? now : agent.updatedAt || now) - agent.startedAt) : '';
  const status = live && trace ? [trace.verb, trace.chip, trace.object].filter(Boolean).join(' ') : !live && agent.tools.length ? summarizeTools(agent.tools) : SUB_LABEL[agent.status];
  const color = agent.status === 'failed' ? colors.danger : agent.status === 'waiting' ? colors.warning : colors.muted;
  return (
    <Card style={styles.card}>
      <InnerCard>
        <PressScale onPress={() => setOpen(o => !o)} style={styles.subHead} accessibilityState={{ expanded: open }}
          accessibilityLabel={`Subagent ${subagentName(agent)}, ${SUB_LABEL[agent.status]}, ${status}`}>
          <View style={styles.subTop}>
            <StatusMark status={agent.status} color={colors.success} />
            <Text style={[textStyle.subheadMedium, styles.flex, { color: colors.text }]} numberOfLines={1}>{subagentName(agent)}</Text>
            <Text style={[textStyle.footnote, styles.tabular, { color: colors.faint }]}>{[elapsed, agent.tools.length ? `${agent.tools.length} tool${agent.tools.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</Text>
            <Chevron expanded={open} size={10} />
          </View>
          <CrossFadeText text={status} numberOfLines={1} style={[textStyle.footnote, styles.subStatus, { color }]} />
        </PressScale>
        <Collapse expanded={open}>
          <View style={styles.subBody}>
            {!!agent.prompt && <Text style={[textStyle.footnote, styles.indent, { color: colors.muted }]} numberOfLines={4}>{agent.prompt}</Text>}
            {agent.tools.map(t => <ToolRow key={t.id} tool={t} />)}
            {!!agent.response.trim() && <Text selectable style={[textStyle.subhead, styles.indent, { color: colors.text }]} numberOfLines={12}>{agent.response.trim()}</Text>}
          </View>
        </Collapse>
      </InnerCard>
    </Card>
  );
});

/** The model thinking: one quiet line pulsing gently, open for the whole status text. */
export function ThinkingLine({ text }: { text: string }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const pulse = usePulseStyle(!open, THINKING_PULSE_MIN);
  return (
    <PressScale onPress={() => setOpen(o => !o)} style={styles.thinkingPress} accessibilityState={{ expanded: open }} accessibilityLabel={`Thinking: ${text}`}>
      <Animated.View style={[styles.thinking, pulse]}>
        <Icon ios="brain" android="psychology" size={14} color={colors.muted} />
        <Text style={[textStyle.footnote, styles.flex, { color: colors.muted }]} numberOfLines={open ? undefined : 1}>{text}</Text>
      </Animated.View>
    </PressScale>
  );
}

/** Tool calls in a row, in an inner card: older groups fold behind their summary sentence, the newest
 * stays open. A lone call has no summary, in the same tree, so a row left open stays open when a second joins it. */
export const ToolGroup = memo(function ToolGroup({ items, initiallyOpen }: { items: readonly { tool: ToolActivity; startedAt?: number; endedAt?: number }[]; initiallyOpen: boolean }) {
  const colors = useColors();
  // Follows initiallyOpen, so a group folds once it stops being the newest, until the user decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? initiallyOpen;
  const several = items.length > 1;
  const failed = items.some(i => i.tool.status === 'failed');
  return (
    <InnerCard>
      {several && (
        <PressScale onPress={() => setToggled(!open)} style={styles.toolHead} accessibilityLabel={summarizeTools(items.map(i => i.tool))} accessibilityState={{ expanded: open }}>
          <Icon ios="square.stack.3d.up" android="stacks" size={15} color={failed ? colors.danger : colors.muted} />
          <Text style={[textStyle.subhead, styles.flex, { color: colors.muted }]} numberOfLines={1}>{summarizeTools(items.map(i => i.tool))}</Text>
          <Chevron expanded={open} size={10} />
        </PressScale>
      )}
      <Collapse expanded={!several || open}>
        {items.map((i, n) => <ToolRow key={i.tool.id || n} tool={i.tool} startedAt={i.startedAt} endedAt={i.endedAt} />)}
      </Collapse>
    </InnerCard>
  );
});

const styles = StyleSheet.create({
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 38, paddingHorizontal: 10, paddingVertical: 5 },
  sentence: { flex: 1 },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  diffScroll: { flexGrow: 1 },
  diffLines: { flexGrow: 1 },
  toolBody: { borderRadius: 10, borderWidth: geometry.hairline, padding: 10, gap: 8, marginHorizontal: 6, marginBottom: 6, borderCurve: 'continuous' },
  code: { ...textStyle.caption, fontFamily: mono },
  exit: { ...textStyle.caption, fontFamily: mono, fontWeight: '600' },
  note: textStyle.footnote,
  card: { marginVertical: 4 },
  subHead: { paddingHorizontal: 10, paddingVertical: 8 },
  subTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subStatus: { marginTop: 2, marginLeft: 20 },
  subBody: { paddingBottom: 6, gap: 2 },
  indent: { paddingHorizontal: 10, paddingVertical: 4 },
  todos: { gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  todo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  struck: { textDecorationLine: 'line-through' },
  thinkingPress: { paddingVertical: 5 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
