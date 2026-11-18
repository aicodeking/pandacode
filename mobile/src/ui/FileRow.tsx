// Changed files, as in the desktop's changed-files tree: name, +/− counts, status chip, under flat
// folder subheads. Used by Changes and the pull request; a row opens its diff. `StageFiles` is Changes'
// list for hosts with the git methods: a switch per file to stage it and, with `onDiscard`, a long press
// (or the VoiceOver action) that offers Discard changes.
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { StageRow } from '../store/git.ts';
import { countParts } from '../store/pull-summary.ts';
import { Card, Chip, CHROME_FONT_SCALE, EXIT_MS, springs, Toggle, useMotion, useStagger, InnerCard, Row, type as text, type Tone } from './ds/index.ts';
import { groupByFolder } from './file-groups.ts';
import { Icon } from './Icon.tsx';
import { mono, useColors } from './theme.ts';
import { useIconSize } from './usePagePadding.ts';

const REFRESH_SCALE = 0.985;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  A: { label: 'Added', tone: 'success' },
  M: { label: 'Modified', tone: 'info' },
  D: { label: 'Deleted', tone: 'danger' },
  R: { label: 'Renamed', tone: 'info' },
  C: { label: 'Copied', tone: 'info' },
  U: { label: 'Conflict', tone: 'warning' },
};

export function Counts({ additions, deletions }: { additions?: number; deletions?: number }) {
  const colors = useColors();
  const { added, removed } = countParts(additions, deletions);
  if (!added && !removed) return null;
  return (
    <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={styles.counts} accessibilityLabel={[added && `${additions} added`, removed && `${deletions} removed`].filter(Boolean).join(', ')}>
      {!!added && <Text style={{ color: colors.success }}>{added}</Text>}
      {!!added && !!removed && ' '}
      {!!removed && <Text style={{ color: colors.danger }}>{removed}</Text>}
    </Text>
  );
}

export interface ListedFile {
  /** Unique in the list: one path can be both staged and unstaged. */
  key: string;
  path: string;
  letter?: string;
  additions?: number;
  deletions?: number;
  note?: string;
}

type DiffTarget = { device: string; session: string; source: 'pull' | 'changes' | 'turn'; staged?: string; turn?: string };

function FileRow({ file, diff }: { file: ListedFile; diff: DiffTarget }) {
  const status = file.letter ? STATUS[file.letter] : undefined;
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  return (
    <Row title={name} subtitle={file.note} chevron
      trailing={(
        <View style={styles.trailing}>
          <Counts additions={file.additions} deletions={file.deletions} />
          <StatusChip letter={file.letter} />
        </View>
      )}
      onPress={() => router.push({ pathname: '/diff', params: { ...diff, path: file.path } })}
      accessibilityHint="Shows the diff"
      accessibilityLabel={[file.path, status?.label, file.note, !!file.additions && `${file.additions} added`, !!file.deletions && `${file.deletions} removed`].filter(Boolean).join(', ')} />
  );
}

export function StatusChip({ letter, style }: { letter?: string; style?: StyleProp<ViewStyle> }) {
  const status = letter ? STATUS[letter] : undefined;
  return status ? <Chip label={status.label} tone={status.tone} style={[styles.chip, style]} /> : null;
}

/** The files in one inner card, flat as the desktop's tree: files at the top level first, so none of them
 * reads as part of a folder above it, then a subhead per folder. `diff` may vary per file (staged or not). */
