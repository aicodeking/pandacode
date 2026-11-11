// Pieces the git screens share (Changes, Commit, Branches, Worktree, New pull request): the bottom action bar, the branch card and the worktree banner.
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, CHROME_FONT_SCALE, geometry, InnerCard, Row, type as text } from './ds/index.ts';
import { useToastClearance } from './ds/Toast.tsx';
import { Icon } from './Icon.tsx';
import { usePaneInsets } from './split.tsx';
import { useColors } from './theme.ts';
import { useIconSize } from './usePagePadding.ts';

/** One-handed actions pinned under a screen's scroll: clear of the home indicator and the Duo's side rail. */
/** The bottom bar: rides on the keyboard (its safe-area padding tucks under it), so its buttons stay
 * reachable while typing. `onHeight`: its height, for a scroll view's keyboard offset. */
export function ActionBar({ children, note, onHeight }: { children?: ReactNode; note?: string; onHeight?: (height: number) => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const side = usePaneInsets();
  // Toasts sit above this bar while its screen is focused (0 until laid out).
  const [height, setHeight] = useState(0);
  useToastClearance(height);
  const measure = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight(next);
    onHeight?.(next);
  };
  return (
    <KeyboardStickyView offset={{ opened: insets.bottom }}>
      <View onLayout={measure} style={[styles.bar, {
        backgroundColor: colors.page, borderTopColor: colors.border,
        paddingBottom: insets.bottom + geometry.screenMargin, paddingLeft: side.left + geometry.screenMargin, paddingRight: side.right + geometry.screenMargin,
      }]}>
        {!!note && <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} numberOfLines={2} style={[text.footnote, styles.note, { color: colors.muted }]}>{note}</Text>}
        {!!children && <View style={styles.actions}>{children}</View>}
      </View>
    </KeyboardStickyView>
  );
}

/** The branch, how it stands against its upstream, and (`onPress`) a way to other branches. */
export function BranchRow({ branch, detail, onPress, trailing }: { branch: string; detail: string; onPress?: () => void; trailing?: ReactNode }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  return (
    <Row title={branch || 'No branch'} subtitle={detail} chevron={!!onPress} onPress={onPress} trailing={trailing}
      leading={<Icon ios="arrow.triangle.branch" android="call_split" size={iconSize} color={colors.muted} />}
      accessibilityHint={onPress ? 'Shows the branches' : undefined} accessibilityLabel={`Branch ${branch || 'none'}, ${detail}`} />
  );
}

/** Says the task works in its own worktree; opens the worktree screen. */
export function WorktreeBanner({ device, session, merged }: { device: string; session: string; merged?: boolean }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  return (
    <Card>
      <InnerCard>
        <Row title="Separate worktree" subtitle={merged ? 'Merged · remove it when you’re done' : 'Merge it into the main branch when it’s ready'} chevron
          leading={<Icon ios="square.stack.3d.down.right" android="account_tree" size={iconSize} color={colors.primary} />}
          onPress={() => router.push({ pathname: '/worktree', params: { device, session } })} accessibilityHint="Shows the worktree" />
      </InnerCard>
    </Card>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: geometry.hairline, paddingTop: geometry.screenMargin, gap: 8 },
  note: { paddingHorizontal: 4 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
