import { useEffect } from 'react';
import type { ColorValue } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Icon } from '../Icon.tsx';
import { useColors } from '../theme.ts';
import { springs } from './motion.ts';

const OPEN_DEGREES = 90;

export interface ChevronProps { expanded: boolean; size?: number; color?: ColorValue }

/** Points right when closed and turns down when open. */
export function Chevron({ expanded, size = 13, color }: ChevronProps) {
  const colors = useColors();
  const turn = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    turn.set(withSpring(expanded ? 1 : 0, springs.snappy));
  }, [expanded, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * OPEN_DEGREES}deg` }] }));
  return <Animated.View style={style}><Icon ios="chevron.right" android="chevron_right" size={size} color={color ?? colors.glyphFaint} /></Animated.View>;
}
