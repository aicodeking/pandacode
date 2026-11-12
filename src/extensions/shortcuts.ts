/** Physical-key bindings. Core keys are reserved; extension conflicts need an explicit user choice. */
import type { Keybinding } from './settings-state';
export const BINDING_CHOICES_KEY = 'pandacode.extensions.keybindings.v1';
export const CORE_BINDINGS = new Set(['Mod+KeyK', 'Mod+Shift+KeyK', 'Mod+KeyN', 'Mod+Shift+KeyN', 'Mod+KeyJ', 'Mod+Shift+KeyJ', 'Mod+KeyB', 'Mod+Shift+KeyB', 'Mod+KeyF', 'Mod+KeyG', 'Mod+Shift+KeyG', 'Mod+KeyZ', 'Mod+Shift+KeyZ', 'Mod+KeyY', 'Mod+KeyA', 'Mod+KeyC', 'Mod+KeyV', 'Mod+KeyX', 'Mod+KeyR', 'Mod+KeyW', 'Mod+KeyQ', 'Mod+KeyT', 'Mod+KeyL', 'Mod+KeyP', 'Mod+KeyS', 'Mod+KeyO', 'Mod+KeyH', 'Mod+KeyM', 'Mod+Alt+KeyI']);
export type BindingChoices = Record<string, string>;
export function readBindingChoices(text: string | null): BindingChoices {
  try {
    if (!text || text.length > 16384) return {};
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => /^Mod\+(Shift\+)?(Alt\+)?Key[A-Z]$/.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length <= 160));
  } catch { return {}; }
}
export function bindingGroups(bindings: Keybinding[], choices: BindingChoices) {
  return [...new Set(bindings.map(binding => binding.key))].sort().map(key => {
    const candidates = bindings.filter(binding => binding.key === key), reserved = CORE_BINDINGS.has(key);
    const winner = reserved ? undefined : candidates.length === 1 ? candidates[0] : candidates.find(binding => binding.id === choices[key]);
    return { key, candidates, reserved, winner };
  });
}
export function shortcutCommand(bindings: Keybinding[], choices: BindingChoices, event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing' | 'keyCode'>, editing: boolean, modal: boolean): string | undefined {
  if (editing || modal || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey === event.metaKey) return;
  const key = `Mod+${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Alt+' : ''}${event.code}`;
  return bindingGroups(bindings, choices).find(group => group.key === key)?.winner?.command;
}
