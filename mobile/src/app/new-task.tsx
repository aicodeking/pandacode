// New task: prompt, computer, project, worktree; harness + model, effort and mode folded into one
// summary row → task.start. Cancel and Start sit in the native header, where the keyboard can't reach them.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { NEW_TASK_DRAFT, setDraft, useDrafts } from '../store/draft.ts';
import { Choice } from '../ui/Choice.tsx';
import { Banner, Chevron, Collapse, EmptyState, geometry, Group, Row, Toggle, type as text } from '../ui/ds/index.ts';
import { Glyph, PermissionPicker, useSheetTop } from '../ui/FormParts.tsx';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { modelLabel } from '../ui/models.ts';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { MODES } from '../ui/status.tsx';
import { useColors } from '../ui/theme.ts';
import { useNewTask } from '../ui/useNewTask.ts';

const PROMPT_HEIGHT = 110;
/** Long enough for the fold to finish opening while the page follows it. */
const FOLLOW_MS = 450;

function CancelItem() {
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
    </Stack.Toolbar>
  );
}

export default function NewTask() {
  const colors = useColors();
  const top = useSheetTop();
  const params = useLocalSearchParams<{ device?: string }>();
  const form = useNewTask(params.device);
  const { hosts, deviceId, list, projects, projectId, provider, options, model, effort, efforts, mode, worktree, starting, pick } = form;
  const prompt = useDrafts(s => s.text[NEW_TASK_DRAFT] ?? '');
  const setPrompt = (next: string) => setDraft(NEW_TASK_DRAFT, next);
  const [expanded, setExpanded] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const followUntil = useRef(0);
  const toggle = () => {
    followUntil.current = expanded ? 0 : Date.now() + FOLLOW_MS;
    setExpanded(!expanded);
  };
  // The opening fold stays in view above the keyboard.
  const follow = () => { if (Date.now() < followUntil.current) scroll.current?.scrollToEnd({ animated: false }); };
  const start = async () => {
    try {
      const { sessionId: session, note } = await form.start(prompt);
      setPrompt('');
      router.dismiss();
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
      if (note) Alert.alert('Started in a worktree', note.replace(/^Started in a worktree: /, ''));
    } catch (e) {
      Alert.alert('Could not start the task', (e as Error).message);
    }
  };

  if (!hosts.length) {
    return (
      <>
        <CancelItem />
        <EmptyState icon={{ ios: 'desktopcomputer', android: 'computer' }} title="No computer online" body="No computer with remote access is online." />
      </>
    );
  }
  const projectName = projects.find(p => p.id === projectId)?.name ?? '';
  const failedMeta = <Text style={[text.subhead, { color: colors.muted }]}>Couldn&apos;t load</Text>;
  const harness = options.harnesses.find(h => h.value === provider)?.label ?? harnessName(provider);
  // As the composer: the default model goes by the agent's name, which is already first.
  const modelName = model === 'default' ? '' : modelLabel(model, options.models.map(m => ({ id: m.value, name: m.label })));
  const summary = [harness, modelName, MODES.find(m => m.id === mode)?.label ?? mode].filter(Boolean).join(' · ');
  // The ScrollView stays the sheet's root: inside a parent with its own background, an iOS 26 form sheet shows it blank.
  return (
    <>
      <CancelItem />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" {...(form.canStart(prompt) && { tintColor: colors.primary, style: { color: colors.onPrimary } })} disabled={!form.canStart(prompt)} onPress={() => void start()}>{starting ? 'Starting…' : 'Start'}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView ref={scroll} automaticallyAdjustKeyboardInsets contentContainerStyle={[styles.form, { paddingTop: top }]}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" onContentSizeChange={follow}>
        <Banner visible={!!form.problem} tone="danger" title="Couldn't load this computer's options" body={form.problem ?? undefined} action={{ label: 'Retry', onPress: form.retry }} />
        <Group>
          <TextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do?" placeholderTextColor={colors.faint} multiline autoFocus
            style={[text.body, styles.prompt, { color: colors.text }]} accessibilityLabel="Prompt" />
        </Group>
        <Group title="Where">
          <Row leading={<Glyph icon={{ ios: 'desktopcomputer', android: 'computer' }} />} title="Computer"
            trailing={<Choice label="Computer" value={deviceId} options={hosts.map(h => ({ value: h.id, label: h.name }))} onChange={form.pickDevice} />} />
          <Row leading={<ProjectTile deviceId={deviceId} projectId={projectId} name={projectName} size={20} />} title="Project"
            trailing={list ? <Choice label="Project" value={projectId} options={projects.map(p => ({ value: p.id, label: p.name }))} onChange={id => pick({ projectId: id })} /> : form.problem ? failedMeta : <ActivityIndicator />} />
          <Row leading={<Glyph icon={{ ios: 'arrow.triangle.branch', android: 'call_split' }} />} title="New worktree"
            trailing={<Toggle accessibilityLabel="New worktree" value={worktree} onValueChange={form.setWorktree} />} />
        </Group>
        <Group>
          <Row leading={provider ? <HarnessLogo id={provider} size={20} /> : <Glyph icon={{ ios: 'cpu', android: 'memory' }} />} title={summary} onPress={toggle}
            accessibilityHint={expanded ? 'Hides the agent options' : 'Shows the agent options'} accessibilityState={{ expanded }} trailing={<Chevron expanded={expanded} />} />
          <Collapse expanded={expanded}>
            <Row leading={<Glyph icon={{ ios: 'square.stack.3d.up', android: 'layers' }} />} title="Agent"
              trailing={options.loaded ? <Choice label="Agent" value={provider} options={options.harnesses} onChange={form.pickProvider} /> : form.problem ? failedMeta : <ActivityIndicator />} />
            <Row leading={<Glyph icon={{ ios: 'cpu', android: 'memory' }} />} title="Model"
              trailing={<Choice label="Model" value={model} options={[{ value: 'default', label: 'Default' }, ...options.models.filter(m => m.value !== 'default')]} onChange={form.pickModel} />} />
            {efforts.length > 0 && (
              <Row leading={<Glyph icon={{ ios: 'gauge.with.dots.needle.67percent', android: 'speed' }} />} title="Effort"
                trailing={<Choice label="Effort" value={effort ?? ''} options={efforts} onChange={e => pick({ effort: e })} />} />
            )}
            <PermissionPicker value={mode} onChange={m => pick({ mode: m })} />
          </Collapse>
        </Group>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  form: { paddingHorizontal: geometry.screenMargin, paddingBottom: geometry.screenMargin, gap: geometry.sectionGap },
  prompt: { minHeight: PROMPT_HEIGHT, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, textAlignVertical: 'top' },
});
