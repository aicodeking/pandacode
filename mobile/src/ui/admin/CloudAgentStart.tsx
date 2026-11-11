// The Machines screen's "Start cloud agent" form: a cloud provider, the agent, a project on the computer and the
// first message. The start runs once per startId, kept until the form changes or the host answers with a failure,
// so a retry after a lost reply makes no second task. Pure logic in store/admin.ts.
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { cloudAgentTargets, startCloudAgent } from '../../connect/api/admin.ts';
import { uuid } from '../../connect/crypto.ts';
import { keepsStartId } from '../../connect/start-retry.ts';
import { cloudStartIssue, harnessLabel, initialCloudForm, type CloudStartForm, type CloudTargets } from '../../store/admin.ts';
import { useTasks } from '../../store/index.ts';
import { Button, geometry, haptic, Row, type as textStyle } from '../ds/index.ts';
import { showActions } from '../Menu.tsx';
import { pickableProjects } from '../new-task-projects.ts';
import { noteUnsentStart } from '../useNewTask.ts';
import { useColors } from '../theme.ts';
import { useDiscardGuard } from '../useDiscardGuard.ts';

const PROMPT_LINES_MAX_HEIGHT = 160;

interface Props { device: string; computer: string; onStarted: (sessionId: string) => void; onCancel: () => void }

export function CloudAgentStart({ device, computer, onStarted, onCancel }: Props) {
  const colors = useColors();
  const projects = pickableProjects(useTasks(device));
  const [targets, setTargets] = useState<CloudTargets | null>(null);
  // What the user changed, over the defaults (first connected provider, Claude Code, first project).
  const [edits, setEdits] = useState<Partial<CloudStartForm>>({});
  const [startId, setStartId] = useState(uuid);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    cloudAgentTargets(device).then(found => { if (live) setTargets(found); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [device]);
  const form: CloudStartForm | null = targets ? { ...initialCloudForm(targets, projects), ...edits } : null;
  const release = useDiscardGuard(!!edits.prompt?.trim(), { message: 'The cloud agent’s first message isn’t sent.' });

  // Any change is a new start: a fresh id, so it never answers with the previous form's task.
  const edit = (change: Partial<CloudStartForm>) => {
    setEdits(current => ({ ...current, ...change }));
    setStartId(uuid());
    setError('');
  };
  const start = async () => {
    if (!form) return;
    setStarting(true);
    try {
      const reply = await startCloudAgent(device, form, startId);
      if (reply.sent !== false) haptic('success');
      release();
      onStarted(reply.sessionId);
      // Made without its first message: the prompt waits in the task's composer, with a toast.
      noteUnsentStart(device, reply, form.prompt);
    } catch (e) {
      haptic('error');
      // Keep the id only while the host may have the start (a lost reply): a retry then answers it.
      // An answer it gave (a refusal or failure) is remembered an hour, so the next tap is a new start.
      if (!keepsStartId(e)) setStartId(uuid());
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (!targets || !form) return <Row title={error ? 'Couldn’t load cloud providers' : 'Loading cloud providers…'} subtitle={error || undefined} tone={error ? 'danger' : undefined} />;
  const provider = targets.providers.find(p => p.provider === form.provider);
  const project = projects.find(p => p.id === form.projectId);
  const issue = cloudStartIssue(form, targets, computer);
  const pickProvider = () => showActions('Cloud provider', targets.providers.map(p => ({
    label: p.ready ? p.label : `${p.label} (not connected)`, checked: p.provider === form.provider, onPress: () => edit({ provider: p.provider }),
  })));
  const pickHarness = () => showActions('Agent', targets.harnesses.map(h => ({ label: harnessLabel(h), checked: h === form.harness, onPress: () => edit({ harness: h }) })));
  const pickProject = () => showActions('Project', projects.map(p => ({ label: p.name, checked: p.id === form.projectId, onPress: () => edit({ projectId: p.id }) })));

  return (
    <View>
      <Row title="Provider" trailing={provider?.label ?? 'Choose'} chevron onPress={pickProvider} accessibilityHint="Chooses the cloud provider" />
      <Row title="Agent" trailing={form.harness ? harnessLabel(form.harness) : 'Choose'} chevron onPress={pickHarness} accessibilityHint="Chooses the agent" />
      <Row title="Project" trailing={project?.name ?? 'Choose'} chevron onPress={projects.length ? pickProject : undefined} accessibilityHint="Chooses the project to copy" />
      <View style={styles.compose}>
        <TextInput value={form.prompt} onChangeText={prompt => edit({ prompt })} placeholder="What should the agent do?" placeholderTextColor={colors.faint} multiline
          style={[textStyle.body, styles.input, { color: colors.text }]} accessibilityLabel="First message" editable={!starting} />
      </View>
      {!!(error || (issue && form.prompt.trim())) && <Row title={error ? 'That didn’t work' : 'Not ready'} subtitle={error || issue || undefined} tone={error ? 'danger' : 'warning'} />}
      <View style={styles.actions}>
        <Button label="Cancel" size="small" onPress={onCancel} disabled={starting} />
        <Button label="Start" size="small" variant="primary" loading={starting} disabled={!!issue} onPress={() => void start()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  compose: { paddingHorizontal: geometry.rowInset, paddingVertical: 8 },
  input: { minHeight: 72, maxHeight: PROMPT_LINES_MAX_HEIGHT, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
});
