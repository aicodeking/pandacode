// Small labels: neutral by default, toned when they state something; branch names in mono.
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import type { Tone } from './palette.ts';
import { PressScale } from './PressScale.tsx';
import { CHROME_FONT_SCALE, geometry, type as text, type IconName } from './type.ts';

export interface ChipProps {
  label: string;
  icon?: IconName;
  tone?: Tone;
  /** Tappable when given. */
  onPress?: () => void;
  accessibilityLabel?: string;
  labelStyle?: StyleProp<TextStyle>;
  ellipsizeMode?: 'head' | 'middle' | 'tail';
  style?: StyleProp<ViewStyle>;
}

export function Chip({ label, icon, tone, onPress, accessibilityLabel, labelStyle, ellipsizeMode, style }: ChipProps) {
  const colors = useColors();
  const ink = tone ? colors[tone] : colors.muted;
  const frame = [styles.chip, { backgroundColor: tone ? colors[`${tone}Fill`] : colors.fill, borderColor: colors.chipBorder }, style];
  const body = (
    <>
      {!!icon && <Icon {...icon} size={12} color={ink} />}
      <Text numberOfLines={1} ellipsizeMode={ellipsizeMode} maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[text.footnote, styles.label, { color: ink }, labelStyle]}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={frame}>{body}</View>;
  return <PressScale onPress={onPress} accessibilityLabel={accessibilityLabel ?? label} hitSlop={8} style={frame}>{body}</PressScale>;
}

export interface BranchChipProps { branch: string; onPress?: () => void; style?: StyleProp<ViewStyle> }

/** `maria/composer-tray`: the middle gives way first, so both the owner and the end stay readable. */
export function BranchChip({ branch, onPress, style }: BranchChipProps) {
  return <Chip label={branch} labelStyle={text.code} ellipsizeMode="middle" onPress={onPress} accessibilityLabel={`Branch ${branch}`} style={style} />;
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, minHeight: 24, paddingHorizontal: 7, paddingVertical: 2, borderRadius: geometry.chipRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  label: { flexShrink: 1 },
});
