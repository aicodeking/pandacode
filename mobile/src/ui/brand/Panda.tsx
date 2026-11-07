// The brand panda, built from rounded Views and kept to the shapes that still read at 22 pt: ears,
// a shaded head with a highlight, soft tilted eye patches with a glinting pupil, nose, an ω mouth,
// blush, arms, a belly and two feet. A turn narrows the head while the face slides into it, the far
// ear tucks down and in and the body slides against it; the shading and the highlight hold still
// against the turn and the pitch, as if lit from one place, so it reads as a head turning in 3D.
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { PANDA_SIZE } from './geometry.ts';
import type { Pose } from './panda-motion.ts';

const TURN_NARROW = 0.08;
const FACE_SHIFT = 2.4;
const BODY_SHIFT = 1;
const FAR_EAR = 1;
const NEAR_EAR = 0.5;
/** How far the shading and the highlight slide against a turn (points per unit of look) and the pitch (per degree). */
const SHADE_TURN = 1.4;
const SHINE_TURN = 0.9;
const SHADE_PITCH = 0.06;
/** Arms rise and splay with the lift, and brace on contact. */
const ARM_RISE = 2.5;
const ARM_SPLAY = 25;
const ARM_BRACE = 1;
/** The silhouette rim's reach past the head. */
const RIM = 0.6;
const PATCH_TILT = 30;

export interface PandaInk {
  fur: string;
  /** Eye patches, nose, mouth, ears, arms and feet. */
  ink: string;
  /** The pupils, darker than the patches. */
  pupil: string;
  blush: string; shade: string; shine: string;
  /** The belly: a touch off the head's white in light, so the body reads between head and feet. */
  belly: string;
  /** A soft silhouette behind the head, so it holds on a white bar. */
  rim: string;
  /** The ears' outer edge (opaque; the ink itself where no rim is wanted), so they hold against a dark bar. */
  earRim: string;
}

const dot = (size: number, color: string, extra?: ViewStyle): ViewStyle => ({ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color, ...extra });

