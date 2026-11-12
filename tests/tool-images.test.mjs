import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
const { basename, bindToolImages, buttonSession, buttonSize, CACHE_BYTES, CACHE_LIMITS, createImageCache, defaultLoader, ELSEWHERE_ERROR, errorText, MISSING_TITLE, missingTitle, NETWORK_PATH_ERROR, IMAGE_EDGES, MAX_RETRIES, RETRY_MS, SESSION_ATTR, isImageDataUrl, isNetworkPath, toolImageCache, toolImageCardHtml, toolImageThumbHtml } = await import('../src/tool-images.ts');
const { LAUNCHER_CLASS, toolImageItems } = await import('../src/tool-image-viewer.ts');

const HOSTILE = 'shots/"><img src=x onerror=alert(1)>\'.png';

test('basename takes the last segment for either separator', () => {
  assert.equal(basename('/Users/me/shots/home.png'), 'home.png');
  assert.equal(basename('C:\\work\\shot.jpg'), 'shot.jpg');
  assert.equal(basename('plain.webp'), 'plain.webp');
  assert.equal(basename('dir/'), 'dir');
});

test('thumbnail markup escapes hostile paths everywhere', () => {
  const html = toolImageThumbHtml(HOSTILE);
  assert.ok(!html.includes('<img src=x'), html);
  assert.ok(!html.includes('"><img'), html);
  assert.ok(html.includes('data-tool-image="shots/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;.png"'));
  assert.ok(html.includes('aria-label="Open image &quot;&gt;&lt;img'));
  assert.equal((html.match(/<img /g) ?? []).length, 1, 'only the placeholder img');
});

test('thumbnail is a typed button with a hidden image and the file name', () => {
  const html = toolImageThumbHtml('/tmp/a/home.png');
  assert.match(html, /^<button type="button" class="tool-image-thumb" data-tool-image="\/tmp\/a\/home\.png" aria-label="Open image home\.png" title="\/tmp\/a\/home\.png">/);
  assert.match(html, /<img alt="" decoding="async" hidden>/);
  assert.match(html, /<span class="tool-image-name">home\.png<\/span>$/);
  assert.match(html, /class="icon tool-image-placeholder"/);
});

test('card markup carries the path and only an escaped meta caption', () => {
  const html = toolImageCardHtml('/tmp/plot.png', { caption: '<b>1200×800</b>' });
  assert.match(html, /^<figure class="tool-image-card">/);
  assert.match(html, /class="tool-image-thumb tool-image-card-button" data-tool-image="\/tmp\/plot\.png"/);
  assert.ok(html.endsWith('<figcaption class="tool-image-card-caption"><span class="tool-image-card-meta">&lt;b&gt;1200×800&lt;/b&gt;</span></figcaption></figure>'), html);
  assert.ok(!html.includes('tool-image-name'), 'the row title already names the file');
  const bare = toolImageCardHtml('/tmp/plot.png');
  assert.ok(!bare.includes('figcaption'), 'no caption without meta');
  assert.ok(bare.endsWith('</button></figure>'), bare);
  assert.ok(!toolImageCardHtml(HOSTILE).includes('<img src=x'));
});

// A stand-in for the transcript: buttons with a path and an <img> that may already show a URL.
const scopeOf = buttons => ({
  querySelectorAll: () => buttons.map(([path, src, session]) => ({
    dataset: path === undefined ? {} : { toolImage: path },
    getAttribute: name => (name === 'data-tool-image-session' ? session ?? null : null),
    querySelector: () => ({ getAttribute: () => src ?? null }),
  })),
});

test('viewer lists each image once, in order, with the URL a loaded button shows', () => {
  const PNG = 'data:image/png;base64,AA';
  const items = toolImageItems(scopeOf([
    ['/a.png'], [undefined], ['/b.png', 'https://evil.example/b.png'], ['/a.png', PNG], ['/c.png', PNG], ['/b.png'],
  ]));
  assert.deepEqual(items, [{ path: '/a.png', shown: PNG, session: '' }, { path: '/b.png', shown: null, session: '' }, { path: '/c.png', shown: PNG, session: '' }]);
  assert.deepEqual(toolImageItems(scopeOf([])), []);
});

