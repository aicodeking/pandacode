// App-owned bootstrap. Normal-account trusted execution, NOT a sandbox.
const { Module } = require('node:module');
const { join } = require('node:path');
const MAX_FRAME = 65536;
let buffer = Buffer.alloc(0), init, sequence = 0;
const pending = new Map();
const write = process.stdout.write.bind(process.stdout);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new Error('LimitExceeded');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  write(Buffer.concat([header, body]));
}
function rpc(method, params) {
  if (pending.size >= 16) return Promise.reject(new Error('LimitExceeded'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ schemaVersion: 1, token: init.token, id, method, params });
  });
}
// Keep package console output off the protocol. Rust separately bounds/discards stderr.
console.log = console.info = console.warn = console.error = () => {};
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > (init ? MAX_FRAME : 300000)) return process.exit(2);
    if (buffer.length < length + 4) break;
    const value = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
    if (!init) {
      init = value;
      const commands = new Map();
      const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      const invocation = freeze(init.context);
      // Rust writes this only after trust, declared command capture and supervision admission.
      const panda = Object.freeze({
        apiVersion: '1.0.0',
        commands: Object.freeze({ register(id, handler) {
          if (id !== invocation.commandId || typeof handler !== 'function' || commands.has(id)) throw new Error('PermissionDenied');
          commands.set(id, handler);
          return Object.freeze({ dispose: () => commands.delete(id) });
        } }),
        context: Object.freeze({
          query: params => rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'query' }),
          subscribe: params => rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'subscribe' }),
          events: params => rpc('context', { ...params, op: 'events' }),
          unsubscribe: params => rpc('context', { ...params, op: 'unsubscribe' }),
        }),
        ui: Object.freeze({ showDialog: dialog => rpc('dialog', dialog) }),
        jobs: Object.freeze(Object.fromEntries(['start', 'poll', 'cancel'].map(op => [op, options => rpc('jobs', { ...options, op })]))),
        connections: Object.freeze(Object.fromEntries(['status', 'start', 'poll', 'cancel'].map(op => [op, options => rpc('connections', { ...options, op })]))),
        services: Object.freeze(Object.fromEntries(['start', 'poll', 'dispose'].map(op => [op, options => rpc('services', { ...options, op })]))),
        // Scope can only be global or this invocation's captured project. No owner/path input.
        storage: Object.freeze(Object.fromEntries(['get', 'set', 'remove', 'snapshot', 'subscribe', 'events', 'unsubscribe', 'migrate'].map(op => [op, options => rpc('storage', { ...options, op })]))),
      });
      void Promise.resolve().then(async () => {
        const module = new Module(join(process.cwd(), 'extension.cjs'));
        module.filename = join(process.cwd(), 'extension.cjs'); module.paths = [];
        module._compile(init.source, module.filename);
        if (invocation?.provider) {
          const handler = module.exports.providers?.[invocation.provider.id];
          if (typeof handler !== 'function') throw new Error('Missing provider');
          await handler(invocation.provider, Object.freeze({
            emit: event => rpc('providerEvent', event),
            nextInput: () => rpc('providerInput', null),
            teamTool: (name, arguments_) => rpc('providerTeamTool', { name, arguments: arguments_ }),
          }));
          await rpc('complete', null);
          return;
        }
        if (invocation?.service) {
          const call = invocation.service;
          const handler = module.exports.services?.[call.id]?.[call.method];
          if (typeof handler !== 'function') throw new Error('Missing public service');
          const result = await handler(call.input, freeze({ consumer: call.consumer, context: call.context, emit: value => rpc('serviceEvent', value) }));
          await rpc('serviceResult', result ?? null);
          await rpc('complete', null);
          return;
        }
        if (invocation?.job) {
          const handler = module.exports.tools?.[invocation.job.tool];
          if (typeof handler !== 'function') throw new Error('Missing tool');
          const result = await handler(invocation.job.args, Object.freeze({ progress: value => rpc('jobProgress', value) }));
          await rpc('jobResult', result ?? null);
          await rpc('complete', null);
          return;
        }
        if (typeof module.exports.activate !== 'function') throw new Error('Missing activate');
        await module.exports.activate(panda, invocation);
        const handler = commands.get(invocation?.commandId);
        if (handler) await handler(invocation);
        commands.clear();
        await rpc('complete', null);
      }).catch(() => { void rpc('failed', null).catch(() => process.exit(2)); });
    } else {
      const waiter = pending.get(value.id); if (!waiter) return process.exit(2);
      pending.delete(value.id);
      if (value.reply?.ok) waiter.resolve(value.reply.value);
      else waiter.reject(new Error(value.reply?.error?.code || 'HostUnavailable'));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
