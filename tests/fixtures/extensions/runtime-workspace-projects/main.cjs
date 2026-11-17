// R0405 fixture: a background service that manages the workspace when it is told to, by the command
// `sample.runtime-workspace-projects/run` (the panel button of the acceptance, the browser spec and the native test).
// `args.call` names one of the nineteen workspace calls or the project check, `args.input` is what that call takes:
//   projects.add      {path}                       projects.remove    {projectId}
//   projects.rename   {projectId, name}            projects.relink    {projectId, path}
//   worktrees.create  {taskId, branch, base?, existing?}
//   worktrees.remove  {worktreeId, deleteBranch?}  worktrees.recreate {worktreeId}      worktrees.merge {worktreeId}
//   branches.create   {projectId, taskId?, name, from?, switch?}
//   branches.switch   {projectId, taskId?, branch} branches.rename    {projectId, taskId?, from, to}
//   branches.remove   {projectId, taskId?, branch, force?}
//   tasks.remove      {taskId}                     tasks.rename       {taskId, title}   tasks.move {taskId, projectId}
//   pulls.link        {taskId, reference}          pulls.unlink {taskId}  pulls.check {taskId}  pulls.merge {taskId, method?}
//   projects.checks.run {taskId}                   (runs the project's inert check script in the task's checkout)
// A call answers its value, or `{ refused: <code>, path, ids }` when the host refused it (nothing changed): that is how a
// revoked grant, a narrowed project, a cancelled confirmation or an unknown id reads from here. `state` answers every call
// made and every refusal. The package never pairs a machine, never asks for remote access and never names a credential;
// the calls have no such option.
exports.service = async (panda, lifetime) => {
  const state = { done: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ done: state.done.length, refused: state.refused }) });
  const invoke = (call, input) => {
    const workspace = panda.workspace;
    switch (call) {
      case 'projects.add': return workspace.projects.add(input);
      case 'projects.remove': return workspace.projects.remove(input.projectId);
      case 'projects.rename': return workspace.projects.rename(input.projectId, input.name);
      case 'projects.relink': return workspace.projects.relink(input.projectId, input.path);
      case 'worktrees.create': return workspace.worktrees.create(input);
      case 'worktrees.remove': return workspace.worktrees.remove(input.worktreeId, input.deleteBranch === undefined ? undefined : { deleteBranch: input.deleteBranch });
      case 'worktrees.recreate': return workspace.worktrees.recreate(input.worktreeId);
      case 'worktrees.merge': return workspace.worktrees.merge(input.worktreeId);
      case 'branches.create': return workspace.branches.create(input);
      case 'branches.switch': return workspace.branches.switch(input);
      case 'branches.rename': return workspace.branches.rename(input);
      case 'branches.remove': return workspace.branches.remove(input);
      case 'tasks.remove': return workspace.tasks.remove(input.taskId);
      case 'tasks.rename': return workspace.tasks.rename(input.taskId, input.title);
      case 'tasks.move': return workspace.tasks.move(input.taskId, input.projectId);
      case 'pulls.link': return workspace.pulls.link(input.taskId, { reference: input.reference });
      case 'pulls.unlink': return workspace.pulls.unlink(input.taskId);
      case 'pulls.check': return workspace.pulls.check(input.taskId);
      case 'pulls.merge': return workspace.pulls.merge(input.taskId, input.method === undefined ? undefined : { method: input.method });
      case 'projects.checks.run': return panda.projects.checks.run({ taskId: input.taskId });
      default: throw new Error('InvalidShape');
    }
  };
  const run = async args => {
    if (args.op === 'state') return state;
    try {
      const value = await invoke(args.call, args.input ?? {});
      state.done.push(args.call);
      return { value: value ?? null };
    } catch (error) {
      const code = String(error?.code ?? error?.message ?? error);
      state.refused.push({ call: args.call, code });
      return { refused: code, path: typeof error?.path === 'string' ? error.path : '$', ids: Array.isArray(error?.ids) ? error.ids : [] };
    }
  };
  panda.commands.register('sample.runtime-workspace-projects/run', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });
  await report();
};
