// The file screen's edit mode: one monospace multiline field in a keyboard-aware scroll view, so
// the caret stays above the keyboard (react-native-keyboard-controller follows it every frame).
// Lines wrap here, unlike the viewer: a horizontal scroll and a moving caret fight on a phone.
import { StyleSheet, TextInput } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Banner, geometry } from '../ds/index.ts';
import { mono, useColors } from '../theme.ts';

const FONT_SIZE = 13;
const LINE_HEIGHT = 19;
/** Space kept between the caret and the keyboard. */
const CARET_GAP = 24;

export interface FileEditorProps {
  value: string;
  onChange: (text: string) => void;
  editable: boolean;
  /** A note above the field (a save that failed), or ''. */
  notice: string;
  insets: { left: number; right: number };
  label: string;
}

export function FileEditor({ value, onChange, editable, notice, insets, label }: FileEditorProps) {
  const colors = useColors();
  return (
    <KeyboardAwareScrollView
      bottomOffset={CARET_GAP}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.page, { paddingLeft: insets.left + geometry.screenMargin, paddingRight: insets.right + geometry.screenMargin }]}
    >
      <Banner visible={!!notice} tone="danger" title={notice} />
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={editable}
        multiline
        scrollEnabled={false}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        smartInsertDelete={false}
        textAlignVertical="top"
        accessibilityLabel={label}
        style={[styles.field, { color: colors.text, opacity: editable ? 1 : 0.6 }]}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingVertical: geometry.sectionGap, flexGrow: 1 },
  field: { fontFamily: mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, minHeight: LINE_HEIGHT * 12, padding: 0 },
});
