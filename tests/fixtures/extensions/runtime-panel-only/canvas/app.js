// R0305 fixture panel: a package with this panel and no background service. It draws on a canvas, keeps its strokes in
// `pandaView.state` (they come back after a reload or a failure of the panel), calls the package SDK through the host
// and shows what the host answered. `postMessage` and `storage.directory` have nobody to answer them here.
const view = window.pandaView;
const canvas = document.getElementById('canvas');
const context = canvas.getContext('2d');
const show = (id, text) => { document.getElementById(id).textContent = text; };
const answered = id => [() => show(id, `${id}: ok`), error => show(id, `${id}: ${error && error.code ? error.code : String(error)}`)];
let strokes = [];
const draw = () => {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = 3; context.strokeStyle = '#336699';
  for (const [x1, y1, x2, y2] of strokes) { context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); }
  show('strokes', `strokes: ${strokes.length}`);
};
const add = stroke => { strokes = [...strokes, stroke].slice(-500); view.state.set({ strokes }); draw(); };
view.onDidInitialize(init => {
  show('instance', `instance: ${init.instanceId ? 'yes' : 'none'} ${init.placement}`);
  show('restored', `restored: ${init.restored}`);
  strokes = init.state && Array.isArray(init.state.strokes) ? init.state.strokes : [];
  draw();
});
view.onDidChangeVisibility(state => show('focus', `focused: ${state.focused}`));
let from = null;
canvas.addEventListener('pointerdown', event => { from = [event.offsetX, event.offsetY]; });
canvas.addEventListener('pointerup', event => { if (from) add([...from, event.offsetX, event.offsetY]); from = null; });
document.getElementById('stroke').addEventListener('click', () => add([10 + strokes.length * 8, 10, 80 + strokes.length * 8, 100]));
document.getElementById('clear').addEventListener('click', () => { strokes = []; view.state.set({ strokes }); draw(); });
document.getElementById('notify').addEventListener('click', () => {
  view.panda.ui.notify({ key: 'sketch', title: 'Sketch', text: `${strokes.length} strokes saved` }).then(...answered('notified'));
});
document.getElementById('register').addEventListener('click', () => {
  view.panda.ui.register({ kind: 'menu', id: 'sample.panel-only/strokes', location: 'panda.status.items', command: 'sample.panel-only/open', presentation: 'status', text: `${strokes.length} strokes` }).then(...answered('status'));
});
document.getElementById('post').addEventListener('click', () => { view.postMessage({ kind: 'saved', strokes: strokes.length }).then(...answered('message')); });
document.getElementById('data').addEventListener('click', () => { view.panda.storage.directory({ scope: 'global' }).then(...answered('directory')); });
document.getElementById('fail').addEventListener('click', () => { setTimeout(() => { throw new Error('The sketch failed on purpose.'); }, 0); });
