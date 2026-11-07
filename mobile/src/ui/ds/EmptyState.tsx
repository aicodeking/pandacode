import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import { Button } from './Button.tsx';
import { useMotion } from './motion.ts';
import { type as text, type IconName } from './type.ts';

const MAX_WIDTH = 320;

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({ icon, title, body, action, style }: EmptyStateProps) {
  const colors = useColors();
  const { enter } = useMotion();
  return (
    <Animated.View entering={enter()} style={[styles.empty, style]}>
      <Icon {...icon} size={34} color={colors.muted} />
      <Text accessibilityRole="header" style={[text.headline, styles.center, { color: colors.text }]}>{title}</Text>
      {!!body && <Text style={[text.subhead, styles.center, { color: colors.muted }]}>{body}</Text>}
      {!!action && <Button label={action.label} onPress={action.onPress} style={styles.action} />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', alignSelf: 'center', gap: 6, maxWidth: MAX_WIDTH, padding: 24 },
  center: { textAlign: 'center' },
  action: { marginTop: 10 },
});
