/* One list of machines for the VM panel: local VMs from Tart and cloud sandboxes from
 * connected providers, with what each can do. Pure, so the panel only renders. */
import type { Vm, VmStatus } from './vm-panel';

export type CloudMachine = { id: string; provider: string; name: string; state: string; os: string; desktop: boolean; detail: string };
export type { CloudConnection } from './cloud-settings';
import type { CloudConnection } from './cloud-settings';
export type Machine = {
  /** A local VM's name, or a cloud ID such as `daytona:…`. */
  key: string;
  name: string;
  os: string;
  cloud: boolean;
  running: boolean;
  /** Its screen can be shown and used here now. */
  live: boolean;
  desktop: boolean;
  detail: string;
  /** Local VMs running outside PandaCode must be restarted here to be seen. */
  elsewhere: boolean;
  canStart: boolean;
  local?: Vm;
};
export type CreateOption = { id: string; label: string; description: string; cloud: boolean };

/** Cloud machines that end for good when stopped (an AgentCore session, a released Colab runtime): no Start. */
const ONE_SHOT: ReadonlySet<string> = new Set(['agentcore', 'colab']);
const osName = (os: string) => os === 'darwin' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
const memory = (mb: number) => mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`;

export function machines(status: VmStatus | undefined, cloud: CloudMachine[]): Machine[] {
  const local = (status?.vms ?? []).map((vm): Machine => ({
    key: vm.name, name: vm.name, os: vm.os, cloud: false, running: vm.running, live: vm.running && vm.attached, desktop: true,
    detail: `${osName(vm.os)} · ${memory(vm.memoryMb)} · ${vm.running ? (vm.attached ? 'Running' : 'Running elsewhere') : 'Stopped'}`,
    elsewhere: vm.running && !vm.attached, canStart: true, local: vm,
  }));
  const remote = cloud.map((machine): Machine => ({
    key: machine.id, name: machine.name, os: machine.os, cloud: true, running: machine.state === 'running', live: machine.state === 'running' && machine.desktop,
    desktop: machine.desktop, detail: `${machine.detail} · ${machine.state[0].toUpperCase()}${machine.state.slice(1)}`, elsewhere: false,
    canStart: !ONE_SHOT.has(machine.provider),
  }));
  return [...local, ...remote];
}

/** Things the New menu can make: local images once Tart is set up, and cloud kinds per connected provider. */
export function createOptions(status: VmStatus | undefined, connections: CloudConnection[]): CreateOption[] {
  const local = status?.installed ? status.images.map(image => ({ id: `image:${image.id}`, label: image.name, description: `Local · ${image.downloadGb} GB download · ${memory(image.memoryMb)}`, cloud: false })) : [];
  const on = (provider: CloudConnection['provider']) => connections.some(c => c.provider === provider && c.connected);
  const cloud: CreateOption[] = [
    ...(on('daytona') ? [{ id: 'cloud:daytona', label: 'Daytona desktop', description: 'Linux with a screen · billed by Daytona', cloud: true }] : []),
    ...(connections.some(c => c.provider === 'cloudflare' && c.connected && c.sandboxes) ? [{ id: 'cloud:cloudflare', label: 'Cloudflare container', description: 'Linux, commands only · your Cloudflare account', cloud: true }] : []),
    ...(on('aws') ? [
      { id: 'cloud:aws-linux', label: 'AWS Linux desktop', description: 'Ubuntu on EC2 · billed while running', cloud: true },
      { id: 'cloud:aws-windows', label: 'AWS Windows desktop', description: 'Windows Server on EC2 · about 10 min to set up', cloud: true },
      { id: 'cloud:agentcore', label: 'AWS AgentCore session', description: 'Commands only · ends after an hour', cloud: true },
    ] : []),
    ...(on('colab') ? [{ id: 'cloud:colab', label: 'Google Colab runtime', description: 'Commands only · uses Colab compute units · released when stopped', cloud: true }] : []),
  ];
  return [...local, ...cloud];
}

export function cloudName(): string {
  return `pandacode-${Math.random().toString(36).slice(2, 8)}`;
}
