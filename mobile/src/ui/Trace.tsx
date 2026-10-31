// Agent traces as the desktop draws them (src/tool-activity.ts, src/subagents.ts): one sentence per
// tool call with its kind's icon, status and duration, tapping open to a diff, checklist, command
// output or the raw input/output; subagent panels; the run's checklist; the Thinking line.
// Every row is memoized on its (immutable) tool object, so a live event re-renders only what changed.
import { memo, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import type { ToolActivity } from '../connect/types.ts';
import { elapsedLabel } from '../store/inbox.ts';
import { describeTool, DIFF_LINES, diffLines, exitCode, parseFields, shellCommand, subagentActive, subagentName, summarizeTools, todosOf, type Subagent, type Todo, type TraceKind } from '../store/trace.ts';
import { duration } from '../store/turns.ts';
import { Icon } from './Icon.tsx';
import { McpBody, useWorkerNames } from './ToolCards.tsx';
import { mono, useColors } from './theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;
const MAX_OUTPUT = 6000;
const PREVIEW_LINES = 12;
/** Running subagents' elapsed time ticks this often. */
const TICK_MS = 15_000;
const ADD_FILL = 'rgba(52, 199, 89, 0.16)';
const DEL_FILL = 'rgba(255, 59, 48, 0.14)';

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

/** Spinner while running, a check when done, a red cross when it failed. */
export function StatusMark({ status, color }: { status: ToolActivity['status'] | Subagent['status']; color: ColorValue }) {
  const colors = useColors();
  if (status === 'running') return <ActivityIndicator size="small" style={styles.small} />;
  if (status === 'waiting') return <Icon ios="hand.raised.fill" android="front_hand" size={12} color={colors.orange} />;
  if (status === 'failed') return <Icon ios="xmark.circle.fill" android="cancel" size={13} color={colors.red} />;
  if (status === 'stopped') return <Icon ios="stop.circle" android="stop_circle" size={13} color={colors.secondary} />;
  return <Icon ios="checkmark" android="check" size={11} color={color} />;
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
    <View style={styles.tool}>
      <Pressable onPress={() => setOpen(o => !o)} style={styles.toolHead} hitSlop={4}
        accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${trace.verb} ${trace.chip} ${trace.object}, ${tool.status}${took ? `, ${took}` : ''}`}>
        <Icon {...traceIcon(trace.kind, trace.own)} size={13} color={failed ? colors.red : colors.secondary} />
        <Text style={styles.sentence} numberOfLines={1}>
          <Text style={[styles.verb, { color: failed ? colors.red : colors.secondary }]}>{trace.verb}</Text>
          {!!trace.chip && <Text style={[styles.chip, { color: colors.text }]}>{`  ${trace.chip}`}</Text>}
          {!!trace.object && <Text style={[trace.kind === 'shell' ? styles.chip : styles.object, { color: colors.tertiary }]}>{`  ${trace.object}`}</Text>}
          {trace.added !== undefined && <Text style={styles.delta}><Text style={{ color: colors.green }}>{`  +${trace.added}`}</Text><Text style={{ color: colors.red }}>{` −${trace.removed ?? 0}`}</Text></Text>}
        </Text>
        {!!took && <Text style={[styles.took, { color: colors.tertiary }]}>{took}</Text>}
        <StatusMark status={tool.status} color={colors.tertiary} />
      </Pressable>
      {open && (trace.kind === 'mcp'
        ? <View style={[styles.toolBody, { backgroundColor: colors.fill }]}><McpBody tool={tool} fields={fields} own={trace.own} /></View>
        : <ToolBody tool={tool} kind={trace.kind} fields={fields} />)}
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
          {code !== undefined && <Text style={[styles.exit, { color: code ? colors.red : colors.secondary }]}>{`exit ${code}`}</Text>}
          {!!body.trim() && <Code text={tail(body)} />}
        </>
      );
    }
    return null;
  })();
  return (
    <View style={[styles.toolBody, { backgroundColor: colors.fill }]}>
      {card ?? <>
        {!!tool.input && <Code text={tool.input} />}
        {!!tool.output && <Code text={tool.output} />}
      </>}
      {!tool.output.trim() && kind !== 'edit' && kind !== 'todo' && (
        <Text style={[styles.note, { color: colors.secondary }]}>{tool.status === 'running' ? 'Waiting for output…' : 'No output was returned.'}</Text>
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
  if (!lines.length) return <Text style={[styles.note, { color: colors.secondary }]}>No changes were recorded.</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {lines.slice(0, DIFF_LINES).map((line, i) => (
          <Text key={i} style={[styles.code, { color: colors.text, backgroundColor: line.kind === 'add' ? ADD_FILL : DEL_FILL }]}>{`${line.kind === 'add' ? '+' : '-'} ${line.text}`}</Text>
        ))}
        {lines.length > DIFF_LINES && <Text style={[styles.note, { color: colors.secondary }]}>+{lines.length - DIFF_LINES} more lines</Text>}
      </View>
    </ScrollView>
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
            {done ? <Icon ios="checkmark.circle.fill" android="check_circle" size={15} color={colors.green} />
              : doing ? <Icon ios="circle.dotted.circle" android="radio_button_checked" size={15} color={colors.tint} />
              : <Icon ios="circle" android="radio_button_unchecked" size={15} color={colors.tertiary} />}
            <Text style={[styles.todoText, { color: done ? colors.secondary : colors.text, fontWeight: doing ? '600' : '400' }, done && styles.struck]}>{todo.text}</Text>
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
    <View style={[styles.card, { backgroundColor: colors.fill }]}>
      <View style={styles.cardHead}>
        <Icon ios="checklist" android="checklist" size={14} color={colors.secondary} />
        <Text style={[styles.cardTitle, { color: colors.text }]}>Plan</Text>
        <Text style={[styles.cardMeta, { color: colors.secondary }]}>{done} of {todos.length} done</Text>
      </View>
      <Checklist todos={todos} />
    </View>
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
  const color = agent.status === 'failed' ? colors.red : agent.status === 'waiting' ? colors.orange : colors.secondary;
  return (
    <View style={[styles.card, { backgroundColor: colors.fill }, !live && styles.doneCard]}>
      <Pressable onPress={() => setOpen(o => !o)} style={styles.cardHead} accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={`Subagent ${subagentName(agent)}, ${SUB_LABEL[agent.status]}, ${status}`}>
        <StatusMark status={agent.status} color={colors.green} />
        <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>{subagentName(agent)}</Text>
        <Text style={[styles.cardMeta, { color: colors.secondary }]}>{[elapsed, agent.tools.length ? `${agent.tools.length} tool${agent.tools.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</Text>
        <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={11} color={colors.secondary} />
      </Pressable>
      <Text style={[styles.subStatus, { color }]} numberOfLines={1}>{status}</Text>
      {open && (
        <View style={styles.subBody}>
          {!!agent.prompt && <Text style={[styles.note, { color: colors.secondary }]} numberOfLines={4}>{agent.prompt}</Text>}
          {agent.tools.map(t => <ToolRow key={t.id} tool={t} />)}
          {!!agent.response.trim() && <Text selectable style={[styles.response, { color: colors.text }]} numberOfLines={12}>{agent.response.trim()}</Text>}
        </View>
      )}
    </View>
  );
});

