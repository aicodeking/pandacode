// R0303 fixture panel: shows its instance, the board the service streams, the claim answered to this instance only,
// its visibility and theme, and keeps the selection in `pandaView.state` (it comes back after a reload or failure).
const view = window.pandaView;
const show = (id, text) => { document.getElementById(id).textContent = text; };
const fail = error => show('error', `error: ${error && error.code ? error.code : String(error)}`);
let first = null;
view.onDidInitialize(init => {
  show('instance', `instance: ${init.instanceId} ${init.placement}`);
  show('restored', `restored: ${init.restored}`);
  show('state', `state: ${init.state === undefined ? 'none' : JSON.stringify(init.state)}`);
});
view.onDidChangeTheme(theme => show('theme', `theme: ${theme.colorScheme}`));
view.onDidChangeVisibility(state => show('visibility', `visibility: ${state.visible ? 'visible' : 'hidden'}`));
view.onMessage(message => {
  if (message.kind === 'board') {
    first = message.issues[0] ? message.issues[0].id : null;
    show('board', `board: r${message.revision} ${message.issues.map(issue => `${issue.id}:${issue.status}`).join(',')}`);
  }
  if (message.kind === 'claimed') show('claimed', `claimed: ${message.issueId} by ${message.by === view.instanceId ? 'me' : 'other'}`);
});
document.getElementById('claim').addEventListener('click', () => { if (first) view.postMessage({ kind: 'claim', issueId: first }).catch(fail); });
document.getElementById('remember').addEventListener('click', () => {
  try { view.state.set({ selected: first }); show('state', `state: ${JSON.stringify(view.state.get())}`); } catch (error) { fail(error); }
});
document.getElementById('oversized').addEventListener('click', () => {
  try { view.state.set('x'.repeat(262145)); } catch (error) { fail(error); return; }
  show('error', 'error: none');
});
document.getElementById('secret').addEventListener('click', () => { view.panda.secrets.get({ key: 'token' }).then(() => show('error', 'error: none'), fail); });
