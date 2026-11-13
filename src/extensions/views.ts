import { isImeKey } from '../dom';
import { validateContract, type Json } from './contracts';
import { invokeExtensionCommand, extensionCommands } from './commands';
import { evaluateCondition } from './contracts';
import type { RegisteredView, ViewDefinition, ViewTreeItem } from './views-state';

/** Presentation owns only its DOM/listeners/transients, never underlying workspace services. */
export function mountInspectorView(host: HTMLElement, entry: RegisteredView, context: Record<string, Json>, notify: (message: string) => void): () => void {
  const checked = validateContract('view', entry.view);
  if (!checked.ok) {
    const error = document.createElement('p'); error.setAttribute('role', 'alert');
    error.textContent = 'Extension view data is invalid. Select a built-in view to continue.';
    host.replaceChildren(error); return () => error.remove();
  }
  const view = checked.value as unknown as ViewDefinition;
  const controller = new AbortController(), { signal } = controller;
  let transient: (() => void) | undefined;
  const panel = document.createElement('section'); panel.className = 'extension-inspector-view';
  panel.setAttribute('aria-label', `${view.title} — ${entry.owner}`);
  const appendText = (parent: HTMLElement, tag: string, text: string) => {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  appendText(panel, 'p', `Extension: ${entry.owner}`);
  appendText(panel, 'p', view.text);
  if (view.rich) {
    const button = appendText(panel, 'button', 'Open isolated extension window') as HTMLButtonElement;
    button.type = 'button'; button.className = 'ds-btn';
    const status = appendText(panel, 'p', 'Rich HTML is experimental. Native targets remain disabled until installed isolation qualification.'); status.setAttribute('role', 'status');
    button.addEventListener('click', () => {
      if (signal.aborted) return;
      button.disabled = true;
      void import('./rich-views').then(module => signal.aborted ? '' : module.openRichView(entry)).then(message => { if (!signal.aborted && message) status.textContent = message; }).catch(() => { if (!signal.aborted) status.textContent = 'The isolated view is unavailable. The host-rendered view remains usable.'; }).finally(() => { if (!signal.aborted) button.disabled = false; });
    }, { signal });
  }
  const toolbar = document.createElement('div'); toolbar.className = 'extension-view-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', `${view.title} tools`); panel.append(toolbar);
  const captured = structuredClone({ ...context, schemaVersion: 1, windowId: 'main', surfaceId: view.id });
  const commands = extensionCommands().filter(item => item.owner.extensionId === entry.owner && item.owner.version === entry.version);
  for (const item of view.toolbar ?? []) {
    const command = commands.find(itemCommand => itemCommand.command.id === item.command)?.command;
    if (!command) continue;
    const button = appendText(toolbar, 'button', command.title) as HTMLButtonElement; button.type = 'button'; button.className = 'ds-btn';
    const enabled = command.enabled === undefined ? true : evaluateCondition(command.enabled, captured);
    button.disabled = enabled !== true && (!enabled.ok || enabled.value !== true);
    button.addEventListener('click', () => {
      if (!signal.aborted && panel.isConnected) invokeExtensionCommand(command.id, captured, notify, close => { transient?.(); transient = close; });
    }, { signal });
  }
  toolbar.hidden = !toolbar.childElementCount;
  for (const control of view.controls ?? []) {
    const group = document.createElement('section'); group.className = 'extension-view-control ds-card-inner'; panel.append(group);
    appendText(group, 'h3', control.label);
    if (control.kind === 'progress') {
      const progress = document.createElement('progress'); progress.max = 100; progress.value = control.value;
      progress.setAttribute('aria-label', control.label); group.append(progress); appendText(group, 'span', `${control.value}%`);
    } else if (control.kind === 'list') {
      const list = document.createElement('ul'); list.setAttribute('aria-label', control.label); group.append(list);
      for (const item of control.items) appendText(list, 'li', item);
    } else if (control.kind === 'table') {
      const table = document.createElement('table'); table.setAttribute('aria-label', control.label); group.append(table);
      const head = table.createTHead().insertRow(); for (const column of control.columns) { const th = appendText(head, 'th', column); th.setAttribute('scope', 'col'); }
      const body = table.createTBody(); for (const row of control.rows) { const tr = body.insertRow(); for (let i = 0; i < control.columns.length; i++) appendText(tr, 'td', row[i] ?? ''); }
    } else if (control.kind === 'tabs') {
      const nav = document.createElement('div'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', control.label); group.append(nav);
      const content = document.createElement('div'); content.setAttribute('role', 'tabpanel'); group.append(content);
      const buttons: HTMLButtonElement[] = [];
      const select = (index: number) => {
        buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; });
        content.textContent = control.items[index].text; content.setAttribute('aria-labelledby', buttons[index].id);
      };
      control.items.forEach((item, index) => {
        const button = appendText(nav, 'button', item.label) as HTMLButtonElement;
        button.id = `extension-view-tab-${crypto.randomUUID()}`; button.type = 'button'; button.className = 'ds-btn'; button.setAttribute('role', 'tab'); buttons.push(button);
        button.addEventListener('click', () => select(index), { signal });
        button.addEventListener('keydown', event => {
          if (isImeKey(event)) { if (event.key === 'Enter' || event.key === ' ') event.preventDefault(); return; }
          const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
          if (next < 0) return; event.preventDefault(); event.stopPropagation(); select(next); buttons[next].focus();
        }, { signal });
      }); select(0);
    } else if (control.kind === 'tree') {
      const tree = document.createElement('ul'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', control.label); group.append(tree);
      const addItems = (parent: HTMLElement, items: ViewTreeItem[]) => {
        for (const item of items) {
          const row = document.createElement('li'); row.setAttribute('role', 'none'); parent.append(row);
          const button = appendText(row, 'button', item.label) as HTMLButtonElement; button.type = 'button'; button.className = 'ds-btn'; button.setAttribute('role', 'treeitem'); button.tabIndex = -1;
          let children: HTMLElement | undefined;
          if (item.children?.length) { children = document.createElement('ul'); children.id = `extension-view-tree-${crypto.randomUUID()}`; children.setAttribute('role', 'group'); children.hidden = true; row.append(children); button.setAttribute('aria-owns', children.id); button.setAttribute('aria-expanded', 'false'); addItems(children, item.children); }
          const expand = (value: boolean) => { if (children) { children.hidden = !value; button.setAttribute('aria-expanded', String(value)); } };
          button.addEventListener('click', () => expand(children?.hidden ?? false), { signal });
          button.addEventListener('focus', () => { tree.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach(node => { node.tabIndex = node === button ? 0 : -1; }); }, { signal });
          button.addEventListener('keydown', event => {
            if (isImeKey(event)) { if (event.key === 'Enter' || event.key === ' ') event.preventDefault(); return; }
            const visible = [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].filter(node => !node.closest('ul[hidden]'));
            const index = visible.indexOf(button);
            let target = event.key === 'ArrowDown' ? visible[Math.min(index + 1, visible.length - 1)] : event.key === 'ArrowUp' ? visible[Math.max(index - 1, 0)] : event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1) : undefined;
            if (event.key === 'ArrowRight' && children) { if (children.hidden) expand(true); else target = children.querySelector<HTMLButtonElement>('[role="treeitem"]') ?? undefined; }
            else if (event.key === 'ArrowLeft') { if (children && !children.hidden) expand(false); else target = row.parentElement?.closest('li')?.querySelector<HTMLButtonElement>('[role="treeitem"]') ?? undefined; }
            else if (!target) return;
            event.preventDefault(); event.stopPropagation(); target?.focus();
          }, { signal });
        }
      };
      addItems(tree, control.items); const first = tree.querySelector<HTMLElement>('[role="treeitem"]'); if (first) first.tabIndex = 0;
    }
  }
  host.replaceChildren(panel);
  return () => { controller.abort(); transient?.(); transient = undefined; panel.remove(); };
}
