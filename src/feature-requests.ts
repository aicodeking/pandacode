import { escape, icon, isImeKey } from './dom.ts';

/* Feature request cards: an agent that notices a missing feature leaves a card above the prompt. The user sends it as a
 * GitHub issue draft (the text travels in the link the browser opens; it is an issue only once they submit it there),
 * turns it into a task, edits it, or hides it. */

export type FeatureRequest = { id: string; sessionId: string; title: string; description: string; createdAt: number };

export const TITLE_LIMIT = 120;
export const DESCRIPTION_LIMIT = 4000;
/** Longest URL sent to the browser; GitHub and browsers refuse much more. */
export const FEATURE_REQUEST_URL_LIMIT = 7000;
const ISSUE_BASE = 'https://github.com/aicodeking/pandacode/issues/new?template=feature_request.yml';
const SENT = 'Opened a draft on GitHub with this text. It becomes an issue when you submit it there.';
const SENT_SHORTENED = 'Opened a draft on GitHub with a shortened description. It becomes an issue when you submit it there.';
const NO_PROJECT = 'Open a project to create a task.';

const draftUrl = (title: string, problem: string): string =>
  `${ISSUE_BASE}&title=${encodeURIComponent(title)}&problem=${encodeURIComponent(problem)}&proposal=`;

/** The GitHub issue draft for a request; a description too long for the URL is cut at a whole character and ends in an ellipsis. */
export function issueDraft(title: string, description: string): { url: string; shortened: boolean } {
  const head = title.trim(), body = description.trim();
  const full = draftUrl(head, body);
  if (full.length <= FEATURE_REQUEST_URL_LIMIT) return { url: full, shortened: false };
  const chars = Array.from(body);
  const cut = (length: number) => `${chars.slice(0, length).join('').trimEnd()}…`;
  let low = 0, high = chars.length;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (draftUrl(head, cut(middle)).length <= FEATURE_REQUEST_URL_LIMIT) low = middle; else high = middle - 1;
  }
  return { url: draftUrl(head, cut(low)), shortened: true };
}

export const issueUrl = (title: string, description: string): string => issueDraft(title, description).url;

/** What is missing from a request, or '' when it can be sent. */
export function requestProblem(title: string, description: string, missingBody = 'Add a description'): string {
  if (!title.trim()) return 'Add a title';
  return description.trim() ? '' : missingBody;
}

export type FeatureRequestsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls back when requests change (any thread, or the switch). */
  listen(callback: (event: { sessionId?: string } | null) => void): Promise<() => void>;
  sessionId(): string;
  canCreateTask(): boolean;
  /** A task in the open task's project with the same agent and model. */
  createTask(title: string, description: string): Promise<{ id: string; project: string }>;
  openTask(id: string): void;
  openUrl(url: string): Promise<unknown>;
  openSettings(): void;
  notify(text: string, actions?: { label: string; run: () => void }[]): void;
  copy(text: string): Promise<void>;
  focusComposer(): void;
  settle(element: HTMLElement): void;
  dialog: { open(title: string, body: string): HTMLElement; close(): void };
};

export type FeatureRequestsView = {
  /** The cards' host: the composer area keeps it across its redraws. */
  element: HTMLElement;
  /** The composer was redrawn or the thread changed. */
  sync(): void;
  feedback(): void;
  dispose(): void;
};

type Edit = { title: string; description: string };
type Field = 'title' | 'description';

