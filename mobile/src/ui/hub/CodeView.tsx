// A file's text for the phone: line numbers, monospace, one horizontal scroll for the whole file
// (lines never wrap), a cheap syntax colouring and a jump to a line. The vertical list is the
// screen's scroll view, so the bar's scroll edge and the Duo's insets work as on other screens.
import { forwardRef, useMemo, useState, type ReactElement } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type ListRenderItem } from 'react-native';
import Animated from 'react-native-reanimated';
import { commentPrefix, tokenize, type TokenKind } from '../../store/files.ts';
import { useColors, mono, type Colors } from '../theme.ts';
import { codeWidth, expandTabs, gutterWidth, GUTTER_PAD, MAX_CHARS } from './code-lines.ts';

const LINE_HEIGHT = 19;
const FONT_SIZE = 13;
/** The code and its line numbers stay at their base size: widths and the fixed row height are measured
 * from it, and a larger Dynamic Type size would clip them. */
const FIXED_SCALE = 1;

const tone = (colors: Colors, kind: TokenKind) =>
  kind === 'comment' ? colors.faint : kind === 'string' ? colors.success : kind === 'keyword' ? colors.info : kind === 'number' ? colors.warning : colors.text;

export interface CodeViewProps {
  lines: readonly string[];
  path: string;
  /** 1-based line to highlight and start at. */
  focus?: number;
  insets: { left: number; right: number };
  footer?: ReactElement;
  onEndReached?: () => void;
  /** The pushed screen's scroll edge feed (usePushedScroll). */
  scrollHandler?: unknown;
  onLayout?: (event: LayoutChangeEvent) => void;
  onContentSizeChange?: (width: number, height: number) => void;
}

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<string>);

export const CodeView = forwardRef<FlatList<string>, CodeViewProps>(function CodeView(
  { lines, path, focus, insets, footer, onEndReached, scrollHandler, onLayout, onContentSizeChange }, ref,
) {
  const colors = useColors();
  // The pane's own width (the Duo's split view is narrower than the window), measured from the scroll view.
  const [width, setWidth] = useState(0);
  const measure = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const comment = commentPrefix(path);
  // Tabs drawn as spaces, so every character is one monospace advance and the width below holds.
  const shown = useMemo(() => lines.map(line => expandTabs(line)), [lines]);
  const gutter = gutterWidth(shown.length);
  const contentWidth = useMemo(() => codeWidth(shown, width - insets.left - insets.right), [shown, width, insets.left, insets.right]);
  const render: ListRenderItem<string> = ({ item, index }) => {
    const focused = index + 1 === focus;
    return (
      <View style={[styles.line, focused && { backgroundColor: colors.warningFill }]}>
        <Text style={[styles.number, { width: gutter, color: focused ? colors.text : colors.faint }]} maxFontSizeMultiplier={FIXED_SCALE} accessibilityElementsHidden>{index + 1}</Text>
        <Text style={[styles.code, { color: colors.text }]} numberOfLines={1} ellipsizeMode="clip" maxFontSizeMultiplier={FIXED_SCALE}>
          {tokenize(item.length > MAX_CHARS ? item.slice(0, MAX_CHARS) : item, comment).map((token, i) => (
            token.kind === 'plain' ? token.text : <Text key={i} style={{ color: tone(colors, token.kind) }}>{token.text}</Text>
          ))}
        </Text>
      </View>
    );
  };
  const initial = focus && focus > 1 && focus <= lines.length ? Math.max(0, focus - 6) : undefined;
  return (
    <ScrollView horizontal style={{ backgroundColor: colors.background }} onLayout={measure} contentContainerStyle={{ paddingLeft: insets.left, paddingRight: insets.right }} showsHorizontalScrollIndicator directionalLockEnabled>
      <AnimatedFlatList
        ref={ref}
        style={{ width: contentWidth }}
        data={shown}
        renderItem={render}
        keyExtractor={(_, i) => String(i)}
        getItemLayout={(_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
        initialScrollIndex={initial}
        initialNumToRender={60}
        windowSize={11}
        contentInsetAdjustmentBehavior="automatic"
        onScroll={scrollHandler as never}
        scrollEventThrottle={16}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
        onEndReached={onEndReached}
        onEndReachedThreshold={2}
        ListFooterComponent={footer}
      />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  line: { flexDirection: 'row', height: LINE_HEIGHT, alignItems: 'center' },
  number: { fontFamily: mono, fontSize: FONT_SIZE - 1, textAlign: 'right', paddingRight: GUTTER_PAD },
  code: { fontFamily: mono, fontSize: FONT_SIZE, flexShrink: 0 },
});
