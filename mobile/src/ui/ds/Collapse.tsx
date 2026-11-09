// Expand and collapse: the body is measured once off to the side, then the frame's height follows a
// spring on the UI thread. A closed body stays unmounted, so long lists don't carry it.
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { springs } from './motion.ts';

export interface CollapseProps { expanded: boolean; children: ReactNode }

export function Collapse({ expanded, children }: CollapseProps) {
  const [mounted, setMounted] = useState(expanded);
  if (expanded && !mounted) setMounted(true);
  const progress = useSharedValue(expanded ? 1 : 0);
  const height = useSharedValue(0);
  useEffect(() => {
    progress.set(withSpring(expanded ? 1 : 0, springs.smooth, finished => {
      if (!finished || expanded) return;
      // The body goes, so its height does too: a reopened body may be another size.
      height.set(0);
      scheduleOnRN(setMounted, false);
    }));
  }, [expanded, progress, height]);
  const frame = useAnimatedStyle(() => ({ height: progress.get() * height.get(), opacity: progress.get() }));
  // Content that changes while open moves the frame on the same spring.
  const measure = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    height.set(height.get() > 0 ? withSpring(next, springs.smooth) : next);
  };
  return (
    <Animated.View style={[styles.frame, frame]}>
      {mounted && <View style={styles.body} onLayout={measure}>{children}</View>}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  body: { position: 'absolute', top: 0, left: 0, right: 0 },
});