/** Any shared or derived value holding at least a Pose: the views only read it. */
export function Panda({ pose, ink }: { pose: { readonly value: Pose }; ink: PandaInk }) {
  // A 2D turn (narrower), not a perspective rotateY: a 3D layer gets depth-sorted against the flat
  // body, which then paints over the face.
  const head = useAnimatedStyle(() => {
    const p = pose.value;
    return { transform: [{ translateY: p.nod }, { scaleX: 1 - TURN_NARROW * Math.abs(p.look) }] };
  });
  const face = useAnimatedStyle(() => ({ transform: [{ translateX: pose.value.look * FACE_SHIFT }] }));
  const shade = useAnimatedStyle(() => {
    const p = pose.value;
    return { transform: [{ translateX: -p.look * SHADE_TURN }, { translateY: p.pitch * SHADE_PITCH }] };
  });
  const shine = useAnimatedStyle(() => {
    const p = pose.value;
    return { transform: [{ translateX: p.look * SHINE_TURN }, { translateY: -p.pitch * SHADE_PITCH }] };
  });
  // Turning right, the right ear is the far one: down and in; the left comes out a little.
  const earL = useAnimatedStyle(() => {
    const p = pose.value;
    const right = Math.max(p.look, 0);
    const left = Math.max(-p.look, 0);
    return { transform: [{ translateX: left * FAR_EAR - right * NEAR_EAR - p.earsOut }, { translateY: p.earsL + left * FAR_EAR }] };
  });
  const earR = useAnimatedStyle(() => {
    const p = pose.value;
    const right = Math.max(p.look, 0);
    const left = Math.max(-p.look, 0);
    return { transform: [{ translateX: left * NEAR_EAR - right * FAR_EAR + p.earsOut }, { translateY: p.earsR + right * FAR_EAR }] };
  });
  const armL = useAnimatedStyle(() => {
    const p = pose.value;
    return { transform: [{ translateY: -ARM_RISE * p.arms + ARM_BRACE * p.brace }, { rotate: `${ARM_SPLAY * p.arms}deg` }, { scaleY: 1.25 }] };
  });
  const armR = useAnimatedStyle(() => {
    const p = pose.value;
    return { transform: [{ translateY: -ARM_RISE * p.arms + ARM_BRACE * p.brace }, { rotate: `${-ARM_SPLAY * p.arms}deg` }, { scaleY: 1.25 }] };
  });
  const body = useAnimatedStyle(() => ({ transform: [{ translateX: -pose.value.look * BODY_SHIFT }] }));
  const feet = useAnimatedStyle(() => ({ transform: [{ translateY: -pose.value.tuck }] }));
  // A blink closes the whole eye, patch and glint, about its centre.
  const eyes = useAnimatedStyle(() => ({ transform: [{ scaleY: 1 - 0.85 * pose.value.blink }] }));
  const limb = { backgroundColor: ink.ink };
  return (
    <View style={styles.box}>
      <Animated.View style={[StyleSheet.absoluteFill, body]}>
        <View style={[styles.belly, { backgroundColor: ink.belly }]} />
        <Animated.View style={[StyleSheet.absoluteFill, feet]}>
          <View style={[styles.foot, { left: 5.4 }, limb]} />
          <View style={[styles.foot, { right: 5.4 }, limb]} />
        </Animated.View>
        {/* Arms at the head and belly seam, pivoting at the shoulder. */}
        <Animated.View style={[styles.arm, styles.armL, limb, armL]} />
        <Animated.View style={[styles.arm, styles.armR, limb, armR]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, head]}>
        {/* Each ear a rim disc with the ink disc inside it: no border, which goes jagged when the intro draws the panda large. */}
        <Animated.View style={[styles.ear, { left: 1.4, backgroundColor: ink.earRim }, earL]}><View style={[styles.earInner, limb]} /></Animated.View>
        <Animated.View style={[styles.ear, { right: 1.4, backgroundColor: ink.earRim }, earR]}><View style={[styles.earInner, limb]} /></Animated.View>
        <View style={[styles.headRim, { backgroundColor: ink.rim }]} />
        <View style={[styles.head, { backgroundColor: ink.shade }]}>
          {/* Depth: the fill is the shade; an offset disc of fur leaves a soft falloff low on the right, and a highlight sits high on the left. */}
          <Animated.View style={[dot(22, ink.fur, { left: -3, top: -5.5 }), shade]} />
          <Animated.View style={[dot(6, ink.shine, { left: 2.6, top: 1.4 }), shine]} />
          <Animated.View style={[StyleSheet.absoluteFill, face]}>
            {/* Each eye: a pupil low and toward the nose in its patch, a glint at its top left. */}
            <Animated.View style={[styles.eye, { left: 3 }, eyes]}>
              <View style={[StyleSheet.absoluteFill, styles.patch, { backgroundColor: ink.ink, transform: [{ rotate: `${PATCH_TILT}deg` }] }]} />
              <View style={dot(2.2, ink.pupil, { left: 2.3, top: 2.7 })}>
                <View style={dot(1, ink.fur, styles.glint)} />
              </View>
            </Animated.View>
            <Animated.View style={[styles.eye, { left: 12.4 }, eyes]}>
              <View style={[StyleSheet.absoluteFill, styles.patch, { backgroundColor: ink.ink, transform: [{ rotate: `${-PATCH_TILT}deg` }] }]} />
              <View style={dot(2.2, ink.pupil, { left: 1.1, top: 2.7 })}>
                <View style={dot(1, ink.fur, styles.glint)} />
              </View>
            </Animated.View>
            <View style={dot(3.6, ink.blush, { left: 1, top: 10.8, height: 2 })} />
            <View style={dot(3.6, ink.blush, { right: 1, top: 10.8, height: 2 })} />
            <View style={[styles.nose, { backgroundColor: ink.ink }]} />
            {/* An ω: two small half discs side by side, clipped discs so they stay sharp when the intro draws the panda large. */}
            <View style={[styles.mouth, { left: 8.8 }]}><View style={[styles.mouthDisc, limb]} /></View>
            <View style={[styles.mouth, { left: 10.3 }]}><View style={[styles.mouthDisc, limb]} /></View>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

const HEAD = { left: 0.5, top: 2, width: 21, height: 15.5 };
const BELLY = { left: 4, top: 13, width: 14, height: 8 };

const styles = StyleSheet.create({
  box: { width: PANDA_SIZE, height: PANDA_SIZE },
  ear: { position: 'absolute', top: 0.4, width: 7, height: 7, borderRadius: 3.5 },
  earInner: { position: 'absolute', left: 0.5, top: 0.5, width: 6, height: 6, borderRadius: 3 },
  head: { position: 'absolute', ...HEAD, borderRadius: HEAD.height / 2, borderCurve: 'continuous', overflow: 'hidden' },
  headRim: {
    position: 'absolute', left: HEAD.left - RIM, top: HEAD.top - RIM, width: HEAD.width + RIM * 2, height: HEAD.height + RIM * 2,
    borderRadius: HEAD.height / 2 + RIM, borderCurve: 'continuous',
  },
  // The belly tucks under the head.
  belly: { position: 'absolute', ...BELLY, borderRadius: BELLY.height / 2 },
  foot: { position: 'absolute', top: 18.4, width: 5, height: 3.6, borderRadius: 1.8 },
  arm: { position: 'absolute', top: 13.4, width: 4, height: 4, borderRadius: 2 },
  armL: { left: 2.4, transformOrigin: '100% 0%' },
  armR: { right: 2.4, transformOrigin: '0% 0%' },
  eye: { position: 'absolute', top: 4.8, width: 5.6, height: 7 },
  patch: { borderRadius: 2.8 },
  glint: { left: 0.2, top: 0.2 },
  nose: { position: 'absolute', left: 8.8, top: 10.8, width: 3.4, height: 2.1, borderRadius: 1.05 },
  mouth: { position: 'absolute', top: 12.6, width: 1.9, height: 1, overflow: 'hidden' },
  mouthDisc: { position: 'absolute', left: 0, top: -0.9, width: 1.9, height: 1.9, borderRadius: 0.95 },
});
