// App-owned bootstrap. Normal-account trusted execution, NOT a sandbox.
const { Module } = require('node:module');
const { join } = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
// A short activation keeps 64 KiB frames and 16 pending requests; a service's duplex channel allows 2 MiB frames and
// 64 pending requests per direction (runtime_duplex_channel.rs).
let maxFrame = 65536, maxPending = 16;
let buffer = Buffer.alloc(0), init, sequence = 0, stopService, serveCall, stopping = false;
const pending = new Map();
const invocations = new AsyncLocalStorage();
const write = process.stdout.write.bind(process.stdout);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxFrame) throw new Error('LimitExceeded');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  write(Buffer.concat([header, body]));
}
function rpc(method, params) {
  if (pending.size >= maxPending) return Promise.reject(new Error('LimitExceeded'));
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
    if (length > (init ? maxFrame : 300000)) return process.exit(2);
    if (buffer.length < length + 4) break;
    const value = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
    if (!init) {
      init = value;
      if (init.context?.lifetime) { maxFrame = 2 * 1024 * 1024; maxPending = 64; }
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
        if (invocation?.lifetime) {
          // Background service (runtime.service): no deadline, no message budget, alive until the host stops it.
          const service = module.exports.service;
          if (typeof service !== 'function') throw new Error('Missing service');
          const stops = new Set();
          const lifetime = Object.freeze({
            reason: invocation.lifetime.reason,
            restarts: invocation.lifetime.restarts,
            onStop(handler) {
              if (typeof handler !== 'function') throw new TypeError('onStop needs a function');
              stops.add(handler);
              return Object.freeze({ dispose: () => { stops.delete(handler); } });
            },
            setStatus: status => rpc('serviceStatus', { text: String(status?.text ?? '').slice(0, 200), working: status?.working === true }),
          });
          // Handlers registered here live in the service's shared state; owned commands only.
          const servicePanda = Object.freeze({
            apiVersion: '1.0.0',
            commands: Object.freeze({ register(id, handler) {
              if (!invocation.lifetime.commands.includes(id) || typeof handler !== 'function' || commands.has(id)) throw new Error('PermissionDenied');
              commands.set(id, handler);
              return Object.freeze({ dispose: () => commands.delete(id) });
            } }),
            // The same context surface a short activation has. Requests made while an owned command runs are
            // answered for the context that command was invoked from; anywhere else they are stale.
            context: Object.freeze({
              query: params => rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'query', invocation: invocations.getStore() }),
              subscribe: params => rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'subscribe', invocation: invocations.getStore() }),
              events: params => rpc('context', { ...params, op: 'events', invocation: invocations.getStore() }),
              unsubscribe: params => rpc('context', { ...params, op: 'unsubscribe', invocation: invocations.getStore() }),
            }),
          });
          // Host to service calls interleave freely with the service's own requests: each runs on its own.
          serveCall = async call => {
            const reply = body => send({ schemaVersion: 1, token: init.token, reply: { id: call.id, ...body } });
            const code = error => { const text = error?.code ?? error?.message; return typeof text === 'string' && /^[A-Z][A-Za-z]{0,63}$/.test(text) ? text : 'HostUnavailable'; };
            try {
              const handler = call.method === 'command' ? commands.get(call.params?.commandId) : undefined;
              if (!handler) return reply({ ok: false, error: { code: 'PermissionDenied' } });
              const value = await invocations.run(call.id, () => handler(freeze({ commandId: call.params.commandId, args: call.params.args ?? null })));
              reply({ ok: true, value: value ?? null });
            } catch (error) {
              try { reply({ ok: false, error: { code: code(error) } }); } catch { process.exit(2); }
            }
          };
          stopService = async reason => {
            if (stopping) return;
            stopping = true;
            await Promise.allSettled([...stops].map(handler => Promise.resolve().then(() => handler(reason))));
            try { await rpc('serviceStopped', { reason }); } catch { /* the host ends the process anyway */ }
            process.exit(0);
          };
          await service(servicePanda, lifetime);
          await rpc('serviceReady', null);
          return;
        }
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
    } else if (value && typeof value.stop === 'string' && init.context?.lifetime) {
      // The host's stop request: run onStop handlers, acknowledge, exit. The host waits at most 2 s.
      if (stopService) void stopService(value.stop); else process.exit(0);
    } else if (value && value.call && init.context?.lifetime) {
      // A host to service call (an owned command). Before the service function has registered, there is no handler.
      if (serveCall) void serveCall(value.call); else process.exit(2);
    } else {
      const waiter = pending.get(value.id); if (!waiter) return process.exit(2);
      pending.delete(value.id);
      if (value.reply?.ok) waiter.resolve(value.reply.value);
      else waiter.reject(new Error(value.reply?.error?.code || 'HostUnavailable'));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
