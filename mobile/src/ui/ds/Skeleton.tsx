import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import { usePulseStyle } from './pulse.ts';

const PULSE_MIN = 0.5;

export interface SkeletonProps { width?: DimensionValue; height?: number; radius?: number; style?: StyleProp<ViewStyle> }

/** A grey placeholder pulsing on the shared loop; hidden from screen readers. */
export function Skeleton({ width = '100%', height = 14, radius = 6, style }: SkeletonProps) {
  const colors = useColors();
  const pulse = usePulseStyle(true, PULSE_MIN);
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ width, height, borderRadius: radius, backgroundColor: colors.fill }, style, pulse]} />;
}