test('viewer items keep the thread each button was rendered for', () => {
  const items = toolImageItems(scopeOf([['/a.png', null, 's1'], ['/b.png', null, 's2'], ['/a.png', null, 's2'], ['/c.png']]), 'fallback');
  assert.deepEqual(items.map(item => [item.path, item.session]), [['/a.png', 's1'], ['/b.png', 's2'], ['/a.png', 's2'], ['/c.png', 'fallback']]);
});

test('only data:image URLs are accepted', () => {
  assert.ok(isImageDataUrl('data:image/png;base64,AAAA'));
  assert.ok(isImageDataUrl('data:image/svg+xml,%3Csvg%3E'));
  for (const bad of ['https://example.com/a.png', 'javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '', null, 42]) assert.ok(!isImageDataUrl(bad), String(bad));
});

test('cache loads once per session and path', async () => {
  const calls = [];
  const cache = createImageCache(async (sessionId, path) => { calls.push(`${sessionId}:${path}`); return `data:image/png;base64,${sessionId}`; });
  const [a, b] = await Promise.all([cache.get('s1', 'x.png'), cache.get('s1', 'x.png')]);
  assert.equal(a, 'data:image/png;base64,s1');
  assert.equal(b, a);
  assert.equal(await cache.get('s2', 'x.png'), 'data:image/png;base64,s2');
  assert.deepEqual(calls, ['s1:x.png', 's2:x.png']);
});

test('cache rejects non-image URLs and failed loads as null', async () => {
  const cache = createImageCache(async (_s, path) => {
    if (path === 'boom.png') throw new Error('not seen in this session');
    if (path === 'sync.png') return undefined;
    return 'https://evil.example/x.png';
  });
  assert.equal(await cache.get('s', 'remote.png'), null);
  assert.equal(await cache.get('s', 'boom.png'), null);
  assert.equal(await cache.get('s', 'sync.png'), null);
  const throwsSync = createImageCache(() => { throw new Error('sync'); });
  assert.equal(await throwsSync.get('s', 'a.png'), null);
});

test('cache retries a failed load after RETRY_MS, up to MAX_RETRIES times, and keeps successes', async () => {
  let clock = 1_000, fail = true;
  const calls = [];
  const cache = createImageCache(async (_s, path) => {
    calls.push(path);
    if (fail) throw new Error('not yet');
    return 'data:image/png;base64,OK';
  }, 200, { now: () => clock });
  assert.equal(await cache.get('s', 'a.png'), null);
  assert.equal(await cache.get('s', 'a.png'), null, 'too soon: the failure is reused');
  assert.equal(calls.length, 1);
  for (let retry = 1; retry <= MAX_RETRIES; retry++) {
    clock += RETRY_MS;
    assert.equal(await cache.get('s', 'a.png'), null);
    assert.equal(calls.length, 1 + retry);
  }
  clock += RETRY_MS;
  assert.equal(await cache.get('s', 'a.png'), null, 'timed retries stop after MAX_RETRIES');
  assert.equal(calls.length, 1 + MAX_RETRIES);
  fail = false;
  clock += RETRY_MS * 10;
  assert.equal(await cache.get('s', 'a.png', { retry: true }), null, 'forced retries (viewer, re-render) stop after MAX_RETRIES too');
  assert.equal(calls.length, 1 + MAX_RETRIES);
});

test('a forced retry loads once the image appears, and a success stays cached', async () => {
  let clock = 1_000, fail = true;
  const calls = [];
  const cache = createImageCache(async () => { calls.push(clock); if (fail) throw new Error('not yet'); return 'data:image/png;base64,OK'; }, 200, { now: () => clock });
  assert.equal(await cache.get('s', 'a.png'), null);
  fail = false;
  clock += 1_000;
  assert.equal(await cache.get('s', 'a.png', { retry: true }), 'data:image/png;base64,OK');
  clock += RETRY_MS * 10;
  assert.equal(await cache.get('s', 'a.png', { retry: true }), 'data:image/png;base64,OK');
  assert.equal(calls.length, 2, 'a success stays cached');
});

test('forced retries are capped like timed ones', async () => {
  let clock = 1_000;
  const calls = [];
  const cache = createImageCache(async () => { calls.push(clock); throw new Error('gone'); }, 200, { now: () => clock });
  await cache.get('s', 'a.png');
  for (let round = 0; round < MAX_RETRIES * 3; round++) {
    clock += 1_000;
    await cache.get('s', 'a.png', { retry: true });
  }
  assert.equal(calls.length, 1 + MAX_RETRIES, 'a viewer reopening or a row re-rendering never loads past the cap');
});

test('a forced retry waits a short gap and shares one pending load', async () => {
  let clock = 10_000;
  const calls = [];
  const cache = createImageCache(async () => { calls.push(clock); throw new Error('gone'); }, 200, { now: () => clock });
  await cache.get('s', 'a.png');
  assert.equal(await cache.get('s', 'a.png', { retry: true }), null);
  assert.equal(calls.length, 1, 'not straight after the failure');
  clock += 1_000;
  const [x, y] = await Promise.all([cache.get('s', 'a.png', { retry: true }), cache.get('s', 'a.png', { retry: true })]);
  assert.equal(x, null); assert.equal(y, null);
  assert.equal(calls.length, 2, 'two renders at once ask once');
});

test('the header thumbnail and viewer share the retrying cache', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(!/const stepImages = new Map/.test(main), 'no private cache that keeps failures forever');
  assert.match(main, /toolImageCache\(toolImageLoader\)\.get\(sessionId, path, \{ retry: retry && forceStepImage\(sessionId, path\) \}\)/);
  // The header re-renders on every step, so its forced retries are capped per session and image.
  assert.match(main, /function forceStepImage\([^)]*\): boolean \{[\s\S]*?if \(tries >= MAX_RETRIES\) return false;/);
  assert.match(main, /retryLater\(image,/);
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.match(viewer, /\.get\(sessionId, item\.path, \{ retry: true \}\)/);
});

test('viewer reveal uses the platform label and says when it fails', () => {
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.match(viewer, /import \{ isMac, isWindows \} from '\.\/platform\.ts';/);
  assert.match(viewer, /REVEAL_LABEL = isMac \? 'Reveal in Finder' : isWindows \? 'Show in Explorer' : 'Open folder'/);
  assert.ok(!/<span>Reveal in Finder<\/span>/.test(viewer), 'no hard-coded Finder label');
  assert.match(viewer, /class="tool-image-viewer-notice" role="status" aria-live="polite"/);
  assert.match(viewer, /showNotice\(viewer, REVEAL_FAILED\)/);
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /\{ id: 'reveal', label: REVEAL_LABEL,/, 'the file menus share the label');
});

test('cache is bounded and keeps the most recently used', async () => {
  const calls = [];
  const cache = createImageCache(async (_s, path) => { calls.push(path); return 'data:image/png;base64,AA'; }, 2);
  await cache.get('s', 'a'); await cache.get('s', 'b');
  await cache.get('s', 'a'); // a is now newest
  await cache.get('s', 'c'); // evicts b
  assert.equal(cache.size, 2);
  await cache.get('s', 'a');
  await cache.get('s', 'b');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
});

test('cache is bounded by the bytes of its data URLs, keeping the newest even when it alone is over', async () => {
  const url = n => `data:image/png;base64,${'A'.repeat(n)}`;
  const sizes = { a: 400, b: 400, c: 300, huge: 5000 };
  const calls = [];
  const cache = createImageCache(async (_s, path) => { calls.push(path); return url(sizes[path]); }, 100, { maxBytes: 1000 });
  await cache.get('s', 'a'); await cache.get('s', 'b');
  assert.equal(cache.size, 2);
  await cache.get('s', 'a'); // a is now newest
  await cache.get('s', 'c'); // a + b + c are over 1000 bytes: the oldest (b) goes
  assert.equal(cache.size, 2);
  assert.ok(cache.bytes <= 1000, String(cache.bytes));
  await cache.get('s', 'a'); await cache.get('s', 'c');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  await cache.get('s', 'huge'); // over the bound alone: everything older goes, the newest stays
  assert.equal(cache.size, 1);
  await cache.get('s', 'huge');
  assert.deepEqual(calls, ['a', 'b', 'c', 'huge']);
  await cache.get('s', 'b');
  assert.equal(cache.size, 1, 'the huge entry gives way to the next image');
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test('full images are bounded by bytes (64 MB of data URLs), not only by count', () => {
  assert.equal(CACHE_BYTES.full, 64 * 1024 * 1024);
  for (const size of ['thumb', 'card']) assert.ok(CACHE_BYTES[size] > 0 && CACHE_BYTES[size] <= CACHE_BYTES.full, size);
  const source = readFileSync(new URL('../src/tool-images.ts', import.meta.url), 'utf8');
  assert.match(source, /createImageCache\(load, CACHE_LIMITS\[size\], \{ maxEdge: IMAGE_EDGES\[size\], maxBytes: CACHE_BYTES\[size\] \}\)/);
});

test('the launcher viewer has no Reveal and is styled from always-loaded tokens', () => {
  const overlay = readFileSync(new URL('../src/overlay-thread.ts', import.meta.url), 'utf8');
  assert.match(overlay, /^import '\.\/tool-images\.css';$/m, 'the launcher loads the viewer stylesheet');
  assert.match(overlay, /attachToolImages\(this\.history, [^\n]*, overlayImageLoader, \{ launcher: true \}\)/, 'the launcher asks for its viewer');
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.equal(LAUNCHER_CLASS, 'is-launcher');
  assert.match(viewer, /dialog\.innerHTML = viewerHtml\(!launcher\)/, 'no Reveal button is rendered in the launcher');
  assert.match(viewer, /\$\{reveal \? `<button[^`]*data-tool-image-action="reveal"/);
  assert.match(viewer, /function revealPath\(viewer: Viewer\): void \{\n  if \(!viewer\.canReveal\) return;/, 'reveal_path is never called there');
  assert.match(viewer, /openToolImage\(button, \{ sessionId: sessionId\(\), load, scope: root, launcher \}\)/);
  assert.match(viewer, /installToolImageClicks\(container, sessionId, load, surface\)/);
  assert.match(viewer, /if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); closeViewer\(viewer\); return; \}/, 'Esc closes the viewer before the launcher\'s own Escape handler');
  // Every token tool-images.css uses reaches the launcher's rows and its viewer (a dialog on <body>): defined on the
  // launcher's root (most of its tokens are scoped to its own components, which neither the rows' nor the
  // dialog's ancestors are) or by tool-images.css's launcher block.
  const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const css = read('tool-images.css');
  const rules = text => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.split(';').pop().trim(), body }));
  const rootRules = ['overlay.css', 'tokens.css', 'overlay-model-picker.css', 'model-picker.css', 'message-actions.css', 'coordination-message.css']
    .flatMap(name => rules(read(name))).filter(rule => /^(?:(?::root|html)(?:\[[^\]]*\])?\s*,?\s*)+$/.test(rule.selector));
  const launcherRules = rules(css).filter(rule => /is-launcher|launcher-thread/.test(rule.selector));
  // Rows use the thumbnail and card rules; the viewer uses every rule.
  const tokens = list => new Set(list.flatMap(rule => [...rule.body.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1])));
  const imageRules = rules(css).filter(rule => !launcherRules.includes(rule));
  const scopes = {
    rows: [/\.launcher-thread/, tokens(imageRules.filter(rule => /tool-image-(?:thumb|card|name|placeholder)/.test(rule.selector) && !/viewer/.test(rule.selector)))],
    viewer: [/dialog\.tool-image-viewer\.is-launcher/, tokens(rules(css))],
  };
  const local = new Set(['--viewer-w', '--viewer-h']);
  for (const [scope, [pattern, used]] of Object.entries(scopes)) {
    const defined = [...rootRules, ...launcherRules.filter(rule => pattern.test(rule.selector))].map(rule => rule.body).join(';');
    const missing = [...used].filter(token => !local.has(token) && !new RegExp(`(?:^|[;{\\s])${token}:`).test(defined));
    assert.deepEqual(missing, [], `${scope}: tokens the launcher leaves undefined`);
  }
  assert.match(css, /\.tool-image-viewer\.is-launcher \.ds-btn\{/, 'the raised button design-system.css draws in the app');
});

