// New task: prompt, computer, project, worktree; harness + model, effort and mode folded into one
// summary row → task.start, or chat.start for a Chat (no project) where the computer serves it.
// Team (where the computer serves team.start) starts an architect that leads agents: Auto (the
// picked model leads and picks worker models) or a named team from the computer's Settings.
// The project picker also offers Add project (the add-project sheet). The + under the prompt attaches
// images and text files (where the computer serves image.put), as the composer does. Run on (where the
// computer serves cloudAgents.start and has a connected cloud provider) starts it on a cloud machine instead. Cancel and Start sit in the native header, where the keyboard can't reach them.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BLOCKED_TITLE } from '../ui/menu-gate.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { teamChoices, teamSummary } from '../connect/api/team.ts';
import { NEW_TASK_DRAFT, setDraft, useDrafts } from '../store/draft.ts';
import { Choice } from '../ui/Choice.tsx';
import { AttachButton, AttachChips, useComposerAttach } from '../ui/ComposerAttach.tsx';
import { Banner, Chevron, Collapse, EmptyState, geometry, Group, Row, Toggle, type as text } from '../ui/ds/index.ts';
import { Glyph, PermissionPicker, useSheetTop } from '../ui/FormParts.tsx';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { modelLabel } from '../ui/models.ts';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { ADD_PROJECT_CHOICE, canStartWith, CHAT_CHOICE, projectChoices } from '../ui/new-task-projects.ts';
import { MODES } from '../ui/status.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';
import { useNewTask } from '../ui/useNewTask.ts';

const PROMPT_HEIGHT = 110;
/** Long enough for the fold to finish opening while the page follows it. */
const FOLLOW_MS = 450;

const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };

