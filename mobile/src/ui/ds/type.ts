// Text styles on the iOS text-style scale, with Apple's tracking per size. Dynamic Type stays on:
// cap only tiny chrome with `CHROME_FONT_SCALE`.
import type { ComponentProps } from 'react';
import { Platform, type TextStyle } from 'react-native';
import type { Icon } from '../Icon.tsx';
import { mono } from '../theme.ts';

const style = (fontSize: number, lineHeight: number, tracking: number, fontWeight: TextStyle['fontWeight'] = '400'): TextStyle => ({
  fontSize, lineHeight, fontWeight, letterSpacing: Platform.OS === 'ios' ? tracking : 0,
});

export const type = {
  largeTitle: style(34, 41, 0.37, '700'),
  title3: style(20, 25, 0.38, '600'),
  headline: style(17, 22, -0.41, '600'),
  body: style(17, 22, -0.41),
  bodyMedium: style(17, 22, -0.41, '500'),
  callout: style(16, 21, -0.32),
  calloutMedium: style(16, 21, -0.32, '500'),
  subhead: style(15, 20, -0.24),
  subheadMedium: style(15, 20, -0.24, '500'),
  footnote: style(13, 18, -0.08),
  footnoteMedium: style(13, 18, -0.08, '500'),
  caption: style(12, 16, 0),
  code: { fontFamily: mono, fontSize: 13, lineHeight: 18 } satisfies TextStyle,
};

export const CHROME_FONT_SCALE = 1.4;

/** Phone geometry; radii always with `borderCurve: 'continuous'`. */
export const geometry = {
  hairline: 0.5, screenMargin: 10, sectionGap: 10,
  cardRadius: 20, cardPadding: 6, innerRadius: 14, controlRadius: 12, chipRadius: 7,
  rowHeight: 44, rowHeightSubtitle: 58,
  /** Above a screen's empty or error state, so it sits in the upper part of the page. */
  emptyTop: 48,
  /** Side padding inside a card's rows, as Row's. */
  rowInset: 12,
};

export type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;
