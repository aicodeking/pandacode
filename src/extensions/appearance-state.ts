/** Public bounded appearance data; never CSS or selectors. */
export type AppearanceColors = { background: string; foreground: string; accent: string };
export type ExtensionTheme = { id: string; schemaVersion: 1; light: AppearanceColors; dark: AppearanceColors; font?: 'system' | 'sans-serif' | 'monospace'; rowPadding?: number; radius?: number };

const icons = new Map<string, string>();
/** Assets have already passed native SVG policy. Defense in depth for browser fixtures. */
export function safeAppearanceIcon(source: string): string | undefined {
  if (source.length > 16384) return;
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror')) return;
  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (!['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g'].includes(node.localName)) return;
    for (const attribute of node.attributes) {
      if (attribute.name === 'xmlns' && attribute.value === 'http://www.w3.org/2000/svg') continue;
      if (['fill', 'stroke'].includes(attribute.name) && !['none', 'currentColor'].includes(attribute.value)) return;
      if (!['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'rx', 'ry', 'points'].includes(attribute.name) || /url|https?:|data:|[<>]/i.test(attribute.value)) return;
    }
  }
  return root.innerHTML;
}
export function appearanceIcon(name: string): string | undefined { return icons.get(name); }
export function setAppearanceIcons(values: Map<string, string>): void { icons.clear(); for (const [name, source] of values) { const safe = safeAppearanceIcon(source); if (safe) icons.set(name, safe); } }
