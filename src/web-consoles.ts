import { webJson } from './web-http';

type Kind = 'simulator' | 'vm' | 'cloud';
type Lease = { lease: string; controller: boolean; expiresAt: number };
const commands: Record<string, { kind: Kind; target: string; frame: boolean }> = {
  simulator_frame: { kind: 'simulator', target: 'udid', frame: true }, simulator_input: { kind: 'simulator', target: 'udid', frame: false },
  vm_frame: { kind: 'vm', target: 'name', frame: true }, vm_input: { kind: 'vm', target: 'name', frame: false },
  cloud_frame: { kind: 'cloud', target: 'id', frame: true }, cloud_input: { kind: 'cloud', target: 'id', frame: false },
};
const lifecycle: Record<string, { kind: Kind; manager: boolean }> = {
  simulator_select: { kind: 'simulator', manager: true }, simulator_create_duo: { kind: 'simulator', manager: true },
  simulator_pose: { kind: 'simulator', manager: false }, simulator_power: { kind: 'simulator', manager: false }, simulator_appearance: { kind: 'simulator', manager: false },
  vm_show: { kind: 'vm', manager: true }, vm_create: { kind: 'vm', manager: true }, vm_power: { kind: 'vm', manager: false }, vm_desktop: { kind: 'vm', manager: false }, vm_setup: { kind: 'vm', manager: true },
};
export const isConsoleCommand = (command: string) => command === 'simulator_capture' || command === 'agents_dock_save_preferences' || command === 'agents_dock_pin' || Object.hasOwn(commands, command) || Object.hasOwn(lifecycle, command);

const text = (value: unknown, name: string, maximum = 256): string => {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
};
const oneOf = <T extends string>(value: unknown, name: string, values: readonly T[]): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
};
const lifecycleBody = (command: string, args: Record<string, unknown>): { target: string; body: Record<string, unknown>; timeoutMs: number } => {
  switch (command) {
    case 'simulator_select': return { target: '$manager', body: { action: 'simulatorSelect', ...(args.udid == null ? {} : { udid: text(args.udid, 'simulator') }) }, timeoutMs: 70000 };
    case 'simulator_create_duo': return { target: '$manager', body: { action: 'simulatorCreateDuo' }, timeoutMs: 210000 };
    case 'simulator_pose': return { target: text(args.udid, 'simulator'), body: { action: 'simulatorPose', pose: oneOf(args.pose, 'simulator pose', ['closed', 'book', 'open'] as const) }, timeoutMs: 210000 };
    case 'simulator_power': {
      if (typeof args.on !== 'boolean') throw new Error('Invalid simulator power state');
      return { target: text(args.udid, 'simulator'), body: { action: 'simulatorPower', on: args.on }, timeoutMs: 330000 };
    }
    case 'simulator_appearance': return { target: text(args.udid, 'simulator'), body: { action: 'simulatorAppearance', mode: oneOf(args.mode, 'simulator appearance', ['light', 'dark'] as const) }, timeoutMs: 70000 };
    case 'vm_show': return { target: '$manager', body: { action: 'vmShow', ...(args.name == null ? {} : { name: text(args.name, 'VM') }) }, timeoutMs: 70000 };
    case 'vm_create': return { target: '$manager', body: { action: 'vmCreate', image: oneOf(args.image, 'VM image', ['ubuntu', 'debian', 'fedora', 'macos-tahoe', 'macos-sequoia'] as const), name: text(args.name, 'VM', 64) }, timeoutMs: 930000 };
    case 'vm_power': {
      const target = text(args.name, 'VM');
      const operation = oneOf(args.action, 'VM power action', ['start', 'stop', 'suspend', 'delete'] as const);
      if (operation !== 'start' && args.share != null) throw new Error('Shared project is only valid while starting a VM');
      const share = args.share == null ? {} : { shareProjectId: text(args.share, 'shared project', 128) };
      return { target, body: { action: 'vmPower', operation, ...(operation === 'start' ? share : {}), ...(operation === 'delete' ? { confirm: target } : {}) }, timeoutMs: 150000 };
    }
    case 'vm_desktop': return { target: text(args.name, 'VM'), body: { action: 'vmDesktop' }, timeoutMs: 930000 };
    case 'vm_setup': return { target: '$manager', body: { action: 'vmSetup' }, timeoutMs: 930000 };
    default: throw new Error('Invalid console lifecycle command');
  }
};

