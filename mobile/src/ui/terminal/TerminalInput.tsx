// The input bar under the terminal: an accessory row of keys a phone keyboard lacks (Esc, Tab,
// Ctrl-C, Ctrl-D, arrows, | ~ /) and a line field that sends its text with Return.
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { lineInput, MAX_INPUT_BYTES, TERMINAL_KEYS } from '../../store/terminal.ts';
import { geometry, haptic, PressScale, type } from '../ds/index.ts';
import { Icon } from '../Icon.tsx';
import { mono, useColors } from '../theme.ts';

export interface TerminalInputProps {
  /** Sends raw input; resolves once the computer took it. */
  onSend: (data: string) => Promise<void>;
  disabled: boolean;
}

export function TerminalInput({ onSend, disabled }: TerminalInputProps) {
  const colors = useColors();
  const [text, setText] = useState('');
  const send = (data: string) => {
    haptic('light');
    // The screen's banner reports a failed send.
    onSend(data).catch(() => undefined);
  };
  const submit = () => {
    const line = text;
    setText('');
    void onSend(lineInput(line)).catch(() => setText(line));
  };
  return (
    <View style={[styles.bar, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.keys}>
        {TERMINAL_KEYS.map(key => (
          <PressScale key={key.label} disabled={disabled} onPress={() => send(key.data)} accessibilityRole="button" accessibilityLabel={key.accessibilityLabel}
            style={[styles.key, { backgroundColor: colors.raised, borderColor: colors.border, opacity: disabled ? 0.4 : 1 }]}>
            <Text style={[styles.keyText, { color: colors.text }]}>{key.label}</Text>
          </PressScale>
        ))}
      </ScrollView>
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          submitBehavior="submit"
          editable={!disabled}
          placeholder={disabled ? 'This terminal has ended' : 'Type a command'}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          returnKeyType="send"
          maxLength={MAX_INPUT_BYTES / 4}
          accessibilityLabel="Terminal input"
          style={[styles.input, type.body, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.border }]}
        />
        <PressScale disabled={disabled} onPress={submit} accessibilityRole="button" accessibilityLabel="Send line"
          style={[styles.send, { backgroundColor: colors.primary, opacity: disabled ? 0.4 : 1 }]}>
          <Icon ios="return" android="keyboard_return" size={18} color={colors.onPrimary} />
        </PressScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: geometry.hairline, paddingTop: 6, gap: 6 },
  keys: { gap: 6, paddingHorizontal: geometry.screenMargin },
  key: { minWidth: 40, height: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: geometry.hairline, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontFamily: mono, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: geometry.screenMargin, paddingBottom: 6 },
  input: { flex: 1, fontFamily: mono, minHeight: 38, borderRadius: 10, borderWidth: geometry.hairline, paddingHorizontal: 10 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
});
