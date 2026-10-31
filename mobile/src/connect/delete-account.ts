// Account deletion order (App Store guideline 5.1.1(v)); pure, tested in node. client.ts wires it.
export const NOT_CONFIRMED = 'The relay did not confirm that the account was deleted.';

export interface DeleteSteps {
  /** `DELETE /v1/account`; the relay answers `{ ok: true }`. */
  remove: () => Promise<unknown>;
  /** Erases this phone's secrets and caches. */
  wipe: () => Promise<void>;
  signOut: () => Promise<void>;
}

/** The relay deletes first; only a confirmed deletion wipes and signs out, so a failure changes nothing here. */
export async function deleteAccount(steps: DeleteSteps): Promise<void> {
  const reply = await steps.remove();
  if ((reply as { ok?: unknown } | null)?.ok !== true) throw new Error(NOT_CONFIRMED);
  await steps.wipe();
  await steps.signOut();
}
