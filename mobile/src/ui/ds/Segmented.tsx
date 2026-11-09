// The desktop's segmented control: a recessed track and a raised thumb that slides between equal
// options. Custom, because the native control can't take the hairline thumb. A radio group to VoiceOver.
import { useEffect } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import { haptic, springs } from './motion.ts';
import { PressScale } from './PressScale.tsx';
import { type as text, CHROME_FONT_SCALE, geometry, type IconName } from './type.ts';

const TRACK_INSET = 2;
const MIN_HEIGHT = 36;
/** To a 44 pt target. */
const TARGET_SLOP = 4;
const MIN_LABEL_SCALE = 0.75;
const PRESSED_THUMB = 0.96;

export interface SegmentedOption<T extends string> { value: T; label: string; icon?: IconName }

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

export function Segmented<T extends string>({ options, value, onChange, accessibilityLabel, style }: SegmentedProps<T>) {
  const colors = useColors();
  const index = options.findIndex(option => option.value === value);
  const position = useSharedValue(Math.max(index, 0));
  const segment = useSharedValue(0);
  const press = useSharedValue(1);
  const selected = index >= 0;
  useEffect(() => {
    if (index >= 0) position.set(withSpring(index, springs.snappy));
  }, [index, position]);
  const thumb = useAnimatedStyle(() => ({
    width: segment.get(),
    opacity: segment.get() > 0 && selected ? 1 : 0,
    transform: [{ translateX: position.get() * segment.get() }, { scale: press.get() }],
  }));
  const measure = (event: LayoutChangeEvent) => segment.set(event.nativeEvent.layout.width / Math.max(options.length, 1));
  const pick = (next: T) => {
    if (next === value) return;
    haptic('selection');
    onChange(next);
  };
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.track, { backgroundColor: colors.track, borderColor: colors.border }, style]}>
      <View style={styles.options} onLayout={measure}>
        <Animated.View style={[styles.thumb, { backgroundColor: colors.thumb, borderColor: colors.borderStrong, boxShadow: colors.shadowRaised }, thumb]} />
        {options.map(option => {
          const on = option.value === value;
          const tint = on ? colors.text : colors.muted;
          return (
            <PressScale key={option.value} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={option.label} hitSlop={TARGET_SLOP} onPress={() => pick(option.value)} style={styles.option}
              onPressIn={() => { if (on) press.set(withSpring(PRESSED_THUMB, springs.press)); }} onPressOut={() => press.set(withSpring(1, springs.press))}>
              {!!option.icon && <Icon {...option.icon} size={15} color={tint} />}
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={MIN_LABEL_SCALE} maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[on ? text.subheadMedium : text.subhead, { color: tint }]}>{option.label}</Text>
            </PressScale>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { borderRadius: geometry.controlRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, padding: TRACK_INSET },
  options: { flexDirection: 'row', minHeight: MIN_HEIGHT },
  thumb: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: geometry.controlRadius - TRACK_INSET, borderCurve: 'continuous', borderWidth: geometry.hairline },
  option: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 6 },
});
