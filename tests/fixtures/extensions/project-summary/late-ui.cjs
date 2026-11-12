exports.activate = async panda => {
  await panda.context.subscribe({ resource: 'jobs', limit: 10 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await panda.ui.showDialog({ title: 'Late UI must not appear', fields: [], successMessage: 'Forbidden late result' });
};
