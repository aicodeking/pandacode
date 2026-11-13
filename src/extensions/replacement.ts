import './replacement.css';
import { escape } from '../dom';
import { extensionsSnapshot, extensionIdentity } from './manager';
import { createComponentSelection, createComponentSlot, type ComponentProvider, type SlotProps, type SlotAction, type SlotId } from './component-slot';

export const componentSelection = createComponentSelection(localStorage);
const faults = new Set<string>();
export function componentProviders(): ComponentProvider[] {
  const snapshot = extensionsSnapshot();
  return snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled && item.manifest.permissions?.includes('ui.contribute')).flatMap(item => item.manifest.contributes.components ?? []).sort((a, b) => a.id.localeCompare(b.id));
}
export function selectComponent(slot: SlotId, id?: string): void {
  componentSelection.select(slot, id, componentProviders());
  window.dispatchEvent(new Event('pandacode-components-change'));
}
const identity = (provider: ComponentProvider) => `${provider.id}:${extensionIdentity(provider.id.split('/')[0])}`;
/** Declarative composer v1 reorders host-owned regions, never substitutes an editor or
 * dispatches an extension action. Recovery changes attributes only: native input/IME,
 * undo, grants, approvals, queue and submission remain exclusively core-owned. */
export function applyComposerPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('#prompt') || !host.querySelector('.composer-tray')) throw new Error('Incomplete host composer');
}): void {
  delete host.dataset.componentProvider;
  host.classList.remove('component-toolbar-first');
  const provider = componentSelection.resolve('panda.composer', componentProviders());
  if (!provider || faults.has(identity(provider))) return;
  try {
    qualify();
    host.classList.add('component-toolbar-first');
    host.dataset.componentProvider = provider.id;
  } catch { faults.add(identity(provider)); }
}
/** Closed transcript recipe: no cloned history, content delivery, action proxy or
 * extra event subscription. Failure/revocation never touches host reading state. */
export function applyTranscriptPresentation(host: HTMLElement, qualify = () => {
  if (host.id !== 'transcript') throw new Error('Unsupported transcript host');
}): void {
  delete host.dataset.componentProvider;
  host.classList.remove('component-timeline');
  const status = host.parentElement?.querySelector<HTMLElement>(':scope > [data-transcript-presentation-status]');
  if (status) { status.hidden = true; status.textContent = ''; }
  const provider = componentSelection.resolve('panda.transcript', componentProviders());
  if (!provider) return;
  const owner = extensionsSnapshot().packages.find(item => item.manifest.id === provider.id.split('/')[0]);
  const missing = ['tasks.transcript.read', 'tasks.tools.read'].filter(permission => !owner?.manifest.permissions?.includes(permission));
  const unavailable = (message: string) => {
    if (!host.parentElement) return;
    const notice = status ?? document.createElement('p');
    notice.dataset.transcriptPresentationStatus = '';
    notice.className = 'transcript-presentation-status';
    notice.setAttribute('role', 'status'); notice.hidden = false; notice.textContent = message;
    if (!notice.parentElement) host.before(notice);
  };
  if (missing.length) { unavailable(`Unsupported replacement — content redacted (${missing.join(', ')} not granted). Built-in transcript remains active.`); return; }
  if (faults.has(identity(provider))) { unavailable('Transcript replacement failed. Built-in transcript remains active.'); return; }
  try { qualify(); host.classList.add('component-timeline'); host.dataset.componentProvider = provider.id; }
  catch { faults.add(identity(provider)); unavailable('Transcript replacement failed. Built-in transcript remains active.'); }
}
/** Host-only fault boundary. The optional painter supports controlled conformance faults. */
export function renderComponent(host: HTMLElement, props: SlotProps, current: () => SlotProps, dispatch: (action: SlotAction) => void, paint = componentHtml): (() => void) | undefined {
  const provider = componentSelection.resolve(props.slot, componentProviders());
  if (!provider || faults.has(identity(provider))) return;
  let instance: ReturnType<typeof createComponentSlot>;
  try { instance = createComponentSlot(props, current, dispatch); host.innerHTML = paint(provider, instance.props); }
  catch { instance!?.dispose(); host.replaceChildren(); faults.add(identity(provider)); return; }
  const click = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-component-object]') : undefined;
    const object = instance.props.objects.find(object => object.id === button?.dataset.componentObject);
    if (!object || !button || !host.contains(button)) return;
    instance.dispatch({ contractVersion: 1, kind: props.slot === 'panda.projects' ? 'select' : object.directory ? 'toggle' : 'open', id: object.id, objectRevision: object.revision, revision: props.revision, context: props.context });
  };
  host.addEventListener('click', click);
  return () => { instance.dispose(); host.removeEventListener('click', click); };
}
function componentHtml(provider: ComponentProvider, props: SlotProps): string {
  const state = props.state;
  return `<section class="component-replacement component-${provider.presentation}" data-component-provider="${escape(provider.id)}" aria-label="${escape(provider.title)}" aria-busy="${state.loading}" ${state.visible ? '' : 'hidden'}>
    ${state.loading || state.offline ? `<p role="status">${state.offline ? 'Offline — built-in recovery remains available.' : 'Loading…'}</p>` : ''}
    ${props.objects.map(object => `<button type="button" class="ds-btn ${provider.presentation === 'cards' ? 'ds-card' : 'ds-row'}" data-component-object="${escape(object.id)}" ${object.id === state.selected ? 'aria-current="true"' : ''} ${object.directory ? `aria-expanded="${Boolean(object.expanded)}"` : ''} ${state.loading || state.offline ? 'disabled' : ''}>${escape(object.label)}${object.directory ? object.expanded ? ' ▾' : ' ▸' : ''}</button>`).join('') || (!state.loading && !state.offline ? '<p role="status">No items</p>' : '')}
  </section>`;
}
