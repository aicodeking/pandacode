// File and folder icons from Material Icon Theme (the VS Code extension), matched the way
// VS Code does: exact file name, then the longest extension, then the default icon.
import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };
import { escape } from './dom.ts';

type Names = { fileNames: Record<string, string>; fileExtensions: Record<string, string>; folderNames: Record<string, string> };
const { iconDefinitions, light, ...dark } = manifest as unknown as Names & { iconDefinitions: Record<string, { iconPath: string }>; light: Names };

// Own keys only: a file named `constructor` must not resolve to Object.prototype.
function find(kind: keyof Names, key: string, isLight: boolean): string | undefined {
  if (isLight && Object.hasOwn(light[kind], key)) return light[kind][key];
  return Object.hasOwn(dark[kind], key) ? dark[kind][key] : undefined;
}

export function fileIconId(name: string, isDir: boolean, isLight = false): string {
  const lower = name.toLowerCase();
  if (isDir) return find('folderNames', lower, isLight) ?? 'folder';
  const exact = find('fileNames', lower, isLight);
  // README's own icon is a blue info circle, which reads as a warning in change lists: it takes its extension's icon.
  if (exact && exact !== 'readme') return exact;
  for (let dot = lower.indexOf('.'); dot !== -1; dot = lower.indexOf('.', dot + 1)) {
    const id = find('fileExtensions', lower.slice(dot + 1), isLight);
    if (id) return id;
  }
  return 'file';
}

export function fileIconUrl(name: string, isDir: boolean, isLight = false): string {
  const file = iconDefinitions[fileIconId(name, isDir, isLight)].iconPath.split('/').pop();
  return new URL(`../node_modules/material-icon-theme/icons/${file}`, import.meta.url).href;
}

export function fileIcon(name: string, isDir: boolean, isLight = false): string {
  return `<img class="icon file-type-icon" src="${escape(fileIconUrl(name, isDir, isLight))}" alt="" aria-hidden="true" draggable="false">`;
}
