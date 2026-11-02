import './theme-settings.css';
import { escape, icon } from './dom';
import { oklch, toHex } from './color';
import { BUILTIN_THEMES, builtinTokens, CLASSIC, SWATCHES, palette, type BuiltinTheme, type AccentChoice, type VsixTheme } from './palette';

/* Colors: the accent (wallpaper, classic, a swatch or any color) and VS Code themes
 * imported from a .vsix or installed from Open VSX by extension ID. */

export type ThemeSettingsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  chooseVsix(): Promise<string | null>;
  notify(text: string): void;
};
const SWATCH_NAMES = ['Blue', 'Green', 'Purple', 'Pink', 'Orange', 'Teal'];

/** One line for the settings row. */
export function colorsSummary(): string {
  if (palette.vsix) return `${palette.vsix.name} · VS Code theme`;
  const accent = palette.accent;
  if (palette.builtin !== 'system') return `${BUILTIN_THEMES.find(theme => theme.id === palette.builtin)!.name} palette`;
  if (accent.mode === 'wallpaper') return 'Accent follows the wallpaper';
  if (accent.mode === 'classic') return 'Classic yellow accent';
  const index = SWATCHES.indexOf(accent.color);
  return `${index >= 0 ? SWATCH_NAMES[index] : 'Custom'} accent`;
}

const swatchesOf = (theme: VsixTheme) => ['editor.background', 'sideBar.background', 'editor.foreground', 'button.background', 'focusBorder']
  .map(key => theme.colors[key]).filter(Boolean).slice(0, 4);

