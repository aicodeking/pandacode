/** Private host wiring, deliberately separate from the read-only public ui object. */
import { createUiCatalog, createCoreCommands, CatalogError, type PublicCommandId } from './catalog';
import { extensionsSnapshot } from './manager';
export const ui = createUiCatalog(extensionsSnapshot);
let commands: ReturnType<typeof createCoreCommands> | undefined;
export function registerCoreCommands(handlers: Record<PublicCommandId, () => void | Promise<void>>): () => void {
  if (commands) throw new Error('Core UI commands already registered');
  const registration = createCoreCommands(handlers); commands = registration;
  return () => { if (commands === registration) commands = undefined; };
}
export async function invokeCoreCommand(id: string): Promise<void> {
  if (!commands) throw new CatalogError('HostUnavailable');
  await commands.invoke(id, null);
}
