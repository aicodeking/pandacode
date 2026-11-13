// Task info sheet: project, branch, computer, harness, status and when it last ran, then the task's
// stage and details (its goal; thread.goal), editable while the agent is stopped, and a Codex native
// goal when it has one. The sheet fits this content (root layout), so the page scrolls only at the
// largest text sizes.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { guardedFormSheet, TASK_INFO_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { setThreadGoal, setThreadStage, STAGES, threadGoal, type Stage, type ThreadGoal } from '../connect/api/threads.ts';
import { taskKey, useConnect, useModels } from '../store/index.ts';
import { STAGE_NAMES, stageName } from '../store/stages.ts';
import { Banner, BranchChip, Button, EmptyState, Group, haptic, lastActiveLabel, Skeleton, LARGE_TEXT_SCALE, geometry, Row, StatusDot, type as text, type Tone } from '../ui/ds/index.ts';
import { Choice } from '../ui/Choice.tsx';
import { Glyph, Note, useSheetTop } from '../ui/FormParts.tsx';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { modelLabel, useModelOptions } from '../ui/models.ts';
import { ProjectTile } from '../ui/ProjectTile.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it; on Android Task info is a modal, so
 * always (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, TASK_INFO_DETENTS, guardedFormSheet(Platform.OS));

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
    // Keyboard-aware, as commit.tsx: the details editor and its Save stay above the keyboard.
    <KeyboardAwareScrollView enabled={SHEET_KEYBOARD} style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top }]} bounces={false}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" bottomOffset={geometry.sectionGap}>
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
      <GoalSection deviceId={device} sessionId={session} busy={status === 'running' || status === 'waiting'} />
    </KeyboardAwareScrollView>
  );
}

/** Details shown before "Show more". */
const DETAIL_LINES = 6;
const MAX_DETAILS = 100 * 1024;

/** The task's stage and details from thread.goal; hidden on a host without it. */
function GoalSection({ deviceId, sessionId, busy }: { deviceId: string; sessionId: string; busy: boolean }) {
  const supported = useHostSupports(deviceId, 'thread.goal');
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [error, setError] = useState('');
  /** Bumped by Retry: asks for the goal again. */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    threadGoal(deviceId, sessionId).then(g => live && setGoal(g), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [deviceId, sessionId, supported, attempt]);
  if (!supported) return null;
  const load = () => { setError(''); setAttempt(a => a + 1); };
  if (error && !goal) return <Banner visible tone="danger" title="Couldn’t load the task’s goal" body={error} action={{ label: 'Retry', onPress: load }} />;
  if (!goal) return <Group title="Goal"><View style={styles.loading}><Skeleton width="60%" /><Skeleton width="80%" /></View></Group>;
  return <GoalForm deviceId={deviceId} sessionId={sessionId} goal={goal} locked={busy || goal.running} onChange={setGoal} />;
}

function GoalForm({ deviceId, sessionId, goal, locked, onChange }: { deviceId: string; sessionId: string; goal: ThreadGoal; locked: boolean; onChange: (goal: ThreadGoal) => void }) {
  const colors = useColors();
  const canEdit = useHostAllows(deviceId, 'thread.setGoal');
  const canStage = useHostAllows(deviceId, 'thread.setStage');
  const accessNote = useAccessNote(deviceId, ['thread.setGoal', 'thread.setStage']);
  const [draft, setDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Closing the sheet with unsaved details asks first, as the file editor does.
  useDiscardGuard(draft !== null && draft !== goal.description, { message: 'Your edits to the task’s details aren’t saved.', onDiscard: () => setDraft(null) });
  const run = async (change: () => Promise<ThreadGoal>) => {
    setSaving(true);
    setError('');
    try {
      onChange(await change());
      haptic('success');
      setDraft(null);
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  // Work in progress comes from starting the task, so it's offered only while the task is in it.
  const stages = STAGES.filter(stage => stage !== 'in_progress' || goal.stage === 'in_progress').map(stage => ({ value: stage, label: STAGE_NAMES[stage] }));
  const stageLabel = stageName(goal.stage);
  const editable = canEdit && !locked && !saving;
  return (
    <>
      <Banner visible={!!error} tone="danger" title="Couldn’t save" body={error} />
      <Group title="Goal" footer={accessNote ? <Note>{accessNote}</Note> : locked ? <Note>Stop the agent to change the stage or details.</Note> : undefined}>
        <Row leading={<Glyph icon={{ ios: 'square.stack.3d.up', android: 'view_kanban' }} />} title="Stage"
          trailing={canStage && !locked && !saving
            ? <Choice label="Stage" value={goal.stage} options={stages} onChange={stage => run(() => setThreadStage(deviceId, sessionId, stage as Stage))} />
            : <Value text={stageLabel} />} />
        {!!goal.goal?.objective && (
          <Row leading={<Glyph icon={{ ios: 'scope', android: 'track_changes' }} />} title="Native goal" subtitle={goal.goal.objective} trailing={<Value text={goal.goal.status} />} />
        )}
        {draft === null ? (
          <View style={styles.details}>
            <Text style={[text.subhead, { color: goal.description ? colors.text : colors.muted }]} selectable numberOfLines={expanded ? undefined : DETAIL_LINES}>
              {goal.description || 'No details yet.'}
            </Text>
            <View style={styles.detailActions}>
              {goal.description.split('\n').length > DETAIL_LINES || goal.description.length > 400
                ? <Button label={expanded ? 'Show less' : 'Show more'} size="small" onPress={() => setExpanded(e => !e)} />
                : <View />}
              {editable && <Button label="Edit" size="small" icon={{ ios: 'pencil', android: 'edit' }} onPress={() => setDraft(goal.description)} />}
            </View>
          </View>
        ) : (
          <View style={styles.details}>
            <TextInput value={draft} onChangeText={setDraft} multiline autoFocus maxLength={MAX_DETAILS} placeholder="What should the agent do, and how will you know it’s done?"
              placeholderTextColor={colors.faint} accessibilityLabel="Task details" editable={!saving}
              style={[text.body, styles.input, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
            <View style={styles.detailActions}>
              <Button label="Cancel" size="small" disabled={saving} onPress={() => setDraft(null)} />
              <Button label="Save" size="small" variant="primary" loading={saving} disabled={draft.trim() === goal.description} onPress={() => run(() => setThreadGoal(deviceId, sessionId, draft))} />
            </View>
          </View>
        )}
      </Group>
    </>
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
  loading: { padding: geometry.rowInset, gap: geometry.screenMargin },
  details: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.screenMargin, gap: geometry.screenMargin },
  detailActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { minHeight: 96, maxHeight: 220, padding: 10, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, textAlignVertical: 'top' },
});