/** Each panel owns its own explicit controller lease. Failed input is never retried. */
export class WebConsoles {
  private leases = new Map<string, Promise<Lease>>();
  private generations = new Map<Kind, number>();
  private inputs = new Map<string, { tail: Promise<unknown>; pending: number }>();
  private csrf(): Record<string, string> {
    const value = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pandacode_csrf='))?.slice('pandacode_csrf='.length) ?? '';
    return { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(value), 'x-request-id': crypto.randomUUID() };
  }
  private async mutation(path: string, method: string, body?: unknown): Promise<unknown> {
    const { response, value } = await webJson(`/api/pandacode/consoles/${path}`, { method, headers: this.csrf(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { timeoutMs: 50000 });
    if (!response.ok) throw new Error(`Console request failed (${response.status}). Reopen the console to reconnect.`);
    return value;
  }
  private lease(kind: Kind, target: string): Promise<Lease> {
    const key = JSON.stringify([kind, target]);
    let pending = this.leases.get(key);
    if (!pending) {
      pending = this.mutation('open', 'POST', { kind, target, control: true }).then(value => {
        const lease = value as Lease;
        if (!lease || typeof lease.lease !== 'string' || !/^webconsole_[A-Za-z0-9_-]+$/.test(lease.lease) || lease.controller !== true) throw new Error('Invalid console lease');
        return lease;
      });
      this.leases.set(key, pending);
      void pending.catch(() => { if (this.leases.get(key) === pending) this.leases.delete(key); });
    }
    return pending;
  }
  async call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    if (command === 'agents_dock_save_preferences' || command === 'agents_dock_pin') {
      let body: Record<string, unknown> = { action: 'pin' };
      if (command === 'agents_dock_save_preferences') {
        if (typeof args.enabled !== 'boolean' || typeof args.keepOnScreen !== 'boolean') throw new Error('Invalid running agents widget preferences');
        body = { action: 'save', enabled: args.enabled, keepOnScreen: args.keepOnScreen };
      }
      const result = await webJson('/api/pandacode/dock', { method: 'POST', headers: this.csrf(), body: JSON.stringify(body) }, { timeoutMs: 50000 });
      if (!result.response.ok) throw new Error(command === 'agents_dock_pin' ? 'Pinned native windows are unavailable in the web UI.' : `Running agents preferences failed (${result.response.status}).`);
      return result.value as T;
    }
    if (command === 'simulator_capture') {
      const target = text(args.udid, 'simulator');
      const lease = await this.lease('simulator', target); const url = new URL('/api/pandacode/consoles/capture', location.href); url.searchParams.set('lease', lease.lease);
      const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 70000);
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Console capture failed (${response.status}). Reopen the console to reconnect.`);
        const mime = response.headers.get('content-type')?.split(';', 1)[0]; if (mime !== 'image/png') throw new Error('Invalid console capture type');
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty console capture'); const chunks: Uint8Array[] = []; let length = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('Console capture exceeds limit'); } chunks.push(part.value); }
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes.buffer as T;
      } finally { window.clearTimeout(timer); }
    }
    const life = lifecycle[command];
    if (life) {
      const request = lifecycleBody(command, args);
      if (life.manager !== (request.target === '$manager')) throw new Error('Invalid console lifecycle target');
      const lease = await this.lease(life.kind, request.target);
      const result = await webJson('/api/pandacode/consoles/lifecycle', { method: 'POST', headers: this.csrf(), body: JSON.stringify({ lease: lease.lease, ...request.body }) }, { timeoutMs: request.timeoutMs });
      if (!result.response.ok) throw new Error(`Console lifecycle failed (${result.response.status}). Reopen the console to reconnect.`);
      if (!result.value || typeof result.value !== 'object' || !Object.hasOwn(result.value, 'result')) throw new Error('Invalid console lifecycle response');
      return (result.value as { result: T }).result;
    }
    const operation = commands[command];
    if (!operation) throw new Error('Invalid console command');
    const target = args[operation.target];
    if (typeof target !== 'string' || !target || target.length > 256) throw new Error('Invalid console target');
    const generation = this.generations.get(operation.kind) ?? 0;
    const lease = await this.lease(operation.kind, target);
    if (generation !== (this.generations.get(operation.kind) ?? 0)) throw new Error('Console was closed');
    if (!operation.frame) {
      let state = this.inputs.get(lease.lease);
      if (!state) { state = { tail: Promise.resolve(), pending: 0 }; this.inputs.set(lease.lease, state); }
      if (state.pending >= 64) throw new Error('Console input queue is full. Wait for delivery before continuing.');
      const current = state; current.pending++;
      // A failed predecessor closes this input chain. Reopening the panel obtains
      // a new lease; uncertain input and subsequent actions are never replayed.
      const sent = current.tail.then(() => {
        if (generation !== (this.generations.get(operation.kind) ?? 0)) throw new Error('Console was closed');
        return this.mutation('input', 'POST', { lease: lease.lease, input: args.input });
      });
      current.tail = sent; void sent.catch(() => {});
      try { return await sent as T; } finally { current.pending--; }
    }
    const url = new URL('/api/pandacode/consoles/frame', location.href);
    url.searchParams.set('lease', lease.lease);
    if (args.after !== undefined) url.searchParams.set('after', String(args.after));
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 50000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Console frame failed (${response.status}). Reopen the console to reconnect.`);
      const mime = response.headers.get('content-type')?.split(';', 1)[0];
      if (mime !== (operation.kind === 'simulator' ? 'application/octet-stream' : 'image/jpeg')) throw new Error('Invalid console frame type');
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty console frame');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Console frame exceeds limit'); } chunks.push(part.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes.buffer as T;
    } finally { window.clearTimeout(timer); }
  }
  async release(kind: Kind): Promise<void> {
    this.generations.set(kind, (this.generations.get(kind) ?? 0) + 1);
    const pending: Promise<void>[] = [];
    for (const [key, lease] of this.leases) {
      if (JSON.parse(key)[0] !== kind) continue;
      this.leases.delete(key);
      pending.push(lease.then(value => { this.inputs.delete(value.lease); return this.mutation(encodeURIComponent(value.lease), 'DELETE'); }).then(() => {}));
    }
    await Promise.allSettled(pending);
  }
}
