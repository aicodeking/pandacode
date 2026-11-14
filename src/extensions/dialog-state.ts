/** JSON-only form state. Host callbacks receive copies and cancellation, never DOM handles. */
import { primitiveLimit, validateContract, type Json } from './contracts.ts';

export type SelectOption = { value: string; label: string; disabled?: boolean };
export type DialogField = { id: string; label: string } & (
  { kind: 'text'; value?: string; required?: boolean; minLength?: number } |
  { kind: 'textarea'; value?: string; required?: boolean; minLength?: number; rows?: number } |
  { kind: 'switch'; value?: boolean } |
  { kind: 'select'; options: SelectOption[]; required?: boolean; multiple?: boolean; async?: boolean; placeholder?: string }
);
export type DialogDefinition = { title: string; fields: DialogField[]; confirmLabel?: string; confirmation?: string; successMessage: string; cancelMessage?: string };
export type DialogValues = Record<string, string | boolean | string[]>;
export type DialogContext = Record<string, Json>;
export type DialogResult = { kind: 'confirmed'; values: DialogValues } | { kind: 'cancelled'; reason: 'cancel' | 'unload' | 'busy' };
export type DialogCallbacks = {
  options(field: Extract<DialogField, { kind: 'select' }>, query: string, context: DialogContext, signal: AbortSignal): Promise<SelectOption[]>;
  validate(values: DialogValues, context: DialogContext, signal: AbortSignal): Promise<Record<string, string>>;
};
/** Text and textarea share one value contract; only their presentation differs. */
export const isTextField = (field: DialogField): field is Extract<DialogField, { kind: 'text' | 'textarea' }> => field.kind === 'text' || field.kind === 'textarea';
export const TEXT_LIMIT = primitiveLimit('field', 'text');
export const declarativeDialogCallbacks: DialogCallbacks = {
  async options(field, query) { return field.options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())); },
  async validate() { return {}; },
};

export function createDialogState(input: DialogDefinition, context: DialogContext, callbacks = declarativeDialogCallbacks) {
  const checked = validateContract('dialog', input), captured = validateContract('context', context);
  if (!checked.ok || !captured.ok) throw new Error('Invalid dialog data or context.');
  const definition = checked.value as unknown as DialogDefinition;
  const invocation = captured.value as DialogContext;
  const lifetime = new AbortController();
  const requests = new Map<string, AbortController>();
  const values: DialogValues = Object.fromEntries(definition.fields.map(field => [field.id, field.kind === 'select' ? field.multiple ? [] : '' : field.value ?? (field.kind === 'switch' ? false : '')]));
  const available = new Map(definition.fields.flatMap(field => field.kind === 'select' ? [[field.id, structuredClone(field.options)] as const] : []));
  const errors = (): Record<string, string> => Object.fromEntries(definition.fields.flatMap(field => {
    const value = values[field.id];
    if (isTextField(field) && (field.required && !String(value).trim() || String(value).length < (field.minLength ?? 0))) return [[field.id, field.minLength ? `Enter at least ${field.minLength} characters.` : 'This field is required.']];
    if (field.kind === 'select' && field.required && !(Array.isArray(value) ? value.length : String(value).length)) return [[field.id, 'Choose an option.']];
    return [];
  }));
  return {
    definition,
    get signal() { return lifetime.signal; },
    values: () => structuredClone(values),
    optionsFor: (id: string) => structuredClone(available.get(id) ?? []),
    set(id: string, value: string | boolean | string[]): void {
      if (lifetime.signal.aborted) return;
      const field = definition.fields.find(field => field.id === id);
      if (!field) throw new Error('Unknown field.');
      const options = available.get(id) ?? [];
      if (isTextField(field) && (typeof value !== 'string' || value.length > TEXT_LIMIT) || field.kind === 'switch' && typeof value !== 'boolean' || field.kind === 'select' && (field.multiple ? !Array.isArray(value) || value.length > primitiveLimit('field', 'options') || value.some(v => typeof v !== 'string' || !options.some(option => option.value === v && !option.disabled)) || new Set(value).size !== value.length : typeof value !== 'string' || !options.some(option => option.value === value && !option.disabled))) throw new Error('Invalid field value.');
      values[id] = structuredClone(value);
    },
    async options(id: string, query: string): Promise<SelectOption[] | undefined> {
      if (lifetime.signal.aborted) return;
      const field = definition.fields.find(field => field.id === id);
      if (!field || field.kind !== 'select') throw new Error('Unknown select.');
      requests.get(id)?.abort();
      const request = new AbortController(); requests.set(id, request);
      try {
        const response = await callbacks.options(structuredClone(field), query.slice(0, primitiveLimit('field', 'query')), structuredClone(invocation), request.signal);
        if (request.signal.aborted || lifetime.signal.aborted || requests.get(id) !== request) return;
        const result = validateContract('selectOptions', response);
        if (!result.ok) throw new Error('Invalid option response.');
        const options = result.value as unknown as SelectOption[];
        const value = values[id], selected = Array.isArray(value) ? value : [value];
        available.set(id, [...options, ...(available.get(id) ?? []).filter(option => selected.includes(option.value) && !options.some(current => current.value === option.value))]);
        return options;
      } catch (error) {
        if (!request.signal.aborted && !lifetime.signal.aborted && requests.get(id) === request) throw error;
      }
    },
    async validate(): Promise<Record<string, string> | undefined> {
      if (lifetime.signal.aborted) return;
      const local = errors();
      if (Object.keys(local).length) return local;
      let response: Record<string, string>;
      try { response = await callbacks.validate(structuredClone(values), structuredClone(invocation), lifetime.signal); }
      catch (error) { if (lifetime.signal.aborted) return; throw error; }
      if (lifetime.signal.aborted) return;
      if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length > 24 || Object.entries(response).some(([id, message]) => !definition.fields.some(field => field.id === id) || typeof message !== 'string' || !message.length || message.length > 256)) throw new Error('Invalid validation response.');
      return structuredClone(response);
    },
    cancelOptions(id: string) { requests.get(id)?.abort(); requests.delete(id); },
    dispose() { lifetime.abort(); requests.forEach(request => request.abort()); requests.clear(); },
  };
}
