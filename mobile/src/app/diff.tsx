// One file's diff, from the pull request (task.pullDiff), the task's checkout (task.diff) or one turn
// of the task (turn.diff, `turn` being the message id). A secret file's diff is refused below Full:
// that shows as its own note, not an error to retry.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../connect/client.ts';
import { turnDiff } from '../connect/api/git.ts';
import type { Diff } from '../connect/types.ts';
import { useColors } from '../ui/theme.ts';
import { DiffView } from '../ui/DiffView.tsx';
import { isSecretRefusal } from '../ui/TurnChanges.tsx';
import { PUSHED_HEADER } from '../ui/PushedScroll.tsx';
import { Counts, StatusChip } from '../ui/FileRow.tsx';
import { hasGlass } from '../ui/Glass.tsx';
import { diffSummary } from '../store/diff.ts';
import { Banner, Card, InnerCard, Row, EmptyState, Skeleton, geometry } from '../ui/ds/index.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { usePaneInsets } from '../ui/split.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const PAGE_TOP = geometry.screenMargin;
const WIDTHS = ['62%', '88%', '74%', '40%', '92%', '56%', '80%'] as const;
const CODE_ICON = { ios: 'plus.forwardslash.minus', android: 'difference' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const LOCK_ICON = { ios: 'lock.fill', android: 'lock' } as const;

/** A turn's patch for one file as a Diff; a binary file has no text to show. */
async function loadTurnDiff(device: string, session: string, messageId: number, path: string): Promise<Diff> {
  const reply = await turnDiff(device, session, messageId, path);
  if (reply.error) throw new Error(reply.error);
  return { text: reply.binary ? '' : reply.patch ?? '', truncated: !!reply.truncated };
}

export default function DiffScreen() {
  const { device = '', session = '', path = '', source = 'changes', staged, turn } = useLocalSearchParams<{ device: string; session: string; path: string; source?: 'pull' | 'changes' | 'turn'; staged?: string; turn?: string }>();
  const colors = useColors();
  const header = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const side = usePaneInsets();
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const asked = source === 'pull' ? connect.pullDiff(device, session, path)
      : source === 'turn' ? loadTurnDiff(device, session, Number(turn), path)
      : connect.taskDiff(device, session, path, staged === '1');
    return asked.then(next => { setDiff(next); setError(''); }, (e: Error) => setError(e.message));
  }, [device, session, path, source, staged, turn]);
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  const summary = useMemo(() => (diff ? diffSummary(diff.text) : null), [diff]);
  const name = path.split('/').pop() ?? '';
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  const retry = () => { setError(''); void load(); };
  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: (hasGlass ? header : 0) + PAGE_TOP, paddingBottom: insets.bottom + PAGE_TOP, paddingLeft: geometry.screenMargin + side.left, paddingRight: geometry.screenMargin + side.right }]}>
      <Stack.Screen options={{ scrollEdgeEffects: PUSHED_HEADER.scrollEdgeEffects, headerShadowVisible: false, title: name || 'Diff' }} />
      <HeaderActions />
      {error && isSecretRefusal(error) ? <EmptyState icon={LOCK_ICON} title="This file may hold secrets" body="Secret files need Full access. Give this phone Full access on the computer to see its changes." style={styles.center} />
        : error ? <EmptyState icon={ERROR_ICON} title="Couldn’t load this diff" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.center} />
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
      <Banner visible={!!diff?.truncated} tone="info" title="This diff was cut short." body="See the rest on the computer." style={[styles.truncated, { left: geometry.screenMargin + side.left, right: geometry.screenMargin + side.right, bottom: insets.bottom + geometry.screenMargin }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: geometry.sectionGap },
  center: { marginTop: geometry.emptyTop },
  skeleton: { paddingTop: geometry.rowInset, gap: geometry.sectionGap },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  truncated: { position: 'absolute' },
});
