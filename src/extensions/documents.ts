/** JSON-only document presentation admission. No DOM or native authority. */
import { validateContract } from './contracts.ts';
export type DocumentControl = Readonly<{ id: string; label: string; enabled: boolean; selected?: boolean }>;
export type DocumentTab = Readonly<{ id: string; documentId: string; label: string; controls: readonly DocumentControl[] }>;
export type DocumentPresentation = Readonly<{ contractVersion: 1; context: string; revision: number; tabs: readonly DocumentTab[]; selected: string; focused: string; visible: boolean }>;
export type DocumentAction = Readonly<{ contractVersion: 1; context: string; revision: number; tabId: string; documentId: string; controlId: string }>;
export type DocumentResult = { ok: true } | { ok: false; reason: 'InvalidArguments' | 'UnsupportedCapability' | 'StaleContext' | 'Revoked' };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => !field.get && !field.set));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
export function createDocumentPresentation(props: DocumentPresentation, current: () => DocumentPresentation, authorized: () => boolean, dispatch: (action: DocumentAction) => void) {
  if (!record(props) || !validateContract('documentPresentation', props).ok) throw new Error('Invalid document presentation');
  const ids = new Set<string>();
  for (const tab of props.tabs) {
    if (!record(tab) || Object.keys(tab).some(key => !['id', 'documentId', 'label', 'controls'].includes(key)) || !text(tab.id) || ids.has(tab.id) || !text(tab.documentId) || !text(tab.label) || !Array.isArray(tab.controls) || tab.controls.length > 256 || tab.controls.some(control => !record(control) || Object.keys(control).some(key => !['id', 'label', 'enabled', 'selected'].includes(key)) || !text(control.id) || !text(control.label) || typeof control.enabled !== 'boolean' || control.selected !== undefined && typeof control.selected !== 'boolean') || new Set(tab.controls.map(control => control.id)).size !== tab.controls.length) throw new Error('Invalid document tab');
    ids.add(tab.id);
  }
  if (props.selected && !ids.has(props.selected)) throw new Error('Invalid document selection');
  const captured = freeze(structuredClone(props)); let disposed = false;
  return {
    props: captured,
    dispatch(input: unknown): DocumentResult {
      if (disposed || !authorized()) return { ok: false, reason: 'Revoked' };
      if (!record(input) || Object.keys(input).sort().join(',') !== 'context,contractVersion,controlId,documentId,revision,tabId' || !text(input.tabId) || !text(input.documentId) || !text(input.controlId) || !text(input.context) || !Number.isSafeInteger(input.revision)) return { ok: false, reason: 'InvalidArguments' };
      if (input.contractVersion !== 1) return { ok: false, reason: 'UnsupportedCapability' };
      const action = input as DocumentAction, live = current();
      if (!validateContract('documentPresentation', live).ok) return { ok: false, reason: 'StaleContext' };
      if (action.context !== captured.context || live.context !== captured.context || action.revision !== captured.revision || live.revision !== captured.revision || !live.visible || !captured.visible) return { ok: false, reason: 'StaleContext' };
      const tab = captured.tabs.find(tab => tab.id === action.tabId), latest = live.tabs.find(tab => tab.id === action.tabId);
      if (!tab || !latest || tab.documentId !== action.documentId || latest.documentId !== action.documentId) return { ok: false, reason: 'InvalidArguments' };
      if (!tab.controls.some(control => control.id === action.controlId && control.enabled) || !latest.controls.some(control => control.id === action.controlId && control.enabled)) return { ok: false, reason: 'UnsupportedCapability' };
      dispatch(freeze(structuredClone(action))); return { ok: true };
    },
    dispose() { disposed = true; },
  };
}
