import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { geometry } from './ds/index.ts';

const BOTTOM = 48;

/** A pushed screen's scroll content: the screen margin clear of side insets (the iPhone Duo's rail). */
export function usePagePadding() {
  const { left, right } = useSafeAreaInsets();
  return { paddingTop: geometry.screenMargin, paddingBottom: BOTTOM, paddingLeft: geometry.screenMargin + left, paddingRight: geometry.screenMargin + right, gap: geometry.sectionGap };
}

const ICON_SCALE_CAP = 1.6;

/** A glyph's size beside text at the current Dynamic Type size, so large text doesn't dwarf its icon. */
export function useIconSize(size: number) {
  const { fontScale } = useWindowDimensions();
  return Math.round(size * Math.min(fontScale, ICON_SCALE_CAP));
}
