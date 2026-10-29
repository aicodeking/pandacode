import type { ProviderId } from './types';
import { escape } from './dom';
import githubCopilotLogo from './assets/providers/github-copilot.svg?raw';
import clineLogo from './assets/providers/cline.svg?raw';
import devinLogo from './assets/providers/devin.svg?raw';
import kiloLogo from './assets/providers/kilo.svg?raw';
import zcodeLogo from './assets/providers/zcode.svg?raw';

// Original provider assets; see docs/brand-assets.md for provenance.
// A harness without an asset shows a neutral lettered tile at the logo size.
const logos: Partial<Record<ProviderId, string>> = {
  claude: new URL('./assets/providers/claude.svg', import.meta.url).href,
  codex: new URL('./assets/providers/openai.svg', import.meta.url).href,
  kimi: new URL('./assets/providers/kimi.png', import.meta.url).href,
  opencode: new URL('./assets/providers/opencode.png', import.meta.url).href,
  glm: new URL('./assets/providers/glm.svg', import.meta.url).href,
  antigravity: new URL('./assets/providers/antigravity.png', import.meta.url).href,
  grok: new URL('./assets/providers/grok.png', import.meta.url).href,
  mimo: new URL('./assets/providers/mimo.png', import.meta.url).href,
  pi: new URL('./assets/providers/pi.png', import.meta.url).href,
  deepseek: new URL('./assets/providers/deepseek.png', import.meta.url).href,
  commandcode: new URL('./assets/providers/commandcode.png', import.meta.url).href,
  muse: new URL('./assets/providers/muse.svg', import.meta.url).href,
  omp: new URL('./assets/providers/omp.svg', import.meta.url).href,
  hermes: new URL('./assets/providers/hermes.svg', import.meta.url).href,
  nanobot: new URL('./assets/providers/nanobot.svg', import.meta.url).href,
};

/** Decorative provider mark. The surrounding control supplies its accessible name. */
export function providerLogo(id: ProviderId, cls = ''): string {
  const className = `provider-logo${cls ? ` ${escape(cls)}` : ''}`;
  // Monochrome marks are inlined and drawn in the theme's text color.
  const inline = id === 'github-copilot' ? githubCopilotLogo : id === 'cline' ? clineLogo.replaceAll('#1C1C24', 'currentColor') : id === 'devin' ? devinLogo.replace('fill="black"', 'fill="currentColor"') : id === 'kilo' ? kiloLogo : id === 'zcode' ? zcodeLogo.replace('fill="black"', 'fill="currentColor"') : '';
  if (inline) {
    return inline.replace('<svg ', `<svg class="${className}" data-provider="${id}" aria-hidden="true" focusable="false" `);
  }
  const src = logos[id];
  if (!src) return `<span class="${className} provider-logo-tile" data-provider="${id}" aria-hidden="true">${escape(id.charAt(0).toUpperCase())}</span>`;
  return `<img class="${className}" data-provider="${id}" src="${escape(src)}" width="20" height="20" alt="" aria-hidden="true" draggable="false">`;
}