export function FileGroups({ files, diff, refreshed = 0 }: { files: readonly ListedFile[]; diff: (file: ListedFile) => DiffTarget; refreshed?: number }) {
  const colors = useColors();
  const folderIcon = useIconSize(13);
  const enter = useStagger();
  const { layout, exit } = useMotion();
  const settle = useSharedValue(1);
  const seen = useRef(refreshed);
  useEffect(() => {
    if (seen.current === refreshed) return;
    seen.current = refreshed;
    // A refresh answers with a small settle of the whole card, from wherever it is.
    settle.set(withSequence(withTiming(REFRESH_SCALE, { duration: EXIT_MS, reduceMotion: ReduceMotion.System }), withSpring(1, springs.smooth)));
  }, [refreshed, settle]);
  const card = useAnimatedStyle(() => ({ transform: [{ scale: settle.get() }] }));
  const groups = [...groupByFolder(files)].sort((a, b) => Number(!!a.folder) - Number(!!b.folder));
  const orderOf = new Map(groups.flatMap(g => g.files).map((file, i) => [file.key, i]));
  return (
    <Animated.View style={card}>
      <Card>
        <InnerCard>
          {groups.map(group => (
            <View key={group.folder}>
              {!!group.folder && (
                <View style={styles.folder} accessible accessibilityRole="header" accessibilityLabel={group.folder}>
                  <Icon ios="folder" android="folder" size={folderIcon} color={colors.faint} />
                  <Text numberOfLines={1} ellipsizeMode="head" style={[text.code, styles.folderName, { color: colors.muted }]}>{group.folder}</Text>
                </View>
              )}
              {group.files.map(file => (
                <Animated.View key={file.key} entering={enter(orderOf.get(file.key) ?? 0)} exiting={exit} layout={layout}>
                  <FileRow file={file} diff={diff(file)} />
                </Animated.View>
              ))}
            </View>
          ))}
        </InnerCard>
      </Card>
    </Animated.View>
  );
}

const STAGE_LABEL: Record<StageRow['stage'], string> = { all: 'Staged', none: 'Not staged', partial: 'Partly staged' };
const DISCARD_ACTION = 'discard';
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Each changed file with its status and a switch that stages or unstages it; tapping the row opens its diff.
 * `onDiscard` (only where the host serves git.discard) adds a long press and a VoiceOver action for it. */
export function StageFiles({ rows, device, session, pending, disabled, onToggle, onDiscard }: {
  rows: readonly StageRow[]; device: string; session: string; pending: ReadonlySet<string>; disabled?: boolean;
  onToggle: (path: string, staged: boolean) => void; onDiscard?: (path: string) => void;
}) {
  const enter = useStagger();
  const { layout, exit } = useMotion();
  return (
    <Card>
      <InnerCard>
        {rows.map((row, i) => {
          const folder = folderOf(row.path);
          // A partly staged file opens its unstaged half, the part still to decide on.
          const staged = row.stage === 'all' ? '1' : '0';
          const discard = onDiscard && !pending.has(row.path) ? () => onDiscard(row.path) : undefined;
          return (
            <Animated.View key={row.path} entering={enter(i)} exiting={exit} layout={layout}>
              <Row title={row.path.slice(row.path.lastIndexOf('/') + 1)} subtitle={[folder, row.stage === 'partial' ? STAGE_LABEL.partial : ''].filter(Boolean).join(' · ') || undefined}
                leading={<StatusChip letter={row.letter} />}
                trailing={<Toggle value={row.stage !== 'none'} disabled={disabled || pending.has(row.path)} accessibilityLabel={`Stage ${row.path}`} onValueChange={value => onToggle(row.path, value)} />}
                onPress={() => router.push({ pathname: '/diff', params: { device, session, source: 'changes', staged, path: row.path } })}
                onLongPress={discard}
                accessibilityActions={discard ? [{ name: DISCARD_ACTION, label: 'Discard changes' }] : undefined}
                onAccessibilityAction={discard ? event => { if (event.nativeEvent.actionName === DISCARD_ACTION) discard(); } : undefined}
                accessibilityHint={discard ? 'Shows the diff. Long press to discard its changes' : 'Shows the diff'} accessibilityLabel={`${row.path}, ${STAGE_LABEL[row.stage]}`} />
            </Animated.View>
          );
        })}
      </InnerCard>
    </Card>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'center' },
  counts: { ...text.caption, fontFamily: mono, fontVariant: ['tabular-nums'] },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30, paddingHorizontal: 12, paddingTop: 6 },
  folderName: { flex: 1 },
});
