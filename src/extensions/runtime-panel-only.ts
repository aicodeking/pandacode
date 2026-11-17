/**
 * A package with panels and no background service (R0305, ADR-0001, contract G4): the browser twin of
 * `rich_views::runtime_panel_only` and the preview's page host.
 *
 * PREVIEW EVIDENCE, NOT NATIVE. A package may ship only panels: no `runtime`, no service, nothing in the Running list,
 * no process. Its pages use `pandaView.panda` as a service package's pages do; here the proxied calls run on the R0208
 * runner's page panda (`RuntimePreview.pageCall`), which is never started, so `starts` stays 0. `pandaView.postMessage`
 * answers `NO_SERVICE` and the service-only calls (`storage.directory` among them) are refused by the channel before
 * anything runs. What a page made (notices, live items, a waiting dialog) is the package's: a disable, safe mode,
 * untrust or a revoke of `ui.richViews` ends it once, whether the panel is mounted, closed or failed, closes the
 * package's instances without keeping their state, and gives the keyboard back to the app if a panel had it. These
 * rules are for predictability and fault isolation, never for trust (ADR-0005).
 *
 * Imports are pure at module load (the Node specs import this file); the app-only parts load their modules lazily.
 */
import { ChannelError, previewPanelHost, type Origin, type PanelService, type PreviewPanelHost } from './runtime-rich-channel';
import { createRuntimePreview, type Grants, type PreviewManifest, type PreviewOptions, type RuntimePreview } from './runtime-preview';

/** The reason the notices of an ended page are withdrawn with (twin of `runtime_panel_only::PAGE_ENDED`). */
export const PAGE_ENDED = 'panel-ended';
/** Dispatched by the preview's grant command (`runtime-rich-mount.ts` `GRANTS_CHANGED`; not imported, to keep this module pure). */
const GRANTS_CHANGED = 'pandacode-extension-grants-changed';

export type PanelOnlyManifest = PreviewManifest & { permissions?: readonly string[] };
type Views = { views?: readonly { id?: string; rich?: unknown }[] };

/** `true` for a package that declares at least one rich view and no background service (twin of `panel_only`). */
export function panelOnly(manifest: { runtime?: { service?: { start?: string } }; contributes?: unknown }): boolean {
  const views = (manifest.contributes as Views | undefined)?.views ?? [];
  return manifest.runtime?.service?.start !== 'onEnable' && views.some(view => view.rich !== undefined);
}

/** Twin of `PageWork`: packages (owner, version) whose pages made at least one host call. */
export class PageWork {
  private pages = new Set<string>();
  private static key(owner: string, version: string) { return `${owner}\u0000${version}`; }
  note(owner: string, version: string): boolean { const key = PageWork.key(owner, version); if (this.pages.has(key)) return false; this.pages.add(key); return true; }
  /** The pages whose package may no longer show panels: each ends once and is forgotten. Answers the owners. */
  ended(allowed: (owner: string, version: string) => boolean): string[] {
    const owners: string[] = [];
    for (const key of [...this.pages]) {
      const [owner, version] = key.split('\u0000');
      if (allowed(owner, version)) continue;
      this.pages.delete(key);
      if (!owners.includes(owner)) owners.push(owner);
    }
    return owners;
  }
  get size() { return this.pages.size; }
}

/** Why the package of `owner@version` may no longer show panels, read from an extensions snapshot (pure). */
export function lifecycleRefusal(snapshot: { safeMode?: boolean; packages: readonly { manifest: { id: string; version: string }; enabled: boolean; executable?: { trusted: boolean } | null }[] }, owner: string, version: string): 'safe-mode' | 'disabled' | 'untrusted' | undefined {
  if (snapshot.safeMode) return 'safe-mode';
  const item = snapshot.packages.find(candidate => candidate.manifest.id === owner && candidate.manifest.version === version);
  if (!item || !item.enabled) return 'disabled';
  return item.executable?.trusted ? undefined : 'untrusted';
}

type Page = { runner: RuntimePreview; version: string; authorized: () => boolean; grants: Grants; refresh?: () => Grants };
type Mounted = { owner: string; dispose: (keep?: boolean) => void };
export type PageOptions = Omit<PreviewOptions, 'panels'> & {
  manifest: PanelOnlyManifest;
  /** The package may show panels now (enabled, trusted, outside safe mode, `ui.richViews` held). Default: always. */
  authorized?: () => boolean;
  /** The grants the package holds now, read again before every call (the app preview's grants file twin). */
  refresh?: () => Grants;
};

/**
 * The page host of every package without a service: the `PanelService` of a `PreviewPanelHost`. Nothing here starts a
 * process: `declares` and `running` are false for every owner (so `postMessage` answers `NO_SERVICE`), events have
 * nobody to go to, and a panel's proxied call runs on its package's page panda, checked per call.
 */
export class PanelOnlyPages implements PanelService {
  readonly work = new PageWork();
  private pages = new Map<string, Page>();
  private mounts = new Map<string, Mounted>();
  /** `release(label)` gives the keyboard back to the app control that had it before panel `label`. */
  constructor(readonly host: PreviewPanelHost, private release: (label: string) => void = () => {}) { host.setService(this); }