export function mountThemeSettings(host: HTMLElement, options: ThemeSettingsHost): () => void {
  let themes: VsixTheme[] = [], busy = false, disposed = false;
  host.innerHTML = `<section class="colors-section" aria-labelledby="builtin-heading">
      <h3 id="builtin-heading">Theme</h3>
      <p class="builtin-note">Choose a palette for your workspace. Themes adapt to light and dark. Changes save automatically.</p>
      <div class="builtin-themes" role="radiogroup" aria-labelledby="builtin-heading"></div>
    </section><section class="colors-section" aria-labelledby="accent-heading">
      <h3 id="accent-heading">Accent</h3>
      <div class="accent-choices" role="radiogroup" aria-labelledby="accent-heading"></div>
      <p class="colors-note" hidden>A VS Code theme is active, so its own colors are used and wallpapers no longer change them.</p>
    </section>
    <section class="colors-section" aria-labelledby="vsix-heading">
      <h3 id="vsix-heading">VS Code theme</h3>
      <div class="vsix-list" role="radiogroup" aria-labelledby="vsix-heading" aria-busy="true"></div>
      <div class="vsix-actions">
        <button type="button" class="secondary-button" data-colors="import">${icon('download')}Import .vsix…</button>
        <form class="vsix-install"><input name="extension" placeholder="publisher.extension" aria-label="Open VSX extension ID" autocomplete="off" spellcheck="false" maxlength="201" required><button class="secondary-button">Install</button></form>
      </div>
      <p class="vsix-status" role="status" aria-live="polite"></p>
    </section>`;
  const accents = host.querySelector<HTMLElement>('.accent-choices')!, list = host.querySelector<HTMLElement>('.vsix-list')!;
  const status = host.querySelector<HTMLElement>('.vsix-status')!;
  const say = (text: string) => { status.textContent = text; };

  function renderBuiltins(): void {
    const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    host.querySelector<HTMLElement>('.builtin-themes')!.innerHTML = BUILTIN_THEMES.map(theme => {
      const tokens = theme.id === 'system' ? {
        '--bg': toHex(oklch(mode === 'dark' ? 0.23 : 0.985, 0, 0)),
        '--sidebar': toHex(oklch(mode === 'dark' ? 0.28 : 0.95, 0, 0)),
        '--raised': toHex(oklch(mode === 'dark' ? 0.32 : 0.92, 0, 0)),
      } : builtinTokens(theme.id, mode);
      const style = Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');
      const checked = !palette.vsix && palette.builtin === theme.id;
      return `<button type="button" role="radio" class="builtin-theme" data-builtin="${theme.id}" tabindex="${checked || (palette.vsix && theme.id === 'system') ? 0 : -1}" aria-checked="${checked}"><span class="builtin-preview" style="${escape(style)}" aria-hidden="true"><span class="builtin-mini-sidebar"><i></i><i></i><i></i></span><span class="builtin-mini-thread"><i></i><i></i><b></b></span><span class="builtin-check">${icon('check')}</span></span><span>${theme.name}</span></button>`;
    }).join('');
  }
  function renderAccents(): void {
    renderBuiltins();
    const summary = host.closest('.settings-panel')?.querySelector('.settings-colors-summary');
    if (summary) summary.textContent = colorsSummary();
    const current = palette.accent, locked = Boolean(palette.vsix);
    const checked = (choice: AccentChoice) => !locked && (choice.mode === current.mode && (choice.mode !== 'custom' || (current.mode === 'custom' && current.color === choice.color)));
    const custom = current.mode === 'custom' && !SWATCHES.includes(current.color) ? current.color : '#4f8ef7';
    const option = (choice: AccentChoice, label: string, swatch: string, extra = '') => `<button type="button" role="radio" class="accent-choice" aria-checked="${checked(choice)}" data-accent='${escape(JSON.stringify(choice))}' ${locked ? 'disabled' : ''} ${extra}><span class="accent-swatch" style="--swatch:${escape(swatch)}"></span><span>${label}</span></button>`;
    accents.innerHTML = [
      option({ mode: 'wallpaper' }, 'Wallpaper', palette.wallpaperAccent ?? CLASSIC, 'title="The most vivid color of the current wallpaper"'),
      option({ mode: 'classic' }, 'Classic', CLASSIC),
      ...SWATCHES.map((color, i) => option({ mode: 'custom', color }, SWATCH_NAMES[i], color)),
      `<label class="accent-choice accent-custom ${current.mode === 'custom' && !SWATCHES.includes(current.color) && !locked ? 'accent-custom-on' : ''}"><span class="accent-swatch" style="--swatch:${escape(custom)}"></span><span>Custom</span><input type="color" value="${escape(custom)}" aria-label="Custom accent color" ${locked ? 'disabled' : ''}></label>`,
    ].join('');
    host.querySelector<HTMLElement>('.colors-note')!.hidden = !locked;
  }
  function renderThemes(): void {
    const active = palette.vsix?.id ?? '';
    const row = (theme: VsixTheme | null) => {
      const id = theme?.id ?? '';
      const swatches = theme ? swatchesOf(theme).map(color => `<i style="--swatch:${escape(color)}"></i>`).join('') : '<i class="vsix-bamboo"></i>';
      return `<div class="vsix-row"><button type="button" role="radio" class="vsix-choice" aria-checked="${id === active}" data-theme-id="${escape(id)}"><span class="vsix-swatches" aria-hidden="true">${swatches}</span><span class="vsix-name"><strong>${escape(theme?.name ?? 'PandaCode')}</strong><small>${escape(theme ? `${theme.extension} · ${theme.kind === 'dark' ? 'Dark' : 'Light'}` : `${BUILTIN_THEMES.find(theme => theme.id === palette.builtin)!.name} palette · accent and wallpaper apply`)}</small></span></button>${theme ? `<button type="button" class="icon-button vsix-remove" data-remove="${escape(id)}" aria-label="Remove ${escape(theme.name)}" title="Remove">${icon('trash')}</button>` : ''}</div>`;
    };
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = row(null) + themes.map(row).join('') + (themes.length ? '' : '<p class="vsix-empty">Import a .vsix or install one by ID, such as <code>dracula-theme.theme-dracula</code>.</p>');
  }
  async function load(): Promise<void> {
    try { themes = await options.call<VsixTheme[]>('themes_list'); }
    catch (error) { say(error instanceof Error ? error.message : String(error)); }
    if (!disposed) renderThemes();
  }
  async function added(promise: Promise<VsixTheme[]>, source: string): Promise<void> {
    if (busy) return;
    busy = true; say(`Installing ${source}…`);
    host.querySelectorAll<HTMLButtonElement>('.vsix-actions button').forEach(button => { button.disabled = true; });
    try {
      const fresh = await promise;
      themes = [...themes.filter(theme => !fresh.some(item => item.id === theme.id)), ...fresh].sort((a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name));
      palette.setVsix(fresh[0]);
      say(`Added ${fresh.length === 1 ? fresh[0].name : `${fresh.length} themes from ${fresh[0].extension}`}. Using ${fresh[0].name}.`);
      renderThemes(); renderAccents();
    } catch (error) { say(error instanceof Error ? error.message : String(error)); }
    finally { busy = false; host.querySelectorAll<HTMLButtonElement>('.vsix-actions button').forEach(button => { button.disabled = false; }); }
  }

  host.addEventListener('click', event => {
    const target = event.target as Element;
    const builtin = target.closest<HTMLButtonElement>('[data-builtin]');
    if (builtin) { palette.setBuiltin(builtin.dataset.builtin as BuiltinTheme); renderThemes(); renderAccents(); return; }
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
        renderThemes(); renderAccents(); say('Theme removed.');
      }).catch(error => say(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (target.closest('[data-colors="import"]')) {
      void options.chooseVsix().then(path => { if (path) void added(options.call<VsixTheme[]>('theme_import', { path }), path.split(/[\\/]/).pop() ?? 'theme'); });
    }
  });
  host.querySelector<HTMLElement>('.builtin-themes')!.addEventListener('keydown', event => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-builtin]')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    const id = buttons[next].dataset.builtin!;
    buttons[next].click();
    host.querySelector<HTMLButtonElement>(`[data-builtin="${id}"]`)!.focus();
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
