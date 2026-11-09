// The task's uncommitted changes (task.changes): branch, ahead/behind and each file under its folder
// with its Git status and +/− counts (from task.diff). Tapping a file opens its diff. Pull to
// refresh; it also refreshes when a run ends.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { connect } from '../connect/client.ts';
import type { Changes } from '../connect/types.ts';
import { fileCounts, statusLetter } from '../store/diff.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { useColors } from '../ui/theme.ts';
import { Banner, Card, crossFadeIn, crossFadeOut, EmptyState, InnerCard, Row, Skeleton, springs, useStagger } from '../ui/ds/index.ts';
import { statusTally } from '../ui/file-groups.ts';
import { Counts, FileGroups, type ListedFile } from '../ui/FileRow.tsx';
import { Icon } from '../ui/Icon.tsx';
import { isActive } from '../ui/status.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useIconSize } from '../ui/usePagePadding.ts';

type Loaded = Changes & { counts: ReturnType<typeof fileCounts> };

const CLEAN_ICON = { ios: 'checkmark.circle', android: 'check_circle' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

const stagedFlag = (file: ListedFile) => (file.note ? '1' : '0');

function Loading() {
  return (
    <Card>
      <InnerCard style={styles.loading}>
        <Skeleton width="55%" height={16} />
        <Skeleton width="80%" />
        <Skeleton width="70%" />
      </InnerCard>
    </Card>
  );
}

/** Added against removed lines, sliding to the new balance when a refresh changes it. */
function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const colors = useColors();
  const share = additions / Math.max(1, additions + deletions);
  const added = useSharedValue(share);
  useEffect(() => { added.set(withSpring(share, springs.smooth)); }, [share, added]);
  const green = useAnimatedStyle(() => ({ transform: [{ scaleX: added.get() }] }));
  const red = useAnimatedStyle(() => ({ transform: [{ scaleX: 1 - added.get() }] }));
  return (
    <View style={[styles.bar, { backgroundColor: colors.fill }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.barPart, styles.barAdded, { backgroundColor: colors.success }, green]} />
      <Animated.View style={[styles.barPart, styles.barRemoved, { backgroundColor: colors.danger }, red]} />
    </View>
  );
}

function BranchCard({ changes, letters }: { changes: Loaded; letters: readonly string[] }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  const totals = Object.values(changes.counts);
  const additions = totals.reduce((n, c) => n + c.additions, 0);
  const deletions = totals.reduce((n, c) => n + c.deletions, 0);
  const tally = statusTally(letters);
  const sync = [changes.ahead > 0 && `${changes.ahead} ahead`, changes.behind > 0 && `${changes.behind} behind`].filter(Boolean).join(' · ');
  const subtitle = [tally || 'No uncommitted changes', sync].filter(Boolean).join(' · ');
  const label = `${additions}/${deletions}`;
  return (
    <Card>
      <InnerCard accessible accessibilityLabel={[changes.branch || 'No branch', subtitle].join(', ')}>
        <Row title={changes.branch || 'No branch'} subtitle={subtitle} leading={<Icon ios="arrow.triangle.branch" android="call_split" size={iconSize} color={colors.muted} />}
          trailing={additions + deletions > 0 ? (
            // The numbers cross-fade when a refresh changes them.
            <LayoutAnimationConfig skipEntering>
              <Animated.View key={label} entering={crossFadeIn} exiting={crossFadeOut}><Counts additions={additions} deletions={deletions} /></Animated.View>
            </LayoutAnimationConfig>
          ) : undefined} />
        {additions + deletions > 0 && <StatBar additions={additions} deletions={deletions} />}
      </InnerCard>
    </Card>
  );
}

export default function ChangesScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const scroll = usePushedScroll();
  const running = useConnect(s => isActive(s.live[taskKey(device, session)]?.status ?? 'idle'));
  const [changes, setChanges] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!changes);
  // One full diff gives every file's counts; staged-only files have none.
  const load = useCallback(() => Promise.all([connect.taskChanges(device, session), connect.taskDiff(device, session).catch(() => null)])
    .then(([list, diff]) => { setChanges({ ...list, counts: diff ? fileCounts(diff.text) : {} }); setError(''); }, (e: Error) => setError(e.message)), [device, session]);
  const [refreshed, setRefreshed] = useState(0);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); setRefreshed(n => n + 1); };
  useEffect(() => { void load(); }, [load]);
  // Again whenever a run ends.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [running, load]);

  const retry = () => { setError(''); void load(); };
  const files: ListedFile[] = (changes?.files ?? []).map(f => ({
    key: `${f.staged}/${f.path}`, path: f.path, letter: statusLetter(f.status), note: f.staged ? 'Staged' : undefined,
    additions: changes?.counts[f.path]?.additions, deletions: changes?.counts[f.path]?.deletions,
  }));
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Changes' }} />
      {!changes && !error && <Loading />}
      {!changes && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the changes" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />}
      <Banner visible={!!changes && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: retry }} />
      {changes && (
        <>
          <Animated.View entering={enter(0)}><BranchCard changes={changes} letters={files.flatMap(f => f.letter ?? [])} /></Animated.View>
          {files.length ? (
            <Animated.View entering={enter(1)}>
              <FileGroups files={files} refreshed={refreshed} diff={file => ({ device, session, source: 'changes', staged: stagedFlag(file) })} />
            </Animated.View>
          ) : <View><EmptyState icon={CLEAN_ICON} title="No uncommitted changes." style={styles.empty} /></View>}
        </>
      )}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 48 },
  loading: { padding: 12, gap: 12 },
  bar: { height: 3, marginHorizontal: 12, marginBottom: 8, borderRadius: 1.5, overflow: 'hidden' },
  barPart: { ...StyleSheet.absoluteFill },
  barAdded: { transformOrigin: 'left' },
  barRemoved: { transformOrigin: 'right' },
});
