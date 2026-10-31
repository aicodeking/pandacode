// Shared pieces of generative UI: the composer fill for the open thread, titles, and the glass
// buttons and chips that only put a prompt in the composer (never send it).
import * as Haptics from 'expo-haptics';
import { useContext } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { draftKey, fillDraft } from '../../store/draft.ts';
import type { Action } from '../../store/generative.ts';
import { ThreadContext } from '../Attachments.tsx';
import { Glass } from '../Glass.tsx';
import { useColors } from '../theme.ts';

/** Fills this thread's composer, or undefined outside a thread (nothing to fill). */
export function useFill(): ((prompt: string) => void) | undefined {
  const thread = useContext(ThreadContext);
  if (!thread) return undefined;
  return prompt => { void Haptics.selectionAsync(); fillDraft(draftKey(thread.deviceId, thread.sessionId), prompt); };
}

export function Title({ text }: { text?: string }) {
  const colors = useColors();
  return text ? <Text style={[styles.title, { color: colors.text }]}>{text}</Text> : null;
}

export function Button({ label, tone, onPress, disabled, hint }: { label: string; tone: Action['tone']; onPress: () => void; disabled?: boolean; hint?: string }) {
  const colors = useColors();
  const primary = tone === 'primary';
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint ?? 'Puts a prompt in the message field'} accessibilityState={{ disabled }}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
      {primary
        ? <View style={[styles.button, { backgroundColor: colors.tint }]}><Text style={[styles.buttonText, { color: colors.onTint }]}>{label}</Text></View>
        : <Glass interactive style={styles.button}><Text style={[styles.buttonText, { color: tone === 'danger' ? colors.red : colors.text }]}>{label}</Text></Glass>}
    </Pressable>
  );
}

export function Actions({ items }: { items: Action[] }) {
  const fill = useFill();
  if (!items.length) return null;
  return <View style={styles.row}>{items.map((item, i) => <Button key={i} label={item.label} tone={item.tone} disabled={!fill} hint={item.prompt === item.label ? undefined : item.prompt} onPress={() => fill?.(item.prompt)} />)}</View>;
}

/** Followup suggestions: glass chips under the reply. */
export function Chips({ options, label }: { options: Action[]; label?: string }) {
  const colors = useColors();
  const fill = useFill();
  if (!options.length || !fill) return null;
  return (
    <View style={styles.chips}>
      {!!label && <Text style={[styles.hint, { color: colors.secondary }]}>{label}</Text>}
      <View style={styles.row}>
        {options.map((option, i) => (
          <Pressable key={i} onPress={() => fill(option.prompt)} accessibilityRole="button" accessibilityLabel={option.label} accessibilityHint="Puts it in the message field" style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
            <Glass interactive style={styles.chip}><Text style={[styles.chipText, { color: colors.text }]} numberOfLines={1}>{option.label}</Text></Glass>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chips: { gap: 6, marginBottom: 8 },
  button: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, borderCurve: 'continuous', overflow: 'hidden' },
  buttonText: { fontSize: 14, fontWeight: '600' },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, maxWidth: 280, borderCurve: 'continuous', overflow: 'hidden' },
  chipText: { fontSize: 14, fontWeight: '500' },
});