test('stylesheet uses tokens only: no literal colours or gradients', () => {
  const css = readFileSync(new URL('../src/tool-images.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'no hex colours');
  assert.ok(!/\b(?:rgba?|hsla?)\(/i.test(css), 'no literal rgb/hsl');
  assert.ok(!/gradient\(/i.test(css), 'no gradients');
  assert.ok(!/transition:[^;}]*\b(?:width|height|top|left|transform|backdrop-filter|all)\b/.test(css), 'no layout transitions');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /focus-visible\{outline:2px solid var\(--focus\)/);
  assert.match(css, /\.tool-image-viewer\.is-actual \.tool-image-viewer-image\{max-width:none;max-height:none\}/, 'actual size lifts the fit limits');
  assert.match(css, /\.tool-image-viewer-stage\{[^}]*overflow:auto/, 'the stage scrolls at actual size');
});

test('network paths are recognised in every spelling', () => {
  for (const path of ['\\\\host\\share\\a.png', '//host/share/a.png', '\\/host/a.png', '/\\host/a.png', ' //a.png', 'file:////host/a.png', 'file://host/share/a.png', 'FILE://host/a.png', '/net/host/a.png', '/Network/Servers/a.png', 'file:///net/h/a.png']) {
    assert.ok(isNetworkPath(path), path);
  }
  for (const path of ['/tmp/a.png', 'file:///tmp/a.png', 'C:\\shots\\a.png', '.pandacode/progress-shots/x.png', 'test-results/a//b.png', '/network-shots/a.png', 'net/a.png']) {
    assert.ok(!isNetworkPath(path), path);
  }
});

test('the cache never asks the loader for a network path', async () => {
  const calls = [];
  const cache = createImageCache(async (_s, path) => { calls.push(path); return 'data:image/png;base64,AA'; });
  assert.equal(await cache.get('s', '\\\\host\\share\\a.png'), null);
  assert.equal(await cache.get('s', '//host/share/a.png'), null);
  assert.equal(await cache.get('s', '.pandacode/progress-shots/x.png'), 'data:image/png;base64,AA');
  assert.deepEqual(calls, ['.pandacode/progress-shots/x.png']);
  await assert.rejects(defaultLoader('s', '//host/share/a.png'), /Network image paths/);
});

test('every tool-row image goes through tool_image, relative paths included', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const loader = /const toolImageLoader: ToolImageLoader = [\s\S]*?;\n/.exec(main)?.[0] ?? '';
  assert.match(loader, /isNetworkPath\(path\)/);
  assert.match(loader, /call<string>\('tool_image'/);
  assert.ok(!loader.includes('workspace_image'), loader);
});

// A stand-in button: attributes and a class list.
const fakeButton = (attrs = {}, classes = []) => ({
  attrs: { ...attrs },
  classList: { contains: name => classes.includes(name) },
  getAttribute(name) { return this.attrs[name] ?? null; },
  setAttribute(name, value) { this.attrs[name] = value; },
});

test('buttons keep the thread that rendered them', () => {
  const old = fakeButton({ [SESSION_ATTR]: 'thread-a' });
  const fresh = fakeButton();
  const root = { querySelectorAll: () => [old, fresh].filter(button => !button.attrs[SESSION_ATTR]) };
  assert.equal(bindToolImages(root, 'thread-b'), 1);
  assert.equal(buttonSession(old, 'thread-b'), 'thread-a', 'a switch never rebinds a row still on screen');
  assert.equal(buttonSession(fresh), 'thread-b');
  assert.equal(bindToolImages(root, ''), 0, 'no thread, no stamp');
  assert.equal(buttonSession(fakeButton(), 'fallback'), 'fallback');
});

test('rows, cards and the viewer ask for their own sizes and keep separate caches', async () => {
  assert.equal(buttonSize(fakeButton({}, ['tool-image-thumb'])), 'thumb');
  assert.equal(buttonSize(fakeButton({}, ['tool-image-thumb', 'tool-image-card-button'])), 'card');
  assert.equal(IMAGE_EDGES.thumb, 160);
  assert.equal(IMAGE_EDGES.card, 640);
  assert.equal(IMAGE_EDGES.full, undefined);
  assert.equal(CACHE_LIMITS.full, 8, 'few full images (up to 25 MB each) are held');
  const calls = [];
  const load = async (sessionId, path, ...rest) => { calls.push([path, ...rest]); return 'data:image/png;base64,AA'; };
  const thumbs = toolImageCache(load, 'thumb'), full = toolImageCache(load, 'full');
  assert.notEqual(thumbs, full);
  assert.equal(toolImageCache(load), thumbs, 'thumbnails are the default');
  await thumbs.get('s', 'a.png'); await toolImageCache(load, 'card').get('s', 'a.png'); await full.get('s', 'a.png');
  await thumbs.get('s', 'a.png'); await full.get('s', 'a.png');
  assert.deepEqual(calls, [['a.png', 160], ['a.png', 640], ['a.png']], 'the full image is asked without maxEdge');
});

test('the viewer loads the full image with the button\'s thread; rows bind as they enter the page', () => {
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.match(viewer, /const full = toolImageCache\(load, 'full'\);\n  const source = sessionId \? full\.get\(sessionId, item\.path/);
  assert.match(viewer, /session: buttonSession\(button, fallback\)/);
  assert.match(viewer, /sessionId = item\.session;/, 'each stepped-to image loads with its own thread');
  assert.match(viewer, /const bind = \(\) => bindToolImages\(container, sessionId\(\)\);\n  const hydrate = \(\) => \{\n    bind\(\);/);
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /call<string>\('tool_image', maxEdge \? \{ sessionId, path, maxEdge \} : \{ sessionId, path \}\)/);
  assert.match(main, /retryLater\(image, \(\) => loadStepImage\(label, false, sessionId\)\)/, 'header retries keep their thread');
});

test('the viewer header keeps one layout while stepping', () => {
  const css = readFileSync(new URL('../src/tool-images.css', import.meta.url), 'utf8');
  assert.match(css, /\.tool-image-viewer-plate\{[^}]*width:var\(--viewer-w\);height:var\(--viewer-h\)/, 'a fixed frame');
  assert.match(css, /\.tool-image-viewer-titles\{flex:1 1 0;min-width:0/, 'titles never size the header');
  assert.match(css, /\.tool-image-viewer-name\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.tool-image-viewer-controls\{[^}]*flex:none/);
  assert.match(css, /\.tool-image-viewer-actions\{[^}]*flex:none/, 'Copy and Reveal are their own group');
  assert.match(css, /\.tool-image-viewer-action\[hidden\]\{display:none\}/, 'a Reveal that does not apply leaves no gap');
  assert.doesNotMatch(css, /is-off\{visibility:hidden\}/);
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.match(viewer, /if \(reveal\) \{ reveal\.disabled = off; reveal\.hidden = off; \}/);
  // Reveal sits before Copy, so hiding it moves neither Copy nor the Previous/Next/Close group after it.
  assert.match(viewer, /tool-image-viewer-actions">[^]*?data-tool-image-action="reveal"[^]*?data-tool-image-action="copy"[^]*?<\/div>\s*<div class="tool-image-viewer-controls">/);
});

test('the viewer offers actual size only for an image larger than the window', () => {
  const viewer = readFileSync(new URL('../src/tool-image-viewer.ts', import.meta.url), 'utf8');
  assert.match(viewer, /const fits = loaded && image\.naturalWidth <= image\.clientWidth && image\.naturalHeight <= image\.clientHeight;/);
  assert.match(viewer, /zoom\.disabled = fits;/);
  assert.match(viewer, /window\.addEventListener\('resize', resized\)/, 'a resized window re-checks');
  const css = readFileSync(new URL('../src/tool-images.css', import.meta.url), 'utf8');
  assert.match(css, /\.tool-image-viewer-zoom:disabled\{opacity:1;cursor:default\}/, 'the app-wide disabled fade never dims the image');
});

test('the shared produced-images fixture covers every image producer', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/produced-images.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length >= 40);
  for (const entry of cases) {
    assert.equal(typeof entry.command, 'string');
    assert.ok(entry.produced === null || typeof entry.produced === 'string', entry.command);
    if (entry.cwd !== undefined) assert.equal(typeof entry.cwd, 'string');
    // Record cases: the tool record's name and its raw input text (JSON, or Codex plain text).
    if (entry.tool !== undefined) assert.ok(typeof entry.tool === 'string' && typeof entry.input === 'string', entry.command);
    if (entry.input !== undefined) assert.equal(typeof entry.tool, 'string', entry.command);
    if ('served' in entry) assert.ok(entry.served === null || typeof entry.served === 'string', entry.command);
  }
  const commands = cases.map(entry => entry.command).join('\n');
  for (const program of ['screencapture', 'simctl', 'ffmpeg', 'sips', 'magick', 'convert', 'rsvg-convert', 'playwright screenshot', '--screenshot', 'timeout', 'nice', 'caffeinate', 'sudo', 'env', 'cd ', 'bash -lc']) {
    assert.ok(commands.includes(program), program);
  }
  assert.ok(cases.some(entry => entry.produced === null && /\.tiff\b/.test(entry.command)), 'TIFF output is never served');
});

test('a refusal for another machine titles the placeholder and is never asked again', async () => {
  let clock = 1_000, calls = 0;
  // Tauri rejects with the command's error string.
  const cache = createImageCache(async () => { calls++; throw ELSEWHERE_ERROR; }, 200, { now: () => clock });
  assert.equal(await cache.get('s', '/tmp/a.png'), null);
  assert.equal(cache.failure('s', '/tmp/a.png'), ELSEWHERE_ERROR);
  assert.equal(missingTitle(cache.failure('s', '/tmp/a.png')), 'This image is on another machine');
  clock += RETRY_MS * 10;
  assert.equal(await cache.get('s', '/tmp/a.png', { retry: true }), null);
  assert.equal(calls, 1, 'a permanent refusal is not retried');
  // Other failures keep the generic title and stay retryable.
  const flaky = createImageCache(async () => { throw new Error('The image is missing or not a regular file'); }, 200, { now: () => clock });
  assert.equal(await flaky.get('s', '/tmp/b.png'), null);
  assert.equal(missingTitle(flaky.failure('s', '/tmp/b.png')), MISSING_TITLE);
  assert.equal(flaky.failure('s', '//host/x.png'), NETWORK_PATH_ERROR);
  assert.equal(flaky.failure('s', '/never/asked.png'), '');
  assert.equal(errorText(new Error('x')), 'x');
  assert.equal(errorText('y'), 'y');
  assert.equal(errorText({}), '');
});

test('the workers panel and the launcher thread load and open tool-row images', () => {
  const architect = readFileSync(new URL('../src/architect.ts', import.meta.url), 'utf8');
  assert.match(architect, /this\.releaseImages = attachToolImages\(panel\.querySelector<HTMLElement>\('\.architect-worker-detail'\)!, \(\) => this\.worker\(\)\?\.sessionId \?\? ''\);/);
  assert.match(architect, /close\(\): void \{[^]*?this\.releaseImages\?\.\(\); this\.releaseImages = undefined; this\.teamMessages\?\.destroy\(\);/);
  const overlay = readFileSync(new URL('../src/overlay-thread.ts', import.meta.url), 'utf8');
  assert.match(overlay, /attachToolImages\(this\.history, \(\) => this\.task\?\.sessionId \?\? '', overlayImageLoader, \{ launcher: true \}\);/);
  assert.match(overlay, /overlayCall<string>\('tool_image'/);
  assert.match(overlay, /import '\.\/tool-images\.css';/);
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const launcher = lib.slice(lib.indexOf('label() == "launcher"'), lib.indexOf('label() == "tray"'));
  assert.match(launcher, /\btool_image,/, 'the launcher window may ask for tool-row images');
});
