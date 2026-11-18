// New schedule sheet (?device=, ?session= to preselect a thread, ?id= to edit): the message, the
// thread it goes to, and a cadence from what the desktop supports (once, repeat every N, daily,
// weekdays, weekly on chosen days, after another thread's run), checked as the host checks it
// (draftInput in src/store/schedules.ts) → schedules.create / schedules.update.
import { DatePicker, Host } from '@expo/ui/swift-ui';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FEATURE_SHEET_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { createSchedule, placeSchedule, refreshSchedules, updateSchedule, useSchedules } from '../connect/api/schedules.ts';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { connect } from '../connect/client.ts';
import { useTasks } from '../store/index.ts';
import { DAY_NAMES, draftInput, draftOf, emptyDraft, INTERVALS, KINDS, timeOf, type ScheduleDraft, type ScheduleKind } from '../store/schedules.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { Choice } from '../ui/Choice.tsx';
import { Banner, Chip, EmptyState, geometry, Group, haptic, Row, Toggle, type as text } from '../ui/ds/index.ts';
import { Glyph, Note, useSheetTop } from '../ui/FormParts.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { editState, onceChoice, threadOptions, watchOptions as watchChoices } from '../ui/schedule-form.ts';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, FEATURE_SHEET_DETENTS);

const PROMPT_HEIGHT = 96;
const NUMBER_WIDTH = 80;
/** Android and older systems pick a one-off from these, and a clock time from half hours. */
const ONCE_PRESETS = [{ label: 'In 1 hour', hours: 1 }, { label: 'In 3 hours', hours: 3 }, { label: 'In 8 hours', hours: 8 }, { label: 'In 1 day', hours: 24 }, { label: 'In 1 week', hours: 168 }];
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const nativePicker = Platform.OS === 'ios';

function dateAt(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

const formatAt = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** `keep`: an edit, whose saved time is offered as "Keep: <date>" when no preset matches it. */
function OnceField({ draft, change, keep }: { draft: ScheduleDraft; change: (patch: Partial<ScheduleDraft>) => void; keep: boolean }) {
  const [now] = useState(() => Date.now());
  if (nativePicker) {
    return (
      <Row leading={<Glyph icon={{ ios: 'calendar', android: 'event' }} />} title="At" trailing={(
        <Host matchContents>
          <DatePicker selection={new Date(draft.runAt)} range={{ start: new Date() }} displayedComponents={['date', 'hourAndMinute']} onDateChange={date => change({ runAt: date.getTime() })} />
        </Host>
      )} />
    );
  }
  const { options, value: current } = onceChoice(ONCE_PRESETS, now, draft.runAt, keep, formatAt);
  return <Row leading={<Glyph icon={{ ios: 'calendar', android: 'event' }} />} title="When" trailing={<Choice label="When" value={current} options={options} onChange={v => change({ runAt: Number(v) })} />} />;
}

function TimeField({ draft, change }: { draft: ScheduleDraft; change: (patch: Partial<ScheduleDraft>) => void }) {
  const trailing = nativePicker
    ? <Host matchContents><DatePicker selection={dateAt(draft.timeOfDay)} displayedComponents={['hourAndMinute']} onDateChange={date => change({ timeOfDay: timeOf(date) })} /></Host>
    : <Choice label="Time" value={draft.timeOfDay} options={HALF_HOURS.map(t => ({ value: t, label: t }))} onChange={t => change({ timeOfDay: t })} />;
  return <Row leading={<Glyph icon={{ ios: 'clock', android: 'schedule' }} />} title="Time" trailing={trailing} />;
}

function DaysField({ days, change }: { days: number[]; change: (patch: Partial<ScheduleDraft>) => void }) {
  const toggle = (day: number) => change({ days: days.includes(day) ? days.filter(d => d !== day) : [...days, day] });
  return (
    <View style={styles.days} accessibilityRole="radiogroup" accessibilityLabel="Days">
      {DAY_NAMES.map((name, day) => (
        <Chip key={name} label={name} tone={days.includes(day) ? 'info' : undefined} onPress={() => { haptic('selection'); toggle(day); }}
          accessibilityLabel={`${name}${days.includes(day) ? ', on' : ''}`} />
      ))}
    </View>
  );
}

const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };

