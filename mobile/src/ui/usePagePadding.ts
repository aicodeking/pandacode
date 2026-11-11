import { useWindowDimensions } from 'react-native';
import { geometry } from './ds/index.ts';
import { usePaneInsets } from './split.tsx';

const BOTTOM = 48;

/** A pushed screen's scroll content: the screen margin clear of side insets (the iPhone Duo's rail; not
 * the left one beside the split view's sidebar, usePaneInsets). */
export function usePagePadding() {
  const { left, right } = usePaneInsets();
  return { paddingTop: geometry.screenMargin, paddingBottom: BOTTOM, paddingLeft: geometry.screenMargin + left, paddingRight: geometry.screenMargin + right, gap: geometry.sectionGap };
}

const ICON_SCALE_CAP = 1.6;

/** A glyph's size beside text at the current Dynamic Type size, so large text doesn't dwarf its icon. */
export function useIconSize(size: number) {
  const { fontScale } = useWindowDimensions();
  return Math.round(size * Math.min(fontScale, ICON_SCALE_CAP));
}
