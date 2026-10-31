// SwiftUI Liquid Glass controls (iOS 26+) through @expo/ui: interactive glass that bulges under
// the finger.
// Callers keep their React Native version for Android and iOS without glass (`nativeGlass`).
import { Host, Image } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityHint, accessibilityLabel, contentShape, disabled as disable, frame, glassEffect, onLongPressGesture, onTapGesture, shapes } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'expo-symbols';
import { Platform, useColorScheme, type ColorValue } from 'react-native';
import { hasGlass } from './Glass.tsx';
import { useColors } from './theme.ts';

export const nativeGlass = hasGlass && Platform.OS === 'ios';

export const interactiveGlass = (shape: 'circle' | 'capsule', tint?: ColorValue) =>
  glassEffect({ glass: { variant: 'regular', interactive: true, tint: tint as string | undefined }, shape });

/** A round glass button in its own Host. `tint` fills the glass (the prominent style). */
export function GlassIcon({ icon, label, hint, onPress, onLongPress, size, iconSize, color, tint, disabled }: {
  icon: SFSymbol; label: string; hint?: string; onPress: () => void; onLongPress?: () => void; size: number; iconSize: number; color?: ColorValue; tint?: ColorValue; disabled?: boolean;
}) {
  const colors = useColors();
  const scheme = useColorScheme();
  return (
    <Host matchContents colorScheme={scheme ?? undefined}>
      <Image systemName={icon} size={iconSize} color={color ?? colors.text} modifiers={[
        frame({ width: size, height: size }), contentShape(shapes.circle()), interactiveGlass('circle', tint),
        onTapGesture(onPress), ...(onLongPress ? [onLongPressGesture(onLongPress)] : []),
        accessibilityLabel(label), ...(hint ? [accessibilityHint(hint)] : []), accessibilityAddTraits(['isButton']), disable(!!disabled),
      ]} />
    </Host>
  );
}
