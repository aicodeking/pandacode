// Nested cards as in the reference: outer card > (section head) > inner card > (foot).
import { Children, type ReactNode } from 'react';
import { StyleSheet, Text, View, type ViewProps } from 'react-native';
import Animated from 'react-native-reanimated';
import { useColors } from '../theme.ts';
import { useStagger } from './motion.ts';
import { geometry, type } from './type.ts';

export function Card({ style, ...rest }: ViewProps) {
  const colors = useColors();
  return <View {...rest} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, boxShadow: colors.shadowCard }, style]} />;
}

export function InnerCard({ style, ...rest }: ViewProps) {
  const colors = useColors();
  return <View {...rest} style={[styles.inner, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }, style]} />;
}

export interface CardSectionProps extends ViewProps {
  title?: string;
  /** Beside the title: a count or an icon button. */
  trailing?: ReactNode;
  /** Under the inner card, inside the outer one: a meter, a merge button. */
  footer?: ReactNode;
}

export function CardSection({ title, trailing, footer, children, ...rest }: CardSectionProps) {
  const colors = useColors();
  return (
    <Card {...rest}>
      {(!!title || !!trailing) && (
        <View style={styles.head}>
          <Text accessibilityRole="header" numberOfLines={1} style={[type.subhead, styles.title, { color: colors.muted }]}>{title}</Text>
          {trailing}
        </View>
      )}
      <InnerCard>{children}</InnerCard>
      {!!footer && <View style={styles.foot}>{footer}</View>}
    </Card>
  );
}

function StaggeredRows({ children }: { children: ReactNode }) {
  const enter = useStagger();
  return Children.toArray(children).map((row, i) => <Animated.View key={i} entering={enter(i)}>{row}</Animated.View>);
}

export interface GroupProps extends CardSectionProps {
  /** The rows arrive one after another on first mount. */
  stagger?: boolean;
}

/** One card for settings and sheets: an optional head, its rows, and a note, all inside. No head for a single row. */
export function Group({ title, trailing, footer, stagger, children, style, ...rest }: GroupProps) {
  const colors = useColors();
  return (
    <View {...rest} style={[styles.flat, { backgroundColor: colors.card, borderColor: colors.border, boxShadow: colors.shadowCard }, style]}>
      {(!!title || !!trailing) && (
        <View style={styles.groupHead}>
          <Text accessibilityRole="header" numberOfLines={1} style={[type.subhead, styles.title, { color: colors.muted }]}>{title}</Text>
          {trailing}
        </View>
      )}
      {stagger ? <StaggeredRows>{children}</StaggeredRows> : children}
      {!!footer && <View style={styles.groupFoot}>{footer}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 },
  groupFoot: { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 6 },
  flat: { borderRadius: geometry.cardRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, paddingVertical: 4 },
  card: { borderRadius: geometry.cardRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, padding: geometry.cardPadding },
  inner: { borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, paddingVertical: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 10, paddingTop: 2, paddingBottom: 6 },
  title: { flex: 1 },
  foot: { paddingHorizontal: 6, paddingTop: 8, paddingBottom: 2 },
});