  /** Registers (or replaces, for a new version) the page of a package without a service. Never starts anything. */
  register(options: PageOptions): RuntimePreview {
    const { manifest, authorized, refresh, ...rest } = options;
    if (!panelOnly(manifest)) throw new ChannelError(`UnsupportedCapability: ${manifest.id} declares a background service; its service answers its panels.`);
    const runner = createRuntimePreview({ ...rest, manifest });
    this.pages.set(manifest.id, { runner, version: manifest.version, authorized: authorized ?? (() => true), grants: options.grants, refresh });
    return runner;
  }
  runner(owner: string): RuntimePreview | undefined { return this.pages.get(owner)?.runner; }
  version(owner: string): string | undefined { return this.pages.get(owner)?.version; }
  /** Service processes started for `owner`'s panels: always 0 (the runner is never started). */
  starts(owner: string): number { return this.pages.get(owner)?.runner.starts ?? 0; }
  /** Binds a shell as mount `label` (what the inspector mount does) and keeps it for a lifecycle end. */
  mount(label: string, frame: { readonly contentWindow: Window | null }, origin: Origin): (keep?: boolean) => void {
    const dispose = this.host.bind(label, frame, origin);
    this.mounts.set(label, { owner: origin.owner, dispose });
    return (keep = true) => { if (this.mounts.get(label)?.dispose === dispose) this.mounts.delete(label); dispose(keep); };
  }

  // ---- PanelService ----------------------------------------------------------------------------------------------
  declares(): boolean { return false; }
  running(): boolean { return false; }
  async deliver(): Promise<void> { /* No service: panel events have nobody to go to. */ }
  async call(owner: string, path: string, args: unknown[]): Promise<unknown> {
    const page = this.pages.get(owner);
    if (!page) throw new ChannelError(`UnsupportedCapability: ${path} has no preview host.`);
    if (!page.authorized()) throw new ChannelError('PermissionDenied: the package may no longer show panels.');
    if (page.refresh) { const fresh = page.refresh(); page.grants.clear(); for (const [name, scope] of fresh) page.grants.set(name, scope); }
    this.work.note(owner, page.version);
    return page.runner.pageCall(path, args);
  }

  /**
   * After a lifecycle change (twin of `runtime_panel_only::reconcile` with the mount teardown): every page whose
   * package may no longer show panels ends once. Its instances close without keeping their state (a focused one gives
   * the keyboard back first), the kept state of its closed or failed instances goes, and its work ends.
   */
  reconcile(reason = 'lifecycle'): { ended: string[]; released: string[] } {
    const released: string[] = [];
    const ended: string[] = [];
    for (const [owner, page] of this.pages) {
      if (page.authorized()) continue;
      let closed = false;
      for (const [label, mount] of [...this.mounts]) {
        if (mount.owner !== owner) continue;
        if (this.host.channel.focused(label)) { released.push(label); this.release(label); }
        this.mounts.delete(label); mount.dispose(false); closed = true;
      }
      const kept = this.host.channel.dormant();
      this.host.channel.purge(origin => origin.owner !== owner);
      const purged = this.host.channel.dormant() < kept;
      if (page.runner.endPage(reason) || closed || purged) ended.push(owner);
    }
    // Pages that made calls and may no longer show panels are forgotten with their work.
    this.work.ended(owner => this.pages.get(owner)?.authorized() ?? false);
    return { ended, released };
  }
}

// ---- the app preview --------------------------------------------------------------------------------------------

let pages: PanelOnlyPages | undefined;
/** The preview page's one page host, over its one panel host. */
export function previewPages(): PanelOnlyPages {
  if (!pages) {
    pages = new PanelOnlyPages(previewPanelHost());
    const host = pages;
    // Read by the browser spec: the preview column only.
    if (typeof window !== 'undefined') Object.assign(window, { __panelOnlyPages: {
      starts: (owner: string) => host.starts(owner),
      notices: (owner: string) => host.runner(owner)?.noticeSnapshot().notices.filter(notice => notice.owner === owner).length ?? 0,
      items: (owner: string) => host.runner(owner)?.items.count(owner) ?? 0,
      tracked: () => host.work.size,
      services: async () => ((await (await import('../bridge')).call<{ services: { id: string }[] }>('extensions_service_lifetime')).services ?? []).map(service => service.id),
    } });
  }
  return pages;
}
const watched = new Set<string>();

/**
 * Before a served preview panel of `entry` mounts: if its package declares no service, its page gets the page host
 * (once per version), with the preview grants read again before every call and a lifecycle watcher that ends the
 * page's work even when no panel of it is mounted. `authorized` is the mount's own authority check.
 */
export async function ensurePreviewPage(entry: { owner: string; version: string }, authorized: () => boolean): Promise<void> {
  const [{ extensionsManagementSnapshot, extensionsSnapshot, onExtensionChanged }, { createRuntimeGrantsPreview }] = await Promise.all([import('./manager'), import('./runtime-grants')]);
  const item = extensionsSnapshot().packages.find(candidate => candidate.manifest.id === entry.owner && candidate.manifest.version === entry.version);
  const manifest = item?.manifest as unknown as PanelOnlyManifest | undefined;
  if (!manifest || !panelOnly(manifest)) return;
  const host = previewPages();
  if (host.version(entry.owner) !== entry.version) {
    const refresh = (): Grants => {
      const grants = createRuntimeGrantsPreview();
      grants.sync(extensionsManagementSnapshot() as unknown as Parameters<typeof grants.sync>[0]);
      const held: Grants = new Map();
      for (const name of manifest.permissions ?? []) if (grants.check(entry.owner, entry.version, name) === 'ok') held.set(name, true);
      return held;
    };
    host.register({ manifest, loaders: {}, grants: refresh(), refresh, authorized, now: () => Date.now() });
  }
  if (watched.has(entry.owner)) return;
  watched.add(entry.owner);
  const check = () => {
    const reason = lifecycleRefusal(extensionsSnapshot(), entry.owner, entry.version) ?? 'revoked';
    host.reconcile(reason);
  };
  onExtensionChanged(entry.owner, check);
  window.addEventListener(GRANTS_CHANGED, check);
}

/** A slot of the app lost its package's authority: the page host ends that package's work at once. */
export function endPreviewPage(reason: string): void { pages?.reconcile(reason); }
