// Bundled executable package: imports native Node libraries, never the core Tauri bridge.
exports.activate = async (panda, context) => {
  const page = await panda.context.query({ resource: 'projects', limit: 10 });
  const name = page.items.map(item => `${item.name} (${item.id})`).join(', ') || page.state;
  await panda.ui.showDialog({ title: 'Executable project summary', fields: [
    { id: 'summary', kind: 'text', label: 'Captured project', value: name },
  ], successMessage: 'Project summary acknowledged' });
};
