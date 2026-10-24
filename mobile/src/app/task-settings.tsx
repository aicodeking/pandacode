// Model & permissions for one task, in a sheet: harness, model, effort and mode (task.configure).
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { TaskSummary } from '../connect/types.ts';
import { useConnect } from '../store/index.ts';
import { Choice } from '../ui/Choice.tsx';
import { HarnessLogo } from '../ui/harness.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useModelOptions } from '../ui/models.ts';
import { MODES } from '../ui/status.tsx';
import { useColors } from '../ui/theme.ts';

type Settings = Pick<TaskSummary, 'provider' | 'model' | 'effort' | 'mode'>;

export default function TaskSettings() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const task = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session));
  const colors = useColors();
  if (!task) return <Text style={[styles.empty, { color: colors.secondary }]}>This task is not loaded yet.</Text>;
  return <Form deviceId={device} sessionId={session} task={task} />;
}

function Form({ deviceId, sessionId, task }: { deviceId: string; sessionId: string; task: TaskSummary }) {
  const colors = useColors();
  const [settings, setSettings] = useState<Settings>({ provider: task.provider, model: task.model, effort: task.effort, mode: task.mode });
  const options = useModelOptions(deviceId, settings.provider);
  const configure = async (change: Partial<Settings>) => {
    const before = settings;
    setSettings(s => ({ ...s, ...change }));
    void Haptics.selectionAsync();
    try {
      await connect.configureTask(deviceId, { sessionId, ...change });
    } catch (error) {
      setSettings(before);
      Alert.alert('Could not change settings', (error as Error).message);
    }
  };
  const efforts = options.efforts(settings.model);
  return (
    <ScrollView style={{ backgroundColor: colors.grouped }} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic">
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        <Row icon={<HarnessLogo id={settings.provider} size={18} />} label="Harness">
          {options.harnesses.length > 0 ? <Choice value={settings.provider} options={options.harnesses} onChange={provider => provider !== settings.provider && configure({ provider, model: 'default', effort: null })} />
            : <Text style={{ color: colors.secondary }}>{settings.provider}</Text>}
        </Row>
        <Row icon={<Icon ios="cpu" android="memory" size={17} color={colors.tint} />} label="Model">
          {options.models.length > 0 ? <Choice value={settings.model} options={options.models} onChange={model => configure({ provider: settings.provider, model, effort: options.defaultEffort(model) })} />
            : <Text style={{ color: colors.secondary }}>{settings.model}</Text>}
        </Row>
        {efforts.length > 0 && (
          <Row icon={<Icon ios="gauge.with.dots.needle.67percent" android="speed" size={17} color={colors.tint} />} label="Effort">
            <Choice value={settings.effort ?? ''} options={efforts} onChange={effort => configure({ effort })} />
          </Row>
        )}
        <Row icon={<Icon ios="lock.shield" android="shield" size={17} color={colors.tint} />} label="Permissions" last>
          <Choice value={settings.mode} options={MODES.map(m => ({ value: m.id, label: m.label }))} onChange={mode => configure({ mode })} />
        </Row>
      </View>
      <Text style={[styles.footer, { color: colors.secondary }]}>Changes apply from the next message.</Text>
    </ScrollView>
  );
}

function Row({ icon, label, children, last }: { icon: ReactNode; label: string; children: ReactNode; last?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }]}>
      <View style={styles.icon}>{icon}</View>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  group: { borderRadius: 16, paddingHorizontal: 14, borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 50, gap: 10 },
  icon: { width: 22, alignItems: 'center' },
  label: { flex: 1, fontSize: 16 },
  footer: { fontSize: 13, marginHorizontal: 14 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 40 },
});
