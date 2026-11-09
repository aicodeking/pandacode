import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// The inherited desktop-preview tests expect Mac keyboard conventions. This
// opt-in fixture emulates client labels only, not native platform capabilities.
export default mergeConfig(base, defineConfig({
  plugins: [{
    name: 'desktop-preview-mac-client-fixture',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', injectTo: 'head-prepend', children: "Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});" }],
    },
  }],
}));
