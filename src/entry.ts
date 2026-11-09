// Keep the launcher and menu bar popover isolated: importing main loads the full workspace and its listeners.
const view = new URLSearchParams(location.search).get('view');
const browserWorkspace = !('__TAURI_INTERNALS__' in window) && (document.documentElement.dataset.pandacodeWeb === 'true' || new URLSearchParams(location.search).has('web'));
if (view === 'launcher' && !browserWorkspace) {
  void import('./overlay');
} else if (view === 'tray' && !browserWorkspace) {
  void import('./tray-popover');
} else {
  void (async () => {
    if ('__TAURI_INTERNALS__' in window) {
      const { initializeWebNativeHost } = await import('./web-native-host');
      await initializeWebNativeHost();
    } else if (document.documentElement.dataset.pandacodeWeb === 'true' || new URLSearchParams(location.search).has('web')) {
      const { bootstrapWeb } = await import('./web-bootstrap');
      await bootstrapWeb();
    }
    await import('./main');
    window.dispatchEvent(new Event('pandacode-workspace-ready'));
    if (!('__TAURI_INTERNALS__' in window) && document.documentElement.dataset.pandacodeWeb === 'true') {
      const { mountWebConnectionStatus } = await import('./web-runtime');
      const disposeStatus = mountWebConnectionStatus();
      window.addEventListener('pagehide', disposeStatus, { once: true });
      const { synchronizeWebAppearance } = await import('./web-appearance-sync');
      const dispose = synchronizeWebAppearance();
      window.addEventListener('pagehide', dispose, { once: true });
    }
  })();
}
