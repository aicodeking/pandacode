// A generative form: native inputs whose answers fill the prompt template ({name}) and put it in
// the composer. Nothing is posted anywhere.
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { formPrompt, type View as Spec } from '../../store/generative.ts';
import { useColors } from '../theme.ts';
import { geometry, InnerCard, PressScale, Toggle, type as textStyle } from '../ds/index.ts';
import { Button, Title, useFill } from './common.tsx';

type FormSpec = Extract<Spec, { type: 'form' }>;

const initial = (spec: FormSpec) => Object.fromEntries(spec.fields.map(f => [f.name, f.type === 'checkbox' ? (f.value === 'true' || f.value === 'yes' ? 'yes' : 'no') : f.value ?? (f.type === 'select' ? f.options[0] ?? '' : '')]));

export function Form({ spec }: { spec: FormSpec }) {
  const colors = useColors();
  const fill = useFill();
  const [values, setValues] = useState<Record<string, string>>(() => initial(spec));
  const set = (name: string, value: string) => setValues(v => ({ ...v, [name]: value }));
  const missing = spec.fields.some(f => f.required && !values[f.name]?.trim());
  return (
    <InnerCard style={styles.form}>
      <Title text={spec.title} />
      {spec.fields.map(field => (
        <View key={field.name} style={field.type === 'checkbox' ? styles.inline : styles.field}>
          <Text style={[textStyle.footnoteMedium, styles.label, { color: colors.muted }]}>{field.label}{field.required ? ' *' : ''}</Text>
          {field.type === 'checkbox'
            ? <Toggle value={values[field.name] === 'yes'} onValueChange={on => set(field.name, on ? 'yes' : 'no')} accessibilityLabel={field.label} />
            : field.type === 'select'
              ? <View style={styles.options}>{field.options.map(option => {
                const chosen = values[field.name] === option;
                return (
                  <PressScale key={option} onPress={() => set(field.name, option)} accessibilityRole="radio" accessibilityState={{ selected: chosen }}
                    style={[styles.option, { backgroundColor: chosen ? colors.primary : colors.fill, borderColor: colors.border }]}>
                    <Text style={[textStyle.subhead, { color: chosen ? colors.onPrimary : colors.text }]}>{option}</Text>
                  </PressScale>
                );
              })}</View>
              : <TextInput value={values[field.name]} onChangeText={t => set(field.name, t)} placeholder={field.placeholder} placeholderTextColor={colors.faint}
                multiline={field.type === 'textarea'} keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'} accessibilityLabel={field.label}
                style={[styles.input, field.type === 'textarea' && styles.area, { color: colors.text, backgroundColor: colors.fill, borderColor: colors.border }]} />}
        </View>
      ))}
      <View style={styles.actions}>
        <Button label={spec.submit} tone="primary" disabled={!fill || missing} onPress={() => fill?.(formPrompt(spec.prompt, spec.fields, values))} />
      </View>
    </InnerCard>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10, padding: 12 },
  field: { gap: 4 },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { flexShrink: 1 },
  input: { fontSize: textStyle.subhead.fontSize, borderRadius: geometry.controlRadius, borderWidth: geometry.hairline, paddingHorizontal: 10, paddingVertical: 8, borderCurve: 'continuous' },
  area: { minHeight: 72, textAlignVertical: 'top' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { borderRadius: geometry.controlRadius, borderWidth: geometry.hairline, paddingHorizontal: 12, paddingVertical: 6, borderCurve: 'continuous' },
  actions: { flexDirection: 'row' },
});
