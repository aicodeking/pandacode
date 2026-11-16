/**
 * Code folders, the service environment and the package data directory (runtime slice R0105): the webview's mirror
 * of the native rules in `src-tauri/src/extensions/runtime_code_folders.rs` and `packages.rs`, used by the browser
 * preview and by author pre-checks.
 *
 * The authority is native: it validates archives, writes the checksum-qualified code directory, gives the service its
 * environment and creates the data directory. The preview runs no package code, so the answers here are labelled
 * synthetic stand-ins that follow the same rules (paths under a placeholder app data folder).
 */

const MIB = 1024 * 1024;
/** The package limits (`packages.rs`), measured in docs/extensions/runtime-code-folders.md. */
export const PACKAGE_LIMITS = Object.freeze({
  archive: 16 * MIB,
  file: 8 * MIB,
  expanded: 64 * MIB,
  files: 1024,
  /** The current archive and one more generation (staged update or rollback) in base64, plus 1 MiB of state. */
  record: 2 * Math.ceil((16 * MIB) / 3) * 4 + MIB,
});
export const MAX_CODE_FOLDERS = 8;
/** Placeholder app data folder of the preview's synthetic paths. */
export const PREVIEW_APP_DATA = '<app data>';

type Manifest = {
  runtime?: { entrypoint?: string; files?: unknown };
  contributes?: { icons?: { asset: string }[]; views?: { rich?: Record<string, string> }[] };
};

/** `^[a-z0-9][a-z0-9_-]*$`, at most 64 characters (the schema's `runtime.files` item). */
export const validCodeFolder = (name: unknown): name is string => typeof name === 'string' && name.length <= 64 && /^[a-z0-9][a-z0-9_-]*$/.test(name);
/** The declared code folders of a manifest. */
export const codeFolders = (manifest: Manifest): string[] => (Array.isArray(manifest.runtime?.files) ? manifest.runtime.files : []).filter(validCodeFolder).slice(0, MAX_CODE_FOLDERS);
/** `true` when the archive file `name` lies inside a declared code folder (exact, case-sensitive prefix). */
export function inCodeFolder(manifest: Manifest, name: string): boolean {
  const slash = name.indexOf('/');
  return slash > 0 && slash < name.length - 1 && codeFolders(manifest).includes(name.slice(0, slash));
}
/** The native declaration rule: the manifest, the entry point (with `runtime`), icons, rich-view assets and every file of a code folder. */
export function declaredPackageFile(manifest: Manifest, name: string): boolean {
  if (name === 'extension.json') return true;
  if (manifest.runtime && (name === 'main.cjs' || inCodeFolder(manifest, name))) return true;
  if ((manifest.contributes?.icons ?? []).some(icon => icon.asset === name)) return true;
  return (manifest.contributes?.views ?? []).some(view => !!view.rich && ['html', 'css', 'script'].some(key => view.rich![key] === name));
}

/** `<app data>/extension-code-v1/<package id>/<archive checksum>`: where the service of that generation runs. */
export const codeDirectory = (appData: string, id: string, checksum: string) => `${appData}/extension-code-v1/${id}/${checksum}`;

/** The service environment: the user's, without `NODE_OPTIONS` and the host's own `PANDACODE_*` variables (names compare without case). */
export function serviceEnvironment(parent: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => { const upper = name.toUpperCase(); return upper !== 'NODE_OPTIONS' && !upper.startsWith('PANDACODE_'); }));
}

export type DirectoryCaller = 'service' | 'activation' | 'panel';
export type DirectoryAnswer = { ok: true; value: { schemaVersion: 1; path: string } } | { ok: false; error: { code: 'UnsupportedCapability' | 'PermissionDenied' | 'InvalidShape' | 'StaleContext' } };
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * `panda.storage.directory({ scope })`: service only (a short activation or a panel answers `UnsupportedCapability`),
 * under the live `storage.private` grant; `project` needs the call's project context (`StaleContext` without one).
 */
export async function storageDirectory(request: { caller: DirectoryCaller; id: string; granted: boolean; options: unknown; projectId?: string | null; appData?: string }): Promise<DirectoryAnswer> {
  const fail = (code: 'UnsupportedCapability' | 'PermissionDenied' | 'InvalidShape' | 'StaleContext'): DirectoryAnswer => ({ ok: false, error: { code } });
  if (request.caller !== 'service') return fail('UnsupportedCapability');
  if (!request.granted) return fail('PermissionDenied');
  const options = request.options as Record<string, unknown> | null;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 1 || (options.scope !== 'global' && options.scope !== 'project')) return fail('InvalidShape');
  const base = `${request.appData ?? PREVIEW_APP_DATA}/extension-data-v1/${request.id}`;
  if (options.scope === 'global') return { ok: true, value: { schemaVersion: 1, path: `${base}/global` } };
  const project = request.projectId;
  if (!project || project.length > 256) return fail('StaleContext');
  return { ok: true, value: { schemaVersion: 1, path: `${base}/project-${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(project)))}` } };
}
