// Task info sheet: project, branch, computer, harness, status and when it last ran.
import { useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { taskKey, useConnect } from '../store/index.ts';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { mono, useColors } from '../ui/theme.ts';

const STATUS: Record<string, string> = { idle: 'Finished', running: 'Working', waiting: 'Needs you', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };

export default function TaskInfo() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const task = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session));
  const computer = useConnect(s => s.devices.find(d => d.id === device));
  const live = useConnect(s => s.live[taskKey(device, session)]?.status);
  if (!task) return <Text style={[styles.empty, { color: colors.secondary }]}>This task is not loaded yet.</Text>;
  const status = live && live !== 'idle' ? live : task.status;
  const project = task.chat ? 'Chat' : task.projectName;
  const at = task.lastPromptAt ?? task.updatedAt;
  return (
    <ScrollView style={{ backgroundColor: colors.grouped }} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic">
      <Text style={[styles.title, { color: colors.text }]} selectable>{task.title || 'Untitled task'}</Text>
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        <Row icon={<ProjectTile deviceId={device} projectId={task.chat ? undefined : task.projectId} name={project} />} label="Project" value={project} />
        <Row icon={<Icon ios="arrow.triangle.branch" android="call_split" size={16} color={colors.tint} />} label="Branch" value={task.branch || '—'} mono />
        <Row icon={<Icon ios="desktopcomputer" android="computer" size={16} color={colors.tint} />} label="Computer" value={`${computer?.name ?? '—'}${computer && !computer.online ? ' (offline)' : ''}`} />
        <Row icon={<HarnessLogo id={task.provider} size={18} />} label="Harness" value={`${harnessName(task.provider)}${task.model !== 'default' ? ` · ${task.model}` : ''}`} />
        <Row icon={<Icon ios="circle.dotted.circle" android="radio_button_checked" size={16} color={colors.tint} />} label="Status" value={STATUS[status] ?? status} />
        <Row icon={<Icon ios="clock" android="schedule" size={16} color={colors.tint} />} label="Last active" value={new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} last />
      </View>
    </ScrollView>
  );
}

function Row({ icon, label, value, mono: monospace, last }: { icon: ReactNode; label: string; value: string; mono?: boolean; last?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }]}>
      <View style={styles.icon}>{icon}</View>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.value, { color: colors.secondary }, monospace && { fontFamily: mono, fontSize: 13 }]} numberOfLines={1} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '700', marginHorizontal: 4 },
  group: { borderRadius: 16, paddingHorizontal: 14, borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 10 },
  icon: { width: 22, alignItems: 'center' },
  label: { fontSize: 16 },
  value: { flex: 1, textAlign: 'right', fontSize: 15 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 40 },
});
