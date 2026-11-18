// Generative UI fences drawn natively, matching the desktop (src/generative-ui-components.ts).
// Parsing is pure and memoized by source (parseBlock in src/store/generative.ts); a view that
// throws while drawing falls back to its source, so a row never crashes.
import { Component, memo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { parseBlock, type Panel, type Status, type TreeItem, type View as Spec } from '../../store/generative.ts';
import { ReplyImage } from '../Attachments.tsx';
import { useColors } from '../theme.ts';
import { Card, CardSection, Chevron, Collapse, geometry, InnerCard, PressScale, Row, Segmented, Skeleton, type as textStyle } from '../ds/index.ts';
import { Icon } from '../Icon.tsx';
import type { Colors } from '../theme.ts';
import { Chart, Spark } from './Chart.tsx';
import { CodeBox, DiffBox } from './Code.tsx';
import { Actions, Chips, styles as shared, Title } from './common.tsx';
import { Form } from './Form.tsx';
import { Body } from './MarkdownText.tsx';

export const GenerativeBlock = memo(function GenerativeBlock({ lang, source, pending }: { lang: string; source: string; pending: boolean }) {
  if (pending) return <View style={styles.pending} accessible accessibilityLabel="Building view"><Skeleton height={64} radius={geometry.innerRadius} /></View>;
  const block = parseBlock(lang, source);
  const fallback = <Failed message="This view could not be shown." source={source} />;
  return (
    <Guard fallback={fallback}>
      <View style={styles.block}>
        {block.kind === 'view' ? <Node spec={block.view} />
          : block.kind === 'code' ? <CodeBox label={block.label} code={block.code} />
            : block.kind === 'error' ? <Failed message={block.message} source={block.source} />
              : <Note icon={block.kind === 'svg' ? 'scribble' : 'chevron.left.forwardslash.chevron.right'} title={block.kind === 'svg' ? 'Diagram' : 'Static HTML'} body="View it on the desktop." />}
      </View>
    </Guard>
  );
});

class Guard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Failed({ message, source }: { message: string; source: string }) {
  const colors = useColors();
  return <View style={styles.gap}><Text style={[styles.small, { color: colors.danger }]}>{message}</Text><CodeBox code={source} /></View>;
}

function Note({ icon, title, body }: { icon: Parameters<typeof Icon>[0]['ios']; title?: string; body: string }) {
  const colors = useColors();
  return (
    <InnerCard>
      <Row leading={<Icon ios={icon} android="desktop_windows" size={18} color={colors.muted} />} title={title ?? body} subtitle={title ? body : undefined} />
    </InnerCard>
  );
}

const TONE = (colors: Colors): Record<string, ColorValue> => ({ info: colors.info, success: colors.success, warning: colors.warning, danger: colors.danger, note: colors.muted });
const STATUS: Record<Status, { ios: Parameters<typeof Icon>[0]['ios']; android: Parameters<typeof Icon>[0]['android']; color: keyof Colors }> = {
  done: { ios: 'checkmark.circle.fill', android: 'check_circle', color: 'success' },
  active: { ios: 'circle.dotted.circle', android: 'radio_button_checked', color: 'text' },
  pending: { ios: 'circle', android: 'radio_button_unchecked', color: 'faint' },
  error: { ios: 'xmark.circle.fill', android: 'cancel', color: 'danger' },
  skipped: { ios: 'minus.circle', android: 'do_not_disturb_on', color: 'faint' },
};

const Markdown = ({ text }: { text?: string }) => (text ? <Body text={text} /> : null);

function Node({ spec }: { spec: Spec }): ReactNode {
  const colors = useColors();
  switch (spec.type) {
    case 'markdown': return <Markdown text={spec.text} />;
    case 'callout': {
      const tone = TONE(colors)[spec.tone];
      return <InnerCard style={styles.panel} accessibilityRole={spec.tone === 'danger' || spec.tone === 'warning' ? 'alert' : undefined}>
        {!!spec.title && <Text style={[shared.title, { color: tone }]}>{spec.title}</Text>}<Markdown text={spec.body} />
      </InnerCard>;
    }
    case 'card': return <CardSection title={spec.title} footer={spec.footer ? <Text style={[styles.small, { color: colors.muted }]}>{spec.footer}</Text> : undefined}>
      <View style={styles.panel}><Markdown text={spec.body} />{spec.children.map((child, i) => <Node key={i} spec={child} />)}<Actions items={spec.actions} /></View>
    </CardSection>;
    case 'stats': return <View style={styles.grid}>{spec.items.map((item, i) => (
      <InnerCard key={i} style={styles.stat}>
        <Text style={[styles.small, { color: colors.muted }]} numberOfLines={1}>{item.label}</Text>
        <Text style={[styles.value, { color: colors.text }]} numberOfLines={1}>{item.value}</Text>
        {!!item.delta && <Text style={[styles.small, { color: item.trend === 'up' ? colors.success : item.trend === 'down' ? colors.danger : colors.muted }]}>{`${item.trend === 'up' ? '▲' : item.trend === 'down' ? '▼' : '•'} ${item.delta}`}</Text>}
        {item.spark && <Spark values={item.spark} />}
        {!!item.hint && <Text style={[styles.small, { color: colors.faint }]}>{item.hint}</Text>}
      </InnerCard>
    ))}</View>;
    case 'table': return <Table spec={spec} />;
    case 'chart': return <InnerCard style={styles.panel}><Chart spec={spec} /></InnerCard>;
    case 'progress': {
      const percent = Math.round((spec.value / spec.max) * 100);
      return <View style={styles.gap} accessible accessibilityRole="progressbar" accessibilityLabel={spec.label ?? 'Progress'} accessibilityValue={{ min: 0, max: spec.max, now: spec.value }}>
        <View style={styles.between}><Text style={[styles.body, { color: colors.text }]}>{spec.label ?? 'Progress'}</Text><Text style={[styles.body, { color: colors.muted }]}>{`${percent}%`}</Text></View>
        <View style={[styles.track, { backgroundColor: colors.fill }]}><View style={[styles.fillBar, { width: `${percent}%`, backgroundColor: colors.primary }]} /></View>
        {!!spec.note && <Text style={[styles.small, { color: colors.muted }]}>{spec.note}</Text>}
      </View>;
    }
    case 'steps': case 'plan': case 'timeline': return <View style={styles.gap}>
      <Title text={spec.title ?? (spec.type === 'plan' ? 'Plan' : undefined)} /><Markdown text={spec.summary} />
      {spec.items.map((step, i) => {
        const status = STATUS[step.status];
        return <View key={i} style={styles.step} accessible accessibilityLabel={`${step.title} (${step.status})`}>
          <Icon ios={status.ios} android={status.android} size={17} color={colors[status.color]} />
          <View style={styles.flex}>
            {!!step.time && <Text style={[styles.small, { color: colors.faint }]}>{step.time}</Text>}
            <Text style={[styles.body, { color: step.status === 'skipped' ? colors.faint : colors.text, textDecorationLine: step.status === 'skipped' ? 'line-through' : 'none' }]}>{step.title}</Text>
            <Markdown text={step.detail} />
          </View>
        </View>;
      })}
      <Actions items={spec.actions} />
    </View>;
    case 'checklist': {
      const done = spec.items.filter(item => item.done).length;
      return <View style={styles.gap}>
        <Title text={spec.title ? `${spec.title} · ${done}/${spec.items.length}` : undefined} />
        {spec.items.map((item, i) => <View key={i} style={styles.step} accessible accessibilityLabel={`${item.text}, ${item.done ? 'done' : 'not done'}`}>
          <Icon ios={item.done ? 'checkmark.square.fill' : 'square'} android={item.done ? 'check_box' : 'check_box_outline_blank'} size={17} color={item.done ? colors.success : colors.faint} />
          <Text style={[styles.body, styles.flex, { color: item.done ? colors.muted : colors.text }]}>{item.text}</Text>
        </View>)}
      </View>;
    }
    case 'tabs': return <Tabs items={spec.items} />;
    case 'accordion': return <View style={styles.gap}>{spec.items.map((item, i) => <Fold key={i} item={item} />)}</View>;
    case 'tree': return <View style={styles.gap}><Title text={spec.title} /><Branch items={spec.items} depth={0} /></View>;
    case 'diff': return <DiffBox file={spec.file} diff={spec.diff} />;
    case 'code': return <CodeBox label={spec.file ?? spec.language} code={spec.code} />;
    case 'terminal': return <CodeBox label={spec.exitCode === undefined ? 'Terminal' : `Exit ${spec.exitCode}`} command={spec.command} code={spec.output} />;
    case 'compare': return <View style={styles.gap}><Title text={spec.title} />{spec.items.map((item, i) => (
      <InnerCard key={i} style={styles.panel}>
        <Title text={item.title} />
        {item.pros.map((text, j) => <Point key={`p${j}`} good text={text} />)}
        {item.cons.map((text, j) => <Point key={`c${j}`} text={text} />)}
        {!!item.verdict && <Text style={[styles.small, { color: colors.muted }]}>{item.verdict}</Text>}
      </InnerCard>
    ))}</View>;
    case 'gallery': return <View style={styles.gap}>{spec.images.map((image, i) => <View key={i} style={styles.gap}><ReplyImage alt={image.caption ?? ''} path={image.path} />{!!image.caption && <Text style={[styles.small, { color: colors.muted }]}>{image.caption}</Text>}</View>)}</View>;
    case 'actions': return <View style={styles.gap}>{!!spec.label && <Text style={[styles.small, { color: colors.muted }]}>{spec.label}</Text>}<Actions items={spec.buttons} /></View>;
    case 'chips': return <Chips options={spec.options} label={spec.label} />;
    case 'form': return <Form spec={spec} />;
    case 'stack': return <View style={styles.gap}>{spec.children.map((child, i) => <Node key={i} spec={child} />)}</View>;
    // ponytail: phones get at most 2 columns; a wider grid wraps.
    case 'grid': return <View style={styles.grid}>{spec.children.map((child, i) => <View key={i} style={{ width: spec.columns > 1 ? '48%' : '100%' }}><Node spec={child} /></View>)}</View>;
    case 'custom': return <Note icon="macwindow" title={spec.title ?? 'Interactive view'} body="Interactive view, open on the desktop." />;
    case 'unknown': return <Failed message={`PandaCode has no “${spec.name}” view. Showing its data instead.`} source={spec.raw} />;
  }
}

function Point({ text, good }: { text: string; good?: boolean }) {
  const colors = useColors();
  return <View style={styles.step} accessible accessibilityLabel={`${good ? 'Pro' : 'Con'}: ${text}`}>
    <Icon ios={good ? 'plus.circle.fill' : 'minus.circle.fill'} android={good ? 'add_circle' : 'do_not_disturb_on'} size={15} color={good ? colors.success : colors.danger} />
    <Text style={[styles.body, styles.flex, { color: colors.text }]}>{text}</Text>
  </View>;
}

const COLUMN = { min: 72, max: 220, char: 7.5 };
function Table({ spec }: { spec: Extract<Spec, { type: 'table' }> }) {
  const colors = useColors();
  const widths = spec.columns.map((column, i) => Math.min(COLUMN.max, Math.max(COLUMN.min, Math.max(column.label.length, ...spec.rows.map(row => row[i].length)) * COLUMN.char + 16)));
  const cell = (text: string, i: number, head?: boolean) => (
    <Text key={i} style={[styles.cell, { width: widths[i], textAlign: spec.columns[i].align, color: head ? colors.muted : colors.text, fontWeight: head ? '600' : '400' }]}>{text}</Text>
  );
  return <View style={styles.gap}>
    <Title text={spec.title} />
    <ScrollView horizontal directionalLockEnabled>
      <View style={[styles.table, { borderColor: colors.separator }]}>
        <View style={[styles.tr, { backgroundColor: colors.fill }]}>{spec.columns.map((column, i) => cell(column.label, i, true))}</View>
        {spec.rows.map((row, r) => <View key={r} style={[styles.tr, { borderColor: colors.separator }, styles.rule]}>{row.map((text, i) => cell(text, i))}</View>)}
      </View>
    </ScrollView>
  </View>;
}


const PanelBody = ({ item }: { item: Panel }) => <View style={styles.gap}><Markdown text={item.body} />{item.children.map((child, i) => <Node key={i} spec={child} />)}</View>;

/** The system's segmented shape takes this many labels on a phone; more scroll sideways. */
const SEGMENTED_TABS = 4;

function Tabs({ items }: { items: Panel[] }) {
  const colors = useColors();
  const [index, setIndex] = useState(0);
  return <View style={styles.gap}>
    {items.length <= SEGMENTED_TABS
      ? <Segmented options={items.map((item, i) => ({ value: String(i), label: item.label }))} value={String(index)} onChange={value => setIndex(Number(value))} accessibilityLabel="Tabs" />
      : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.segments, { backgroundColor: colors.track }]}>
        {items.map((item, i) => (
          <Pressable key={i} onPress={() => setIndex(i)} accessibilityRole="tab" accessibilityState={{ selected: i === index }} style={[styles.segment, i === index && { backgroundColor: colors.thumb }]}>
            <Text style={[i === index ? textStyle.subheadMedium : textStyle.subhead, { color: i === index ? colors.text : colors.muted }]}>{item.label}</Text>
          </Pressable>
        ))}
      </ScrollView>}
    <PanelBody item={items[index] ?? items[0]} />
  </View>;
}

