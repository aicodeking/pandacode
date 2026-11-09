// Sign-out order; pure, tested in node. client.ts wires it on every path: Sign out, a refused token,
// removing this device, account deletion and leaving the demo.

export interface LocalSteps {
  /** Unsent composer text. */
  clearDrafts: () => void;
  /** Snoozes, pins and the outbox, in memory and stored. */
  clearLocal: () => Promise<void>;
}

/** A failed erase is logged and never keeps anyone signed in. */
export async function forgetPhoneState(steps: LocalSteps): Promise<void> {
  steps.clearDrafts();
  await steps.clearLocal().catch(error => console.warn('Could not clear local state', error));
}

export interface SignOutSteps {
  stop: () => void;
  forgetLocal: () => Promise<void>;
  clearSession: () => Promise<unknown>;
  reset: () => void;
}

/** The connection stops first and the outbox goes before the token, so an interrupted sign-out can't
 * leave old messages to send on the next sign-in. */
export async function signOutSteps(steps: SignOutSteps): Promise<void> {
  steps.stop();
  await steps.forgetLocal();
  await steps.clearSession();
  steps.reset();
}
