// R0306 fixture panel. The installed qualification reads `window.__windowsPanels` (what this document observed) and
// calls `window.__windowsPanelsDo` (what the scenario asks it to do) through the WebView2 debugging connection.
// Frame `seq` is drawn as one opaque column at x = seq % 64 in rgb((seq*5)%256, (seq*11)%256, 200): integer
// rectangles without anti-aliasing, so the sampled pixel is exact.
const view = window.pandaView;
const KEY = 'windows-panels-note';
const show = (id, text) => { document.getElementById(id).textContent = text; };
const canvas = document.getElementById('stream');
const context = canvas.getContext('2d', { willReadFrequently: true });
const observed = {
  // A new document has a new boot id: a parked webview that keeps its document keeps it.
  boot: crypto.randomUUID(),
  init: null, theme: null, visibility: [], heartbeats: 0,
  frames: { drawn: 0, last: -1, gaps: 0, done: null, sample: null },
  claim: null, task: null, errors: [], storage: null, keys: [],
};
window.__windowsPanels = observed;
let claimStarted = 0;

function idb(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('windows-panels', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('notes');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction('notes', mode);
      const request = work(transaction.objectStore('notes'));
      transaction.oncomplete = () => { open.result.close(); resolve(request.result ?? null); };
      transaction.onerror = () => { open.result.close(); reject(transaction.error); };
    };
  });
}
async function readStorage() {
  const local = localStorage.getItem(KEY);
  let indexed = null;
  try { indexed = await idb('readonly', store => store.get(KEY)); } catch (error) { observed.errors.push(`idb: ${error?.name ?? error}`); }
  observed.storage = { local, indexed, origin: location.origin };
  show('storage', `storage: ${local ?? 'none'} / ${indexed ?? 'none'}`);
  return observed.storage;
}
function draw(seq) {
  context.fillStyle = `rgb(${(seq * 5) % 256}, ${(seq * 11) % 256}, 200)`;
  context.fillRect(seq % 64, 0, 1, 16);
}

view.onDidInitialize(init => {
  observed.init = { viewId: view.viewId, instanceId: init.instanceId ?? null, placement: init.placement ?? null, restored: init.restored ?? null, state: init.state === undefined ? null : init.state, at: Date.now() };
  show('instance', `instance: ${init.instanceId} ${init.placement}`);
  void readStorage();
});
view.onDidChangeTheme(theme => { observed.theme = theme.colorScheme; });
view.onDidChangeVisibility(state => { observed.visibility.push({ visible: state.visible, focused: state.focused, at: Date.now() }); });
view.onMessage(message => {
  if (message.kind === 'heartbeat') { observed.heartbeats++; return; }
  if (message.kind === 'frame') {
    if (message.seq !== observed.frames.last + 1) observed.frames.gaps++;
    observed.frames.last = message.seq; observed.frames.drawn++;
    draw(message.seq);
    show('frames', `frames: ${observed.frames.drawn}`);
    return;
  }
  if (message.kind === 'stream-done') {
    const x = observed.frames.last % 64;
    observed.frames.done = { posted: message.posted, at: Date.now() };
    observed.frames.sample = { x, rgba: [...context.getImageData(x, 8, 1, 1).data] };
    return;
  }
  if (message.kind === 'claimed') { observed.claim = { issueId: message.issueId, status: message.status, mine: message.assignee === view.instanceId, ms: Math.round(performance.now() - claimStarted) }; show('claimed', `claimed: ${message.issueId}`); return; }
  if (message.kind === 'task') { observed.task = { id: message.id }; show('task', `task: ${message.id}`); return; }
  if (message.kind === 'error') observed.errors.push(`${message.for}: ${message.code}`);
});
document.addEventListener('keydown', event => { observed.keys.push({ key: event.key, ctrl: event.ctrlKey, at: Date.now() }); });

window.__windowsPanelsDo = {
  stream: frames => view.postMessage({ kind: 'stream', frames }),
  claim: () => { claimStarted = performance.now(); return view.postMessage({ kind: 'claim' }); },
  startTask: (projectId, prompt) => view.postMessage({ kind: 'start-task', projectId, prompt }),
  store: async value => {
    localStorage.setItem(KEY, value);
    await idb('readwrite', store => store.put(value, KEY));
    return readStorage();
  },
  read: () => readStorage(),
  remember: value => { view.state.set({ note: value }); return view.state.get(); },
  focusButton: () => { document.getElementById('focus-target').focus(); return document.hasFocus(); },
  releaseFocus: () => view.releaseFocus(),
  // An uncaught error outside any handler: the client reports the first one as the panel's fault.
  fault: () => { setTimeout(() => { throw new Error('windows-panels qualification fault'); }, 0); return true; },
};
