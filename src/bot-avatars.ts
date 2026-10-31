/** Bot icons: panda faces on colored badges, or an image the user uploaded (stored as a
 *  small data: URL). Legacy bots keep their emoji or the first letter of their name.
 *  `panda:N` picks face N % FACES.length on color N; a bot's own color (`#rrggbb`) tints the badge. */

export const PANDAS: { id: string; name: string; color: string }[] = [
  ['Orange', '#f97316'], ['Amber', '#f59e0b'], ['Coral', '#fb7185'], ['Pink', '#ec4899'], ['Violet', '#8b5cf6'],
  ['Blue', '#3b82f6'], ['Teal', '#14b8a6'], ['Green', '#22c55e'], ['Slate', '#64748b'], ['Cream', '#e6d2a8'],
].map(([name, color], i) => ({ id: `panda:${i}`, name, color }));

const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_UPLOAD = 5 * 1024 * 1024;
const SIZE = 128;
const INK = '#1d1d1f';
const PATCHES = `<ellipse cx="24" cy="35" rx="5" ry="6.5" transform="rotate(30 24 35)" fill="${INK}"/><ellipse cx="40" cy="35" rx="5" ry="6.5" transform="rotate(-30 40 35)" fill="${INK}"/>`;
const PUPILS = '<circle cx="25" cy="34" r="1.7" fill="#fff"/><circle cx="39" cy="34" r="1.7" fill="#fff"/>';
const NOSE = `<ellipse cx="32" cy="42" rx="2.8" ry="1.9" fill="${INK}"/>`;
const line = (d: string, color = INK) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>`;
const SMILE = line('M29 45.5q3 2.5 6 0');

/** Eyes and mouth over the shared head; the badge color shows through everything else. */
export const FACES: { name: string; art: string }[] = [
  { name: 'Classic', art: PATCHES + PUPILS + NOSE + SMILE },
  { name: 'Happy', art: PATCHES + line('M22.5 35q2.5-2.6 5 0', '#fff') + line('M36.5 35q2.5-2.6 5 0', '#fff') + NOSE + line('M28 45q4 3.6 8 0') },
  { name: 'Wink', art: PATCHES + '<circle cx="25" cy="34" r="1.7" fill="#fff"/>' + line('M37.5 35h4', '#fff') + NOSE + SMILE },
  { name: 'Sleepy', art: PATCHES + line('M22.5 35.5q2.5 2 5 0', '#fff') + line('M36.5 35.5q2.5 2 5 0', '#fff') + NOSE + line('M30.5 46.5h3') },
  { name: 'Glasses', art: PATCHES + PUPILS + `<circle cx="24.5" cy="34.5" r="6.8" fill="none" stroke="${INK}" stroke-width="1.5"/><circle cx="39.5" cy="34.5" r="6.8" fill="none" stroke="${INK}" stroke-width="1.5"/>` + line('M31.3 34h1.4') + NOSE + SMILE },
  { name: 'Surprised', art: PATCHES + `<circle cx="25" cy="34.5" r="2.6" fill="#fff"/><circle cx="39" cy="34.5" r="2.6" fill="#fff"/>` + NOSE + `<ellipse cx="32" cy="47" rx="2" ry="2.4" fill="${INK}"/>` },
];

const escape = (value: string): string => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pandaIndex = (id: string): number => PANDAS.findIndex(p => p.id === id);
export const isUpload = (value: string): boolean => IMAGE.test(value);

/** A panda face on its preset color; '' for an unknown id. Inside a picker, `--panda-bg` recolors every face at once. */
export function pandaSvg(id: string): string {
  const index = pandaIndex(id);
  if (index < 0) return '';
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" style="fill:var(--panda-bg,${PANDAS[index].color})"/>`
    + `<circle cx="17" cy="19" r="8" fill="${INK}"/><circle cx="47" cy="19" r="8" fill="${INK}"/>`
    + `<ellipse cx="32" cy="36" rx="20" ry="17.5" fill="#fff"/>${FACES[index % FACES.length].art}</svg>`;
}

