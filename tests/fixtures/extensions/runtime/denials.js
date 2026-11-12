// Only reviewed synthetic inputs; never probe user paths or real endpoints.
for (const name of ['require', 'process', 'Deno', 'Bun', 'fetch', 'XMLHttpRequest',
                    'WebSocket', 'Worker', 'ffi', 'std', 'os']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error('ambient authority: ' + name);
}
const attempts = [
  () => require('fs').readFileSync('qualification-sentinel'),
  () => fetch('http://127.0.0.1:1/qualification'),
  () => process.env.QUALIFICATION_SENTINEL,
  () => require('child_process').spawn('qualification-sentinel'),
  () => ffi.dlopen('qualification-sentinel'),
  () => Function('return process')(),
];
for (const attempt of attempts) {
  let denied = false;
  try { attempt(); } catch (error) { denied = error instanceof ReferenceError; }
  if (!denied) throw new Error('ambient operation was not denied');
}
// SharedArrayBuffer is an engine intrinsic, not an OS import. No worker or native
// handles are installed. Actual module-loading attempts must reject too.
Promise.all(['std', 'os', 'node:fs', 'file:///qualification-sentinel'].map(name =>
  import(name).then(() => { throw new Error('module unexpectedly loaded'); }, () => true)
));
