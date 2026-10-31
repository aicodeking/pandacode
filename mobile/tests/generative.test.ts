/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendDraft } from '../src/store/draft.ts';
import { extractFollowups, formPrompt, generativeParts, normalize, parseBlock, sanitizeSvg, type View } from '../src/store/generative.ts';

const ui = (spec: unknown) => {
  const block = parseBlock('ui', JSON.stringify(spec));
  assert.equal(block.kind, 'view', JSON.stringify(block));
  return (block as { view: View }).view;
};

test('every spec type parses', () => {
  const specs: [unknown, string][] = [
    [{ type: 'callout', tone: 'warning', title: 'T', body: 'b' }, 'callout'],
    [{ type: 'card', title: 'C', actions: [{ label: 'Go', prompt: 'go' }], children: [{ type: 'markdown', text: 'x' }] }, 'card'],
    [{ type: 'stats', items: [{ label: 'Users', value: 12, delta: '-3', spark: [1, 2, 3] }] }, 'stats'],
    [{ type: 'table', columns: ['A', { label: 'B', align: 'right' }], rows: [[1, 2], { A: 'x', B: 'y' }] }, 'table'],
    [{ type: 'chart', chart: 'area', labels: ['a', 'b'], series: [{ values: [1, 2] }] }, 'chart'],
    [{ type: 'progress', value: 150, max: 100 }, 'progress'],
    [{ type: 'plan', items: [{ title: 'one', status: 'done' }, 'two'] }, 'plan'],
    [{ type: 'steps', items: ['a'] }, 'steps'], [{ type: 'timeline', items: [{ title: 'a', time: 'now' }] }, 'timeline'],
    [{ type: 'checklist', items: [{ text: 'a', done: true }, 'b'] }, 'checklist'],
    [{ type: 'tabs', items: [{ label: 'One', body: 'x' }] }, 'tabs'],
    [{ type: 'accordion', items: [{ label: 'One', open: true }] }, 'accordion'],
    [{ type: 'tree', paths: ['src/a.ts', 'src/b.ts', 'README.md'] }, 'tree'],
    [{ type: 'diff', file: 'a', diff: '+x' }, 'diff'], [{ type: 'code', code: 'x' }, 'code'],
    [{ type: 'terminal', command: 'ls', output: 'a', exitCode: 0 }, 'terminal'],
    [{ type: 'compare', items: [{ title: 'A', pros: ['p'], cons: ['c'] }] }, 'compare'],
    [{ type: 'gallery', images: [{ path: './shot.png' }, 'https://x/y.png', '../up.png'] }, 'gallery'],
    [{ type: 'actions', buttons: [{ label: 'Run', tone: 'primary' }] }, 'actions'],
    [{ type: 'chips', options: [{ label: 'a', prompt: 'b' }] }, 'chips'],
    [{ type: 'followups', items: ['Next'] }, 'chips'],
    [{ type: 'form', fields: [{ name: 'n' }], prompt: 'Hi {n}' }, 'form'],
    [{ type: 'stack', children: [] }, 'stack'], [{ type: 'grid', columns: 9, children: [] }, 'grid'],
    [{ type: 'custom', title: 'Board', html: '<b>x</b>' }, 'custom'],
    [{ type: 'mystery', a: 1 }, 'unknown'],
  ];
  for (const [spec, type] of specs) assert.equal(ui(spec).type, type, JSON.stringify(spec));
  const tree = ui({ type: 'tree', paths: ['src/a.ts', 'src/b.ts'] }) as Extract<View, { type: 'tree' }>;
  assert.deepEqual(tree.items[0].children.map(c => c.name), ['a.ts', 'b.ts']);
  const gallery = ui({ type: 'gallery', images: ['./shot.png', 'https://x/y.png', '../up.png'] }) as Extract<View, { type: 'gallery' }>;
  assert.deepEqual(gallery.images.map(i => i.path), ['shot.png']);
  assert.equal((ui({ type: 'progress', value: 150, max: 100 }) as Extract<View, { type: 'progress' }>).value, 100);
  assert.equal((ui({ type: 'stats', items: [{ label: 'a', value: 1, delta: '-3' }] }) as Extract<View, { type: 'stats' }>).items[0].trend, 'down');
  assert.equal((ui({ type: 'grid', columns: 9, children: [] }) as { columns: number }).columns, 4);
});

