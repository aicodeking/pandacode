// New task: computer, project, harness + model, effort, mode, worktree, prompt → task.start.
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Choice } from '../ui/Choice.tsx';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { Button } from '../ui/requests.tsx';
import { MODES } from '../ui/status.tsx';
import { useColors } from '../ui/theme.ts';
import { useNewTask } from '../ui/useNewTask.ts';

export default function NewTask() {
  const colors = useColors();
  const params = useLocalSearchParams<{ device?: string }>();
  const form = useNewTask(params.device);
  const { hosts, deviceId, list, projectId, provider, options, model, effort, efforts, mode, worktree, starting, pick } = form;
  const [prompt, setPrompt] = useState('');
  const start = async () => {
    try {
      const session = await form.start(prompt);
      router.dismiss();
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
    } catch (e) {
      Alert.alert('Could not start the task', (e as Error).message);
    }
  };

  if (!hosts.length) return <Text style={[styles.empty, { color: colors.secondary }]}>No computer with remote access is online.</Text>;
  return (
    <ScrollView style={{ backgroundColor: colors.grouped }} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        <Row label="Computer"><Choice value={deviceId} options={hosts.map(h => ({ value: h.id, label: h.name }))} onChange={form.pickDevice} /></Row>
        <Row label="Project">{list ? <View style={styles.project}><ProjectTile deviceId={deviceId} projectId={projectId} name={list.projects.find(p => p.id === projectId)?.name ?? ''} /><Choice value={projectId} options={list.projects.map(p => ({ value: p.id, label: p.name }))} onChange={id => pick({ projectId: id })} /></View> : <ActivityIndicator />}</Row>
        <Row label="Harness">{options.loaded ? <Choice value={provider} options={options.harnesses} onChange={form.pickProvider} /> : <ActivityIndicator />}</Row>
        <Row label="Model"><Choice value={model} options={[{ value: 'default', label: 'Default' }, ...options.models.filter(m => m.value !== 'default')]} onChange={form.pickModel} /></Row>
        {efforts.length > 0 && <Row label="Effort"><Choice value={effort ?? ''} options={efforts} onChange={e => pick({ effort: e })} /></Row>}
        <Row label="Permissions"><Choice value={mode} options={MODES.map(m => ({ value: m.id, label: m.label }))} onChange={m => pick({ mode: m })} /></Row>
        <Row label="New worktree" last><Switch value={worktree} onValueChange={form.setWorktree} /></Row>
      </View>
      <TextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do?" placeholderTextColor={colors.tertiary as string} multiline autoFocus
        style={[styles.prompt, { backgroundColor: colors.card, color: colors.text }]} accessibilityLabel="Prompt" />
      {starting
        ? <View style={styles.starting}><ActivityIndicator /><Text style={{ color: colors.secondary }}>Starting on the computer…</Text></View>
        : <Button label="Start task" kind="primary" onPress={start} disabled={!form.canStart(prompt)} />}
    </ScrollView>
  );
}

function Row({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }]}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { padding: 16, gap: 16 },
  group: { borderRadius: 16, paddingHorizontal: 14 },
  project: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, gap: 12 },
  label: { fontSize: 16 },
  prompt: { borderRadius: 16, padding: 14, fontSize: 16, minHeight: 120, textAlignVertical: 'top' },
  starting: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 40 },
});
