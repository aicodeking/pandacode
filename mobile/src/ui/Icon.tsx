import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

type Android = Exclude<ComponentProps<typeof SymbolView>['name'], string>['android'];

/** SF Symbol on iOS, Material Symbol on Android. */
export function Icon({ ios, android, size = 20, color }: { ios: SFSymbol; android: Android; size?: number; color?: ColorValue }) {
  return <SymbolView name={{ ios, android }} size={size} tintColor={color as string | undefined} />;
}
