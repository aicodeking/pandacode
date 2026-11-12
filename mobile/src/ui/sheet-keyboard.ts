// Who lifts a form sheet's content above the keyboard: react-native-screens (Android, natively) or the
// screen's own KeyboardAvoidingView / KeyboardAwareScrollView. Both at once lifts it twice.
//
// react-native-screens 4.30 on Android (SheetAnimationCoordinator.calculateKeyboardShiftHidingBottomInset)
// translates a form sheet up by min(space above the sheet's highest detent, keyboard height). With a
// highest detent of 1 there is no space above it, and SheetDelegate expands a 2- or 3-detent sheet to
// that detent while the IME shows, so the native shift is 0 and the JS lift is still needed. A
// fitToContents sheet (or one whose highest detent is under 1) is moved natively, so JS keeps out.
// iOS never moves sheet content for the keyboard. Pure (no React Native import) for tests.

/** A sheet's `sheetAllowedDetents`, as passed in src/app/_layout.tsx. */
export type SheetDetents = 'fitToContents' | readonly number[];

/** Task info's detents in _layout.tsx (tests/header-actions.test.ts keeps them in step). */
export const TASK_INFO_DETENTS: SheetDetents = 'fitToContents';
/** SHEET_SCREENS' detents in _layout.tsx (rename, commit, new-pull, new-schedule, btw, add-project). */
export const FEATURE_SHEET_DETENTS: SheetDetents = [0.6, 1];

/** Whether react-native-screens itself moves this sheet above the keyboard on `os`. */
export function nativeSheetLift(os: string, detents: SheetDetents): boolean {
  if (os !== 'android') return false;
  if (detents === 'fitToContents') return true;
  return detents.length > 0 && Math.max(...detents) < 1;
}

/**
 * Whether a route that guards a draft (useDiscardGuard: Task info and SHEET_SCREENS) is a form sheet on
 * `os`. On Android _layout.tsx presents those as a modal (`androidModal`), which nothing lifts natively.
 */
export const guardedFormSheet = (os: string): boolean => os !== 'android';

/**
 * Whether a screen's own keyboard padding should run: everywhere the native sheet doesn't lift it.
 * `formSheet` is false where the route isn't presented as a form sheet on `os` (see guardedFormSheet).
 */
export const sheetKeyboardPadding = (os: string, detents: SheetDetents, formSheet = true): boolean =>
  !formSheet || !nativeSheetLift(os, detents);
