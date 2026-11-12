exports.activate = async panda => {
  await panda.context.subscribe({ resource: 'jobs', limit: 10 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  throw new Error('Controlled fixture exception');
};
