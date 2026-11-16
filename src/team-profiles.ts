import { call } from './bridge';
import { icon, isImeKey } from './dom';
import { openChoiceMenu } from './choice-menu';
import type { TeamLibrary, TeamProfile, TeamSetup } from './architect-types';
import { sameTeamSetup } from './team-mode';

/** A team profile was saved or deleted; `detail` is the new library. main.ts listens (by name, to keep this module lazy). */
export const TEAMS_CHANGED_EVENT = 'pandacode:teams-changed';
export function teamsChanged(library: TeamLibrary): void {
  window.dispatchEvent(new CustomEvent(TEAMS_CHANGED_EVENT, { detail: library }));
}

/** Reusable templates stay local until the setup form applies the draft. */
export function mountTeamProfiles(host: HTMLElement, options: {
  library: TeamLibrary;
  pendingSetup?: TeamSetup | null;
  read: () => TeamSetup;
  apply: (setup: TeamSetup) => void;
  busy: (value: boolean) => void;
}): { selectedId: () => string | null; changed: () => void; dispose: () => void; hasMenu: () => boolean } {
  let library = structuredClone(options.library), disposed = false, pending = false;
  let menu: (() => void) | undefined, edit: 'create' | 'rename' | undefined;
  let selected = library.profiles.find(profile => profile.id === library.activeProfileId && sameTeamSetup(profile.setup, options.read()))?.id
    ?? library.profiles.find(profile => sameTeamSetup(profile.setup, options.read()))?.id ?? null;
  host.className = 'team-library';
  host.innerHTML = `<div class="team-library-heading"><span>Team profile</span><span class="team-library-state" role="status"></span></div><div class="team-library-row"><button type="button" class="team-library-picker" aria-label="Choose team profile" aria-haspopup="dialog" aria-expanded="false"><span></span>${icon('down')}</button><button type="button" class="icon-button team-library-manage" aria-label="Manage team profile" aria-haspopup="dialog">${icon('more')}</button></div><div class="team-library-actions"><button type="button" class="team-library-create">${icon('plus')} Save as…</button><button type="button" class="team-library-update" hidden>Update profile</button></div><div class="team-library-editor" hidden><label>Profile name<input type="text" maxlength="80" autocomplete="off" aria-label="Profile name"></label><div><button type="button" class="secondary-button team-library-cancel">Cancel</button><button type="button" class="primary-button team-library-confirm">Save profile</button></div></div><p class="team-library-error" role="alert" hidden></p>`;
  const picker = host.querySelector<HTMLButtonElement>('.team-library-picker')!;
  const manage = host.querySelector<HTMLButtonElement>('.team-library-manage')!;
  const create = host.querySelector<HTMLButtonElement>('.team-library-create')!;
  const update = host.querySelector<HTMLButtonElement>('.team-library-update')!;
  const status = host.querySelector<HTMLElement>('.team-library-state')!;
  const editor = host.querySelector<HTMLElement>('.team-library-editor')!;
  const name = editor.querySelector<HTMLInputElement>('input')!;
  const confirm = editor.querySelector<HTMLButtonElement>('.team-library-confirm')!;
  const error = host.querySelector<HTMLElement>('.team-library-error')!;
  const current = (): TeamProfile | undefined => library.profiles.find(profile => profile.id === selected);
  const showError = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false; };
  function refresh(): void {
    if (disposed) return;
    const profile = current(), setup = options.read();
    const modified = !!profile && !sameTeamSetup(profile.setup, setup);
    picker.querySelector('span')!.textContent = profile?.name ?? (library.lastSetup && sameTeamSetup(library.lastSetup, setup) ? 'Last saved setup' : 'Custom setup');
    picker.disabled = pending || (!library.profiles.length && !library.lastSetup);
    picker.title = 'Choose a saved team';
    manage.disabled = pending || !profile;
    create.disabled = pending;
    update.hidden = !modified;
    update.disabled = pending;
    status.textContent = modified ? 'Modified' : options.pendingSetup && sameTeamSetup(options.pendingSetup, setup) ? 'Pending' : profile ? 'Saved' : '';
  }
  function closeEditor(): void { edit = undefined; editor.hidden = true; error.hidden = true; }
  function editName(mode: 'create' | 'rename'): void {
    edit = mode; editor.hidden = false; error.hidden = true;
    name.value = mode === 'rename' ? current()?.name ?? '' : '';
    confirm.textContent = mode === 'rename' ? 'Rename profile' : 'Save profile';
    name.focus(); name.select();
  }
  async function mutate(action: () => Promise<TeamLibrary>, after?: () => void): Promise<void> {
    if (pending || disposed) return;
    pending = true; error.hidden = true; menu?.(); options.busy(true);
    try {
      library = await action();
      teamsChanged(library);
      if (!disposed) { after?.(); closeEditor(); }
    } catch (cause) { if (!disposed) showError(cause); }
    finally { pending = false; if (!disposed) { options.busy(false); refresh(); } }
  }
  picker.addEventListener('click', () => {
    if (menu) { menu(); return; }
    // Named agent teams live in Settings and the model picker, not among classic profiles.
    const profiles = library.profiles.filter(profile => !profile.setup.config.rosterOnly);
    const items = profiles.map(profile => ({ id: profile.id, label: profile.name, provider: profile.setup.architect.provider,
      description: `${profile.setup.config.workers.length} worker model${profile.setup.config.workers.length === 1 ? '' : 's'} · ${profile.setup.config.maxParallel === 0 ? 'Unlimited at once' : `${profile.setup.config.maxParallel} at once`}`, selected: selected === profile.id }));
    if (library.lastSetup) items.unshift({ id: 'last-saved', label: 'Last saved setup', provider: library.lastSetup.architect.provider,
      description: library.enabled ? 'Default for new tasks' : 'Remembered · single agent default', selected: !selected && sameTeamSetup(library.lastSetup, options.read()) });
    menu = openChoiceMenu({ anchor: picker, title: 'Team profiles', items, width: 310,
      searchPlaceholder: profiles.length > 5 ? 'Search profiles…' : undefined,
      onSelect: choose, onClose: () => { menu = undefined; },
    });
  });
  /** The picker's choices: classic profiles (named agent teams live elsewhere) and the last saved setup. */
  function choices(): { id: string; selected: boolean }[] {
    const items = library.profiles.filter(profile => !profile.setup.config.rosterOnly).map(profile => ({ id: profile.id, selected: selected === profile.id }));
    return library.lastSetup ? [{ id: 'last-saved', selected: !selected && sameTeamSetup(library.lastSetup, options.read()) }, ...items] : items;
  }
  /** A fresh host choice before an extension's profile action. It counts as this form's menu, so the setup stays
   * open while it shows; Escape or a click elsewhere declines it. */
  function hostChoice(label: string, run: () => void): void {
    if (pending || disposed) return;
    menu?.();
    menu = openChoiceMenu({ anchor: picker, title: 'Extension requested a roster action', items: [{ id: 'continue', label: `Continue: ${label}`, icon: 'play' }],
      onSelect: id => { if (id === 'continue' && !disposed && !pending) run(); }, onClose: () => { menu = undefined; } });
  }
  /** Applies a choice to the setup form: the picker's own selection handler. */
  function choose(id: string): void {
    const setup = id === 'last-saved' ? library.lastSetup : library.profiles.find(profile => profile.id === id && !profile.setup.config.rosterOnly)?.setup;
    if (!setup) throw new Error('This profile is no longer available.');
    options.apply(structuredClone(setup)); selected = id === 'last-saved' ? library.activeProfileId : id;
    closeEditor(); refresh();
  }
  create.addEventListener('click', () => editName('create'));
  editor.querySelector('.team-library-cancel')!.addEventListener('click', () => { closeEditor(); create.focus(); });
  function saveNamed(): void {
    const trimmed = name.value.trim();
    if (!trimmed) { showError(new Error('Give this team profile a name.')); name.focus(); return; }
    const id = edit === 'rename' ? current()?.id : undefined;
    const setup = edit === 'rename' ? current()?.setup : options.read();
    if (!setup) return;
    void mutate(() => call<TeamLibrary>('architect_save_profile', { id, name: trimmed, setup }), () => {
      selected = id ?? library.profiles.find(profile => profile.name === trimmed)?.id ?? null;
    });
  }
  confirm.addEventListener('click', saveNamed);
  name.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); event.stopPropagation(); saveNamed(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeEditor(); create.focus(); }
  });
  update.addEventListener('click', () => {
    const profile = current(); if (!profile) return;
    void mutate(() => call<TeamLibrary>('architect_save_profile', { id: profile.id, name: profile.name, setup: options.read() }));
  });
  manage.addEventListener('click', () => {
    if (menu) { menu(); return; }
    const profile = current(); if (!profile) return;
    menu = openChoiceMenu({ anchor: manage, title: 'Profile actions', actions: true, items: [
      { id: 'rename', label: 'Rename profile', icon: 'edit' }, { id: 'delete', label: 'Delete profile', icon: 'close' },
    ], onSelect: id => {
      if (id === 'rename') { menu?.(); editName('rename'); }
      else void mutate(() => call<TeamLibrary>('architect_delete_profile', { id: profile.id }), () => { selected = null; });
    }, onClose: () => { menu = undefined; } });
  });
  refresh();
  const selectedId = () => { const profile = current(); return profile && sameTeamSetup(profile.setup, options.read()) ? profile.id : null; };
  const view: TeamProfilesView = { host, selectedId, choices, choose, confirm: hostChoice, pending: () => pending, hasMenu: () => Boolean(menu) };
  mounted = view; dispatchEvent(new Event(TEAM_PROFILES_EVENT));
  return {
    selectedId,
    changed: refresh,
    hasMenu: () => Boolean(menu),
    dispose: () => { disposed = true; menu?.(); if (mounted === view) { mounted = undefined; dispatchEvent(new Event(TEAM_PROFILES_EVENT)); } },
  };
}

/** Host-only view of the mounted profile library for presentation adoption (docs/extensions/agent-roster.md). */
export type TeamProfilesView = { host: HTMLElement; selectedId: () => string | null; choices: () => { id: string; selected: boolean }[]; choose: (id: string) => void; confirm: (label: string, run: () => void) => void; pending: () => boolean; hasMenu: () => boolean };
export const TEAM_PROFILES_EVENT = 'pandacode:team-profiles';
let mounted: TeamProfilesView | undefined;
/** The library of the open team setup, while its form is in the page. */
export function activeTeamProfiles(): TeamProfilesView | undefined { return mounted?.host.isConnected ? mounted : undefined; }
