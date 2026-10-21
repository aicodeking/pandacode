import test from 'node:test';
import assert from 'node:assert/strict';
import { formPrompt, interpolate, LIMITS, normalize, parseSpec, scrubCss, treeFromPaths, VIEW_TYPES } from '../src/generative-ui-components.ts';

test('every documented type validates, and unknown types fall back instead of failing', () => {
  const samples = {
    markdown: { text: 'hi' }, callout: { body: 'x' }, card: { title: 't' }, stats: { items: [{ label: 'a', value: 1 }] },
    table: { columns: ['a'], rows: [[1]] }, chart: { series: [{ values: [1, 2] }] }, progress: { value: 3 }, steps: { items: ['a'] },
    plan: { items: ['a'] }, timeline: { items: ['a'] }, checklist: { items: ['a'] }, tabs: { tabs: [{ label: 'a' }] },
    accordion: { items: [{ title: 'a' }] }, tree: { paths: ['a/b'] }, diff: { diff: '+a' }, code: { code: 'x' }, terminal: { output: 'x' },
    compare: { items: [{ title: 'a', pros: ['p'] }] }, gallery: { images: ['a.png'] }, actions: { buttons: ['Go'] }, chips: { options: ['a'] },
    form: { fields: [{ name: 'n' }] }, stack: { children: [] }, grid: { children: [] }, custom: { html: '<p>x</p>' },
  };
  for (const type of VIEW_TYPES) assert.equal(normalize({ type, ...samples[type] }).type, type, type);
  assert.deepEqual(normalize({ type: 'hologram', x: 1 }).type, 'unknown');
  const followups = normalize({ type: 'followups', items: [{ label: 'Run tests', prompt: 'Run the tests' }] });
  assert.deepEqual([followups.type, followups.label, followups.options[0].prompt], ['chips', 'Suggested follow-ups', 'Run the tests']);
  assert.throws(() => normalize({}), /needs a "type"/);
  assert.throws(() => parseSpec('{"type":'), /not valid JSON/);
});

test('specs are clipped to their limits and coerced to safe values', () => {
  const table = normalize({ type: 'table', columns: Array.from({ length: 30 }, (_, i) => `c${i}`), rows: Array.from({ length: 500 }, () => [{ evil: 1 }, 'ok']) });
  assert.equal(table.columns.length, LIMITS.columns);
  assert.equal(table.rows.length, LIMITS.rows);
  assert.equal(table.rows[0][0], '');
  const chart = normalize({ type: 'chart', chart: 'radar', labels: ['a', 'b'], series: [{ values: ['3', 'x', 9] }] });
  assert.equal(chart.chart, 'bar');
  assert.deepEqual(chart.series[0].values, [3, 0]);
  const progress = normalize({ type: 'progress', value: 500, max: 10 });
  assert.equal(progress.value, 10);
  const action = normalize({ type: 'actions', buttons: [{ label: 'Ship', tone: 'evil' }] }).buttons[0];
  assert.deepEqual(action, { label: 'Ship', prompt: 'Ship', tone: 'secondary' });
  // Gallery paths stay in the workspace: no URLs, no parent directories.
  assert.deepEqual(normalize({ type: 'gallery', images: ['https://x.test/a.png', 'file:///etc/a.png', '../a.png', 'shots/a.png'] }).images.map(image => image.path), ['shots/a.png']);
});

test('nesting and size are bounded', () => {
  let deep = { type: 'markdown', text: 'leaf' };
  for (let i = 0; i < 8; i++) deep = { type: 'stack', children: [deep] };
  assert.throws(() => normalize(deep), /nest at most/);
  const wide = { type: 'grid', children: Array.from({ length: 24 }, () => ({ type: 'grid', children: Array.from({ length: 24 }, () => ({ type: 'markdown', text: 'x' })) })) };
  assert.throws(() => normalize(wide), /at most \d+ parts/);
  assert.throws(() => parseSpec(' '.repeat(LIMITS.source + 1)), /larger than 64 KB/);
  assert.throws(() => normalize({ type: 'custom', html: 'x'.repeat(LIMITS.source + 1) }), /64 KB/);
});

test('custom CSS cannot load anything or escape its style element', () => {
  const css = scrubCss('@import url(https://evil.test/x.css); .a{background:url("https://evil.test/p.png")} .b{background:url(data:image/png;base64,AAAA)} </style><script>x</script> .c{behavior:expression(alert(1))}');
  assert.doesNotMatch(css, /evil\.test|@import|<\/style|expression\(/i);
  assert.match(css, /url\(data:image\/png;base64,AAAA\)/);
  assert.match(normalize({ type: 'custom', html: '<p>x</p>', css: '.x{background:url(/local.png)}' }).css, /background:none/);
});

test('custom state keeps only simple keys and text values', () => {
  const spec = normalize({ type: 'custom', html: '<b>x</b>', state: { count: 2, 'bad key': 'x', obj: { a: 1 }, name: 'Ada' } });
  assert.deepEqual(spec.state, { count: '2', name: 'Ada' });
  assert.equal(interpolate('Hello {name}, {count} {missing}', spec.state), 'Hello Ada, 2 {missing}');
});

test('forms turn answers into a prompt, never a request', () => {
  const fields = [{ name: 'env', label: 'Environment' }, { name: 'dry', label: 'Dry run' }];
  assert.equal(formPrompt('Deploy to {env} (dry run: {dry})', fields, { env: 'staging', dry: 'yes' }), 'Deploy to staging (dry run: yes)');
  assert.equal(formPrompt(undefined, fields, { env: 'prod', dry: 'no' }), 'Environment: prod\nDry run: no');
  const form = normalize({ type: 'form', fields: [{ name: 'a b<script>', options: ['x', 'y'] }] });
  assert.equal(form.fields[0].name, 'abscript');
  assert.equal(form.fields[0].type, 'select');
});

test('flat paths become a nested file tree', () => {
  const tree = treeFromPaths(['src/a.ts', 'src/lib/b.ts', 'README.md']);
  assert.deepEqual(tree.map(item => item.name), ['src', 'README.md']);
  assert.deepEqual(tree[0].children.map(item => item.name), ['a.ts', 'lib']);
});
