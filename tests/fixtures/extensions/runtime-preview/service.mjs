// R0208 fixture: a browser-safe ES module (no imports, no Node, no globals but the `panda` it is handed) that the preview
// runner (src/extensions/runtime-preview.ts) loads. It reacts to two host events and to signals of the B1 fake daemon
// (the replaced backend); a signal payload is `{ op, ... }` and `op` is one of:
//   notify   -> notify key `build`, then replace it once
//   register -> register a live menu item and update it
//   ask      -> show a dialog and keep the answer in the status
//   reveal   -> reveal a target given in `target`
//   read     -> read tasks through `panda.context.query`
// Every answer and refusal is kept in the status line so the spec reads what the host replied.
export async function service(panda, lifetime) {
  const OWNER = 'sample.runtime-preview';
  const PAGE = `${OWNER}/preferences`;
  const state = { settings: null, tasks: [], answers: [], refused: [], dialog: null };
  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error)); return null; };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ revision: state.settings?.revision ?? null, label: state.settings?.values?.label ?? null, tasks: state.tasks, answers: state.answers, refused: state.refused, dialog: state.dialog }) });
  const readSettings = async () => { state.settings = await panda.settings.get({ page: PAGE }).catch(refuse); report(); };
  await readSettings();
  panda.events.on('settings.changed', () => { void readSettings(); });
  panda.events.on('task.created', event => {
    state.tasks.push(event.taskId);
    void panda.ui.notify({ key: 'task', title: 'Tasks', text: `${state.tasks.length} new tasks`, tone: 'info' }).then(answer => { state.answers.push(answer.replaced ? 'replaced' : 'shown'); report(); }, error => { refuse(error); report(); });
  });
  const run = async signal => {
    const args = signal.payload ?? {};
    switch (args.op) {
      case 'notify':
        state.answers.push((await panda.ui.notify({ key: 'build', text: '3 builds failed', tone: 'danger' })).replaced);
        state.answers.push((await panda.ui.notify({ key: 'build', text: '4 builds failed', tone: 'danger' })).replaced);
        break;
      case 'register':
        await panda.ui.register({ kind: 'menu', id: `${OWNER}/live`, location: 'panda.status.items', command: `${OWNER}/open`, presentation: 'status', text: 'idle' });
        await panda.ui.update(`${OWNER}/live`, { text: 'busy', tone: 'warning' });
        break;
      case 'ask':
        state.dialog = await panda.ui.showDialog({ title: 'Pick a name', fields: [{ id: 'name', label: 'Name', kind: 'text', required: true }], successMessage: 'Answered' });
        break;
      case 'reveal':
        await panda.ui.reveal(args.target).catch(refuse);
        break;
      case 'read': {
        const page = await panda.context.query({ resource: 'tasks', limit: 10 }).catch(refuse);
        state.answers.push(page ? page.items.map(item => item.id) : null);
        break;
      }
      default: refuse({ code: 'InvalidShape' });
    }
    report();
  };
  await panda.daemon.subscribe('signals', signal => { void run(signal.data).catch(error => { refuse(error); report(); }); });
  lifetime.onStop(() => { lifetime.setStatus({ text: 'stopped' }); });
  report();
}
