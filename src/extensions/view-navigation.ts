import { isExtensionInspectorView, type ExtensionInspectorView } from '../inspector-tabs';

// Host-only binding. Packages submit declared openView actions, never DOM events/selectors.
let open: (id: ExtensionInspectorView) => boolean = () => false;
export function registerInspectorViewOpener(handler: typeof open): () => void {
  open = handler;
  return () => { if (open === handler) open = () => false; };
}
export function requestInspectorView(id: unknown): boolean { return isExtensionInspectorView(id) && open(id); }
