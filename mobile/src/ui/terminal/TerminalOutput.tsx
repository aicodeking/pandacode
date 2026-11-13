// The terminal's scrollback: one monospace Text per line in a virtualized list, styled runs from
// store/terminal.ts. It follows new output unless the user scrolled up, and measures how many
// columns and rows fit (narrow phones, the Duo split pane) so the computer wraps for this width.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, useColorScheme, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type TextStyle } from 'react-native';
import { colorOf, gridFor, lineSpans, type CellStyle, type Line, type Screen } from '../../store/terminal.ts';
import { mono, useColors } from '../theme.ts';

export const FONT_SIZE = 12;
export const LINE_HEIGHT = 16;
/** Padding on each side of the text. */
const PAD = 10;
/** Within this of the end still counts as following the output. */
const FOLLOW_SLACK = 24;
const SAMPLE = 'M'.repeat(20);

interface Ink { text: string; page: string; dark: boolean }

function spanStyle(style: CellStyle, ink: Ink): TextStyle | undefined {
  if (style.fg === undefined && style.bg === undefined && !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse) return undefined;
  let fg = style.fg === undefined ? ink.text : colorOf(style.fg, ink.dark);
  let bg = style.bg === undefined ? undefined : colorOf(style.bg, ink.dark);
  if (style.inverse) [fg, bg] = [bg ?? ink.page, fg];
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: style.bold ? '700' : undefined,
    opacity: style.dim ? 0.6 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecorationLine: style.underline ? 'underline' : undefined,
  };
}

const TerminalLine = memo(function TerminalLine({ line, ink }: { line: Line; ink: Ink }) {
  const spans = lineSpans(line);
  return (
    <Text style={[styles.line, { color: ink.text }]}>
      {spans.length ? spans.map((span, i) => <Text key={i} style={spanStyle(span.style, ink)}>{span.text}</Text>) : ' '}
    </Text>
  );
});

export interface TerminalOutputProps {
  screen: Screen;
  /** The columns and rows that fit, whenever they change. */
  onGrid: (cols: number, rows: number) => void;
  /** Room kept above the first line: the glass header the output scrolls under, plus the settled
   * keyboard height while it lifts the view (a transform, so no layout event fires). */
  topInset: number;
  bottomInset: number;
}

export function TerminalOutput({ screen, onGrid, topInset, bottomInset }: TerminalOutputProps) {
  const colors = useColors();
  const dark = useColorScheme() === 'dark';
  const ink: Ink = { text: colors.text, page: colors.page, dark };
  const list = useRef<FlatList<Line>>(null);
  const following = useRef(true);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [charWidth, setCharWidth] = useState(0);
  const grid = useRef('');

  const report = useCallback((width: number, height: number, char: number) => {
    if (!width || !char) return;
    const { cols, rows } = gridFor(width - PAD * 2, height - PAD * 2, char, LINE_HEIGHT);
    const key = `${cols}x${rows}`;
    if (key === grid.current) return;
    grid.current = key;
    onGrid(cols, rows);
  }, [onGrid]);

  // Re-measure on layout, on the sample's width, and whenever the inset changes (the keyboard
  // settling lifts the view with a transform, which fires no layout event).
  useEffect(() => {
    report(box.width, box.height - topInset, charWidth);
  }, [report, box.width, box.height, topInset, charWidth]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ width, height });
  };
  const onSample = (e: LayoutChangeEvent) => {
    setCharWidth(e.nativeEvent.layout.width / SAMPLE.length);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
  };
  const follow = () => {
    if (following.current) list.current?.scrollToEnd({ animated: false });
  };

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <Text style={[styles.line, styles.sample]} onLayout={onSample} accessible={false} importantForAccessibility="no-hide-descendants">{SAMPLE}</Text>
      <FlatList
        ref={list}
        data={screen.lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <TerminalLine line={item} ink={ink} />}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={follow}
        onLayout={follow}
        initialNumToRender={60}
        windowSize={9}
        maxToRenderPerBatch={80}
        removeClippedSubviews
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: PAD + topInset, paddingBottom: PAD + bottomInset }}
        accessibilityLabel="Terminal output"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  line: { fontFamily: mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT },
  sample: { position: 'absolute', opacity: 0, left: 0, top: 0 },
});
