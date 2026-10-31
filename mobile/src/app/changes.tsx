// The task's uncommitted changes (task.changes): branch, ahead/behind and each file with its Git
// status and +/− counts (from task.diff). Tapping a file opens its diff. Pull to refresh; it also
// refreshes when a run ends.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { Changes } from '../connect/types.ts';
import { fileCounts, statusLetter } from '../store/diff.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { useBackdrop } from '../ui/Backdrop.tsx';
import { FileRow } from '../ui/FileRow.tsx';
import { Icon } from '../ui/Icon.tsx';
import { isActive } from '../ui/status.tsx';
import { mono, useColors } from '../ui/theme.ts';

type Loaded = Changes & { counts: ReturnType<typeof fileCounts> };

export default function ChangesScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const backdrop = useBackdrop();
  const running = useConnect(s => isActive(s.live[taskKey(device, session)]?.status ?? 'idle'));
  const [changes, setChanges] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // One full diff gives every file's counts; staged-only files have none.
  const load = useCallback(() => Promise.all([connect.taskChanges(device, session), connect.taskDiff(device, session).catch(() => null)])
    .then(([list, diff]) => { setChanges({ ...list, counts: diff ? fileCounts(diff.text) : {} }); setError(''); }, (e: Error) => setError(e.message)), [device, session]);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  useEffect(() => { void load(); }, [load]);
  // Again whenever a run ends.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [running, load]);

  const sync = changes && [changes.ahead && `${changes.ahead} ahead`, changes.behind && `${changes.behind} behind`].filter(Boolean).join(', ');
  return (
    <ScrollView style={{ backgroundColor: backdrop.background }} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: 'Changes' }} />
      {!changes && !error && <ActivityIndicator style={styles.spinner} />}
      {!!error && <Text style={[styles.note, { color: colors.secondary }]}>{error}</Text>}
      {changes && (
        <>
          <View style={styles.branch}>
            <Icon ios="arrow.triangle.branch" android="call_split" size={15} color={colors.green} />
            <Text style={[styles.branchName, { color: colors.text }]} numberOfLines={1}>{changes.branch || 'No branch'}</Text>
            {!!sync && <Text style={[styles.sync, { color: colors.secondary }]}>{sync}</Text>}
          </View>
          {changes.files.length ? (
            <View style={[styles.group, { backgroundColor: backdrop.card }]}>
              {changes.files.map((f, i) => {
                const counts = changes.counts[f.path];
                return <FileRow key={`${f.staged}/${f.path}`} letter={statusLetter(f.status)} path={f.path} additions={counts?.additions} deletions={counts?.deletions}
                  note={f.staged ? 'Staged' : undefined} last={i === changes.files.length - 1} diff={{ device, session, source: 'changes', staged: f.staged ? '1' : '0' }} />;
              })}
            </View>
          ) : <Text style={[styles.note, { color: colors.secondary }]}>No uncommitted changes.</Text>}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12, paddingBottom: 40 },
  spinner: { marginTop: 80 },
  note: { fontSize: 15, textAlign: 'center', marginTop: 60, paddingHorizontal: 16 },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  branchName: { flex: 1, fontFamily: mono, fontSize: 15, fontWeight: '600' },
  sync: { fontSize: 14 },
  group: { borderRadius: 16, paddingHorizontal: 14, borderCurve: 'continuous' },
});
