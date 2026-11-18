import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import type { Tone } from './palette.ts';
import { usePulseStyle } from './pulse.ts';

const DEFAULT_SIZE = 8;

export interface StatusDotProps {
  tone: Tone;
  /** Pulses on opacity on the shared loop. */
  pulse?: boolean;
  size?: number;
  /** Give one when the dot alone says the state. */
  accessibilityLabel?: string;
}

function Pulsing({ style, accessibilityLabel }: { style: object; accessibilityLabel?: string }) {
  const pulse = usePulseStyle(true);
  return <Animated.View accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel} style={[style, pulse]} />;
}

export function StatusDot({ tone, pulse, size = DEFAULT_SIZE, accessibilityLabel }: StatusDotProps) {
  const colors = useColors();
  const style = { width: size, height: size, borderRadius: size / 2, backgroundColor: colors[tone] };
  if (pulse) return <Pulsing style={style} accessibilityLabel={accessibilityLabel} />;
  return <View accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel} style={[styles.dot, style]} />;
}

const styles = StyleSheet.create({ dot: { flexShrink: 0 } });
