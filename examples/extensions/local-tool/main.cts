import type { Activate, ToolHandler } from '@pandacode/extensions';

const TOOL = 'sample.local-tool/count';

// Runs in the captured project folder with literal arguments; no shell, network or ambient command lookup.
export const tools: Record<string, ToolHandler> = {
  [TOOL]: async (args, job) => {
    await job.progress({ phase: 'counting', completed: 0 });
    const words = args.join(' ').split(/\s+/).filter(Boolean).length;
    await job.progress({ phase: 'counting', completed: 100 });
    return { words };
  },
};

export const activate: Activate = panda => {
  panda.commands.register('sample.local-tool/run', async () => {
    const job = await panda.jobs.start({ tool: TOOL, args: ['hello from a local tool'] });
    await panda.ui.showDialog({
      title: 'Local tool', fields: [], confirmLabel: 'Done',
      confirmation: `Job ${job.job} is ${job.state}.`,
      successMessage: 'Local tool closed',
    });
  });
};
