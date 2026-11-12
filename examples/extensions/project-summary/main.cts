import type { Activate } from '@pandacode/extensions';

export const activate: Activate = panda => {
  panda.commands.register('sample.sdk-summary/summary', async context => {
    const page = await panda.context.query({ resource: 'projects', limit: 10 });
    await panda.ui.showDialog({
      title: 'SDK project summary', fields: [], confirmLabel: 'Done',
      confirmation: `Captured project ${context.projectId ?? 'none'}: ${page.items.map(item => item.name ?? item.id).join(', ') || page.state}`,
      successMessage: 'Project summary closed',
    });
  });
};
