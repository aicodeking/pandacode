// What one turn changed (turn.summary), as the desktop's turn footer opens it: the turn's totals and
// each file with its status and +/− counts. A file opens that turn's patch for it (turn.diff).
// Shown by Changes when it is opened from a transcript's "N changed files" row. A secret file's
// patch is refused below Full (diff.tsx says so); SecretsNote also serves Changes' hiddenSecrets.
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { turnSummary, type TurnFile, type TurnSummary } from '../connect/api/git.ts';
import { Banner, Card, EmptyState, geometry, InnerCard, Row, Skeleton, type, useStagger } from './ds/index.ts';
import { Counts, FileGroups, type ListedFile } from './FileRow.tsx';
import { Icon } from './Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from './PushedScroll.tsx';
import { useColors } from './theme.ts';
import { useIconSize } from './usePagePadding.ts';

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const EMPTY_ICON = { ios: 'doc.text.magnifyingglass', android: 'find_in_page' } as const;
const LETTERS: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', copied: 'C' };

/** The host's refusal of a secret file's diff (turn.diff, task.diff with a path) to a phone below
 * Full: "This file may hold secrets. Give this phone Full access on the computer to …". */
export const isSecretRefusal = (message: string) => message.startsWith('This file may hold secrets.');

/** task.diff's `hiddenSecrets` (secret files left out for a phone below Full) as a note, or null. */
export function hiddenSecretsText(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
  return `${count} ${count === 1 ? 'file' : 'files'} hidden — secret files need Full access`;
}

/** A small lock note for secret files the host left out; nothing when there are none. */
export function SecretsNote({ count }: { count: unknown }) {
  const colors = useColors();
  const text = hiddenSecretsText(count);
  if (!text) return null;
  return (
    <View accessibilityRole="text" style={[styles.note, { backgroundColor: colors.cardInner, borderColor: colors.border }]}>
      <Icon ios="lock.fill" android="lock" size={14} color={colors.muted} />
      <Text style={[type.footnote, styles.noteText, { color: colors.muted }]}>{text}</Text>
    </View>
  );
}

/** A turn file's status word as the one-letter Git status the file rows show. */
export const turnLetter = (status: string): string => LETTERS[status.trim().toLowerCase()] ?? 'M';

export const turnFiles = (files: readonly TurnFile[]): ListedFile[] => files.map(f => ({
  key: f.path, path: f.path, letter: turnLetter(f.status),
  note: f.binary ? 'Binary' : f.oldPath ? `From ${f.oldPath}` : undefined,
  additions: f.additions ?? undefined, deletions: f.deletions ?? undefined,
}));

function Totals({ summary }: { summary: TurnSummary }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  const count = summary.files.length;
  const title = `${count} changed ${count === 1 ? 'file' : 'files'}`;
  return (
    <Card>
      <InnerCard accessible accessibilityLabel={`${title}, ${summary.additions} added, ${summary.deletions} removed`}>
        <Row title={title} subtitle="Changed in this turn" leading={<Icon ios="sparkles" android="auto_awesome" size={iconSize} color={colors.muted} />}
          trailing={<Counts additions={summary.additions} deletions={summary.deletions} />} />
      </InnerCard>
    </Card>
  );
}

export function TurnChanges({ device, session, turn }: { device: string; session: string; turn: string }) {
  const scroll = usePushedScroll();
  const [summary, setSummary] = useState<TurnSummary | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!summary);
  const messageId = Number(turn);
  const load = useCallback(() => turnSummary(device, session, messageId)
    .then(reply => { setSummary(reply); setError(''); }, (e: Error) => setError(e.message)), [device, session, messageId]);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const retry = () => { setError(''); void load(); };
  const files = summary ? turnFiles(summary.files) : [];
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Turn changes' }} />
      {!summary && !error && <Card><View style={styles.loading}><Skeleton width="60%" /><Skeleton width="80%" /></View></Card>}
      {!summary && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load this turn’s changes" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />}
      <Banner visible={!!summary && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: retry }} />
      {summary && (
        <>
          <Animated.View entering={enter(0)}><Totals summary={summary} /></Animated.View>
          {/* Hosts that leave secret files out of a turn for phones below Full say how many. */}
          <SecretsNote count={(summary as TurnSummary & { hiddenSecrets?: number }).hiddenSecrets} />
          {files.length > 0
            ? <Animated.View entering={enter(1)}><FileGroups files={files} diff={() => ({ device, session, source: 'turn', turn })} /></Animated.View>
            : <EmptyState icon={EMPTY_ICON} title="No files recorded for this turn." style={styles.empty} />}
          <Banner visible={summary.truncated} tone="info" title="Some files aren’t listed." body="See the full list on the computer." />
        </>
      )}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: 12 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: geometry.rowInset, paddingVertical: 8, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  noteText: { flex: 1, minWidth: 0 },
});
