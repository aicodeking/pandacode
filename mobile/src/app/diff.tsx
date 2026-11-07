// One file's diff, from the pull request (task.pullDiff) or the task's checkout (task.diff).
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../connect/client.ts';
import type { Diff } from '../connect/types.ts';
import { useColors } from '../ui/theme.ts';
import { DiffView } from '../ui/DiffView.tsx';
import { PUSHED_HEADER } from '../ui/PushedScroll.tsx';
import { Counts, StatusChip } from '../ui/FileRow.tsx';
import { hasGlass } from '../ui/Glass.tsx';
import { diffSummary } from '../store/diff.ts';
import { Banner, Card, InnerCard, Row, EmptyState, Skeleton, geometry } from '../ui/ds/index.ts';

const PAGE_TOP = geometry.screenMargin;
const WIDTHS = ['62%', '88%', '74%', '40%', '92%', '56%', '80%'] as const;
const CODE_ICON = { ios: 'plus.forwardslash.minus', android: 'difference' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

export default function DiffScreen() {
  const { device = '', session = '', path = '', source = 'changes', staged } = useLocalSearchParams<{ device: string; session: string; path: string; source?: 'pull' | 'changes'; staged?: string }>();
  const colors = useColors();
  const header = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const asked = source === 'pull' ? connect.pullDiff(device, session, path) : connect.taskDiff(device, session, path, staged === '1');
    return asked.then(setDiff, (e: Error) => setError(e.message));
  }, [device, session, path, source, staged]);
  useEffect(() => { void load(); }, [load]);
  const summary = useMemo(() => (diff ? diffSummary(diff.text) : null), [diff]);
  const name = path.split('/').pop() ?? '';
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  const retry = () => { setError(''); void load(); };
  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: (hasGlass ? header : 0) + PAGE_TOP, paddingBottom: insets.bottom + PAGE_TOP, paddingLeft: geometry.screenMargin + insets.left, paddingRight: geometry.screenMargin + insets.right }]}>
      <Stack.Screen options={{ scrollEdgeEffects: PUSHED_HEADER.scrollEdgeEffects, headerShadowVisible: false, title: name || 'Diff' }} />
      {error ? <EmptyState icon={ERROR_ICON} title="Couldn’t load this diff" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.center} />
        : !diff ? <View style={styles.skeleton}>{WIDTHS.map((width, i) => <Skeleton key={i} width={width} />)}</View>
        : !diff.text ? <EmptyState icon={CODE_ICON} title="No changes to show for this file." style={styles.center} />
        : (
          <>
            <Card>
              <InnerCard>
                <Row title={folder || 'Top level'}
                  trailing={<View style={styles.trailing}><Counts additions={summary?.additions} deletions={summary?.deletions} /><StatusChip letter={summary?.letter} /></View>} />
              </InnerCard>
            </Card>
            <DiffView diff={diff.text} />
          </>
        )}
      <Banner visible={!!diff?.truncated} tone="info" title="This diff was cut short." body="See the rest on the computer." style={styles.truncated} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 10 },
  center: { marginTop: 80 },
  skeleton: { paddingTop: 12, gap: 10 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  truncated: { position: 'absolute', left: geometry.screenMargin, right: geometry.screenMargin, bottom: 30 },
});
