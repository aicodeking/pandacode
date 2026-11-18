// Small pieces the Settings screen and the task sheets share.
import { useHeaderHeight } from 'expo-router/react-navigation';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useColors } from './theme.ts';
import Animated from 'react-native-reanimated';
import { CrossFadeText, Segmented, type as text, useMotion, type IconName } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { MODES } from './status.tsx';

const GLYPH = 20;
const GLYPH_MAX_SCALE = 1.6;

/**
 * Top padding for a sheet whose height follows its content. iOS 26 lays a sheet out under its header;
 * as an inset that height isn't counted when the sheet fits itself, and the last rows fall off the bottom.
 */
export function useSheetTop(): number {
  const header = useHeaderHeight();
  return Platform.OS === 'ios' ? header : 0;
}

/** A row's leading SF Symbol. */
export function Glyph({ icon, tone }: { icon: IconName; tone?: string }) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  return <Icon {...icon} size={GLYPH * Math.min(fontScale, GLYPH_MAX_SCALE)} color={tone ?? colors.muted} />;
}

/** Quiet text in a card's footer, or under a control. */
export function Note({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <Text style={[text.footnote, { color: colors.muted }]}>{children}</Text>;
}

const OPTIONS = MODES.map(mode => ({ value: mode.id, label: mode.label }));

/** The permission mode and what it does; a mode the phone doesn't list (a newer host's) shows by name with no segment lit. */
export function PermissionPicker({ value, onChange, note }: { value: string; onChange: (mode: string) => void; note?: string }) {
  const colors = useColors();
  const hint = MODES.find(mode => mode.id === value)?.hint ?? value;
  const { layout } = useMotion();
  return (
    <View style={styles.permission}>
      <Segmented accessibilityLabel="Permissions" options={OPTIONS} value={value} onChange={onChange} />
      <Animated.View layout={layout}>
        <CrossFadeText text={note ? `${hint} ${note}` : hint} style={[text.footnote, styles.hint, { color: colors.muted }]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  permission: { padding: 8, gap: 8 },
  hint: { paddingHorizontal: 4 },
});
