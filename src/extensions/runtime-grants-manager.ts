/**
 * Settings -> Extensions: review and manage what each package may do (runtime phase R1).
 *
 * The user sees the persisted effective grant per package and permission, and grants, narrows or revokes it. Every
 * change goes to the native store (`extensions_runtime_grant`), which re-checks it and answers the new projection;
 * this module only draws that projection. It holds no authority: a held grant is never confirmed per action, and a
 * request naming a permission the package does not declare is refused natively (`PermissionDenied`).
 */
import { escape } from '../dom';
import { changeRuntimeGrant, loadRuntimeGrants, scopeDimensions, UNAVAILABLE_GRANTS, type GrantChange, type GrantScope, type GrantsProjection, type PackageGrants } from './runtime-grants';
import { extensionProjects, onExtensionsChanged } from './manager';

const projectName = (id: string) => extensionProjects().find(project => project.id === id)?.name ?? `unavailable project ${id}`;
/** The effective scope of one grant, as the user reads it. */
export function describeScope(permission: string, scope: GrantScope): string {
  const dimensions = scopeDimensions(permission);
  if (!dimensions.length) return 'Granted';
  const parts = [
    dimensions.includes('projects') ? (scope.projects ? `Projects: ${scope.projects.map(projectName).join(', ')}` : 'All projects') : '',
    dimensions.includes('toolKinds') ? (scope.toolKinds ? `Tool kinds: ${scope.toolKinds.join(', ')}` : 'All tool kinds') : '',
    dimensions.includes('items') ? (scope.items ? `Credential items: ${scope.items.join(', ')}` : 'All declared credential items') : '',
  ].filter(Boolean);
  return `Granted · ${parts.join(' · ')}`;
}
/** Why a package holds no authority now, or an empty string when it does. */
export function suspension(item: PackageGrants): string {
  if (item.authorized) return '';
  if (item.archived) return 'Suspended: disabled, archived or in safe mode. Grants are kept but carry no authority.';
  return 'Suspended: executable content is not trusted. Grants are kept; review executable trust to resume.';
}
const split = (value: string) => value.split(',').map(entry => entry.trim()).filter(Boolean);

function permissionRow(item: PackageGrants, permission: string, off: string): string {
  const grant = item.grants.find(entry => entry.permission === permission);
  const owner = escape(item.id), name = escape(permission), dimensions = scopeDimensions(permission);
  const state = grant ? describeScope(permission, grant.scope) : 'Not granted';
  const label = (verb: string) => `${verb} ${name} for ${owner}`;
  let editor = '';
  if (dimensions.length) {
    const known = extensionProjects().map(project => project.id), chosen = grant?.scope.projects ?? [];
    const listed = [...known, ...chosen.filter(id => !known.includes(id))];
    editor = `<fieldset data-grant-scope><legend>Scope of ${name}</legend>
      ${dimensions.includes('projects') ? `<div role="group" aria-label="Projects for ${name} of ${owner}">${listed.map(project => `<label><input type="checkbox" data-grant-project="${escape(project)}" ${chosen.includes(project) ? 'checked' : ''} ${off}> ${escape(projectName(project))}</label>`).join('') || '<small>No projects are open.</small>'}<small>None checked means every project.</small></div>` : ''}
      ${dimensions.includes('toolKinds') ? `<label>Tool kinds <input type="text" data-grant-tool-kinds value="${escape((grant?.scope.toolKinds ?? []).join(', '))}" aria-label="Tool kinds for ${name} of ${owner}" placeholder="all tool kinds" ${off}></label>` : ''}
      ${dimensions.includes('items') ? `<label>Credential items <input type="text" data-grant-items value="${escape((grant?.scope.items ?? []).join(', '))}" aria-label="Credential items for ${name} of ${owner}" placeholder="all declared items" ${off}></label>` : ''}</fieldset>`;
  }
  return `<div class="setting-row" data-grant-row="${name}"><div><strong>${name}</strong><small data-grant-state>${escape(state)}</small></div>${editor}
    <button type="button" class="secondary-button" data-grant-op="grant" aria-label="${label(grant ? 'Save grant of' : 'Grant')}" ${off}>${grant ? 'Save grant' : 'Grant'}</button>
    ${grant && dimensions.length ? `<button type="button" class="secondary-button" data-grant-op="narrow" aria-label="${label('Narrow')}" ${off}>Narrow</button>` : ''}
    ${grant ? `<button type="button" class="secondary-button" data-grant-op="revoke" aria-label="${label('Revoke')}" ${off}>Revoke</button>` : ''}</div>`;
}
function packageSection(item: PackageGrants, off: string): string {
  const owner = escape(item.id);
  if (!item.declared.length) return `<section data-grants-package="${owner}" aria-label="Permissions of ${owner}"><h4>${owner} ${escape(item.version)}</h4><p data-grants-none>Declares no permissions; nothing to grant.</p></section>`;
  const ungranted = item.declared.filter(name => !item.grants.some(grant => grant.permission === name));
  const note = suspension(item);
  return `<section data-grants-package="${owner}" aria-label="Permissions of ${owner}"><h4>${owner} ${escape(item.version)}</h4>
    ${note ? `<p role="status" data-grants-suspended>${escape(note)}</p>` : ''}
    ${ungranted.length ? `<p role="status" data-grants-pending>Needs your review, not granted yet: ${ungranted.map(escape).join(', ')}. The package cannot use ${ungranted.length === 1 ? 'it' : 'them'} until you grant ${ungranted.length === 1 ? 'it' : 'them'}.</p>` : ''}
    ${item.declared.map(permission => permissionRow(item, permission, off)).join('')}
    ${item.grants.length ? `<button type="button" class="secondary-button" data-grant-op="revokeAll" aria-label="Revoke all permissions of ${owner}" ${off}>Revoke all</button>` : ''}</section>`;
}

