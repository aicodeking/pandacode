// Monospace boxes for generative UI: code and terminal output with a Copy button, and a
// read-only diff (line kinds from src/store/diff.ts). Long lines scroll sideways.
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { diffLines, type DiffKind } from '../../store/diff.ts';
import { Button, geometry, haptic, InnerCard, type as textStyle } from '../ds/index.ts';
import { type Colors, mono, useColors } from '../theme.ts';

const MAX_LINES = 400;
const COPIED_MS = 1400;
const fill = (colors: Colors): Record<DiffKind, string | undefined> => ({ add: colors.successFill, del: colors.dangerFill, hunk: colors.infoFill, meta: undefined, context: undefined });

function Frame({ label, copy, children }: { label?: string; copy: string; children: ReactNode }) {
  const colors = useColors();
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(''), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const onCopy = () => Clipboard.setStringAsync(copy).then(() => { haptic('success'); AccessibilityInfo.announceForAccessibility('Copied'); setCopied('Copied'); }, () => { haptic('error'); setCopied('Copy failed'); });
  return (
    <InnerCard style={styles.frame}>
      <View style={[styles.head, { borderColor: colors.border }]}>
        <Text style={[textStyle.footnoteMedium, styles.label, { color: colors.muted }]} numberOfLines={1}>{label ?? ''}</Text>
        <Button label={copied || 'Copy'} icon={copied === 'Copied' ? { ios: 'checkmark', android: 'check' } : undefined} variant="plain" size="small" onPress={onCopy} accessibilityLabel={`Copy ${label ?? 'code'}`} />
      </View>
      <ScrollView horizontal directionalLockEnabled contentContainerStyle={styles.scroll}>{children}</ScrollView>
    </InnerCard>
  );
}

export function CodeBox({ label, code, command }: { label?: string; code: string; command?: string }) {
  const colors = useColors();
  const shown = useMemo(() => code.split('\n').slice(0, MAX_LINES).join('\n'), [code]);
  return (
    <Frame label={label} copy={code}>
      <Text selectable style={[styles.text, { color: colors.text }]}>
        {!!command && <Text style={{ color: colors.success }}>{`$ ${command}\n`}</Text>}
        {shown}
      </Text>
    </Frame>
  );
}

export function DiffBox({ file, diff }: { file?: string; diff: string }) {
  const colors = useColors();
  const lines = useMemo(() => diffLines(diff).slice(0, MAX_LINES), [diff]);
  const tone = (kind: DiffKind): ColorValue => (kind === 'meta' || kind === 'hunk' ? colors.muted : colors.text);
  const fills = fill(colors);
  return (
    <Frame label={file ?? 'Diff'} copy={diff}>
      <View style={styles.lines}>{lines.map((line, i) => <Text key={i} style={[styles.text, styles.line, { color: tone(line.kind), backgroundColor: fills[line.kind] }]}>{line.text || ' '}</Text>)}</View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', paddingVertical: 0 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingLeft: 10, paddingRight: 2, minHeight: 36, borderBottomWidth: geometry.hairline },
  label: { flexShrink: 1 },
  scroll: { padding: 10, flexGrow: 1 },
  lines: { flexGrow: 1 },
  text: { ...textStyle.caption, fontFamily: mono },
  line: { paddingHorizontal: 4 },
});