export function mountFeatureRequests(host: FeatureRequestsHost): FeatureRequestsView {
  const element = document.createElement('div');
  element.id = 'feature-requests';
  element.innerHTML = '<div class="fr-body"></div><div class="sr-only fr-live" role="status" aria-live="polite"></div>';
  const body = element.querySelector<HTMLElement>('.fr-body')!, live = element.querySelector<HTMLElement>('.fr-live')!;

  let enabled = true, loadedFor = '', requested = '\0', items: FeatureRequest[] = [];
  let shownId = '', listOpen = false, editing: Edit | null = null;
  let busy = false, error = '', invalid: Field | null = null, enter = false, loads = 0, disposed = false;
  let feedbackDraft: Edit = { title: '', description: '' };
  let unlisten: (() => void) | undefined;

  const shown = (): FeatureRequest | undefined => items.find(item => item.id === shownId);
  const hasProject = (): boolean => host.canCreateTask();
  const reset = (): void => { listOpen = false; editing = null; busy = false; error = ''; invalid = null; };

  function apply(sessionId: string, on: boolean, next: FeatureRequest[]): void {
    const sameThread = loadedFor === sessionId;
    const known = new Set(items.map(item => item.id));
    const sorted = [...next].sort((a, b) => a.createdAt - b.createdAt);
    if (!sameThread) reset();
    loadedFor = sessionId; enabled = on; items = sorted;
    const arrivals = sameThread ? sorted.filter(item => !known.has(item.id)) : [];
    if (!sorted.some(item => item.id === shownId)) { shownId = sorted[0]?.id ?? ''; if (sameThread) reset(); }
    enter = on && arrivals.some(item => item.id === shownId);
    if (on && arrivals.length) {
      const [first] = arrivals;
      live.textContent = arrivals.some(item => item.id === shownId)
        ? `The agent suggested a feature request: ${first.title}.`
        : `Another feature request is waiting: ${first.title}.`;
    }
    render();
  }

  async function load(): Promise<void> {
    const sessionId = host.sessionId(), token = ++loads;
    try {
      const [on, list] = await Promise.all([
        host.call<boolean>('feature_requests_enabled'),
        sessionId ? host.call<FeatureRequest[]>('feature_requests_list', { sessionId }) : Promise.resolve([]),
      ]);
      if (disposed || token !== loads || sessionId !== host.sessionId()) return;
      apply(sessionId, on, list);
    } catch {
      // The cards stay as they were; the next event or thread switch asks again.
    }
  }

  const count = (value: string, limit: number, from: number): string => value.length >= from ? `${value.length}/${limit}` : '';

  function cardHtml(item: FeatureRequest): string {
    const titleId = `fr-title-${item.id}`;
    const edit = editing;
    const alert = (field: Field) => invalid === field ? `<p class="fr-field-error" id="fr-error-${field}">${field === 'title' ? 'Add a title' : 'Add a description'}</p>` : '';
    const content = edit
      ? `<input class="fr-input" data-fr="title" data-fr-field="title" id="${titleId}" value="${escape(edit.title)}" maxlength="${TITLE_LIMIT}" aria-label="Title" ${invalid === 'title' ? `aria-invalid="true" aria-describedby="fr-error-title"` : ''} autocomplete="off" spellcheck="true">
        <span class="fr-count" data-fr-count="title" ${count(edit.title, TITLE_LIMIT, 100) ? '' : 'hidden'}>${count(edit.title, TITLE_LIMIT, 100)}</span>${alert('title')}
        <textarea class="fr-input fr-area" data-fr="description" data-fr-field="description" rows="${rowsFor(edit.description)}" maxlength="${DESCRIPTION_LIMIT}" aria-label="Description" ${invalid === 'description' ? `aria-invalid="true" aria-describedby="fr-error-description"` : ''} spellcheck="true">${escape(edit.description)}</textarea>
        <span class="fr-count" data-fr-count="description" ${count(edit.description, DESCRIPTION_LIMIT, 3600) ? '' : 'hidden'}>${count(edit.description, DESCRIPTION_LIMIT, 3600)}</span>${alert('description')}`
      : `<h3 class="fr-title" id="${titleId}" tabindex="-1" data-fr="title">${escape(item.title)}</h3>
        <p class="fr-text" tabindex="0">${escape(item.description)}</p>`;
    const off = busy ? 'disabled' : '';
    const noProject = !hasProject();
    return `<article class="fr-card" aria-labelledby="${titleId}" aria-busy="${busy}" data-request="${escape(item.id)}">
      <div class="fr-eyebrow">${icon('chat', 'fr-mark')}<span>Suggested feature request</span></div>
      ${content}
      <p class="fr-hint">Send request opens a draft on GitHub in your browser, with this text in the link. It becomes an issue only when you submit it there.</p>
      <div class="fr-actions">
        <span class="fr-group"><button type="button" class="fr-ghost" data-fr="edit" data-fr-action="edit" ${off}>${edit ? 'Done' : 'Edit'}</button><button type="button" class="fr-ghost fr-trash" data-fr="trash" data-fr-action="trash" aria-label="Don't show feature requests again" title="Don't show feature requests again" ${off}>${icon('trash')}</button></span>
        <span class="fr-group fr-group-main"><button type="button" class="fr-raised" data-fr="do" data-fr-action="do" ${noProject ? `aria-disabled="true" aria-describedby="fr-no-project" title="${NO_PROJECT}"` : ''} ${off}>${busy ? '<span class="support-spinner" aria-hidden="true"></span>Creating…' : 'Do it myself'}</button><button type="button" class="fr-send" data-fr="send" data-fr-action="send" ${off}>Send request${icon('external')}</button></span>
      </div>
      ${noProject ? `<span class="sr-only" id="fr-no-project">${NO_PROJECT}</span>` : ''}
      ${error ? `<p class="fr-error" role="alert">${escape(error)}</p>` : ''}
    </article>`;
  }

  function rowsFor(value: string): number {
    return Math.min(8, Math.max(4, value.split('\n').length + Math.floor(value.length / 70)));
  }

  function moreHtml(): string {
    const rest = items.filter(item => item.id !== shownId);
    if (!rest.length) return '';
    const label = `${rest.length} more feature request${rest.length === 1 ? '' : 's'}`;
    return `<div class="fr-queue"><button type="button" class="fr-queue-toggle" data-fr="queue" data-fr-action="queue" aria-expanded="${listOpen}">${icon('chevron', 'fr-chevron')}<span>${label}</span></button>
      ${listOpen ? `<ul class="fr-queue-list">${rest.map(item => `<li><button type="button" data-fr="row:${escape(item.id)}" data-fr-action="pick" data-request="${escape(item.id)}" title="${escape(item.title)}">${escape(item.title)}</button></li>`).join('')}</ul>` : ''}</div>`;
  }

  function currentFocus(): { key: string; start: number | null; end: number | null } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !body.contains(active)) return null;
    const key = active.closest<HTMLElement>('[data-fr]')?.dataset.fr;
    if (!key) return null;
    const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    return { key, start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null };
  }

  function render(): void {
    const item = shown();
    if (!enabled || !item) { body.replaceChildren(); return; }
    const focus = currentFocus();
    body.innerHTML = `<section class="fr-region" role="region" aria-label="${items.length === 1 ? 'Feature request suggestion' : `${items.length} feature request suggestions`}">${cardHtml(item)}${moreHtml()}</section>`;
    if (focus) {
      const target = [...body.querySelectorAll<HTMLElement>('[data-fr]')].find(node => node.dataset.fr === focus.key);
      if (target) {
        target.focus({ preventScroll: true });
        if (focus.start !== null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) target.setSelectionRange(focus.start, focus.end ?? focus.start);
      }
    }
    if (enter) { enter = false; const card = body.querySelector<HTMLElement>('.fr-card'); if (card) host.settle(card); }
  }

  function focusField(field: Field): void {
    body.querySelector<HTMLElement>(`[data-fr-field="${field}"]`)?.focus({ preventScroll: true });
  }

  /** The text to act on; an edit is checked and saved first. Null leaves the card as it is, with the reason on it. */
  async function commit(item: FeatureRequest): Promise<{ title: string; description: string } | null> {
    if (!editing) return { title: item.title, description: item.description };
    const { title, description } = editing;
    const missing = requestProblem(title, description);
    if (missing) { invalid = title.trim() ? 'description' : 'title'; error = ''; busy = false; render(); focusField(invalid); return null; }
    const next = { title: title.trim(), description: description.trim() };
    if (next.title === item.title && next.description === item.description) return next;
    try {
      const saved = await host.call<FeatureRequest>('feature_request_update', { id: item.id, ...next });
      items = items.map(entry => entry.id === item.id ? saved : entry);
      return next;
    } catch {
      error = 'Couldn’t save your edit. Try again.'; busy = false; render();
      return null;
    }
  }

  async function remove(id: string): Promise<boolean> {
    try { await host.call('feature_request_dismiss', { id }); }
    catch { error = 'Couldn’t hide this card. Try again.'; render(); return false; }
    items = items.filter(item => item.id !== id);
    reset();
    if (shownId === id) shownId = items[0]?.id ?? '';
    render();
    host.focusComposer();
    return true;
  }

  async function send(): Promise<void> {
    const item = shown();
    if (!item || busy) return;
    busy = true; error = '';
    try {
      const content = await commit(item);
      if (!content) return;
      const draft = issueDraft(content.title, content.description);
      try { await host.openUrl(draft.url); }
      catch {
        host.notify('Couldn’t open your browser.', [{ label: 'Copy text', run: () => { void host.copy(`${content.title}\n\n${content.description}`).then(() => host.notify('Copied.')); } }]);
        return;
      }
      host.notify(draft.shortened ? SENT_SHORTENED : SENT);
      await remove(item.id);
    } finally { busy = false; }
  }

  async function doItMyself(): Promise<void> {
    const item = shown();
    if (!item || busy || !hasProject()) return;
    busy = true; error = '';
    try {
      const content = await commit(item);
      if (!content) return;
      render();
      try {
        const task = await host.createTask(content.title, content.description);
        busy = false;
        host.notify(`Task created in ${task.project}`, [{ label: 'Open', run: () => host.openTask(task.id) }]);
        await remove(item.id);
      } catch (failure) {
        busy = false;
        const reason = failure instanceof Error ? failure.message : String(failure);
        error = `Couldn’t create the task: ${reason.replace(/\.$/, '')}. Try again, or use Send request.`;
        render();
        body.querySelector<HTMLElement>('[data-fr="do"]')?.focus({ preventScroll: true });
      }
    } finally { busy = false; }
  }

  async function switchOff(): Promise<void> {
    const item = shown();
    if (!item || busy) return;
    error = '';
    try {
      await host.call('feature_request_dismiss', { id: item.id });
      await host.call('feature_requests_set_enabled', { enabled: false });
    } catch { error = 'Couldn’t turn off feature request cards. Try again.'; render(); return; }
    enabled = false; items = items.filter(entry => entry.id !== item.id); reset(); render();
    host.focusComposer();
    host.notify('Feature request cards turned off', [
      { label: 'Turn on', run: () => { void host.call('feature_requests_set_enabled', { enabled: true }).then(load, () => host.notify('Couldn’t turn feature request cards on.')); } },
      { label: 'Settings', run: host.openSettings },
    ]);
  }

  async function toggleEdit(): Promise<void> {
    const item = shown();
    if (!item || busy) return;
    error = '';
    if (!editing) { editing = { title: item.title, description: item.description }; invalid = null; render(); focusField('title'); return; }
    const content = await commit(item);
    if (!content) return;
    editing = null; invalid = null; render();
    body.querySelector<HTMLElement>('[data-fr="edit"]')?.focus({ preventScroll: true });
  }

  function cancelEdit(): void {
    editing = null; invalid = null; error = ''; render();
    body.querySelector<HTMLElement>('[data-fr="edit"]')?.focus({ preventScroll: true });
  }

  element.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fr-action]') : null;
    if (!target || !body.contains(target)) return;
    switch (target.dataset.frAction) {
      case 'edit': void toggleEdit(); break;
      case 'trash': void switchOff(); break;
      case 'do': if (target.getAttribute('aria-disabled') !== 'true') void doItMyself(); break;
      case 'send': void send(); break;
      case 'queue': listOpen = !listOpen; render(); break;
      case 'pick': shownId = target.dataset.request ?? shownId; reset(); render(); body.querySelector<HTMLElement>('.fr-title')?.focus({ preventScroll: true }); break;
    }
  });

  element.addEventListener('input', event => {
    const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target : null;
    const field = target?.dataset.frField as Field | undefined;
    if (!target || !field || !editing) return;
    editing[field] = target.value;
    if (field === 'description' && target instanceof HTMLTextAreaElement) target.rows = rowsFor(target.value);
    const counter = body.querySelector<HTMLElement>(`[data-fr-count="${field}"]`);
    if (counter) {
      const text = field === 'title' ? count(target.value, TITLE_LIMIT, 100) : count(target.value, DESCRIPTION_LIMIT, 3600);
      counter.textContent = text; counter.hidden = !text;
    }
    if (invalid === field && target.value.trim()) {
      invalid = null; target.removeAttribute('aria-invalid'); target.removeAttribute('aria-describedby');
      body.querySelector(`#fr-error-${field}`)?.remove();
    }
  });

  element.addEventListener('keydown', event => {
    const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (!target || !editing || !target.dataset.frField || isImeKey(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!event.repeat) void send(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
  });

  /** The Feedback dialog: the same form, empty. Its draft survives Esc and Cancel until the app closes. */
  function feedback(): void {
    const noProject = !hasProject();
    const dialog = host.dialog.open('Feedback', `<div class="fr-dialog">
      <p class="fr-dialog-sub">Tell us what PandaCode is missing. Send request opens a draft on GitHub in your browser with this text in the link; it becomes an issue when you submit it there.</p>
      <label class="field-label" for="fr-dialog-title">Title</label>
      <input id="fr-dialog-title" data-fr-dialog="title" maxlength="${TITLE_LIMIT}" placeholder="What should PandaCode do?" autocomplete="off" spellcheck="true" value="${escape(feedbackDraft.title)}">
      <p class="fr-field-error" id="fr-dialog-error-title" hidden>Add a title</p>
      <label class="field-label" for="fr-dialog-details">Details</label>
      <textarea id="fr-dialog-details" data-fr-dialog="description" rows="5" maxlength="${DESCRIPTION_LIMIT}" placeholder="What are you trying to do, and what gets in the way?" spellcheck="true">${escape(feedbackDraft.description)}</textarea>
      <p class="fr-field-error" id="fr-dialog-error-description" hidden>Add details</p>
      <div class="dialog-footer fr-dialog-footer"><button type="button" class="fr-ghost" data-action="close-dialog">Cancel</button><button type="button" class="secondary-button" data-fr-dialog-action="do" ${noProject ? `aria-disabled="true" aria-describedby="fr-dialog-note"` : ''}>Do it myself</button><button type="button" class="primary-button" data-fr-dialog-action="send">Send request</button></div>
      ${noProject ? `<p class="fr-dialog-note" id="fr-dialog-note">${NO_PROJECT}</p>` : ''}
      <p class="fr-field-error" id="fr-dialog-error" role="alert" hidden></p>
    </div>`);
    const input = (field: Field) => dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-fr-dialog="${field}"]`)!;
    const show = (id: string, text?: string) => {
      const node = dialog.querySelector<HTMLElement>(`#fr-dialog-${id}`)!;
      node.hidden = !text; if (text) node.textContent = text;
    };
    const check = (): boolean => {
      show('error-title'); show('error-description'); show('error');
      const missing = requestProblem(feedbackDraft.title, feedbackDraft.description, 'Add details');
      if (!missing) return true;
      const field: Field = feedbackDraft.title.trim() ? 'description' : 'title';
      show(`error-${field}`, missing);
      input(field).setAttribute('aria-invalid', 'true'); input(field).focus();
      return false;
    };
    const finish = (text: string, actions?: { label: string; run: () => void }[]) => {
      feedbackDraft = { title: '', description: '' };
      host.dialog.close();
      host.notify(text, actions);
    };
    dialog.addEventListener('input', event => {
      const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target : null;
      const field = target?.dataset.frDialog as Field | undefined;
      if (!target || !field) return;
      feedbackDraft[field] = target.value;
      if (target.value.trim() && target.getAttribute('aria-invalid')) { target.removeAttribute('aria-invalid'); show(`error-${field}`); }
    });
    let sending = false;
    const sendDialog = async (): Promise<void> => {
      if (sending || !check()) return;
      sending = true;
      const draft = issueDraft(feedbackDraft.title, feedbackDraft.description);
      try { await host.openUrl(draft.url); }
      catch {
        sending = false;
        const text = `${feedbackDraft.title.trim()}\n\n${feedbackDraft.description.trim()}`;
        host.notify('Couldn’t open your browser.', [{ label: 'Copy text', run: () => { void host.copy(text).then(() => host.notify('Copied.')); } }]);
        return;
      }
      finish(draft.shortened ? SENT_SHORTENED : SENT);
    };
    const taskDialog = async (button: HTMLElement): Promise<void> => {
      if (button.getAttribute('aria-disabled') === 'true' || !check()) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-fr-dialog-action]')];
      const label = button.textContent;
      for (const entry of buttons) entry.disabled = true;
      button.innerHTML = '<span class="support-spinner" aria-hidden="true"></span>Creating…';
      try {
        const task = await host.createTask(feedbackDraft.title.trim(), feedbackDraft.description.trim());
        finish(`Task created in ${task.project}`, [{ label: 'Open', run: () => host.openTask(task.id) }]);
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        for (const entry of buttons) entry.disabled = false;
        button.textContent = label;
        show('error', `Couldn’t create the task: ${reason.replace(/\.$/, '')}. Try again, or use Send request.`);
      }
    };
    dialog.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fr-dialog-action]') : null;
      if (!button) return;
      if (button.dataset.frDialogAction === 'send') void sendDialog(); else void taskDialog(button);
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isImeKey(event)) { event.preventDefault(); void sendDialog(); }
    });
  }

  void host.listen(event => {
    if (disposed) return;
    if (!event?.sessionId || event.sessionId === host.sessionId()) void load();
    else if (event.sessionId === requested) requested = '\0';
  }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);

  return {
    element,
    sync() {
      const sessionId = host.sessionId();
      if (sessionId !== requested) { requested = sessionId; loadedFor = ''; reset(); items = []; shownId = ''; render(); void load(); }
    },
    feedback,
    dispose() { disposed = true; unlisten?.(); element.remove(); },
  };
}
