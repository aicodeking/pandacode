// A computer's task schedules (?device=), like the desktop's Schedules settings: each schedule's
// cadence, thread and next run, with an on/off toggle (schedules.setEnabled). A row opens
// schedule.tsx; + opens the New schedule sheet. Hidden actions follow what the host serves.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { placeSchedule, refreshSchedules, setScheduleEnabled, useSchedules } from '../connect/api/schedules.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import { cadence, isFinished, nextLine, sortSchedules, type TaskSchedule } from '../store/schedules.ts';
import { Banner, Card, EmptyState, geometry, haptic, InnerCard, Row, Skeleton, Toggle, useStagger } from '../ui/ds/index.ts';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const CLOCK_ICON = { ios: 'clock.arrow.circlepath', android: 'schedule' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

function ScheduleRow({ device, schedule, canToggle, onError }: { device: string; schedule: TaskSchedule; canToggle: boolean; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    haptic('selection');
    try {
      placeSchedule(device, schedule.id, await setScheduleEnabled(device, schedule.id, enabled));
      onError('');
    } catch (e) {
      haptic('error');
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const subtitle = [cadence(schedule), schedule.sessionTitle, nextLine(schedule)].filter(Boolean).join(' · ');
  return (
    <Row title={schedule.title} subtitle={subtitle} chevron={!canToggle}
      trailing={canToggle && !isFinished(schedule) ? <Toggle accessibilityLabel={`${schedule.title} on`} value={schedule.enabled} disabled={busy} onValueChange={value => void toggle(value)} /> : undefined}
      onPress={() => router.push({ pathname: '/schedule', params: { device, id: schedule.id } })} />
  );
}

export default function SchedulesScreen() {
  const { device = '' } = useLocalSearchParams<{ device: string }>();
  const scroll = usePushedScroll();
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const supported = useHostSupports(device, 'schedules.list');
  const canToggle = useHostAllows(device, 'schedules.setEnabled');
  const canCreate = useHostAllows(device, 'schedules.create');
  const list = useSchedules(s => s[device]);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!list);
  const load = useCallback(() => refreshSchedules(device).then(() => setError(''), (e: Error) => setError(e.message)), [device]);
  // Back from a schedule or the sheet, the list is read again.
  useFocusEffect(useCallback(() => { if (supported) void load(); }, [load, supported]));
  useReloadOnReconnect(device, () => (supported ? load() : undefined));
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const schedules = list ? sortSchedules(list.schedules) : [];
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Schedules' }} />
      <HeaderActions right={[{ label: 'New schedule', icon: { ios: 'plus', android: 'add' }, hidden: !supported || !canCreate, onPress: () => router.push({ pathname: '/new-schedule', params: { device } }) }]} />
      {!supported && <EmptyState icon={CLOCK_ICON} title={outdated(computer)} style={styles.empty} />}
      {supported && <AccessNote device={device} methods={['schedules.create', 'schedules.setEnabled']} />}
      {supported && !list && !error && <Card><InnerCard style={styles.loading}><Skeleton width="70%" /><Skeleton width="50%" /><Skeleton width="60%" /></InnerCard></Card>}
      {supported && !list && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the schedules" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />}
      <Banner visible={!!list?.paused} tone="info" title="The scheduler is paused" body={`Nothing runs until it is resumed in Settings on ${computer}.`} />
      <Banner visible={!!list && !!(error || actionError)} tone="danger" title={actionError ? 'Couldn’t change the schedule' : 'Couldn’t refresh'} body={actionError || error} />
      {list && !schedules.length && (
        <EmptyState icon={CLOCK_ICON} title="No schedules" body="Schedules send a thread a message on a timer, or when another thread finishes."
          action={canCreate ? { label: 'New schedule', onPress: () => router.push({ pathname: '/new-schedule', params: { device } }) } : undefined} style={styles.empty} />
      )}
      {schedules.length > 0 && (
        <Card>
          <InnerCard>
            {schedules.map((schedule, i) => (
              <Animated.View key={schedule.id} entering={enter(i)}>
                <ScheduleRow device={device} schedule={schedule} canToggle={canToggle} onError={setActionError} />
              </Animated.View>
            ))}
          </InnerCard>
        </Card>
      )}
      <Banner visible={!!list?.truncated} tone="info" title="Some schedules were left out to fit." />
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
});
