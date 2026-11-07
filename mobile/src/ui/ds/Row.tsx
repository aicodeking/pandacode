// A row inside an inner card: leading symbol or tile, title, muted subtitle, trailing meta, chevron.
import { isValidElement, type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '../theme.ts';
import { Icon } from '../Icon.tsx';
import type { Tone } from './palette.ts';
import { PressScale, type PressScaleProps } from './PressScale.tsx';
import { Toggle } from './Toggle.tsx';
import { geometry, type } from './type.ts';

const DISABLED_OPACITY = 0.5;
/** From about the largest non-accessibility size, a row stops sharing its line. */
export const LARGE_TEXT_SCALE = 1.3;
const META_MIN_WIDTH = 56;
const LARGE_TITLE_LINES = 2;
const LARGE_SUBTITLE_LINES = 3;

export interface RowProps extends Omit<PressScaleProps, 'children' | 'style' | 'disabled'> {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  /** A string reads as muted meta ("4 of 4"); anything else is drawn as given. */
  trailing?: ReactNode;
  chevron?: boolean;
  /** Colours the state line: the subtitle when there is one, otherwise the title. */
  tone?: Tone;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Row({ title, subtitle, leading, trailing, chevron, tone, disabled, style, onPress, accessibilityLabel, ...rest }: RowProps) {
  const colors = useColors();
  const large = useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
  const toned = tone ? colors[tone] : undefined;
  const titleColor = !subtitle && toned ? toned : colors.text;
  const meta = typeof trailing === 'string'
    ? <Text numberOfLines={large ? LARGE_SUBTITLE_LINES : 1} style={[type.subhead, !large && styles.meta, { color: colors.faint }]}>{trailing}</Text>
    : trailing;
  // A switch keeps the edge at any size; everything else that wants a line of its own goes under the title.
  const underTitle = large && !(isValidElement(trailing) && trailing.type === Toggle);
  const body = (
    <>
      {leading != null && <View style={[styles.leading, large && styles.leadingLarge]}>{leading}</View>}
      <View style={styles.text}>
        <Text numberOfLines={large ? LARGE_TITLE_LINES : 1} style={[type.body, { color: titleColor }]}>{title}</Text>
        {!!subtitle && <Text numberOfLines={large ? LARGE_SUBTITLE_LINES : 1} style={[type.subhead, { color: toned ?? colors.muted }]}>{subtitle}</Text>}
        {underTitle && meta != null && <View style={styles.under}>{meta}</View>}
      </View>
      {!underTitle && meta}
      {chevron && <Icon ios="chevron.right" android="chevron_right" size={13} color={colors.glyphFaint} />}
    </>
  );
  const frame = [styles.row, large && styles.rowLarge, { minHeight: subtitle ? geometry.rowHeightSubtitle : geometry.rowHeight }, disabled && styles.disabled, style];
  if (!onPress) return <View style={frame} testID={rest.testID}>{body}</View>;
  return (
    <PressScale {...rest} onPress={onPress} disabled={disabled} accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)} style={frame}>
      {body}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 6 },
  leading: { minWidth: 22, alignItems: 'center', justifyContent: 'center' },
  rowLarge: { alignItems: 'flex-start' },
  // Every leading, tile or symbol, takes the width of a scaled symbol, so titles share an edge.
  leadingLarge: { minWidth: 34, marginTop: 6 },
  // The title wins: it takes what it needs and the meta gives way first, down to a readable stub.
  text: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  meta: { flexShrink: 1000, minWidth: META_MIN_WIDTH, textAlign: 'right' },
  under: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  disabled: { opacity: DISABLED_OPACITY },
});
