import './agent-input.css';
import { call } from './bridge';
import { richMarkdown, type RichContext } from './rich-markdown';
import type { AgentInputResponse, AgentQuestion } from './types';

export interface AgentInput { element: HTMLFormElement; dispose(): void; }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
let nextControlId = 0;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className; result.textContent = content; return result;
}

/** One retained form per request; answers stay local and are never written to storage. */
export function createAgentInput(sessionId: string, requestId: string, data: unknown, resolved: () => void, remote = false): AgentInput {
  const request = object(data) ? data : {};
  const element = node('form', 'agent-input');
  element.dataset.requestId = requestId;
  element.setAttribute('aria-label', request.kind === 'questions' ? 'Agent questions' : 'Integration request');
  const heading = node('h3', '', request.kind === 'questions' ? 'A quick question' : 'Input needed');
  element.append(heading);
  const fields = node('fieldset', 'agent-input-fields');
  element.append(fields);
  const error = node('p', 'agent-input-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = node('div', 'agent-input-actions');
  const cancel = node('button', 'secondary-button', 'Cancel'); cancel.type = 'button';
  const submit = node('button', 'primary-button', request.kind === 'url' ? 'Continue' : 'Submit answers'); submit.type = 'submit';
  const decline = node('button', 'secondary-button', 'Decline'); decline.type = 'button';
  actions.append(cancel); if (request.kind !== 'questions') actions.append(decline); actions.append(submit);
  element.append(error, actions);
  let disposed = false, pending = false;
  let response: () => AgentInputResponse;
  const fail = (message: string) => { error.textContent = message; error.hidden = false; };
  // Questions may carry Markdown, images from this task's workspace, charts and HTML views.
  const richContext: RichContext = { image: path => call<string>(remote ? 'remote_workspace_image' : 'workspace_image', { sessionId, path }) };

  try {
    if (request.kind === 'questions') {
      if (!Array.isArray(request.questions) || !request.questions.length || request.questions.length > 20) throw new Error('This question format is not supported. Cancel to let the agent continue.');
      const ids = new Set<string>();
      const readers = request.questions.map(raw => {
        if (!object(raw) || !text(raw.id) || !text(raw.question) || ids.has(raw.id as string)) throw new Error('This question format is not supported. Cancel to let the agent continue.');
        ids.add(raw.id as string);
        return { id: raw.id as string, read: renderQuestion(fields, raw as unknown as AgentQuestion, richContext) };
      });
      response = () => ({ answers: Object.fromEntries(readers.map(reader => [reader.id, reader.read()])) });
    } else if (request.kind === 'form') {
      if (text(request.message)) fields.append(node('p', 'agent-input-message', text(request.message)));
      const readers = renderSchema(fields, request.schema);
      response = () => ({ action: 'accept', content: Object.fromEntries(readers.flatMap(reader => {
        const value = reader.read(); return value === undefined ? [] : [[reader.name, value]];
      })) });
    } else if (request.kind === 'url') {
      const url = new URL(text(request.url));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('This request does not contain a supported web address.');
      fields.append(node('p', 'agent-input-message', text(request.message) || 'Complete the requested step in your browser, then continue.'));
      fields.append(node('p', 'agent-input-url', url.origin));
      const open = node('button', 'secondary-button', 'Open in browser'); open.type = 'button';
      open.title = url.href;
      open.addEventListener('click', async () => {
        open.disabled = true;
        try { await call('open_external_url', { url: url.href }); }
        catch (cause) { if (!disposed) fail(cause instanceof Error ? cause.message : String(cause)); }
        finally { if (!disposed && !pending) open.disabled = false; }
      });
      fields.append(open);
      response = () => ({ action: 'accept', content: null });
    } else throw new Error('This input format is not supported. Cancel to let the agent continue.');
  } catch (cause) {
    fields.replaceChildren(); submit.hidden = true; decline.hidden = true;
    fail(cause instanceof Error ? cause.message : String(cause));
    response = () => { throw new Error('This input format is not supported.'); };
  }

  async function send(value: AgentInputResponse): Promise<void> {
    if (disposed || pending) return;
    pending = true; fields.disabled = true;
    actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
    error.hidden = true; submit.textContent = 'Sending…';
    try {
      await call('respond_user_input', { sessionId, requestId, response: value });
      if (!disposed) resolved();
    } catch (cause) {
      if (!disposed) fail(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending = false;
      if (!disposed) {
        fields.disabled = false; actions.querySelectorAll('button').forEach(button => { button.disabled = false; });
        submit.textContent = request.kind === 'url' ? 'Continue' : 'Submit answers';
      }
    }
  }
  element.addEventListener('submit', event => {
    event.preventDefault(); event.stopPropagation();
    if (disposed || pending || submit.hidden) return;
    try { if (element.reportValidity()) void send(response()); }
    catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
  });
  cancel.addEventListener('click', () => { void send(request.kind === 'questions' ? { answers: {} } : { action: 'cancel', content: null }); });
  decline.addEventListener('click', () => { void send({ action: 'decline', content: null }); });
  return { element, dispose() {
    disposed = true;
    element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea').forEach(input => { input.value = ''; });
    element.remove();
  } };
}

/** Renders Markdown into `target`, keeping the plain text if rendering fails. */
function rich(target: HTMLElement, source: string, context: RichContext): void {
  target.textContent = source;
  void richMarkdown(target, source, context).catch(() => { target.textContent = source; });
}

function renderQuestion(host: HTMLElement, question: AgentQuestion, context: RichContext): () => string[] {
  const group = node('fieldset', 'agent-input-question');
  const legend = node('legend'); group.append(legend);
  const body = node('div', 'agent-input-question-text'); rich(body, question.question, context); legend.append(body);
  if (question.header) { const header = node('span', 'agent-input-header'); rich(header, question.header, context); legend.prepend(header); }
  host.append(group);
  const name = `agent-question-${++nextControlId}`;
  const choices: HTMLInputElement[] = [];
  const options = Array.isArray(question.options) && !question.isSecret ? question.options : [];
  if (options.length > 30) throw new Error('This question has too many options to display.');
  for (const option of options) {
    if (!object(option) || !text(option.label)) throw new Error('This question contains an unsupported option.');
    const label = node('label', 'agent-input-option');
    const input = node('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = name; input.value = option.label;
    choices.push(input);
    const copy = node('span');
    const title = node('strong'); rich(title, option.label, context); copy.append(title);
    if (option.description) { const detail = node('small'); rich(detail, option.description, context); copy.append(detail); }
    label.append(input, copy); group.append(label);
  }
  let custom: HTMLInputElement | undefined, other: HTMLInputElement | undefined;
  if (!choices.length || question.isOther !== false) {
    const label = node('label', 'agent-input-custom');
    label.append(node('span', '', choices.length ? 'Other answer' : question.isSecret ? 'Private answer' : 'Your answer'));
    custom = node('input'); custom.type = question.isSecret ? 'password' : 'text'; custom.autocomplete = 'off'; custom.spellcheck = !question.isSecret; custom.maxLength = 8192;
    custom.setAttribute('aria-label', question.header || question.question);
    if (choices.length) {
      other = node('input'); other.type = question.multiSelect ? 'checkbox' : 'radio'; other.name = name; other.setAttribute('aria-label', 'Use other answer');
      label.prepend(other); custom.addEventListener('input', () => { other!.checked = Boolean(custom!.value); });
    } else custom.required = true;
    label.append(custom); group.append(label);
  }
  return () => {
    const values = choices.filter(input => input.checked).map(input => input.value);
    if (custom && (!choices.length || other?.checked) && custom.value.trim()) values.push(custom.value);
    if (!values.length) { (custom ?? choices[0])?.focus(); throw new Error(`Answer “${question.header || question.question}” before continuing.`); }
    return values;
  };
}

type FieldReader = { name: string; read(): unknown };
function renderSchema(host: HTMLElement, raw: unknown): FieldReader[] {
  const unsupported = () => new Error('This integration asks for a form format that PandaCode cannot display yet. Cancel this request to continue.');
  if (!object(raw) || raw.type !== 'object' || !object(raw.properties) || Object.keys(raw.properties).length > 30) throw unsupported();
  const topKeys = new Set(['type', 'properties', 'required', 'title', 'description', 'additionalProperties', '$schema', '$id']);
  if (Object.keys(raw).some(key => !topKeys.has(key))) throw unsupported();
  if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.some(name => typeof name !== 'string' || !Object.hasOwn(raw.properties as object, name)))) throw unsupported();
  const required = new Set(Array.isArray(raw.required) ? raw.required : []);
  const keys = new Set(['type', 'title', 'description', 'default', 'enum', 'enumNames', 'minimum', 'maximum', 'minLength', 'maxLength', 'format', 'items', 'minItems', 'maxItems', 'uniqueItems']);
  return Object.entries(raw.properties).map(([name, schema]) => {
    if (!object(schema) || Object.keys(schema).some(key => !keys.has(key))) throw unsupported();
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(text(schema.type))) throw unsupported();
    const isRequired = required.has(name), title = text(schema.title) || name;
    const field = node('label', 'agent-input-field');
    field.append(node('span', '', title + (isRequired ? '' : ' (optional)')));
    if (text(schema.description)) field.append(node('small', '', text(schema.description)));
    host.append(field);
    if (schema.type === 'array') {
      if (!object(schema.items) || schema.items.type !== 'string' || !Array.isArray(schema.items.enum) || schema.items.enum.some(value => typeof value !== 'string') || schema.items.enum.length > 30 || new Set(schema.items.enum).size !== schema.items.enum.length || Object.keys(schema.items).some(key => !['type', 'enum', 'enumNames'].includes(key))) throw unsupported();
      const group = node('div', 'agent-input-options'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', title);
      field.replaceWith(node('div', 'agent-input-field')); const wrapper = host.lastElementChild!; wrapper.append(...field.childNodes, group);
      const choices = schema.items.enum.map((value, index) => {
        const label = node('label', 'agent-input-option'), input = node('input'); input.type = 'checkbox'; input.value = value;
        input.checked = Array.isArray(schema.default) && schema.default.includes(value);
        const labels = object(schema.items) && Array.isArray(schema.items.enumNames) ? schema.items.enumNames : [];
        label.append(input, node('span', '', text(labels[index]) || value)); group.append(label); return input;
      });
      return { name, read() {
        const value = choices.filter(input => input.checked).map(input => input.value);
        if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`Choose the requested number of options for “${title}”.`);
        return !isRequired && !value.length ? undefined : [...new Set(value)];
      } };
    }
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.length || schema.enum.length > 50 || schema.enum.some(value => value === null || !['string', 'number', 'boolean'].includes(typeof value))) throw unsupported();
      const select = node('select'); select.required = isRequired; select.setAttribute('aria-label', title);
      select.append(new Option('Choose…', ''));
      schema.enum.forEach((value, index) => select.append(new Option(Array.isArray(schema.enumNames) ? text(schema.enumNames[index]) || String(value) : String(value), String(index))));
      const defaultIndex = schema.enum.indexOf(schema.default); if (defaultIndex >= 0) select.value = String(defaultIndex);
      field.append(select);
      return { name, read: () => select.value === '' ? undefined : validate((schema.enum as unknown[])[Number(select.value)], schema, title) };
    }
    const input = node('input'); input.setAttribute('aria-label', title); input.autocomplete = 'off';
    input.type = schema.type === 'boolean' ? 'checkbox' : schema.type === 'string' ? 'text' : 'number';
    if (schema.type === 'string') {
      const format = text(schema.format);
      if (format && !['email', 'uri', 'date', 'date-time', 'password'].includes(format)) throw unsupported();
      input.type = ({ email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local', password: 'password' } as Record<string, string>)[format] || 'text';
      if (typeof schema.minLength === 'number') input.minLength = schema.minLength;
      input.maxLength = typeof schema.maxLength === 'number' ? Math.min(8192, schema.maxLength) : 8192;
    } else if (schema.type !== 'boolean') {
      input.step = schema.type === 'integer' ? '1' : 'any';
      if (typeof schema.minimum === 'number') input.min = String(schema.minimum);
      if (typeof schema.maximum === 'number') input.max = String(schema.maximum);
    }
    input.required = isRequired && schema.type !== 'boolean';
    if (schema.type === 'boolean') input.checked = schema.default === true;
    else if (['string', 'number'].includes(typeof schema.default)) input.value = String(schema.default);
    field.append(input);
    return { name, read() {
      if (schema.type === 'boolean') return input.checked;
      if (!input.value && !isRequired) return undefined;
      const value = schema.format === 'date-time' ? new Date(input.value).toISOString() : schema.type === 'string' ? input.value : input.valueAsNumber;
      return validate(value, schema, title);
    } };
  });
}

function validate(value: unknown, schema: ObjectValue, title: string): unknown {
  const invalid = () => { throw new Error(`Enter a valid value for “${title}”.`); };
  if (schema.type === 'string') {
    if (typeof value !== 'string') return invalid();
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength || typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) return invalid();
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(value)) return invalid();
    if (schema.format === 'uri') { try { new URL(value); } catch { return invalid(); } }
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))) return invalid();
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value)))) return invalid();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) return invalid();
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) return invalid();
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') return invalid();
  return value;
}
