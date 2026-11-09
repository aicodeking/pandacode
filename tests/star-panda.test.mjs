import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const repository = 'https://github.com/aicodeking/pandacode';
const description = 'I am sad because people are not starring my repo.. If you like it can you star it, please?';

function load(hidden = false) {
  const file = new URL('../src/star-panda.ts', import.meta.url);
  assert.ok(existsSync(file), 'the companion renderer exists');
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const attributes = new Set(), listeners = new Map(), exports = {};
  const document = {
    hidden,
    documentElement: { toggleAttribute: (name, on) => on ? attributes.add(name) : attributes.delete(name) },
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const require = name => {
    if (name === './star-panda.css') return {};
    assert.equal(name, './about-settings');
    return { PROJECT_LINKS: { repository } };
  };
  new Function('exports', 'require', 'document', outputText)(exports, require, document);
  return { ...exports, document, attributes, listeners };
}

test('the companion is one accessible button using the explicit repository action', () => {
  const html = load().starPanda();
  assert.match(html, /^<button\b[^>]*type="button"/);
  assert.match(html, /class="star-panda"/);
  assert.match(html, /data-action="open-url"/);
  assert.ok(html.includes(`data-url="${repository}"`));
  assert.ok(html.includes('aria-label="Star PandaCode on GitHub"'));
  for (const attribute of ['data-tip', 'aria-description']) assert.ok(html.includes(`${attribute}="${description}"`));
  assert.match(html, /<svg\b[^>]*viewBox="0 0 22 22"[^>]*aria-hidden="true"/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /\btitle=|<title|<script|<img|\bon\w+=|\bhref=/);
});

test('CSS gestures move only wrappers, so fill-box never re-anchors an SVG rotate()', () => {
  const { starPanda } = load();
  const html = starPanda();
  const css = readFileSync(new URL('../src/star-panda.css', import.meta.url), 'utf8');
  for (const part of ['head', 'offer', 'ear-left', 'ear-right', 'glint']) {
    const tag = html.match(new RegExp(`<\\w+ class="[^"]*\\bstar-panda-${part}\\b[^"]*"[^>]*>`))?.[0];
    assert.ok(tag, `${part} exists`);
    assert.doesNotMatch(tag, /\btransform=/, `${part} has no transform attribute`);
  }
  assert.doesNotMatch(css, /:is\([^)]*\b(?:g|ellipse|path|rect|circle)\b[^)]*\)\s*\{[^}]*transform-box/);
  const ids = [html, starPanda()].map(h => h.match(/clipPath id="([^"]+)"/)[1]);
  assert.notEqual(ids[0], ids[1], 'each instance clips with its own id');
  assert.ok(html.includes(`url(#${ids[0]})`));
});

test('hiding the document closes the animation gate, including an initially hidden window', () => {
  const { document, attributes, listeners } = load();
  assert.equal(attributes.has('data-star-panda-hidden'), false);
  document.hidden = true;
  listeners.get('visibilitychange')();
  assert.equal(attributes.has('data-star-panda-hidden'), true);
  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(attributes.has('data-star-panda-hidden'), false);
  assert.equal(load(true).attributes.has('data-star-panda-hidden'), true);
});
