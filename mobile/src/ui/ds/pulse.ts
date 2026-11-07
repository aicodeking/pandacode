// One Reanimated loop shared by every pulsing dot and skeleton: runs while a focused screen shows one,
// stops with the last, stays off with Reduce Motion. Opacity only.
import { NavigationContext } from 'expo-router/react-navigation';
import { use, useEffect, useState } from 'react';
import { cancelAnimation, Easing, makeMutable, useAnimatedStyle, useReducedMotion, withRepeat, withTiming } from 'react-native-reanimated';

const HALF_CYCLE_MS = 900;
const wave = makeMutable(1);
let users = 0;

function join() {
  users += 1;
  if (users === 1) wave.set(withRepeat(withTiming(0, { duration: HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }), -1, true));
}

function leave() {
  users -= 1;
  if (users > 0) return;
  cancelAnimation(wave);
  wave.set(1);
}

/** Like `useIsFocused`, which throws outside a route; views the root layout draws (the sidebar) count as focused. */
function useScreenFocused(): boolean {
  const navigation = use(NavigationContext);
  // Focus is read in an effect, not during render: it can be stale there and React Navigation warns.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!navigation) return undefined;
    const sync = () => setFocused(navigation.isFocused());
    sync();
    const unsubscribers = [navigation.addListener('focus', sync), navigation.addListener('blur', sync)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [navigation]);
  return focused;
}

/** An animated style pulsing between full opacity and `min` while `active`. */
export function usePulseStyle(active: boolean, min = 0.35) {
  const focused = useScreenFocused();
  const reduced = useReducedMotion();
  const running = active && focused && !reduced;
  useEffect(() => {
    if (!running) return undefined;
    join();
    return leave;
  }, [running]);
  return useAnimatedStyle(() => ({ opacity: running ? min + (1 - min) * wave.get() : 1 }));
}
