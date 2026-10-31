// Production build of t3/bench.html on top of T3 Code's own apps/web/vite.config.ts.
// Copied to $T3CODE_DIR/apps/web/zbench/ by setup-t3.sh.
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite-plus";
import base from "../vite.config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const swaps: Array<[string, string]> = [
  ["/packages/client-runtime/src/connection/driver.ts", here("./driver-shim.ts")],
  ["/apps/web/src/rpc/requestLatencyState.ts", here("./latency-shim.ts")],
];

function swapModules(): Plugin {
  return {
    name: "bench:swap-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || swaps.some(([, shim]) => importer === shim)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const swap = resolved && swaps.find(([suffix]) => resolved.id.split("?")[0]!.endsWith(suffix));
      return swap ? swap[1] : null;
    },
  };
}

export default defineConfig(async (env) =>
  mergeConfig(await (base as (e: typeof env) => object)(env), {
    root: here(".."),
    plugins: [swapModules()],
    // zbench/ is outside tsconfig.json's include, so tsconfigPaths does not map "~" here.
    resolve: { alias: [{ find: /^~\//, replacement: `${here("../src")}/` }] },
    build: { outDir: "dist-bench", rolldownOptions: { input: here("./bench.html") } },
  }),
);
