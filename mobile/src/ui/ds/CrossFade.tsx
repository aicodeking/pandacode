// Text that cross-fades when it changes (not on first mount); also under Reduce Motion, where a fade stays right.
import { StyleSheet, View, type StyleProp, type TextProps, type TextStyle } from 'react-native';
import Animated, { LayoutAnimationConfig } from 'react-native-reanimated';
import { crossFadeIn, crossFadeOut } from './motion.ts';

export interface CrossFadeTextProps extends Omit<TextProps, 'children' | 'style'> { text: string; style?: StyleProp<TextStyle> }

export function CrossFadeText({ text, style, ...rest }: CrossFadeTextProps) {
  return (
    <LayoutAnimationConfig skipEntering>
      <View>
        <Animated.Text {...rest} key={text} entering={crossFadeIn} exiting={crossFadeOut} style={style}>{text}</Animated.Text>
      </View>
    </LayoutAnimationConfig>
  );
}

export interface AnimatedNumberProps extends Omit<CrossFadeTextProps, 'text'> { value: number; format?: (value: number) => string }

/** A count with tabular figures, so neighbouring digits hold still. */
export function AnimatedNumber({ value, format = String, style, ...rest }: AnimatedNumberProps) {
  return <CrossFadeText {...rest} text={format(value)} style={[styles.tabular, style]} />;
}

const styles = StyleSheet.create({ tabular: { fontVariant: ['tabular-nums'] } });
