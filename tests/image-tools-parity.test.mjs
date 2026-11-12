import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool } from '../src/tool-trace.ts';

// One list of image tools, shared with the Rust `tool_image` authorization (src-tauri/src/tool_images_auth/tool_names.rs):
// a row shows a thumbnail exactly when Rust would serve it.
const CASES = JSON.parse(readFileSync(new URL('./fixtures/image-tools.json', import.meta.url), 'utf8'));

test('image-tools.json: the row shows exactly the image the fixture names', () => {
  assert.ok(CASES.length >= 10);
  for (const { toolName, input, output, image } of CASES) {
    const trace = describeTool({ name: toolName, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input), output });
    assert.equal(trace.image ?? trace.produced ?? null, image, toolName);
  }
});
