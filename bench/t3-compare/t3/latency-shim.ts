// As in T3 Code's render scenarios: the fake session never answers unrelated RPCs, so do not
// let them raise the "slow request" notice partway through a run.
export * from "../src/rpc/requestLatencyState";
export function trackRpcRequestSent(): void {}
