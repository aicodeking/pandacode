// One schedule (?device=&id=): what it sends, to which thread and when, its on/off toggle, Run now,
// Snooze, Edit (the New schedule sheet) and Delete, then its run history; a run opens its thread.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { deleteSchedule, placeSchedule, refreshSchedules, runScheduleNow, scheduleRuns, setScheduleEnabled, snoozeSchedule, useSchedules } from '../connect/api/schedules.ts';
import { cadence, isFinished, nextLine, OUTCOME_LABEL, SNOOZES, when, type ScheduleRun, type TaskSchedule } from '../store/schedules.ts';
import { Banner, Button, CardSection, Chip, EmptyState, geometry, Group, haptic, Row, Skeleton, Toggle, type as text, type Tone, useStagger } from '../ui/ds/index.ts';
import { Glyph } from '../ui/FormParts.tsx';
import { showActions } from '../ui/Menu.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const OUTCOME_TONE: Record<ScheduleRun['outcome'], Tone | undefined> = { started: 'success', queued: 'info', skipped: undefined, failed: 'danger' };
const openTask = (device: string, session: string) => router.push({ pathname: '/task/[device]/[session]', params: { device, session } });

function Details({ device, schedule }: { device: string; schedule: TaskSchedule }) {
  const max = schedule.maxRuns === null ? '' : ` of ${schedule.maxRuns}`;
  return (
    <Group>
      <Row leading={<Glyph icon={{ ios: 'bubble.left', android: 'chat' }} />} title="Thread" trailing={<Meta>{schedule.sessionTitle}</Meta>} chevron onPress={() => openTask(device, schedule.sessionId)} />
      <Row leading={<Glyph icon={{ ios: 'repeat', android: 'repeat' }} />} title="When" trailing={<Meta>{cadence(schedule)}</Meta>} />
      <Row leading={<Glyph icon={{ ios: 'clock', android: 'schedule' }} />} title="Next run" trailing={<Meta>{nextLine(schedule) || '—'}</Meta>} />
      <Row leading={<Glyph icon={{ ios: 'number', android: 'tag' }} />} title="Runs" trailing={<Meta>{`${schedule.runCount}${max}${schedule.lastRunAt ? ` · last ${when(schedule.lastRunAt)}` : ''}`}</Meta>} />
      {schedule.createdBy === 'agent' && <Row leading={<Glyph icon={{ ios: 'sparkles', android: 'auto_awesome' }} />} title="Set by an agent" />}
    </Group>
  );
}

function Meta({ children }: { children: string }) {
  const colors = useColors();
  return <Text numberOfLines={1} style={[text.callout, styles.meta, { color: colors.muted }]}>{children}</Text>;
}

function History({ device, runs, error, onRetry }: { device: string; runs: ScheduleRun[] | null; error: string; onRetry: () => void }) {
  const enter = useStagger(!!runs);
  if (!runs && error) return <CardSection title="Runs"><Row title="Couldn’t load the runs" subtitle={error} trailing={<Button label="Retry" size="small" variant="plain" onPress={onRetry} />} /></CardSection>;
  if (!runs) return <CardSection title="Runs"><View style={styles.loading}><Skeleton width="60%" /><Skeleton width="45%" /></View></CardSection>;
  if (!runs.length) return <CardSection title="Runs"><Row title="No runs yet" /></CardSection>;
  return (
    <CardSection title="Runs">
      {runs.map((run, i) => (
        <Animated.View key={run.id} entering={enter(i)}>
          <Row title={`Run ${run.sequence}${run.manual ? ' · Run now' : ''}`} subtitle={[when(run.at), run.detail].filter(Boolean).join(' · ')}
            trailing={<Chip label={OUTCOME_LABEL[run.outcome]} tone={OUTCOME_TONE[run.outcome]} />} chevron onPress={() => openTask(device, run.sessionId)} />
        </Animated.View>
      ))}
    </CardSection>
  );
}