/** Mounts the grants review into `host`; returns its disposer. */
export function mountGrantsManager(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '', projection: GrantsProjection = UNAVAILABLE_GRANTS;
  const draw = () => {
    if (disposed) return;
    const off = pending ? 'disabled' : '';
    host.innerHTML = `<h3>Permissions</h3><p>A package can use only what you grant here. A permission you have granted is never asked about again for each action; revoking or narrowing it stops that work at once.</p>
      ${!projection.available ? '<p role="status">Permission grants are unavailable; no package holds authority.</p>' : ''}
      ${projection.packages.map(item => packageSection(item, off)).join('')}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}`;
  };
  const refresh = async () => { try { projection = await loadRuntimeGrants(); } finally { draw(); } };
  const read = (row: HTMLElement): GrantScope => {
    const scope: GrantScope = {};
    const projects = [...row.querySelectorAll<HTMLInputElement>('[data-grant-project]')].filter(input => input.checked).map(input => input.dataset.grantProject!);
    if (projects.length) scope.projects = projects;
    const kinds = split(row.querySelector<HTMLInputElement>('[data-grant-tool-kinds]')?.value ?? ''); if (kinds.length) scope.toolKinds = kinds;
    const items = split(row.querySelector<HTMLInputElement>('[data-grant-items]')?.value ?? ''); if (items.length) scope.items = items;
    return scope;
  };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-grant-op]') : null;
    const section = button?.closest<HTMLElement>('[data-grants-package]');
    if (!button || !section || pending || !host.contains(button)) return;
    const id = section.dataset.grantsPackage!, op = button.dataset.grantOp as GrantChange['op'];
    const row = button.closest<HTMLElement>('[data-grant-row]'), permission = row?.dataset.grantRow;
    const change: GrantChange | null = op === 'revokeAll' ? { op, id } : !permission ? null : op === 'revoke' ? { op, id, permission } : { op, id, permission, scope: read(row!) };
    if (!change) return;
    pending = true; error = ''; draw();
    try { projection = await changeRuntimeGrant(change); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); try { projection = await loadRuntimeGrants(); } catch { /* keep the last projection */ } }
    finally {
      pending = false; draw();
      if (!disposed) {
        const again = [...host.querySelectorAll<HTMLElement>('[data-grants-package]')].find(node => node.dataset.grantsPackage === id);
        const target = permission && again ? [...again.querySelectorAll<HTMLElement>('[data-grant-row]')].find(node => node.dataset.grantRow === permission)?.querySelector<HTMLButtonElement>('[data-grant-op]') : again?.querySelector<HTMLButtonElement>('[data-grant-op]');
        (target ?? host.querySelector<HTMLElement>('[role="alert"]'))?.focus({ preventScroll: true });
      }
    }
  };
  host.addEventListener('click', click);
  const unsubscribe = onExtensionsChanged(() => { if (!pending) void refresh(); });
  draw(); void refresh();
  return () => { disposed = true; unsubscribe(); host.removeEventListener('click', click); host.replaceChildren(); };
}
