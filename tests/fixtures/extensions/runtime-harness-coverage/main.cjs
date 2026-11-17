// R0509 fixture: a background service that reads the harness capability report (`panda.harnesses.list`, under
// `harnesses.inventory`) and decides, per harness and mode, what it can promise about a guard: a call it can check
// before it runs ("every call" only through a companion, otherwise "the calls the harness asks about" or "sandbox
// escalations only"), or only after it ran. It never treats a row as a yes/no: it reads `coverage` and
// `qualification` of each cell. It also observes the run of every turn it sees, to compare with the report's
// counters. The command `sample.coverage-reader/control` is the only way to look at it, chosen by `args.op`:
//   report  -> panda.harnesses.list(args.options) again and the summary below
//   status  -> per harness and mode: { coverage, qualification, label }
//   runs    -> the `run` of every turn.start seen, in order
//   calls   -> { source, coverage } of every tool.before / tool.after seen, in order
const LABELS = {
  everyCall: 'checked before every call',
  askedCalls: 'checked before the calls the harness asks about',
  escalationsOnly: 'checked before sandbox escalations only',
  none: 'not enforced in this mode (seen after it ran)',
};
function summary(report) {
  const status = {};
  for (const row of report.harnesses) {
    status[row.id] = {};
    for (const [mode, cell] of Object.entries(row.hooks.toolBefore)) {
      // A source-feasible companion is not a promise: only the delivered cell sets the label.
      status[row.id][mode] = { coverage: cell.coverage, qualification: cell.qualification, label: LABELS[cell.coverage] ?? cell.coverage };
    }
  }
  return status;
}
exports.service = async (panda, lifetime) => {
  const state = { report: null, error: null, runs: [], calls: [] };
  const read = async options => {
    try { state.report = await panda.harnesses.list(options); state.error = null; } catch (error) { state.error = error.code ?? error.message; }
    return { report: state.report, error: state.error, status: state.report ? summary(state.report) : null };
  };
  await read();
  const hooks = [
    panda.hooks.on('turn.start', payload => { state.runs.push(payload.run); }),
    panda.hooks.on('tool.before', payload => { state.calls.push({ event: 'tool.before', source: payload.source, coverage: payload.coverage }); }),
    panda.hooks.on('tool.after', payload => { state.calls.push({ event: 'tool.after', source: payload.source, coverage: payload.coverage }); }),
  ];
  panda.commands.register('sample.coverage-reader/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'report': return await read(args.options);
      case 'status': return state.report ? summary(state.report) : { error: state.error };
      case 'runs': return [...state.runs];
      case 'calls': return [...state.calls];
      default: throw new Error('InvalidShape');
    }
  });
  lifetime.onStop(() => { for (const hook of hooks) hook.dispose(); });
};
