const SUPPORT_URL = 'https://github.com/aicodeking/pandacode/issues';
const CONTROL = /[\u0000-\u001f\u007f]/;
export function validateExternalUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || CONTROL.test(value)) throw new Error('Invalid external URL');
  const url = new URL(value); if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password) throw new Error('Only credential-free HTTP(S) URLs are allowed');
  return url;
}
export function openWebExternal(value: unknown): void {
  const url = validateExternalUrl(value);
  if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive && typeof window.open === 'function') { window.open(url.href, '_blank', 'noopener,noreferrer'); return; }
  showLink(url);
}
export function openWebSupport(): void { openWebExternal(SUPPORT_URL); }
function showLink(url: URL): void {
  const dialog = document.createElement('dialog'); dialog.className = 'web-external-link dialog-plate'; dialog.setAttribute('aria-labelledby', 'web-external-link-title');
  dialog.innerHTML = '<form method="dialog"><h2 id="web-external-link-title">Open link</h2><p>This link will open in a new browser tab.</p><a data-open target="_blank" rel="noopener noreferrer">Open link</a><button value="cancel">Cancel</button></form>';
  const link = dialog.querySelector<HTMLAnchorElement>('[data-open]')!; link.href = url.href; link.textContent = url.href;
  const previous = document.activeElement as HTMLElement | null; dialog.addEventListener('close', () => { dialog.remove(); previous?.focus?.(); }, { once: true });
  document.body.append(dialog); dialog.showModal(); link.focus();
}
