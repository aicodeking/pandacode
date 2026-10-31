// A changed file in the Changes and pull request lists: status letter, path, +/− counts; opens its diff.
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon.tsx';
import { mono, useColors } from './theme.ts';

export function Counts({ additions, deletions }: { additions?: number; deletions?: number }) {
  const colors = useColors();
  if (additions === undefined && deletions === undefined) return null;
  return (
    <Text style={styles.counts} accessibilityLabel={`${additions ?? 0} added, ${deletions ?? 0} removed`}>
      <Text style={{ color: colors.green }}>+{additions ?? 0}</Text> <Text style={{ color: colors.red }}>−{deletions ?? 0}</Text>
    </Text>
  );
}

export function FileRow({ letter, path, additions, deletions, note, diff, last }: {
  letter?: string; path: string; additions?: number; deletions?: number; note?: string; last?: boolean;
  diff: { device: string; session: string; source: 'pull' | 'changes'; staged?: string };
}) {
  const colors = useColors();
  const slash = path.lastIndexOf('/');
  const color = letter === 'A' ? colors.green : letter === 'D' ? colors.red : letter === 'U' ? colors.orange : colors.tint;
  return (
    <Pressable onPress={() => router.push({ pathname: '/diff', params: { ...diff, path } })} accessibilityRole="button" accessibilityHint="Shows the diff"
      style={({ pressed }) => [styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }, pressed && { opacity: 0.6 }]}>
      {!!letter && <Text style={[styles.letter, { color }]}>{letter}</Text>}
      <View style={styles.text}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{path.slice(slash + 1)}</Text>
        {(slash > 0 || !!note) && <Text style={[styles.dir, { color: colors.secondary }]} numberOfLines={1} ellipsizeMode="head">{[path.slice(0, slash), note].filter(Boolean).join(' · ')}</Text>}
      </View>
      <Counts additions={additions} deletions={deletions} />
      <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6 },
  letter: { width: 16, fontFamily: mono, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  text: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontFamily: mono },
  dir: { fontSize: 12, fontFamily: mono },
  counts: { fontSize: 13, fontFamily: mono },
});
