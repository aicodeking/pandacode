// A unified diff in a monospace, horizontally scrollable view: added lines green, removed red,
// hunk headers tinted. Lines are virtualized; the width fits the longest line.
import { useMemo } from 'react';
import { FlatList, PixelRatio, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { diffLines, type DiffKind, type DiffLine } from '../store/diff.ts';
import { mono, useColors } from './theme.ts';

const FONT = 12;
const LINE = 17;
/** Menlo's advance at 12 pt; a little over, so the longest line never clips. */
const CHAR = 7.3;
const PAD = 12;
const FILL: Record<DiffKind, string | undefined> = { add: 'rgba(52, 199, 89, 0.18)', del: 'rgba(255, 59, 48, 0.16)', hunk: 'rgba(10, 132, 255, 0.14)', meta: undefined, context: undefined };

export function DiffView({ diff }: { diff: string }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const lines = useMemo(() => diffLines(diff), [diff]);
  const wide = useMemo(() => Math.max(width, lines.reduce((max, l) => Math.max(max, l.text.length), 0) * CHAR * PixelRatio.getFontScale() + PAD * 2), [lines, width]);
  const row = ({ item }: { item: DiffLine }) => (
    <View style={[styles.line, { backgroundColor: FILL[item.kind] }]}>
      <Text style={[styles.text, { color: item.kind === 'meta' || item.kind === 'hunk' ? colors.secondary : colors.text }]} numberOfLines={1}>{item.text || ' '}</Text>
    </View>
  );
  return (
    <ScrollView horizontal contentContainerStyle={{ width: wide }} directionalLockEnabled>
      <FlatList data={lines} renderItem={row} keyExtractor={(_, i) => String(i)} style={{ width: wide }}
        contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.list}
        getItemLayout={(_, index) => ({ length: LINE, offset: LINE * index, index })} initialNumToRender={60} windowSize={11} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 40 },
  line: { height: LINE, paddingHorizontal: PAD, justifyContent: 'center' },
  text: { fontFamily: mono, fontSize: FONT, lineHeight: LINE },
});
