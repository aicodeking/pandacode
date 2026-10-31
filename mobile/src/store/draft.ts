// Each task's unsent composer text. Generative UI (chips, buttons, forms) fills it; the Composer
// reads and edits it and focuses the field when `focus` ticks. Nothing here sends.
import { create } from 'zustand';

type Drafts = { text: Record<string, string>; focus: Record<string, number> };

export const draftKey = (deviceId: string, sessionId: string) => `${deviceId}\u0000${sessionId}`;

export const useDrafts = create<Drafts>(() => ({ text: {}, focus: {} }));

/** Adds `text` after what is already typed, as the desktop's fillComposer does. */
export const appendDraft = (current: string, text: string) => (current.trimEnd() ? `${current.trimEnd()}\n\n${text}` : text);

export function setDraft(key: string, text: string): void {
  useDrafts.setState(s => ({ text: { ...s.text, [key]: text } }));
}

/** Puts a prompt in the task's composer for the user to review, and focuses it. */
export function fillDraft(key: string, text: string): void {
  useDrafts.setState(s => ({ text: { ...s.text, [key]: appendDraft(s.text[key] ?? '', text) }, focus: { ...s.focus, [key]: (s.focus[key] ?? 0) + 1 } }));
}
