import { icon } from '../dom';
import type { ChoiceItem } from '../choice-menu';
import { evaluateCondition, type Json } from './contracts';
import type { ExtensionMenuItem } from './manager';

/** Only policy-validated, local static icons reach this host renderer. */
export function extensionIcon(svg: string | undefined): string {
  const parsed = svg ? new DOMParser().parseFromString(svg, 'image/svg+xml') : undefined;
  const node = parsed?.documentElement;
  if (node?.localName === 'svg' && !parsed?.querySelector('parsererror')) {
    node.setAttribute('class', 'icon'); node.setAttribute('aria-hidden', 'true'); return node.outerHTML;
  }
  return icon('help').replace('<svg ', '<svg data-extension-icon-fallback="true" ');
}
export function extensionChoices(items: ExtensionMenuItem[], icons: Record<string, string>, context: Record<string, Json>): ChoiceItem[] {
  let separator = false;
  return items.flatMap(item => {
    if (item.kind === 'separator') { separator = true; return []; }
    const enabled = item.enabled === undefined ? undefined : evaluateCondition(item.enabled, context);
    const choice: ChoiceItem = { id: item.id, label: item.title!, separator, disabled: enabled !== undefined && (!enabled.ok || enabled.value !== true), selected: item.checked, kind: item.kind === 'checkbox' || item.kind === 'radio' ? item.kind : undefined, leading: extensionIcon(icons[item.icon ?? '']), children: item.items ? extensionChoices(item.items, icons, context) : undefined };
    separator = false; return [choice];
  });
}
