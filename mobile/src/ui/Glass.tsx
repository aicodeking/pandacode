// Liquid Glass where iOS 26 has it; a system blur material on older iOS, a solid surface on Android.
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, useColorScheme, View, type ViewProps } from 'react-native';
import { Material } from './Backdrop.tsx';
import { useColors } from './theme.ts';

export const hasGlass = isLiquidGlassAvailable();

export function Glass({ style, interactive, ...rest }: ViewProps & { interactive?: boolean }) {
  const colors = useColors();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  if (hasGlass) return <GlassView glassEffectStyle="regular" colorScheme={scheme} isInteractive={interactive} style={style} {...rest} />;
  const edge = { borderWidth: 0.5, borderColor: colors.separator };
  if (Platform.OS === 'ios') return <Material material="systemChromeMaterial" style={[edge, style]} {...rest} />;
  return <View style={[{ backgroundColor: colors.card }, edge, style]} {...rest} />;
}
