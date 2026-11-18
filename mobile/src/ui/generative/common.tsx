// Shared pieces of generative UI: the composer fill for the open thread, titles, and the buttons and
// chips that only put a prompt in the composer (never send it).
import { useContext } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { draftKey, fillDraft } from '../../store/draft.ts';
import type { Action } from '../../store/generative.ts';
import { ThreadContext } from '../Attachments.tsx';
import { useColors } from '../theme.ts';
import { Button as DsButton, haptic, type as textStyle } from '../ds/index.ts';

/** Fills this thread's composer, or undefined outside a thread (nothing to fill). */
export function useFill(): ((prompt: string) => void) | undefined {
  const thread = useContext(ThreadContext);
  if (!thread) return undefined;
  return prompt => { haptic('selection'); fillDraft(draftKey(thread.deviceId, thread.sessionId), prompt); };
}

export function Title({ text }: { text?: string }) {
  const colors = useColors();
  return text ? <Text style={[styles.title, { color: colors.text }]}>{text}</Text> : null;
}

export function Button({ label, tone, onPress, disabled, hint }: { label: string; tone: Action['tone']; onPress: () => void; disabled?: boolean; hint?: string }) {
  return <DsButton label={label} size="small" variant={tone === 'primary' ? 'primary' : tone === 'danger' ? 'destructive' : 'raised'} onPress={onPress} disabled={disabled} accessibilityHint={hint ?? 'Puts a prompt in the message field'} />;
}

export function Actions({ items }: { items: Action[] }) {
  const fill = useFill();
  if (!items.length) return null;
  return <View style={styles.row}>{items.map((item, i) => <Button key={i} label={item.label} tone={item.tone} disabled={!fill} hint={item.prompt === item.label ? undefined : item.prompt} onPress={() => fill?.(item.prompt)} />)}</View>;
}

/** Followup suggestions: raised chips under the reply. */
export function Chips({ options, label }: { options: Action[]; label?: string }) {
  const colors = useColors();
  const fill = useFill();
  if (!options.length || !fill) return null;
  return (
    <View style={styles.chips}>
      {!!label && <Text style={[textStyle.caption, { color: colors.muted }]}>{label}</Text>}
      <View style={styles.row}>
        {options.map((option, i) => <DsButton key={i} label={option.label} size="small" style={styles.chip} onPress={() => fill(option.prompt)} accessibilityHint="Puts it in the message field" />)}
      </View>
    </View>
  );
}

export const styles = StyleSheet.create({
  title: textStyle.subheadMedium,
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chips: { gap: 6, marginBottom: 8 },
  chip: { maxWidth: 280 },
});
