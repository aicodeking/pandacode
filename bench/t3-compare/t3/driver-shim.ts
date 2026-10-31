// Same swap as T3 Code's own render scenarios (test/appScenarios.renders.tsx vi.mock):
// every connection opens test/fakeEnvironment.ts's in-process session. Everything above it is the app.
import * as Layer from "effect/Layer";
import * as actual from "../../../packages/client-runtime/src/connection/driver.ts";
import { fakeDriver } from "../test/fakeEnvironment";

export * from "../../../packages/client-runtime/src/connection/driver.ts";
export const layer = Layer.succeed(actual.ConnectionDriver, fakeDriver as never);
