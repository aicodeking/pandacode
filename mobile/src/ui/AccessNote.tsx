// A short inline note in place of actions this phone's grant (or the computer's "Full access for
// remote tasks" switch) keeps off; nothing when they're allowed, unknown, or the host is just
// outdated. Gate the actions themselves with useHostAllows (connect/api/capabilities.ts).
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useHostCapabilities } from '../connect/api/capabilities.ts';
import { geometry, type } from './ds/index.ts';
import { useComputerName } from './hub/common.tsx';
import { Icon } from './Icon.tsx';
import { accessNoteText } from './access-note.ts';
import { useColors } from './theme.ts';

export function useAccessNote(device: string, methods: readonly string[]): string | null {
  const caps = useHostCapabilities(device);
  const computer = useComputerName(device);
  return accessNoteText(caps, methods, computer);
}

export function AccessNote({ device, methods, style }: { device: string; methods: readonly string[]; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const note = useAccessNote(device, methods);
  if (!note) return null;
  return (
    <View accessibilityRole="text" style={[styles.note, { backgroundColor: colors.cardInner, borderColor: colors.border }, style]}>
      <Icon ios="lock.fill" android="lock" size={14} color={colors.muted} />
      <Text style={[type.footnote, styles.text, { color: colors.muted }]}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: geometry.rowInset, paddingVertical: 8, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  text: { flex: 1, minWidth: 0 },
});
