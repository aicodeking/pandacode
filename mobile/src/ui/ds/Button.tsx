// Primary is monochrome (text-coloured fill, page-coloured label); colour only for destructive.
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import { PressScale, type PressScaleProps } from './PressScale.tsx';
import { geometry, type as text, type IconName } from './type.ts';

const DISABLED_OPACITY = 0.45;
/** A small button's 32 pt to a 44 pt target. */
const SMALL_SLOP = 6;

export type ButtonVariant = 'primary' | 'raised' | 'plain' | 'destructive';

export interface ButtonProps extends Omit<PressScaleProps, 'children'> {
  label: string;
  variant?: ButtonVariant;
  icon?: IconName;
  /** Shows a spinner in place of the icon and ignores presses. */
  loading?: boolean;
  size?: 'regular' | 'small';
}

export function Button({ label, variant = 'raised', icon, loading, size = 'regular', disabled, style, accessibilityLabel, accessibilityState, ...rest }: ButtonProps) {
  const colors = useColors();
  const off = !!disabled || !!loading;
  const small = size === 'small';
  const ink = variant === 'primary' ? colors.onPrimary : variant === 'destructive' ? colors.danger : colors.text;
  const surface = variant === 'primary'
    ? { backgroundColor: colors.primary, boxShadow: colors.shadowRaised }
    : variant === 'plain'
      ? undefined
      : { backgroundColor: colors.raised, borderColor: colors.border, borderWidth: geometry.hairline, boxShadow: colors.shadowRaised };
  return (
    <PressScale hitSlop={small ? SMALL_SLOP : undefined} {...rest} disabled={off} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ ...accessibilityState, disabled: off, busy: !!loading }}
      style={[styles.button, small && styles.small, surface, off && styles.off, style]}>
      {loading ? <ActivityIndicator size="small" color={ink} /> : !!icon && <Icon {...icon} size={small ? 15 : 17} color={ink} />}
      <Text numberOfLines={1} style={[small ? text.footnoteMedium : text.calloutMedium, { color: ink }]}>{label}</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: geometry.rowHeight, paddingHorizontal: 16, paddingVertical: 8, borderRadius: geometry.controlRadius, borderCurve: 'continuous' },
  small: { minHeight: 32, paddingHorizontal: 10, paddingVertical: 5, gap: 5, borderRadius: 10 },
  off: { opacity: DISABLED_OPACITY },
});
