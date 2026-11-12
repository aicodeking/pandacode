exports.activate = async panda => {
  await panda.context.subscribe({ resource: 'jobs', limit: 10 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const retained = [];
  while (true) retained.push(Buffer.alloc(4 * 1024 * 1024, 1));
};
