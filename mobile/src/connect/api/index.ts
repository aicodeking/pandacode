// Per-feature host calls (one file per group, matching src-tauri/src/remote/methods/*.rs) and
// the capability discovery they rely on. See docs/remote-access.md, "Adding a method".
export { hostCall, type HostCallOptions } from '../client.ts';
export { registerMethods } from '../rpc.ts';
export { useHostSupports, useHostCapabilities, capabilitiesOf } from './capabilities.ts';
export { supports, type HostCapabilities, type HostLimits } from './hello.ts';
