import './theme-settings.css';
import { escape, icon } from './dom';
import { CLASSIC, SWATCHES, palette, type AccentChoice, type VsixTheme } from './palette';
import { t } from './i18n.ts';

/* Colors: the accent (wallpaper, classic, a swatch or any color) and VS Code themes
 * imported from a .vsix or installed from Open VSX by extension ID. */

export type ThemeSettingsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  chooseVsix(): Promise<string | null>;
  notify(text: string): void;
};
const SWATCH_NAMES = [t('Blue'), t('Green'), t('Purple'), t('Pink'), t('Orange'), t('Teal')];

/** One line for the settings row. */
export function colorsSummary(): string {
  if (palette.vsix) return t`${palette.vsix.name} · VS Code theme`;
  const accent = palette.accent;
  if (accent.mode === 'wallpaper') return t('Accent follows the wallpaper');
  if (accent.mode === 'classic') return t('Classic yellow accent');
  const index = SWATCHES.indexOf(accent.color);
  return t`${index >= 0 ? SWATCH_NAMES[index] : t('Custom')} accent`;
}

const swatchesOf = (theme: VsixTheme) => ['editor.background', 'sideBar.background', 'editor.foreground', 'button.background', 'focusBorder']
  .map(key => theme.colors[key]).filter(Boolean).slice(0, 4);

