// Asks before a sheet or screen with typed, unsaved input goes away (swipe down, Cancel, back):
// 'Discard changes?' with Keep Editing and Discard. A successful submit calls the returned `release()`
// before it leaves, so saving never asks.
import { usePreventRemove } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

export type DiscardGuardOptions = {
  /** The alert's body; omitted, it says the changes aren't saved. */
  message?: string;
  /** Runs before the blocked navigation repeats, to drop the draft (e.g. back to view mode). */
  onDiscard?: () => void;
};

export const DISCARD_TITLE = 'Discard changes?';
const DISCARD_MESSAGE = 'Your changes aren’t saved.';

/** Guards `dirty` input; returns `release()`, which lets the next leave through without asking. */
export function useDiscardGuard(dirty: boolean, { message = DISCARD_MESSAGE, onDiscard }: DiscardGuardOptions = {}): () => void {
  const [released, setReleased] = useState(false);
  // Once the input is clean again (saved in place, or discarded), later edits are guarded afresh.
  if (released && !dirty) setReleased(false);
  const disable = usePreventRemove(dirty && !released, ({ repeat }) => {
    Alert.alert(DISCARD_TITLE, message, [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { setReleased(true); onDiscard?.(); repeat(); } },
    ]);
  });
  return useCallback(() => { setReleased(true); disable(); }, [disable]);
}