test('chart fences use the questions spec', () => {
  const block = parseBlock('chart', '{"type":"pie","labels":["a","b"],"series":[{"values":[1,3]}]}');
  assert.equal(block.kind === 'view' && block.view.type === 'chart' && block.view.chart, 'pie');
  assert.equal(parseBlock('chart', '{"type":"radar","labels":["a"],"series":[{"values":[1]}]}').kind, 'error');
});

test('invalid JSON, missing types and limits fall back to errors', () => {
  assert.deepEqual(parseBlock('ui', '{nope'), { kind: 'error', message: 'This view is not valid JSON.', source: '{nope' });
  assert.equal(parseBlock('ui', '{"title":"x"}').kind, 'error');
  assert.equal(parseBlock('ui', '{"type":"table","columns":[]}').kind, 'error');
  let deep: unknown = { type: 'markdown', text: 'x' };
  for (let i = 0; i < 6; i++) deep = { type: 'stack', children: [deep] };
  assert.throws(() => normalize(deep), /nest/);
  assert.equal(parseBlock('ui', '{"type":"callout"}'), parseBlock('ui', '{"type":"callout"}'), 'memoized by source');
});

test('other fences: mermaid as labelled code, html as a note', () => {
  assert.deepEqual(parseBlock('mermaid', 'graph TD; A-->B'), { kind: 'code', label: 'Diagram · Mermaid', code: 'graph TD; A-->B' });
  assert.deepEqual(parseBlock('html', '<b>x</b>'), { kind: 'html' });
});

test('svg is accepted only when it is shapes alone', () => {
  const ok = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>';
  assert.equal(sanitizeSvg(ok), ok);
  for (const bad of [
    '<svg><script>alert(1)</script></svg>', '<svg onload="x()"><rect/></svg>', '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="https://x/y.png"/></svg>', '<svg><use xlink:href="other.svg#a"/></svg>', '<svg><rect style="fill:url(https://x)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>', '<svg><a href="javascript:x"><rect/></a></svg>', 'not svg', '<svg><rect/>',
  ]) assert.equal(sanitizeSvg(bad), null, bad);
  assert.deepEqual(parseBlock('svg', '<svg><script/></svg>'), { kind: 'svg', xml: null });
});

test('followups become chips; code keeps them', () => {
  const { text, options } = extractFollowups('Done. :codex-followup[Run tests]{prompt="Run the &quot;unit&quot; tests"} :followup[Ship] `:followup[Code]`');
  assert.deepEqual(options, [{ label: 'Run tests', prompt: 'Run the "unit" tests', tone: 'secondary' }, { label: 'Ship', prompt: 'Ship', tone: 'secondary' }]);
  assert.match(text, /`:followup\[Code\]`/);
  assert.doesNotMatch(text, /Run tests/);
  const fenced = extractFollowups('```\n:followup[No]\n```\n');
  assert.equal(fenced.options.length, 0);
});

test('replies split into text, blocks and chips', () => {
  assert.deepEqual(generativeParts('plain **text**'), [{ kind: 'text', text: 'plain **text**' }]);
  const parts = generativeParts('Intro\n\n```ui\n{"type":"callout"}\n```\n\n```ts\nconst a = 1;\n```\nEnd :followup[Next]\n\n```chart\n{"type":"bar"');
  assert.deepEqual(parts.map(p => p.kind), ['text', 'block', 'text', 'chips', 'block']);
  assert.deepEqual(parts[1], { kind: 'block', lang: 'ui', source: '{"type":"callout"}', pending: false });
  assert.match((parts[2] as { text: string }).text, /```ts\nconst a = 1;\n```/);
  assert.equal((parts[4] as { pending: boolean }).pending, true, 'still streaming');
});

test('forms fill their template; drafts append', () => {
  const fields = [{ name: 'area', label: 'Area' }, { name: 'urgent', label: 'Urgent' }];
  assert.equal(formPrompt('Fix {area} (urgent: {urgent}) {other}', fields, { area: 'login', urgent: 'yes' }), 'Fix login (urgent: yes) {other}');
  assert.equal(formPrompt(undefined, fields, { area: 'login' }), 'Area: login\nUrgent: ');
  assert.equal(appendDraft('', 'Run tests'), 'Run tests');
  assert.equal(appendDraft('Hello  \n', 'Run tests'), 'Hello\n\nRun tests');
});
