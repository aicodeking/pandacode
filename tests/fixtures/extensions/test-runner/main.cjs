// A local test runner using the packaged runtime. No network or ambient command lookup.
exports.activate = () => {};
exports.tools = {
  'sample.test-runner/test': async (args, job) => {
    await job.progress({ phase: 'testing', completed: 0 });
    if (args[0] === 'wait') return new Promise(() => {});
    if (args[0] === 'result-flood') return 'x'.repeat(8193);
    if (args[0] === 'progress-flood') await job.progress('x'.repeat(513));
    if (args[0] === 'flood') { for (let i = 0; i < 33; i++) await job.progress({ phase: 'testing', completed: i }); }
    const assert = require('node:assert/strict');
    assert.equal(2 + 2, 4);
    await job.progress({ phase: 'testing', completed: 100 });
    return { passed: 1, args, cwd: process.cwd() };
  },
};
