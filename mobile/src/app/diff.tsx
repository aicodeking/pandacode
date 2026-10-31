// One file's diff, from the pull request (task.pullDiff) or the task's checkout (task.diff).
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { Diff } from '../connect/types.ts';
import { useBackdrop } from '../ui/Backdrop.tsx';
import { DiffView } from '../ui/DiffView.tsx';
import { useColors } from '../ui/theme.ts';

export default function DiffScreen() {
  const { device = '', session = '', path = '', source = 'changes', staged } = useLocalSearchParams<{ device: string; session: string; path: string; source?: 'pull' | 'changes'; staged?: string }>();
  const colors = useColors();
  const backdrop = useBackdrop();
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = source === 'pull' ? connect.pullDiff(device, session, path) : connect.taskDiff(device, session, path, staged === '1');
    load.then(setDiff, (e: Error) => setError(e.message));
  }, [device, session, path, source, staged]);
  const note = error || (diff && !diff.text ? 'No changes to show for this file.' : '');
  return (
    <View style={[styles.screen, { backgroundColor: backdrop.background }]}>
      <Stack.Screen options={{ title: path.split('/').pop() || 'Diff' }} />
      {!diff && !error ? <ActivityIndicator style={styles.center} />
        : note ? <Text style={[styles.note, { color: colors.secondary }]}>{note}</Text>
        : <DiffView diff={diff!.text} />}
      {diff?.truncated && <Text style={[styles.truncated, { color: colors.secondary, backgroundColor: colors.card }]}>This diff was cut short. See the rest on the computer.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { marginTop: 120 },
  note: { fontSize: 15, textAlign: 'center', marginTop: 120, paddingHorizontal: 32 },
  truncated: { position: 'absolute', left: 16, right: 16, bottom: 30, fontSize: 13, padding: 10, borderRadius: 12, overflow: 'hidden', textAlign: 'center' },
});
