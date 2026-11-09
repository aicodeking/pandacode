// Each task's unsent composer text. Generative UI (chips, buttons, forms) fills it; the Composer
// reads and edits it and focuses the field when `focus` ticks. Nothing here sends. Also the pure
// keys for labelling steered prompts (kept here, free of native imports, so tests can run them).
import { create } from 'zustand';

type Drafts = { text: Record<string, string>; focus: Record<string, number> };

export const draftKey = (deviceId: string, sessionId: string) => `${deviceId}\u0000${sessionId}`;

/** The New task sheet's prompt, so swiping the sheet away never loses it. */
export const NEW_TASK_DRAFT = 'new-task';

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

/** Puts back the text of a failed send, unless something was typed while it was in flight. */
export function restoreDraft(key: string, text: string): void {
  useDrafts.setState(s => (s.text[key]?.trim() ? s : { text: { ...s.text, [key]: text } }));
}

export const steerKey = (taskKey: string, text: string) => `${taskKey}\u0000${text.trim()}`;

/** When this message was steered: same task and text, created at or after the steer. Else undefined. */
export function steeredAt(steers: Readonly<Record<string, number>>, taskKey: string, text: string, createdAt: number): number | undefined {
  const at = steers[steerKey(taskKey, text)];
  return at !== undefined && createdAt >= at ? at : undefined;
}
