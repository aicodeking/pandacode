// The brand's layout in points, shared by the views and the clearance test. No React Native imports.
// The 44 pt box is the bar item; its vertical centre is the right-hand buttons' centre line.

export const BOX_HEIGHT = 44;
export const FONT_SIZE = 20;
/** SF Rounded Heavy at 20 pt, measured on device. */
export const CAP = 14.2;
export const ASCENDER = 14.8;
export const X_HEIGHT = 10.6;
/** The baseline: cap height centred on the box, so the word sits on the buttons' axis. */
export const BASELINE = BOX_HEIGHT / 2 + CAP / 2;
/**
 * The bar places items 20 pt in, but the buttons' glass reaches 16 pt from the edge: the word's left
 * edge matches that. The panda lives at the word's other end and its trip stays over the word, so
 * nothing crosses that line.
 */
export const OPTICAL_INSET = -4;
export const PANDA_SIZE = 22;
/** The ears' top inside the panda's box. */
export const EAR_TOP = 0.4;
/** On a letter the feet sit this far into its top, as if the panda's weight settles on it. */
export const SINK = 1;
/** The resting panda's gap after the e (from the e's edge to the panda's nearest outline). */
export const REST_GAP = 1.5;
/** The panda's outline reaches this far from its centre at rest (head and ears). */
export const HALF_WIDTH = 10.5;
/** The tap trick's height above the perch. */
export const TRICK_JUMP = 13;
/** The pressed letter carries the panda down with it. */
export const DIP = 1.6;
/** The shadow under the feet, on the ground at rest and on whatever letter is below in flight. */
export const SHADOW_WIDTH = 12;
export const SHADOW_HEIGHT = 3;
/** The d perch sits over its stem (at the glyph's right side), this far right of the letter's centre. */
export const PERCH_OFFSET_D = 3.2;

const TALL = new Set(['P', 'C', 'd']);

/** How far a letter rises above the baseline. */
export function letterTop(char: string): number {
  return char === 'd' ? ASCENDER : TALL.has(char) ? CAP : X_HEIGHT;
}
