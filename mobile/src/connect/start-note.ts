/** Why a host started a task somewhere other than asked (its busy or dirty checkout gave way to
 * a worktree), as one short line; older hosts send none. The reply is the host's, so untrusted. */
export function startNote(reply: unknown): string | undefined {
  const note = (reply as { note?: unknown } | null)?.note;
  if (typeof note !== 'string') return undefined;
  const line = note.split('\n')[0].trim().slice(0, 300);
  return line || undefined;
}
