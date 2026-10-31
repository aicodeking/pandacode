// MCP elicitation forms: the same flat JSON Schema subset and checks as the desktop
// (renderSchema/validate in src/agent-input.ts). Pure, so tests run in node.

export type Field =
  | { kind: 'text'; name: string; title: string; description: string; required: boolean; schema: Prop }
  | { kind: 'number'; name: string; title: string; description: string; required: boolean; schema: Prop }
  | { kind: 'boolean'; name: string; title: string; description: string; required: boolean; schema: Prop }
  | { kind: 'enum'; name: string; title: string; description: string; required: boolean; schema: Prop; options: { value: unknown; label: string }[] }
  | { kind: 'multi'; name: string; title: string; description: string; required: boolean; schema: Prop; options: { value: string; label: string }[] };

export interface Prop {
  type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; enumNames?: unknown[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; format?: string;
  items?: { type?: string; enum?: unknown[]; enumNames?: unknown[] }; minItems?: number; maxItems?: number;
}

export const UNSUPPORTED = 'This form format is not supported here. Cancel to let the agent continue.';
const TOP = new Set(['type', 'properties', 'required', 'title', 'description', 'additionalProperties', '$schema', '$id']);
const KEYS = new Set(['type', 'title', 'description', 'default', 'enum', 'enumNames', 'minimum', 'maximum', 'minLength', 'maxLength', 'format', 'items', 'minItems', 'maxItems', 'uniqueItems']);
const FORMATS = ['email', 'uri', 'date', 'date-time', 'password'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (names: unknown[] | undefined, i: number, value: unknown) => (typeof names?.[i] === 'string' && names[i] ? String(names[i]) : String(value));

/** Fields for a schema, or throws UNSUPPORTED. */
export function parseSchema(raw: unknown): Field[] {
  if (!object(raw) || raw.type !== 'object' || !object(raw.properties) || Object.keys(raw.properties).length > 30) throw new Error(UNSUPPORTED);
  if (Object.keys(raw).some(k => !TOP.has(k))) throw new Error(UNSUPPORTED);
  const properties = raw.properties;
  if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.some(n => typeof n !== 'string' || !Object.hasOwn(properties, n)))) throw new Error(UNSUPPORTED);
  const required = new Set(Array.isArray(raw.required) ? raw.required : []);
  return Object.entries(properties).map(([name, value]): Field => {
    if (!object(value) || Object.keys(value).some(k => !KEYS.has(k))) throw new Error(UNSUPPORTED);
    const schema = value as Prop;
    const base = { name, title: typeof schema.title === 'string' && schema.title ? schema.title : name, description: typeof schema.description === 'string' ? schema.description : '', required: required.has(name), schema };
    if (schema.type === 'array') {
      const items = schema.items;
      if (!object(items) || items.type !== 'string' || !Array.isArray(items.enum) || !items.enum.length || items.enum.length > 30
        || items.enum.some(v => typeof v !== 'string') || new Set(items.enum).size !== items.enum.length || Object.keys(items).some(k => !['type', 'enum', 'enumNames'].includes(k))) throw new Error(UNSUPPORTED);
      return { ...base, kind: 'multi', options: (items.enum as string[]).map((v, i) => ({ value: v, label: label(items.enumNames, i, v) })) };
    }
    if (!['string', 'number', 'integer', 'boolean'].includes(String(schema.type))) throw new Error(UNSUPPORTED);
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.length || schema.enum.length > 50 || schema.enum.some(v => v === null || !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(UNSUPPORTED);
      return { ...base, kind: 'enum', options: schema.enum.map((v, i) => ({ value: v, label: label(schema.enumNames, i, v) })) };
    }
    if (schema.type === 'string' && schema.format && !FORMATS.includes(schema.format)) throw new Error(UNSUPPORTED);
    return { ...base, kind: schema.type === 'boolean' ? 'boolean' : schema.type === 'string' ? 'text' : 'number' };
  });
}

/** A field's starting value as the input holds it (text for text/number, index string for enums). */
export function initial(field: Field): unknown {
  const d = field.schema.default;
  if (field.kind === 'boolean') return d === true;
  if (field.kind === 'multi') return Array.isArray(d) ? d.filter(v => field.options.some(o => o.value === v)) : [];
  if (field.kind === 'enum') { const i = field.options.findIndex(o => o.value === d); return i >= 0 ? String(i) : ''; }
  return typeof d === 'string' || typeof d === 'number' ? String(d) : '';
}

/** Validates what the user entered; returns the content to send or throws a user-facing error. */
export function readForm(fields: Field[], input: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = read(field, input[field.name] ?? initial(field));
    if (value !== undefined) content[field.name] = value;
  }
  return content;
}

function read(field: Field, raw: unknown): unknown {
  const { schema, title, required } = field;
  const invalid = () => new Error(`Enter a valid value for “${title}”.`);
  if (field.kind === 'boolean') return raw === true;
  if (field.kind === 'multi') {
    const list = [...new Set(Array.isArray(raw) ? raw.map(String) : [])];
    if ((typeof schema.minItems === 'number' && list.length < schema.minItems) || (typeof schema.maxItems === 'number' && list.length > schema.maxItems)) throw new Error(`Choose the requested number of options for “${title}”.`);
    return !required && !list.length ? undefined : list;
  }
  if (field.kind === 'enum') {
    if (raw === '' || raw === undefined) { if (required) throw new Error(`Choose a value for “${title}”.`); return undefined; }
    const option = field.options[Number(raw)];
    if (!option) throw invalid();
    return option.value;
  }
  const text = typeof raw === 'string' ? raw : '';
  if (!text) { if (required) throw new Error(`Fill in “${title}”.`); return undefined; }
  if (field.kind === 'number') {
    const n = Number(text.trim());
    if (!text.trim() || !Number.isFinite(n) || (schema.type === 'integer' && !Number.isInteger(n))) throw invalid();
    if ((typeof schema.minimum === 'number' && n < schema.minimum) || (typeof schema.maximum === 'number' && n > schema.maximum)) throw new Error(`“${title}” must be ${range(schema)}.`);
    return n;
  }
  const length = [...text].length;
  if ((typeof schema.minLength === 'number' && length < schema.minLength) || (typeof schema.maxLength === 'number' && length > schema.maxLength)) throw invalid();
  if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) throw invalid();
  if (schema.format === 'uri') { try { new URL(text); } catch { throw invalid(); } }
  if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)))) throw invalid();
  if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d\d:\d\d)$/i.test(text) || !Number.isFinite(Date.parse(text)))) throw invalid();
  return text;
}

export function range(schema: Prop): string {
  const { minimum: lo, maximum: hi } = schema;
  if (typeof lo === 'number' && typeof hi === 'number') return `between ${lo} and ${hi}`;
  if (typeof lo === 'number') return `at least ${lo}`;
  if (typeof hi === 'number') return `at most ${hi}`;
  return 'a number';
}
