// Offline and error notices: slides in a few points from above, fades out.
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import { Button } from './Button.tsx';
import { useMotion } from './motion.ts';
import type { Tone } from './palette.ts';
import { geometry, type as text, type IconName } from './type.ts';

const WARNING_ICON: IconName = { ios: 'exclamationmark.triangle.fill', android: 'warning' };

export interface BannerProps {
  visible: boolean;
  title: string;
  body?: string;
  tone?: Tone;
  icon?: IconName;
  /** `loading`: the action is in flight, so it shows a spinner and ignores presses. */
  action?: { label: string; onPress: () => void; loading?: boolean };
  style?: StyleProp<ViewStyle>;
}

export function Banner({ visible, title, body, tone = 'warning', icon = WARNING_ICON, action, style }: BannerProps) {
  const colors = useColors();
  const { enterFromAbove, exit } = useMotion();
  if (!visible) return null;
  return (
    <Animated.View entering={enterFromAbove} exiting={exit} accessibilityRole="alert" accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: colors.cardInner, borderColor: colors.border, boxShadow: colors.shadowCard }, style]}>
      <Icon {...icon} size={18} color={colors[tone]} />
      <View style={styles.text}>
        <Text style={[text.subheadMedium, { color: colors.text }]}>{title}</Text>
        {!!body && <Text style={[text.footnote, { color: colors.muted }]}>{body}</Text>}
      </View>
      {!!action && <Button label={action.label} onPress={action.onPress} loading={action.loading} size="small" />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: geometry.rowHeight, paddingHorizontal: 12, paddingVertical: 8, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  text: { flex: 1, minWidth: 0 },
});
