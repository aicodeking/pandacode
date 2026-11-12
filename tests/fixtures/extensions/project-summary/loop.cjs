exports.activate = async panda => {
  await panda.context.subscribe({ resource: 'jobs', limit: 10 });
  // A real CPU loop in the native host, not a sleeping browser mock.
  while (true) {}
};
