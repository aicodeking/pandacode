// The inline note under an action this phone can't use on a computer (ui/AccessNote.tsx). Pure, so
// tests/access-note.test.ts covers it in node. Outdated hosts stay silent here: those actions are
// hidden as before, and a call to one explains itself ("Update PandaCode on <computer>…").
import { blockedBy, type HostCapabilities } from '../connect/api/hello.ts';

const LABEL = { view: 'View', control: 'Control', full: 'Full' } as const;

/** The note for the first of `methods` the grant or the Full access switch keeps off, or null. */
export function accessNoteText(caps: HostCapabilities | undefined, methods: readonly string[], computer: string): string | null {
  for (const method of methods) {
    const reason = blockedBy(caps, method);
    if (reason === 'switch') return `Turn on Full access for remote tasks on ${computer}.`;
    if (reason === 'access') {
      const needed = caps?.kind === 'hello' ? caps.methodAccess.get(method) ?? 'full' : 'full';
      return `Needs ${LABEL[needed]} access — change it for this phone in PandaCode Settings → Connect on ${computer}.`;
    }
  }
  return null;
}