/** The model thinking: one quiet line, open for the whole status text. */
export function ThinkingLine({ text }: { text: string }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(o => !o)} style={styles.thinking} accessibilityRole="button" accessibilityState={{ expanded: open }}>
      <Icon ios="brain" android="psychology" size={13} color={colors.secondary} />
      <Text style={[styles.object, styles.flex, { color: colors.secondary }]} numberOfLines={open ? undefined : 1}>{text}</Text>
    </Pressable>
  );
}

/** Tool calls in a row: older groups fold behind their summary sentence, the newest stays open. */
export const ToolGroup = memo(function ToolGroup({ items, initiallyOpen }: { items: readonly { tool: ToolActivity; startedAt?: number; endedAt?: number }[]; initiallyOpen: boolean }) {
  const colors = useColors();
  const [open, setOpen] = useState(initiallyOpen);
  if (items.length === 1) return <ToolRow tool={items[0].tool} startedAt={items[0].startedAt} endedAt={items[0].endedAt} />;
  const failed = items.some(i => i.tool.status === 'failed');
  return (
    <View>
      <Pressable onPress={() => setOpen(o => !o)} style={styles.toolHead} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Icon ios="square.stack.3d.up" android="stacks" size={13} color={failed ? colors.red : colors.secondary} />
        <Text style={[styles.verb, styles.flex, { color: colors.secondary }]} numberOfLines={1}>{summarizeTools(items.map(i => i.tool))}</Text>
        <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={11} color={colors.secondary} />
      </Pressable>
      {open && <View style={[styles.group, { borderColor: colors.separator }]}>{items.map((i, n) => <ToolRow key={i.tool.id || n} tool={i.tool} startedAt={i.startedAt} endedAt={i.endedAt} />)}</View>}
    </View>
  );
});

const styles = StyleSheet.create({
  tool: { marginVertical: 1 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  sentence: { flex: 1 },
  flex: { flex: 1 },
  verb: { fontSize: 13.5, fontWeight: '500' },
  chip: { fontSize: 12.5, fontFamily: mono },
  object: { fontSize: 13 },
  delta: { fontSize: 12.5, fontFamily: mono },
  took: { fontSize: 12, fontVariant: ['tabular-nums'] },
  toolBody: { borderRadius: 10, padding: 10, gap: 8, marginBottom: 4, borderCurve: 'continuous' },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 16 },
  exit: { fontFamily: mono, fontSize: 12, fontWeight: '600' },
  note: { fontSize: 13, lineHeight: 18 },
  group: { borderLeftWidth: 2, paddingLeft: 10, marginLeft: 5 },
  card: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, marginVertical: 4, borderCurve: 'continuous' },
  doneCard: { opacity: 0.8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 14.5, fontWeight: '600' },
  cardMeta: { fontSize: 12.5, fontVariant: ['tabular-nums'] },
  subStatus: { fontSize: 13, marginTop: 3, marginLeft: 22 },
  subBody: { marginTop: 6, gap: 2 },
  response: { fontSize: 13.5, lineHeight: 19, marginTop: 4 },
  todos: { gap: 6, marginTop: 6 },
  todo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  todoText: { flex: 1, fontSize: 14, lineHeight: 19 },
  struck: { textDecorationLine: 'line-through' },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  small: { transform: [{ scale: 0.7 }], width: 14, height: 14 },
});
