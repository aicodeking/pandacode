// R0306 fixture: a panel-only package (no service) on its own origin. It reads the key the board package writes on
// the board's origin: per-package storage means it never sees the board's value, and its own value stays its own.
const view = window.pandaView;
const KEY = 'windows-panels-note';
const observed = { boot: crypto.randomUUID(), init: null, storage: null, post: null };
window.__windowsPanels = observed;
function read() {
  observed.storage = { local: localStorage.getItem(KEY), origin: location.origin };
  document.getElementById('storage').textContent = `storage: ${observed.storage.local ?? 'none'}`;
  return observed.storage;
}
view.onDidInitialize(init => { observed.init = { viewId: view.viewId, instanceId: init.instanceId ?? null, placement: init.placement ?? null, restored: init.restored ?? null }; read(); });
window.__windowsPanelsDo = {
  read,
  store: value => { localStorage.setItem(KEY, value); return read(); },
  // A package without a service has no channel peer: the host answers the post with a refusal (R0303/R0305).
  post: () => view.postMessage({ kind: 'hello' }).then(() => { observed.post = 'delivered'; return observed.post; }, error => { observed.post = String(error?.code ?? error?.message ?? error); return observed.post; }),
};