export default function NewSchedule() {
  const colors = useColors();
  const top = useSheetTop();
  const params = useLocalSearchParams<{ device: string; id?: string; session?: string }>();
  const device = params.device ?? '';
  const editing = useSchedules(s => (params.id ? s[device]?.schedules.find(x => x.id === params.id) : undefined));
  const schedulesLoaded = useSchedules(s => !!s[device]);
  const state = editState(params.id, schedulesLoaded, !!editing);
  const list = useTasks(device);
  const tasks = useMemo(() => (list?.tasks ?? []).filter(t => !t.botId), [list]);
  const [draft, setDraft] = useState<ScheduleDraft>(() => (editing ? draftOf(editing) : emptyDraft(Date.now(), params.session ?? '')));
  // The schedule list can arrive after the sheet opens: seed the draft from the schedule then, once,
  // so Save never sends the empty form over it (Save stays off until it's seeded).
  const [seededId, setSeededId] = useState(() => editing?.id ?? null);
  /** The draft as seeded: closing asks first only once the user has changed it. */
  const [seed, setSeed] = useState(draft);
  if (editing && seededId !== editing.id) {
    const next = draftOf(editing);
    setSeededId(editing.id);
    setDraft(next);
    setSeed(next);
  }
  const seeded = !params.id || seededId !== null;
  const method = params.id ? 'schedules.update' : 'schedules.create';
  const allowed = useHostAllows(device, method);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const release = useDiscardGuard(JSON.stringify(draft) !== JSON.stringify(seed), { message: editing ? 'Your changes to this schedule aren’t saved.' : 'This schedule isn’t created yet.' });
  useEffect(() => { if (device && !list) void connect.listTasks(device).catch((e: Error) => setError(e.message)); }, [device, list]);
  useEffect(() => { if (device && params.id && !schedulesLoaded) void refreshSchedules(device).catch((e: Error) => setError(e.message)); }, [device, params.id, schedulesLoaded]);
  // The first thread once the list arrives, when none was given.
  const sessionId = draft.sessionId || tasks[0]?.sessionId || '';
  const change = (patch: Partial<ScheduleDraft>) => setDraft(d => ({ ...d, ...patch }));
  const watchOptions = watchChoices(tasks, sessionId, editing);
  const threads = threadOptions(tasks, editing);

  const save = async () => {
    const checked = draftInput({ ...draft, sessionId });
    if ('error' in checked) {
      haptic('error');
      setError(checked.error);
      return;
    }
    setSaving(true);
    try {
      const saved = editing ? await updateSchedule(device, editing.id, checked.input) : await createSchedule(device, checked.input);
      placeSchedule(device, saved.id, saved);
      haptic('success');
      release();
      router.back();
    } catch (e) {
      haptic('error');
      setSaving(false);
      Alert.alert(editing ? 'Could not save the schedule' : 'Could not create the schedule', (e as Error).message);
    }
  };

  if (state === 'missing') {
    return <><HeaderActions left={[CANCEL]} right={[]} /><EmptyState icon={{ ios: 'calendar.badge.exclamationmark', android: 'event_busy' }} title="Schedule not found" body="It may have been removed on the computer." /></>;
  }
  if (list && !tasks.length && !editing) {
    return <><HeaderActions left={[CANCEL]} right={[]} /><EmptyState icon={{ ios: 'bubble.left', android: 'chat' }} title="No threads to schedule" body="Start a task on this computer first; a schedule sends one of its threads a message." /></>;
  }
  const loading = state === 'loading' || (state === 'ready' && !seeded);
  const ready = allowed && !loading && !!draft.prompt.trim() && !!sessionId && !saving;
  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit schedule' : 'New schedule' }} />
      <HeaderActions left={[CANCEL]} right={[{ label: saving ? 'Saving…' : loading ? 'Loading…' : 'Save', primary: true, disabled: !ready, onPress: () => void save() }]} />
      <KeyboardAwareScrollView enabled={SHEET_KEYBOARD} contentContainerStyle={[styles.form, { paddingTop: top }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" bottomOffset={geometry.sectionGap}>
        <AccessNote device={device} methods={[method]} />
        <Banner visible={!!error} tone="danger" title={error} />
        {loading && <Note>Loading the schedule…</Note>}
        <Group>
          <TextInput value={draft.prompt} onChangeText={prompt => change({ prompt })} placeholder="What should the thread be sent?" placeholderTextColor={colors.faint} multiline autoFocus={!editing}
            style={[text.body, styles.prompt, { color: colors.text }]} accessibilityLabel="Message" />
        </Group>
        <Group>
          <TextInput value={draft.title} onChangeText={title => change({ title })} placeholder="Title (optional)" placeholderTextColor={colors.faint} maxLength={120}
            style={[text.body, styles.line, { color: colors.text }]} accessibilityLabel="Title" />
        </Group>
        <Group title="Send to">
          <Row leading={<Glyph icon={{ ios: 'bubble.left', android: 'chat' }} />} title="Thread"
            trailing={<Choice label="Thread" value={sessionId} options={threads} onChange={id => change({ sessionId: id, watchSessionId: '' })} />} />
        </Group>
        <Group title="When">
          <Row leading={<Glyph icon={{ ios: 'repeat', android: 'repeat' }} />} title="Repeat"
            trailing={<Choice label="Repeat" value={draft.kind} options={KINDS.map(k => ({ value: k.value, label: k.label }))} onChange={kind => change({ kind: kind as ScheduleKind })} />} />
          {draft.kind === 'once' && <OnceField draft={draft} change={change} keep={!!editing} />}
          {draft.kind === 'interval' && (
            <Row leading={<Glyph icon={{ ios: 'timer', android: 'timer' }} />} title="Every"
              trailing={<Choice label="Every" value={String(draft.intervalMinutes)} options={INTERVALS.map(i => ({ value: String(i.minutes), label: i.label }))} onChange={m => change({ intervalMinutes: Number(m) })} />} />
          )}
          {(draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'weekly') && <TimeField draft={draft} change={change} />}
          {draft.kind === 'weekly' && <DaysField days={draft.days} change={change} />}
          {draft.kind === 'after' && (
            <>
              <Row leading={<Glyph icon={{ ios: 'arrow.turn.down.right', android: 'subdirectory_arrow_right' }} />} title="After"
                trailing={watchOptions.length ? <Choice label="After" value={draft.watchSessionId} options={watchOptions} onChange={id => change({ watchSessionId: id })} /> : <Note>No other thread in this project</Note>} />
              <Row leading={<Glyph icon={{ ios: 'checkmark.circle', android: 'check_circle' }} />} title="Only when it succeeds"
                trailing={<Toggle accessibilityLabel="Only when it succeeds" value={draft.onlyOnSuccess} onValueChange={onlyOnSuccess => change({ onlyOnSuccess })} />} />
            </>
          )}
        </Group>
        {draft.kind !== 'once' && (
          <Group footer={<Note>Leave empty to run until removed.</Note>}>
            <Row leading={<Glyph icon={{ ios: 'number', android: 'tag' }} />} title="Max runs" trailing={(
              <TextInput value={draft.maxRuns} onChangeText={maxRuns => change({ maxRuns: maxRuns.replace(/\D/g, '') })} placeholder="No limit" placeholderTextColor={colors.faint}
                keyboardType="number-pad" maxLength={4} style={[text.callout, styles.number, { color: colors.text }]} accessibilityLabel="Max runs" />
            )} />
          </Group>
        )}
        <Text style={[text.footnote, styles.note, { color: colors.muted }]}>The thread gets this message in its own permission mode, as if you sent it.</Text>
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  form: { paddingHorizontal: geometry.screenMargin, paddingBottom: geometry.screenMargin, gap: geometry.sectionGap },
  prompt: { minHeight: PROMPT_HEIGHT, paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding, textAlignVertical: 'top' },
  line: { minHeight: geometry.rowHeight, paddingHorizontal: geometry.rowInset },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: geometry.cardPadding, paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding },
  number: { minWidth: NUMBER_WIDTH, textAlign: 'right' },
  note: { paddingHorizontal: geometry.rowInset },
});
