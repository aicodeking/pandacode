// Task info sheet: project, branch, computer, harness, status and when it last ran. The sheet fits
// this content (root layout), so the page scrolls only at the largest text sizes.
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { taskKey, useConnect, useModels } from '../store/index.ts';
import { BranchChip, EmptyState, Group, lastActiveLabel, LARGE_TEXT_SCALE, geometry, Row, StatusDot, type as text, type Tone } from '../ui/ds/index.ts';
import { Glyph, useSheetTop } from '../ui/FormParts.tsx';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { modelLabel, useModelOptions } from '../ui/models.ts';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { useColors } from '../ui/theme.ts';

const STATUS: Record<string, { label: string; tone?: Tone; pulse?: boolean }> = {
  idle: { label: 'Finished', tone: 'success' },
  running: { label: 'Working', tone: 'running', pulse: true },
  waiting: { label: 'Needs you', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  stopped: { label: 'Stopped' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
};

export default function TaskInfo() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const top = useSheetTop();
  const task = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session));
  const computer = useConnect(s => s.devices.find(d => d.id === device));
  const live = useConnect(s => s.live[taskKey(device, session)]?.status);
  const models = useModels(device, task?.provider ?? '');
  useModelOptions(device, task?.provider ?? '');
  if (!task) return <EmptyState icon={{ ios: 'hourglass', android: 'hourglass_empty' }} title="This task is not loaded yet." />;
  const status = live && live !== 'idle' ? live : task.status;
  const state = STATUS[status] ?? { label: status };
  const project = task.chat ? 'Chat' : task.projectName;
  const at = task.lastPromptAt ?? task.updatedAt;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top }]} bounces={false}>
      <Text style={[text.title3, styles.title, { color: colors.text }]} selectable>{task.title || 'Untitled task'}</Text>
      <Group>
        <Row leading={<ProjectTile deviceId={device} projectId={task.chat ? undefined : task.projectId} name={project} size={20} />} title="Project" trailing={<Value text={project} />} />
        <Row leading={<Glyph icon={{ ios: 'arrow.triangle.branch', android: 'call_split' }} />} title="Branch" trailing={task.branch ? <BranchChip branch={task.branch} style={styles.value} /> : <Value text="—" />} />
        <Row leading={<Glyph icon={{ ios: 'desktopcomputer', android: 'computer' }} />} title="Computer" trailing={<Value text={`${computer?.name ?? '—'}${computer && !computer.online ? ' (offline)' : ''}`} />} />
        <Row leading={<HarnessLogo id={task.provider} size={20} />} title="Agent" trailing={<Value text={`${harnessName(task.provider)}${task.model !== 'default' ? ` · ${modelLabel(task.model, models)}` : ''}`} />} />
        <Row leading={<Glyph icon={{ ios: 'circle.dotted.circle', android: 'radio_button_checked' }} />} title="Status"
          trailing={<View style={styles.status}>{!!state.tone && <StatusDot tone={state.tone} pulse={state.pulse} />}<Text numberOfLines={1} style={[text.subhead, { color: colors.muted }]}>{state.label}</Text></View>} />
        <Row leading={<Glyph icon={{ ios: 'clock', android: 'schedule' }} />} title="Last active" trailing={<Value text={lastActiveLabel(at)} />} />
      </Group>
    </ScrollView>
  );
}

function Value({ text: value }: { text: string }) {
  const colors = useColors();
  const large = useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
  return <Text numberOfLines={large ? 3 : 1} selectable style={[text.subhead, !large && styles.value, { color: colors.muted }]}>{value}</Text>;
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  page: { paddingHorizontal: geometry.screenMargin, gap: geometry.sectionGap },
  title: { marginHorizontal: 4 },
  value: { flexShrink: 1, maxWidth: '68%', alignSelf: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
});