function Fold({ item }: { item: Panel }) {
  const colors = useColors();
  const [open, setOpen] = useState(!!item.open);
  return <Card>
    <PressScale onPress={() => setOpen(o => !o)} accessibilityState={{ expanded: open }} style={[styles.between, styles.foldHead]}>
      <Text style={[shared.title, styles.flex, { color: colors.text }]}>{item.label}</Text>
      <Chevron expanded={open} />
    </PressScale>
    <Collapse expanded={open}><InnerCard style={styles.panel}><PanelBody item={item} /></InnerCard></Collapse>
  </Card>;
}

function Branch({ items, depth }: { items: TreeItem[]; depth: number }) {
  return <>{items.map((item, i) => <TreeRow key={i} item={item} depth={depth} />)}</>;
}

function TreeRow({ item, depth }: { item: TreeItem; depth: number }) {
  const colors = useColors();
  const [open, setOpen] = useState(true);
  const folder = item.children.length > 0;
  return <>
    <Pressable disabled={!folder} onPress={() => setOpen(o => !o)} accessibilityState={folder ? { expanded: open } : undefined} style={[styles.treeRow, { paddingLeft: depth * 16 }]}>
      <Icon ios={folder ? (open ? 'folder.fill' : 'folder') : 'doc'} android={folder ? 'folder' : 'description'} size={14} color={colors.muted} />
      <Text style={[styles.mono, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
      {!!item.status && <Text style={[styles.badge, { color: colors.muted, backgroundColor: colors.fill }]}>{item.status}</Text>}
      {!!item.note && <Text style={[styles.small, styles.flex, { color: colors.faint }]} numberOfLines={1}>{item.note}</Text>}
    </Pressable>
    {folder && open && <Branch items={item.children} depth={depth + 1} />}
  </>;
}

const styles = StyleSheet.create({
  block: { marginBottom: 10, gap: 8 },
  pending: { height: 64, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  gap: { gap: 6 },
  flex: { flex: 1 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  panel: { padding: 12, gap: 8 },
  foldHead: { minHeight: 40, paddingHorizontal: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, flexBasis: '45%', gap: 2, padding: 10 },
  value: textStyle.title3,
  body: textStyle.subhead,
  small: textStyle.caption,
  mono: { ...textStyle.code, flexShrink: 1 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fillBar: { height: 8, borderRadius: 4 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  table: { borderWidth: geometry.hairline, borderRadius: 10, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  rule: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { ...textStyle.footnote, paddingHorizontal: 8, paddingVertical: 6 },
  segments: { flexDirection: 'row', borderRadius: 10, padding: 2, gap: 2 },
  segment: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  treeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3 },
  badge: { ...textStyle.caption, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden' },
});
