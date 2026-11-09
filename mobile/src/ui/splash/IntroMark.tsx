// The intro's mark: the header brand's layout drawn at WORD_SCALE (letters set at that size, so they
// stay sharp; the panda's rounded views scale cleanly), driven by the intro clocks. Its own
// coordinates are the header brand's times WORD_SCALE, so flying it there is a translate and a scale.
import { useMemo, useState } from 'react';
import { StyleSheet, useColorScheme, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { inkFor, toneFor, TONES, WORD } from '../brand/Brand.tsx';
import { BASELINE, DIP, FONT_SIZE, PANDA_SIZE } from '../brand/geometry.ts';
import { LINE_HEIGHT, TEXT_BASELINE } from '../brand/Letter.tsx';
import { answer } from '../brand/panda-motion.ts';
import { Panda } from '../brand/Panda.tsx';
import { useColors } from '../theme.ts';
import type { MarkLayout, Placement, Span } from './mark-layout.ts';
import { introPose, LAND, LAUNCH, launchLetter, letterOpacity, letterRise, letterTimes, letterTone, WORD_SCALE, type Point } from './timeline.ts';

const K = WORD_SCALE;
const LAST = WORD.length - 1;
/** How far below its place a letter starts, as a fraction of the font size. */
const LETTER_DROP = 0.4;
const LETTER_GROW = 0.35;
const ESTIMATED = 11.8 * K;

const estimated: readonly Span[] = WORD.split('').map((_, i) => ({ left: i * ESTIMATED, width: ESTIMATED }));

export function useMarkSpans() {
  const [spans, setSpans] = useState(estimated);
  const onLetter = (i: number) => (event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setSpans(prev => prev.map((span, j) => (j === i ? { left: x, width } : span)));
  };
  return { spans, onLetter };
}

export interface IntroMarkProps {
  /** The beat's clock (0 until it starts) and the clock since mount. */
  t: SharedValue<number>;
  w: SharedValue<number>;
  /** The panda's feet at the start (the launch screen's centre), in the mark's coordinates. */
  from: Point;
  layout: MarkLayout;
  /** 0..1: the breath and blinks ease out as the hand-off starts, so the mark lands at rest. */
  calm: SharedValue<number>;
  /** 0..1 through the flight, and where the header brand draws its letters and panda: each drifts onto its place. */
  drift: SharedValue<number>;
  place: SharedValue<Placement | null>;
  lefts: readonly number[];
  onLetter: (i: number) => (event: LayoutChangeEvent) => void;
}

interface IntroLetterProps {
  i: number; t: SharedValue<number>; left: number; start: number; dipAt: number | undefined;
  drift: SharedValue<number>; place: SharedValue<Placement | null>; onLayout: (event: LayoutChangeEvent) => void;
}

/** One letter: ink, with its colour cross-faded over it while it rises (the e keeps it). */
function IntroLetter({ i, t, left, start, dipAt, drift, place, onLayout }: IntroLetterProps) {
  const colors = useColors();
  const dark = useColorScheme() === 'dark';
  const keep = i === LAST;
  const rise = useAnimatedStyle(() => {
    const now = t.get();
    const r = letterRise(now, start);
    const to = place.get();
    const shift = to ? (K * to.lefts[i] - left) * drift.get() : 0;
    const dip = dipAt === undefined ? 0 : answer(now - dipAt).dip * DIP * K;
    return {
      opacity: letterOpacity(now, start),
      transform: [{ translateX: shift }, { translateY: (1 - r) * LETTER_DROP * FONT_SIZE * K + dip }, { scale: 1 - LETTER_GROW * (1 - r) }],
    };
  });
  const tone = useAnimatedStyle(() => ({ opacity: letterTone(t.get(), start, keep) }));
  return (
    // Measured here: offsets within the word.
    <Animated.View onLayout={onLayout} style={[styles.letter, rise]}>
      <Animated.Text allowFontScaling={false} style={[styles.glyph, { color: colors.text }]}>{WORD[i]}</Animated.Text>
      <Animated.Text allowFontScaling={false} style={[styles.glyph, styles.over, { color: toneFor(colors, dark, TONES[i]) }, tone]}>{WORD[i]}</Animated.Text>
    </Animated.View>
  );
}

export function IntroMark({ t, w, from, layout, calm, drift, place, lefts, onLetter }: IntroMarkProps) {
  const colors = useColors();
  const dark = useColorScheme() === 'dark';
  const to = { x: layout.home, y: K * BASELINE };
  const centresKey = layout.centres.join(',');
  // Once per layout: when each letter rises, and which one the take-off presses (the landing presses the d and e).
  const { starts, pushed } = useMemo(() => {
    const centres = centresKey.split(',').map(Number);
    return { starts: letterTimes(centres, from.x, layout.home), pushed: launchLetter(centres, from.x) };
  }, [centresKey, from.x, layout.home]);
  const pose = useDerivedValue(() => {
    const p = introPose(t.get(), w.get(), from, to);
    const live = 1 - calm.get();
    const at = place.get();
    const x = p.x + (at ? (K * at.home - to.x) * drift.get() : 0);
    return { ...p, x, sy: 1 + (p.sy - 1) * live, blink: p.blink * live };
  });
  const panda = useAnimatedStyle(() => {
    const p = pose.get();
    // Scaled about the feet, so the feet stay on their path.
    return { transform: [{ translateX: p.x - PANDA_SIZE / 2 }, { translateY: p.y + p.bob * p.scale - PANDA_SIZE }, { scale: p.scale }] };
  });
  const lean = useAnimatedStyle(() => ({ transform: [{ rotate: `${pose.get().groundLean}deg` }] }));
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${pose.get().pitch}deg` }] }));
  const squash = useAnimatedStyle(() => {
    const sy = pose.get().sy;
    return { transform: [{ scaleX: 1 / Math.sqrt(sy) }, { scaleY: sy }] };
  });
  const ink = inkFor(colors, dark, toneFor(colors, dark, 'worktree'));
  return (
    <View style={{ width: layout.width, height: layout.height }}>
      <View style={styles.word}>
        {WORD.split('').map((_, i) => (
          <IntroLetter
            key={i} i={i} t={t} left={lefts[i]} start={starts[i]} dipAt={i === pushed ? LAUNCH : i >= LAST - 1 ? LAND : undefined}
            drift={drift} place={place} onLayout={onLetter(i)}
          />
        ))}
      </View>
      <Animated.View style={[styles.panda, panda]}>
        <Animated.View style={[styles.pivot, styles.feet, lean]}>
          <Animated.View style={[styles.pivot, spin]}>
            <Animated.View style={[styles.pivot, styles.feet, squash]}>
              <Panda pose={pose} ink={ink} />
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  word: { position: 'absolute', left: 0, top: K * (BASELINE - TEXT_BASELINE), flexDirection: 'row' },
  letter: { transformOrigin: '50% 100%' },
  // The header's Letter style, at K.
  glyph: { fontFamily: 'ui-rounded', fontSize: FONT_SIZE * K, lineHeight: LINE_HEIGHT * K, fontWeight: '800', letterSpacing: -0.4 * K },
  over: { position: 'absolute', left: 0, top: 0 },
  panda: { position: 'absolute', left: 0, top: 0, width: PANDA_SIZE, height: PANDA_SIZE, transformOrigin: '50% 100%' },
  pivot: { width: PANDA_SIZE, height: PANDA_SIZE },
  feet: { transformOrigin: '50% 100%' },
});
