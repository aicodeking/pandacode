/** Namespace-scoped persistent form values. No core preference keys or storage handles. */
import { isTextField, TEXT_LIMIT, type DialogField, type DialogValues } from './dialog-state.ts';
import { primitiveLimit } from './contracts.ts';
/** `section` places the fields as an owner-labelled group in an eligible core page instead of a page of their own. */
export type SettingsPageDefinition = { id: string; title: string; section?: string; fields: DialogField[] };
export type Keybinding = { id: string; command: string; key: string };

export function settingsDefaults(page: SettingsPageDefinition): DialogValues {
  return Object.fromEntries(page.fields.map(field => [field.id, field.kind === 'select' ? field.multiple ? [] : '' : field.value ?? (field.kind === 'switch' ? false : '')]));
}
/** Revalidated by the native boundary before persistence; unknown fields never reach storage. */
export function validSettingsValues(page: SettingsPageDefinition, input: unknown): input is DialogValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const values = input as DialogValues;
  return Object.keys(values).length === page.fields.length && page.fields.every(field => {
    if (!Object.hasOwn(values, field.id)) return false;
    const value = values[field.id];
    if (isTextField(field)) return typeof value === 'string' && value.length <= TEXT_LIMIT && value.length >= (field.minLength ?? 0) && (!field.required || !!value.trim());
    if (field.kind === 'switch') return typeof value === 'boolean';
    const allowed = (value: unknown) => typeof value === 'string' && field.options.some(option => option.value === value && !option.disabled);
    return field.multiple ? Array.isArray(value) && value.length <= primitiveLimit('field', 'options') && new Set(value).size === value.length && (!field.required || value.length > 0) && value.every(allowed) : typeof value === 'string' && (!value && !field.required || allowed(value));
  });
}