/** `color` overrides the panda's own. Pickers tint only their own swatches, never an avatar beside them. */
export function botAvatarHtml(avatar: string, name: string, cls = '', color = ''): string {
  const value = avatar.trim();
  const art = pandaSvg(value) || (IMAGE.test(value) ? `<img alt="" src="${value}">` : '');
  const content = art || escape(value || name.trim().slice(0, 1).toUpperCase() || '?');
  const tint = COLOR.test(color) ? ` style="--panda-bg:${color};--bot-color:${color}"` : '';
  return `<span class="bot-avatar${art ? ' has-art' : ''}${cls ? ` ${cls}` : ''}"${tint} aria-hidden="true">${content}</span>`;
}

function customSwatch(url: string, pressed: boolean): string {
  return `<button type="button" class="avatar-swatch" data-avatar-choice="custom" aria-pressed="${pressed}" aria-label="Uploaded image"><img alt="" src="${url}"></button>`;
}

/** One face per kind, on the current color: picking a face never changes the color. */
export function avatarPicker(current: string, color = ''): string {
  const index = pandaIndex(current);
  const shown = (face: number) => index >= 0 && index % FACES.length === face ? current : `panda:${face}`;
  const swatches = FACES.map((face, i) => `<button type="button" class="avatar-swatch" data-avatar-choice="${shown(i)}" aria-pressed="${shown(i) === current}" aria-label="${face.name} panda">${pandaSvg(shown(i))}</button>`).join('');
  return `<div class="avatar-picker" role="group" aria-label="Face" style="${COLOR.test(color) ? `--panda-bg:${color}` : ''}"><input type="hidden" name="avatar" value="${escape(current)}">${swatches}`
    + `${IMAGE.test(current) ? customSwatch(current, true) : ''}<button type="button" class="avatar-upload" data-avatar-upload-button>Upload…</button>`
    + `<input type="file" hidden accept="${UPLOAD_TYPES.join(',')}" data-avatar-upload><span class="avatar-error" role="alert" hidden></span></div>`;
}

/** Automatic (the panda's own color) and each preset hue. */
export function colorPicker(current: string): string {
  const swatch = (value: string, label: string, fill: string) => `<button type="button" class="color-swatch${value ? '' : ' auto'}" data-color-choice="${value}" aria-pressed="${value === current}" aria-label="${label}" title="${label}" style="${fill}"></button>`;
  return `<div class="color-picker" role="group" aria-label="Color"><input type="hidden" name="color" value="${escape(COLOR.test(current) ? current : '')}">`
    + swatch('', 'Automatic', '') + PANDAS.map(p => swatch(p.color, p.name, `background:${p.color}`)).join('') + '</div>';
}

function choose(picker: HTMLElement, swatch: HTMLElement, value: string): void {
  const hidden = picker.querySelector<HTMLInputElement>('input[type=hidden]')!;
  hidden.value = value;
  for (const item of picker.querySelectorAll('[data-avatar-choice],[data-color-choice]')) item.setAttribute('aria-pressed', String(item === swatch));
  if (picker.matches('.color-picker')) {
    // Faces in the same form follow the color, so the row previews what the bot will look like.
    picker.closest('form')?.querySelector<HTMLElement>('.avatar-picker')?.style.setProperty('--panda-bg', value || 'initial');
  }
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

/** Call first from the host's click and change listeners; true when a picker handled the event. */
export function handleAvatarPicker(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const picker = target.closest<HTMLElement>('.avatar-picker,.color-picker');
  if (!picker) return false;
  if (event.type === 'change') {
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-avatar-upload]')) return false;
    void upload(picker, target);
    return true;
  }
  if (event.type !== 'click') return false;
  if (target.closest('[data-avatar-upload-button]')) { picker.querySelector<HTMLInputElement>('[data-avatar-upload]')!.click(); return true; }
  const swatch = target.closest<HTMLElement>('[data-avatar-choice],[data-color-choice]');
  if (!swatch) return false;
  const choice = swatch.dataset.avatarChoice ?? swatch.dataset.colorChoice!;
  choose(picker, swatch, choice === 'custom' ? swatch.querySelector('img')!.getAttribute('src')! : choice);
  return true;
}
