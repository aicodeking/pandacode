exports.activate = async panda => {
  await panda.context.subscribe({ resource: 'jobs', limit: 10 });
  await new Promise(() => {});
};
