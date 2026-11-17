// App-owned bootstrap. Normal-account trusted execution, NOT a sandbox.
const { Module } = require('node:module');
const { join } = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
// A short activation keeps 64 KiB frames and 16 pending requests; a service's duplex channel allows 2 MiB frames and
// 64 pending requests per direction (runtime_duplex_channel.rs).
let maxFrame = 65536, maxPending = 16;
let buffer = Buffer.alloc(0), init, sequence = 0, stopService, serveCall, serveEvent, stopping = false;
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
        // The data directory (`storage.directory`) is service only: a short activation has none.
        storage: Object.freeze({
          ...Object.fromEntries(['get', 'set', 'remove', 'snapshot', 'subscribe', 'events', 'unsubscribe', 'migrate'].map(op => [op, options => rpc('storage', { ...options, op })])),
          directory: () => Promise.reject(new Error('UnsupportedCapability')),
        }),
      });
      void Promise.resolve().then(async () => {
        let module;
        if (invocation?.lifetime && typeof init.entry === 'string') {
          // A service runs from its code directory (runtime.files): Node's own loader, so relative require, import(),
          // workers and Wasm resolve beside main.cjs.
          module = { exports: require(init.entry) };
        } else {
          module = new Module(join(process.cwd(), 'extension.cjs'));
          module.filename = join(process.cwd(), 'extension.cjs'); module.paths = [];
          module._compile(init.source, module.filename);
        }
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
          // Workspace events (events.workspace): one-way frames in order. A handler runs to its end before the next
          // event reaches any handler, so the order the host sent is the order the package sees; a handler's failure
          // never stops the stream. The host is told about the first and last handler of a kind only.
          const listeners = new Map();
          const events = Object.freeze({
            on(kind, handler) {
              if (typeof kind !== 'string' || typeof handler !== 'function') throw new TypeError('events.on needs a kind and a function');
              const entry = { handler };
              const set = listeners.get(kind) ?? new Set();
              if (!set.size) {
                listeners.set(kind, set);
                // A refusal (no grant, unknown kind) leaves this kind without listeners: nothing will ever arrive.
                rpc('events', { op: 'subscribe', kind }).catch(() => { listeners.delete(kind); });
              }
              set.add(entry);
              let live = true;
              return Object.freeze({ dispose: () => {
                if (!live) return;
                live = false;
                const current = listeners.get(kind);
                if (!current?.delete(entry) || current.size) return;
                listeners.delete(kind);
                rpc('events', { op: 'unsubscribe', kind }).catch(() => {});
              } });
            },
          });
          // At most 256 events wait for a slow handler. Past that the oldest are dropped, and one `gap` (standing for
          // the numbers it covers, so it carries the last of them) tells the package to read the state again.
          const waiting = [];
          let pumping = false, lost = 0, lastLost = 0, lostAt = 0;
          const dispatchEvent = async envelope => {
            for (const { handler } of [...(listeners.get(envelope.kind) ?? [])]) {
              try { await handler(freeze(envelope)); } catch { /* a failing handler never blocks the stream */ }
            }
          };
          const pump = async () => {
            if (pumping) return;
            pumping = true;
            try {
              while (waiting.length || lost) {
                if (lost) {
                  const gap = { schemaVersion: 1, kind: 'gap', sequence: lastLost, at: lostAt, dropped: lost };
                  lost = 0;
                  await dispatchEvent(gap);
                  continue;
                }
                await dispatchEvent(waiting.shift());
              }
            } finally { pumping = false; }
          };
          serveEvent = envelope => {
            if (waiting.length >= 256) { const oldest = waiting.shift(); lost += 1; lastLost = oldest.sequence; lostAt = oldest.at; }
            waiting.push(envelope);
            void pump();
          };
          // Handlers registered here live in the service's shared state; owned commands only.
          const servicePanda = Object.freeze({
            apiVersion: '1.0.0',
            events,
            commands: Object.freeze({ register(id, handler) {
              if (!invocation.lifetime.commands.includes(id) || typeof handler !== 'function' || commands.has(id)) throw new Error('PermissionDenied');
              commands.set(id, handler);
              return Object.freeze({ dispose: () => commands.delete(id) });
            } }),
            // The same context surface a short activation has. Requests made while an owned command runs are
            // answered for the context that command was invoked from; anywhere else they are stale.
            context: Object.freeze({
              // The four task reads are answered natively from the grants file (R0203); the rest keep the broker path.
              query: params => (['tasks', 'transcript', 'tools', 'changes'].includes(params?.resource) ? rpc('contentQuery', { ...params, limit: params?.limit === undefined ? 10 : params.limit })
                : ['usage', 'limits', 'accounts', 'metrics'].includes(params?.resource) ? rpc('usageQuery', { ...params, limit: params?.limit === undefined ? 10 : params.limit }) : rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'query', invocation: invocations.getStore() })),
              subscribe: params => rpc('context', { ...params, limit: params?.limit === undefined ? 10 : params.limit, op: 'subscribe', invocation: invocations.getStore() }),
              events: params => rpc('context', { ...params, op: 'events', invocation: invocations.getStore() }),
              unsubscribe: params => rpc('context', { ...params, op: 'unsubscribe', invocation: invocations.getStore() }),
            }),
            // Scoped live contributions (R0205): the host checks the grant, the scope and every limit on each request.
            ui: Object.freeze({
              register: async item => {
                const { id } = await rpc('ui', { op: 'register', item });
                return Object.freeze({
                  id,
                  update: patch => rpc('ui', { op: 'update', id, patch }),
                  dispose: () => rpc('ui', { op: 'dispose', id }),
                });
              },
              update: (id, patch) => rpc('ui', { op: 'update', id, patch }),
              updateView: (id, patch) => rpc('ui', { op: 'updateView', id, patch }),
              // Replaceable, attributed notices (R0207, ui.notify): the host names the package and checks the grant on every call.
              notify: notice => rpc('notice', { op: 'notify', notice }),
              withdraw: key => rpc('notice', { op: 'withdraw', key }),
              // Resolves with the user's answer, `{ status: 'confirmed', values }` or `{ status: 'cancelled' }` (R0206); a second dialog while one is open answers Conflict.
              showDialog: dialog => rpc('uiDialog', dialog),
              // Shows a view or settings page of the package, a task, or a file of a project; an unknown or stale target answers NotFound.
              reveal: target => rpc('uiReveal', target),
            }),
            // The package's own settings pages (R0203): the owner is the connection's, never the request's.
            settings: Object.freeze({ get: options => rpc('settingsGet', options === undefined || options === null ? {} : { ...options }) }),
            // Reads the usage windows again (R0204): needs harnesses.limits.read, once per harness per 60 s, resolves to null.
            harnesses: Object.freeze({
              refreshLimits: options => rpc('limitsRefresh', options === undefined || options === null ? {} : { ...options }),
              // Makes another account of a harness the active one (R0805, credentials.use for that account): a host operation, no credential crosses.
              switchAccount: options => rpc('accountSwitch', options === undefined || options === null ? {} : { ...options }),
            }),
            // Starts an attributed task (R0401, tasks.start): defaults, worktree and target are resolved by the host; no option pairs a machine.
            tasks: Object.freeze({ start: options => rpc('tasksStart', options === undefined || options === null ? {} : { ...options }) }),
            // Publishes what is true for the package's own providers (R0806, ui.dynamic): readiness, account, models, limits.
            providers: Object.freeze({ update: (id, state) => rpc('providerUpdate', { id, state }) }),
            // The package's data directory (storage.private). `project` needs the context of an owned command.
            storage: Object.freeze({ directory: options => rpc('storageDirectory', { ...options, invocation: invocations.getStore() }) }),
            // Declared connection requests (R0804): the host builds, authenticates and runs them; the grant is checked per call.
            connections: Object.freeze(Object.fromEntries(['status', 'start', 'poll', 'cancel'].map(op => [op, options => rpc('connectionsRequest', { ...options, op, invocation: invocations.getStore() })]))),
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
    } else if (value && value.event && init.context?.lifetime) {
      // A workspace event. The host sends one only after the service subscribed, so a handler exists by then.
      if (serveEvent) serveEvent(value.event); else process.exit(2);
    } else if (value && value.call && init.context?.lifetime) {
      // A host to service call (an owned command). Before the service function has registered, there is no handler.
      if (serveCall) void serveCall(value.call); else process.exit(2);
    } else {
      const waiter = pending.get(value.id); if (!waiter) return process.exit(2);
      pending.delete(value.id);
      if (value.reply?.ok) waiter.resolve(value.reply.value);
      else { const failure = new Error(value.reply?.error?.code || 'HostUnavailable'); failure.code = failure.message; failure.ids = Array.isArray(value.reply?.error?.ids) ? value.reply.error.ids : []; waiter.reject(failure); }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
