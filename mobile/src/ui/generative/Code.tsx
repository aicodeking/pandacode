// Monospace boxes for generative UI: code and terminal output with a Copy button, and a
// read-only diff (line kinds from src/store/diff.ts). Long lines scroll sideways.
import * as Clipboard from 'expo-clipboard';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { diffLines, type DiffKind } from '../../store/diff.ts';
import { mono, useColors } from '../theme.ts';

const MAX_LINES = 400;
const FILL: Record<DiffKind, string | undefined> = { add: 'rgba(52, 199, 89, 0.18)', del: 'rgba(255, 59, 48, 0.16)', hunk: 'rgba(10, 132, 255, 0.14)', meta: undefined, context: undefined };

function Frame({ label, copy, children }: { label?: string; copy: string; children: ReactNode }) {
  const colors = useColors();
  const [copied, setCopied] = useState('');
  const onCopy = () => Clipboard.setStringAsync(copy).then(() => setCopied('Copied'), () => setCopied('Copy failed'));
  return (
    <View style={[styles.frame, { backgroundColor: colors.fill }]}>
      <View style={[styles.head, { borderColor: colors.separator }]}>
        <Text style={[styles.label, { color: colors.secondary }]} numberOfLines={1}>{label ?? ''}</Text>
        <Pressable onPress={onCopy} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Copy ${label ?? 'code'}`}>
          <Text style={[styles.copy, { color: colors.tint }]}>{copied || 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal directionalLockEnabled contentContainerStyle={styles.scroll}>{children}</ScrollView>
    </View>
  );
}

export function CodeBox({ label, code, command }: { label?: string; code: string; command?: string }) {
  const colors = useColors();
  const shown = useMemo(() => code.split('\n').slice(0, MAX_LINES).join('\n'), [code]);
  return (
    <Frame label={label} copy={code}>
      <Text selectable style={[styles.text, { color: colors.text }]}>
        {!!command && <Text style={{ color: colors.green }}>{`$ ${command}\n`}</Text>}
        {shown}
      </Text>
    </Frame>
  );
}

export function DiffBox({ file, diff }: { file?: string; diff: string }) {
  const colors = useColors();
  const lines = useMemo(() => diffLines(diff).slice(0, MAX_LINES), [diff]);
  const tone = (kind: DiffKind): ColorValue => (kind === 'meta' || kind === 'hunk' ? colors.secondary : colors.text);
  return (
    <Frame label={file ?? 'Diff'} copy={diff}>
      <View>{lines.map((line, i) => <Text key={i} style={[styles.text, styles.line, { color: tone(line.kind), backgroundColor: FILL[line.kind] }]}>{line.text || ' '}</Text>)}</View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, overflow: 'hidden', borderCurve: 'continuous' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  copy: { fontSize: 13, fontWeight: '600' },
  scroll: { padding: 10 },
  text: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  line: { paddingHorizontal: 4 },
});
