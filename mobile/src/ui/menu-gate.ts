// Whether a menu item for a host method shows, and what it says when it can't run, as the computer
// hub does: hidden only when the computer lacks the method (an older PandaCode); kept when this
// phone's grant or the computer's "Full access for remote tasks" switch is in the way, where it
// carries the AccessNote text (a disabled subtitle in the iOS menu, an alert when tapped elsewhere).
// Pure, so tests/menu-gate.test.ts covers it in node.
import { supports, type HostCapabilities } from '../connect/api/hello.ts';
import { accessNoteText } from './access-note.ts';

export interface MenuGate {
  /** False only when the computer is known not to serve the method. */
  shown: boolean;
  /** Why this phone can't use it there (the AccessNote text), or null when it can. */
  note: string | null;
}

export function menuGate(caps: HostCapabilities | undefined, method: string, computer: string): MenuGate {
  return { shown: supports(caps, method) ?? true, note: accessNoteText(caps, [method], computer) };
}

/** The alert's title when a blocked item is tapped. */
export const BLOCKED_TITLE = 'Not available from this phone';

/** `run`, or, when the gate has a note, `explain` with it instead. */
export const gatedPress = (gate: MenuGate, run: () => void, explain: (note: string) => void) => (): void => {
  if (gate.note) explain(gate.note);
  else run();
};
