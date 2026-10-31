// Keep the launcher and menu bar popover isolated: importing main loads the full workspace and its listeners.
const view = new URLSearchParams(location.search).get('view');
if (view === 'launcher') {
  void import('./overlay');
} else if (view === 'tray') {
  void import('./tray-popover');
} else {
  void import('./main');
}
