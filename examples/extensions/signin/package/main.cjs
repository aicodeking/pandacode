// sample.signin: the installed service. The logic is lib/signin.mjs (one browser-safe module that the browser preview runs as
// well); this file only hands it the platform's own fetch, clock and timers. No token is ever printed, logged or returned.
exports.service = async (panda, lifetime) => {
  const { run } = await import('./lib/signin.mjs');
  await run(panda, lifetime, {});
};
