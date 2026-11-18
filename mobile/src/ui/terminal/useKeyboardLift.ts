// Follows the keyboard every frame on the UI thread (react-native-keyboard-controller), a finger
// dragging it included, as the task screen does: a style lifting the terminal and its input bar,
// and the settled height for what can wait for React (the list's top spacer).
import { useState } from 'react';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useAnimatedStyle } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/** `bottomInset`: the padding under the input bar that the keyboard replaces. */
export function useKeyboardLift(bottomInset: number) {
  const { height } = useReanimatedKeyboardAnimation();
  const [settled, setSettled] = useState(0);
  useKeyboardHandler({
    onEnd: event => {
      'worklet';
      scheduleOnRN(setSettled, event.height);
    },
  }, []);
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, -height.get() - bottomInset) }] }));
  return { lift, settled: Math.max(0, settled - bottomInset) };
}
