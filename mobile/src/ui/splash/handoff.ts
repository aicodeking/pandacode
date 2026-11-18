// What the intro and the Inbox header's brand share: the brand registers how to find itself on screen
// (the intro flies the mark there), stays hidden until the mark arrives, and holds its own show until
// the intro is done. iOS only plays the intro; elsewhere the brand is shown from the start.
import { Platform } from 'react-native';
import { makeMutable } from 'react-native-reanimated';
import { create } from 'zustand';
import { consumeShow } from '../brand/useShowClock.ts';

/** The header brand's word box in window coordinates, its letters' left edges and the panda's home (word coordinates). */
export interface Rect { x: number; y: number; width: number; height: number; lefts: readonly number[]; home: number }

interface IntroState {
  /** The intro has finished (or never played): the header brand runs its own show. */
  done: boolean;
  /** The header brand's word box in window coordinates, or null when it is not on screen. */
  measure: (() => Promise<Rect | null>) | null;
}

const PLAYS = Platform.OS === 'ios';

export const useIntro = create<IntroState>(() => ({ done: !PLAYS, measure: null }));

/** The header brand's opacity, driven by the hand-off on the UI thread. */
export const headerShown = makeMutable(PLAYS ? 0 : 1);

/** The Inbox list's entrance (0 hidden and a few points low, 1 in place), driven by the hand-off. */
export const contentShown = makeMutable(PLAYS ? 0 : 1);

export function finishIntro() {
  consumeShow();
  headerShown.set(1);
  contentShown.set(1);
  useIntro.setState({ done: true });
}

