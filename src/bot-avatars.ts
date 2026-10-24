/** Bot icons: ten panda faces on colored badges, or an image the user uploaded (stored as a
 *  small data: URL). Legacy bots keep their emoji or the first letter of their name. */

export const PANDAS: { id: string; name: string; color: string }[] = [
  ['Orange', '#f97316'], ['Amber', '#f59e0b'], ['Coral', '#fb7185'], ['Pink', '#ec4899'], ['Violet', '#8b5cf6'],
  ['Blue', '#3b82f6'], ['Teal', '#14b8a6'], ['Green', '#22c55e'], ['Slate', '#64748b'], ['Cream', '#e6d2a8'],
].map(([name, color], i) => ({ id: `panda:${i}`, name, color }));

const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_UPLOAD = 5 * 1024 * 1024;
const SIZE = 128;
const INK = '#1d1d1f';

const escape = (value: string): string => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** A panda face on its preset color; '' for an unknown id. */
export function pandaSvg(id: string): string {
  const panda = PANDAS.find(p => p.id === id);
  if (!panda) return '';
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="${panda.color}"/>`
    + `<circle cx="17" cy="19" r="8" fill="${INK}"/><circle cx="47" cy="19" r="8" fill="${INK}"/>`
    + '<ellipse cx="32" cy="36" rx="20" ry="17.5" fill="#fff"/>'
    + `<ellipse cx="24" cy="35" rx="5" ry="6.5" transform="rotate(30 24 35)" fill="${INK}"/><ellipse cx="40" cy="35" rx="5" ry="6.5" transform="rotate(-30 40 35)" fill="${INK}"/>`
    + '<circle cx="25" cy="34" r="1.7" fill="#fff"/><circle cx="39" cy="34" r="1.7" fill="#fff"/>'
    + `<ellipse cx="32" cy="42" rx="2.8" ry="1.9" fill="${INK}"/><path d="M29 45.5q3 2.5 6 0" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

export function botAvatarHtml(avatar: string, name: string, cls = ''): string {
  const value = avatar.trim();
  const art = pandaSvg(value) || (IMAGE.test(value) ? `<img alt="" src="${value}">` : '');
  const content = art || escape(value || name.trim().slice(0, 1).toUpperCase() || '?');
  return `<span class="bot-avatar${art ? ' has-art' : ''}${cls ? ` ${cls}` : ''}" aria-hidden="true">${content}</span>`;
}

function customSwatch(url: string, pressed: boolean): string {
  return `<button type="button" class="avatar-swatch" data-avatar-choice="custom" aria-pressed="${pressed}" aria-label="Uploaded image"><img alt="" src="${url}"></button>`;
}

export function avatarPicker(current: string): string {
  const swatches = PANDAS.map(p => `<button type="button" class="avatar-swatch" data-avatar-choice="${p.id}" aria-pressed="${p.id === current}" aria-label="${p.name} panda">${pandaSvg(p.id)}</button>`).join('');
  return `<div class="avatar-picker" role="radiogroup" aria-label="Icon"><input type="hidden" name="avatar" value="${escape(current)}">${swatches}`
    + `${IMAGE.test(current) ? customSwatch(current, true) : ''}<button type="button" class="avatar-upload" data-avatar-upload-button>Upload…</button>`
    + `<input type="file" hidden accept="${UPLOAD_TYPES.join(',')}" data-avatar-upload><span class="avatar-error" role="alert" hidden></span></div>`;
}

function choose(picker: HTMLElement, swatch: HTMLElement, value: string): void {
  const hidden = picker.querySelector<HTMLInputElement>('input[name="avatar"]')!;
  hidden.value = value;
  for (const item of picker.querySelectorAll('[data-avatar-choice]')) item.setAttribute('aria-pressed', String(item === swatch));
  hidden.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Center-crops the image to a 128 px square PNG. */
async function cropped(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

async function upload(picker: HTMLElement, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  const error = picker.querySelector<HTMLElement>('.avatar-error')!;
  const fail = (text: string) => { error.textContent = text; error.hidden = false; };
  error.hidden = true;
  if (!file) return;
  if (!UPLOAD_TYPES.includes(file.type)) return fail('Choose a PNG, JPEG, WebP or GIF image.');
  if (file.size > MAX_UPLOAD) return fail('Choose an image under 5 MB.');
  let url: string;
  try { url = await cropped(file); } catch { return fail('That image could not be read.'); }
  let swatch = picker.querySelector<HTMLElement>('[data-avatar-choice="custom"]');
  if (!swatch) {
    picker.querySelector('[data-avatar-upload-button]')!.insertAdjacentHTML('beforebegin', customSwatch(url, false));
    swatch = picker.querySelector<HTMLElement>('[data-avatar-choice="custom"]')!;
  }
  swatch.querySelector('img')!.src = url;
  choose(picker, swatch, url);
}

/** Call first from the host's click and change listeners; true when the picker handled the event. */
export function handleAvatarPicker(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const picker = target.closest<HTMLElement>('.avatar-picker');
  if (!picker) return false;
  if (event.type === 'change') {
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-avatar-upload]')) return false;
    void upload(picker, target);
    return true;
  }
  if (event.type !== 'click') return false;
  if (target.closest('[data-avatar-upload-button]')) { picker.querySelector<HTMLInputElement>('[data-avatar-upload]')!.click(); return true; }
  const swatch = target.closest<HTMLElement>('[data-avatar-choice]');
  if (!swatch) return false;
  const choice = swatch.dataset.avatarChoice!;
  choose(picker, swatch, choice === 'custom' ? swatch.querySelector('img')!.getAttribute('src')! : choice);
  return true;
}
