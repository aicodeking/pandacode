"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = exports.tools = void 0;
const TOOL = 'sample.local-tool/count';
// Runs in the captured project folder with literal arguments; no shell, network or ambient command lookup.
exports.tools = {
    [TOOL]: async (args, job) => {
        await job.progress({ phase: 'counting', completed: 0 });
        const words = args.join(' ').split(/\s+/).filter(Boolean).length;
        await job.progress({ phase: 'counting', completed: 100 });
        return { words };
    },
};
const activate = panda => {
    panda.commands.register('sample.local-tool/run', async () => {
        const job = await panda.jobs.start({ tool: TOOL, args: ['hello from a local tool'] });
        await panda.ui.showDialog({
            title: 'Local tool', fields: [], confirmLabel: 'Done',
            confirmation: `Job ${job.job} is ${job.state}.`,
            successMessage: 'Local tool closed',
        });
    });
};
exports.activate = activate;