export default function NewTask() {
  const colors = useColors();
  const top = useSheetTop();
  const params = useLocalSearchParams<{ device?: string }>();
  const form = useNewTask(params.device);
  const { hosts, deviceId, list, projects, projectId, provider, options, model, effort, efforts, mode, worktree, starting, pick } = form;
  const prompt = useDrafts(s => s.text[NEW_TASK_DRAFT] ?? '');
  const setPrompt = (next: string) => setDraft(NEW_TASK_DRAFT, next);
  const [expanded, setExpanded] = useState(false);
  const { chat, setChatPick, gates } = form;
  const attach = useComposerAttach(deviceId, false);
  const ready = canStartWith({ deviceId, projectId, provider, prompt, starting, chat, allowed: form.allowed, attachments: attach.pending.length > 0 });
  const pickProject = (value: string) => {
    // Chat and Add project stay listed when this phone's access keeps them off; picking one says why.
    const note = value === CHAT_CHOICE ? gates.chat.note : value === ADD_PROJECT_CHOICE ? gates.addProject.note : null;
    if (note) return Alert.alert(BLOCKED_TITLE, note);
    if (value === ADD_PROJECT_CHOICE) return router.push({ pathname: '/add-project', params: { device: deviceId } });
    setChatPick(value === CHAT_CHOICE);
    if (value !== CHAT_CHOICE) pick({ projectId: value });
  };
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const followUntil = useRef(0);
  const toggle = () => {
    followUntil.current = expanded ? 0 : Date.now() + FOLLOW_MS;
    setExpanded(!expanded);
  };
  // The opening fold stays in view above the keyboard.
  const follow = () => { if (Date.now() < followUntil.current) scroll.current?.scrollToEnd({ animated: false }); };
  // A "Message not sent" toast waits until this sheet has gone (it unmounts once the native dismiss
  // finishes): shown while the sheet is up, the toast would sit behind it.
  const unsentNotice = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => unsentNotice.current?.(), []);
  const start = async () => {
    try {
      const prepared = attach.prepare(prompt);
      if (!prepared) return;
      const { sessionId: session, note, notice } = await form.begin(prepared.text, prepared.images, { deferNotice: true });
      setPrompt('');
      attach.clear();
      unsentNotice.current = notice;
      router.dismiss();
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
      if (typeof note === 'string' && note) Alert.alert('Started in a worktree', note.replace(/^Started in a worktree: /, ''));
    } catch (e) {
      Alert.alert('Could not start the task', (e as Error).message);
    }
  };

  if (!hosts.length) {
    return (
      <>
        <HeaderActions left={[CANCEL]} right={[]} />
        <EmptyState icon={{ ios: 'desktopcomputer', android: 'computer' }} title="No computer online" body="No computer with remote access is online." />
      </>
    );
  }
  const projectName = chat ? 'Chat' : projects.find(p => p.id === projectId)?.name ?? '';
  const choices = projectChoices(projects, { chat: gates.chat.shown, add: gates.addProject.shown });
  const blockedPicks = [gates.chat.shown && gates.chat.note ? 'Chat' : '', gates.addProject.shown && gates.addProject.note ? 'Add project' : ''].filter(Boolean);
  const pickNote = blockedPicks.length ? `${blockedPicks.join(' and ')}: ${gates.chat.note ?? gates.addProject.note}` : undefined;
  const failedMeta = <Text style={[text.subhead, { color: colors.muted }]}>Couldn&apos;t load</Text>;
  const harness = options.harnesses.find(h => h.value === provider)?.label ?? harnessName(provider);
  // As the composer: the default model goes by the agent's name, which is already first.
  const modelName = model === 'default' ? '' : modelLabel(model, options.models.map(m => ({ id: m.value, name: m.label })));
  const summary = [harness, modelName, MODES.find(m => m.id === mode)?.label ?? mode].filter(Boolean).join(' · ');
  // The ScrollView stays the sheet's root: inside a parent with its own background, an iOS 26 form sheet shows it blank.
  return (
    <>
      <HeaderActions left={[CANCEL]} right={[{ label: starting ? 'Starting…' : 'Start', primary: true, disabled: !ready, onPress: () => void start() }]} />
      <ScrollView ref={scroll} automaticallyAdjustKeyboardInsets contentContainerStyle={[styles.form, { paddingTop: top }]}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" onContentSizeChange={follow}>
        <Banner visible={!!form.problem} tone="danger" title="Couldn't load this computer's options" body={form.problem ?? undefined} action={{ label: 'Retry', onPress: form.retry }} />
        {form.cloud
          ? <Banner visible={!!form.cloudNote} tone="warning" title="Can’t run on the cloud" body={form.cloudNote ?? undefined} />
          : <AccessNote device={deviceId} methods={[form.method]} />}
        <Group>
          <TextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do?" placeholderTextColor={colors.faint} multiline autoFocus
            style={[text.body, styles.prompt, { color: colors.text }]} accessibilityLabel="Prompt" />
          {attach.items.length > 0 && (
            <View style={styles.attach}>
              <AttachChips pending={attach.pending} onRemove={attach.remove} uploading={starting && attach.hasImages} />
              <AttachButton items={attach.items} disabled={starting} />
            </View>
          )}
        </Group>
        <Group title="Where" footer={form.cloud ? `Runs on a ${form.cloud.label} cloud machine with a copy of the project.` : pickNote}>
          <Row leading={<Glyph icon={{ ios: 'desktopcomputer', android: 'computer' }} />} title="Computer"
            trailing={<Choice label="Computer" value={deviceId} options={hosts.map(h => ({ value: h.id, label: h.name }))} onChange={form.pickDevice} />} />
          <Row leading={chat ? <Glyph icon={{ ios: 'bubble.left', android: 'chat_bubble' }} /> : <ProjectTile deviceId={deviceId} projectId={projectId} name={projectName} size={20} />} title="Project"
            trailing={list ? <Choice label="Project" value={chat ? CHAT_CHOICE : projectId} options={choices} onChange={pickProject} /> : form.problem ? failedMeta : <ActivityIndicator />} />
          {form.runOnOptions.length > 1 && (
            <Row leading={<Glyph icon={{ ios: 'cloud', android: 'cloud' }} />} title="Run on"
              trailing={<Choice label="Run on" value={form.runOn} options={form.runOnOptions} onChange={form.setRunOn} />} />
          )}
          {!chat && !form.team && !form.cloud && (
            <Row leading={<Glyph icon={{ ios: 'arrow.triangle.branch', android: 'call_split' }} />} title="New worktree"
              trailing={<Toggle accessibilityLabel="New worktree" value={worktree} onValueChange={form.setWorktree} />} />
          )}
        </Group>
        {!chat && !form.cloud && gates.team.shown && (
          <Group footer={form.team ? teamSummary(form.teamRoster, form.profileId) : undefined}>
            <Row leading={<Glyph icon={{ ios: 'person.3', android: 'groups' }} />} title="Team" subtitle={gates.team.note ?? undefined}
              trailing={<Toggle accessibilityLabel="Team" value={form.team} disabled={!!gates.team.note} onValueChange={form.setTeamOn} />} />
            {form.team && (
              <Row leading={<Glyph icon={{ ios: 'sparkles', android: 'auto_awesome' }} />} title="Agents"
                trailing={<Choice label="Team" value={form.profileId} options={teamChoices(form.teamRoster)} onChange={form.setTeamPick} />} />
            )}
          </Group>
        )}
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
  prompt: { minHeight: PROMPT_HEIGHT, paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding, textAlignVertical: 'top' },
  attach: { paddingHorizontal: geometry.cardPadding, paddingBottom: geometry.cardPadding, alignItems: 'flex-start' },
});
