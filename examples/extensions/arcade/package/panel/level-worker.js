// The worker that builds a level. It is a module worker served from the panel's own folder, and it imports a sibling
// module by a relative address: both resolve inside the package origin, never the network.
import { buildLevel } from './game.js';

self.addEventListener('message', event => {
  const seed = Number(event.data && event.data.seed);
  self.postMessage({ seed, walls: buildLevel(Number.isFinite(seed) ? seed : 1) });
});
