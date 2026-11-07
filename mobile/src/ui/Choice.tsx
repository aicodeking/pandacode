// A native menu picker with a monochrome trigger: a SwiftUI menu on iOS, the Material sheet on
// Android. The trigger is React Native text, so the value cross-fades when it changes.
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CrossFadeText, type as text } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { ViewMenu } from './Menu.tsx';
import { useColors } from './theme.ts';

const MAX_VALUE_WIDTH = 200;
const MAX_SCALE = 1.6;

export interface Option { value: string; label: string }

export const Choice = memo(function Choice({ value, options, onChange, label = 'Choose' }: { value: string; options: Option[]; onChange: (value: string) => void; label?: string }) {
  const colors = useColors();
  const current = options.find(o => o.value === value)?.label ?? (value || '—');
  // The native host follows its content late, so the trigger holds its widest value and a change never clips.
  const widest = [current, ...options.map(o => o.label)].reduce((a, b) => (b.length > a.length ? b : a));
  const items = options.map(o => ({ label: o.label, checked: o.value === value, onPress: () => { if (o.value !== value) onChange(o.value); } }));
  return (
    <ViewMenu label={`${label}: ${current}`} items={items}>
      <View style={styles.trigger}>
        <View style={styles.value}>
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE} accessible={false} style={[text.callout, styles.sizer]}>{widest}</Text>
          <View style={styles.current}>
            <CrossFadeText text={current} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE} style={[text.callout, { color: colors.text }]} />
          </View>
        </View>
        <Icon ios="chevron.down" android="expand_more" size={11} color={colors.muted} />
      </View>
    </ViewMenu>
  );
});

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { maxWidth: MAX_VALUE_WIDTH },
  sizer: { opacity: 0 },
  current: { ...StyleSheet.absoluteFill, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
});
