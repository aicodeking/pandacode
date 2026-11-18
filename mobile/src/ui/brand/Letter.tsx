// One letter of the wordmark. Its colour fills up from the baseline and drains back down instead of
// fading: a fade (by colour or by a copy's opacity) blends tone into ink and goes muddy on the way,
// while a wipe shows every pixel as either ink or tone. Two complementary clip windows, moved only
// with transforms: ink above the line, tone below it. A letter fills while the panda passes over or
// lands on it and, for a perch's letter, while the panda is at that perch (at rest: the e beside it).
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { CAP, DIP, FONT_SIZE } from './geometry.ts';
import { letter, perchGlow } from './panda-motion.ts';

/** Where SF Rounded's baseline falls in a 24 pt line box at 20 pt, measured on device. */
export const LINE_HEIGHT = 24;
export const TEXT_BASELINE = 19.1;
/** The wipe line when empty (past the line box, so no sliver of tone remains) and when full. */
const EMPTY = LINE_HEIGHT + 1;
const FULL = TEXT_BASELINE - CAP - 1.2;
const BLEED = 2;

export interface LetterProps {
  char: string; passes: readonly number[]; ink: string; tone: string;
  /** The perch whose accent this letter is (see PERCH_LETTER), if any. */
  perch?: number;
  time: SharedValue<number>;
  onLayout: (event: LayoutChangeEvent) => void;
}

export function Letter({ char, passes, ink, tone, perch, time, onLayout }: LetterProps) {
  // Derived values read the clock directly, so Reanimated subscribes every style below to it.
  const state = useDerivedValue(() => {
    const t = time.get();
    const { dip, glow } = letter(t, passes);
    const fill = Math.max(glow, perch === undefined ? 0 : perchGlow(t, perch));
    return { dip, line: EMPTY + (FULL - EMPTY) * fill };
  });
  const press = useAnimatedStyle(() => ({ transform: [{ translateY: state.get().dip * DIP }] }));
  // The ink window covers the glyph from its top down to the line; the tone window from the line down.
  const inkClip = useAnimatedStyle(() => ({ transform: [{ translateY: state.get().line - LINE_HEIGHT }] }));
  const inkGlyph = useAnimatedStyle(() => ({ transform: [{ translateY: LINE_HEIGHT - state.get().line }] }));
  const toneClip = useAnimatedStyle(() => ({ transform: [{ translateY: state.get().line }] }));
  const toneGlyph = useAnimatedStyle(() => ({ transform: [{ translateY: -state.get().line }] }));
  return (
    <Animated.View onLayout={onLayout} style={press}>
      {/* Sizes the letter; the visible glyphs are the two clipped copies. */}
      <Animated.Text allowFontScaling={false} style={[styles.glyph, styles.spacer]}>{char}</Animated.Text>
      <Animated.View style={[styles.clip, inkClip]}>
        <Animated.Text allowFontScaling={false} style={[styles.glyph, styles.inside, { color: ink }, inkGlyph]}>{char}</Animated.Text>
      </Animated.View>
      <Animated.View style={[styles.clip, toneClip]}>
        <Animated.Text allowFontScaling={false} style={[styles.glyph, styles.inside, { color: tone }, toneGlyph]}>{char}</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glyph: { fontFamily: 'ui-rounded', fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, fontWeight: '800', letterSpacing: -0.4 },
  spacer: { color: 'transparent' },
  // Wider than the advance, so tight tracking never shaves a glyph's edge.
  clip: { position: 'absolute', left: -BLEED, right: -BLEED, top: 0, height: LINE_HEIGHT, overflow: 'hidden' },
  inside: { marginLeft: BLEED },
});