export function mountThemeSettings(host: HTMLElement, options: ThemeSettingsHost): () => void {
  let themes: VsixTheme[] = [], busy = false, disposed = false;
  host.innerHTML = `<section class="colors-section" aria-labelledby="accent-heading">
      <h3 id="accent-heading">${t('Accent')}</h3>
      <div class="accent-choices" role="radiogroup" aria-labelledby="accent-heading"></div>
      <p class="colors-note" hidden>${t('A VS Code theme is active, so its own colors are used and wallpapers no longer change them.')}</p>
    </section>
    <section class="colors-section" aria-labelledby="vsix-heading">
      <h3 id="vsix-heading">${t('VS Code theme')}</h3>
      <div class="vsix-list" role="radiogroup" aria-labelledby="vsix-heading" aria-busy="true"></div>
      <div class="vsix-actions">
        <button type="button" class="secondary-button" data-colors="import">${icon('download')}${t('Import .vsix…')}</button>
        <form class="vsix-install"><input name="extension" placeholder="publisher.extension" aria-label="${t('Open VSX extension ID')}" autocomplete="off" spellcheck="false" maxlength="201" required><button class="secondary-button">${t('Install')}</button></form>
      </div>
      <p class="vsix-status" role="status" aria-live="polite"></p>
    </section>`;
  const accents = host.querySelector<HTMLElement>('.accent-choices')!, list = host.querySelector<HTMLElement>('.vsix-list')!;
  const status = host.querySelector<HTMLElement>('.vsix-status')!;
  const say = (text: string) => { status.textContent = text; };

  function renderAccents(): void {
    const current = palette.accent, locked = Boolean(palette.vsix);
    const checked = (choice: AccentChoice) => !locked && (choice.mode === current.mode && (choice.mode !== 'custom' || (current.mode === 'custom' && current.color === choice.color)));
    const custom = current.mode === 'custom' && !SWATCHES.includes(current.color) ? current.color : '#4f8ef7';
    const option = (choice: AccentChoice, label: string, swatch: string, extra = '') => `<button type="button" role="radio" class="accent-choice" aria-checked="${checked(choice)}" data-accent='${escape(JSON.stringify(choice))}' ${locked ? 'disabled' : ''} ${extra}><span class="accent-swatch" style="--swatch:${escape(swatch)}"></span><span>${label}</span></button>`;
    accents.innerHTML = [
      option({ mode: 'wallpaper' }, t('Wallpaper'), palette.wallpaperAccent ?? CLASSIC, `title="${t('The most vivid color of the current wallpaper')}"`),
      option({ mode: 'classic' }, t('Classic'), CLASSIC),
      ...SWATCHES.map((color, i) => option({ mode: 'custom', color }, SWATCH_NAMES[i], color)),
      `<label class="accent-choice accent-custom ${current.mode === 'custom' && !SWATCHES.includes(current.color) && !locked ? 'accent-custom-on' : ''}"><span class="accent-swatch" style="--swatch:${escape(custom)}"></span><span>${t('Custom')}</span><input type="color" value="${escape(custom)}" aria-label="${t('Custom accent color')}" ${locked ? 'disabled' : ''}></label>`,
    ].join('');
    host.querySelector<HTMLElement>('.colors-note')!.hidden = !locked;
  }
  function renderThemes(): void {
    const active = palette.vsix?.id ?? '';
    const row = (theme: VsixTheme | null) => {
      const id = theme?.id ?? '';
      const swatches = theme ? swatchesOf(theme).map(color => `<i style="--swatch:${escape(color)}"></i>`).join('') : '<i class="vsix-bamboo"></i>';
      return `<div class="vsix-row"><button type="button" role="radio" class="vsix-choice" aria-checked="${id === active}" data-theme-id="${escape(id)}"><span class="vsix-swatches" aria-hidden="true">${swatches}</span><span class="vsix-name"><strong>${escape(theme?.name ?? 'PandaCode')}</strong><small>${escape(theme ? t`${theme.extension} · ${theme.kind === 'dark' ? t('Dark') : t('Light')}` : t('Built in · accent and wallpaper apply'))}</small></span></button>${theme ? `<button type="button" class="icon-button vsix-remove" data-remove="${escape(id)}" aria-label="${t`Remove ${escape(theme.name)}`}" title="${t('Remove')}">${icon('trash')}</button>` : ''}</div>`;
    };
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = row(null) + themes.map(row).join('') + (themes.length ? '' : `<p class="vsix-empty">${t('Import a .vsix or install one by ID, such as')} <code>dracula-theme.theme-dracula</code>.</p>`);
  }
  async function load(): Promise<void> {
    try { themes = await options.call<VsixTheme[]>('themes_list'); }
    catch (error) { say(error instanceof Error ? error.message : String(error)); }
    if (!disposed) renderThemes();
  }
  async function added(promise: Promise<VsixTheme[]>, source: string): Promise<void> {
    if (busy) return;
    busy = true; say(t`Installing ${source}…`);
    host.querySelectorAll<HTMLButtonElement>('.vsix-actions button').forEach(button => { button.disabled = true; });
    try {
      const fresh = await promise;
      themes = [...themes.filter(theme => !fresh.some(item => item.id === theme.id)), ...fresh].sort((a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name));
      palette.setVsix(fresh[0]);
      say(t`Added ${fresh.length === 1 ? fresh[0].name : t`${fresh.length} themes from ${fresh[0].extension}`}. Using ${fresh[0].name}.`);
      renderThemes(); renderAccents();
    } catch (error) { say(error instanceof Error ? error.message : String(error)); }
    finally { busy = false; host.querySelectorAll<HTMLButtonElement>('.vsix-actions button').forEach(button => { button.disabled = false; }); }
  }

  host.addEventListener('click', event => {
    const target = event.target as Element;
    const accent = target.closest<HTMLButtonElement>('[data-accent]');
    if (accent && !accent.disabled) { palette.setAccent(JSON.parse(accent.dataset.accent!)); renderAccents(); return; }
    const choice = target.closest<HTMLButtonElement>('[data-theme-id]');
    if (choice) { palette.setVsix(themes.find(theme => theme.id === choice.dataset.themeId) ?? null); renderThemes(); renderAccents(); return; }
    const remove = target.closest<HTMLButtonElement>('[data-remove]');
    if (remove) {
      const id = remove.dataset.remove!;
      void options.call('theme_remove', { id }).then(() => {
        themes = themes.filter(theme => theme.id !== id);
        if (palette.vsix?.id === id) palette.setVsix(null);
        renderThemes(); renderAccents(); say(t('Theme removed.'));
      }).catch(error => say(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (target.closest('[data-colors="import"]')) {
      void options.chooseVsix().then(path => { if (path) void added(options.call<VsixTheme[]>('theme_import', { path }), path.split(/[\\/]/).pop() ?? t('theme')); });
    }
  });
  host.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.type === 'color') palette.setAccent({ mode: 'custom', color: input.value });
  });
  host.addEventListener('change', event => { if ((event.target as HTMLInputElement).type === 'color') renderAccents(); });
  host.querySelector<HTMLFormElement>('.vsix-install')!.addEventListener('submit', event => {
    event.preventDefault();
    const input = (event.target as HTMLFormElement).querySelector<HTMLInputElement>('input')!, id = input.value.trim();
    if (id) void added(options.call<VsixTheme[]>('theme_install', { extensionId: id }), id).then(() => { if (!busy) input.value = ''; });
  });
  const onPalette = () => { if (!disposed) renderAccents(); };
  window.addEventListener('pandacode-palette-change', onPalette);
  renderAccents();
  void load();
  return () => { disposed = true; window.removeEventListener('pandacode-palette-change', onPalette); };
}
