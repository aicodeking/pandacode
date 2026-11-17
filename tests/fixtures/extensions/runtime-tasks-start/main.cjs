// R0401 fixture: a background service that starts tasks when it is told to, by the command
// `sample.runtime-tasks-start/control` (the panel button of the acceptance, the browser spec and the native test).
// `op` is one of:
//   start   -> panda.tasks.start({ projectId, prompt, title?, harness?, model?, effort?, mode?, worktree?, target?, attachments? })
//              with the options of `args.options`; answers the started task `{ id, projectId, worktree }`
//   refuse  -> the same call, answering the refusal as `{ refused: <code>, ids }` instead of throwing (no task exists)
//   steps   -> three starts in a row ("three-step fake task"): the first with defaults, the second in a new worktree,
//              the third with a title; answers the three results in order
//   state   -> what the service holds: every answer and every refusal so far
// The package never names a credential, never pairs a machine and never asks for remote access: the call has no such option.
exports.service = async (panda, lifetime) => {
  const state = { started: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ started: state.started.length, refused: state.refused }) });
  const begin = async options => {
    const started = await panda.tasks.start(options);
    state.started.push(started);
    return started;
  };
  const run = async args => {
    switch (args.op) {
      case 'start': return begin(args.options);
      case 'refuse':
        try { return await begin(args.options); } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          return { refused: code, ids: Array.isArray(error?.ids) ? error.ids : [] };
        }
      case 'steps': {
        const { projectId, prompt } = args.options;
        return [
          await begin({ projectId, prompt: `${prompt} (1/3)` }),
          await begin({ projectId, prompt: `${prompt} (2/3)`, worktree: 'new' }),
          await begin({ projectId, prompt: `${prompt} (3/3)`, title: 'Fixture step three' }),
        ];
      }
      case 'state': return state;
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.runtime-tasks-start/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });
  await report();
};