export default function ScheduleScreen() {
  const { device = '', id = '' } = useLocalSearchParams<{ device: string; id: string }>();
  const colors = useColors();
  const scroll = usePushedScroll();
  const schedule = useSchedules(s => s[device]?.schedules.find(x => x.id === id));
  const listed = useSchedules(s => !!s[device]);
  const can = {
    control: useHostAllows(device, 'schedules.setEnabled'),
    runNow: useHostAllows(device, 'schedules.runNow'),
    snooze: useHostAllows(device, 'schedules.snooze'),
    edit: useHostAllows(device, 'schedules.update'),
    remove: useHostAllows(device, 'schedules.delete'),
  };
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  // Each failure says what failed: loading the schedule, its run history, or an action.
  const [loadError, setLoadError] = useState('');
  const [runsError, setRunsError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadRuns = useCallback(async () => {
    setRunsError('');
    try {
      setRuns(await scheduleRuns(device, { scheduleId: id }));
    } catch (e) {
      setRunsError((e as Error).message);
    }
  }, [device, id]);
  const load = useCallback(async () => {
    try {
      await refreshSchedules(device);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
    await loadRuns();
  }, [device, loadRuns]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useReloadOnReconnect(device, load);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  /** Runs one change, keeping the list in step; an error shows in the banner. */
  const act = async (work: () => Promise<TaskSchedule | null | void>) => {
    setBusy(true);
    try {
      const next = await work();
      if (next !== undefined) placeSchedule(device, id, next);
      haptic('success');
      setError('');
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runNow = () => act(async () => {
    await runScheduleNow(device, id);
    await load();
  });
  const snooze = () => showActions('Snooze the next run', SNOOZES.map(s => ({ label: s.label, onPress: () => void act(() => snoozeSchedule(device, id, s.minutes)) })));
  const remove = (s: TaskSchedule) => Alert.alert(`Delete “${s.title}”?`, 'It stops sending messages. Its run history stays with the thread.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => void act(async () => { await deleteSchedule(device, id); placeSchedule(device, id, null); router.back(); }) },
  ]);

  if (!schedule) {
    return (
      <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Schedule' }} />
        <HeaderActions right={[]} />
        {loadError ? <EmptyState icon={ERROR_ICON} title="Couldn’t load the schedule" body={loadError} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />
          : listed ? <EmptyState icon={ERROR_ICON} title="This schedule no longer exists." style={styles.empty} />
            : <Group><View style={styles.loading}><Skeleton width="70%" /><Skeleton width="50%" /></View></Group>}
      </PushedScroll>
    );
  }
  const finished = isFinished(schedule);
  const live = schedule.enabled && schedule.nextRunAt !== null;
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: schedule.title }} />
      <HeaderActions right={[{ label: 'Edit', accessibilityLabel: 'Edit schedule', hidden: !can.edit, onPress: () => router.push({ pathname: '/new-schedule', params: { device, id } }) }]} />
      <Banner visible={!!loadError} tone="danger" title="Couldn’t refresh the schedule" body={loadError} action={{ label: 'Retry', onPress: () => void refresh() }} />
      <Banner visible={!!error} tone="danger" title="Couldn’t do that" body={error} />
      <Details device={device} schedule={schedule} />
      <CardSection title="Message">
        <Text selectable style={[text.callout, styles.prompt, { color: colors.text }]}>{schedule.prompt}</Text>
      </CardSection>
      {(can.control || can.runNow || can.snooze || can.remove) && (
        <Group>
          {can.control && !finished && <Row leading={<Glyph icon={{ ios: 'power', android: 'power_settings_new' }} />} title="On"
            trailing={<Toggle accessibilityLabel="Schedule on" value={schedule.enabled} disabled={busy} onValueChange={value => void act(() => setScheduleEnabled(device, id, value))} />} />}
          {can.runNow && <Row leading={<Glyph icon={{ ios: 'play.circle', android: 'play_circle' }} />} title="Run now" disabled={busy || finished} onPress={() => void runNow()} />}
          {can.snooze && live && schedule.kind !== 'after' && <Row leading={<Glyph icon={{ ios: 'moon.zzz', android: 'snooze' }} />} title="Snooze" disabled={busy} chevron onPress={snooze} />}
          {can.remove && <Row leading={<Glyph icon={{ ios: 'trash', android: 'delete' }} tone={colors.danger} />} title="Delete" tone="danger" disabled={busy} onPress={() => remove(schedule)} />}
        </Group>
      )}
      <AccessNote device={device} methods={['schedules.runNow', 'schedules.setEnabled', 'schedules.update', 'schedules.delete']} />
      <History device={device} runs={runs} error={runsError} onRetry={() => void loadRuns()} />
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
  meta: { flexShrink: 1, maxWidth: 220, textAlign: 'right' },
  prompt: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.screenMargin },
});
